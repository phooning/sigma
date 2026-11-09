import type {
  GateResult,
  GateStatus,
  MetricRecord,
  RESULTS_SCHEMA,
} from "./types.ts";

export type StepStatus = "passed" | "failed" | "skipped";

export interface StepRecord {
  name: string;
  status: StepStatus;
  durationMs: number;
  command?: string;
  exitCode?: number | null;
  note?: string;
}

/** Per-asset outcome across every surface that touched it. */
export interface AssetOutcome {
  id: string;
  relativePath: string;
  /** e.g. { "rust-probe": "ok", "browser-playback": "unsupported: …" } */
  outcomes: Record<string, string>;
}

export interface RunEnvironment {
  fingerprint: string;
  platform: string;
  arch: string;
  osRelease: string;
  cpuModel: string;
  cpuCount: number;
  memoryBytes: number;
  node: string;
  tools: Record<string, string | null>;
}

export interface RunResults {
  schema: typeof RESULTS_SCHEMA;
  suiteVersion: string;
  runId: string;
  tier: string;
  startedAt: string;
  finishedAt: string;
  git: { revision: string | null; dirty: boolean | null };
  environment: RunEnvironment;
  corpus: {
    manifestHash: string | null;
    present: boolean;
    assetCount: number;
    totalBytes: number;
    verification: "sha256" | "size" | "absent";
    exercisedAssetIds: string[];
  };
  workload: Record<string, unknown>;
  steps: StepRecord[];
  gates: GateResult[];
  metrics: MetricRecord[];
  assets: AssetOutcome[];
  limitations: string[];
}

const STATUS_ORDER: GateStatus[] = [
  "FAIL",
  "UNCALIBRATED",
  "UNSUPPORTED",
  "NOT_RUN",
  "PASS",
];

const formatNumber = (value: number | null, digits = 2) =>
  value === null
    ? "—"
    : Number.isInteger(value)
      ? String(value)
      : value.toFixed(digits);

const escapeCell = (value: string) =>
  value.replace(/\|/g, "\\|").replace(/\n/g, " ");

export const countByStatus = (gates: readonly GateResult[]) => {
  const counts = Object.fromEntries(
    STATUS_ORDER.map((status) => [status, 0]),
  ) as Record<GateStatus, number>;
  for (const gate of gates) counts[gate.status] += 1;
  return counts;
};

export const renderMarkdown = (results: RunResults) => {
  const counts = countByStatus(results.gates);
  const lines: string[] = [];
  lines.push(`# Sigma media suite — ${results.tier}`);
  lines.push("");
  lines.push(`- Run: \`${results.runId}\``);
  lines.push(
    `- Git: \`${results.git.revision ?? "unknown"}\`${results.git.dirty ? " (dirty)" : ""}`,
  );
  lines.push(
    `- Environment: \`${results.environment.fingerprint}\` (${results.environment.cpuModel}, ${results.environment.cpuCount} CPUs, ${(results.environment.memoryBytes / 1024 ** 3).toFixed(0)} GiB, Node ${results.environment.node})`,
  );
  lines.push(
    `- Tools: ${Object.entries(results.environment.tools)
      .map(([tool, version]) => `${tool} ${version ?? "absent"}`)
      .join(", ")}`,
  );
  lines.push(
    `- Corpus: ${results.corpus.present ? `${results.corpus.assetCount} assets, ${(results.corpus.totalBytes / 1024 ** 2).toFixed(1)} MiB, verified by ${results.corpus.verification}` : "absent"}; manifest \`${results.corpus.manifestHash?.slice(0, 16) ?? "none"}\`; exercised ${results.corpus.exercisedAssetIds.length}`,
  );
  lines.push(`- Workload: \`${JSON.stringify(results.workload)}\``);
  lines.push(
    `- Gates: ${STATUS_ORDER.map((status) => `${status} ${counts[status]}`).join(" · ")}`,
  );
  lines.push("");
  lines.push("## Gates");
  lines.push("");
  lines.push("| Gate | Class | Tier | Status | Invariant / budget | Detail |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  const sorted = [...results.gates].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      (a.id < b.id ? -1 : 1),
  );
  for (const gate of sorted) {
    lines.push(
      `| ${gate.id} | ${gate.gateClass} | ${gate.tier} | **${gate.status}** | ${escapeCell(gate.invariant)} | ${escapeCell(gate.detail)}${gate.reproduce ? ` — repro: \`${escapeCell(gate.reproduce)}\`` : ""} |`,
    );
  }
  if (results.metrics.length > 0) {
    lines.push("");
    lines.push("## Metrics");
    lines.push("");
    lines.push(
      "| Metric | Surface | Cache | Unit | n | min | p50 | p95 | p99 | max | cv |",
    );
    lines.push(
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const metric of results.metrics) {
      const s = metric.summary;
      lines.push(
        `| ${metric.key}${s.noisy ? " ⚠︎noisy" : ""} | ${metric.surface} | ${metric.cache} | ${metric.unit} | ${s.n} | ${formatNumber(s.min)} | ${formatNumber(s.p50)} | ${formatNumber(s.p95)} | ${formatNumber(s.p99)} | ${formatNumber(s.max)} | ${formatNumber(s.cv)} |`,
      );
    }
  }
  if (results.assets.length > 0) {
    const surfaces = [
      ...new Set(
        results.assets.flatMap((asset) => Object.keys(asset.outcomes)),
      ),
    ].sort();
    lines.push("");
    lines.push("## Per-asset outcomes");
    lines.push("");
    lines.push(`| Asset | ${surfaces.join(" | ")} |`);
    lines.push(`| --- | ${surfaces.map(() => "---").join(" | ")} |`);
    for (const asset of results.assets) {
      lines.push(
        `| ${escapeCell(asset.relativePath)} | ${surfaces
          .map((surface) => escapeCell(asset.outcomes[surface] ?? "NOT_RUN"))
          .join(" | ")} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Steps");
  lines.push("");
  for (const step of results.steps) {
    lines.push(
      `- ${step.status.toUpperCase()} ${step.name} (${(step.durationMs / 1000).toFixed(1)} s)${step.note ? ` — ${step.note}` : ""}`,
    );
  }
  if (results.limitations.length > 0) {
    lines.push("");
    lines.push("## Limitations and unverified claims");
    lines.push("");
    for (const limitation of results.limitations) lines.push(`- ${limitation}`);
  }
  lines.push("");
  return lines.join("\n");
};

const csvCell = (value: string | number | null) => {
  if (value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const renderMetricsCsv = (results: RunResults) => {
  const header = [
    "run_id",
    "git_revision",
    "environment",
    "tier",
    "metric",
    "surface",
    "cache",
    "workload",
    "unit",
    "n",
    "min",
    "p50",
    "p95",
    "p99",
    "max",
    "mean",
    "cv",
    "noisy",
  ];
  const rows = results.metrics.map((metric) =>
    [
      results.runId,
      results.git.revision,
      results.environment.fingerprint,
      results.tier,
      metric.key,
      metric.surface,
      metric.cache,
      metric.workload,
      metric.unit,
      metric.summary.n,
      metric.summary.min,
      metric.summary.p50,
      metric.summary.p95,
      metric.summary.p99,
      metric.summary.max,
      metric.summary.mean,
      metric.summary.cv,
      metric.summary.noisy ? 1 : 0,
    ]
      .map(csvCell)
      .join(","),
  );
  return `${[header.join(","), ...rows].join("\n")}\n`;
};
