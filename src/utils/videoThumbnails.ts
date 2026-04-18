import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { MediaItem } from "./media.types";

export type VideoLodAssets = Pick<MediaItem, "thumbnailPath" | "thumbnailUrl">;

export const generateVideoThumbnail = async (
  filePath: string,
): Promise<VideoLodAssets> => {
  try {
    const thumbnailPath = await invoke<string | null>(
      "generate_video_thumbnail",
      { path: filePath },
    );

    if (!thumbnailPath) return {};

    return {
      thumbnailPath,
      thumbnailUrl: convertFileSrc(thumbnailPath),
    };
  } catch (err) {
    console.warn("Failed to generate video thumbnail:", err);
    return {};
  }
};
