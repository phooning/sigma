# Lifecycle and persistence hardening — 2026-11-11

## Scope and starting state

Inspected `impl-8` at `88e1a60`: React/Zustand session hydration and mutations, the shared save/load queue, JSON serialization and validation, Tauri startup/close/exit handling, atomic replacement, drop imports, preview requests, native video control, and the desktop harness. Existing Phase 2 protections and process-aware restart tests were present. The historical “49 checks” and media latency figures were not treated as current evidence.

The initial tree contained the untracked `tsconfig.node.tsbuildinfo`; it was left alone. Another untracked research file, `docs/SIGMA_ENGINEERING_EVIDENCE.md`, appeared during the task and was also left untouched. All implementation changes remain uncommitted on `impl-8`. No branch, worktree, commit, reset, push, or user workspace operation was performed. Native scenarios use generated tiny media in canonical temporary directories and a fresh test application identifier.

## Verified findings and corrections

| Severity | Failure mechanism and correction | Reproduction / evidence |
| --- | --- | --- |
| P0 | Cocoa `terminate:` bypasses Tauri's `ExitRequested` in the installed Tao runtime. Even after window-close coordination was added, application Quit terminated a pending writer. A macOS delegate subclass now implements `applicationShouldTerminate:` and routes it through the same asynchronous coordinator, preserving Tao's other methods and object layout. | Real `NSRunningApplication.terminate()` against the exact fixture PID exited in 131 ms; the destination remained at x=450 instead of the requested x=475. This is a deterministic native failure, separate from SIGKILL. The unchanged assertion is the regression gate. |
| P0 | Invalid recovery JSON, invalid state shape, or an unsupported Zustand envelope version failed hydration, but a subsequent mutation overwrote the only recovery bytes. `createSessionStorage` validates before hydration, preserves the original bytes, reports the failure, and disables automatic overwrite. Explicit Save As remains available. Storage quota errors are also reported without throwing through an in-memory edit. | Three store regressions failed before the fix and pass afterward. A browser test starts with broken recovery data, imports media, saves explicitly, and verifies that the original bytes remain unchanged. |
| P1 | A save requested after undoing an edit could be skipped as “clean” while an earlier write was still pending. That earlier write then committed the unwanted snapshot. `saveSessionToFile` now accounts for pending persistence and failed-write retries before skipping a request. | Deferred-write regression failed with two writes instead of the required three before the fix; it now verifies the final requested snapshot and clean state. |
| P1 | Neither window close nor native application exit waited for frontend saves or blocking native operations. Added a native-owned shutdown handshake: freeze new session mutations, invalidate pending loads, drain requested persistence, reject new native work, drain accepted native operations, stop video workers, then authorize exit. Repeated close requests coalesce. A ten-second deadline cancels shutdown and leaves the app open; request IDs prevent stale acknowledgments or errors from affecting a newer attempt. | Frontend deferred-promise tests and native state-machine tests; real macOS tests close during two queued writes and during a write outside the frontend queue, reject a failed save, retry successfully, and exercise timeout plus late completion. The original missing barrier was established by tracing the close/exit handlers; a pre-fix native race was not run. |
| P1 | A drop probe retained component ownership but not workspace ownership. Its result could append old media to a newly loaded workspace. `useTauriDrop` now checks the session generation on success and failure. | Deferred probe/session replacement test failed before the fix and passes afterward. Existing late-registration/unmount tests remain passing. |
| P2 | Atomic replacement synced the temporary file but did not sync the parent directory after rename. The replacement now syncs the directory on Unix and reports post-replacement sync failure explicitly. | Existing native fault tests preserve the prior target and clean temporary files after write/precommit failures. Real SIGKILL before rename preserves the prior committed JSON and permits reopening. Actual power interruption was not tested. |

No existing canvas file schema or session envelope version was changed. Viewport-only movement retains the existing product semantics: it updates session recovery but does not make an explicitly saved canvas dirty. Shutdown does not silently autosave unsaved edits over a workspace file.

## Lifecycle ownership

`main.tsx` installs one native listener pair outside React's Strict Mode mount cycle, with hot-reload disposal and protection against late registration. Native code owns the deadline and final exit authorization. `CloseRequested` covers the window controls, `ExitRequested` covers Tauri's exit API, and the macOS delegate explicitly intercepts Cocoa/menu termination. It cancels Cocoa's immediate termination and initiates the asynchronous coordinator; it does not block Cocoa's main thread.

The store freezes mutation and new persistence entry points while closing. Existing saves retain their FIFO order and generation checks. Failed writes remain observable to the shutdown barrier. An empty session can close even when its corrupt historical recovery copy is protected; nonempty unsaved work requires working recovery storage or an explicit successful file save.

Native operation guards live inside blocking closures for saves, probes, thumbnails, previews, screenshots, and exports. This prevents cancellation of an IPC waiter from falsely signaling completion of its blocking operation. Decode requests and calibration probes are also tracked. Manifest admission is serialized with shutdown state, and stop-all waits for aborted worker tasks before acknowledging cleanup. Idle monitors and the webview terminate with the process; this is not a comprehensive long-duration leak assessment.

## Changed files

| Files | Purpose |
| --- | --- |
| `src/lib/applicationLifecycle.ts`, `src/main.tsx` | Frontend/native handshake, freeze/resume, scoped error responses, listener ownership. |
| `src/lib/applicationLifecycle.test.ts` | Deferred flush, duplicate close, late listener, disposal, and stale-response regressions. |
| `src/lib/sessionStorage.ts`, `src/lib/sessionStorage.test.ts` | Recovery validation, overwrite protection, explicit quota errors and retry. |
| `src/stores/useCanvasSessionStore.ts`, `src/stores/useCanvasSessionStore.test.ts` | Queue drain/error state, mutation barrier, undo/save ordering, recovery regressions. |
| `src/utils/drag.ts`, `src/utils/drag.test.tsx` | Prevent stale imports crossing workspace generations. |
| `src/utils/fs.ts` | Reuse the existing canvas validator for recovery data. |
| `src-tauri/src/lifecycle.rs` | Native shutdown state, macOS termination hook, deadline, operation guards, and unit tests. |
| `src-tauri/src/lib.rs` | Startup wiring, close/exit interception, command registration, operation ownership. |
| `src-tauri/src/canvas_persistence.rs` | Directory sync, native save ownership, disposable test-only precommit barrier. |
| `src-tauri/src/native_video/commands.rs`, `src-tauri/src/native_video/controller.rs` | Prevent restart during cleanup, track calibration, await worker disposal. |
| `src/test/desktopBridge.ts`, `desktop-tests/lifecycle.mjs` | Real queued/native writes, graceful versus forced termination, retry/timeout, restart fixtures. |
| `scripts/run-desktop-tests.mjs` | Unique test identity and test-only global Tauri API for the driver. |
| `e2e/canvas-save.spec.ts` | User-visible corrupt-recovery and explicit-save workflow. |
| `docs/lifecycle-hardening.md` | Investigation, validation, and release limitations. |

## Validation

Node **26.13.0**, pnpm **10.32.1**, macOS. Logs were retained under `/tmp/sigma-*.log`; the harness also preserves native failures under `desktop-test-results/`.

| Actual command | Result / boundary |
| --- | --- |
| `pnpm test` | PASS: 201 tests across 26 files. Native IPC is mocked. Initial baseline: 188 tests. |
| `pnpm test:e2e` | PASS: 30 passed, 7 existing optional/performance/corpus cases skipped. Chromium with mocked Tauri IPC. First restricted attempt could not bind port 1420; rerun with local-server access passed. |
| `pnpm lint`, `pnpm lint:apply` | PASS; final full checks made no unrelated formatting changes. |
| `pnpm exec tsc --noEmit` | PASS: application types. |
| `pnpm exec tsc --project tsconfig.scripts.json --noEmit` | PASS: media scripts and TypeScript native harness. |
| `pnpm exec tsc --project tsconfig.vitest.json --noEmit` | Existing configuration failure: references absent `@types/jsdom`. No dependency changes made. |
| `pnpm exec tsc -p tsconfig.vitest.json --types node,vitest/globals --composite false --noEmit` | PASS with an explicit type-list override. |
| `pnpm build` | PASS; existing large-chunk advisory remains. Also executed by the production Tauri build. |
| `cargo check --manifest-path src-tauri/Cargo.toml --all-features` | PASS. |
| `cargo test --manifest-path src-tauri/Cargo.toml --all-targets --all-features` | PASS: 37 unit tests, 3 enforced IPC integration tests, one corpus-plan entry point that does no corpus workload without a plan, and 2 Criterion smoke checks. Native media subprocesses execute; IPC integration uses Tauri's mock runtime. Restricted thumbnail test failed, then passed with native-process access. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | PASS. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | PASS; pre-existing stable-toolchain warning about `trailing_comma` remains. |
| `pnpm bench` | PASS; generated current benchmark reports. JS IPC benchmark uses mocks; no native latency or baseline-improvement claim. |
| `pnpm bench:ipc:rust -- --sample-size 10 --measurement-time 1 --warm-up-time 1` | PASS: mock-runtime profile IPC 9.10 µs (8.49–10.22 µs interval), 32-asset manifest 212.08 µs (208.46–216.91 µs). Criterion marked the former 12.5% slower and latter 13.3% faster than its stored reference. The profile command's implementation was unchanged and 2 of 10 samples were severe high outliers; these small-sample deltas do not establish causation or a real-window latency change. |
| `pnpm tauri build --no-bundle` | PASS: optimized macOS executable. No installer signing/notarization claim. |
| `pnpm test:desktop` | PASS on the final source: 2 WebdriverIO smoke checks plus the real WKWebView/Tauri/FFmpeg process lifecycle below. A pre-fix application Quit check failed with the prior x=450 file; the same x=475 assertion passed after the macOS fix. |

The first desktop attempt failed its settings-dialog interaction. A standalone follow-up failed startup; other Cargo invocations had shared its debug output directory, so that run is not accepted as lifecycle evidence. The test-only driver configuration was corrected and subsequent Cargo/native runs were serialized. The full native suite then passed. In the final run, a double queued write took 3,056 ms including two injected 1,500 ms delays; direct native write and application Quit each waited about 1,480 ms for the same injected delay. An idle close took 13–22 ms in the later scenarios. These are wall-clock observations through the test driver, not before/after latency benchmarks. The native run also observed FFmpeg child exit after manifest removal, stop-all, application shutdown, media removal, and session replacement; a 6,208-byte `SVF1` packet; a two-item file with a modified viewport and crop; restart restoration; and missing-source retention. It distinguished normal window close, Cocoa application Quit, and deliberate SIGKILL before rename. Nonfatal driver `core.invoke` warnings remain visible in the logs rather than being suppressed.

## Remaining limits and release assessment

| Subsystem | Assessment | Supporting boundary |
| --- | --- | --- |
| Graceful shutdown | **PASS** | Real macOS close and Cocoa Quit both waited for pending saves; errors and deadline left the process open. |
| Persistence consistency | **PASS** | FIFO and undo regressions, atomic replacement fault tests, direct native write drain, directory fsync. |
| Crash recovery | **PASS** | Tested case: SIGKILL between temporary-file sync and rename retained the previous committed JSON, followed by successful reopen. Power loss and kill during an export remain unverified. |
| Resource cleanup | **NOT VERIFIED comprehensively** | Decoder child PIDs exited under five tested transitions and shutdown joins workers; no long soak of subscriptions, cache use, and exports. |
| Workspace restoration | **PASS** | Repeated actual process launches restored two positioned items, crop, viewport, and a missing source reference without dropping the item. |
| Native macOS validation | **PASS** | `pnpm test:desktop` used WKWebView, Tauri IPC, FFmpeg, real app processes, normal termination and SIGKILL. Signing/notarization was not tested. |

Power-loss durability, signed distribution behavior, multi-process writes to the same canvas, and forced termination during an export are outside the verified claims. A killed writer may leave a hidden temporary file; the committed canvas remains intact, and the test runner removes its disposable directory. No unsafe sweep of older temporary files was introduced.

Invalid recovery bytes are retained in their original storage key. There is no new repair/export UI for that raw key; users can open a valid file and save new work explicitly. A long-running or hung media operation causes shutdown to time out and remain open rather than silently terminating it. The larger optional media corpus and a long-duration subscription/cache soak were not run.

**Recommendation:** The tested paths support an internal macOS beta with explicit file-save expectations. Do not claim broad production-beta readiness yet. Before that release, run a long native media/resource soak, exercise force-stop during export and startup recovery across more assets, and provide a user-facing recovery route for protected invalid local storage. Power-loss durability and packaged release behavior need separate validation if either is part of the release promise.
