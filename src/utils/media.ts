import { CropHandle, CropInsets, MediaItem } from "./media.types";

export const VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "mkv"];
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

export const getCrop = (item: MediaItem): CropInsets => item.crop ?? EMPTY_CROP;

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export const CROP_HANDLES: CropHandle[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];
export const MIN_MEDIA_SIZE = 100;
export const EMPTY_CROP: CropInsets = { top: 0, right: 0, bottom: 0, left: 0 };
