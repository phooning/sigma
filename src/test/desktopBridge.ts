import { Channel, invoke } from "@tauri-apps/api/core";
import { onDropMedia } from "../components/CanvasActions";
import { useCanvasSessionStore } from "../stores/useCanvasSessionStore";
import { loadCanvasFromPath, saveToStorage } from "../utils/fs";

let frameChannel: Channel<ArrayBuffer> | undefined;
let packetBytes = 0;
let packetMagic = "";

export const desktopBridge = {
  async captureFrames() {
    packetBytes = 0;
    packetMagic = "";
    frameChannel = new Channel<ArrayBuffer>();
    frameChannel.onmessage = (data) => {
      const bytes = new Uint8Array(data);
      packetBytes = bytes.length;
      packetMagic = String.fromCharCode(...bytes.slice(0, 4));
    };
    await invoke("native_video_subscribe_frames", { onFrame: frameChannel });
  },
  frameInfo() {
    return { packetBytes, packetMagic };
  },
  /** Real drop-import path (probe over IPC, item creation, store commit). */
  async importPaths(paths: string[]) {
    const started = performance.now();
    const items = await onDropMedia({
      paths,
      viewportRef: { current: useCanvasSessionStore.getState().viewport },
    });
    useCanvasSessionStore
      .getState()
      .setItems((previous) => [...previous, ...items]);
    return {
      ok: true as const,
      elapsedMs: performance.now() - started,
      items: items.map((item) => ({
        id: item.id,
        filePath: item.filePath,
        sourceWidth: item.sourceWidth,
        sourceHeight: item.sourceHeight,
        duration: item.duration,
        frameRate: item.frameRate,
        fileSize: item.fileSize,
      })),
    };
  },
  sessionItemCount() {
    return useCanvasSessionStore.getState().items.length;
  },
  firstItem() {
    const item = useCanvasSessionStore.getState().items[0];
    return { id: item?.id, path: item?.filePath };
  },
  replaceWithVideo(path: string) {
    useCanvasSessionStore.getState().replaceSession({
      items: [
        {
          id: "ui-video",
          type: "video",
          filePath: path,
          url: "",
          x: 40,
          y: 60,
          width: 320,
          height: 320,
          sourceWidth: 64,
          sourceHeight: 64,
        },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      saveFilePath: null,
      lastSavedSignature: null,
    });
  },
  removeVideos() {
    useCanvasSessionStore
      .getState()
      .setItems((items) => items.filter((item) => item.type !== "video"));
  },
  clearFixture() {
    useCanvasSessionStore.getState().replaceSession({
      items: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      saveFilePath: null,
      lastSavedSignature: null,
    });
  },
  async saveFixture(project: string, image: string) {
    const item = {
      id: "lifecycle-image",
      type: "image" as const,
      filePath: image,
      url: "",
      x: 40,
      y: 60,
      width: 320,
      height: 240,
    };
    const store = useCanvasSessionStore.getState();
    store.replaceSession({
      items: [item],
      saveFilePath: null,
      lastSavedSignature: null,
    });
    const current = useCanvasSessionStore.getState();
    return saveToStorage(current.items, current.viewport, project);
  },
  async reopenFixture(project: string) {
    const result = await loadCanvasFromPath(project);
    if (!result.ok) return result;
    useCanvasSessionStore.getState().replaceSession({
      items: result.data.items,
      viewport: result.data.viewport,
      saveFilePath: project,
    });
    const item = useCanvasSessionStore.getState().items[0];
    return { ok: true as const, id: item?.id, path: item?.filePath };
  },
};

declare global {
  interface Window {
    __SIGMA_DESKTOP_TEST__?: typeof desktopBridge;
  }
}
