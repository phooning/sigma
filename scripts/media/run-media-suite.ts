// Sigma media suite orchestrator.
//
//   node scripts/media/run-media-suite.ts --tier smoke|full|perf|soak [options]
//
// Options:
//   --seed <n|text>     workload seed (default 20261108)
//   --ops <n>           seeded canvas operations
//   --cycles <n>        soak / lifecycle cycles
//   --native / --no-native    real Tauri desktop scenario (macOS)
//   --browser / --no-browser  real-media Playwright scenario
//   --update-baseline   write benchmarks/media-baseline.json from this run
//   --keep              keep generated plan/fault directories
//
// Each run writes artifacts/benchmarks/<run-id>/{results.json,summary.md,metrics.csv}
// plus raw sub-reports. Exit code is non-zero only for FAIL gates.
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import {
  blockingFailures,
  browserRunFailure,
  browserScenarioFailures,
  CRITICAL_RELEASE_GATES,
  correctnessGate,
  desktopRunFailure,
  performanceGate,
  shutdownFailures,
} from "../../src/lib/media-corpus/gates.ts";
import { parseSeed } from "../../src/lib/media-corpus/random.ts";
import {
  type AssetOutcome,
  countByStatus,
  type RunResults,
  renderMarkdown,
  renderMetricsCsv,
  type StepRecord,
} from "../../src/lib/media-corpus/report.ts";
import {
  classifyRetention,
  summarize,
} from "../../src/lib/media-corpus/stats.ts";
import {
  BASELINE_SCHEMA,
  type BaselineFile,
  type CorpusAsset,
  type GateResult,
  type MetricRecord,
  RESULTS_SCHEMA,
  SUITE_VERSION,
} from "../../src/lib/media-corpus/types.ts";
import {
  ARTIFACTS_ROOT,
  BASELINE_PATH,
  CORPUS_ROOT,
  contentHashOf,
  environmentInfo,
  ffmpegVersion,
  gitInfo,
  listCorpusFiles,
  probeAsset,
  ROOT,
  readManifest,
  run,
  sha256File,
} from "./corpus.ts";
import { createFaultFixtures } from "./fault-fixtures.ts";

type Tier = "smoke" | "full" | "perf" | "soak";
const { values } = parseArgs({
  options: {
    tier: { type: "string", default: "smoke" },
    seed: { type: "string" },
    ops: { type: "string" },
    cycles: { type: "string" },
    native: { type: "boolean" },
    "no-native": { type: "boolean" },
    browser: { type: "boolean" },
    "no-browser": { type: "boolean" },
    "update-baseline": { type: "boolean" },
    keep: { type: "boolean" },
  },
});
const tier = values.tier as Tier;
if (!["smoke", "full", "perf", "soak"].includes(tier)) {
  console.error(`Unknown tier ${tier}`);
  process.exit(2);
}
const defaults = {
  smoke: {
    ops: 600,
    cycles: 0,
    native: false,
    browser: false,
    probeIterations: 1,
    concurrency: [] as number[],
  },
  full: {
    ops: 3000,
    cycles: 5,
    native: process.platform === "darwin",
    browser: true,
    probeIterations: 1,
    concurrency: [4],
  },
  perf: {
    ops: 1000,
    cycles: 0,
    native: false,
    browser: true,
    probeIterations: 7,
    concurrency: [1, 2, 4, 8, 8, 8],
  },
  soak: {
    ops: 5000,
    cycles: 12,
    native: false,
    browser: true,
    probeIterations: 1,
    concurrency: [] as number[],
  },
}[tier];
const seed = parseSeed(values.seed, 20261108);
const ops = Number(values.ops ?? defaults.ops);
const cycles = Number(values.cycles ?? defaults.cycles);
const wantNative = values["no-native"]
  ? false
  : (values.native ?? defaults.native);
const wantBrowser = values["no-browser"]
  ? false
  : (values.browser ?? defaults.browser);

const startedAt = new Date();
const runId = `${startedAt.toISOString().replace(/[:.]/g, "-")}-${tier}`;
const outDir = join(ARTIFACTS_ROOT, runId);
mkdirSync(outDir, { recursive: true });
const gates: GateResult[] = [];
const metrics: MetricRecord[] = [];
const steps: StepRecord[] = [];
const limitations: string[] = [];
const outcomes = new Map<string, AssetOutcome>();
const environment = environmentInfo();
const ffmpeg = environment.tools.ffmpeg ? "ffmpeg" : null;
const ffprobe = environment.tools.ffprobe ? "ffprobe" : null;

const gate = (args: Parameters<typeof correctnessGate>[0]) =>
  gates.push(correctnessGate({ ...args, tier }));
const notRun = (
  id: string,
  invariant: string,
  reason: string,
  unsupported = false,
) => {
  gate({
    id,
    invariant,
    tier,
    failures: null,
    ...(unsupported ? { unsupportedReason: reason } : {}),
  });
  limitations.push(`${id}: ${reason}`);
};
const outcome = (
  id: string,
  relativePath: string,
  surface: string,
  value: string,
) => {
  const entry = outcomes.get(id) ?? { id, relativePath, outcomes: {} };
  entry.outcomes[surface] = value;
  outcomes.set(id, entry);
};
const addMetric = (
  key: string,
  samples: readonly number[],
  meta: Pick<MetricRecord, "unit" | "surface" | "cache" | "workload"> & {
    higherIsBetter?: boolean;
  },
) => {
  if (samples.length === 0) return;
  metrics.push({ key, ...meta, summary: summarize(samples) });
};
const step = async <T>(
  name: string,
  body: () => Promise<T>,
  command?: string,
): Promise<T | undefined> => {
  const started = performance.now();
  console.log(`\n▶ ${name}`);
  try {
    const value = await body();
    steps.push({
      name,
      status: "passed",
      durationMs: performance.now() - started,
      ...(command ? { command } : {}),
    });
    return value;
  } catch (error) {
    steps.push({
      name,
      status: "failed",
      durationMs: performance.now() - started,
      note: String(error),
      ...(command ? { command } : {}),
    });
    console.error(`✖ ${name}: ${String(error)}`);
    return undefined;
  }
};
const runLogged = async (
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => {
  const result = await run(command, args, {
    env: { ...process.env, ...env },
    timeoutMs,
  });
  writeFileSync(
    join(outDir, `${name}.log`),
    `$ ${command} ${args.join(" ")}\n\n${result.stdout}\n${result.stderr}`,
  );
  return result;
};
const readJson = <T>(path: string): T | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;

/**
 * macOS: a locked screen or sleeping display stops WKWebView from rendering,
 * so UI-driven desktop checks cannot complete. Report that as an environmental
 * limitation instead of a regression.
 */
const screenLocked = () => {
  if (process.platform !== "darwin") return false;
  try {
    return /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(
      execFileSync("ioreg", ["-n", "Root", "-d1"], { encoding: "utf8" }),
    );
  } catch {
    return false;
  }
};

/** True when the top-level `moov` box precedes `mdat` (fast-start MP4). */
const isFastStart = (path: string) => {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(16);
    let offset = 0;
    const size = statSync(path).size;
    for (let index = 0; index < 32 && offset + 8 <= size; index += 1) {
      readSync(fd, header, 0, 16, offset);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      if (boxSize < 8) return false;
      offset += boxSize;
    }
    return false;
  } finally {
    closeSync(fd);
  }
};

// ---------------------------------------------------------------------------
// 1. Corpus discovery and verification
const manifest = readManifest();
gate({
  id: "corpus.manifest-present",
  invariant: "fixtures/media-corpus.manifest.json exists with schema v1",
  tier,
  failures: manifest
    ? []
    : ["manifest missing; run node scripts/media/build-manifest.ts"],
  checked: 1,
});
if (!manifest) {
  console.error("Missing manifest; aborting.");
  process.exit(1);
}
const filesOnDisk = await listCorpusFiles(CORPUS_ROOT);
const corpusPresent = filesOnDisk.length > 0;
if (!corpusPresent && tier !== "smoke") {
  console.error(
    `The ${tier} tier requires the real corpus under ${relative(ROOT, CORPUS_ROOT)}/ (${manifest.assetCount} assets, contentHash ${manifest.contentHash.slice(0, 16)}). It is not committed; provision it before requesting this tier.`,
  );
  gate({
    id: "corpus.available",
    invariant: "full corpus present for non-smoke tiers",
    tier,
    failures: ["corpus absent"],
    checked: 1,
  });
  process.exitCode = 1;
}
const assetsById = new Map(manifest.assets.map((asset) => [asset.id, asset]));
const selectedAssets: CorpusAsset[] = !corpusPresent
  ? []
  : tier === "smoke" || tier === "soak"
    ? manifest.subsets.smoke
        .map((id) => assetsById.get(id))
        .filter((asset): asset is CorpusAsset => !!asset)
    : manifest.assets;
const absolutePath = (asset: CorpusAsset) =>
  join(CORPUS_ROOT, asset.relativePath);
const hashesBefore = new Map<string, string>();

await step("verify corpus against manifest", async () => {
  if (!corpusPresent) {
    notRun(
      "corpus.manifest-current",
      "corpus files match manifest",
      "corpus absent (smoke uses committed lightweight fixtures)",
    );
    return;
  }
  const failures: string[] = [];
  const known = new Set(manifest.assets.map((asset) => asset.relativePath));
  for (const file of filesOnDisk)
    if (!known.has(file.relativePath))
      failures.push(`untracked file ${file.relativePath} (rebuild manifest)`);
  const onDisk = new Map(
    filesOnDisk.map((file) => [file.relativePath, file.absolutePath]),
  );
  const hashAll = tier === "full";
  for (const asset of manifest.assets) {
    const path = onDisk.get(asset.relativePath);
    if (!path) {
      failures.push(`missing ${asset.relativePath}`);
      outcome(asset.id, asset.relativePath, "corpus", "missing");
      continue;
    }
    const size = statSync(path).size;
    if (size !== asset.sizeBytes)
      failures.push(
        `${asset.relativePath}: size ${size} != ${asset.sizeBytes}`,
      );
    if (hashAll || selectedAssets.includes(asset)) {
      const hash = await sha256File(path);
      hashesBefore.set(asset.id, hash);
      if (hash !== asset.sha256)
        failures.push(`${asset.relativePath}: sha256 mismatch`);
    }
    outcome(asset.id, asset.relativePath, "corpus", asset.status);
  }
  gate({
    id: "corpus.manifest-current",
    invariant: `every file listed with matching size${hashAll ? " and sha256" : " (sha256 for exercised subset)"}; no untracked files`,
    tier,
    failures,
    checked: manifest.assets.length,
  });
  const recomputed = contentHashOf(manifest.assets);
  gate({
    id: "corpus.manifest-hash",
    invariant: "manifest contentHash matches its asset list",
    tier,
    failures:
      recomputed === manifest.contentHash
        ? []
        : [`${recomputed} != ${manifest.contentHash}`],
    checked: 1,
  });
  const unhealthy = manifest.assets.filter((asset) => asset.status !== "ok");
  gate({
    id: "corpus.decode-checks",
    invariant:
      "every manifest asset probes and decodes first/middle/near-end frames (ffmpeg)",
    tier,
    failures: unhealthy.map(
      (asset) =>
        `${asset.relativePath}: ${asset.status} ${asset.issues.join("; ")}`,
    ),
    checked: manifest.assets.length,
  });
});

// Full tier: decode every frame of every asset to catch mid-stream corruption.
if (tier === "full" && corpusPresent) {
  await step("full decode of every asset (ffmpeg)", async () => {
    if (!ffmpeg)
      return notRun(
        "corpus.full-decode",
        "every frame decodes without errors",
        "ffmpeg unavailable",
        true,
      );
    const failures: string[] = [];
    const fps: number[] = [];
    for (const asset of manifest.assets) {
      const started = performance.now();
      const result = await run(
        ffmpeg,
        [
          "-v",
          "error",
          "-threads",
          "0",
          "-i",
          absolutePath(asset),
          "-map",
          "0:v:0",
          "-f",
          "null",
          "-",
        ],
        { timeoutMs: 15 * 60_000 },
      );
      const seconds = (performance.now() - started) / 1000;
      const frames = (asset.durationSec ?? 0) * (asset.video?.frameRate ?? 0);
      if (result.code === 0 && !result.stderr.trim()) {
        fps.push(frames / seconds);
        outcome(
          asset.id,
          asset.relativePath,
          "ffmpeg-full-decode",
          `ok ${(frames / seconds).toFixed(0)} fps`,
        );
      } else {
        failures.push(
          `${asset.relativePath}: ${result.stderr.trim().split("\n").slice(-1)[0] ?? `exit ${result.code}`}`,
        );
        outcome(asset.id, asset.relativePath, "ffmpeg-full-decode", "FAIL");
      }
    }
    gate({
      id: "corpus.full-decode",
      invariant: "every frame of every asset decodes without errors",
      tier,
      failures,
      checked: manifest.assets.length,
    });
    addMetric("ffmpeg.full_decode_fps", fps, {
      unit: "fps",
      surface: "ffmpeg",
      cache: "n/a",
      workload: "software decode, all assets",
      higherIsBetter: true,
    });
  });
}

// ---------------------------------------------------------------------------
// 2. Fixture plan: corpus subset/all + lightweight committed clips + faults
type PlanAsset = {
  id: string;
  path: string;
  relativePath: string;
  kind: "corpus" | "failure";
  expect: "ok" | "error";
  grant: boolean;
  expected: {
    width: number;
    height: number;
    duration: number | null;
    frameRate: number | null;
    size: number;
  } | null;
};
const planAssets: PlanAsset[] = selectedAssets.map((asset) => ({
  id: asset.id,
  path: absolutePath(asset),
  relativePath: asset.relativePath,
  kind: "corpus",
  expect: asset.status === "ok" ? "ok" : "error",
  grant: true,
  expected: asset.video
    ? {
        width: asset.video.width,
        height: asset.video.height,
        duration: asset.durationSec,
        frameRate: asset.video.frameRate,
        size: asset.sizeBytes,
      }
    : null,
}));
let corpusRootForPlan = CORPUS_ROOT;
if (!corpusPresent) {
  // Separately defined lightweight fixtures; never reported as corpus coverage.
  corpusRootForPlan = join(ROOT, "fixtures");
  for (const name of [
    "generated-lod-test-1080p.mp4",
    "generated-lod-test-1080p.webm",
  ]) {
    const path = join(ROOT, "fixtures", name);
    if (!existsSync(path)) continue;
    const probed = await probeAsset(path, name, {
      ffprobe,
      ffmpeg,
      decodeChecks: false,
      sha256: "",
    });
    planAssets.push({
      id: `light-${name}`,
      path,
      relativePath: name,
      kind: "corpus",
      expect: "ok",
      grant: true,
      expected: probed.video
        ? {
            width: probed.video.width,
            height: probed.video.height,
            duration: probed.durationSec,
            frameRate: probed.video.frameRate,
            size: probed.sizeBytes,
          }
        : null,
    });
  }
  limitations.push(
    "Real corpus absent: smoke ran on the committed lightweight fixtures (fixtures/generated-lod-test-1080p.*) and manifest metadata only; no real-world coverage is claimed.",
  );
}
const donorAsset = selectedAssets.find(
  (asset) =>
    asset.status === "ok" && asset.video && isFastStart(absolutePath(asset)),
);
const faults = await createFaultFixtures({
  seed,
  ffmpeg,
  donor: donorAsset?.video
    ? {
        path: absolutePath(donorAsset),
        width: donorAsset.video.width,
        height: donorAsset.video.height,
        duration: donorAsset.durationSec,
        frameRate: donorAsset.video.frameRate,
        sizeBytes: donorAsset.sizeBytes,
      }
    : null,
});
planAssets.push(
  ...faults.fixtures.map(
    ({ description: _description, ...fixture }) => fixture,
  ),
);
if (!donorAsset)
  limitations.push(
    "No fast-start corpus clip available; truncated-container fixtures were not generated.",
  );
const planPath = join(outDir, "plan.json");
const ipcReportPath = join(outDir, "native-ipc-report.json");
writeFileSync(
  planPath,
  JSON.stringify(
    {
      corpusRoot: corpusRootForPlan,
      assets: planAssets,
      report: ipcReportPath,
      probeIterations: defaults.probeIterations,
      concurrencyLevels: defaults.concurrency,
      soakCycles: tier === "soak" ? cycles : 0,
    },
    null,
    2,
  ),
);

// ---------------------------------------------------------------------------
// 3. Native IPC (real Tauri command handlers via tauri::test)
type IpcReport = {
  assets: Array<{
    id: string;
    probe: {
      status: string;
      error: string | null;
      observed: Record<string, number> | null;
      mismatches: string[];
      latencyMs: number[];
    };
    thumbnail: {
      status: string;
      width?: number;
      height?: number;
      insideCache?: boolean;
      error?: string;
    };
    thumbnailColdMs: number;
    thumbnailWarmMs: number;
    warmMatchesCold: boolean;
  }>;
  metrics: {
    probeMs: number[];
    thumbnailColdMs: number[];
    thumbnailWarmMs: number[];
  };
  concurrency: Array<{
    level: number;
    wallMs: number;
    succeeded: number;
    requested: number;
    throughputPerSec: number;
  }>;
  soak: Array<{
    cycle: number;
    wallMs: number;
    failures: number;
    rssBytes: number | null;
    openFds?: number | null;
    liveChildren: string[];
    cacheBytes: number | null;
  }>;
  cacheStatsAfterClear: { totalBytes?: number } | null;
  liveChildrenAfterSerial: string[];
  liveChildrenAtEnd: string[];
  rss: {
    startBytes: number | null;
    endBytes: number | null;
    peakSelfBytes: number | null;
    peakChildBytes: number | null;
  };
  errors: string[];
};
const ipc = await step(
  "native IPC media commands (cargo test --test media_ipc)",
  async () => {
    const result = await runLogged(
      "native-ipc",
      "cargo",
      [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--test",
        "media_ipc",
        "--",
        "--nocapture",
        "--test-threads=1",
      ],
      { SIGMA_MEDIA_PLAN: planPath },
      60 * 60_000,
    );
    if (result.code !== 0)
      throw new Error(`cargo test exited ${result.code}; see native-ipc.log`);
    const report = readJson<IpcReport>(ipcReportPath);
    if (!report) throw new Error("native IPC report missing");
    return report;
  },
  "cargo test --manifest-path src-tauri/Cargo.toml --test media_ipc -- --nocapture",
);
if (!ipc) {
  for (const id of [
    "native.probe-contract",
    "native.failure-handling",
    "native.thumbnails",
    "native.no-orphan-processes",
  ]) {
    gate({
      id,
      invariant: "native IPC suite completed",
      tier,
      failures: ["native IPC suite did not complete (see native-ipc.log)"],
      checked: 1,
    });
  }
} else {
  const byId = new Map(ipc.assets.map((asset) => [asset.id, asset]));
  const corpusPlan = planAssets.filter((asset) => asset.kind === "corpus");
  const probeFailures: string[] = [];
  const thumbFailures: string[] = [];
  for (const asset of corpusPlan) {
    const native = byId.get(asset.id);
    const status = native?.probe.status ?? "missing";
    if (status !== "ok")
      probeFailures.push(
        `${asset.relativePath}: ${status} ${native?.probe.error ?? ""} ${native?.probe.mismatches.join("; ") ?? ""}`,
      );
    if (native && typeof native.probe.observed?.frameRate !== "number")
      probeFailures.push(
        `${asset.relativePath}: frameRate missing from IPC payload`,
      );
    const thumb = native?.thumbnail;
    if (
      asset.expect === "ok" &&
      (thumb?.status !== "ok" ||
        thumb.width !== 320 ||
        !native?.warmMatchesCold)
    ) {
      thumbFailures.push(
        `${asset.relativePath}: thumbnail ${JSON.stringify(thumb)} warm=${native?.warmMatchesCold}`,
      );
    }
    outcome(
      asset.id,
      asset.relativePath,
      "rust-ipc",
      status === "ok" && thumb?.status === "ok"
        ? "ok"
        : `${status}/${thumb?.status}`,
    );
  }
  gate({
    id: "native.probe-contract",
    invariant:
      "probe_media IPC payload (camelCase) matches ffprobe manifest: size, dimensions, duration ±0.1 s, frameRate ±0.01",
    tier,
    failures: probeFailures,
    checked: corpusPlan.length,
  });
  gate({
    id: "native.thumbnails",
    invariant:
      "request_decode yields a 320 px wide JPEG in the app cache; warm request is a cache hit for the same file",
    tier,
    failures: thumbFailures,
    checked: corpusPlan.filter((asset) => asset.expect === "ok").length,
  });
  const faultFailures: string[] = [];
  for (const fixture of faults.fixtures) {
    const native = byId.get(fixture.id);
    const status = native?.probe.status;
    const expected = fixture.expect === "ok" ? "ok" : "expected-error";
    const thumbOk =
      ["ok", "none"].includes(native?.thumbnail.status ?? "") ||
      (fixture.expect === "error" && native?.thumbnail.status === "error");
    if (status !== expected || !thumbOk)
      faultFailures.push(
        `${fixture.id}: probe ${status} (want ${expected}), thumbnail ${native?.thumbnail.status} ${native?.probe.error ?? ""}`,
      );
    if (
      fixture.id === "fault-ungranted" &&
      !native?.probe.error?.includes("scope")
    )
      faultFailures.push("ungranted path was not rejected by scope");
    if (fixture.id === "fault-sub-second" && native?.thumbnail.status !== "ok")
      faultFailures.push("sub-second clip got no thumbnail");
    outcome(
      fixture.id,
      fixture.relativePath,
      "rust-ipc",
      `${status}/${native?.thumbnail.status}`,
    );
  }
  gate({
    id: "native.failure-handling",
    invariant:
      "malformed/missing/denied media fail with controlled IPC errors (no fallback metadata, no crash); scope denial enforced",
    tier,
    failures: faultFailures,
    checked: faults.fixtures.length,
    reproduce: `--seed ${seed}`,
  });
  const orphanFailures = [
    ...ipc.liveChildrenAfterSerial,
    ...ipc.liveChildrenAtEnd,
    ...ipc.soak.flatMap((cycle) => cycle.liveChildren),
  ];
  gate({
    id: "native.no-orphan-processes",
    invariant:
      "no ffmpeg/ffprobe child processes remain after each command returns",
    tier,
    failures: orphanFailures,
    checked: ipc.assets.length,
  });
  gate({
    id: "native.cache-cleanup",
    invariant: "clear_media_cache leaves zero cached bytes",
    tier,
    failures:
      ipc.cacheStatsAfterClear?.totalBytes === 0
        ? []
        : [`cache bytes after clear: ${ipc.cacheStatsAfterClear?.totalBytes}`],
    checked: 1,
  });
  if (ipc.errors.length > 0) limitations.push(...ipc.errors);
  const surface = {
    surface: "rust-ipc" as const,
    workload: `${corpusPlan.length} assets, debug build`,
  };
  addMetric("rust.probe_ms", ipc.metrics.probeMs, {
    unit: "ms",
    cache: "n/a",
    ...surface,
  });
  addMetric("rust.thumbnail_cold_ms", ipc.metrics.thumbnailColdMs, {
    unit: "ms",
    cache: "cold",
    ...surface,
  });
  addMetric("rust.thumbnail_warm_ms", ipc.metrics.thumbnailWarmMs, {
    unit: "ms",
    cache: "warm",
    ...surface,
  });
  const probeTotal = ipc.metrics.probeMs.reduce((sum, value) => sum + value, 0);
  if (probeTotal > 0) {
    addMetric(
      "rust.metadata_throughput",
      [ipc.metrics.probeMs.length / (probeTotal / 1000)],
      { unit: "count", cache: "n/a", ...surface, higherIsBetter: true },
    );
  }
  const byLevel = new Map<number, number[]>();
  for (const entry of ipc.concurrency) {
    byLevel.set(entry.level, [
      ...(byLevel.get(entry.level) ?? []),
      entry.throughputPerSec,
    ]);
    if (entry.succeeded !== entry.requested)
      limitations.push(
        `decode concurrency ${entry.level}: ${entry.succeeded}/${entry.requested} succeeded`,
      );
  }
  for (const [level, samples] of byLevel) {
    addMetric(`rust.thumbnail_throughput@${level}`, samples, {
      unit: "count",
      cache: "cold",
      surface: "rust-ipc",
      workload: `${level} concurrent cold thumbnails`,
      higherIsBetter: true,
    });
  }
  if (ipc.rss.peakSelfBytes)
    addMetric("rust.peak_rss_bytes", [ipc.rss.peakSelfBytes], {
      unit: "bytes",
      cache: "n/a",
      ...surface,
    });
  if (ipc.rss.peakChildBytes)
    addMetric("rust.peak_child_rss_bytes", [ipc.rss.peakChildBytes], {
      unit: "bytes",
      cache: "n/a",
      ...surface,
    });
  if (ipc.soak.length > 0) {
    const rss = ipc.soak
      .map((cycle) => cycle.rssBytes ?? Number.NaN)
      .filter(Number.isFinite);
    const verdict = classifyRetention(rss, {
      warmup: 2,
      toleranceBytesPerCycle: 1024 * 1024,
    });
    gate({
      id: "soak.native-retention",
      invariant:
        "native RSS after each soak cycle does not keep growing (slope ≤ 1 MiB/cycle after warm-up)",
      tier,
      failures:
        verdict.kind === "growing"
          ? [verdict.detail]
          : verdict.kind === "insufficient"
            ? null
            : [],
      checked: rss.length,
      ...(verdict.kind === "insufficient"
        ? { unsupportedReason: verdict.detail }
        : {}),
    });
    addMetric("soak.native_rss_bytes", rss, {
      unit: "bytes",
      cache: "n/a",
      surface: "rust-ipc",
      workload: `${ipc.soak.length} cycles`,
    });
    const fds = ipc.soak
      .map((cycle) => cycle.openFds ?? Number.NaN)
      .filter(Number.isFinite);
    const steadyFds = fds.slice(2);
    const fdGrowth =
      steadyFds.length >= 4
        ? Math.max(...steadyFds) - steadyFds[0]
        : Number.NaN;
    gate({
      id: "soak.native-fd-retention",
      invariant:
        "open file descriptors after each soak cycle do not keep growing (≤ 2 above the first post-warm-up cycle)",
      tier,
      failures: Number.isNaN(fdGrowth)
        ? null
        : fdGrowth > 2
          ? [
              `descriptors ${steadyFds[0]} → max ${Math.max(...steadyFds)} over ${steadyFds.length} cycles`,
            ]
          : [],
      checked: fds.length,
      ...(Number.isNaN(fdGrowth)
        ? {
            unsupportedReason: `${steadyFds.length} post-warmup samples (need >= 4)`,
          }
        : {}),
    });
    if (fds.length > 0)
      addMetric("soak.native_open_fds", fds, {
        unit: "count",
        cache: "n/a",
        surface: "rust-ipc",
        workload: `${ipc.soak.length} cycles`,
      });
    gate({
      id: "soak.native-failures",
      invariant: "no command failures across soak cycles",
      tier,
      failures: ipc.soak
        .filter((cycle) => cycle.failures > 0)
        .map((cycle) => `cycle ${cycle.cycle}: ${cycle.failures} failures`),
      checked: ipc.soak.length,
    });
  }
}

// ---------------------------------------------------------------------------
// 4. Frontend correctness gates (Vitest, real app modules, native payloads)
type VitestJson = {
  success: boolean;
  numFailedTests: number;
  testResults: Array<{
    name: string;
    message?: string;
    assertionResults: Array<{
      title: string;
      status: string;
      failureMessages: string[];
    }>;
  }>;
};
type FrontendReport = {
  source: string;
  metrics: Array<{
    key: string;
    unit: MetricRecord["unit"];
    workload: string;
    samples: number[];
  }>;
  fixtureOutcomes: Record<string, string>;
};
await step(
  "frontend corpus gates (vitest)",
  async () => {
    const jsonPath = join(outDir, "vitest.json");
    const frontendOut = join(outDir, "frontend-report.json");
    const result = await runLogged(
      "vitest",
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "src/features/media-corpus",
        "src/lib/media-corpus",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${jsonPath}`,
      ],
      {
        SIGMA_MEDIA_SEED: String(seed),
        SIGMA_MEDIA_OPS: String(ops),
        SIGMA_MEDIA_FRONTEND_OUT: frontendOut,
        ...(ipc
          ? {
              SIGMA_MEDIA_PLAN: planPath,
              SIGMA_MEDIA_IPC_REPORT: ipcReportPath,
            }
          : {}),
      },
      30 * 60_000,
    );
    const report = readJson<VitestJson>(jsonPath);
    if (!report)
      throw new Error(`vitest produced no JSON (exit ${result.code})`);
    for (const file of report.testResults) {
      for (const test of file.assertionResults) {
        const id = test.title.match(/^\[([^\]]+)\]/)?.[1];
        const gateId = id
          ? `frontend.${id}`
          : `frontend.unit.${test.title.slice(0, 40)}`;
        if (!id) {
          if (test.status !== "passed")
            gate({
              id: gateId,
              invariant: test.title,
              tier,
              failures: test.failureMessages.map((m) => m.split("\n")[0] ?? m),
              checked: 1,
            });
          continue;
        }
        gate({
          id: gateId,
          invariant: test.title.replace(/^\[[^\]]+\]\s*/, ""),
          tier,
          failures:
            test.status === "passed"
              ? []
              : test.status === "failed"
                ? test.failureMessages.map((m) =>
                    m.split("\n").slice(0, 2).join(" "),
                  )
                : null,
          checked: 1,
          reproduce: `SIGMA_MEDIA_SEED=${seed} SIGMA_MEDIA_OPS=${ops} pnpm exec vitest run src/features/media-corpus -t "${id}"`,
        });
      }
      if (file.message)
        gate({
          id: `frontend.suite-error`,
          invariant: "test files load without errors",
          tier,
          failures: [file.message.split("\n")[0] ?? "error"],
          checked: 1,
        });
    }
    gate({
      id: "frontend.no-unhandled-errors",
      invariant:
        "no unhandled exceptions or rejections during the frontend suites",
      tier,
      failures: /Unhandled (Rejection|Error)/i.test(
        result.stdout + result.stderr,
      )
        ? ["unhandled error reported by vitest (see vitest.log)"]
        : [],
      checked: report.testResults.length,
    });
    const frontend = readJson<FrontendReport>(frontendOut);
    if (frontend) {
      if (frontend.source !== "native-ipc-report")
        limitations.push(
          `frontend gates used ${frontend.source} (native IPC report unavailable)`,
        );
      for (const entry of frontend.metrics) {
        addMetric(entry.key, entry.samples, {
          unit: entry.unit,
          surface: "jsdom",
          cache: "n/a",
          workload: entry.workload,
        });
      }
      for (const [id, value] of Object.entries(frontend.fixtureOutcomes)) {
        const asset = planAssets.find((candidate) => candidate.id === id);
        outcome(id, asset?.relativePath ?? id, "frontend-import", value);
      }
    }
  },
  "pnpm exec vitest run src/features/media-corpus src/lib/media-corpus",
);

// ---------------------------------------------------------------------------
// 5. Browser (Chromium) playback, seeking, lifecycle and scaling
type PlaywrightSuite = {
  title: string;
  specs?: Array<{
    title: string;
    ok: boolean;
    tests: Array<{
      status: string;
      results: Array<{ status: string; error?: { message?: string } }>;
    }>;
  }>;
  suites?: PlaywrightSuite[];
};
if (!wantBrowser) {
  notRun(
    "browser.playback",
    "real-media Chromium playback",
    `not requested for tier ${tier}`,
  );
} else if (!corpusPresent || selectedAssets.length === 0) {
  notRun("browser.playback", "real-media Chromium playback", "corpus absent");
} else {
  const browserDone = await step(
    "browser real-media scenario (playwright)",
    async () => {
      const browserOut = join(outDir, "browser");
      const browserPlanPath = join(outDir, "browser-plan.json");
      const okAssets = selectedAssets.filter(
        (asset) => asset.status === "ok" && asset.video,
      );
      writeFileSync(
        browserPlanPath,
        JSON.stringify({
          assets: okAssets.map((asset) => ({
            id: asset.id,
            relativePath: asset.relativePath,
            path: `/sigma-media-corpus/clips/${asset.relativePath}`,
            url: `/fixtures/clips/${asset.relativePath.split("/").map(encodeURIComponent).join("/")}`,
            probe: {
              width: asset.video?.width,
              height: asset.video?.height,
              duration: asset.durationSec ?? 0,
              frameRate: asset.video?.frameRate ?? 30,
              size: asset.sizeBytes,
            },
          })),
          nodeCounts: [1, 10, 25, 50, 100, 250],
          previewCounts: [1, 2, 4, 8, 16],
          cycles: Math.max(3, cycles),
          outDir: browserOut,
        }),
      );
      const grep = {
        smoke: "playback",
        full: "playback|switching|visibility|lifecycle",
        perf: "playback|preview-concurrency|scaling",
        soak: "lifecycle",
      }[tier];
      const jsonPath = join(outDir, "playwright.json");
      const result = await runLogged(
        "playwright",
        "pnpm",
        [
          "exec",
          "playwright",
          "test",
          "e2e/media-corpus.spec.ts",
          "--grep",
          grep,
          "--reporter=json",
          "--workers=1",
        ],
        {
          SIGMA_MEDIA_BROWSER_PLAN: browserPlanPath,
          PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath,
        },
        90 * 60_000,
      );
      const report = readJson<{
        suites: PlaywrightSuite[];
        errors?: unknown[];
      }>(jsonPath);
      const runnerFailure = browserRunFailure(result, report);
      if (runnerFailure) throw new Error(runnerFailure);
      if (!report) throw new Error("Playwright report missing");
      const walk = (
        suite: PlaywrightSuite,
      ): NonNullable<PlaywrightSuite["specs"]> => [
        ...(suite.specs ?? []),
        ...(suite.suites ?? []).flatMap(walk),
      ];
      const specs = report.suites.flatMap(walk);
      if (!specs.some((spec) => /^\[browser\./.test(spec.title)))
        throw new Error("Playwright reported no browser scenarios");
      for (const spec of specs) {
        const id = spec.title.match(/^\[([^\]]+)\]/)?.[1];
        if (!id) continue;
        const results = spec.tests.flatMap((test) => test.results);
        gate({
          id,
          invariant: spec.title.replace(/^\[[^\]]+\]\s*/, ""),
          tier,
          failures: browserScenarioFailures(spec.ok, results),
          checked: 1,
        });
      }
      const playback = readJson<{
        outcomes: Record<string, string>;
        startupMs: number[];
        seekMs: number[];
      }>(join(browserOut, "playback.json"));
      if (playback) {
        for (const asset of okAssets)
          outcome(
            asset.id,
            asset.relativePath,
            "browser-playback",
            playback.outcomes[asset.id] ?? "NOT_RUN",
          );
        if (
          Object.values(playback.outcomes).some(
            (value) => value === "unsupported",
          )
        ) {
          limitations.push(
            "Chromium reported MEDIA_ERR_SRC_NOT_SUPPORTED for some assets (platform codec limitation, not a regression).",
          );
        }
        addMetric("browser.playback_ready_ms", playback.startupMs, {
          unit: "ms",
          surface: "browser",
          cache: "cold",
          workload: `${okAssets.length} assets, load → readyState≥2`,
        });
        addMetric("browser.seek_ms", playback.seekMs, {
          unit: "ms",
          surface: "browser",
          cache: "n/a",
          workload: "start/middle/near-end seeks per asset",
        });
      }
      const scaling = readJson<{
        results: Array<{
          count: number;
          loadMs: number;
          heapBytes: number;
          videos: number;
          playing: number;
          frameDeltas: number[];
          longTasks: number[];
        }>;
      }>(join(browserOut, "scaling.json"));
      for (const entry of scaling?.results ?? []) {
        addMetric(`browser.pan_frame_ms@${entry.count}`, entry.frameDeltas, {
          unit: "ms",
          surface: "browser",
          cache: "n/a",
          workload: `${entry.count} video nodes, 60 wheel pans (${entry.videos} <video> mounted, ${entry.playing} playing)`,
        });
        addMetric(`browser.heap_bytes@${entry.count}`, [entry.heapBytes], {
          unit: "bytes",
          surface: "browser",
          cache: "n/a",
          workload: `${entry.count} video nodes after GC`,
        });
        addMetric(`browser.workspace_load_ms@${entry.count}`, [entry.loadMs], {
          unit: "ms",
          surface: "browser",
          cache: "n/a",
          workload: `${entry.count} video nodes`,
        });
      }
      const concurrency = readJson<{
        levels: Array<{
          count: number;
          mounted: number;
          advancing: number;
          droppedFrames: number;
          totalFrames: number;
          frameDeltas: number[];
        }>;
      }>(join(browserOut, "preview-concurrency.json"));
      for (const level of concurrency?.levels ?? []) {
        addMetric(
          `browser.preview_frame_ms@${level.count}`,
          level.frameDeltas,
          {
            unit: "ms",
            surface: "browser",
            cache: "n/a",
            workload: `${level.count} visible previews (${level.advancing}/${level.mounted} advancing)`,
          },
        );
        if (level.totalFrames > 0) {
          addMetric(
            `browser.preview_dropped_ratio@${level.count}`,
            [level.droppedFrames / level.totalFrames],
            {
              unit: "ratio",
              surface: "browser",
              cache: "n/a",
              workload: `${level.count} visible previews, 2 s`,
            },
          );
        }
      }
      const lifecycle = readJson<{
        retainedHeapBytes: number[];
        leftoverVideoElements: number[];
      }>(join(browserOut, "lifecycle.json"));
      if (lifecycle) {
        const verdict = classifyRetention(lifecycle.retainedHeapBytes, {
          warmup: 1,
          toleranceBytesPerCycle: 512 * 1024,
        });
        gate({
          id: "browser.heap-retention",
          invariant:
            "JS heap after each unload+GC does not keep growing (≤ 512 KiB/cycle after warm-up)",
          tier,
          failures:
            verdict.kind === "growing"
              ? [verdict.detail]
              : verdict.kind === "insufficient"
                ? null
                : [],
          checked: lifecycle.retainedHeapBytes.length,
          ...(verdict.kind === "insufficient"
            ? { unsupportedReason: verdict.detail }
            : {}),
        });
        addMetric("browser.retained_heap_bytes", lifecycle.retainedHeapBytes, {
          unit: "bytes",
          surface: "browser",
          cache: "n/a",
          workload: `${lifecycle.retainedHeapBytes.length} load/unload cycles, after GC`,
        });
      }
      return true;
    },
    "pnpm exec playwright test e2e/media-corpus.spec.ts",
  );
  gate({
    id: "browser.media",
    invariant: "real-media Chromium scenario completes",
    tier,
    failures: browserDone
      ? []
      : ["scenario did not complete (see playwright.log)"],
    checked: 1,
  });
}

// ---------------------------------------------------------------------------
// 6. Native desktop (real Tauri app, WKWebView, FFmpeg decoders)
type DesktopReport = {
  ipc?: Array<{
    id: string;
    probe: { ok: boolean; value?: Record<string, number>; error?: string };
    probeMs: number;
    thumbnail: unknown;
    thumbnailMs: number;
  }>;
  import?: { elapsedMs: number; items: Array<Record<string, unknown>> };
  playback?: Array<{
    id: string;
    status: string;
    code?: number;
    readyMs: number;
    advanced?: boolean;
    seekMs?: number;
    seekError?: number;
  }>;
  nativeDecode?: {
    requested: number;
    states: string[];
    decoderPids: number[];
    frame: { packetBytes: number; packetMagic: string };
  };
  afterStopAll?: { survivingDecoders: number[]; items: number };
  shutdown?: {
    exit: { code: number | null; signal: string | null };
    decodersAtClose: number[];
    thumbnailPidsAtClose: number[];
    survivingDecoders: number[];
  };
  stages?: Array<{ name: string; rssBytes: number | null }>;
  error?: string;
};
if (!wantNative) {
  notRun(
    "desktop.media",
    "real Tauri desktop media scenario",
    `not requested for tier ${tier} (pass --native)`,
  );
} else if (process.platform !== "darwin") {
  notRun(
    "desktop.media",
    "real Tauri desktop media scenario",
    `embedded WebDriver desktop tests are verified only on macOS (platform ${process.platform})`,
    true,
  );
} else if (!corpusPresent) {
  notRun("desktop.media", "real Tauri desktop media scenario", "corpus absent");
} else if (screenLocked()) {
  notRun(
    "desktop.media",
    "real Tauri desktop media scenario",
    "screen is locked or the display is asleep; WKWebView does not render, so the real-app scenario cannot run",
    true,
  );
} else {
  const desktopDone = await step(
    "native desktop media scenario (pnpm test:desktop)",
    async () => {
      const desktopReportPath = join(outDir, "desktop-media-report.json");
      const desktopPlanPath = join(outDir, "desktop-plan.json");
      const okAssets = selectedAssets.filter(
        (asset) => asset.status === "ok" && asset.video,
      );
      const decodeIds = [...okAssets]
        .sort(
          (a, b) =>
            (b.video?.width ?? 0) * (b.video?.height ?? 0) -
              (a.video?.width ?? 0) * (a.video?.height ?? 0) ||
            (a.id < b.id ? -1 : 1),
        )
        .slice(0, 4)
        .map((asset) => asset.id);
      writeFileSync(
        desktopPlanPath,
        JSON.stringify({
          mediaDirs: [CORPUS_ROOT, faults.directory],
          assets: planAssets
            .filter((asset) => asset.grant)
            .map((asset) => ({ ...asset })),
          playbackAssetIds: okAssets.map((asset) => asset.id),
          decodeAssetIds: decodeIds,
          report: desktopReportPath,
        }),
      );
      const result = await runLogged(
        "desktop",
        "pnpm",
        ["test:desktop"],
        { SIGMA_DESKTOP_MEDIA_PLAN: desktopPlanPath },
        60 * 60_000,
      );
      const report = readJson<DesktopReport>(desktopReportPath);
      if (!report)
        throw new Error(
          `${desktopRunFailure(result, null)} (exit ${result.code}); see desktop.log`,
        );
      if (report.error)
        limitations.push(
          `desktop scenario error: ${report.error.split("\n")[0]}`,
        );
      const ipcFailures: string[] = [];
      for (const asset of planAssets.filter((candidate) => candidate.grant)) {
        const entry = report.ipc?.find(
          (candidate) => candidate.id === asset.id,
        );
        if (!entry) {
          ipcFailures.push(`${asset.relativePath}: not exercised`);
          continue;
        }
        if (asset.expect === "ok") {
          const value = entry.probe.value;
          if (!entry.probe.ok || !value)
            ipcFailures.push(`${asset.relativePath}: ${entry.probe.error}`);
          else if (
            asset.expected &&
            (value.width !== asset.expected.width ||
              value.height !== asset.expected.height ||
              (asset.expected.frameRate !== null &&
                Math.abs((value.frameRate ?? 0) - asset.expected.frameRate) >
                  0.01))
          ) {
            ipcFailures.push(`${asset.relativePath}: ${JSON.stringify(value)}`);
          }
        } else if (entry.probe.ok)
          ipcFailures.push(`${asset.relativePath}: unexpected success`);
        outcome(
          asset.id,
          asset.relativePath,
          "desktop-ipc",
          entry.probe.ok ? "ok" : "error",
        );
      }
      gate({
        id: "desktop.ipc-contract",
        invariant:
          "probe_media over real WKWebView IPC matches manifest (incl. frameRate); faults rejected",
        tier,
        failures: ipcFailures,
        checked: report.ipc?.length ?? 0,
      });
      const imported = report.import?.items ?? [];
      gate({
        id: "desktop.import",
        invariant:
          "production drop-import creates one item per decodable asset with numeric frameRate, in order",
        tier,
        failures: [
          // The scenario imports every granted asset expected to probe OK
          // (corpus clips plus the healthy fault fixtures).
          ...(imported.length ===
          planAssets.filter((asset) => asset.grant && asset.expect === "ok")
            .length
            ? []
            : [`${imported.length} items imported`]),
          ...imported
            .filter((item) => typeof item.frameRate !== "number")
            .map(
              (item) =>
                `${String(item.filePath)}: frameRate ${String(item.frameRate)}`,
            ),
        ],
        checked: imported.length,
      });
      const playbackFailures: string[] = [];
      for (const entry of report.playback ?? []) {
        const asset = assetsById.get(entry.id);
        const fps = asset?.video?.frameRate ?? 30;
        const ok =
          entry.status === "ready" &&
          entry.advanced &&
          (entry.seekError ?? 1) <= 2 / fps + 0.01;
        outcome(
          entry.id,
          asset?.relativePath ?? entry.id,
          "desktop-playback",
          ok
            ? "ok"
            : entry.status === "error" && entry.code === 4
              ? "unsupported"
              : `FAIL ${entry.status}`,
        );
        if (!ok && !(entry.status === "error" && entry.code === 4))
          playbackFailures.push(
            `${asset?.relativePath}: ${JSON.stringify(entry)}`,
          );
      }
      gate({
        id: "desktop.playback",
        invariant:
          "WKWebView <video> via asset protocol becomes ready, advances and seeks within two frames",
        tier,
        failures: playbackFailures,
        checked: report.playback?.length ?? 0,
      });
      const decode = report.nativeDecode;
      const activeStates =
        decode?.states.filter((state) => state.toLowerCase() === "active")
          .length ?? 0;
      gate({
        id: "desktop.decoder-throttling",
        invariant:
          "native arbiter caps active FFmpeg decoders (≤ active allocations) and delivers SVF1 frames",
        tier,
        failures: !decode
          ? ["not exercised"]
          : [
              ...(decode.decoderPids.length <= Math.max(activeStates, 1)
                ? []
                : [
                    `${decode.decoderPids.length} decoders for ${activeStates} active allocations`,
                  ]),
              ...(decode.frame.packetMagic === "SVF1" &&
              decode.frame.packetBytes > 64
                ? []
                : [`no frame: ${JSON.stringify(decode.frame)}`]),
            ],
        checked: decode?.requested ?? 0,
      });
      gate({
        id: "desktop.stop-all-releases",
        invariant:
          "native_video_stop_all terminates every decoder; clearing the canvas leaves zero items",
        tier,
        failures: !report.afterStopAll
          ? ["not exercised"]
          : [
              ...report.afterStopAll.survivingDecoders.map(
                (pid) => `decoder ${pid} survived`,
              ),
              ...(report.afterStopAll.items === 0
                ? []
                : [`${report.afterStopAll.items} items remain`]),
            ],
        checked: 1,
      });
      gate({
        id: "desktop.shutdown-under-load",
        invariant:
          "closing the window during active decoding and a pending thumbnail exits with code 0 and leaves no decoder processes",
        tier,
        failures: !report.shutdown
          ? ["not exercised"]
          : shutdownFailures(report.shutdown),
        checked: 1,
      });
      addMetric(
        "desktop.probe_ms",
        (report.ipc ?? [])
          .filter((entry) => entry.probe.ok)
          .map((entry) => entry.probeMs),
        {
          unit: "ms",
          surface: "native-desktop",
          cache: "n/a",
          workload: "WKWebView IPC probe_media",
        },
      );
      addMetric(
        "desktop.thumbnail_cold_ms",
        (report.ipc ?? [])
          .filter((entry) => typeof entry.thumbnail === "string")
          .map((entry) => entry.thumbnailMs),
        {
          unit: "ms",
          surface: "native-desktop",
          cache: "cold",
          workload: "WKWebView IPC request_decode",
        },
      );
      if (report.import)
        addMetric("desktop.import_ms", [report.import.elapsedMs], {
          unit: "ms",
          surface: "native-desktop",
          cache: "n/a",
          workload: `${imported.length} assets via onDropMedia`,
        });
      addMetric(
        "desktop.playback_ready_ms",
        (report.playback ?? [])
          .filter((entry) => entry.status === "ready")
          .map((entry) => entry.readyMs),
        {
          unit: "ms",
          surface: "native-desktop",
          cache: "cold",
          workload: "WKWebView <video> canplay",
        },
      );
      addMetric(
        "desktop.seek_ms",
        (report.playback ?? []).flatMap((entry) =>
          typeof entry.seekMs === "number" ? [entry.seekMs] : [],
        ),
        {
          unit: "ms",
          surface: "native-desktop",
          cache: "n/a",
          workload: "WKWebView mid seek",
        },
      );
      for (const stageEntry of report.stages ?? []) {
        if (stageEntry.rssBytes)
          addMetric(
            `desktop.rss_bytes@${stageEntry.name}`,
            [stageEntry.rssBytes],
            {
              unit: "bytes",
              surface: "native-desktop",
              cache: "n/a",
              workload:
                "app process RSS (excludes WebContent/GPU helper processes)",
            },
          );
      }
      limitations.push(
        "Desktop RSS covers the Tauri host process only; WKWebView WebContent and GPU helper processes are separate and not measured.",
      );
      // Sub-gates above stay for diagnosis, but the aggregate (critical)
      // desktop.media row must not pass when the runner itself failed.
      const runFailure = desktopRunFailure(result, report);
      if (runFailure) throw new Error(`${runFailure}; see desktop.log`);
      return true;
    },
    "SIGMA_DESKTOP_MEDIA_PLAN=… pnpm test:desktop",
  );
  gate({
    id: "desktop.media",
    invariant: "real Tauri desktop media scenario completes",
    tier,
    failures: desktopDone
      ? []
      : ["scenario did not complete (see desktop.log)"],
    checked: 1,
  });
}

// ---------------------------------------------------------------------------
// 7. Fixture immutability (hash again after every workload)
await step("verify corpus immutability", async () => {
  if (!corpusPresent)
    return notRun(
      "corpus.immutable",
      "source clips unchanged after the run",
      "corpus absent",
    );
  const failures: string[] = [];
  for (const [id, before] of hashesBefore) {
    const asset = assetsById.get(id);
    if (!asset) continue;
    const after = await sha256File(absolutePath(asset));
    if (after !== before)
      failures.push(`${asset.relativePath} changed during the run`);
  }
  gate({
    id: "corpus.immutable",
    invariant:
      "sha256 of every exercised source clip identical before and after the run",
    tier,
    failures,
    checked: hashesBefore.size,
  });
});

// ---------------------------------------------------------------------------
// 8. Performance gates against the calibrated baseline
const baseline = readJson<BaselineFile>(BASELINE_PATH);
const BUDGETS: Array<{ id: string; key: string }> = [
  { id: "perf.import-latency", key: "frontend.import.batch_ms" },
  { id: "perf.metadata-latency", key: "rust.probe_ms" },
  { id: "perf.metadata-throughput", key: "rust.metadata_throughput" },
  { id: "perf.thumbnail-cold", key: "rust.thumbnail_cold_ms" },
  { id: "perf.thumbnail-warm", key: "rust.thumbnail_warm_ms" },
  { id: "perf.seek-latency", key: "browser.seek_ms" },
  { id: "perf.playback-ready", key: "browser.playback_ready_ms" },
  { id: "perf.canvas-frame@100", key: "browser.pan_frame_ms@100" },
  { id: "perf.canvas-frame@250", key: "browser.pan_frame_ms@250" },
  { id: "perf.state-mutation@250", key: "frontend.state.move_one_ms@250" },
  { id: "perf.persist-save", key: "frontend.persist.save_ms" },
  {
    id: "perf.persist-serialize@250",
    key: "frontend.persist.serialize_ms@250",
  },
  { id: "perf.peak-memory", key: "rust.peak_rss_bytes" },
  { id: "perf.retained-memory", key: "browser.retained_heap_bytes" },
];
if (tier === "perf" || tier === "full") {
  for (const budget of BUDGETS) {
    const metric = metrics.find((entry) => entry.key === budget.key);
    gates.push({
      id: budget.id,
      ...performanceGate({
        metric,
        baseline,
        environment: environment.fingerprint,
        tier,
      }),
    });
  }
}
if (values["update-baseline"]) {
  const next: BaselineFile = {
    schema: BASELINE_SCHEMA,
    environment: environment.fingerprint,
    recordedAt: startedAt.toISOString().slice(0, 10),
    method: `node scripts/media/run-media-suite.ts --tier ${tier} --update-baseline (seed ${seed}); p50/p95 of measured samples; metrics with fewer than 5 samples are omitted`,
    thresholds: { default: 0.25, ...(baseline?.thresholds ?? {}) },
    metrics: Object.fromEntries(
      metrics
        .filter(
          (metric) => metric.summary.n >= 5 && metric.summary.p50 !== null,
        )
        .map((metric) => [
          metric.key,
          {
            key: metric.key,
            unit: metric.unit,
            p50: metric.summary.p50 as number,
            p95: (metric.summary.p95 ?? metric.summary.p50) as number,
            n: metric.summary.n,
          },
        ]),
    ),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `Baseline written to ${relative(ROOT, BASELINE_PATH)} (${Object.keys(next.metrics).length} metrics)`,
  );
}

// ---------------------------------------------------------------------------
// 9. Reports
if (!values.keep) await faults.cleanup();
else limitations.push(`Fault fixtures kept at ${faults.directory}`);
const exercised = [
  ...new Set(
    planAssets
      .filter((asset) => asset.kind === "corpus" && assetsById.has(asset.id))
      .map((asset) => asset.id),
  ),
];
if (tier === "full") {
  for (const id of CRITICAL_RELEASE_GATES) {
    if (!gates.some((entry) => entry.id === id)) {
      gates.push(
        correctnessGate({
          id,
          invariant: "required release check executed",
          tier,
          failures: null,
        }),
      );
    }
  }
}
const results: RunResults = {
  schema: RESULTS_SCHEMA,
  suiteVersion: SUITE_VERSION,
  runId,
  tier,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  git: gitInfo(),
  environment: {
    ...environment,
    tools: { ...environment.tools, ffmpegFull: ffmpegVersion() },
  },
  corpus: {
    manifestHash: manifest.contentHash,
    present: corpusPresent,
    assetCount: manifest.assetCount,
    totalBytes: manifest.totalBytes,
    verification: !corpusPresent
      ? "absent"
      : tier === "full"
        ? "sha256"
        : "size",
    exercisedAssetIds: exercised,
  },
  workload: {
    seed,
    operations: ops,
    cycles,
    native: wantNative,
    browser: wantBrowser,
    faults: faults.fixtures.map((fixture) => fixture.id),
  },
  steps,
  gates,
  metrics,
  assets: [...outcomes.values()].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : 1,
  ),
  limitations: [...new Set(limitations)],
};
writeFileSync(
  join(outDir, "results.json"),
  `${JSON.stringify(results, null, 2)}\n`,
);
writeFileSync(join(outDir, "summary.md"), renderMarkdown(results));
writeFileSync(join(outDir, "metrics.csv"), renderMetricsCsv(results));
const counts = countByStatus(gates);
console.log(
  `\nGates: ${Object.entries(counts)
    .map(([status, count]) => `${status} ${count}`)
    .join(" · ")}`,
);
const blockers = blockingFailures(gates, tier === "full");
for (const blocked of blockers)
  console.log(`  BLOCKED ${blocked.id}: ${blocked.status} ${blocked.detail}`);
console.log(`Report: ${relative(ROOT, join(outDir, "summary.md"))}`);
if (blockers.length > 0 || steps.some((entry) => entry.status === "failed"))
  process.exitCode = 1;
