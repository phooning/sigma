# Sigma Canvas internal beta readiness

**Assessment date:** 2026-11-11 (America/Los_Angeles), Phase 4C  
**Checkout:** `impl-8` at `84e6c37` plus an uncommitted working tree. Nothing was committed or pushed.  
**Decision:** **GO for a controlled internal macOS beta** using a developer-provided build with FFmpeg installed separately. **NO-GO for public or signed distribution.** This is a limited qualification. It does not claim power-loss durability or an hours-long native session.

## Evidence boundary

- **Read:** `docs/SIGMA_ENGINEERING_EVIDENCE.md`, `docs/lifecycle-hardening.md`, and the reports under `artifacts/benchmarks/`.
- **Missing:** `docs/desktop-media-qualification.md` and `docs/native-media-safety.md` do not exist in this checkout. No evidence was taken from them.
- **Backlog IDs:** The dossier does not define the `SIG-*` IDs used in the Phase 4C brief. They are mapped below by their titles in that brief.
- **Superseded reports:** The 2026-11-09 full report has `desktop.media` **FAIL**, and the preliminary report `2026-11-12T01-14-07-318Z-full` lacked aggregate rows. Neither counts as a pass.
- **Mocked layers:** Vitest and Playwright mock Tauri IPC. Rust IPC tests use Tauri's mock runtime. Only rows labeled *native* in the tables below ran the real Tauri, WKWebView, and FFmpeg processes on macOS.

This document replaces the earlier Phase 4C draft written today. That draft listed directory-sync failure, real disk-full, mid-write permission revocation, and descriptor growth as unverified. This pass closed those four gaps.

## 1. Resolved blockers

### Carried forward from the earlier Phase 4C work (re-verified in this pass)

- **SIG-A08 / B05–B07: invalid recovery data and Save As.**
  - Invalid recovery JSON, an invalid state shape, or an unsupported session envelope keeps its exact original `localStorage` value.
  - Automatic overwrite of that value is disabled.
  - The persistent "Canvas recovery failed" notice offers **Export original data**. It writes the untouched string to a file the user chooses, using the atomic native save command.
  - Export never clears or rewrites the recovery key. Save As still saves new in-memory work.
- **SIG-A13: malformed canvas validation.**
  - Loading validates optional media metadata (`frameRate`, `sourceWidth`, `sourceHeight`, `duration`, `fileSize`, preview paths, `deferVideoLoad`) and crop values.
  - Duplicate item IDs and unknown `schemaVersion` values are rejected before the workspace changes.
  - New saves write `schemaVersion: 1`. Legacy unversioned files are still accepted. No migration was needed, because the evidence shows only one format in the field.
- **SIG-B12 (part): read-only destination.** Atomic save refuses an existing read-only target and tells the user to use Save As.
- **SIG-A14 / D16: release gate and report integrity.**
  - The full runner records a missing critical row as NOT_RUN.
  - It exits nonzero when any gate is FAIL or any critical release row is not PASS. The critical rows are `corpus.manifest-current`, `native.probe-contract`, `native.thumbnails`, `browser.media`, `desktop.media`, and `desktop.shutdown-under-load`.
- **SIG-B03: hung shutdown timeout.** A hung shutdown is cancelled after 10 s and the app stays open. A late acknowledgment cannot exit it. Re-run natively in this pass.

### New in this pass

- **SIG-B04: directory durability acknowledgement.**
  - **Defect found:** after the rename, any error from the parent-directory `fsync` failed the save. Some volumes (SMB, some FUSE/exFAT mounts) return `EINVAL`/`ENOTSUP` for a directory fsync. On those volumes every save would have been reported as failed, and the session would have stayed dirty permanently.
  - **Fix:** directory sync is now injectable. "Unsupported" results are treated as best effort. A real I/O error (for example `EIO`) is still reported, with a message saying the file was written but its folder could not be flushed, and suggesting save again or Save As.
  - **Tests:** a unit test injects `EIO`, `EINVAL`, `ENOTSUP`, and `Unsupported`. It checks that the destination is always the complete new file (never a partial one) and that no temporary file remains.
- **SIG-B12: disk-full and permission revocation.**
  - **Real disk-full test (native macOS):** `scripts/fs-faults/disk-full.ts` creates a disposable 4 MiB HFS+ disk image, fills it until `ENOSPC`, and runs an opt-in Rust test. An 8 MiB save fails, the original bytes stay intact, and the temporary file is removed. After space is freed, a small save succeeds. The script always detaches and deletes the image.
  - **Mid-write revocation:** a new unit test makes the folder read-only after the temporary file is complete and before the rename. The rename fails and the original stays intact. The hidden `.sigma-canvas-*.tmp` cannot be deleted while the folder is read-only. It never replaces the destination.
- **SIG-A13: future-format UX.** Opening a canvas with `schemaVersion > 1` now says "format version N … cannot open. The file was not changed." The previous message was the generic "not a valid Sigma config". A Playwright test checks the message, checks that the current canvas is kept, and checks that the app never writes to that file.
- **SIG-D10: resource endurance.** The native soak now records open file descriptors in every cycle and has a new gate, `soak.native-fd-retention`. A 20-cycle soak passed (section 5).

## 2. Remaining blockers

The items below block **public** release. None blocks the controlled internal beta, provided testers are told about them.

1. **No hours-long native app soak.** Endurance evidence covers 20 cycles of the Rust IPC harness and 20 browser cycles, about 37 s of wall time in total. Separately, the native full report has one RSS sample per stage. WKWebView WebContent and GPU helper memory, descriptors inside the real app, and cache growth over hours were not measured.
2. **Power-loss durability is not established.** No real power cut was run. The directory-sync path is exercised only by fault injection.
3. **The recovery export has not been driven natively.** The export button and exact-bytes write are tested in Chromium with mocked IPC. No WebDriver test clicks it inside the Tauri app, because the native save dialog cannot be driven.
4. **Permission revocation by macOS (TCC or sandbox) during a write was not tested.** It was simulated with POSIX folder permissions. Network volumes were not tested.
5. **No distribution qualification.** There is no signed or notarized installer, no bundled FFmpeg, and no cross-platform build.

## 3. Test evidence and exact commands

**Environment:** Node 26.13.0 and pnpm 10.32.1, macOS on Apple M5 (10 CPUs, 16 GiB), rustc 1.96.1, FFmpeg/ffprobe 9.0.2. The commands ran one at a time, because they share port 1420 and the Cargo target directory.

| Command | Layer | Result |
| --- | --- | --- |
| `pnpm test` | Automated, mocked IPC | PASS: 204 tests in 26 files |
| `pnpm test:e2e` | Automated, Chromium, mocked IPC | PASS: 31 passed, 7 skipped (optional performance and corpus cases). Includes the recovery export and the new future-format refusal. |
| `pnpm lint:apply`, `pnpm lint` | Static | PASS. Biome reformatted only files changed in this pass. |
| `pnpm exec tsc --noEmit`, `pnpm exec tsc -p tsconfig.scripts.json --noEmit` | Static | PASS. The scripts config now includes `scripts/fs-faults`. |
| `cargo test --manifest-path src-tauri/Cargo.toml --all-targets --all-features` | Automated Rust; real FFmpeg subprocesses; mock Tauri runtime | PASS: 39 unit tests plus 1 ignored (disk-full, opt-in); IPC integration tests and Criterion smoke checks pass |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | Static | PASS |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Static | PASS. The existing stable-toolchain `trailing_comma` warning remains. |
| `node scripts/fs-faults/disk-full.ts` | **Native macOS**, real full volume | PASS. Filled 3,997,696 bytes; the 8 MiB save was refused; original intact; temp removed; mount cleaned up. |
| `pnpm test:desktop` | **Native macOS**: Tauri, WKWebView, FFmpeg | PASS. Window close and Cocoa Quit drain pending saves. The 10 s deadline keeps the app open, and a late acknowledgment cannot exit it. Restart restores items, crop, viewport, and missing media. |
| `node scripts/media/run-media-suite.ts --tier soak --cycles 20 --ops 1200` | Automated, Rust IPC and browser | PASS, [soak report](../artifacts/benchmarks/2026-11-12T03-32-36-435Z-soak/summary.md): 34 PASS, 0 FAIL, 1 NOT_RUN (`desktop.media` is not part of the soak tier by design) |
| `node scripts/media/run-media-suite.ts --tier full --ops 1200 --cycles 5` | **Native macOS** plus automated | PASS (exit 0), [full report](../artifacts/benchmarks/2026-11-12T03-36-31-155Z-full/summary.md): 51 PASS, 0 FAIL, 2 NOT_RUN, 3 UNCALIBRATED. Every critical release row is PASS. |

The two NOT_RUN rows in the full report are `perf.canvas-frame@100` and `@250`, which recorded no samples. The three UNCALIBRATED rows (`perf.metadata-throughput`, `perf.peak-memory`, `perf.retained-memory`) have no matching baseline entry. All five are non-critical, and the gate shows them rather than counting them as passes.

## 4. Regression matrix

| Failure or transition | Status | Layer and evidence |
| --- | --- | --- |
| Corrupt recovery value; future session envelope | PASS | Vitest and Playwright: the value is preserved, and export writes the identical string |
| Malformed project; malformed optional media metadata | PASS | `fs.test.ts`; Playwright keeps the existing canvas after a malformed load |
| Future project schema | PASS | `fs.test.ts` checks the message; Playwright checks the message, that the canvas is kept, and that the file is never written |
| Legacy unversioned project | PASS | `fs.test.ts` |
| Interrupted write before rename | PASS | Native unit fault test, plus a real SIGKILL in `pnpm test:desktop` that kept the previous committed canvas |
| Real disk full | PASS | **Native**: `disk-full.ts` on a full HFS+ image |
| Existing read-only destination | PASS | Rust unit test: original bytes and directory entries unchanged |
| Folder permission revoked before rename | PASS | Rust unit test (POSIX permissions). TCC/sandbox revocation is NOT VERIFIED. |
| Scope denied or revoked | PASS | Rust IPC test; the real desktop denied save blocks shutdown until a successful retry |
| Failed parent-directory sync | PASS (fault injection) | Rust unit test: `EIO` is reported and the file is complete; unsupported results are tolerated. A real power cut is NOT VERIFIED. |
| Save failure → dirty state and retry | PASS | Playwright and the `frontend.persist.save-failure` gate |
| Repeated restart; invalid hydration | PASS | Native restart scenarios; store regressions |
| Simultaneous lifecycle requests | PASS | Native duplicate-close coalescing; frontend stale-response tests |
| Hung shutdown | PASS | Native: the 10 s deadline keeps the process open |
| Media source removed | PASS | Native: the decoder exits; restart keeps the missing item's identity and geometry |
| Critical release check missing or not run | PASS | `mediaCorpus.test.ts`; the full runner blocks on any non-PASS critical row |

## 5. Resource measurements

**20-cycle soak** ([native IPC report](../artifacts/benchmarks/2026-11-12T03-32-36-435Z-soak/native-ipc-report.json)). Each cycle clears the cache, then probes and decodes four corpus assets through Tauri IPC with the mock runtime and real FFmpeg.

- **RSS of the Rust test process:** 47,169,536 bytes in cycles 0–1, then 45,023,232 bytes flat from cycle 4 through cycle 19. Slope is zero; `soak.native-retention` PASS.
- **Open file descriptors:** 10 in every one of the 20 cycles; `soak.native-fd-retention` PASS.
- **Cache size after each cycle:** 112,077 bytes every cycle.
- **FFmpeg children:** no ffmpeg/ffprobe child survived. Fourteen orphan checks passed, and none remained at the end.
- **Browser heap after GC across 20 load/unload cycles:** 12,408,372–13,467,964 bytes (CV 0.02); `browser.heap-retention` PASS.

**Native full report** ([desktop report](../artifacts/benchmarks/2026-11-12T03-36-31-155Z-full/summary.md)). One RSS sample of the Tauri host process per stage:

| Stage | RSS (bytes) |
| --- | --- |
| Launched | 135,217,152 |
| IPC probed | 137,773,056 |
| Imported | 137,936,896 |
| Played | 123,535,360 |
| Native decoding | 125,353,984 |
| Cleaned up | 125,386,752 |

The decoder arbiter capped active decoders. Stop-all and shutdown left zero decoder processes.

These are single samples per stage, not a retention slope. WebContent and GPU helper processes are excluded.

**Not measured:** descriptors and RSS inside the real app over many cycles, GPU memory, and multi-hour sessions.

## 6. Known supported limitations

- **Platform:** macOS only. FFmpeg and ffprobe must be installed separately and be on `PATH`.
- **Media access:** media must stay in its granted location. Missing sources keep their placement on the canvas but cannot play.
- **Post-rename sync failure:** if the folder cannot be flushed after a successful rename, Sigma reports the save as failed and keeps the session dirty, even though the file already holds the complete new bytes. Saving again is safe. Volumes that do not support directory fsync are treated as successful saves.
- **Leftover temp file:** if folder write permission is revoked in the middle of a save, a hidden `.sigma-canvas-<pid>-<n>.tmp` file can remain. It is never used as the canvas.
- **Export destination:** recovery export goes wherever the user points it. Choosing an existing canvas file (macOS asks for confirmation first) replaces that file with the raw recovery bytes.
- **Concurrent writers:** there is no lock against another process writing the same canvas.

## 7. Qualification matrix and internal-beta decision

| Area | Status | Evidence and boundary |
| --- | --- | --- |
| Graceful shutdown | PASS | Native: close and Cocoa Quit drain saves; timeout and late acknowledgments handled |
| File-save integrity | PASS | Native: real disk-full and SIGKILL tests. Unit: write, read-only, rename-permission, and directory-sync faults. Power loss is NOT VERIFIED. |
| Recovery UX | PASS (browser) | Playwright: exact-bytes export, Save As, and future-format refusal. The native click-through is NOT VERIFIED. |
| Media import and previews | PASS | Native full report: probe contract, thumbnails, playback |
| Decoder cleanup | PASS | Native: zero decoders after stop-all and shutdown; no orphans in the soak |
| Filesystem permissions | PASS (POSIX and scope) | Native denied save; Rust scope and permission tests. TCC/sandbox revocation is NOT VERIFIED. |
| Native macOS testing | PASS | `pnpm test:desktop`, full desktop media scenario, disk-full image |
| Long-session resource behavior | NOT VERIFIED | Bounded 20-cycle soak is flat for RSS, descriptors, and cache, but it is a short IPC harness run, not a long session in the real app |
| Startup and reopen | PASS | Native restarts restore canvas state and missing media |
| External FFmpeg dependency | PASS (as external) | FFmpeg 9.0.2 was installed and exercised. The app needs a separate install. |
| Installer distribution | NOT VERIFIED | No signed or notarized installer, no bundled FFmpeg, no cross-platform package |

**Internal macOS beta: GO, controlled.** All critical release rows are PASS, the native lifecycle suite passes, the real disk-full test passes, and no regression row is FAIL. Tell testers about the FFmpeg prerequisite and the limitations above, and ask them to keep backups of important canvases. This decision does not upgrade any NOT VERIFIED row to PASS.

## 8. Public-release blockers

- A signed and notarized installer, with Gatekeeper behavior verified.
- A decision on FFmpeg provisioning (bundled or managed), qualified together with licensing.
- A multi-hour native soak with WebContent and GPU memory, descriptor, and cache measurements.
- A native click-through of the recovery export, and TCC/sandbox permission revocation during a write.
- Calibrated performance baselines, and the two restored canvas-frame metrics.
- Any cross-platform claim requires Windows and Linux qualification. None exists.

## 9. Recommended next engineering priorities

1. **Real-app native soak:** run repeated import, play, save, close, and reopen in the Tauri app for at least an hour. Sample host, WebContent, and GPU RSS, `lsof` descriptor counts, cache size, and decoder PIDs.
2. **Native recovery export:** add a test-only dialog override to the desktop harness so WebDriver can click **Export original data** and the exported bytes can be compared.
3. **Run `disk-full.ts` in CI:** a scheduled job on a macOS runner, plus a variant that fills the volume during a save through the app's IPC.
4. **Performance baselines:** calibrate the three UNCALIBRATED metrics and restore the canvas-frame samples.
5. **Distribution:** set up the signing and notarization pipeline, then decide on FFmpeg provisioning.

## Files changed in this pass

| File | Change |
| --- | --- |
| `src-tauri/src/canvas_persistence.rs` | Injectable directory sync; unsupported sync treated as best effort; clearer message for post-rename failures; tests for directory sync, permission revocation, and opt-in disk-full |
| `src-tauri/tests/media_ipc.rs` | Open-descriptor sample in every soak cycle |
| `scripts/media/run-media-suite.ts` | `soak.native-fd-retention` gate and `soak.native_open_fds` metric |
| `scripts/fs-faults/disk-full.ts` (new) | Disposable full-volume harness for macOS |
| `tsconfig.scripts.json` | Type-checks `scripts/fs-faults` |
| `src/utils/fs.ts`, `src/utils/fs.test.ts` | Explicit message for an unsupported format version, with a regression test |
| `e2e/canvas-save.spec.ts` | Future-format refusal: canvas kept, file never written |

The earlier Phase 4C changes (recovery export, schema validation, read-only guard, release gate) remain in place and were not modified in this pass, apart from additions listed above.
