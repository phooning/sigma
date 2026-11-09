// Shared, environment-neutral types for the media corpus harness. This module
// must stay free of Node and DOM APIs so it can be imported by Vitest suites,
// Playwright specs and Node 26 scripts (via native type stripping).

export const MANIFEST_SCHEMA = "sigma.media-corpus.v1" as const;
export const RESULTS_SCHEMA = "sigma.media-results.v1" as const;
export const BASELINE_SCHEMA = "sigma.media-baseline.v1" as const;
export const SUITE_VERSION = "1.0.0";

export type AssetStatus =
  | "ok"
  | "probe-failed"
  | "no-video-stream"
  | "decode-failed"
  | "missing"
  | "unreadable";

export type DecodeCheck = "ok" | "failed" | "not-run";

export type HdrKind = "none" | "hlg" | "pq";

export interface CorpusVideoStream {
  index: number;
  codec: string;
  profile: string | null;
  width: number;
  height: number;
  /** Width/height after applying rotation metadata. */
  displayWidth: number;
  displayHeight: number;
  rotation: number;
  pixelFormat: string | null;
  bitDepth: number | null;
  colorSpace: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  hdr: HdrKind;
  /** Average frame rate (frames per second), when reported. */
  frameRate: number | null;
  rFrameRate: string | null;
  avgFrameRate: string | null;
  /**
   * Variable-frame-rate evidence from sampled packet durations. `null` means
   * the sample could not be collected, not that the stream is constant.
   */
  variableFrameRate: boolean | null;
}

export interface CorpusAudioStream {
  index: number;
  codec: string;
  profile: string | null;
  channels: number | null;
  sampleRate: number | null;
}

export interface CorpusOtherStream {
  index: number;
  codecType: string;
  codec: string | null;
}

export interface CorpusDecodeChecks {
  firstFrame: DecodeCheck;
  seekMiddle: DecodeCheck;
  seekNearEnd: DecodeCheck;
  errors: string[];
}

export interface CorpusAsset {
  /** Stable identifier derived from the content hash. */
  id: string;
  /** NFC-normalised, forward-slash path relative to the corpus root. */
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  extension: string;
  container: string | null;
  durationSec: number | null;
  bitRate: number | null;
  streamCount: number;
  video: CorpusVideoStream | null;
  audio: CorpusAudioStream[];
  other: CorpusOtherStream[];
  decode: CorpusDecodeChecks;
  status: AssetStatus;
  issues: string[];
  groups: string[];
}

export interface CorpusCoverage {
  dimensions: Record<string, string[]>;
  gaps: string[];
}

export interface CorpusManifest {
  schema: typeof MANIFEST_SCHEMA;
  corpusRoot: string;
  tool: { ffprobe: string | null };
  /** sha256 over (id, relativePath, sizeBytes, sha256) of every asset. */
  contentHash: string;
  assetCount: number;
  totalBytes: number;
  assets: CorpusAsset[];
  coverage: CorpusCoverage;
  subsets: { smoke: string[] };
}

/** Outcome states. A missing measurement must never be reported as PASS. */
export type GateStatus =
  | "PASS"
  | "FAIL"
  | "UNCALIBRATED"
  | "UNSUPPORTED"
  | "NOT_RUN";

export type GateClass = "correctness" | "performance";

export interface GateResult {
  id: string;
  gateClass: GateClass;
  status: GateStatus;
  invariant: string;
  tier: string;
  detail: string;
  /** Seed / fixture needed to reproduce a failure, when applicable. */
  reproduce?: string;
}

export interface SampleSummary {
  n: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  stdev: number | null;
  /** Coefficient of variation (stdev / mean). */
  cv: number | null;
  noisy: boolean;
}

export type MetricUnit = "ms" | "bytes" | "count" | "ratio" | "fps" | "MB/s";

export interface MetricRecord {
  /** Stable metric key used for baseline comparison. */
  key: string;
  unit: MetricUnit;
  /** Execution environment the metric came from. */
  surface: "rust-ipc" | "jsdom" | "browser" | "native-desktop" | "ffmpeg";
  cache: "cold" | "warm" | "n/a";
  workload: string;
  summary: SampleSummary;
  /** Lower is better for every metric unless stated otherwise. */
  higherIsBetter?: boolean;
}

export interface BaselineEntry {
  key: string;
  unit: MetricUnit;
  p50: number;
  p95: number;
  n: number;
}

export interface BaselineFile {
  schema: typeof BASELINE_SCHEMA;
  /** Environment fingerprint the numbers were measured on. */
  environment: string;
  recordedAt: string;
  method: string;
  /** Fractional regression threshold per metric key, defaulting to `default`. */
  thresholds: { default: number } & Record<string, number>;
  metrics: Record<string, BaselineEntry>;
}
