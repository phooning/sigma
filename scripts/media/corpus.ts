// Node-side corpus helpers: filesystem walk, streaming hashes, ffprobe and
// environment fingerprinting. Pure classification lives in src/lib/media-corpus.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareCorpusPaths,
  detectVariableFrameRateFromPts,
} from "../../src/lib/media-corpus/classify.ts";
import type {
  CorpusAsset,
  CorpusAudioStream,
  CorpusDecodeChecks,
  CorpusManifest,
  CorpusOtherStream,
  CorpusVideoStream,
  DecodeCheck,
  HdrKind,
} from "../../src/lib/media-corpus/types.ts";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const CORPUS_ROOT_RELATIVE = "fixtures/clips";
export const CORPUS_ROOT = join(ROOT, CORPUS_ROOT_RELATIVE);
export const MANIFEST_PATH = join(ROOT, "fixtures/media-corpus.manifest.json");
export const BASELINE_PATH = join(ROOT, "benchmarks/media-baseline.json");
export const ARTIFACTS_ROOT = join(ROOT, "artifacts/benchmarks");

const IGNORED_NAMES = new Set([".DS_Store", "Thumbs.db", ".gitkeep"]);

export type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/** Spawn without a shell (paths contain spaces, parentheses and non-ASCII). */
export const run = (
  command: string,
  args: readonly string[],
  {
    timeoutMs = 120_000,
    env,
    cwd = ROOT,
  }: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
) =>
  new Promise<RunResult>((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        code: null,
        stdout,
        stderr: stderr + String(error),
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });

export const toolVersion = (command: string, args: string[] = ["-version"]) => {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split("\n")[0]?.trim() ?? null;
  } catch {
    return null;
  }
};

/** Short tool version (e.g. "9.0.2") so fingerprints are not overly specific. */
export const ffmpegVersion = (command = "ffmpeg") => {
  const line = toolVersion(command);
  return line?.match(/version\s+(\S+)/)?.[1] ?? null;
};

/** Recursively list regular files under `root`, sorted by NFC code points. */
export const listCorpusFiles = async (root = CORPUS_ROOT) => {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name) || entry.name.startsWith("._"))
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
    }
  };
  await walk(root);
  return files
    .map((path) => ({
      absolutePath: path,
      relativePath: relative(root, path).split(sep).join("/").normalize("NFC"),
    }))
    .sort((a, b) => compareCorpusPaths(a.relativePath, b.relativePath));
};

/** Streaming SHA-256; never loads a whole clip into memory. */
export const sha256File = (path: string) =>
  new Promise<string>((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });

export const contentHashOf = (
  assets: readonly Pick<
    CorpusAsset,
    "id" | "relativePath" | "sizeBytes" | "sha256"
  >[],
) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        assets.map(({ id, relativePath, sizeBytes, sha256 }) => [
          id,
          relativePath,
          sizeBytes,
          sha256,
        ]),
      ),
    )
    .digest("hex");

export const readManifest = (path = MANIFEST_PATH): CorpusManifest | null => {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as CorpusManifest;
};

const parseRational = (value: unknown) => {
  if (typeof value !== "string" || value === "0/0") return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator)) return null;
  if (denominator === undefined) return numerator as number;
  if (!Number.isFinite(denominator) || denominator === 0) return null;
  return (numerator as number) / denominator;
};

const numberOrNull = (value: unknown) => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
};

const roundTo = (value: number | null, digits = 6) =>
  value === null ? null : Number(value.toFixed(digits));

type ProbeStream = Record<string, unknown> & {
  index?: number;
  codec_type?: string;
  side_data_list?: Array<Record<string, unknown>>;
  tags?: Record<string, string>;
};

const rotationOf = (stream: ProbeStream) => {
  for (const sideData of stream.side_data_list ?? []) {
    const rotation = numberOrNull(sideData.rotation);
    if (rotation !== null) return ((Math.round(rotation) % 360) + 360) % 360;
  }
  const tag = numberOrNull(stream.tags?.rotate);
  return tag === null ? 0 : ((Math.round(tag) % 360) + 360) % 360;
};

const hdrOf = (transfer: string | null): HdrKind =>
  transfer === "arib-std-b67"
    ? "hlg"
    : transfer === "smpte2084"
      ? "pq"
      : "none";

const bitDepthOf = (stream: ProbeStream) => {
  const raw = numberOrNull(stream.bits_per_raw_sample);
  if (raw !== null) return raw;
  const pixFmt = typeof stream.pix_fmt === "string" ? stream.pix_fmt : "";
  const match = pixFmt.match(/p(\d{2})(le|be)?$/);
  return match ? Number(match[1]) : pixFmt ? 8 : null;
};

/** Sample packet timestamps to detect variable frame rate. */
const detectVariableFrameRate = async (ffprobe: string, path: string) => {
  const result = await run(ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-read_intervals",
    "%+#240",
    "-show_entries",
    "packet=pts_time",
    "-of",
    "json",
    path,
  ]);
  if (result.code !== 0) return null;
  try {
    const packets = (JSON.parse(result.stdout).packets ?? []) as Array<{
      pts_time?: string;
    }>;
    return detectVariableFrameRateFromPts(
      packets.map((packet) => Number(packet.pts_time)),
    );
  } catch {
    return null;
  }
};

const decodeFrameAt = async (
  ffmpeg: string,
  path: string,
  seconds: number,
): Promise<{ check: DecodeCheck; error?: string }> => {
  const result = await run(
    ffmpeg,
    [
      "-v",
      "error",
      "-ss",
      seconds.toFixed(3),
      "-i",
      path,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 60_000 },
  );
  if (result.code === 0 && !result.stderr.trim()) return { check: "ok" };
  return {
    check: "failed",
    error: `seek ${seconds.toFixed(2)}s: ${result.timedOut ? "timeout" : (result.stderr.trim().split("\n").pop() ?? `exit ${result.code}`)}`,
  };
};

export type ProbedAsset = Omit<CorpusAsset, "groups" | "id">;

export const probeAsset = async (
  absolutePath: string,
  relativePath: string,
  {
    ffprobe = "ffprobe",
    ffmpeg = "ffmpeg",
    decodeChecks = true,
    sha256,
  }: {
    ffprobe?: string | null;
    ffmpeg?: string | null;
    decodeChecks?: boolean;
    sha256: string;
  },
): Promise<ProbedAsset> => {
  const extension = relativePath.includes(".")
    ? (relativePath.split(".").pop() ?? "").toLowerCase()
    : "";
  const sizeBytes = (await stat(absolutePath)).size;
  const base: ProbedAsset = {
    relativePath,
    sizeBytes,
    sha256,
    extension,
    container: null,
    durationSec: null,
    bitRate: null,
    streamCount: 0,
    video: null,
    audio: [],
    other: [],
    decode: {
      firstFrame: "not-run",
      seekMiddle: "not-run",
      seekNearEnd: "not-run",
      errors: [],
    },
    status: "ok",
    issues: [],
  };
  if (!ffprobe) {
    return { ...base, status: "probe-failed", issues: ["ffprobe unavailable"] };
  }
  const probe = await run(ffprobe, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    absolutePath,
  ]);
  if (probe.code !== 0) {
    return {
      ...base,
      status: "probe-failed",
      issues: [
        `ffprobe exit ${probe.code}: ${probe.stderr.trim().split("\n").pop() ?? ""}`,
      ],
    };
  }
  const json = JSON.parse(probe.stdout) as {
    format?: Record<string, unknown>;
    streams?: ProbeStream[];
  };
  const streams = json.streams ?? [];
  const format = json.format ?? {};
  const issues: string[] = [];
  let video: CorpusVideoStream | null = null;
  const audio: CorpusAudioStream[] = [];
  const other: CorpusOtherStream[] = [];
  for (const stream of streams) {
    const index = typeof stream.index === "number" ? stream.index : -1;
    const codec =
      typeof stream.codec_name === "string" ? stream.codec_name : null;
    if (
      stream.codec_type === "video" &&
      video === null &&
      (stream.disposition as Record<string, number> | undefined)
        ?.attached_pic !== 1
    ) {
      const width = numberOrNull(stream.width) ?? 0;
      const height = numberOrNull(stream.height) ?? 0;
      const rotation = rotationOf(stream);
      const swap = rotation === 90 || rotation === 270;
      const colorTransfer =
        typeof stream.color_transfer === "string"
          ? stream.color_transfer
          : null;
      const avgFrameRate =
        typeof stream.avg_frame_rate === "string"
          ? stream.avg_frame_rate
          : null;
      const rFrameRate =
        typeof stream.r_frame_rate === "string" ? stream.r_frame_rate : null;
      video = {
        index,
        codec: codec ?? "unknown",
        profile: typeof stream.profile === "string" ? stream.profile : null,
        width,
        height,
        displayWidth: swap ? height : width,
        displayHeight: swap ? width : height,
        rotation,
        pixelFormat: typeof stream.pix_fmt === "string" ? stream.pix_fmt : null,
        bitDepth: bitDepthOf(stream),
        colorSpace:
          typeof stream.color_space === "string" ? stream.color_space : null,
        colorTransfer,
        colorPrimaries:
          typeof stream.color_primaries === "string"
            ? stream.color_primaries
            : null,
        hdr: hdrOf(colorTransfer),
        frameRate: roundTo(
          parseRational(avgFrameRate) ?? parseRational(rFrameRate),
          6,
        ),
        rFrameRate,
        avgFrameRate,
        variableFrameRate: await detectVariableFrameRate(ffprobe, absolutePath),
      };
      if (avgFrameRate && rFrameRate && avgFrameRate !== rFrameRate) {
        issues.push(
          `avg_frame_rate ${avgFrameRate} differs from r_frame_rate ${rFrameRate}`,
        );
      }
    } else if (stream.codec_type === "audio") {
      audio.push({
        index,
        codec: codec ?? "unknown",
        profile: typeof stream.profile === "string" ? stream.profile : null,
        channels: numberOrNull(stream.channels),
        sampleRate: numberOrNull(stream.sample_rate),
      });
    } else {
      other.push({
        index,
        codecType: String(stream.codec_type ?? "unknown"),
        codec,
      });
    }
  }
  const durationSec = roundTo(numberOrNull(format.duration), 6);
  const result: ProbedAsset = {
    ...base,
    container:
      typeof format.format_name === "string" ? format.format_name : null,
    durationSec,
    bitRate: numberOrNull(format.bit_rate),
    streamCount: streams.length,
    video,
    audio,
    other,
    issues,
  };
  if (!video)
    return {
      ...result,
      status: "no-video-stream",
      issues: [...issues, "no decodable video stream"],
    };
  if (decodeChecks && ffmpeg) {
    const duration = durationSec ?? 0;
    const first = await decodeFrameAt(ffmpeg, absolutePath, 0);
    const middle = await decodeFrameAt(ffmpeg, absolutePath, duration / 2);
    const end = await decodeFrameAt(
      ffmpeg,
      absolutePath,
      Math.max(0, duration - 0.5),
    );
    const decode: CorpusDecodeChecks = {
      firstFrame: first.check,
      seekMiddle: middle.check,
      seekNearEnd: end.check,
      errors: [first.error, middle.error, end.error].filter(
        (error): error is string => !!error,
      ),
    };
    const failed = decode.errors.length > 0;
    return { ...result, decode, status: failed ? "decode-failed" : "ok" };
  }
  return result;
};

export const gitInfo = () => {
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim().length > 0;
    return { revision, dirty };
  } catch {
    return { revision: null, dirty: null };
  }
};

/**
 * Coarse environment fingerprint used to match baselines: same OS, arch, CPU
 * model, core count, memory class and major tool versions.
 */
export const environmentInfo = () => {
  const cpu = cpus()[0]?.model ?? "unknown-cpu";
  const memoryGiB = Math.round(totalmem() / 1024 ** 3);
  const ffmpeg = ffmpegVersion("ffmpeg");
  const ffprobe = ffmpegVersion("ffprobe");
  const rustc = toolVersion("rustc", ["--version"])?.split(" ")[1] ?? null;
  const fingerprint = [
    platform(),
    arch(),
    cpu.replace(/\s+/g, "-"),
    `${cpus().length}c`,
    `${memoryGiB}g`,
    `node${process.versions.node.split(".")[0]}`,
    `ffmpeg${ffmpeg?.split(".")[0] ?? "-none"}`,
  ].join("|");
  return {
    fingerprint,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    cpuModel: cpu,
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    node: process.version,
    tools: { ffmpeg, ffprobe, rustc },
  };
};
