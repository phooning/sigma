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
  | { type: "geometry"; itemId: string; bounds: Layout | null }
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
  payloadLength: number;
  packetBuffer: ArrayBuffer | null;
  yPlane: Uint8Array | null;
  uPlane: Uint8Array | null;
  vPlane: Uint8Array | null;
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
const PIXEL_FORMAT_YUV420 = 2;

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

  if (message.type === "geometry") {
    applyGeometry(message.itemId, message.bounds);
    return;
  }

  if (message.type === "layout") {
    applyLayoutManifest(message.manifest);
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
  const parsed = parseFramePacket(packet, packet.byteLength);
  if (!parsed) {
    return;
  }

  const existing = frames.get(parsed.streamId);
  if (existing && !existing.presented) {
    releaseFrameBuffer(existing);
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

function applyGeometry(itemId: string, bounds: Layout | null) {
  const streamId = stableStreamId(itemId);

  if (!bounds) {
    layouts.delete(streamId);
    return;
  }

  const previous = layouts.get(streamId);
  if (previous && layoutsEqual(previous, bounds)) return;

  layouts.set(streamId, {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  });
}

function applyLayoutManifest(manifest: NativeVideoManifest) {
  // Skip layout and geometry rebuilds when manifest fields are unchanged.
  if (layoutManifestUnchanged(manifest)) return;

  layouts.clear();
  for (const asset of manifest.assets) {
    layouts.set(stableStreamId(asset.id), {
      x: asset.screenX,
      y: asset.screenY,
      width: asset.renderedWidthPx,
      height: asset.renderedHeightPx,
    });
  }
}

function layoutManifestUnchanged(manifest: NativeVideoManifest) {
  if (manifest.assets.length !== layouts.size) return false;

  for (const asset of manifest.assets) {
    const streamId = stableStreamId(asset.id);
    const previous = layouts.get(streamId);
    if (
      !previous ||
      previous.x !== asset.screenX ||
      previous.y !== asset.screenY ||
      previous.width !== asset.renderedWidthPx ||
      previous.height !== asset.renderedHeightPx
    ) {
      return false;
    }
  }

  return true;
}

function parseFramePacket(
  packet: ArrayBuffer,
  packetLength: number,
): Frame | null {
  if (packetLength < FRAME_PACKET_HEADER_LEN) return null;

  const view = new DataView(packet, 0, packetLength);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== FRAME_PACKET_MAGIC) return null;

  const headerLength = view.getUint8(5);
  const pixelFormat = view.getUint8(6);
  if (
    headerLength !== FRAME_PACKET_HEADER_LEN ||
    pixelFormat !== PIXEL_FORMAT_YUV420
  ) {
    return null;
  }

  const sequence = view.getBigUint64(8, true);
  const streamId = view.getBigUint64(24, true).toString();
  const width = view.getUint32(32, true);
  const height = view.getUint32(36, true);
  const stride = view.getUint32(40, true);
  const payloadLength = view.getUint32(44, true);
  const yLength = width * height;
  const chromaLength = (width / 2) * (height / 2);
  const uOffset = headerLength + yLength;
  const vOffset = uOffset + chromaLength;

  if (
    packetLength < headerLength + payloadLength ||
    payloadLength < yLength + chromaLength * 2
  ) {
    return null;
  }

  return {
    sequence,
    streamId,
    width,
    height,
    stride,
    payloadLength,
    packetBuffer: packet,
    yPlane: new Uint8Array(packet, headerLength, yLength),
    uPlane: new Uint8Array(packet, uOffset, chromaLength),
    vPlane: new Uint8Array(packet, vOffset, chromaLength),
    presented: false,
  };
}

function releaseFrameBuffer(frame: Frame) {
  frame.packetBuffer = null;
  frame.yPlane = null;
  frame.uPlane = null;
  frame.vPlane = null;
}

class Canvas2dRenderer implements Renderer {
  readonly name = "offscreen-2d";
  private readonly context: OffscreenCanvasRenderingContext2D;
  private readonly scratch = new Map<
    string,
    {
      canvas: OffscreenCanvas;
      context: OffscreenCanvasRenderingContext2D;
      rgba: Uint8ClampedArray;
      pendingBitmap: ImageBitmap | null;
      decoding: boolean;
      hasPixels: boolean;
    }
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
      if (!activeAssets.has(streamId)) {
        if (!frame.presented) releaseFrameBuffer(frame);
        frame.presented = true;
        continue;
      }

      const layout = layoutMap.get(streamId);
      if (!layout) continue;

      const scratch = this.getScratch(streamId, frame.width, frame.height);
      if (!frame.presented && !scratch.decoding) {
        this.scheduleBitmapDecode(frame, scratch);
      }

      if (scratch.pendingBitmap) {
        scratch.context.clearRect(0, 0, frame.width, frame.height);
        scratch.context.drawImage(scratch.pendingBitmap, 0, 0);
        scratch.pendingBitmap.close();
        scratch.pendingBitmap = null;
        scratch.hasPixels = true;
        frame.presented = true;
      }

      if (scratch.hasPixels) {
        this.context.drawImage(
          scratch.canvas,
          layout.x,
          layout.y,
          layout.width,
          layout.height,
        );
      }
    }
  }

  private scheduleBitmapDecode(
    frame: Frame,
    scratch: {
      rgba: Uint8ClampedArray;
      pendingBitmap: ImageBitmap | null;
      decoding: boolean;
    },
  ) {
    const yPlane = frame.yPlane;
    const uPlane = frame.uPlane;
    const vPlane = frame.vPlane;
    if (!frame.packetBuffer || !yPlane || !uPlane || !vPlane) return;

    scratch.decoding = true;
    frame.presented = true;
    const started = performance.now();
    queueMicrotask(() => {
      void (async () => {
        // YUV conversion and createImageBitmap happen outside requestAnimationFrame.
        yuv420ToRgba(
          yPlane,
          uPlane,
          vPlane,
          scratch.rgba,
          frame.width,
          frame.height,
        );
        const bitmap = await createImageBitmap(
          new ImageData(scratch.rgba, frame.width, frame.height),
        );
        releaseFrameBuffer(frame);
        scratch.pendingBitmap?.close();
        scratch.pendingBitmap = bitmap;
        scratch.decoding = false;
        metricsWindow.uploadLatencyMs.push(performance.now() - started);
      })().catch(() => {
        releaseFrameBuffer(frame);
        scratch.decoding = false;
      });
    });
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

    existing?.pendingBitmap?.close();
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Scratch OffscreenCanvas 2D context is unavailable.");
    }

    const scratch = {
      canvas,
      context,
      rgba: new Uint8ClampedArray(width * height * 4),
      pendingBitmap: null,
      decoding: false,
      hasPixels: false,
    };
    this.scratch.set(streamId, scratch);
    return scratch;
  }
}

class WebGpuRenderer implements Renderer {
  readonly name = "webgpu";
  private readonly context: any;
  private readonly renderPipeline: any;
  private readonly computePipeline: any;
  private readonly sampler: any;
  private readonly gpuFrames = new Map<
    string,
    {
      width: number;
      height: number;
      yTexture: any;
      uTexture: any;
      vTexture: any;
      rgbaTexture: any;
      computeBindGroup: any;
      renderBindGroup: any;
      vertexBuffer: any;
      layout: Layout | null;
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
    this.computePipeline = this.createYuvComputePipeline();
    this.renderPipeline = this.createRenderPipeline(format);
    this.resize(width, height, ratio);
  }

  resize(width: number, height: number, ratio: number) {
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
    for (const gpuFrame of this.gpuFrames.values()) {
      gpuFrame.layout = null;
    }
  }

  render(frameMap: Map<string, Frame>, layoutMap: Map<string, Layout>) {
    const encoder = this.device.createCommandEncoder();

    for (const [streamId, frame] of frameMap) {
      if (!activeAssets.has(streamId)) {
        if (!frame.presented) releaseFrameBuffer(frame);
        frame.presented = true;
        continue;
      }

      if (!frame.presented) {
        this.uploadYuvFrame(encoder, streamId, frame);
      }
    }

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

    pass.setPipeline(this.renderPipeline);

    for (const streamId of frameMap.keys()) {
      if (!activeAssets.has(streamId)) continue;

      const layout = layoutMap.get(streamId);
      const gpuFrame = this.gpuFrames.get(streamId);
      if (!layout || !gpuFrame) continue;

      this.updateVertexBufferIfNeeded(gpuFrame, layout);
      pass.setBindGroup(0, gpuFrame.renderBindGroup);
      pass.setVertexBuffer(0, gpuFrame.vertexBuffer);
      pass.draw(6);
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private uploadYuvFrame(encoder: any, streamId: string, frame: Frame) {
    const yPlane = frame.yPlane;
    const uPlane = frame.uPlane;
    const vPlane = frame.vPlane;
    if (!frame.packetBuffer || !yPlane || !uPlane || !vPlane) return;

    const uploadStarted = performance.now();
    const gpuFrame = this.prepareFrame(streamId, frame);
    const chromaWidth = frame.width / 2;
    const chromaHeight = frame.height / 2;

    this.device.queue.writeTexture(
      { texture: gpuFrame.yTexture },
      yPlane,
      { bytesPerRow: frame.stride, rowsPerImage: frame.height },
      { width: frame.width, height: frame.height },
    );
    this.device.queue.writeTexture(
      { texture: gpuFrame.uTexture },
      uPlane,
      { bytesPerRow: chromaWidth, rowsPerImage: chromaHeight },
      { width: chromaWidth, height: chromaHeight },
    );
    this.device.queue.writeTexture(
      { texture: gpuFrame.vTexture },
      vPlane,
      { bytesPerRow: chromaWidth, rowsPerImage: chromaHeight },
      { width: chromaWidth, height: chromaHeight },
    );

    const computePass = encoder.beginComputePass();
    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, gpuFrame.computeBindGroup);
    computePass.dispatchWorkgroups(
      Math.ceil(frame.width / 8),
      Math.ceil(frame.height / 8),
    );
    computePass.end();

    releaseFrameBuffer(frame);
    frame.presented = true;
    metricsWindow.uploadLatencyMs.push(performance.now() - uploadStarted);
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
    const yTexture = this.device.createTexture({
      size: [frame.width, frame.height, 1],
      format: "r8unorm",
      usage: usage.TEXTURE_BINDING | usage.COPY_DST,
    });
    const uTexture = this.device.createTexture({
      size: [frame.width / 2, frame.height / 2, 1],
      format: "r8unorm",
      usage: usage.TEXTURE_BINDING | usage.COPY_DST,
    });
    const vTexture = this.device.createTexture({
      size: [frame.width / 2, frame.height / 2, 1],
      format: "r8unorm",
      usage: usage.TEXTURE_BINDING | usage.COPY_DST,
    });
    const rgbaTexture = this.device.createTexture({
      size: [frame.width, frame.height, 1],
      format: "rgba8unorm",
      usage:
        usage.TEXTURE_BINDING |
        usage.STORAGE_BINDING |
        usage.COPY_DST |
        usage.RENDER_ATTACHMENT,
    });
    const computeBindGroup = this.device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: yTexture.createView() },
        { binding: 1, resource: uTexture.createView() },
        { binding: 2, resource: vTexture.createView() },
        { binding: 3, resource: rgbaTexture.createView() },
      ],
    });
    const renderBindGroup = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: rgbaTexture.createView() },
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
      yTexture,
      uTexture,
      vTexture,
      rgbaTexture,
      computeBindGroup,
      renderBindGroup,
      vertexBuffer,
      layout: null,
    };
    this.gpuFrames.set(streamId, gpuFrame);
    return gpuFrame;
  }

  private updateVertexBufferIfNeeded(
    gpuFrame: { vertexBuffer: any; layout: Layout | null },
    layout: Layout,
  ) {
    if (layoutsEqual(gpuFrame.layout, layout)) return;

    this.device.queue.writeBuffer(
      gpuFrame.vertexBuffer,
      0,
      verticesForLayout(layout),
    );
    gpuFrame.layout = { ...layout };
  }

  private createYuvComputePipeline() {
    const shader = this.device.createShaderModule({
      code: `
// Minimal WGSL compute shader converts YUV420 planes to RGBA for presentation.
@group(0) @binding(0) var yTexture: texture_2d<f32>;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var vTexture: texture_2d<f32>;
@group(0) @binding(3) var outTexture: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn yuv420ToRgba(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTexture);
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }

  let y = textureLoad(yTexture, vec2i(id.xy), 0).r;
  let chromaCoord = vec2i(i32(id.x / 2u), i32(id.y / 2u));
  let u = textureLoad(uTexture, chromaCoord, 0).r - 0.5;
  let v = textureLoad(vTexture, chromaCoord, 0).r - 0.5;
  let r = y + 1.402 * v;
  let g = y - 0.344136 * u - 0.714136 * v;
  let b = y + 1.772 * u;
  textureStore(outTexture, vec2i(id.xy), vec4f(r, g, b, 1.0));
}
`,
    });

    return this.device.createComputePipeline({
      layout: "auto",
      compute: {
        module: shader,
        entryPoint: "yuv420ToRgba",
      },
    });
  }

  private createRenderPipeline(format: string) {
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

const yTable = new Int32Array(256);
const uToBTable = new Int32Array(256);
const uToGTable = new Int32Array(256);
const vToRTable = new Int32Array(256);
const vToGTable = new Int32Array(256);

for (let value = 0; value < 256; value += 1) {
  yTable[value] = 298 * Math.max(0, value - 16);
  uToBTable[value] = 516 * (value - 128);
  uToGTable[value] = -100 * (value - 128);
  vToRTable[value] = 409 * (value - 128);
  vToGTable[value] = -208 * (value - 128);
}

function yuv420ToRgba(
  yPlane: Uint8Array,
  uPlane: Uint8Array,
  vPlane: Uint8Array,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
) {
  // 2D fallback converts YUV420 to RGBA with lookup tables in the worker.
  const chromaWidth = width / 2;
  let output = 0;

  for (let y = 0; y < height; y += 1) {
    const yRow = y * width;
    const chromaRow = Math.floor(y / 2) * chromaWidth;
    for (let x = 0; x < width; x += 1) {
      const chromaIndex = chromaRow + Math.floor(x / 2);
      const yy = yTable[yPlane[yRow + x]];
      const u = uPlane[chromaIndex];
      const v = vPlane[chromaIndex];

      rgba[output] = clampByte((yy + vToRTable[v] + 128) >> 8);
      rgba[output + 1] = clampByte(
        (yy + uToGTable[u] + vToGTable[v] + 128) >> 8,
      );
      rgba[output + 2] = clampByte((yy + uToBTable[u] + 128) >> 8);
      rgba[output + 3] = 255;
      output += 4;
    }
  }
}

function clampByte(value: number) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

function layoutsEqual(left: Layout | null, right: Layout) {
  return (
    !!left &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
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
