import { beforeEach, describe, expect, it, vi } from "vitest";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  getProjectRootForConfig,
  loadFromStorage,
  resolveProjectPath,
  saveToStorage,
  toProjectRelativePath,
} from "./fs";
import { MediaItem } from "./media.types";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
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

  it("saves media file paths relative to the config folder", async () => {
    vi.mocked(save).mockResolvedValue("/Users/test/project/canvas.json");

    const result = await saveToStorage([baseItem], { x: 1, y: 2, zoom: 3 });

    expect(result).toEqual({ ok: true });
    expect(writeTextFile).toHaveBeenCalledOnce();

    const [filePath, contents] = vi.mocked(writeTextFile).mock.calls[0];
    const config = JSON.parse(contents);

    expect(filePath).toBe("/Users/test/project/canvas.json");
    expect(config.items[0].filePath).toBe("assets/photo.png");
    expect(config.items[0].url).toBeUndefined();
    expect(config.viewport).toEqual({ x: 1, y: 2, zoom: 3 });
  });

  it("loads project-relative media file paths from the selected config folder", async () => {
    vi.mocked(open).mockResolvedValue("/Users/test/project/canvas.json");
    vi.mocked(readTextFile).mockResolvedValue(
      JSON.stringify({
        items: [{ ...baseItem, filePath: "assets/photo.png", url: undefined }],
        viewport: { x: 1, y: 2, zoom: 3 },
      }),
    );

    const result = await loadFromStorage();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.items[0].filePath).toBe(
      "/Users/test/project/assets/photo.png",
    );
    expect(result.data.items[0].url).toBe("");
    expect(result.data.viewport).toEqual({ x: 1, y: 2, zoom: 3 });
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

    expect(result.data.items[0].filePath).toBe(baseItem.filePath);
  });
});
