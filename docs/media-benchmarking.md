# Media corpus testing and benchmarking

Sigma's media suite turns a real-world clip corpus into deterministic correctness gates, reproducible workloads and baseline-compared performance measurements. It drives the production code paths: real Tauri command handlers (Rust), the real import, store, preview-queue and persistence modules (TypeScript), the real canvas in Chromium, and the real desktop app (WKWebView and FFmpeg decoders).

## Prerequisites

| Requirement | Used by | When missing |
| --- | --- | --- |
| Node 26 and pnpm 10.32 | everything | — |
| Rust (pinned in `rust-toolchain.toml`) | native IPC tier | step fails, gates FAIL |
| `ffmpeg` and `ffprobe` on `PATH` | manifest, thumbnails, fault fixtures | probe falls back / gates report UNSUPPORTED |
| Corpus in `fixtures/clips/` (~850 MB) | full, perf, soak | those tiers **exit 1**; smoke runs on the lightweight committed fixtures |
| Playwright Chromium (`pnpm pw:install`) | browser tier | step fails |
| macOS | native desktop tier | gate UNSUPPORTED |

The corpus is not committed (it is in `.gitignore`). `fixtures/media-corpus.manifest.json` is committed: it pins each asset by SHA-256, so any machine can verify it has exactly the same corpus.

## Commands

```bash
pnpm test:media:manifest   # (re)build fixtures/media-corpus.manifest.json from fixtures/clips/
pnpm test:media:smoke      # ~15 s: representative subset + fault fixtures, all correctness gates
pnpm test:media:full       # every asset: full ffmpeg decode, native IPC, frontend, Chromium, desktop app
pnpm test:media:perf       # repeated measurements + perf gates against the baseline
pnpm test:media:soak       # long-running lifecycle/memory cycles (defaults: 12 cycles, 5000 ops)
```

Options (append after `--` is not needed with pnpm 10): `--seed <n|text>`, `--ops <n>`, `--cycles <n>`, `--native`/`--no-native`, `--browser`/`--no-browser`, `--update-baseline`, `--keep`.

`node scripts/media/build-manifest.ts --check` fails if the corpus no longer matches the committed manifest.

### Tiers

| Tier | Assets | Native IPC | Frontend gates | Chromium | Desktop app | Perf gates |
| --- | --- | --- | --- | --- | --- | --- |
| smoke | 4-asset subset (greedy group cover) + 10 fault fixtures | yes | 600 seeded ops | no | no | no |
| full | all 16 + faults; full frame decode | yes | 3000 ops | playback, switching, visibility, lifecycle | yes on macOS | reported |
| perf | all + faults; 7 probe iterations, decode concurrency 1–8 | yes | 1000 ops | playback, preview concurrency, scaling 1–250 nodes | opt-in | enforced when calibrated |
| soak | subset; repeated native cycles | yes | 5000 ops | lifecycle cycles | opt-in | no |

Plain `pnpm test` always runs the library unit tests and the frontend corpus gates against the committed manifest metadata (no binaries needed); CI therefore exercises the ingest, workload and persistence invariants on every PR. `pnpm test:e2e` skips the real-media spec unless the orchestrator provides a plan.

## What each layer exercises

- **Manifest** (`scripts/media/build-manifest.ts`): streaming SHA-256, ffprobe metadata (codec, profile, resolution, rotation, frame rate, VFR evidence, bit depth, colour/HDR, audio, auxiliary streams), first/middle/near-end decode checks, logical groups, coverage gaps and the deterministic smoke subset. Ordering is by NFC code points; no absolute paths or timestamps.
- **Native IPC** (`src-tauri/tests/media_ipc.rs`): real command handlers dispatched through `tauri::test` — scope validation, serde payloads, the decode arbiter, ffprobe/ffmpeg, the thumbnail cache, concurrency and soak cycles, child-process cleanup and RSS.
- **Frontend** (`src/features/media-corpus/`): `onDropMedia`, the canvas session store, `useThumbnailQueue` and workspace save/load fed with the exact payloads the Rust commands returned for each asset.
- **Chromium** (`e2e/media-corpus.spec.ts`): the production canvas renders real clips served by Vite (HTTP range requests); playback readiness, play/pause, seek accuracy, rapid scrubbing, asset switching, offscreen pause/resume, preview concurrency, pan frame times and heap retention.
- **Desktop** (`desktop-tests/media-corpus.ts`, launched by `pnpm test:desktop` when `SIGMA_DESKTOP_MEDIA_PLAN` is set): WKWebView IPC, production import, `<video>` over the asset protocol, native decoder throttling, `stop_all`, and closing the window during active decoding with a pending thumbnail.
- **Fault fixtures** (`scripts/media/fault-fixtures.ts`): generated in a temp directory per run — random bytes, empty, text-as-video, vanished, ungranted, truncated tail/head (partial *reads* of a corpus clip), sub-second clip, audio-only, mode-000. The corpus is never written; `corpus.immutable` re-hashes it after every run.

## Reading results

Each run writes `artifacts/benchmarks/<run-id>/` (ignored by git):

- `results.json` (`sigma.media-results.v1`): git revision, environment fingerprint, tool versions, manifest hash, seed and workload, every gate, every metric (n, min, p50, p95, p99, max, mean, cv, noisy) and per-asset outcomes per surface.
- `summary.md`: the same, human-readable. `metrics.csv`: one row per metric for trend analysis.
- Raw sub-reports (`native-ipc-report.json`, `frontend-report.json`, `browser/*.json`, `desktop-media-report.json`) and logs.

### Gate states

| State | Meaning |
| --- | --- |
| PASS | the invariant was evaluated over at least one item and held, or a calibrated metric is within threshold |
| FAIL | an invariant was violated, or a calibrated metric regressed beyond threshold — exit code 1 |
| UNCALIBRATED | measured, but no baseline for this environment, too few samples (< 5), or metric absent from the baseline — never blocks |
| UNSUPPORTED | the platform cannot run the check (e.g. desktop tier off macOS, ffmpeg missing) |
| NOT_RUN | the check was not requested or did not execute; a check that evaluated zero items is also NOT_RUN |

A missing metric, missing baseline or insufficient sample count is never a PASS.

Correctness failures carry reproduction hints; seeded workloads report the seed, the failing operation index and the operation JSON. Replay with e.g. `SIGMA_MEDIA_SEED=20261108 SIGMA_MEDIA_OPS=35 pnpm exec vitest run src/features/media-corpus -t state.seeded-workload`.

## Baselines

`benchmarks/media-baseline.json` stores p50/p95 per metric for one environment fingerprint (`platform|arch|cpu|cores|memory|node major|ffmpeg major`). Perf gates compare p50 against `baseline × (1 + threshold)` (default threshold 0.25; per-metric overrides in `thresholds`). A different fingerprint yields UNCALIBRATED.

Record a baseline on a quiet reference machine (AC power, no other heavy processes):

```bash
pnpm test:media:perf --update-baseline
```

Metrics with fewer than 5 samples are omitted from the baseline. Treat `⚠︎noisy` (coefficient of variation > 0.35) metrics with caution; re-run before acting on them.

Important measurement notes:
- Rust IPC timings come from a debug test build; they are dominated by the ffprobe/ffmpeg child processes, not Rust code.
- jsdom timings measure JavaScript cost of store/serialization code only, not rendering.
- Chromium (Playwright) is not the shipping webview. macOS ships WKWebView; codec support and decode performance differ. The desktop tier measures WKWebView directly.
- Desktop RSS covers the Tauri host process only; WKWebView WebContent/GPU processes are not included.
- Memory retention is judged by the post-warm-up slope of samples taken after explicit cleanup and GC: a slope that flattens in the second half is a cache/allocator plateau, a slope that persists is reported as growth.

## CI strategy

- PR checks (`test-and-build.yml`): `pnpm test` (library + manifest-metadata frontend gates) and `cargo test` (includes the always-on IPC stale-generation test; the corpus plan test prints NOT RUN without a plan).
- Native integration: `pnpm test:desktop` on a macOS runner.
- Full corpus: a provisioned runner or a local machine with the corpus; `pnpm test:media:full` fails clearly when the corpus is absent.
- Performance: `pnpm test:media:perf` on the calibrated reference machine only.
- Soak: scheduled or manual `pnpm test:media:soak`.
