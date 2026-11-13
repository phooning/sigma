import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCanvasConfigData,
  getProjectRootForConfig,
  isStoredCanvasConfig,
  loadCanvasFromPath,
  loadFromStorage,
  resolveProjectPath,
  saveToStorage,
  saveToStorageAs,
  toProjectRelativePath,
} from "./fs";
import type { MediaItem } from "./media.types";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(),
}));

const baseItem: MediaItem = {
  id: "image-1",
  type: "image",
  filePath: "/Users/test/project/assets/photo.png",
  url: "asset:///Users/test/project/assets/photo.png",
  x: 12,
  y: 34,
  width: 640,
  height: 480,
};

describe("project path helpers", () => {
  it("uses the config file directory as the project root", () => {
    expect(getProjectRootForConfig("/Users/test/project/canvas.json")).toBe(
      "/Users/test/project",
    );
  });

  it("converts absolute asset paths to project-relative paths", () => {
    expect(
      toProjectRelativePath(
        "/Users/test/project",
        "/Users/test/project/assets/photo.png",
      ),
    ).toBe("assets/photo.png");
  });

  it("resolves saved project-relative paths back under the project root", () => {
    expect(resolveProjectPath("/Users/test/project", "assets/photo.png")).toBe(
      "/Users/test/project/assets/photo.png",
    );
  });
});

describe("canvas config storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts legacy files and rejects future schemas or malformed media before hydration", async () => {
    const legacy = { items: [{ ...baseItem, url: undefined }] };
    expect(isStoredCanvasConfig(legacy)).toBe(true);
    expect(isStoredCanvasConfig({ ...legacy, schemaVersion: 2 })).toBe(false);
    vi.mocked(readTextFile).mockResolvedValue(
      JSON.stringify({ ...legacy, schemaVersion: 2 }),
    );
    const future = await loadCanvasFromPath("/project/future.json");
    expect(future).toMatchObject({ ok: false, reason: "invalid" });
    expect(String(!future.ok && future.error)).toContain("format version 2");
    expect(
      isStoredCanvasConfig({
        ...legacy,
        items: [legacy.items[0], legacy.items[0]],
      }),
    ).toBe(false);
    for (const field of [
      { frameRate: "30" },
      { sourceWidth: -1 },
      { thumbnailPath: 7 },
      { crop: { top: 0, right: 0, bottom: "bad", left: 0 } },
    ]) {
      vi.mocked(readTextFile).mockResolvedValue(
        JSON.stringify({
          items: [{ ...legacy.items[0], ...field }],
        }),
      );
      const result = await loadCanvasFromPath("/project/bad.json");
      expect(result.ok).toBe(false);
    }
  });

  it("accepts deterministic application-produced image and video documents", () => {
    for (let seed = 0; seed < 80; seed++) {
      const items: MediaItem[] = Array.from(
        { length: seed % 7 },
        (_, index) => ({
          ...baseItem,
          id: `item-${seed}-${index}`,
          type: index % 2 ? "video" : "image",
          filePath: `/Users/test/project/assets/${seed}-${index}.mp4`,
          x: seed * 17 - index * 13,
          y: index * 23 - seed,
          width: 1 + seed + index,
          height: 1 + index * 2,
          ...(index % 2 ? { duration: seed / 3, frameRate: 24000 / 1001 } : {}),
          ...(index % 3
            ? { sourceWidth: 320 + seed, sourceHeight: 240 + index }
            : {}),
          ...(index % 4
            ? { crop: { top: 0, right: index, bottom: seed / 10, left: 0 } }
            : {}),
        }),
      );
      const text = getCanvasConfigData(
        items,
        { x: seed - 30, y: -seed, zoom: 0.1 + seed / 40 },
        "/Users/test/project/canvas.json",
      );
      const parsed: unknown = JSON.parse(text);
      expect(isStoredCanvasConfig(parsed)).toBe(true);
      expect(parsed).toMatchObject({ schemaVersion: 1 });
    }
  });

  it("rejects invalid numbers and null before JSON can turn them into stored corruption", async () => {
    const invalidItems: MediaItem[][] = [
      [{ ...baseItem, x: Number.NaN }],
      [{ ...baseItem, frameRate: Number.POSITIVE_INFINITY }],
      [{ ...baseItem, sourceWidth: null as unknown as number }],
      [{ ...baseItem, url: null as unknown as string }],
      [{ ...baseItem, imageLod: "bad" as MediaItem["imageLod"] }],
      [
        {
          ...baseItem,
          crop: { top: 0, right: 0, bottom: Number.NaN, left: 0 },
        },
      ],
    ];
    for (const items of invalidItems) {
      expect(() =>
        getCanvasConfigData(items, { x: 0, y: 0, zoom: 1 }, "/canvas.json"),
      ).toThrow();
      const result = await saveToStorage(
        items,
        { x: 0, y: 0, zoom: 1 },
        "/canvas.json",
      );
      expect(result.ok).toBe(false);
    }
    expect(() =>
      getCanvasConfigData(
        [baseItem],
        { x: 0, y: 0, zoom: Infinity },
        "/canvas.json",
      ),
    ).toThrow();
    expect(() =>
      getCanvasConfigData(
        [baseItem],
        { x: 0, y: 0, zoom: 1 },
        "/canvas.json",
        null as unknown as undefined,
      ),
    ).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("saves media file paths relative to the config folder", async () => {
    const result = await saveToStorage(
      [baseItem],
      { x: 1, y: 2, zoom: 3 },
      "/Users/test/project/canvas.json",
      { screenshotDirectory: "/shots", canvasBackgroundPattern: "grid" },
      true,
    );

    expect(result).toEqual({
      ok: true,
      filePath: "/Users/test/project/canvas.json",
    });
    expect(invoke).toHaveBeenCalledOnce();

    const [, args] = vi.mocked(invoke).mock.calls[0];
    const { path: filePath, contents } = args as {
      path: string;
      contents: string;
    };
    const config = JSON.parse(contents);

    expect(filePath).toBe("/Users/test/project/canvas.json");
    expect(config.items[0].filePath).toBe("assets/photo.png");
    expect(config.items[0].url).toBeUndefined();
    expect(config.viewport).toEqual({ x: 1, y: 2, zoom: 3 });
    expect(config.settings).toEqual({
      screenshotDirectory: "/shots",
      canvasBackgroundPattern: "grid",
    });
    expect(config.devMode).toBe(true);
  });

  it("persists probed video frame rates so frame stepping survives reload", async () => {
    const video: MediaItem = {
      ...baseItem,
      id: "video-1",
      type: "video",
      filePath: "/Users/test/project/clips/film.mp4",
      duration: 10.88,
      frameRate: 24000 / 1001,
    };
    const config = JSON.parse(
      getCanvasConfigData(
        [video],
        { x: 0, y: 0, zoom: 1 },
        "/Users/test/project/canvas.json",
      ),
    );
    expect(config.items[0].frameRate).toBeCloseTo(23.976, 3);

    vi.mocked(open).mockResolvedValue("/Users/test/project/canvas.json");
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify(config));
    const loaded = await loadFromStorage();
    expect(loaded.ok && loaded.data.items[0].frameRate).toBeCloseTo(23.976, 3);
  });

  it("opens a picker for save as and returns the selected path", async () => {
    vi.mocked(save).mockResolvedValue("/Users/test/project/scene.json");

    const result = await saveToStorageAs([baseItem], { x: 1, y: 2, zoom: 3 });

    expect(result).toEqual({
      ok: true,
      filePath: "/Users/test/project/scene.json",
    });
    expect(save).toHaveBeenCalledWith({
      title: "Save canvas",
      defaultPath: "canvas.json",
      filters: [
        {
          name: "Canvas Config",
          extensions: ["json"],
        },
      ],
    });
  });

  it("builds config data with session settings and debug mode", () => {
    const config = JSON.parse(
      getCanvasConfigData(
        [baseItem],
        { x: 1, y: 2, zoom: 3 },
        "/Users/test/project/canvas.json",
        {
          screenshotDirectory: "/shots",
          canvasBackgroundPattern: "grid",
        },
        true,
      ),
    );

    expect(config.settings).toEqual({
      screenshotDirectory: "/shots",
      canvasBackgroundPattern: "grid",
    });
    expect(config.devMode).toBe(true);
  });

  it("loads project-relative media file paths from the selected config folder", async () => {
    vi.mocked(open).mockResolvedValue("/Users/test/project/canvas.json");
    vi.mocked(readTextFile).mockResolvedValue(
      JSON.stringify({
        items: [{ ...baseItem, filePath: "assets/photo.png", url: undefined }],
        viewport: { x: 1, y: 2, zoom: 3 },
        settings: {
          screenshotDirectory: "/shots",
          canvasBackgroundPattern: "grid",
        },
        devMode: true,
      }),
    );

    const result = await loadFromStorage();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.filePath).toBe("/Users/test/project/canvas.json");
    expect(result.data.items[0].filePath).toBe(
      "/Users/test/project/assets/photo.png",
    );
    expect(result.data.items[0].url).toBe("");
    expect(result.data.viewport).toEqual({ x: 1, y: 2, zoom: 3 });
    expect(result.data.settings).toEqual({
      screenshotDirectory: "/shots",
      canvasBackgroundPattern: "grid",
    });
    expect(result.data.devMode).toBe(true);
  });

  it("keeps legacy absolute media file paths loadable", async () => {
    vi.mocked(open).mockResolvedValue("/Users/test/project/canvas.json");
    vi.mocked(readTextFile).mockResolvedValue(
      JSON.stringify({
        items: [baseItem],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
    );

    const result = await loadFromStorage();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.filePath).toBe("/Users/test/project/canvas.json");
    expect(result.data.items[0].filePath).toBe(baseItem.filePath);
  });

  it.each([
    "{",
    "null",
    JSON.stringify({ items: {} }),
    JSON.stringify({ items: [{ ...baseItem, filePath: 5 }] }),
    JSON.stringify({ items: [{ ...baseItem, width: 0 }] }),
    JSON.stringify({ items: [baseItem], viewport: { x: 0, y: 0, zoom: 0 } }),
    JSON.stringify({ items: [], settings: { screenshotDirectory: 5 } }),
  ])(
    "rejects malformed canvas data without returning a session: %s",
    async (contents) => {
      vi.mocked(open).mockResolvedValue("/Users/test/project/canvas.json");
      vi.mocked(readTextFile).mockResolvedValue(contents);
      await expect(loadFromStorage()).resolves.toEqual({
        ok: false,
        reason: "invalid",
      });
    },
  );

  it("accepts older configs without optional viewport or settings", async () => {
    vi.mocked(open).mockResolvedValue("/Users/test/project/canvas.json");
    vi.mocked(readTextFile).mockResolvedValue(
      JSON.stringify({ items: [baseItem] }),
    );
    expect((await loadFromStorage()).ok).toBe(true);
  });
});
