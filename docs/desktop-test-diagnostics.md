# macOS desktop-test diagnostics

## Native close experiment

An experimental final `browser.closeWindow()` on the single-window Tauri application closed the window and its in-process WebDriver server. WebdriverIO 9.33.1 then reported:

```text
Error: All window handles were removed, causing WebdriverIO to close the session.
WebDriverError: Request failed with error code ECONNREFUSED ... DELETE /session/...
```

The runner reported failure during teardown. The passing smoke suite omits this experimental close and lets the service delete the session and stop the process. A dedicated process-exit-aware runner is needed to assert graceful application shutdown without losing the in-process server before session teardown. This experiment does not establish that native media children are terminated.

## Denied-write test protocol response

The first denied-write assertion returned an object with an `error` key. The embedded WebDriver interpreted it as a protocol error, even though the native command correctly rejected the path. The test now returns the rejection in a `message` field and independently checks that no destination was created.

## Phase 3B lifecycle attempts

The first process-aware restart attempt tried to import `/src/utils/fs.ts` from `tauri://localhost` and failed because the embedded production-style asset server returned HTML rather than a JavaScript module. A test-build-only bridge now calls the application modules directly. The next attempt received `Canvas destination is outside the application file scope`: the fixture granted the canonical macOS temporary path while Node supplied a `/var` alias for the not-yet-created file. The runner now uses `realpath` before both granting and saving. Neither failure weakened the persistence command's authorization.

Two final integrated runs passed. Run 1: managed smoke PID 60497 exited; lifecycle PIDs 60619 and 60749 exited with code 0; FFmpeg PIDs 60629, 60667 and 60716 exited after manifest removal, stop-all and app shutdown respectively. Run 2: managed smoke PID 61362 exited; lifecycle PIDs 61406 and 61536 exited with code 0; FFmpeg PIDs 61416, 61454 and 61503 exited under the same respective checks. Both received a 6208-byte `SVF1` frame and probed the reopened 1x1 PNG. PIDs are observations from those runs, not stable identifiers.

The dedicated lifecycle client issues WebDriver's close-window request itself and observes the child process independently. It accepts a transport disconnect only for specific connection-reset/refused/socket failures and still requires process exit code 0. This avoids the WDIO runner's attempted session deletion after its in-process server has already terminated; it does not suppress arbitrary WebDriver errors.

The expanded frontend-surface scenario passed twice. In the full run, the service-managed smoke PID 64600 exited; lifecycle apps 64632 and 64762 exited with code 0. Native FFmpeg PIDs 64642, 64680 and 64729 exited after manifest removal, stop-all and shutdown; frontend-driven removal and session replacement ended PIDs 64785 and 64865. In the separate repeat, lifecycle apps 64979 and 65070 exited with code 0; native teardown PIDs were 64986, 65012 and 65046, and frontend removal/replacement ended 65116 and 65165. Both runs received a real frame and reopened the fixture-granted image. The frontend transitions were initiated through a test bridge calling the real canvas store, not mouse or keyboard input.

A third complete run after adding automatic failure-log preservation also passed. Its managed smoke PID 62907 exited; app PIDs 62944 and 63074 exited with code 0, and decoder PIDs 62954, 62992 and 63041 exited after manifest removal, stop-all and shutdown. A controlled port-conflict experiment deliberately occupied port 1420: the runner exited nonzero, stopped its own resources, and retained a diagnostic log under `test-results/desktop-failure-1793734934999-65737.log`. The conflict was deliberate and was removed after the test.

A later test-mode run timed out while triggering a webview reload after the file had been reopened; the native persistence and initial decoder checks had already passed. The retained failure was `test-results/desktop-failure-1793735083009-66844.log` (Playwright may clean that earlier location). The test now sets the existing native-video opt-in before the planned process restart and no longer reloads the webview. Two corrected standalone lifecycle runs and one complete workflow passed. The corrected complete workflow observed managed smoke PID 70588 exit; lifecycle PIDs 70647 and 70777 exited with code 0; direct decoder PIDs 70657, 70695 and 70744 exited after removal, stop-all and shutdown, and frontend transitions ended PIDs 70798 and 70878. The deliberately occupied-port failure was repeated after moving logs to `desktop-test-results/`; it retained `desktop-test-results/desktop-failure-1793735248058-71098.log`.
