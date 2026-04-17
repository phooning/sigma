import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { MediaItem, Viewport } from "./media.types";

type TErrorReason = "cancelled" | "invalid" | "error";

type TLoadResult =
  | { ok: true; data: { items: MediaItem[]; viewport: Viewport } }
  | { ok: false; reason: TErrorReason; error?: unknown };

type TSaveResult =
  | { ok: true }
  | { ok: false; reason: TErrorReason; error?: unknown };

export const saveToStorage = async (
  items: MediaItem[],
  viewport: Viewport,
): Promise<TSaveResult> => {
  try {
    const filePath = await save({
      title: "Save canvas",
      defaultPath: "canvas.json",
      filters: [
        {
          name: "Canvas Config",
          extensions: ["json"],
        },
      ],
    });

    if (!filePath) {
      return { ok: false, reason: "cancelled" };
    }

    const configData = JSON.stringify({ items, viewport });
    await writeTextFile(filePath, configData);

    return { ok: true };
  } catch (err) {
    console.error("Failed to save:", err);
    return { ok: false, reason: "error", error: err };
  }
};

export const loadFromStorage = async (): Promise<TLoadResult> => {
  try {
    const selected = await open({
      filters: [
        {
          name: "Canvas Config",
          extensions: ["json"],
        },
      ],
    });

    if (!selected || typeof selected !== "string") {
      return { ok: false, reason: "cancelled" };
    }

    const contents = await readTextFile(selected);
    const data = JSON.parse(contents);

    if (!data.items) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, data };
  } catch (err) {
    console.error("Failed to load:", err);
    return { ok: false, reason: "error", error: err };
  }
};
