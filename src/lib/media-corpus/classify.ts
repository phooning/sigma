import type { CorpusAsset, CorpusCoverage } from "./types.ts";

const MB = 1024 * 1024;

const frameRateBucket = (fps: number) => {
  if (fps < 20) return "fps:low";
  if (fps < 24.5) return "fps:24";
  if (fps < 27) return "fps:25";
  if (fps < 45) return "fps:30";
  return "fps:60";
};

/** Path characteristics known to break naive path handling or shells. */
export const pathHazards = (relativePath: string) => {
  const hazards: string[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ASCII range check.
  if (/[^\x00-\x7f]/.test(relativePath)) hazards.push("non-ascii-path");
  if (/[\s()[\]'"&;$`!]/.test(relativePath))
    hazards.push("shell-metachar-path");
  if (relativePath.normalize("NFD") !== relativePath.normalize("NFC")) {
    hazards.push("unicode-normalization-sensitive-path");
  }
  return hazards;
};

/** Deterministic logical groups for one asset. Order is stable (sorted). */
export const classifyAsset = (asset: Omit<CorpusAsset, "groups">) => {
  const groups = new Set<string>();
  groups.add(`status:${asset.status}`);
  groups.add(`container:${asset.extension || "none"}`);

  if (asset.sizeBytes < 20 * MB) groups.add("size:small");
  else if (asset.sizeBytes < 60 * MB) groups.add("size:medium");
  else groups.add("size:large");

  if (asset.durationSec !== null) {
    if (asset.durationSec < 10) groups.add("duration:short");
    else if (asset.durationSec < 30) groups.add("duration:medium");
    else groups.add("duration:long");
  }

  if (asset.bitRate !== null) {
    const mbps = asset.bitRate / 1_000_000;
    if (mbps < 8) groups.add("bitrate:low");
    else if (mbps < 25) groups.add("bitrate:medium");
    else groups.add("bitrate:high");
  }

  const video = asset.video;
  if (video) {
    groups.add(`codec:${video.codec}`);
    if (video.profile)
      groups.add(`profile:${video.codec}-${video.profile.toLowerCase()}`);
    const longEdge = Math.max(video.displayWidth, video.displayHeight);
    if (longEdge <= 720) groups.add("res:sd");
    else if (longEdge <= 1280) groups.add("res:hd");
    else if (longEdge <= 1920) groups.add("res:fhd");
    else groups.add("res:uhd");
    groups.add(
      video.displayWidth === video.displayHeight
        ? "orientation:square"
        : video.displayWidth > video.displayHeight
          ? "orientation:landscape"
          : "orientation:portrait",
    );
    if (video.frameRate !== null) groups.add(frameRateBucket(video.frameRate));
    if (video.bitDepth !== null) groups.add(`bitdepth:${video.bitDepth}`);
    groups.add(
      video.hdr === "none" ? "dynamic-range:sdr" : `dynamic-range:${video.hdr}`,
    );
    if (video.rotation !== 0) groups.add("pathological:rotation-metadata");
    if (video.variableFrameRate) groups.add("pathological:variable-frame-rate");
    if (video.pixelFormat?.startsWith("yuvj")) {
      groups.add("pathological:full-range-pixfmt");
    }
  } else {
    groups.add("pathological:no-video-stream");
  }

  groups.add(asset.audio.length > 0 ? "av:video+audio" : "av:video-only");
  for (const audio of asset.audio) groups.add(`audio-codec:${audio.codec}`);
  if (asset.other.length > 0) groups.add("pathological:auxiliary-stream");
  for (const hazard of pathHazards(asset.relativePath)) {
    groups.add(`pathological:${hazard}`);
  }
  if (asset.durationSec !== null && asset.durationSec < 1) {
    groups.add("pathological:sub-second");
  }

  return [...groups].sort();
};

/** Dimensions we expect a desktop media corpus to eventually cover. */
const EXPECTED_DIMENSIONS: Record<string, string[]> = {
  codec: ["h264", "hevc", "vp9", "av1", "prores"],
  container: ["mp4", "mov", "webm", "mkv"],
  bitdepth: ["8", "10"],
  "dynamic-range": ["sdr", "hlg", "pq"],
  res: ["sd", "hd", "fhd", "uhd"],
  orientation: ["landscape", "portrait"],
  av: ["video-only", "video+audio"],
};

export const computeCoverage = (
  assets: readonly CorpusAsset[],
): CorpusCoverage => {
  const dimensions: Record<string, Set<string>> = {};
  for (const asset of assets) {
    for (const group of asset.groups) {
      const separator = group.indexOf(":");
      const dimension = group.slice(0, separator);
      const value = group.slice(separator + 1);
      dimensions[dimension] ??= new Set();
      dimensions[dimension].add(value);
    }
  }
  const gaps: string[] = [];
  for (const [dimension, expected] of Object.entries(EXPECTED_DIMENSIONS)) {
    for (const value of expected) {
      if (!dimensions[dimension]?.has(value))
        gaps.push(`${dimension}:${value}`);
    }
  }
  const pathological = dimensions.pathological ?? new Set<string>();
  for (const value of [
    "rotation-metadata",
    "variable-frame-rate",
    "sub-second",
    "no-video-stream",
  ]) {
    if (!pathological.has(value)) gaps.push(`pathological:${value}`);
  }
  if (!assets.some((asset) => asset.status !== "ok")) {
    gaps.push(
      "real-world corrupt or truncated asset (only synthetic failure fixtures)",
    );
  }
  if (!assets.some((asset) => asset.audio.length > 1)) {
    gaps.push("multiple audio streams");
  }
  return {
    dimensions: Object.fromEntries(
      Object.entries(dimensions)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, values]) => [key, [...values].sort()]),
    ),
    gaps: gaps.sort(),
  };
};

/**
 * Greedy set cover over groups, deterministic and cheap: at each step pick the
 * asset that covers the most uncovered groups, breaking ties by smaller size
 * and then by id. Status groups are ignored so a broken asset is not chosen
 * merely to "cover" its failure.
 */
export const selectRepresentativeSubset = (
  assets: readonly CorpusAsset[],
  maxAssets = 4,
) => {
  const candidates = assets.filter((asset) => asset.status === "ok");
  const uncovered = new Set(
    candidates.flatMap((asset) =>
      asset.groups.filter((group) => !group.startsWith("status:")),
    ),
  );
  const chosen: CorpusAsset[] = [];
  while (chosen.length < maxAssets && uncovered.size > 0) {
    let best: CorpusAsset | undefined;
    let bestGain = 0;
    for (const asset of candidates) {
      if (chosen.includes(asset)) continue;
      const gain = asset.groups.filter((group) => uncovered.has(group)).length;
      if (
        gain > bestGain ||
        (gain === bestGain &&
          best !== undefined &&
          (asset.sizeBytes < best.sizeBytes ||
            (asset.sizeBytes === best.sizeBytes && asset.id < best.id)))
      ) {
        best = asset;
        bestGain = gain;
      }
    }
    if (!best || bestGain === 0) break;
    chosen.push(best);
    for (const group of best.groups) uncovered.delete(group);
  }
  return chosen.map((asset) => asset.id).sort();
};

/**
 * Variable-frame-rate evidence from a window of packet presentation times (in
 * decode order). Returns null when the sample is too small to decide.
 */
export const detectVariableFrameRateFromPts = (
  ptsInDecodeOrder: readonly number[],
  { reorderTail = 16, tolerance = 0.05 } = {},
) => {
  const sorted = ptsInDecodeOrder.filter(Number.isFinite).sort((a, b) => a - b);
  // A sampled window ends mid-GOP: B-frames whose presentation time falls
  // inside the window may sit beyond it in decode order, leaving holes at the
  // tail. Drop the reorder tail so those holes are not mistaken for VFR.
  const pts = sorted.slice(0, Math.max(0, sorted.length - reorderTail));
  if (pts.length < 10) return null;
  const deltas = pts
    .slice(1)
    .map((value, index) => value - (pts[index] as number));
  const ordered = [...deltas].sort((a, b) => a - b);
  const median = ordered[Math.floor(ordered.length / 2)] as number;
  if (!(median > 0)) return null;
  // Ignore timestamp rounding: VFR only when frames deviate beyond tolerance.
  return deltas.some((delta) => Math.abs(delta - median) / median > tolerance);
};

/** Byte-wise code point ordering of NFC paths; independent of locale and FS order. */
export const compareCorpusPaths = (a: string, b: string) => {
  const left = a.normalize("NFC");
  const right = b.normalize("NFC");
  return left < right ? -1 : left > right ? 1 : 0;
};
