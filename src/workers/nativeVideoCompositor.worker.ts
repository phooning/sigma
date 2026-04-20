type NativeVisibleAsset = {
  id: string;
  screenX: number;
  screenY: number;
  renderedWidthPx: number;
  renderedHeightPx: number;
};

type NativeVideoManifest = {
  canvasWidth: number;
  canvasHeight: number;
  assets: NativeVisibleAsset[];
};

type NativeVideoAllocation = {
  assetId: string;
  state: "active" | "suspended" | "thumbnail";
};

type InitMessage = {
  type: "init";
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  devicePixelRatio: number;
};

type WorkerMessage =
  | InitMessage
  | {
      type: "resize";
      width: number;
      height: number;
      devicePixelRatio: number;
    }
  | { type: "layout"; manifest: NativeVideoManifest }
  | { type: "allocations"; allocations: NativeVideoAllocation[] }
  | { type: "frame"; packet: ArrayBuffer };

type Layout = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Frame = {
  sequence: bigint;
  streamId: string;
  width: number;
  height: number;
  stride: number;
  payload: Uint8Array;
  presented: boolean;
};

type Metrics = {
  renderer: string;
  canvasWidth: number;
  canvasHeight: number;
  uploadLatencyP95Ms: number;
  compositeLatencyP95Ms: number;
  frameDropRate: number;
  measuredIpcBytesPerSec: number;
};

const FRAME_PACKET_HEADER_LEN = 64;
const FRAME_PACKET_MAGIC = "SVF1";
const metricsWindow = {
  uploadLatencyMs: [] as number[],
  compositeLatencyMs: [] as number[],
  receivedFrames: 0,
  droppedFrames: 0,
  receivedBytes: 0,
  startedAt: performance.now(),
};

let renderer: Renderer | null = null;
let canvasWidth = 1;
let canvasHeight = 1;
let devicePixelRatio = 1;
const frames = new Map<string, Frame>();
const layouts = new Map<string, Layout>();
const activeAssets = new Set<string>();

interface Renderer {
  readonly name: string;
  resize(width: number, height: number, ratio: number): void;
  render(frames: Map<string, Frame>, layouts: Map<string, Layout>): void;
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  if (message.type === "init") {
    void initialize(message);
    return;
  }

  if (message.type === "resize") {
    canvasWidth = Math.max(1, Math.round(message.width));
    canvasHeight = Math.max(1, Math.round(message.height));
    devicePixelRatio = Math.max(1, message.devicePixelRatio || 1);
    renderer?.resize(canvasWidth, canvasHeight, devicePixelRatio);
    return;
  }

  if (message.type === "layout") {
    layouts.clear();
    for (const asset of message.manifest.assets) {
      layouts.set(stableStreamId(asset.id), {
        x: asset.screenX,
        y: asset.screenY,
        width: asset.renderedWidthPx,
        height: asset.renderedHeightPx,
      });
    }
    return;
  }

  if (message.type === "allocations") {
    activeAssets.clear();
    for (const allocation of message.allocations) {
      if (allocation.state === "active") {
        activeAssets.add(stableStreamId(allocation.assetId));
      }
    }
    return;
  }

  if (message.type === "frame") {
    ingestFrame(message.packet);
  }
};

async function initialize(message: InitMessage) {
  canvasWidth = Math.max(1, Math.round(message.width));
  canvasHeight = Math.max(1, Math.round(message.height));
  devicePixelRatio = Math.max(1, message.devicePixelRatio || 1);

  renderer = await createWebGpuRenderer(
    message.canvas,
    canvasWidth,
    canvasHeight,
    devicePixelRatio,
  );

  if (!renderer) {
    renderer = new Canvas2dRenderer(
      message.canvas,
      canvasWidth,
      canvasHeight,
      devicePixelRatio,
    );
  }

  self.postMessage({ type: "ready", renderer: renderer.name });
  requestAnimationFrame(renderLoop);
}

function ingestFrame(packet: ArrayBuffer) {
  const parsed = parseFramePacket(packet);
  if (!parsed) return;

  const existing = frames.get(parsed.streamId);
  if (existing && !existing.presented) {
    metricsWindow.droppedFrames += 1;
  }

  metricsWindow.receivedFrames += 1;
  metricsWindow.receivedBytes += packet.byteLength;
  frames.set(parsed.streamId, parsed);
}

function renderLoop() {
  if (renderer) {
    const started = performance.now();
    renderer.render(frames, layouts);
    metricsWindow.compositeLatencyMs.push(performance.now() - started);
  }

  maybePostMetrics();
  requestAnimationFrame(renderLoop);
}

function parseFramePacket(packet: ArrayBuffer): Frame | null {
  if (packet.byteLength < FRAME_PACKET_HEADER_LEN) return null;

  const view = new DataView(packet);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== FRAME_PACKET_MAGIC) return null;

  const headerLength = view.getUint8(5);
  const pixelFormat = view.getUint8(6);
  if (headerLength !== FRAME_PACKET_HEADER_LEN || pixelFormat !== 1) {
    return null;
  }

  const sequence = view.getBigUint64(8, true);
  const streamId = view.getBigUint64(24, true).toString();
  const width = view.getUint32(32, true);
  const height = view.getUint32(36, true);
  const stride = view.getUint32(40, true);
  const payloadLength = view.getUint32(44, true);

  if (packet.byteLength < headerLength + payloadLength) return null;

  return {
    sequence,
    streamId,
    width,
    height,
    stride,
    payload: new Uint8Array(packet, headerLength, payloadLength),
    presented: false,
  };
}

class Canvas2dRenderer implements Renderer {
  readonly name = "offscreen-2d";
  private readonly context: OffscreenCanvasRenderingContext2D;
  private readonly scratch = new Map<
    string,
    { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D }
  >();

  constructor(
    private readonly canvas: OffscreenCanvas,
    width: number,
    height: number,
    ratio: number,
  ) {
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      throw new Error("OffscreenCanvas 2D context is unavailable.");
    }

    this.context = context;
    this.resize(width, height, ratio);
  }

  resize(width: number, height: number, ratio: number) {
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  render(frameMap: Map<string, Frame>, layoutMap: Map<string, Layout>) {
    this.context.clearRect(0, 0, canvasWidth, canvasHeight);

    for (const [streamId, frame] of frameMap) {
      if (!activeAssets.has(streamId)) continue;

      const layout = layoutMap.get(streamId);
      if (!layout) continue;

      const uploadStarted = performance.now();
      const scratch = this.getScratch(streamId, frame.width, frame.height);
      scratch.context.putImageData(
        new ImageData(
          new Uint8ClampedArray(
            frame.payload.buffer,
            frame.payload.byteOffset,
            frame.payload.byteLength,
          ),
          frame.width,
          frame.height,
        ),
        0,
        0,
      );
      metricsWindow.uploadLatencyMs.push(performance.now() - uploadStarted);
      this.context.drawImage(
        scratch.canvas,
        layout.x,
        layout.y,
        layout.width,
        layout.height,
      );
      frame.presented = true;
    }
  }

  private getScratch(streamId: string, width: number, height: number) {
    const existing = this.scratch.get(streamId);
    if (
      existing &&
      existing.canvas.width === width &&
      existing.canvas.height === height
    ) {
      return existing;
    }

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Scratch OffscreenCanvas 2D context is unavailable.");
    }

    const scratch = { canvas, context };
    this.scratch.set(streamId, scratch);
    return scratch;
  }
}

class WebGpuRenderer implements Renderer {
  readonly name = "webgpu";
  private readonly context: any;
  private readonly pipeline: any;
  private readonly sampler: any;
  private readonly gpuFrames = new Map<
    string,
    {
      width: number;
      height: number;
      texture: any;
      bindGroup: any;
      vertexBuffer: any;
    }
  >();

  constructor(
    private readonly canvas: OffscreenCanvas,
    gpu: any,
    private readonly device: any,
    width: number,
    height: number,
    ratio: number,
  ) {
    const context = canvas.getContext("webgpu" as OffscreenRenderingContextId);
    if (!context) {
      throw new Error("WebGPU canvas context is unavailable.");
    }

    this.context = context;
    const format = gpu.getPreferredCanvasFormat();
    this.context.configure({
      device,
      format,
      alphaMode: "premultiplied",
    });
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
    this.pipeline = this.createPipeline(format);
    this.resize(width, height, ratio);
  }

  resize(width: number, height: number, ratio: number) {
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
  }

  render(frameMap: Map<string, Frame>, layoutMap: Map<string, Layout>) {
    const encoder = this.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    pass.setPipeline(this.pipeline);

    for (const [streamId, frame] of frameMap) {
      if (!activeAssets.has(streamId)) continue;

      const layout = layoutMap.get(streamId);
      if (!layout) continue;

      const uploadStarted = performance.now();
      const gpuFrame = this.prepareFrame(streamId, frame);
      this.device.queue.writeTexture(
        { texture: gpuFrame.texture },
        frame.payload,
        { bytesPerRow: frame.stride, rowsPerImage: frame.height },
        { width: frame.width, height: frame.height },
      );
      metricsWindow.uploadLatencyMs.push(performance.now() - uploadStarted);

      this.device.queue.writeBuffer(
        gpuFrame.vertexBuffer,
        0,
        verticesForLayout(layout),
      );
      pass.setBindGroup(0, gpuFrame.bindGroup);
      pass.setVertexBuffer(0, gpuFrame.vertexBuffer);
      pass.draw(6);
      frame.presented = true;
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private prepareFrame(streamId: string, frame: Frame) {
    const existing = this.gpuFrames.get(streamId);
    if (
      existing &&
      existing.width === frame.width &&
      existing.height === frame.height
    ) {
      return existing;
    }

    const usage = (globalThis as any).GPUTextureUsage;
    const bufferUsage = (globalThis as any).GPUBufferUsage;
    const texture = this.device.createTexture({
      size: [frame.width, frame.height, 1],
      format: "rgba8unorm",
      usage: usage.TEXTURE_BINDING | usage.COPY_DST,
    });
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.sampler },
      ],
    });
    const vertexBuffer = this.device.createBuffer({
      size: 6 * 4 * Float32Array.BYTES_PER_ELEMENT,
      usage: bufferUsage.VERTEX | bufferUsage.COPY_DST,
    });
    const gpuFrame = {
      width: frame.width,
      height: frame.height,
      texture,
      bindGroup,
      vertexBuffer,
    };
    this.gpuFrames.set(streamId, gpuFrame);
    return gpuFrame;
  }

  private createPipeline(format: string) {
    const shader = this.device.createShaderModule({
      code: `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vertexMain(@location(0) position: vec2f, @location(1) uv: vec2f) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(position, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@group(0) @binding(0) var frameTexture: texture_2d<f32>;
@group(0) @binding(1) var frameSampler: sampler;

@fragment
fn fragmentMain(in: VertexOut) -> @location(0) vec4f {
  return textureSample(frameTexture, frameSampler, in.uv);
}
`,
    });

    return this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: shader,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: 4 * Float32Array.BYTES_PER_ELEMENT,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              {
                shaderLocation: 1,
                offset: 2 * Float32Array.BYTES_PER_ELEMENT,
                format: "float32x2",
              },
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: "fragmentMain",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });
  }
}

async function createWebGpuRenderer(
  canvas: OffscreenCanvas,
  width: number,
  height: number,
  ratio: number,
) {
  const gpu = (navigator as unknown as { gpu?: any }).gpu;
  if (!gpu) return null;

  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;

  const device = await adapter.requestDevice();
  return new WebGpuRenderer(canvas, gpu, device, width, height, ratio);
}

function verticesForLayout(layout: Layout) {
  const x0 = (layout.x / canvasWidth) * 2 - 1;
  const x1 = ((layout.x + layout.width) / canvasWidth) * 2 - 1;
  const y0 = 1 - (layout.y / canvasHeight) * 2;
  const y1 = 1 - ((layout.y + layout.height) / canvasHeight) * 2;

  return new Float32Array([
    x0,
    y0,
    0,
    0,
    x1,
    y0,
    1,
    0,
    x0,
    y1,
    0,
    1,
    x0,
    y1,
    0,
    1,
    x1,
    y0,
    1,
    0,
    x1,
    y1,
    1,
    1,
  ]);
}

function maybePostMetrics() {
  const now = performance.now();
  const elapsedMs = now - metricsWindow.startedAt;
  if (elapsedMs < 1_000) return;

  const receivedFrames = metricsWindow.receivedFrames;
  const droppedFrames = metricsWindow.droppedFrames;
  const totalFrames = receivedFrames + droppedFrames;
  const metrics: Metrics = {
    renderer: renderer?.name ?? "uninitialized",
    canvasWidth,
    canvasHeight,
    uploadLatencyP95Ms: percentile(metricsWindow.uploadLatencyMs, 0.95),
    compositeLatencyP95Ms: percentile(metricsWindow.compositeLatencyMs, 0.95),
    frameDropRate: totalFrames === 0 ? 0 : droppedFrames / totalFrames,
    measuredIpcBytesPerSec:
      elapsedMs > 0
        ? Math.round((metricsWindow.receivedBytes / elapsedMs) * 1_000)
        : 0,
  };

  metricsWindow.uploadLatencyMs = [];
  metricsWindow.compositeLatencyMs = [];
  metricsWindow.receivedFrames = 0;
  metricsWindow.droppedFrames = 0;
  metricsWindow.receivedBytes = 0;
  metricsWindow.startedAt = now;
  self.postMessage({ type: "metrics", metrics });
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;

  values.sort((a, b) => a - b);
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * p) - 1),
  );
  return Number(values[index].toFixed(3));
}

function stableStreamId(value: string) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index) & 0xff);
    hash = (hash * prime) & mask;
  }

  return hash.toString();
}

export {};
