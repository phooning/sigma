import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const baselinePath = resolve(root, "benchmarks/vitest-bench-baseline.json");
const latestPath = resolve(root, "benchmarks/vitest-bench-current.json");
const allowedRegressionPercent = 15;
const maxAllowedRme = 10;

if (!existsSync(baselinePath)) {
  console.error(`Missing committed benchmark baseline: ${baselinePath}`);
  process.exit(1);
}

if (!existsSync(latestPath)) {
  console.error(`Missing benchmark run output: ${latestPath}`);
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const latest = JSON.parse(readFileSync(latestPath, "utf8"));

const flattenBenchmarks = (report) =>
  (report.files ?? []).flatMap((file) =>
    (file.groups ?? []).flatMap((group) =>
      (group.benchmarks ?? []).map((benchmark) => ({
        key: `${file.filepath ?? "unknown"}::${group.fullName ?? group.name ?? "group"}::${benchmark.name}`,
        mean: benchmark.mean ?? null,
        rme: benchmark.rme ?? null,
      })),
    ),
  );

const baselineBenchmarks = new Map(
  flattenBenchmarks(baseline).map((entry) => [entry.key, entry]),
);
const latestBenchmarks = flattenBenchmarks(latest);

const regressions = latestBenchmarks.flatMap((entry) => {
  if (typeof entry.mean !== "number") return [];
  if (typeof entry.rme === "number" && entry.rme > maxAllowedRme) return [];

  const baselineEntry = baselineBenchmarks.get(entry.key);
  if (!baselineEntry || typeof baselineEntry.mean !== "number") return [];
  if (
    typeof baselineEntry.rme === "number" &&
    baselineEntry.rme > maxAllowedRme
  )
    return [];
  if (baselineEntry.mean <= 0) return [];

  const regressionPercent =
    ((entry.mean - baselineEntry.mean) / baselineEntry.mean) * 100;
  if (regressionPercent <= allowedRegressionPercent) return [];

  return [
    {
      ...entry,
      baselineMean: baselineEntry.mean,
      regressionPercent,
    },
  ];
});

if (regressions.length === 0) {
  console.log(
    `Benchmark check passed. No stable benchmark regressed by more than ${allowedRegressionPercent}%.`,
  );
  process.exit(0);
}

console.error(
  `Benchmark regression check failed. Threshold: ${allowedRegressionPercent}% mean runtime increase.`,
);
regressions
  .sort((left, right) => right.regressionPercent - left.regressionPercent)
  .forEach((entry) => {
    console.error(
      `${entry.key} regressed by ${entry.regressionPercent.toFixed(1)}% (${entry.baselineMean.toFixed(6)} -> ${entry.mean.toFixed(6)} ms).`,
    );
  });

process.exit(1);
