import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { SessionSettings } from "../stores/useSettingsStore";
import type { MediaItem, Viewport } from "./media.types";
import { notify } from "./notifications";

type TErrorReason = "cancelled" | "invalid" | "error";

type StoredMediaItem = Omit<MediaItem, "url"> & { url?: string };

type TLoadResult =
  | {
      ok: true;
      filePath: string;
      data: {
        items: MediaItem[];
        viewport?: Viewport;
        settings?: SessionSettings;
        devMode?: boolean;
      };
    }
  | { ok: false; reason: TErrorReason; error?: unknown };

type TSaveResult =
  | { ok: true; filePath: string }
  | { ok: false; reason: TErrorReason; error?: unknown };

type ParsedPath = {
  root: string;
  segments: string[];
};

const toForwardSlashes = (path: string) => path.replace(/\\/g, "/");

const getPreferredSeparator = (path: string) =>
  path.includes("\\") ? "\\" : "/";

const normalizeSegments = (segments: string[], isAbsolute: boolean) => {
  const normalized: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === ".") continue;

    if (segment === "..") {
      const previous = normalized[normalized.length - 1];
      if (previous && previous !== "..") {
        normalized.pop();
      } else if (!isAbsolute) {
        normalized.push(segment);
      }
      continue;
    }

    normalized.push(segment);
  }

  return normalized;
};

const parsePath = (path: string): ParsedPath => {
  const normalizedPath = toForwardSlashes(path);
  const driveMatch = normalizedPath.match(/^([a-zA-Z]:)(?:\/|$)/);

  if (driveMatch) {
    const root = `${driveMatch[1]}/`;
    const rest = normalizedPath.slice(root.length);
    return {
      root,
      segments: normalizeSegments(rest.split("/"), true),
    };
  }

  if (normalizedPath.startsWith("//")) {
    const parts = normalizedPath.slice(2).split("/");
    const rootParts = parts.slice(0, 2);
    const rest = parts.slice(2);

    if (rootParts.length === 2 && rootParts.every(Boolean)) {
      return {
        root: `//${rootParts.join("/")}`,
        segments: normalizeSegments(rest, true),
      };
    }
  }

  if (normalizedPath.startsWith("/")) {
    return {
      root: "/",
      segments: normalizeSegments(normalizedPath.slice(1).split("/"), true),
    };
  }

  return {
    root: "",
    segments: normalizeSegments(normalizedPath.split("/"), false),
  };
};

const formatPath = ({ root, segments }: ParsedPath, separator = "/") => {
  if (!root) return segments.join(separator) || ".";

  const formattedRoot = root.replace(/\//g, separator);
  if (segments.length === 0) return formattedRoot;

  return formattedRoot.endsWith(separator)
    ? `${formattedRoot}${segments.join(separator)}`
    : `${formattedRoot}${separator}${segments.join(separator)}`;
};

const isAbsolutePath = (path: string) => parsePath(path).root !== "";

const normalizePath = (path: string, separator = getPreferredSeparator(path)) =>
  formatPath(parsePath(path), separator);

const rootsMatch = (a: ParsedPath, b: ParsedPath) =>
  a.root.toLowerCase() === b.root.toLowerCase();

const isWindowsRoot = (path: ParsedPath) => /^[a-zA-Z]:\//.test(path.root);

const segmentsMatch = (a: string, b: string, ignoreCase: boolean) =>
  ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;

export const getProjectRootForConfig = (configPath: string) => {
  const separator = getPreferredSeparator(configPath);
  const parsed = parsePath(configPath);

  if (parsed.segments.length === 0) {
    return formatPath(parsed, separator);
  }

  return formatPath(
    {
      root: parsed.root,
      segments: parsed.segments.slice(0, -1),
    },
    separator,
  );
};

export const toProjectRelativePath = (
  projectRoot: string,
  filePath: string,
) => {
  if (!isAbsolutePath(filePath)) {
    return normalizePath(filePath, "/");
  }

  const root = parsePath(projectRoot);
  const target = parsePath(filePath);

  if (!rootsMatch(root, target)) {
    return normalizePath(filePath);
  }

  let commonSegments = 0;
  const ignoreSegmentCase = isWindowsRoot(root);
  while (
    commonSegments < root.segments.length &&
    commonSegments < target.segments.length &&
    segmentsMatch(
      root.segments[commonSegments],
      target.segments[commonSegments],
      ignoreSegmentCase,
    )
  ) {
    commonSegments += 1;
  }

  const parentSegments = root.segments.slice(commonSegments).map(() => "..");
  const childSegments = target.segments.slice(commonSegments);

  return [...parentSegments, ...childSegments].join("/") || ".";
};

export const resolveProjectPath = (projectRoot: string, filePath: string) => {
  if (isAbsolutePath(filePath)) {
    return normalizePath(filePath);
  }

  const separator = getPreferredSeparator(projectRoot);
  const root = parsePath(projectRoot);
  const relative = parsePath(filePath);

  return formatPath(
    {
      root: root.root,
      segments: normalizeSegments(
        [...root.segments, ...relative.segments],
        root.root !== "",
      ),
    },
    separator,
  );
};

const serializeItemForStorage = (
  item: MediaItem,
  projectRoot: string,
): StoredMediaItem => ({
  id: item.id,
  type: item.type,
  filePath: toProjectRelativePath(projectRoot, item.filePath),
  x: item.x,
  y: item.y,
  width: item.width,
  height: item.height,
  ...(typeof item.fileSize === "number" ? { fileSize: item.fileSize } : {}),
  ...(typeof item.duration === "number" ? { duration: item.duration } : {}),
  // Frame stepping depends on the probed rate; without it a reloaded canvas
  // steps every clip at the 30 fps fallback.
  ...(typeof item.frameRate === "number" ? { frameRate: item.frameRate } : {}),
  ...(typeof item.sourceWidth === "number"
    ? { sourceWidth: item.sourceWidth }
    : {}),
  ...(typeof item.sourceHeight === "number"
    ? { sourceHeight: item.sourceHeight }
    : {}),
  ...(item.deferVideoLoad ? { deferVideoLoad: item.deferVideoLoad } : {}),
  ...(item.thumbnailPath ? { thumbnailPath: item.thumbnailPath } : {}),
  ...(item.imagePreview256Path
    ? { imagePreview256Path: item.imagePreview256Path }
    : {}),
  ...(item.imagePreview1024Path
    ? { imagePreview1024Path: item.imagePreview1024Path }
    : {}),
  ...(item.crop ? { crop: item.crop } : {}),
});

const hydrateItemFromStorage = (
  item: StoredMediaItem,
  projectRoot: string,
): MediaItem => ({
  ...item,
  filePath: resolveProjectPath(projectRoot, item.filePath),
  url: "",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const validOptionalNumber = (
  item: Record<string, unknown>,
  key: string,
  minimum: number,
) =>
  item[key] === undefined ||
  (isFiniteNumber(item[key]) && item[key] >= minimum);

const validOptionalString = (item: Record<string, unknown>, key: string) =>
  item[key] === undefined || typeof item[key] === "string";

const validStoredItem = (item: unknown): item is StoredMediaItem => {
  if (!isRecord(item)) return false;
  if (
    typeof item.id !== "string" ||
    !item.id ||
    (item.type !== "image" && item.type !== "video") ||
    typeof item.filePath !== "string" ||
    !item.filePath ||
    !isFiniteNumber(item.x) ||
    !isFiniteNumber(item.y) ||
    !isFiniteNumber(item.width) ||
    item.width <= 0 ||
    !isFiniteNumber(item.height) ||
    item.height <= 0
  )
    return false;
  if (
    !validOptionalNumber(item, "fileSize", 0) ||
    !validOptionalNumber(item, "duration", 0) ||
    !validOptionalNumber(item, "frameRate", Number.EPSILON) ||
    !validOptionalNumber(item, "sourceWidth", Number.EPSILON) ||
    !validOptionalNumber(item, "sourceHeight", Number.EPSILON) ||
    !validOptionalString(item, "url") ||
    !validOptionalString(item, "thumbnailPath") ||
    !validOptionalString(item, "thumbnailUrl") ||
    !validOptionalString(item, "lowResProxyUrl") ||
    !validOptionalString(item, "imagePreview256Path") ||
    !validOptionalString(item, "imagePreview256Url") ||
    !validOptionalString(item, "imagePreview1024Path") ||
    !validOptionalString(item, "imagePreview1024Url") ||
    (item.imageLod !== undefined &&
      item.imageLod !== "full" &&
      item.imageLod !== "preview1024" &&
      item.imageLod !== "preview256") ||
    (item.videoLod !== undefined &&
      item.videoLod !== "video" &&
      item.videoLod !== "thumbnail" &&
      item.videoLod !== "proxy") ||
    (item.deferVideoLoad !== undefined &&
      typeof item.deferVideoLoad !== "boolean")
  )
    return false;
  if (item.crop !== undefined) {
    const crop = item.crop;
    if (!isRecord(crop)) return false;
    if (
      !isFiniteNumber(crop.top) ||
      crop.top < 0 ||
      !isFiniteNumber(crop.right) ||
      crop.right < 0 ||
      !isFiniteNumber(crop.bottom) ||
      crop.bottom < 0 ||
      !isFiniteNumber(crop.left) ||
      crop.left < 0
    )
      return false;
  }
  return true;
};

export const isStoredCanvasConfig = (
  value: unknown,
): value is {
  items: StoredMediaItem[];
  viewport?: Viewport;
  settings?: SessionSettings;
  devMode?: boolean;
} => {
  if (!isRecord(value) || !Array.isArray(value.items)) return false;
  // Older files have no version. A future version must not hydrate into this
  // schema and then be overwritten by a Save.
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1)
    return false;
  const ids = new Set<string>();
  for (const item of value.items) {
    if (!validStoredItem(item) || ids.has(item.id)) return false;
    ids.add(item.id);
  }

  if (value.viewport !== undefined) {
    const viewport = value.viewport;
    if (
      !isRecord(viewport) ||
      !isFiniteNumber(viewport.x) ||
      !isFiniteNumber(viewport.y) ||
      !isFiniteNumber(viewport.zoom) ||
      viewport.zoom <= 0
    )
      return false;
  }
  if (value.settings !== undefined) {
    const settings = value.settings;
    if (
      !isRecord(settings) ||
      typeof settings.screenshotDirectory !== "string" ||
      (settings.canvasBackgroundPattern !== "dots" &&
        settings.canvasBackgroundPattern !== "grid")
    )
      return false;
  }
  return value.devMode === undefined || typeof value.devMode === "boolean";
};

export const getCanvasConfigData = (
  items: MediaItem[],
  viewport: Viewport,
  filePath: string,
  sessionSettings?: SessionSettings,
  devMode?: boolean,
) => {
  const source = {
    items,
    viewport,
    ...(sessionSettings !== undefined ? { settings: sessionSettings } : {}),
    ...(devMode !== undefined ? { devMode } : {}),
  };
  if (!isStoredCanvasConfig(source))
    throw new Error("Canvas contains invalid values and was not saved");
  const projectRoot = getProjectRootForConfig(filePath);
  const stored = {
    schemaVersion: 1,
    items: items.map((item) => serializeItemForStorage(item, projectRoot)),
    viewport,
    ...(sessionSettings !== undefined ? { settings: sessionSettings } : {}),
    ...(devMode !== undefined ? { devMode } : {}),
  };
  // The source was validated above. Serialization only selects those fields,
  // turns a nonempty file path into another nonempty string, and adds schema v1.
  // The round-trip test guards this mapping without validating every item twice
  // on each save.
  return JSON.stringify(stored);
};

const writeCanvasConfig = async (
  items: MediaItem[],
  viewport: Viewport,
  filePath: string,
  sessionSettings?: SessionSettings,
  devMode?: boolean,
): Promise<TSaveResult> => {
  try {
    const configData = getCanvasConfigData(
      items,
      viewport,
      filePath,
      sessionSettings,
      devMode,
    );

    await invoke("save_canvas_atomic", {
      path: filePath,
      contents: configData,
    });

    return { ok: true, filePath };
  } catch (err) {
    console.error("Failed to save:", err);
    return { ok: false, reason: "error", error: err };
  }
};

export const saveToStorage = async (
  items: MediaItem[],
  viewport: Viewport,
  filePath: string,
  sessionSettings?: SessionSettings,
  devMode?: boolean,
): Promise<TSaveResult> => {
  return writeCanvasConfig(items, viewport, filePath, sessionSettings, devMode);
};

export const saveToStorageAs = async (
  items: MediaItem[],
  viewport: Viewport,
  defaultPath = "canvas.json",
  sessionSettings?: SessionSettings,
  devMode?: boolean,
): Promise<TSaveResult> => {
  try {
    const filePath = await selectCanvasSavePath(defaultPath);

    if (!filePath) {
      return { ok: false, reason: "cancelled" };
    }

    return writeCanvasConfig(
      items,
      viewport,
      filePath,
      sessionSettings,
      devMode,
    );
  } catch (err) {
    console.error("Failed to save:", err);
    return { ok: false, reason: "error", error: err };
  }
};

export const selectCanvasSavePath = async (defaultPath = "canvas.json") =>
  save({
    title: "Save canvas",
    defaultPath,
    filters: [
      {
        name: "Canvas Config",
        extensions: ["json"],
      },
    ],
  });

export const loadCanvasFromPath = async (
  selected: string,
): Promise<TLoadResult> => {
  try {
    const contents = await readTextFile(selected);
    let data: unknown;
    try {
      data = JSON.parse(contents);
    } catch {
      return { ok: false, reason: "invalid" };
    }

    if (!isStoredCanvasConfig(data)) {
      const version = isRecord(data) ? data.schemaVersion : undefined;
      return {
        ok: false,
        reason: "invalid",
        ...(typeof version === "number" && version > 1
          ? {
              error: `This canvas uses format version ${version}, which this version of Sigma cannot open. The file was not changed.`,
            }
          : {}),
      };
    }

    const projectRoot = getProjectRootForConfig(selected);
    return {
      ok: true,
      filePath: selected,
      data: {
        ...data,
        items: data.items.map((item: StoredMediaItem) =>
          hydrateItemFromStorage(item, projectRoot),
        ),
      },
    };
  } catch (err) {
    console.error("Failed to load:", err);
    return { ok: false, reason: "error", error: err };
  }
};

export const loadFromStorage = async (): Promise<TLoadResult> => {
  try {
    const selected = await open({
      filters: [{ name: "Canvas Config", extensions: ["json"] }],
    });
    if (!selected || typeof selected !== "string")
      return { ok: false, reason: "cancelled" };
    return loadCanvasFromPath(selected);
  } catch (error) {
    console.error("Failed to load:", error);
    return { ok: false, reason: "error", error };
  }
};

/**
 * Open the system file explorer and reveal the item source.
 */
export const revealItem = async ({
  e,
  id,
  items,
}: {
  e: React.MouseEvent;
  id: string;
  items: MediaItem[];
}) => {
  e.stopPropagation();
  const item = items.find((i) => i.id === id);
  if (!item) return;

  try {
    await revealItemInDir(item.filePath);
  } catch (error) {
    notify.error("Show in folder failed", {
      description: error,
    });
  }
};
