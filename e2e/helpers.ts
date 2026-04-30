import { expect, type Locator, type Page } from "@playwright/test";

export type CanvasSeedKind = "image" | "deferredVideo";

export type FrameSamplerResult = {
  frameDeltas: number[];
  longTasks: number[];
  observationMs: number;
};

type SigmaE2EHandle = {
  dropFiles: (paths: string[]) => Promise<void>;
  setOpenDialogResult: (value: string | string[] | null) => void;
  setSaveDialogResult: (value: string | null) => void;
  setMockFileText: (path: string, text: string) => void;
  getInvokeCalls: () => Array<{ cmd: string; args: unknown }>;
  clearInvokeCalls: () => void;
  setInvokeFailure: (
    cmd: string,
    options?: { path?: string; message?: string } | null,
  ) => void;
  clearInvokeFailures: () => void;
  waitForAnimationFrames: (count: number) => Promise<void>;
  startFrameSampler: () => void;
  stopFrameSampler: () => FrameSamplerResult;
};

type TauriEventPluginInternals = {
  unregisterListener: (event: string, eventId: number) => void;
};

type TauriInternals = {
  metadata: {
    currentWindow: { label: string };
    currentWebview: { label: string };
  };
  transformCallback: (callback: (payload: unknown) => void) => number;
  unregisterCallback: (callbackId: number) => void;
  convertFileSrc: (filePath: string) => string;
  invoke: (
    cmd: string,
    args?: Record<string, unknown> | Uint8Array,
    options?: { headers?: Record<string, string> },
  ) => Promise<unknown>;
};

type SigmaE2EWindow = Window &
  typeof globalThis & {
    __SIGMA_E2E__: SigmaE2EHandle;
    __TAURI_EVENT_PLUGIN_INTERNALS__: TauriEventPluginInternals;
    __TAURI_INTERNALS__: TauriInternals;
  };

const MOCK_IMAGE_DATA_URL =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
      <rect width="640" height="360" fill="#111827" />
      <rect x="24" y="24" width="592" height="312" rx="24" fill="#1f2937" />
      <circle cx="168" cy="180" r="78" fill="#10b981" />
      <rect x="284" y="118" width="198" height="28" rx="14" fill="#f9fafb" />
      <rect x="284" y="170" width="132" height="20" rx="10" fill="#9ca3af" />
      <rect x="284" y="206" width="174" height="20" rx="10" fill="#9ca3af" />
    </svg>
  `);

const PLAYWRIGHT_VIDEO_FIXTURE_URL = "/fixtures/generated-lod-test-1080p.webm";

export async function installTauriMocks(
  page: Page,
  options: { disableNativeImageSurface?: boolean } = {},
) {
  await page.addInitScript(
    ({
      mockImageDataUrl,
      playwrightVideoFixtureUrl,
      disableNativeImageSurface,
    }) => {
      type Callback = (payload: unknown) => void;
      type ListenerRecord = {
        event: string;
        handlerId: number;
      };
      type InvokeCall = {
        cmd: string;
        args: unknown;
      };
      type InvokeFailure = {
        cmd: string;
        path?: string;
        message: string;
      };
      type FrameSamplerState = {
        frameDeltas: number[];
        longTasks: number[];
        observer: PerformanceObserver | null;
        rafId: number | null;
        startedAt: number;
        lastFrameAt: number;
      };

      const callbacks = new Map<number, Callback>();
      const listeners = new Map<number, ListenerRecord>();
      const mockFiles = new Map<string, string>();
      const invokeCalls: InvokeCall[] = [];
      const invokeFailures: InvokeFailure[] = [];
      const tauriWindow = window as SigmaE2EWindow;
      let nextCallbackId = 1;
      let nextEventId = 1;
      let openDialogResult: string | string[] | null = null;
      let saveDialogResult: string | null = null;
      let frameSamplerState: FrameSamplerState | null = null;

      const textEncoder = new TextEncoder();
      const textDecoder = new TextDecoder();

      const waitForAnimationFrames = async (count = 1) => {
        for (let index = 0; index < count; index += 1) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        }
      };

      const dispatchTauriEvent = async (event: string, payload: unknown) => {
        listeners.forEach((listener, eventId) => {
          if (listener.event !== event) return;

          const callback = callbacks.get(listener.handlerId);
          callback?.({
            event,
            id: eventId,
            payload,
          });
        });

        await waitForAnimationFrames(1);
      };

      const getExtension = (path: string) =>
        path.split(".").pop()?.toLowerCase() ?? "";

      const normalizePath = (path: string) => path.replaceAll("\\", "/");

      const pathMatches = (
        expectedPath: string | undefined,
        actualPath: unknown,
      ) =>
        expectedPath === undefined ||
        (typeof actualPath === "string" &&
          normalizePath(actualPath) === normalizePath(expectedPath));

      const findInvokeFailure = (
        cmd: string,
        args: Record<string, unknown> | Uint8Array,
      ) => {
        if (args instanceof Uint8Array) return null;

        return (
          invokeFailures.find(
            (entry) => entry.cmd === cmd && pathMatches(entry.path, args.path),
          ) ?? null
        );
      };

      const toMediaUrl = (filePath: string) => {
        const extension = getExtension(filePath);
        if (["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) {
          return mockImageDataUrl;
        }

        if (["mp4", "webm", "mov", "mkv"].includes(extension)) {
          return playwrightVideoFixtureUrl;
        }

        return "";
      };

      if (disableNativeImageSurface) {
        // Force DOM image rendering when an e2e test needs observable image LOD state.
        delete (
          HTMLCanvasElement.prototype as HTMLCanvasElement & {
            transferControlToOffscreen?: () => OffscreenCanvas;
          }
        ).transferControlToOffscreen;
      }

      const getCallbackId = (handler: unknown) => {
        if (typeof handler === "number") return handler;

        if (typeof handler === "string" && handler.startsWith("__CHANNEL__:")) {
          return Number(handler.slice("__CHANNEL__:".length));
        }

        if (
          typeof handler === "object" &&
          handler !== null &&
          "id" in handler &&
          typeof (handler as { id: unknown }).id === "number"
        ) {
          return (handler as { id: number }).id;
        }

        throw new Error(`Unsupported Tauri handler: ${String(handler)}`);
      };

      tauriWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: (_event: string, eventId: number) => {
          listeners.delete(eventId);
        },
      };

      tauriWindow.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: (callback: Callback) => {
          const callbackId = nextCallbackId++;
          callbacks.set(callbackId, callback);
          return callbackId;
        },
        unregisterCallback: (callbackId: number) => {
          callbacks.delete(callbackId);
        },
        convertFileSrc: toMediaUrl,
        invoke: async (
          cmd: string,
          args: Record<string, unknown> | Uint8Array = {},
          options?: { headers?: Record<string, string> },
        ) => {
          invokeCalls.push({
            cmd,
            args: args instanceof Uint8Array ? {} : args,
          });

          const invokeFailure = findInvokeFailure(cmd, args);
          if (invokeFailure) {
            throw new Error(invokeFailure.message);
          }

          const objectArgs = args instanceof Uint8Array ? {} : args;

          switch (cmd) {
            case "plugin:event|listen": {
              const eventId = nextEventId++;
              listeners.set(eventId, {
                event: String(objectArgs.event),
                handlerId: getCallbackId(objectArgs.handler),
              });
              return eventId;
            }

            case "plugin:event|unlisten": {
              listeners.delete(Number(objectArgs.eventId));
              return null;
            }

            case "plugin:event|emit":
            case "plugin:event|emit_to":
              return null;

            case "plugin:dialog|open":
              return openDialogResult;

            case "plugin:dialog|save":
              return saveDialogResult;

            case "plugin:fs|write_text_file": {
              const path = decodeURIComponent(
                String(options?.headers?.path ?? ""),
              );
              const bytes =
                args instanceof Uint8Array
                  ? args
                  : Array.isArray(args)
                    ? Uint8Array.from(args)
                    : new Uint8Array();

              mockFiles.set(path, textDecoder.decode(bytes));
              return null;
            }

            case "plugin:fs|read_text_file": {
              const path = String(objectArgs.path ?? "");
              const contents = mockFiles.get(path) ?? "";
              return Array.from(textEncoder.encode(contents));
            }

            case "plugin:fs|read":
              return null;

            case "plugin:opener|reveal_item_in_dir":
              return null;

            case "plugin:shell|execute": {
              if (objectArgs.program === "gpu-info") {
                return {
                  code: 0,
                  signal: null,
                  stdout: JSON.stringify({
                    SPDisplaysDataType: [
                      {
                        sppci_model: "Playwright Test GPU",
                        spdisplays_vram: "8 GB",
                      },
                    ],
                  }),
                  stderr: "",
                };
              }

              if (objectArgs.program === "gpu-usage") {
                return {
                  code: 0,
                  signal: null,
                  stdout: '"GPU Utilization" = 37\n"VRAM Used" = 104857600\n',
                  stderr: "",
                };
              }

              return {
                code: 0,
                signal: null,
                stdout: "",
                stderr: "",
              };
            }

            case "probe_media": {
              const path = String(objectArgs.path ?? "");
              const isVideo = /\.(mp4|webm|mov|mkv)$/i.test(path);

              return isVideo
                ? {
                    width: 1920,
                    height: 1080,
                    duration: 8,
                    size: 838 * 1024,
                  }
                : {};
            }

            case "generate_video_thumbnail":
              return "/tmp/playwright-thumbnail.png";

            case "save_media_screenshot":
              return "/tmp/playwright-screenshot.png";

            case "export_video":
              return String(
                objectArgs.outputPath ?? "/tmp/playwright-export.mp4",
              );

            default:
              return null;
          }
        },
      };

      tauriWindow.__SIGMA_E2E__ = {
        dropFiles: async (paths: string[]) => {
          await dispatchTauriEvent("tauri://drag-drop", {
            paths,
            position: {
              x: Math.round(window.innerWidth / 2),
              y: Math.round(window.innerHeight / 2),
            },
          });
        },
        setOpenDialogResult: (value) => {
          openDialogResult = value;
        },
        setSaveDialogResult: (value) => {
          saveDialogResult = value;
        },
        setMockFileText: (path, text) => {
          mockFiles.set(path, text);
        },
        getInvokeCalls: () => [...invokeCalls],
        clearInvokeCalls: () => {
          invokeCalls.length = 0;
        },
        setInvokeFailure: (cmd, options) => {
          invokeFailures.push({
            cmd,
            path: options?.path,
            message: options?.message ?? `Mocked failure for ${cmd}`,
          });
        },
        clearInvokeFailures: () => {
          invokeFailures.length = 0;
        },
        waitForAnimationFrames,
        startFrameSampler: () => {
          if (frameSamplerState?.rafId != null) {
            cancelAnimationFrame(frameSamplerState.rafId);
          }
          frameSamplerState?.observer?.disconnect();

          const state: FrameSamplerState = {
            frameDeltas: [],
            longTasks: [],
            observer: null,
            rafId: null,
            startedAt: performance.now(),
            lastFrameAt: performance.now(),
          };

          if (
            "PerformanceObserver" in window &&
            Array.isArray(PerformanceObserver.supportedEntryTypes) &&
            PerformanceObserver.supportedEntryTypes.includes("longtask")
          ) {
            state.observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                state.longTasks.push(entry.duration);
              }
            });
            state.observer.observe({ type: "longtask", buffered: true });
          }

          const sampleFrame = (timestamp: number) => {
            state.frameDeltas.push(timestamp - state.lastFrameAt);
            state.lastFrameAt = timestamp;
            state.rafId = requestAnimationFrame(sampleFrame);
          };

          state.rafId = requestAnimationFrame(sampleFrame);
          frameSamplerState = state;
        },
        stopFrameSampler: () => {
          if (frameSamplerState === null) {
            return {
              frameDeltas: [],
              longTasks: [],
              observationMs: 0,
            };
          }

          if (frameSamplerState.rafId !== null) {
            cancelAnimationFrame(frameSamplerState.rafId);
          }
          frameSamplerState.observer?.disconnect();

          const result = {
            frameDeltas: [...frameSamplerState.frameDeltas],
            longTasks: [...frameSamplerState.longTasks],
            observationMs: performance.now() - frameSamplerState.startedAt,
          };
          frameSamplerState = null;
          return result;
        },
      };
    },
    {
      mockImageDataUrl: MOCK_IMAGE_DATA_URL,
      playwrightVideoFixtureUrl: PLAYWRIGHT_VIDEO_FIXTURE_URL,
      disableNativeImageSurface: options.disableNativeImageSurface ?? false,
    },
  );
}

export async function gotoApp(
  page: Page,
  options: { disableNativeImageSurface?: boolean } = {},
) {
  await installTauriMocks(page, options);
  await page.goto("/");
  await expect(page.getByText("SIGMA Media Canvas")).toBeVisible();
  await expect(page.getByText("0 items")).toBeVisible();
}

export async function dropFiles(page: Page, paths: string[]) {
  await page.evaluate((filePaths) => {
    const handle = (window as typeof window & { __SIGMA_E2E__: SigmaE2EHandle })
      .__SIGMA_E2E__;
    return handle.dropFiles(filePaths);
  }, paths);
}

export async function setOpenDialogResult(
  page: Page,
  value: string | string[] | null,
) {
  await page.evaluate((dialogValue) => {
    const handle = (window as typeof window & { __SIGMA_E2E__: SigmaE2EHandle })
      .__SIGMA_E2E__;
    handle.setOpenDialogResult(dialogValue);
  }, value);
}

export async function setSaveDialogResult(page: Page, value: string | null) {
  await page.evaluate((dialogValue) => {
    const handle = (window as typeof window & { __SIGMA_E2E__: SigmaE2EHandle })
      .__SIGMA_E2E__;
    handle.setSaveDialogResult(dialogValue);
  }, value);
}

export async function setMockFileText(page: Page, path: string, text: string) {
  await page.evaluate(
    ({ filePath, fileText }) => {
      const handle = (
        window as typeof window & { __SIGMA_E2E__: SigmaE2EHandle }
      ).__SIGMA_E2E__;
      handle.setMockFileText(filePath, fileText);
    },
    { filePath: path, fileText: text },
  );
}

export async function getInvokeCalls(page: Page) {
  return page.evaluate(() => {
    const handle = (window as typeof window & { __SIGMA_E2E__: SigmaE2EHandle })
      .__SIGMA_E2E__;
    return handle.getInvokeCalls();
  });
}

export async function clearInvokeCalls(page: Page) {
  await page.evaluate(() => {
    const handle = (window as typeof window & { __SIGMA_E2E__: SigmaE2EHandle })
      .__SIGMA_E2E__;
    handle.clearInvokeCalls();
  });
}

export async function setInvokeFailure(
  page: Page,
  cmd: string,
  options?: { path?: string; message?: string } | null,
) {
  await page.evaluate(
    ({ invokeCmd, invokeOptions }) => {
      const handle = (
        window as typeof window & { __SIGMA_E2E__: SigmaE2EHandle }
      ).__SIGMA_E2E__;
      handle.setInvokeFailure(invokeCmd, invokeOptions);
    },
    { invokeCmd: cmd, invokeOptions: options ?? null },
  );
}

export async function clearInvokeFailures(page: Page) {
  await page.evaluate(() => {
    const handle = (window as typeof window & { __SIGMA_E2E__: SigmaE2EHandle })
      .__SIGMA_E2E__;
    handle.clearInvokeFailures();
  });
}

export async function waitForAnimationFrames(page: Page, count = 2) {
  await page.evaluate((frameCount) => {
    const handle = (window as typeof window & { __SIGMA_E2E__: SigmaE2EHandle })
      .__SIGMA_E2E__;
    return handle.waitForAnimationFrames(frameCount);
  }, count);
}

export async function startFrameSampler(page: Page) {
  await page.evaluate(() => {
    const handle = (window as typeof window & { __SIGMA_E2E__: SigmaE2EHandle })
      .__SIGMA_E2E__;
    handle.startFrameSampler();
  });
}

export async function stopFrameSampler(page: Page) {
  return page.evaluate(() => {
    const handle = (window as typeof window & { __SIGMA_E2E__: SigmaE2EHandle })
      .__SIGMA_E2E__;
    return handle.stopFrameSampler();
  });
}

export async function openSettings(page: Page) {
  await page.getByRole("button", { name: /open settings/i }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

const TOOLBAR_LOAD_BUTTON_NAME = /^Load$/;
const DEFAULT_CONFIG_PATH = "/tmp/playwright-canvas.json";

const buildSeedItem = (index: number, kind: CanvasSeedKind) => {
  const width = 320;
  const height = 180;
  const columns = 10;
  const gap = 48;
  const x = (index % columns) * (width + gap);
  const y = Math.floor(index / columns) * (height + gap);

  if (kind === "deferredVideo") {
    return {
      id: `seed-video-${index}`,
      type: "video",
      filePath: `/tmp/e2e/seed-video-${index}.mp4`,
      thumbnailPath: `/tmp/e2e/seed-video-${index}.png`,
      fileSize: 150 * 1024 * 1024,
      duration: 8,
      sourceWidth: 1920,
      sourceHeight: 1080,
      deferVideoLoad: true,
      x,
      y,
      width,
      height,
    };
  }

  return {
    id: `seed-image-${index}`,
    type: "image",
    filePath: `/tmp/e2e/seed-image-${index}.png`,
    sourceWidth: 1920,
    sourceHeight: 1080,
    x,
    y,
    width,
    height,
  };
};

export async function loadCanvasConfig(
  page: Page,
  config: {
    items: unknown[];
    viewport: { x: number; y: number; zoom: number };
  },
  path = DEFAULT_CONFIG_PATH,
) {
  await setMockFileText(page, path, JSON.stringify(config));
  await setOpenDialogResult(page, path);

  const loadStartedAt = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: TOOLBAR_LOAD_BUTTON_NAME }).click();
  await expect(page.getByText(`${config.items.length} items`)).toBeVisible();
  await waitForAnimationFrames(page, 2);
  const loadCompletedAt = await page.evaluate(() => performance.now());

  return {
    loadMs: loadCompletedAt - loadStartedAt,
  };
}

export async function seedCanvasItems(
  page: Page,
  count: number,
  kind: CanvasSeedKind = "image",
) {
  const items = Array.from({ length: count }, (_, index) =>
    buildSeedItem(index, kind),
  );

  const loadResult = await loadCanvasConfig(page, {
    items,
    viewport: { x: 0, y: 0, zoom: 1 },
  });

  return {
    ...loadResult,
    items,
    kind,
    count,
  };
}

const selectAllShortcut =
  process.platform === "darwin" ? "Meta+A" : "Control+A";

export async function deleteAllItems(page: Page) {
  const itemCountText = (await page.locator(".item-count").textContent()) ?? "";
  if (itemCountText.trim() === "0 items") return;

  await page.keyboard.press(selectAllShortcut);
  await page.keyboard.press("Delete");
  await expect(page.getByText("0 items")).toBeVisible();
  await waitForAnimationFrames(page, 2);
}

export const mediaItems = (page: Page): Locator => page.locator(".media-item");
export const canvasWorld = (page: Page): Locator =>
  page.locator(".canvas-world");
