import type { SampleSummary } from "./types.ts";

/** Minimum samples before percentiles above p50 are considered meaningful. */
export const MIN_SAMPLES_FOR_P95 = 5;
export const MIN_SAMPLES_FOR_P99 = 20;
/** Coefficient of variation above which a sample set is flagged as noisy. */
export const NOISY_CV = 0.35;

/** Nearest-rank percentile on a pre-sorted array. */
export const percentileSorted = (sorted: readonly number[], p: number) => {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
};

export const summarize = (samples: readonly number[]): SampleSummary => {
  const values = samples.filter((value) => Number.isFinite(value));
  const n = values.length;
  if (n === 0) {
    return {
      n: 0,
      min: null,
      max: null,
      mean: null,
      p50: null,
      p95: null,
      p99: null,
      stdev: null,
      cv: null,
      noisy: false,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance =
    n > 1
      ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
      : 0;
  const stdev = Math.sqrt(variance);
  const cv = mean > 0 ? stdev / mean : null;
  return {
    n,
    min: sorted[0] ?? null,
    max: sorted[n - 1] ?? null,
    mean,
    p50: percentileSorted(sorted, 50),
    p95: n >= MIN_SAMPLES_FOR_P95 ? percentileSorted(sorted, 95) : null,
    p99: n >= MIN_SAMPLES_FOR_P99 ? percentileSorted(sorted, 99) : null,
    stdev: n > 1 ? stdev : null,
    cv: n > 1 ? cv : null,
    noisy: n > 1 && cv !== null && cv > NOISY_CV,
  };
};

/**
 * Least-squares slope of y over sample index. Used by soak tests to separate a
 * steady upward trend (leak evidence) from a one-off allocator step.
 */
export const linearSlope = (values: readonly number[]) => {
  const n = values.length;
  if (n < 2) return null;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - meanX) * (value - meanY);
    denominator += (index - meanX) ** 2;
  });
  return denominator === 0 ? 0 : numerator / denominator;
};

export type RetentionVerdict =
  | { kind: "insufficient"; detail: string }
  | { kind: "stable"; detail: string }
  | { kind: "plateau"; detail: string }
  | { kind: "growing"; detail: string };

/**
 * Classifies post-cleanup memory samples. The first `warmup` samples are
 * excluded because caches and allocator pools legitimately fill during them.
 * Growth is reported only when the trend persists across the second half too,
 * which distinguishes retention that keeps climbing from a cache that filled.
 */
export const classifyRetention = (
  samples: readonly number[],
  {
    warmup = 2,
    toleranceBytesPerCycle = 256 * 1024,
  }: { warmup?: number; toleranceBytesPerCycle?: number } = {},
): RetentionVerdict => {
  const steady = samples.slice(warmup);
  if (steady.length < 4) {
    return {
      kind: "insufficient",
      detail: `${steady.length} post-warmup samples (need >= 4)`,
    };
  }
  const slope = linearSlope(steady) ?? 0;
  const secondHalf = steady.slice(Math.floor(steady.length / 2));
  const lateSlope = linearSlope(secondHalf) ?? 0;
  const detail = `slope ${(slope / 1024).toFixed(1)} KiB/cycle, late slope ${(
    lateSlope / 1024
  ).toFixed(1)} KiB/cycle over ${steady.length} samples`;
  if (slope <= toleranceBytesPerCycle) return { kind: "stable", detail };
  if (lateSlope <= toleranceBytesPerCycle) return { kind: "plateau", detail };
  return { kind: "growing", detail };
};
