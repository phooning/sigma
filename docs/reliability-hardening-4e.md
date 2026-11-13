# Sigma Canvas — Phase 4E reliability hardening

**Assessment date:** 2026-11-11, America/Los_Angeles  
**Branch:** `impl-8`, HEAD `84e6c376180df98e758016a86c5c102d3aafb474`  
**Decision:** The three remaining P2 defects are **FIXED** and ready for code review. The branch is **NO-GO for internal beta qualification under the current release gate** because its final full run exits 1 on `perf.persist-serialize@250`. Public or signed distribution remains unqualified. No commit, push, reset, stash, rebase, or branch switch was made.

## Scope and starting state

The working tree was already dirty at the start of this phase. It contained uncommitted 4C recovery, schema, persistence, gate, and disk-full work; 4D review and desktop harness work; and the untracked `docs/SIGMA_ENGINEERING_EVIDENCE.md`. All were preserved. The existing P2-1 release-gate exit-code fix was inspected and retained. This phase changed no renderer architecture or packaging.

At entry, the modified paths were `e2e/canvas-save.spec.ts`, `scripts/media/run-media-suite.ts`, `scripts/run-desktop-tests.mjs`, `src-tauri/src/canvas_persistence.rs`, `src-tauri/tests/media_ipc.rs`, `src/lib/media-corpus/gates.ts`, `src/lib/media-corpus/mediaCorpus.test.ts`, `src/lib/sessionStorage.test.ts`, `src/lib/sessionStorage.ts`, `src/utils/fs.test.ts`, `src/utils/fs.ts`, and `tsconfig.scripts.json`. The untracked paths were `desktop-tests/disk-faults.ts`, `desktop-tests/endurance.ts`, `docs/SIGMA_ENGINEERING_EVIDENCE.md`, `docs/beta-release-readiness.md`, `docs/independent-reliability-review.md`, and `scripts/fs-faults/`.

The requested `docs/independent-reliability-review.md`, `docs/beta-release-readiness.md`, `docs/lifecycle-hardening.md`, and `docs/SIGMA_ENGINEERING_EVIDENCE.md` existed and were read. The earlier `docs/desktop-media-qualification.md` and `docs/native-media-safety.md` cited by the 4C task still do not exist; their evidence was not invented.

## Root causes and changes

| Finding | Before | After and evidence |
| --- | --- | --- |
| **P2-2 — effective writability** | `Permissions::readonly()` only noticed an existing file when *all* write bits were absent. A `0464` file could be replaced by rename from a writable parent even though this process could not write it. | On Unix, save opens an existing regular destination with `O_WRONLY`, `O_NOFOLLOW`, and `O_CLOEXEC`, without truncating it. The open checks effective credentials, including filesystem ACL decisions. The file identity and permission metadata are checked again before rename. Tests reject mode `0464` and `0444`, preserve the original bytes, accept `0644`, and reject creation in a `0555` parent. Atomic temporary-file replacement and the existing dirty-state retry path remain. |
| **P2-3 — protected recovery lifecycle** | Invalid local recovery bytes were preserved but put every later launch in protected mode with no user exit. A raw export could replace a chosen project. | The warning offers **Export original data**. Export uses the native atomic writer in **create-only** mode, so an existing path cannot be replaced, even after a picker confirmation or a concurrent path appearance. The persistent success notice says the raw backup may not be a valid Sigma project and offers **Discard original data**. Discard requires a successful export in the current launch and verifies that the local bytes have not changed. It removes them only on the user's click, then saves the current session snapshot. Cancellation, failed export, restart before discard, and failed new snapshot are handled explicitly. Browser and real Tauri/WKWebView two-launch tests pass. |
| **P2-4 — serializer/validator contract** | The same increasingly strict validator protected file load and recovery hydration, but no regression contract proved the application could write values it would later accept. JSON serialization could turn non-finite numbers into `null`. | Save validates the in-memory document before serialization and refuses invalid values before native IPC. Validation covers core geometry, duplicate IDs, schema version, crop, optional media numbers and paths, LOD metadata, viewport, settings, and development mode. Deterministic generated image/video states round-trip through the serializer and validator; the actual Zustand `partialize` result rehydrates. Tests cover missing optional fields, legacy unversioned files, future versions, `NaN`, Infinity, and null. The validator now avoids temporary per-item arrays and scans duplicate IDs in the same pass as item validation. |

The native desktop smoke test also had a qualification-only defect: WebDriver reported a Settings dialog as hidden even when its DOM state was `open`, its content was present, and the Tauri bridge was available. The assertion now waits for that observable open state and content. This does not change application behavior.

## New and extended regression coverage

- `src/lib/sessionStorage.test.ts`: exact-byte export, protected original, create-only invoke, cancellation, native export failure, explicit discard, normal persistence afterward, restart requiring a new export, invalid snapshot refusal, and a failed post-discard snapshot message.
- `src/utils/fs.test.ts`: 80 deterministic image/video project states, optional metadata, non-finite/null rejection before invoke, legacy compatibility, and future-version refusal.
- `src/stores/useCanvasSessionStore.test.ts`: validates and rehydrates the real Zustand partialized state.
- `src-tauri/src/canvas_persistence.rs` tests: effective file writability, ordinary writes, restricted parent, create-only no-clobber, and original-byte integrity.
- `src-tauri/tests/canvas_persistence.rs`: IPC coverage for existing and fresh create-only destinations.
- `e2e/canvas-save.spec.ts`: visible export/discard flow and clean reload; existing export check now asserts `createOnly: true`.
- `desktop-tests/lifecycle.mjs`: one launch seeds and protects corrupt recovery, uses real native IPC to export exact bytes, clicks the visible discard action, verifies a valid replacement snapshot, then launches again without the warning. The test supplies a pre-granted disposable path to bypass OS picker selection; browser coverage exercises the export action with a mocked picker.
- `desktop-tests/smoke.spec.js`: stable native Settings-open assertion, following two full-gate failures caused by the WebDriver visibility result.

## Verification and artifacts

Commands ran with Node **26.13.0** on macOS/Apple M5; `PATH` included `/Users/david/.local/share/nvm/v26.13.0/bin`. Native test commands used `caffeinate -dimsu` for the long run. Outputs are from this phase, not inherited report claims.

| Command | Outcome |
| --- | --- |
| `pnpm test` | **PASS:** 212 tests, 26 files (final code). |
| `pnpm exec tsc --noEmit` and `pnpm exec tsc -p tsconfig.scripts.json --noEmit` | **PASS** (final code). |
| `pnpm lint:apply` and `pnpm lint` | **PASS** (final code; Biome). |
| `pnpm test:e2e` | **PASS:** 32 Chromium tests, 7 optional tests skipped. An initial restricted invocation could not bind `127.0.0.1:1420` (`EPERM`); rerunning with local port access passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml --all-targets --all-features` | **PASS:** 41 Rust unit tests, 1 ignored opt-in disk-full test, IPC integration tests, and Criterion smoke targets. |
| `cargo test --manifest-path src-tauri/Cargo.toml canvas_persistence --all-features` | **PASS:** five persistence cases; opt-in disk-full case ignored. |
| `cargo test --manifest-path src-tauri/Cargo.toml --test canvas_persistence --all-features` | **PASS:** native IPC persistence integration. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | **PASS**. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | **PASS**; stable rustfmt emitted its existing `trailing_comma` warning. |
| `caffeinate -dimsu pnpm test:desktop` | **PASS:** real macOS Tauri/WKWebView/FFmpeg smoke, lifecycle, protected recovery export/discard/relaunch, and desktop media scenarios. |
| `git diff --check` | **PASS**. |

**Full gate:** `caffeinate -dimsu node scripts/media/run-media-suite.ts --tier full --ops 1200 --cycles 5` exited **1**. The [final summary](../artifacts/benchmarks/2026-11-12T04-58-06-576Z-full/summary.md), [results](../artifacts/benchmarks/2026-11-12T04-58-06-576Z-full/results.json), and [desktop log](../artifacts/benchmarks/2026-11-12T04-58-06-576Z-full/desktop.log) record **50 PASS, 1 FAIL, 2 NOT_RUN, 3 UNCALIBRATED**. All six critical release rows are **PASS**, including `desktop.media` and `desktop.shutdown-under-load`; the gate correctly fails overall on the noncritical performance row `perf.persist-serialize@250` (p50 **0.35 ms** versus a **0.24 ms** baseline and **0.30 ms** allowed limit, marked noisy). The two `NOT_RUN` canvas-frame measurements are optional performance rows in this configuration. Corpus SHA-256 was unchanged for all 16 assets. The desktop log records the protected recovery export, explicit discard, clean relaunch, zero surviving decoders, and normal shutdown.

Earlier full attempts are retained as failure evidence: [first attempt](../artifacts/benchmarks/2026-11-12T04-43-30-929Z-full/summary.md) and [second attempt](../artifacts/benchmarks/2026-11-12T04-48-38-416Z-full/summary.md). Both were blocked by the native smoke visibility assertion; the second also had a noisy serialization budget failure. The final run proves the corrected smoke assertion and P2-1 gate behavior: a failing native runner cannot yield `desktop.media` PASS, while a completed native runner does. The earlier P2-1 forced-exit negative run remains at [its report](../artifacts/benchmarks/2026-11-12T04-18-43-491Z-full/summary.md).

The final full run measured the Tauri host RSS at **131 MiB** on launch and **119 MiB** after cleanup; WebContent/GPU helpers were outside that measurement. The inherited 20-cycle native IPC soak recorded 10 descriptors each cycle and flat late-cycle RSS, as documented in [beta readiness](beta-release-readiness.md). These are bounded measurements, not an hours-long leak claim.

## Remaining P3 findings and limitations

P3-1 (decoder state after a shutdown timeout), P3-2 (macOS logout semantics), P3-3 (dirty-tree artifact lacks a diff hash), P3-4 (tracked TypeScript build artifact), P3-6 (temporary-file cleanup after folder permission revocation), and P3-7 (post-rename directory-sync error appears as a save failure) remain open. P3-5's overwrite mechanism is closed by the atomic create-only raw export. The original review's historical observations remain in that document.

The overwrite policy for an existing canvas is: replace only a regular, nonsymlink file that the effective process can open for writing, with a writable parent for the temporary file and rename. Existing target mode is preserved. The policy delegates ACL enforcement to the operating system's open operation. ACL-specific and foreign-owner fixtures were not exercised; Unix owner/inode/mode are checked before rename, but another process can still race between the last check and rename. Atomic replacement changes inode and can change owner. The raw export's hard-link no-clobber step may fail safely on filesystems without hard-link support. Real TCC/sandbox revocation mid-write, power loss, network volumes, long native sessions, signed/notarized installers, FFmpeg bundling, and cross-platform behavior remain unverified. FFmpeg/ffprobe must be installed separately for the current internal macOS build.

## Exact files changed in Phase 4E

Application and native persistence: `src/lib/sessionStorage.ts`, `src/stores/useCanvasSessionStore.ts`, `src/utils/fs.ts`, `src/utils/notifications.ts`, `src-tauri/src/canvas_persistence.rs`.

Regression and native harness: `src/lib/sessionStorage.test.ts`, `src/stores/useCanvasSessionStore.test.ts`, `src/utils/fs.test.ts`, `src-tauri/tests/canvas_persistence.rs`, `e2e/canvas-save.spec.ts`, `src/test/desktopBridge.ts`, `desktop-tests/lifecycle.mjs`, `desktop-tests/smoke.spec.js`.

Documentation: this report and `docs/independent-reliability-review.md` (P2 status addendum). Several listed paths already had 4C or 4D uncommitted changes; this list names files touched in 4E, not ownership of their entire diffs. Other dirty files and the dossier were left intact.

## Suggested commit boundaries and next decision

Review and stage the inherited 4C and 4D hunks along the boundaries in section 11 of `docs/independent-reliability-review.md`. Then stage 4E in three reviewable groups: (1) recovery UI, no-clobber export, store callback, browser/native recovery tests; (2) effective-writability native writer and IPC tests; (3) serializer/validator contract and generated-state tests. The smoke assertion and this evidence report can be a final qualification group. Shared 4C/4E files require hunk-level staging. No commits were made.

**Structured commit review:** READY to review these groups; keep the release qualification failure attached to the review. **Internal macOS beta:** NO-GO under the existing gate policy while `perf.persist-serialize@250` is FAIL. The next engineering priority is a controlled serialization benchmark on the intended hardware, followed by either an implementation improvement or an explicit, evidence-backed budget decision. Then rerun the full gate once. After that, address P3-1/P3-2 and strengthen permission/ACL and power-failure coverage. **Public release:** NO-GO until distribution, signing/notarization, FFmpeg provisioning/licensing, and longer native endurance are qualified.
