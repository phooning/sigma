import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const baselineJsonPath = resolve(root, "benchmarks/vitest-bench-baseline.json");
const baselineLogPath = resolve(root, "benchmarks/vitest-bench-baseline.verbose.txt");
const latestJsonPath = resolve(root, "benchmarks/vitest-bench-current.json");
const latestLogPath = resolve(root, "benchmarks/vitest-bench-current.verbose.txt");
const updateBaseline = process.argv.includes("--update-baseline");

const jsonPath = updateBaseline ? baselineJsonPath : latestJsonPath;
const logPath = updateBaseline ? baselineLogPath : latestLogPath;
const hasBaseline = existsSync(baselineJsonPath);

mkdirSync(dirname(jsonPath), { recursive: true });

const vitestArgs = [
  "exec",
  "vitest",
  "bench",
  "--run",
  "--maxWorkers=1",
  "--no-file-parallelism",
  "--reporter=verbose",
  "--outputJson",
  jsonPath,
];

if (!updateBaseline && hasBaseline) {
  vitestArgs.push("--compare", baselineJsonPath);
}

const result = spawnSync(
  "pnpm",
  vitestArgs,
  {
    cwd: root,
    encoding: "utf8",
  },
);

const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join("");
writeFileSync(logPath, combinedOutput);

if (combinedOutput) {
  process.stdout.write(combinedOutput);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
