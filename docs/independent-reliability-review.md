# Sigma Canvas — Independent Pre-Merge Reliability Review (Phase 4D)

**Date:** 2026-11-11 (America/Los_Angeles)  
**Reviewer stance:** Adversarial review. Prior reports were treated as claims to check, not as evidence.  
**Result:** No P0 or P1 defect was found. There are four P2 findings and seven P3 findings. No application code was changed in this phase. P2-1 (a release-gate script defect) was fixed after the review at the user's request. The other additions are review harnesses and one opt-in hook in the test runner.  
**Conclusion:** **GO** for committing `impl-8` as the foundation of the internal macOS beta. This is conditional on the commit boundaries in section 11 and on triaging the P2 findings before the next release gate is relied on (section 12).

**Phase 4E status update (2026-11-11):** P2-2, P2-3, and P2-4 are **FIXED** with native and automated regression evidence in [the 4E hardening report](reliability-hardening-4e.md). The findings and section 12 below record the 4D review as it stood then. The current full gate exits 1 on `perf.persist-serialize@250`, so the current internal-beta qualification decision is **NO-GO** pending that performance-gate decision. P2-1 remains **FIXED**.

## Evidence labels

| Label | Meaning in this document |
| --- | --- |
| **VERIFIED** | Executed in this review, or traced in source code to a conclusion that does not depend on assumptions. |
| **DOCUMENTED** | Stated in a prior report and not re-executed here. |
| **INFERRED** | Follows from reading the code. No test exercised it. |
| **NOT VERIFIED** | No evidence exists in this review or in prior reports. |

---

## 1. Reviewed revision and working-tree inventory

- **HEAD:** `84e6c376180df98e758016a86c5c102d3aafb474` ("fix: crash on macOS pending save") on `impl-8`. VERIFIED.
- **Git operations:** none. No reset, stash, branch switch, commit, or push.
- **Ignored output:** `artifacts/` and `desktop-test-results/` are ignored by `.gitignore` and were preserved.

**Where each phase lives (VERIFIED from `git show --stat` and `git status`):**

| Phase | Location | Contents |
| --- | --- | --- |
| 3 / 4A: lifecycle, recovery protection, save ordering, import ownership, directory fsync | Committed in `84e6c37` | `lifecycle.rs`, `applicationLifecycle.ts`, `sessionStorage.ts` (protection), store queue, `drag.ts`, `canvas_persistence.rs` (directory sync), `desktop-tests/lifecycle.mjs`, `docs/lifecycle-hardening.md`. This commit also contains `tsconfig.node.tsbuildinfo` (finding P3-4). |
| 4B: media qualification and gates | Committed in `ea46b62` and `30bd991` | Media suite, corpus gates, desktop media scenario |
| 4C: recovery export, schema validation, read-only guard, release gate, directory-sync tolerance, disk-full harness, descriptor soak gate | **Uncommitted** | `e2e/canvas-save.spec.ts`, `scripts/media/run-media-suite.ts`, `src-tauri/src/canvas_persistence.rs`, `src-tauri/tests/media_ipc.rs`, `src/lib/media-corpus/gates.ts`, `src/lib/media-corpus/mediaCorpus.test.ts`, `src/lib/sessionStorage{,.test}.ts`, `src/utils/fs{,.test}.ts`, `tsconfig.scripts.json`, `scripts/fs-faults/disk-full.ts`, `docs/beta-release-readiness.md` |
| 4D (this review) | Uncommitted | `desktop-tests/endurance.ts`, `desktop-tests/disk-faults.ts`, an opt-in `SIGMA_DESKTOP_ENDURANCE` hook in `scripts/run-desktop-tests.mjs`, this document |
| Not engineering work | Untracked | `docs/SIGMA_ENGINEERING_EVIDENCE.md`, a research dossier. Left untouched. |

**Missing inputs:** `docs/desktop-media-qualification.md` and `docs/native-media-safety.md` do not exist. No claims in this review are sourced from them.

---

## 2. Findings ranked by severity

No P0 or P1 defect was found. A P0/P1 here means silent loss or corruption of a recoverable document, or a release gate that can certify a failed build in a reachable case.

### P2-1 · The release gate ignores the native desktop runner's exit code — **FIXED** (section 9)

- **Root cause:** In `scripts/media/run-media-suite.ts`, the `native desktop media scenario` step runs `pnpm test:desktop` and then reads only `desktop-media-report.json`. It never inspects `result.code` or `result.timedOut`. `report.error` is only appended to `limitations`, and the step then returns `true`. That `true` sets `desktop.media` (a critical row) to PASS.
- **Asymmetry:** The browser step does reject non-zero exits, through `browserRunFailure` in `src/lib/media-corpus/gates.ts:168`.
- **Practical reach (VERIFIED in source):** Today, a crash in the middle of the scenario still leaves the stage sub-gates FAIL, because `report.shutdown` or `report.nativeDecode` is missing and the gates mark them "not exercised". `desktop-tests/media-corpus.ts` writes its report in `finally`, and `run-desktop-tests.mjs` only runs it after smoke and lifecycle pass. A false PASS therefore needs one of three things:
  - an error after `report.shutdown` is populated;
  - a runner timeout after a complete report was written;
  - a future scenario stage whose gate tolerates absence.
- **Impact:** "Failed child processes cannot produce PASS" holds today only by accident of ordering. It is not enforced.
- **Reproduction:** Source trace (VERIFIED). A false-PASS run was not constructed (NOT VERIFIED).
- **Fix:** applied after review at the user's request; see section 9.

### P2-2 · The read-only guard uses mode bits, not writability — **FIXED in Phase 4E**

- **Root cause:** `replace_canvas_file_with` in `src-tauri/src/canvas_persistence.rs` refuses only when `Permissions::readonly()` is true. On Unix that means no write bit for *anyone* (`mode & 0o222 == 0`). Atomic replacement is a `rename`, which needs write permission on the *folder*, not on the file.
- **Effect:** A file the current user cannot write still gets replaced if its folder is writable. Examples are mode `0464`, or a file owned by another user with mode `0644` in a shared folder. After replacement, the file's owner becomes the saving user.
- **Reproduction (VERIFIED, POSIX):** A `0464` file in a scratch folder: `readonly()` is false and `access(W_OK)` is false, yet `rename` replaced it. The new contents were "replacement" with mode `0644`.
- **Impact:** Bypasses the intended protection. No silent loss of the user's own canvas.
- **Suggested fix:** Check `libc::access(path, W_OK)` (or equivalent) and refuse when it fails.

### P2-3 · Protected recovery data has no discard path — **FIXED in Phase 4E**

- **Root cause:** `src/lib/sessionStorage.ts`. Once hydration rejects the recovery value, `protectedData` disables `setItem` and `removeItem` for the session. Nothing ever removes or replaces the key afterwards.
- **Effect:** Every later launch shows "Canvas recovery failed" again. Automatic recovery stays disabled permanently. `flushSessionPersistence` then refuses to close any non-empty session that is dirty or has no save file (`assertWritable`), so the user must save to a file before every close.
- **Reproduction:** Source trace (VERIFIED). A two-launch native run was not done (NOT VERIFIED).
- **Impact:** No data loss: the bytes are preserved and exportable. This is a permanent degraded mode with no user exit.
- **Suggested fix:** After a successful export, offer "Discard original recovery data".

### P2-4 · Recovery hydration and file loading share one validator — **FIXED in Phase 4E**

- **Root cause:** Phase 4C made `isStoredCanvasConfig` (`src/utils/fs.ts`) stricter: optional metadata ranges, duplicate IDs, and `schemaVersion`. The same function gates recovery hydration in `sessionStorage.ts`. Any value the app itself writes that this validator rejects would turn a recoverable session into protected state (P2-3) at the next launch.
- **Current safety (INFERRED from every producer in `src`):**
  - Probe widths fall back when 0 (`CanvasActions.tsx:197,218`).
  - The native `frame_rate` is always > 0 (`lib.rs:131-150`).
  - Crop insets are clamped to ≥ 0 (`ImageActions.tsx:123-160`).
  - IDs come from `uuidv4()`.
  - The serializer omits empty preview paths.
- **Gap:** No test asserts that serializer output always passes the validator.
- **Impact:** Latent coupling. A future field or rounding change could lock users out of recovery.
- **Suggested fix:** A property test that round-trips `getCanvasConfigData` output and the `partialize` output through `isStoredCanvasConfig`.

### P3 findings (documented; no action taken)

| ID | Finding | Evidence |
| --- | --- | --- |
| P3-1 | If the 10 s shutdown deadline fires during native cleanup, `cancel` runs after `native_video_stop_all` has already stopped the decoders. The app stays open with decoders stopped. Whether the frontend manifest restarts them is unverified. (`lifecycle.rs`: the `request_shutdown` timer versus `complete_shutdown`.) | INFERRED |
| P3-2 | On macOS logout or restart, `applicationShouldTerminate:` returns `NSTerminateCancel`, not `NSTerminateLater`. A system logout is cancelled even when the save completes quickly, and the user has to log out again. | INFERRED |
| P3-3 | Report provenance records `{revision, dirty: true}` but no hash of the working-tree diff. A dirty-tree artifact cannot be tied to exact source. | VERIFIED (`results.json`) |
| P3-4 | `84e6c37` committed `tsconfig.node.tsbuildinfo`, a build artifact. `docs/lifecycle-hardening.md` says it was "left alone". | VERIFIED |
| P3-5 | Recovery export goes wherever the user points it. Choosing an existing canvas (macOS asks for confirmation first) replaces it with the raw recovery bytes. | INFERRED |
| P3-6 | If the folder's write permission is revoked after the temporary file is written and before the rename, the hidden `.sigma-canvas-*.tmp` cannot be unlinked and is leaked. It never replaces the destination. | VERIFIED (unit test) |
| P3-7 | A post-rename directory-sync `EIO` is reported as a failed save although the file already holds the complete new bytes. A volume that always returns `EIO` would block close until Save As elsewhere. | VERIFIED (unit), by design |

---

## 3. Cross-phase integration risks

1. **Validator coupling (4C × 4A):** see P2-4. This is the most consequential interaction found: a stricter load-time rule silently becomes a recovery-time lockout.
2. **Recovery protection × shutdown (4A × 3):** protected storage makes `assertWritable` throw. Shutdown then requires an explicit file save for any non-empty session that is dirty or has no save file. The behavior is correct. Combined with P2-3 it becomes permanent.
3. **Directory-sync tolerance × shutdown (4C × 3):** "unsupported" results no longer block shutdown. A genuine `EIO` still does, and that is intended.
4. **Read-only guard × recovery export (4C × 4C):** export uses `save_canvas_atomic`. It inherits the guard, and also its gap (P2-2).
5. **Release gate × desktop runner (4C × 4B):** the critical-row enforcement in `gates.ts` depends on the desktop step's own completeness checks. Before the P2-1 fix those checks were weaker than the browser step's. They are now equivalent.
6. **Native termination hook × system session events (3 × macOS):** see P3-2.
7. **Excessive coupling:** none beyond item 1. The hardening stays within `lifecycle.rs` and `canvas_persistence.rs` plus the store's queue. No public IPC command changed signature. VERIFIED: compared with the pre-hardening revision `88e1a60`, the `generate_handler!` list in `lib.rs` differs only by adding `lifecycle_ready` and `complete_shutdown`. Argument shapes of existing commands were not diffed individually.

**Areas reviewed with no defect found:**

| Area | What was checked | Status |
| --- | --- | --- |
| Save queue | FIFO order, the undo/pending-skip rule, `persistenceError` clearing, and dirty signatures are consistent (`useCanvasSessionStore.ts:326-425`) | VERIFIED |
| Drop-import ownership | Generation guard on both the success and failure paths (`drag.ts`). Drop is the only production caller of `onDropMedia`. | VERIFIED |
| Media scope | Tauri 2.11.6 `Scope::is_allowed` canonicalizes and resolves symlinks before matching (`tauri/src/scope/fs.rs:419`). A time-of-check/time-of-use window remains between the check and FFmpeg opening the path (already noted in the dossier). | VERIFIED |
| Shutdown state machine | Coalescing, stale IDs, and late acknowledgments | VERIFIED (unit tests and native runs) |

---

## 4. Reproduction evidence

| Claim | How it was reproduced |
| --- | --- |
| P2-1 | Desktop step (`run-media-suite.ts`, "native desktop media scenario" through `return true`) compared with `browserRunFailure` (`gates.ts:168`) |
| P2-2 | Python `-I` scratch demo: file mode `0464`; `mode & 0o222 == 0` is `False`; `access(W_OK)` is `False`; `rename` succeeded with result `0o644` |
| P2-3 | `sessionStorage.ts`: no code path removes the key while `protectedData` is set; `useCanvasSessionStore.ts:41-53` calls `assertWritable` |
| P2-4 | Every producer of `frameRate`, `sourceWidth`/`Height`, `crop`, and `id` (grep plus reading `CanvasActions.tsx`, `ImageActions.tsx`, `lib.rs`) |
| Real disk full (native) | `desktop-tests/disk-faults.ts`; `scripts/fs-faults/disk-full.ts` |
| Long session (native) | `desktop-tests/endurance.ts` |

---

## 5. Test results and exact commands

**Environment:** Node 26.13.0 and pnpm 10.32.1, macOS 27.2 on Apple M5, rustc 1.96.1, FFmpeg 9.0.2. Commands ran one at a time.

| Command | Layer | Result |
| --- | --- | --- |
| `pnpm test` | Automated, mocked IPC | PASS: 204/204, 26 files |
| `pnpm test:e2e` | Chromium, mocked IPC | PASS: 31 passed, 7 skipped |
| `pnpm lint:apply`, `pnpm lint` | Static | PASS. Biome formatted only the two new review harness files. |
| `pnpm exec tsc --noEmit`; `pnpm exec tsc -p tsconfig.scripts.json --noEmit` | Static | PASS |
| `cargo test --manifest-path src-tauri/Cargo.toml --all-targets --all-features` | Rust; real FFmpeg; mock Tauri runtime | PASS: 39 unit tests plus 1 ignored (opt-in disk-full); IPC tests and Criterion smoke checks pass |
| `cargo clippy … -- -D warnings`; `cargo fmt … -- --check` | Static | PASS |
| `node scripts/fs-faults/disk-full.ts` | **Native**, real full HFS+ volume | PASS |
| `pnpm test:desktop` | **Native**: Tauri, WKWebView, FFmpeg | PASS (exit 0), re-run after the runner hook was added |
| `SIGMA_ENDURANCE_SESSIONS=6 SIGMA_ENDURANCE_CYCLES=50 node desktop-tests/endurance.ts` | **Native** | PASS: 300 cycles, 0 failures |
| `node desktop-tests/disk-faults.ts` | **Native**, real full volume | PASS: 11/11 |
| `node scripts/media/run-media-suite.ts --tier full --ops 1200 --cycles 5` | **Native** plus automated | DOCUMENTED (run earlier today in Phase 4C); audited in section 8 |

**Notes on these runs:**

- The endurance and disk-fault scenarios ran directly against the debug WebDriver build produced by the preceding `pnpm test:desktop`. App source did not change between that build and the runs.
- The new `SIGMA_DESKTOP_ENDURANCE` hook in the runner was not itself exercised end to end (NOT VERIFIED).

---

## 6. Long-session resource observations

**Scenario:** `desktop-tests/endurance.ts`. Report: `artifacts/endurance/2026-11-11-native-endurance.json`.

- **Scale:** 6 app sessions × 50 cycles, run for **16 min 13 s**.
- **Media:** three generated H.264 clips (320×240, 640×360, 1280×720) and one PNG, all in disposable temp folders.
- **Each cycle:**
  1. Clear the canvas.
  2. Real drop-import of 4 files.
  3. Thumbnails for 3 clips (cold every 3rd cycle).
  4. Start native decoders, wait for an `SVF1` frame, stop all, verify decoder PIDs exit, restart with a different set.
  5. WKWebView playback of 2 clips to at least 0.2 s.
  6. Save through the production queue, wait for clean state, and check the bytes on disk.
  7. Reopen from disk.
  8. Hide and unhide the app via `NSRunningApplication` (`visibilityState` went from `hidden` to `visible`).
  9. Stop all and remove the videos.
- **Each session** ends with a graceful window close and a relaunch.

| Measure | Observation | Status |
| --- | --- | --- |
| Failures and timeouts | 0 of 300 cycles; 0 playback or frame timeouts | VERIFIED |
| Graceful close | 6/6 exit code 0; 0 orphan decoder PIDs after close; 0 decoder PIDs at any cycle end | VERIFIED |
| Session restore | 6/6 relaunches restored 4 items from recovery storage | VERIFIED |
| Host descriptors (`lsof`) | 73–74 for all 300 cycles | VERIFIED |
| Thumbnail cache | 23,515 bytes after every cycle | VERIFIED |
| Host RSS | 105–152 MiB. Mean per 50-cycle block: 134.6, 121.3, 135.8, 135.1, 133.6, 134.3 MiB. Within-session slope over cycles 10–49 was +8.7 to +13.6 KiB/cycle in 4 of 6 sessions (about 0.5 MiB per session). The other two were flat or negative. | VERIFIED measurement; trend **inconclusive** |
| WebContent RSS | 118–286 MiB, oscillating. Block means 233.6, 180.5, 222.8, 215.1, 212.8, 206.0 MiB. Slope over the whole run is −51 KiB/cycle. | Measured; ownership INFERRED |
| GPU helper RSS | 38–53 MiB. About +45 KiB/cycle in 4 of 6 sessions; it resets on relaunch. | Measured; ownership INFERRED |

**Interpretation:**

- Descriptors, decoder processes, and the cache show no growth.
- Host and GPU memory show a small within-session upward drift. The run is too short to separate allocator or WebKit warm-up from sustained growth. It only bounds growth at roughly ≤ 14 KiB/cycle (host) over 50 cycles.
- **This is not evidence of leak-free operation.**
- WebKit helper processes are XPC services owned by launchd. They were attributed to the app by appearing after launch, so their figures may include unrelated WebKit processes.

**Not covered:**

- Sessions longer than 16 minutes.
- Large or 4K media in the endurance loop.
- GPU memory as reported by the GPU itself (only helper-process RSS was sampled).
- Window minimize and reopen, as distinct from hide and unhide. Reopen-after-close is covered by relaunch.

---

## 7. Disk-failure test results

| Condition | Method | Result | Real or simulated |
| --- | --- | --- | --- |
| Disk full during save (end to end in the app) | `disk-faults.ts`: 4 MiB HFS+ image mounted as the app's fixture folder, filled to `ENOSPC` | Original bytes identical. The UI showed "Save failed: Cannot create temporary canvas file: No space left on device (os error 28)". `isDirty` stayed true. No temp file left. The recovery copy in `localStorage` holds the unsaved edit. | **Real** exhaustion of a disposable volume |
| Disk full during write (Rust) | `disk-full.ts`, 8 MiB write | Refused; original intact; temp removed; later small save succeeds | **Real** |
| Retry after failure | Free space, edit to a newer `x`, save | Committed the newest state (`x=300`), clean. An older snapshot never overwrote it. | Real |
| Read-only folder (temp creation fails) | `chmod 0555` on the mounted folder during the app session | Original intact, session dirty; after restoring permissions, retry committed `x=500` | Real permission change |
| Close after a failed save | `plugin:window\|close` while the last save had failed | App stayed open with the session dirty. That the close request reached the coordinator was not independently observed here; it is DOCUMENTED by the `lifecycle.mjs` denied-save case. | Partial |
| Close once saved | WebDriver window close | Exit code 0 | Real |
| Existing read-only file | Rust unit test | Refused; bytes and folder entries unchanged. Gap: P2-2. | Simulated (permission bits) |
| Permission revoked before rename | Rust unit test | Rename fails; original intact; hidden temp leaked (P3-6) | Simulated |
| Failed rename | Covered by the revocation test above | Original intact | Simulated |
| Failed fsync of the temp file | Not injected | NOT VERIFIED | — |
| Failed directory sync | Rust unit test: `EIO` reported with complete new bytes; `EINVAL`/`ENOTSUP`/`Unsupported` tolerated | Pass | Injected |
| Process killed before rename | `lifecycle.mjs` real SIGKILL | Previous committed file retained | DOCUMENTED; the suite re-ran natively in this review |
| Power loss | — | NOT VERIFIED | — |
| macOS TCC or sandbox revocation | — | NOT VERIFIED | — |

The real user disk was never filled. Every mount was detached, and none remained afterwards (VERIFIED with `mount`).

---

## 8. Release-gate correctness

Audited artifact: `artifacts/benchmarks/2026-11-12T03-36-31-155Z-full` (51 PASS · 0 FAIL · 2 NOT_RUN · 3 UNCALIBRATED).

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| A critical NOT_RUN blocks release | **Holds** | `blockingFailures(gates, full=true)` in `gates.ts` treats any non-PASS critical row as blocking. The runner inserts NOT_RUN rows for absent critical IDs. Unit test in `mediaCorpus.test.ts`. VERIFIED. |
| A failed child process cannot produce PASS | **Holds (after the P2-1 fix)** | Both steps now reject a non-zero exit, a timeout, or a scenario error. Proven natively with a forced non-zero exit after a complete report (section 9). |
| A missing report cannot produce PASS | **Holds** | A missing desktop report throws and makes `desktop.media` FAIL. A missing Playwright JSON fails `browserRunFailure`. VERIFIED in source. |
| Uncalibrated performance is not certified | **Holds** | `perf.metadata-throughput`, `perf.peak-memory`, and `perf.retained-memory` are shown as UNCALIBRATED ("metric absent from baseline"). They are non-blocking and are not reported as PASS. The two `perf.canvas-frame@*` rows are NOT_RUN and non-critical. **The gate certifies no performance level.** |
| Artifacts identify revision and runtime | **Partially** | Revision, dirty flag, OS, CPU, memory, Node, FFmpeg, and rustc are recorded. There is no diff hash for a dirty tree (P3-3). |
| The native scenarios actually ran | **Holds** | All 7 steps passed (the native desktop step took 119 s). `desktop-media-report.json` has no `error`. Contents: 25 IPC probes, 18 imported items, 16 playbacks, 4 decoders requested with 1 active, and shutdown with exit 0 and 0 surviving decoders. `desktop.log` shows 10 real app launches. VERIFIED. |

**The gate covers an internal macOS beta only.** It does not cover signing, notarization, installer behavior, bundled FFmpeg, other platforms, or performance budgets. Those are required for a public release.

---

## 9. Confirmed fixes

During the review itself, no P0 or P1 defect was confirmed, so no fix was made. After the review, the user asked for **P2-1** to be fixed:

- **Change:** a new pure helper, `desktopRunFailure(result, report)` in `src/lib/media-corpus/gates.ts`, mirrors `browserRunFailure`. It rejects a timeout, a non-zero exit, a missing report, or `report.error`. In `scripts/media/run-media-suite.ts`, the desktop step still emits its sub-gates for diagnosis, then throws if the helper reports a failure. The critical `desktop.media` row therefore becomes FAIL.
- **Regression test:** `mediaCorpus.test.ts`, "rejects a desktop run that failed after writing a complete report". Vitest is now 205/205.
- **Healthy native run:** `node scripts/media/run-media-suite.ts --tier full --ops 1200 --cycles 5` gave exit 0 and 51 PASS · 0 FAIL · 2 NOT_RUN · 3 UNCALIBRATED (`artifacts/benchmarks/2026-11-12T04-15-13-492Z-full`).
- **Negative native run:** the same command, with a `pnpm` shim that runs the real `pnpm test:desktop` and then exits 1, gave **exit 1** (`artifacts/benchmarks/2026-11-12T04-18-43-491Z-full`).
  - The report was complete: no `error`, and `shutdown` was recorded.
  - `desktop.shutdown-under-load` and `desktop.decoder-throttling` were PASS.
  - `desktop.media` was **FAIL**, with the step note "pnpm test:desktop exited with code 1".
  - Before the fix this path returned `true` unconditionally, so it would have been PASS. That is INFERRED from the previous code; the old code was not re-run.

The other changes made in this phase are review tooling only:

- `desktop-tests/endurance.ts`: the native endurance scenario.
- `desktop-tests/disk-faults.ts`: the native disk-fault scenario.
- An opt-in `SIGMA_DESKTOP_ENDURANCE` hook in `scripts/run-desktop-tests.mjs`. It is inert unless the variable is set; `pnpm test:desktop` was re-run and passed.

---

## 10. Outstanding issues and verification gaps

1. **Triage:** P2-2 through P2-4 (section 2). P2-1 is fixed.
2. **Native runs not yet done:** a recovery export click-through and a second launch with protected recovery data (P2-3) in the real app. NOT VERIFIED.
3. **Failure modes not covered:** power loss, TCC/sandbox revocation, network volumes, and injected fsync failure of the temporary file. NOT VERIFIED.
4. **Soak length:** a multi-hour soak with large media and GPU-reported memory. The current run was 16 minutes (section 6).
5. **Logout timing:** termination during a macOS logout (P3-2). NOT VERIFIED.
6. **Distribution:** signing, notarization, FFmpeg provisioning, and cross-platform builds. NOT VERIFIED.
7. **Runner hook:** `SIGMA_DESKTOP_ENDURANCE` has not been run through `pnpm test:desktop`. NOT VERIFIED.

---

## 11. Recommended commit boundaries

Each commit is buildable and tests pass after each one, in the order below. `e2e/canvas-save.spec.ts` spans commits 1 and 2: stage its hunks separately, or include it in commit 1.

1. **`feat(recovery): export protected recovery data and validate canvas schema`**
   - `src/lib/sessionStorage.ts`, `src/lib/sessionStorage.test.ts`
   - `src/utils/fs.ts`, `src/utils/fs.test.ts`
   - `e2e/canvas-save.spec.ts`
2. **`fix(persistence): refuse read-only targets; tolerate unsupported directory fsync`**
   - `src-tauri/src/canvas_persistence.rs`
   - `scripts/fs-faults/disk-full.ts`
   - the `scripts/fs-faults` include in `tsconfig.scripts.json`
3. **`fix(gates): block full release on critical NOT_RUN or a failed desktop runner; add descriptor soak gate`**
   - `src/lib/media-corpus/gates.ts`, `src/lib/media-corpus/mediaCorpus.test.ts`
   - `scripts/media/run-media-suite.ts`
   - `src-tauri/tests/media_ipc.rs`
4. **`test(desktop): native endurance and disk-fault scenarios`**
   - `desktop-tests/endurance.ts`, `desktop-tests/disk-faults.ts`
   - `scripts/run-desktop-tests.mjs`
5. **`docs: beta readiness and independent reliability review`**
   - `docs/beta-release-readiness.md`, `docs/independent-reliability-review.md`
   - Leave `docs/SIGMA_ENGINEERING_EVIDENCE.md` out unless its author intends to publish it.
6. **Separately:** remove the committed `tsconfig.node.tsbuildinfo` and ignore it (P3-4).

---

## 12. Independent internal-beta GO/NO-GO

**GO for committing `impl-8` as the internal macOS beta foundation.**

**Reasons for GO:**

- No P0 or P1 defect was found.
- Real native runs confirm safe behavior in the scenarios that matter most for testers' data:
  - real disk exhaustion inside the app;
  - read-only folder, retry, and close;
  - 300 cycles of import, playback, decode, save, and reopen;
  - six graceful shutdowns.
- The critical rows of the release gate are genuinely enforced, including a failed desktop runner (P2-1 fixed and proven natively).

**Conditions:**

- Commit along the boundaries in section 11.
- Tell beta testers about P2-3. If "Canvas recovery failed" appears, they should export the data and then save to a file before closing, every time.

**Public or signed release: NO-GO.** Distribution is unqualified, durability is not established, and there is no long-duration evidence.

**Answer to the completion question:** *Is the accumulated `impl-8` implementation safe, coherent, and sufficiently verified to be committed as the foundation for Sigma Canvas's internal macOS beta?*

**Yes, with conditions.** It is **safe**: no path that loses or corrupts user data was found, and real fault injection preserved the original bytes in every tested case. It is **coherent**: the phases compose without API breaks, and the one risky coupling (P2-4) is currently compatible. It is **sufficiently verified for an internal beta, not beyond it**: the evidence is real but bounded (16 minutes of native endurance, simulated permission faults, no power-loss test). The release-gate exit-code gap (P2-1) is now fixed. Track the three remaining P2 findings for the next hardening pass.
