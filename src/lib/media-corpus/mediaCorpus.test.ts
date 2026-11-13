import { describe, expect, it } from "vitest";
import manifestJson from "../../../fixtures/media-corpus.manifest.json";
import {
  classifyAsset,
  compareCorpusPaths,
  computeCoverage,
  detectVariableFrameRateFromPts,
  selectRepresentativeSubset,
} from "./classify";
import {
  blockingFailures,
  browserRunFailure,
  browserScenarioFailures,
  correctnessGate,
  desktopRunFailure,
  performanceGate,
  previewWorkloadFailure,
  shutdownFailures,
} from "./gates";
import {
  checkCanvasInvariants,
  diffNormalizedItems,
  normalizeItemsForComparison,
} from "./invariants";
import { createRng, parseSeed } from "./random";
import { type RunResults, renderMarkdown, renderMetricsCsv } from "./report";
import { classifyRetention, summarize } from "./stats";
import {
  type BaselineFile,
  type CorpusAsset,
  type CorpusManifest,
  MANIFEST_SCHEMA,
  type MetricRecord,
  RESULTS_SCHEMA,
} from "./types";
import { generateWorkload } from "./workload";

const manifest = manifestJson as CorpusManifest;

const metric = (samples: number[], key = "import.latency"): MetricRecord => ({
  key,
  unit: "ms",
  surface: "jsdom",
  cache: "n/a",
  workload: "test",
  summary: summarize(samples),
});

const baseline = (p50: number, environment = "env-a"): BaselineFile => ({
  schema: "sigma.media-baseline.v1",
  environment,
  recordedAt: "2026-11-08",
  method: "test",
  thresholds: { default: 0.25 },
  metrics: {
    "import.latency": {
      key: "import.latency",
      unit: "ms",
      p50,
      p95: p50,
      n: 10,
    },
  },
});

describe("seeded randomness", () => {
  it("replays identical sequences for the same seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    const left = Array.from({ length: 50 }, () => a.next());
    expect(Array.from({ length: 50 }, () => b.next())).toEqual(left);
    expect(left.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(createRng(43).next()).not.toBe(left[0]);
  });

  it("accepts numeric and textual seeds", () => {
    expect(parseSeed("123")).toBe(123);
    expect(parseSeed("nightly")).toBe(parseSeed("nightly"));
    expect(parseSeed(undefined, 7)).toBe(7);
  });

  it("generates the same workload for the same seed", () => {
    expect(generateWorkload(createRng(9), 200)).toEqual(
      generateWorkload(createRng(9), 200),
    );
    const kinds = new Set(
      generateWorkload(createRng(9), 2000).map((op) => op.kind),
    );
    expect(kinds.size).toBe(12);
  });
});

describe("statistics", () => {
  it("computes nearest-rank percentiles", () => {
    const summary = summarize(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    expect(summary).toMatchObject({
      n: 100,
      min: 1,
      max: 100,
      p50: 50,
      p95: 95,
      p99: 99,
    });
  });

  it("withholds tail percentiles for small samples instead of inventing them", () => {
    const summary = summarize([3, 1, 2]);
    expect(summary.p50).toBe(2);
    expect(summary.p95).toBeNull();
    expect(summary.p99).toBeNull();
  });

  it("flags noisy samples", () => {
    expect(summarize([1, 1, 1, 50, 1, 1]).noisy).toBe(true);
    expect(summarize([10, 10.2, 9.9, 10.1, 10]).noisy).toBe(false);
  });

  it("separates cache plateaus from steady growth", () => {
    const mb = 1024 * 1024;
    expect(
      classifyRetention(
        [0, 50, 100, 100, 100, 100, 100, 100].map((v) => v * mb),
      ).kind,
    ).toBe("stable");
    expect(
      classifyRetention(
        [0, 0, 10, 20, 30, 30, 30, 30, 30, 30].map((v) => v * mb),
      ).kind,
    ).toBe("plateau");
    expect(
      classifyRetention(
        [0, 0, 5, 10, 15, 20, 25, 30, 35, 40].map((v) => v * mb),
      ).kind,
    ).toBe("growing");
    expect(classifyRetention([1, 2, 3]).kind).toBe("insufficient");
  });
});

describe("gates", () => {
  it("requires a cold thumbnail process and checks its cleanup at shutdown", () => {
    const shutdown = {
      exit: { code: 0, signal: null },
      decodersAtClose: [1],
      survivingDecoders: [] as number[],
    };
    expect(shutdownFailures(shutdown)).toContain(
      "no cold thumbnail decode was active at close",
    );
    expect(
      shutdownFailures({
        ...shutdown,
        thumbnailPidsAtClose: [2],
        survivingDecoders: [2],
      }),
    ).toContain("decoder 2 survived shutdown");
    expect(
      shutdownFailures({ ...shutdown, thumbnailPidsAtClose: [2] }),
    ).toEqual([]);
  });
  it("keeps explicit failures when no items were imported", () => {
    const result = correctnessGate({
      id: "import",
      invariant: "imports",
      tier: "full",
      checked: 0,
      failures: ["0 items imported"],
    });
    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("0 items imported");
  });

  it("rejects a desktop run that failed after writing a complete report", () => {
    const complete = {};
    const ok = { code: 0, timedOut: false };
    expect(desktopRunFailure(ok, complete)).toBeNull();
    expect(desktopRunFailure({ code: 1, timedOut: false }, complete)).toContain(
      "exited with code 1",
    );
    expect(
      desktopRunFailure({ code: null, timedOut: true }, complete),
    ).toContain("timed out");
    expect(
      desktopRunFailure(ok, { error: "AssertionError: late\n  at stack" }),
    ).toBe("desktop scenario error: AssertionError: late");
    expect(desktopRunFailure(ok, null)).toContain("no report");
  });

  it("rejects unsuccessful and empty Playwright runs", () => {
    const report = { suites: [{}], errors: [] };
    expect(
      browserRunFailure({ code: 1, timedOut: false }, report),
    ).not.toBeNull();
    expect(
      browserRunFailure({ code: 0, timedOut: true }, report),
    ).not.toBeNull();
    expect(
      browserRunFailure(
        { code: 0, timedOut: false },
        { suites: [], errors: ["runner error"] },
      ),
    ).not.toBeNull();
    expect(
      browserRunFailure({ code: 0, timedOut: false }, { suites: [] }),
    ).not.toBeNull();
    expect(browserRunFailure({ code: 0, timedOut: false }, report)).toBeNull();
    expect(browserScenarioFailures(true, [])).not.toEqual([]);
    expect(browserScenarioFailures(true, [{ status: "skipped" }])).not.toEqual(
      [],
    );
    expect(browserScenarioFailures(true, [{ status: "passed" }])).toEqual([]);
  });

  it("rejects incomplete or nonfunctional preview workloads", () => {
    expect(
      previewWorkloadFailure({
        count: 4,
        mounted: 0,
        advancing: 0,
        totalFrames: 0,
      }),
    ).not.toBeNull();
    expect(
      previewWorkloadFailure({
        count: 4,
        mounted: 4,
        advancing: 3,
        totalFrames: 10,
      }),
    ).not.toBeNull();
    expect(
      previewWorkloadFailure({
        count: 4,
        mounted: 4,
        advancing: 4,
        totalFrames: 0,
      }),
    ).not.toBeNull();
    expect(
      previewWorkloadFailure({
        count: 4,
        mounted: 4,
        advancing: 4,
        totalFrames: 10,
      }),
    ).toBeNull();
  });

  it("never reports PASS for checks that did not run or checked nothing", () => {
    expect(
      correctnessGate({
        id: "g",
        invariant: "i",
        tier: "smoke",
        failures: null,
      }).status,
    ).toBe("NOT_RUN");
    expect(
      correctnessGate({
        id: "g",
        invariant: "i",
        tier: "smoke",
        failures: [],
        checked: 0,
      }).status,
    ).toBe("NOT_RUN");
    expect(
      correctnessGate({
        id: "g",
        invariant: "i",
        tier: "smoke",
        failures: null,
        unsupportedReason: "no H.264 decoder",
      }).status,
    ).toBe("UNSUPPORTED");
    const failed = correctnessGate({
      id: "g",
      invariant: "i",
      tier: "smoke",
      failures: ["x"],
      checked: 3,
      reproduce: "--seed 4",
    });
    expect(failed.status).toBe("FAIL");
    expect(failed.reproduce).toBe("--seed 4");
  });

  it("blocks a full release when a critical check did not run", () => {
    const skipped = correctnessGate({
      id: "desktop.media",
      invariant: "native media",
      tier: "full",
      failures: null,
    });
    expect(blockingFailures([skipped])).toEqual([]);
    expect(blockingFailures([skipped], true)).toEqual([skipped]);
  });

  it("is UNCALIBRATED without a matching baseline, enough samples, or the metric", () => {
    const samples = metric([10, 10, 10, 10, 10]);
    const common = { environment: "env-a", tier: "perf" };
    expect(
      performanceGate({ ...common, metric: undefined, baseline: baseline(10) })
        .status,
    ).toBe("NOT_RUN");
    expect(
      performanceGate({ ...common, metric: samples, baseline: null }).status,
    ).toBe("UNCALIBRATED");
    expect(
      performanceGate({
        ...common,
        metric: samples,
        baseline: baseline(10, "env-b"),
      }).status,
    ).toBe("UNCALIBRATED");
    expect(
      performanceGate({
        ...common,
        metric: metric([10, 10]),
        baseline: baseline(10),
      }).status,
    ).toBe("UNCALIBRATED");
    expect(
      performanceGate({
        ...common,
        metric: metric([1, 1, 1, 1, 1], "other"),
        baseline: baseline(1),
      }).status,
    ).toBe("UNCALIBRATED");
  });

  it("enforces the configured regression threshold on a calibrated environment", () => {
    const common = { environment: "env-a", tier: "perf" };
    expect(
      performanceGate({
        ...common,
        metric: metric([12, 12, 12, 12, 12]),
        baseline: baseline(10),
      }).status,
    ).toBe("PASS");
    expect(
      performanceGate({
        ...common,
        metric: metric([13, 13, 13, 13, 13]),
        baseline: baseline(10),
      }).status,
    ).toBe("FAIL");
  });
});

describe("corpus manifest", () => {
  it("is ordered by NFC code points and free of absolute paths", () => {
    expect(manifest.schema).toBe(MANIFEST_SCHEMA);
    const paths = manifest.assets.map((asset) => asset.relativePath);
    expect([...paths].sort(compareCorpusPaths)).toEqual(paths);
    for (const path of paths) {
      expect(path.startsWith("/")).toBe(false);
      expect(path).not.toMatch(/^[A-Za-z]:[\\/]|\\/);
      expect(path).toBe(path.normalize("NFC"));
    }
    expect(manifest.assetCount).toBe(manifest.assets.length);
    expect(new Set(manifest.assets.map((asset) => asset.id)).size).toBe(
      manifest.assets.length,
    );
  });

  it("reproduces groups, coverage and the smoke subset from asset metadata", () => {
    for (const asset of manifest.assets) {
      const { groups, ...rest } = asset;
      expect(classifyAsset(rest)).toEqual(groups);
    }
    expect(computeCoverage(manifest.assets)).toEqual(manifest.coverage);
    expect(selectRepresentativeSubset(manifest.assets)).toEqual(
      manifest.subsets.smoke,
    );
    expect(manifest.subsets.smoke.length).toBeGreaterThan(0);
  });

  it("does not claim coverage for dimensions absent from the corpus", () => {
    const codecs = manifest.coverage.dimensions.codec ?? [];
    for (const gap of manifest.coverage.gaps.filter((gap) =>
      gap.startsWith("codec:"),
    )) {
      expect(codecs).not.toContain(gap.slice("codec:".length));
    }
  });

  it("orders paths independently of Unicode normalization form", () => {
    const composed = "tráfico.mp4";
    const decomposed = "tráfico.mp4";
    expect(compareCorpusPaths(composed, decomposed)).toBe(0);
    const asset = manifest.assets[0] as CorpusAsset;
    const { groups: _groups, ...rest } = asset;
    expect(classifyAsset({ ...rest, relativePath: decomposed })).toContain(
      "pathological:non-ascii-path",
    );
  });

  it("detects variable frame rate only from real timestamp jitter", () => {
    // Constant 24 fps in B-frame decode order with a truncated reorder tail.
    const constant = Array.from({ length: 240 }, (_, index) => index / 24);
    const decodeOrder = constant.flatMap((value, index) =>
      index % 3 === 1
        ? []
        : index % 3 === 2
          ? [value, constant[index - 1] as number]
          : [value],
    );
    expect(detectVariableFrameRateFromPts(decodeOrder.slice(0, 232))).toBe(
      false,
    );
    const variable = constant.map(
      (value, index) => value + (index % 7 === 0 ? 0.02 : 0),
    );
    expect(detectVariableFrameRateFromPts(variable)).toBe(true);
    expect(detectVariableFrameRateFromPts([0, 1, 2])).toBeNull();
  });
});

describe("canvas invariants", () => {
  const item = {
    id: "a",
    type: "video" as const,
    filePath: "/clips/a.mp4",
    url: "asset://a",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
  };

  it("reports duplicate ids, non-finite geometry and invalid zoom", () => {
    const failures = checkCanvasInvariants(
      [item, { ...item, x: Number.NaN }, { ...item, id: "b", width: 0 }],
      { x: 0, y: 0, zoom: 9 },
    );
    expect(failures.join("\n")).toMatch(/duplicate id/);
    expect(failures.join("\n")).toMatch(/x not finite/);
    expect(failures.join("\n")).toMatch(/non-positive size/);
    expect(failures.join("\n")).toMatch(/zoom 9/);
    expect(checkCanvasInvariants([item], { x: 1, y: 2, zoom: 1 })).toEqual([]);
  });

  it("compares persisted state without volatile URLs", () => {
    const left = normalizeItemsForComparison([item]);
    const right = normalizeItemsForComparison([
      { ...item, url: "asset://elsewhere" },
    ]);
    expect(diffNormalizedItems(left, right)).toEqual([]);
    expect(
      diffNormalizedItems(
        left,
        normalizeItemsForComparison([{ ...item, x: 1 }]),
      ),
    ).toHaveLength(1);
  });
});

describe("reports", () => {
  it("renders every gate status and metric to Markdown and CSV", () => {
    const results: RunResults = {
      schema: RESULTS_SCHEMA,
      suiteVersion: "test",
      runId: "run-1",
      tier: "smoke",
      startedAt: "a",
      finishedAt: "b",
      git: { revision: "abc", dirty: false },
      environment: {
        fingerprint: "env",
        platform: "darwin",
        arch: "arm64",
        osRelease: "1",
        cpuModel: "cpu",
        cpuCount: 1,
        memoryBytes: 1024 ** 3,
        node: "v26",
        tools: { ffmpeg: null },
      },
      corpus: {
        manifestHash: "hash",
        present: false,
        assetCount: 0,
        totalBytes: 0,
        verification: "absent",
        exercisedAssetIds: [],
      },
      workload: { seed: 1 },
      steps: [],
      gates: [
        correctnessGate({
          id: "g1",
          invariant: "inv",
          tier: "smoke",
          failures: ["bad|pipe"],
          checked: 1,
        }),
        correctnessGate({
          id: "g2",
          invariant: "inv",
          tier: "smoke",
          failures: null,
        }),
      ],
      metrics: [metric([1, 2, 3, 4, 5])],
      assets: [{ id: "a", relativePath: "a.mp4", outcomes: { probe: "ok" } }],
      limitations: ["corpus absent"],
    };
    const markdown = renderMarkdown(results);
    expect(markdown).toContain("**FAIL**");
    expect(markdown).toContain("**NOT_RUN**");
    expect(markdown).toContain("bad\\|pipe");
    expect(markdown).toContain("corpus absent");
    const csv = renderMetricsCsv(results).trim().split("\n");
    expect(csv).toHaveLength(2);
    expect(csv[1]).toContain("import.latency");
  });
});
