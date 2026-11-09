import type { MediaItem, Viewport } from "../../utils/media.types.ts";

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Structural invariants every canvas state must satisfy. Returns a list of
 * human-readable violations (empty when the state is valid).
 */
export const checkCanvasInvariants = (
  items: readonly MediaItem[],
  viewport: Viewport,
  {
    minZoom = 0.05,
    maxZoom = 5,
    knownPaths,
  }: {
    minZoom?: number;
    maxZoom?: number;
    knownPaths?: ReadonlySet<string>;
  } = {},
) => {
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const label = `item[${index}] ${item.id}`;
    if (!item.id) failures.push(`${label}: empty id`);
    if (seen.has(item.id)) failures.push(`${label}: duplicate id`);
    seen.add(item.id);
    if (item.type !== "image" && item.type !== "video") {
      failures.push(`${label}: invalid type ${String(item.type)}`);
    }
    if (!item.filePath) failures.push(`${label}: empty filePath`);
    if (knownPaths && !knownPaths.has(item.filePath)) {
      failures.push(`${label}: filePath ${item.filePath} is not a known asset`);
    }
    for (const key of ["x", "y", "width", "height"] as const) {
      if (!isFiniteNumber(item[key]))
        failures.push(`${label}: ${key} not finite`);
    }
    if (!(item.width > 0) || !(item.height > 0)) {
      failures.push(`${label}: non-positive size ${item.width}x${item.height}`);
    }
    if (item.crop) {
      for (const [side, inset] of Object.entries(item.crop)) {
        if (!isFiniteNumber(inset) || inset < 0) {
          failures.push(`${label}: crop.${side} invalid (${inset})`);
        }
      }
    }
    for (const key of [
      "duration",
      "frameRate",
      "sourceWidth",
      "sourceHeight",
      "fileSize",
    ] as const) {
      const value = item[key];
      if (value !== undefined && (!isFiniteNumber(value) || value < 0)) {
        failures.push(`${label}: ${key} invalid (${String(value)})`);
      }
    }
  }
  if (!isFiniteNumber(viewport.x) || !isFiniteNumber(viewport.y)) {
    failures.push("viewport: origin not finite");
  }
  if (
    !isFiniteNumber(viewport.zoom) ||
    viewport.zoom < minZoom - 1e-9 ||
    viewport.zoom > maxZoom + 1e-9
  ) {
    failures.push(
      `viewport: zoom ${viewport.zoom} outside [${minZoom}, ${maxZoom}]`,
    );
  }
  return failures;
};

/** Fields that legitimately differ between sessions or machines. */
const VOLATILE_ITEM_KEYS = new Set([
  "url",
  "thumbnailUrl",
  "lowResProxyUrl",
  "imagePreview256Url",
  "imagePreview1024Url",
  "imageLod",
  "videoLod",
]);

const OPTIONAL_FLAG_KEYS = new Set(["deferVideoLoad"]);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
};

/**
 * Normalised projection of canvas items used for save/load equivalence: keeps
 * identity, geometry, media metadata and source path; drops runtime URLs.
 */
export const normalizeItemsForComparison = (items: readonly MediaItem[]) =>
  items.map((item) =>
    canonicalize(
      Object.fromEntries(
        Object.entries(item).filter(
          ([key, value]) =>
            !VOLATILE_ITEM_KEYS.has(key) &&
            // Optional flags: the app treats `false` and absent identically and
            // the serializer omits `false`; `true` must still round-trip.
            !(OPTIONAL_FLAG_KEYS.has(key) && value === false),
        ),
      ),
    ),
  );

/** Diff two normalised item lists; returns readable differences. */
export const diffNormalizedItems = (
  expected: readonly unknown[],
  actual: readonly unknown[],
) => {
  const failures: string[] = [];
  if (expected.length !== actual.length) {
    failures.push(`item count ${actual.length} != expected ${expected.length}`);
  }
  const count = Math.min(expected.length, actual.length);
  for (let index = 0; index < count; index += 1) {
    const left = JSON.stringify(expected[index]);
    const right = JSON.stringify(actual[index]);
    if (left !== right) failures.push(`item[${index}]: ${right} != ${left}`);
  }
  return failures;
};
