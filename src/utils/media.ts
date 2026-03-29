export const VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "mkv"];
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

export const hasExtension = (filePath: string, exts: string[]) => {
  const lower = filePath.toLowerCase();
  return exts.some((ext) => lower.endsWith(`.${ext}`));
};
