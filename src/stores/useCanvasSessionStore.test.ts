import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadFromStorage,
  saveToStorage,
  selectCanvasSavePath,
} from "../utils/fs";
import type { MediaItem } from "../utils/media.types";
import { notify } from "../utils/notifications";
import {
  flushSessionPersistence,
  INITIAL_VIEWPORT,
  prepareSessionShutdown,
  resumeSession,
  useCanvasSessionStore,
} from "./useCanvasSessionStore";
import { useDevStore } from "./useDevStore";
import { useSettingsStore } from "./useSettingsStore";

vi.mock("../utils/fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/fs")>()),
  loadFromStorage: vi.fn(),
  saveToStorage: vi.fn(),
  selectCanvasSavePath: vi.fn(),
}));
vi.mock("../utils/notifications", () => ({
  notify: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const item: MediaItem = {
  id: "one",
  type: "image",
  filePath: "/photo.png",
  url: "",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
};
const saved = { ok: true as const, filePath: "/canvas.json" };
const loaded = {
  ok: true as const,
  filePath: "/other.json",
  data: { items: [{ ...item, id: "other" }], viewport: INITIAL_VIEWPORT },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function edit(x: number) {
  useCanvasSessionStore
    .getState()
    .setItems((items) => items.map((value) => ({ ...value, x })));
}

describe("canvas persistence lifecycle", () => {
  beforeEach(() => {
    resumeSession();
    vi.resetAllMocks();
    useSettingsStore.getState().replaceSessionSettings({
      screenshotDirectory: "",
      canvasBackgroundPattern: "dots",
    });
    useDevStore.getState().setDevMode(false);
    useCanvasSessionStore.getState().replaceSession({
      items: [],
      viewport: INITIAL_VIEWPORT,
      saveFilePath: null,
      lastSavedSignature: null,
    });
    useCanvasSessionStore.getState().setItems([item]);
  });

  it.each(["save", "save as"])(
    "keeps edits made during %s dirty",
    async (mode) => {
      if (mode === "save")
        useCanvasSessionStore.setState({ saveFilePath: "/canvas.json" });
      vi.mocked(selectCanvasSavePath).mockResolvedValue("/canvas.json");
      const pending = deferred<typeof saved>();
      vi.mocked(saveToStorage).mockReturnValue(pending.promise);
      const operation =
        mode === "save"
          ? useCanvasSessionStore.getState().saveSessionToFile()
          : useCanvasSessionStore.getState().saveSessionToNewFile();
      await vi.waitFor(() => expect(saveToStorage).toHaveBeenCalledOnce());
      edit(50);
      useSettingsStore.getState().setCanvasBackgroundPattern("grid");
      pending.resolve(saved);
      await operation;
      expect(useCanvasSessionStore.getState().isDirty).toBe(true);
      edit(0);
      expect(useCanvasSessionStore.getState().isDirty).toBe(true);
      useSettingsStore.getState().setCanvasBackgroundPattern("dots");
      useCanvasSessionStore.getState().refreshDirtyState();
      expect(useCanvasSessionStore.getState().isDirty).toBe(false);
    },
  );

  it("serializes saves in request order and marks the latest written snapshot clean", async () => {
    useCanvasSessionStore.setState({ saveFilePath: "/canvas.json" });
    const first = deferred<typeof saved>();
    const second = deferred<typeof saved>();
    vi.mocked(saveToStorage)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const firstSave = useCanvasSessionStore.getState().saveSessionToFile();
    edit(20);
    const secondSave = useCanvasSessionStore.getState().saveSessionToFile();
    await vi.waitFor(() => expect(saveToStorage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveToStorage).mock.calls[0][0][0].x).toBe(0);
    first.resolve(saved);
    await firstSave;
    await vi.waitFor(() => expect(saveToStorage).toHaveBeenCalledTimes(2));
    expect(useCanvasSessionStore.getState().isDirty).toBe(true);
    expect(vi.mocked(saveToStorage).mock.calls[1][0][0].x).toBe(20);
    second.resolve(saved);
    await secondSave;
    expect(useCanvasSessionStore.getState().isDirty).toBe(false);
  });

  it("keeps the existing destination and dirty state when Save As is canceled or fails", async () => {
    useCanvasSessionStore.setState({ saveFilePath: "/canvas.json" });
    vi.mocked(selectCanvasSavePath)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("/new.json");
    await useCanvasSessionStore.getState().saveSessionToNewFile();
    expect(saveToStorage).not.toHaveBeenCalled();
    vi.mocked(saveToStorage).mockResolvedValue({
      ok: false,
      reason: "error",
      error: "disk full",
    });
    await useCanvasSessionStore.getState().saveSessionToNewFile();
    expect(useCanvasSessionStore.getState().saveFilePath).toBe("/canvas.json");
    expect(useCanvasSessionStore.getState().isDirty).toBe(true);
  });

  it("loads only after an earlier pending save and does not let its completion affect the loaded project", async () => {
    useCanvasSessionStore.setState({ saveFilePath: "/canvas.json" });
    const pending = deferred<typeof saved>();
    vi.mocked(saveToStorage).mockReturnValue(pending.promise);
    vi.mocked(loadFromStorage).mockResolvedValue(loaded);
    const save = useCanvasSessionStore.getState().saveSessionToFile();
    const load = useCanvasSessionStore.getState().loadSessionFromFile();
    await vi.waitFor(() => expect(saveToStorage).toHaveBeenCalledOnce());
    expect(loadFromStorage).not.toHaveBeenCalled();
    pending.resolve(saved);
    await save;
    expect(await load).toBe(true);
    expect(useCanvasSessionStore.getState().saveFilePath).toBe("/other.json");
    expect(useCanvasSessionStore.getState().items[0].id).toBe("other");
    expect(useCanvasSessionStore.getState().isDirty).toBe(false);
  });

  it("uses the new destination for a quick save queued behind Save As", async () => {
    useCanvasSessionStore.setState({ saveFilePath: "/canvas.json" });
    const picker = deferred<string | null>();
    vi.mocked(selectCanvasSavePath).mockReturnValue(picker.promise);
    vi.mocked(saveToStorage).mockResolvedValue({
      ok: true,
      filePath: "/new.json",
    });
    const saveAs = useCanvasSessionStore.getState().saveSessionToNewFile();
    await vi.waitFor(() => expect(selectCanvasSavePath).toHaveBeenCalledOnce());
    edit(30);
    const quickSave = useCanvasSessionStore.getState().saveSessionToFile();
    picker.resolve("/new.json");
    await Promise.all([saveAs, quickSave]);
    expect(vi.mocked(saveToStorage).mock.calls.map((call) => call[2])).toEqual([
      "/new.json",
      "/new.json",
    ]);
    expect(useCanvasSessionStore.getState().isDirty).toBe(false);
  });

  it("ignores a save completion after replacing a session at the same path", async () => {
    useCanvasSessionStore.setState({ saveFilePath: "/canvas.json" });
    const pending = deferred<typeof saved>();
    vi.mocked(saveToStorage).mockReturnValue(pending.promise);
    const save = useCanvasSessionStore.getState().saveSessionToFile();
    await vi.waitFor(() => expect(saveToStorage).toHaveBeenCalledOnce());
    useCanvasSessionStore.getState().replaceSession({
      items: [{ ...item, id: "replacement" }],
      saveFilePath: "/canvas.json",
      lastSavedSignature: null,
    });
    pending.resolve(saved);
    await save;
    expect(useCanvasSessionStore.getState().items[0].id).toBe("replacement");
    expect(useCanvasSessionStore.getState().isDirty).toBe(true);
    expect(useCanvasSessionStore.getState().lastSavedSignature).toBeNull();
  });

  it("ignores a stale load after session replacement or edits", async () => {
    const pending = deferred<typeof loaded>();
    vi.mocked(loadFromStorage).mockReturnValue(pending.promise);
    const load = useCanvasSessionStore.getState().loadSessionFromFile();
    await vi.waitFor(() => expect(loadFromStorage).toHaveBeenCalledOnce());
    useCanvasSessionStore
      .getState()
      .replaceSession({ items: [{ ...item, id: "replacement" }] });
    pending.resolve(loaded);
    expect(await load).toBe(false);
    expect(useCanvasSessionStore.getState().items[0].id).toBe("replacement");
    const next = deferred<typeof loaded>();
    vi.mocked(loadFromStorage).mockReturnValueOnce(next.promise);
    const second = useCanvasSessionStore.getState().loadSessionFromFile();
    await vi.waitFor(() => expect(loadFromStorage).toHaveBeenCalledTimes(2));
    edit(40);
    next.resolve(loaded);
    expect(await second).toBe(false);
    expect(useCanvasSessionStore.getState().items[0].x).toBe(40);
    expect(notify.warning).toHaveBeenCalledWith(
      "Load canceled",
      expect.anything(),
    );
  });

  it("does not write a Save As whose picker resolves after session replacement", async () => {
    const picker = deferred<string | null>();
    vi.mocked(selectCanvasSavePath).mockReturnValue(picker.promise);
    const save = useCanvasSessionStore.getState().saveSessionToNewFile();
    await vi.waitFor(() => expect(selectCanvasSavePath).toHaveBeenCalledOnce());
    useCanvasSessionStore.getState().replaceSession({ items: [] });
    picker.resolve("/canvas.json");
    await save;
    expect(saveToStorage).not.toHaveBeenCalled();
  });

  it.each([
    "{broken",
    JSON.stringify({ state: { items: "broken" }, version: 0 }),
    JSON.stringify({ state: { items: [] }, version: 9 }),
  ])(
    "preserves invalid recovery data after hydration and later mutations: %s",
    async (contents) => {
      localStorage.setItem("sigma:canvas-session", contents);
      await useCanvasSessionStore.persist.rehydrate();
      useCanvasSessionStore.getState().setViewport({ x: 20, y: 30, zoom: 1 });
      expect(localStorage.getItem("sigma:canvas-session")).toBe(contents);
      expect(notify.error).toHaveBeenCalled();
      localStorage.removeItem("sigma:canvas-session");
      await useCanvasSessionStore.persist.rehydrate();
    },
  );

  it("waits for both queued snapshots before permitting shutdown and freezes late edits", async () => {
    useCanvasSessionStore.setState({ saveFilePath: "/canvas.json" });
    const first = deferred<typeof saved>();
    const second = deferred<typeof saved>();
    vi.mocked(saveToStorage)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const one = useCanvasSessionStore.getState().saveSessionToFile();
    edit(25);
    const two = useCanvasSessionStore.getState().saveSessionToFile();
    let closed = false;
    const shutdown = prepareSessionShutdown().then(() => {
      closed = true;
    });
    edit(999);
    expect(useCanvasSessionStore.getState().items[0].x).toBe(25);
    first.resolve(saved);
    await one;
    expect(closed).toBe(false);
    second.resolve(saved);
    await Promise.all([two, shutdown]);
    expect(closed).toBe(true);
    expect(useCanvasSessionStore.getState().isDirty).toBe(false);
    resumeSession();
    edit(30);
    expect(useCanvasSessionStore.getState().items[0].x).toBe(30);
  });

  it("rejects shutdown after a failed write and allows a successful retry", async () => {
    useCanvasSessionStore.setState({ saveFilePath: "/canvas.json" });
    vi.mocked(saveToStorage)
      .mockResolvedValueOnce({ ok: false, reason: "error", error: "disk full" })
      .mockResolvedValueOnce(saved);
    await useCanvasSessionStore.getState().saveSessionToFile();
    await expect(flushSessionPersistence()).rejects.toBe("disk full");
    await useCanvasSessionStore.getState().saveSessionToFile();
    await expect(flushSessionPersistence()).resolves.toBeUndefined();
  });

  it("saves an undo to the last committed state even while an earlier changed snapshot is pending", async () => {
    useCanvasSessionStore.setState({ saveFilePath: "/canvas.json" });
    vi.mocked(saveToStorage).mockResolvedValue(saved);
    await useCanvasSessionStore.getState().saveSessionToFile();
    const pending = deferred<typeof saved>();
    vi.mocked(saveToStorage).mockReturnValueOnce(pending.promise);
    edit(10);
    const changed = useCanvasSessionStore.getState().saveSessionToFile();
    await vi.waitFor(() => expect(saveToStorage).toHaveBeenCalledTimes(2));
    edit(0);
    expect(useCanvasSessionStore.getState().isDirty).toBe(false);
    const undone = useCanvasSessionStore.getState().saveSessionToFile();
    pending.resolve(saved);
    await Promise.all([changed, undone]);
    expect(saveToStorage).toHaveBeenCalledTimes(3);
    expect(vi.mocked(saveToStorage).mock.calls[2][0][0].x).toBe(0);
    expect(useCanvasSessionStore.getState().isDirty).toBe(false);
  });
});
