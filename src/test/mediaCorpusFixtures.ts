// Loads media fixtures for frontend corpus tests.
//
// With SIGMA_MEDIA_PLAN + SIGMA_MEDIA_IPC_REPORT (written by
// scripts/media/run-media-suite.ts) every fixture carries the exact payload the
// real Rust `probe_media` command returned over Tauri IPC, so the frontend is
// tested against the native contract. Without them, fixtures fall back to the
// committed manifest's ffprobe metadata and are labelled accordingly.
import { existsSync, readFileSync } from "node:fs";
import manifestJson from "../../fixtures/media-corpus.manifest.json";
import type { CorpusManifest } from "../lib/media-corpus/types";

export type NativeProbe =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export type CorpusFixture = {
  id: string;
  path: string;
  relativePath: string;
  kind: "corpus" | "failure";
  expectProbe: "ok" | "error";
  probe: NativeProbe;
  /** Thumbnail path the native decode arbiter produced, if any. */
  thumbnailPath: string | null;
};

export type FixtureSet = {
  source: "native-ipc-report" | "manifest-metadata";
  corpusRoot: string;
  fixtures: CorpusFixture[];
};

type PlanFile = {
  corpusRoot: string;
  assets: Array<{
    id: string;
    path: string;
    relativePath: string;
    kind: "corpus" | "failure";
    expect: "ok" | "error";
  }>;
};

type IpcReport = {
  assets: Array<{
    id: string;
    probe: {
      status: string;
      error: string | null;
      observed: Record<string, unknown> | null;
    };
    thumbnail: { status: string };
    thumbnailPath?: string;
  }>;
};

export const corpusManifest = manifestJson as CorpusManifest;

/** Virtual root used when only manifest metadata is available. */
const VIRTUAL_ROOT = "/sigma-media-corpus/clips";

export const loadFixtureSet = (): FixtureSet => {
  const planPath = process.env.SIGMA_MEDIA_PLAN;
  const reportPath = process.env.SIGMA_MEDIA_IPC_REPORT;
  if (
    planPath &&
    reportPath &&
    existsSync(planPath) &&
    existsSync(reportPath)
  ) {
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as PlanFile;
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as IpcReport;
    const byId = new Map(report.assets.map((asset) => [asset.id, asset]));
    return {
      source: "native-ipc-report",
      corpusRoot: plan.corpusRoot,
      fixtures: plan.assets.map((asset) => {
        const native = byId.get(asset.id);
        const probe: NativeProbe =
          native?.probe.error || !native?.probe.observed
            ? { ok: false, error: native?.probe.error ?? "not probed" }
            : { ok: true, value: native.probe.observed };
        return {
          id: asset.id,
          path: asset.path,
          relativePath: asset.relativePath,
          kind: asset.kind,
          expectProbe: asset.expect,
          probe,
          thumbnailPath: null,
        };
      }),
    };
  }
  return {
    source: "manifest-metadata",
    corpusRoot: VIRTUAL_ROOT,
    fixtures: corpusManifest.assets.map((asset) => ({
      id: asset.id,
      path: `${VIRTUAL_ROOT}/${asset.relativePath}`,
      relativePath: asset.relativePath,
      kind: "corpus",
      expectProbe: asset.status === "ok" ? "ok" : "error",
      probe:
        asset.video && asset.status === "ok"
          ? {
              ok: true,
              value: {
                width: asset.video.width,
                height: asset.video.height,
                duration: asset.durationSec ?? 0,
                frameRate: asset.video.frameRate ?? 30,
                size: asset.sizeBytes,
              },
            }
          : {
              ok: false,
              error: `${asset.relativePath} could not be read as media`,
            },
      thumbnailPath: null,
    })),
  };
};

export const envNumber = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
