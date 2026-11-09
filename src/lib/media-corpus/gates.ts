import type {
  BaselineFile,
  GateResult,
  GateStatus,
  MetricRecord,
} from "./types.ts";

export const MIN_PERF_SAMPLES = 5;

/**
 * Correctness gate. `failures === null` means the check never executed and is
 * reported as NOT_RUN (or UNSUPPORTED when a reason says so), never PASS.
 */
export const correctnessGate = ({
  id,
  invariant,
  tier,
  failures,
  checked,
  unsupportedReason,
  reproduce,
}: {
  id: string;
  invariant: string;
  tier: string;
  failures: readonly string[] | null;
  /** Number of items the invariant was evaluated over. */
  checked?: number;
  unsupportedReason?: string;
  reproduce?: string;
}): GateResult => {
  if (failures === null) {
    return {
      id,
      gateClass: "correctness",
      status: unsupportedReason ? "UNSUPPORTED" : "NOT_RUN",
      invariant,
      tier,
      detail: unsupportedReason ?? "check did not execute",
    };
  }
  if (checked === 0 && failures.length === 0) {
    // A gate that evaluated nothing is vacuous; refuse to call it a pass.
    return {
      id,
      gateClass: "correctness",
      status: "NOT_RUN",
      invariant,
      tier,
      detail: "zero items were checked",
    };
  }
  const status: GateStatus = failures.length === 0 ? "PASS" : "FAIL";
  const shown = failures.slice(0, 5).join("; ");
  return {
    id,
    gateClass: "correctness",
    status,
    invariant,
    tier,
    detail:
      failures.length === 0
        ? `${checked ?? "all"} checked`
        : `${failures.length} failure(s): ${shown}${failures.length > 5 ? "; …" : ""}`,
    ...(failures.length > 0 && reproduce ? { reproduce } : {}),
  };
};

export const thresholdFor = (baseline: BaselineFile, key: string) =>
  baseline.thresholds[key] ?? baseline.thresholds.default;

/**
 * Performance regression gate. Only enforces when a baseline exists for the
 * same environment fingerprint and the run has enough samples; otherwise it
 * reports UNCALIBRATED so an unknown machine never yields a misleading PASS.
 */
export const performanceGate = ({
  metric,
  baseline,
  environment,
  tier,
}: {
  metric: MetricRecord | undefined;
  baseline: BaselineFile | null;
  environment: string;
  tier: string;
}): Omit<GateResult, "id"> => {
  const base = { gateClass: "performance" as const, tier };
  if (!metric || metric.summary.n === 0 || metric.summary.p50 === null) {
    return {
      ...base,
      status: "NOT_RUN",
      invariant: "metric recorded",
      detail: "no samples recorded",
    };
  }
  const observed = metric.summary.p50;
  const noisy = metric.summary.noisy ? " (noisy)" : "";
  if (!baseline) {
    return {
      ...base,
      status: "UNCALIBRATED",
      invariant: "p50 within baseline threshold",
      detail: `p50 ${observed.toFixed(2)} ${metric.unit}; no baseline file${noisy}`,
    };
  }
  if (baseline.environment !== environment) {
    return {
      ...base,
      status: "UNCALIBRATED",
      invariant: "p50 within baseline threshold",
      detail: `p50 ${observed.toFixed(2)} ${metric.unit}; baseline recorded on a different environment${noisy}`,
    };
  }
  const entry = baseline.metrics[metric.key];
  const threshold = thresholdFor(baseline, metric.key);
  const invariant = `p50 ≤ baseline × ${(1 + threshold).toFixed(2)}`;
  if (!entry) {
    return {
      ...base,
      status: "UNCALIBRATED",
      invariant,
      detail: `p50 ${observed.toFixed(2)} ${metric.unit}; metric absent from baseline${noisy}`,
    };
  }
  if (metric.summary.n < MIN_PERF_SAMPLES) {
    return {
      ...base,
      status: "UNCALIBRATED",
      invariant,
      detail: `only ${metric.summary.n} samples (need ${MIN_PERF_SAMPLES})${noisy}`,
    };
  }
  const higherIsBetter = metric.higherIsBetter === true;
  const delta =
    entry.p50 === 0 ? 0 : (observed - entry.p50) / Math.abs(entry.p50);
  const regressed = higherIsBetter ? delta < -threshold : delta > threshold;
  return {
    ...base,
    status: regressed ? "FAIL" : "PASS",
    invariant: higherIsBetter
      ? `p50 ≥ baseline × ${(1 - threshold).toFixed(2)}`
      : invariant,
    detail: `p50 ${observed.toFixed(2)} vs baseline ${entry.p50.toFixed(2)} ${metric.unit} (${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%)${noisy}`,
  };
};

/** Overall exit decision: only correctness failures and calibrated perf failures block. */
export const blockingFailures = (gates: readonly GateResult[]) =>
  gates.filter((gate) => gate.status === "FAIL");

/** Validate runner-level completion before accepting individual browser results. */
export const browserRunFailure = (
  result: { code: number | null; timedOut: boolean },
  report: { suites?: unknown[]; errors?: unknown[] } | null,
): string | null => {
  if (result.timedOut) return "Playwright timed out";
  if (result.code !== 0) return `Playwright exited with code ${result.code}`;
  if (!report) return "Playwright produced no JSON report";
  if (report.errors?.length) return "Playwright reported runner errors";
  if (!report.suites?.length) return "Playwright reported no suites";
  return null;
};

/** A requested scenario must execute, even when Playwright exits successfully. */
export const browserScenarioFailures = (
  ok: boolean,
  results: readonly { status: string; error?: { message?: string } }[],
): string[] => {
  if (
    results.length === 0 ||
    results.some((result) => result.status === "skipped")
  )
    return ["browser scenario did not execute"];
  return ok
    ? []
    : results.map(
        (result) => result.error?.message?.split("\n")[0] ?? result.status,
      );
};

export const previewWorkloadFailure = (level: {
  count: number;
  mounted: number;
  advancing: number;
  totalFrames: number;
}): string | null => {
  if (
    level.mounted < level.count ||
    level.advancing < level.count ||
    level.totalFrames <= 0
  )
    return `requested ${level.count}, mounted ${level.mounted}, advancing ${level.advancing}, frames ${level.totalFrames}`;
  return null;
};

export const shutdownFailures = (shutdown: {
  exit: { code: number | null; signal: string | null };
  decodersAtClose: number[];
  thumbnailPidsAtClose?: number[];
  survivingDecoders: number[];
}): string[] => [
  ...(shutdown.exit.code === 0
    ? []
    : [`exit ${JSON.stringify(shutdown.exit)}`]),
  ...(shutdown.decodersAtClose.length
    ? []
    : ["no decoder was active at close (scenario vacuous)"]),
  ...(shutdown.thumbnailPidsAtClose?.length
    ? []
    : ["no cold thumbnail decode was active at close"]),
  ...shutdown.survivingDecoders.map(
    (pid) => `decoder ${pid} survived shutdown`,
  ),
];
