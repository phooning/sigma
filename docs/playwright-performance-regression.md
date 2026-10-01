# Playwright pan benchmark regression after PR #67

## Conclusion

This was an environment-sensitive benchmark of a broken media-loading fixture,
not evidence of a new canvas hot-path regression in PR #67. The E2E mock returned
`null` for `request_decode`. The seeded 320×180 images use preview LOD, so they
never acquired preview assets. The mock image itself was SVG, which Chromium's
`createImageBitmap(blob)` native-image path cannot decode. Both defects kept the
image loading masks opaque with `backdrop-filter: blur(12px)` throughout panning.

The benchmark consequently measured continuous loading-mask compositing and
failed preview requests, rather than panning displayed images. Browser rendering
behavior and available CPU changed the measured frame intervals enough to cross
the existing 70 ms gate. The fix supplies successful image decode results and a
small PNG, and verifies that an image is actually displayed before measurement.
The 70 ms median and 225 ms local maximum gates remain unchanged.

## CI evidence

- Failed merge job: https://github.com/phooning/sigma/actions/runs/36702755180/job/109845787958
- Passing PR-head job: https://github.com/phooning/sigma/actions/runs/36194565262/job/108267335179
- The PR head `f5938ca` and merge `b4d51aa` have identical file trees.
- Both September jobs used Node 24.21.0, pnpm 10.32.1, Playwright 1.63.0,
  Ubuntu 24.04.5 and image `20260920.314.1`. They ran on different workers and
  Azure regions (passing: westus2; failing: eastus). There is no evidence of an
  image-version change between these two jobs.
- The passing PR report already measured image p50 values of 50, 66.6 and
  66.6 ms at 50, 200 and 500 items. Deferred-video values were 33.3, 33.4 and
  33.4 ms. The image budget was already close to a refresh-interval boundary.
- The failing artifact `11091056410` was downloaded and inspected. Its retry
  trace (`3e86ed376a16306a652fc343541b96b49d2b469e.zip` in the HTML report)
  fails at **200 images**, before the 500-image and video fixtures run.

Retry trace measurements (milliseconds):

| Images | Samples | p50 | p90 | p99/max | Average | FPS | Observation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 50 | 43 | 66.7 | 83.4 | 166.7 | 72.72 | 13.75 | 3150.0 |
| 200 | 43 | 83.3 | 133.4 | 166.7 | 84.71 | 11.81 | 3656.9 |

The 200-image frame intervals varied from 16.6 to 166.7 ms, including 50, 66.7,
83.3, 100, 133.3 and 150 ms. This is not a fixed 12 FPS throttle or a harness
loop waiting five frames: the loop waits one rAF after each wheel event. The
repeated 83.3 ms median is five elapsed 60 Hz refresh intervals, quantized
by the presentation clock. Screenshots show blank image cards behind masks.

The old sampler also collected historical long tasks via `buffered: true`:
50 images reported `[116, 102, 507, 211, 123, 57, 52, 127, 102]`; 200 images
reported the same list plus `[581, 68, 55, 83, 180, 146, 176]`. These are not
independent per-fixture measurements. The patch removes that historical replay,
drains pending entries at stop, and excludes the initial partial rAF interval.

## Code/browser isolation

Temporary copies of `d5a8b65` and `b4d51aa` were tested with Node 24.21.0,
locked dependencies and explicit browser paths, one worker at a time. Old
Playwright 1.59.1 bundles Chromium 147.0.7727.15 (revision 1217); new Playwright
1.63.0 bundles Chromium 153.0.8010.12 (revision 1243).

Unfixed fixture p50 on the local macOS host:

| Code | Chromium | Image 50 / 200 / 500 | Deferred video 50 / 200 / 500 |
| --- | --- | --- | --- |
| Before | 147 | 16.8 / 25.0 / 25.0 | 16.6 / 16.6 / 16.7 |
| Before | 153 | 33.3 / 33.3 / 33.3 | 16.7 / 16.7 / 16.7 |
| After | 147 | 16.8 / 25.0 / 24.9 | 15.6 / 16.6 / 16.6 |
| After | 153 | 33.3 / 33.3 / 33.3 | 16.7 / 16.7 / 16.7 |

The browser affected this fixture; the PR code delta did not. The pan handler,
rAF viewport commit and memoized media-item comparison were unchanged. The
new macOS `:has()` rules do not explain these equivalent before/after results.

The Linux config also launched `/usr/bin/chromium`, bypassing the browser
installed by the workflow. The runner manifest lists system Chromium
153.0.8010.0, while Playwright installed 153.0.8010.12; the job did not log the
actual running browser version. The patch removes this implicit override and
records `browser.version()` in benchmark attachments. Playwright documents that
its bundled browser is the supported/default pairing:
https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-executable-path

Runner manifest:
https://github.com/actions/runner-images/blob/ubuntu24/20260920.314/images/ubuntu/Ubuntu2404-Readme.md

## Causal experiments

Using unchanged application code:

1. SVG blob decoding throws `InvalidStateError: The source image could not be
   decoded`. All image masks remain `data-visible="false"`.
2. A PNG alone still leaves masks opaque because `request_decode` returns null.
3. A successful decode result alone still leaves masks opaque with SVG data.
4. A PNG plus successful `request_decode` displays native images. Local image
   p50 drops from 33.3 to 16.7 ms at every tested item count.

In an Ubuntu 24.04 x64 Playwright container, full Chromium 153 with the original
fixtures measured 50.0 / 66.6 / 66.7 ms. A diagnostic CSS override removing only
loading-mask backdrop blur reduced these values to 16.7 / 16.7 / 16.7 ms. This
CSS override is **not** part of the patch. The application clears its masks
normally when valid previews decode.

Under a two-CPU limit in the same container and full Chromium, the original
fixtures reproduced **83.29999999999927 ms at 200 images**, exactly matching CI;
500 images also measured 83.3 ms. The unchanged 70 ms assertion failed.
With the fix, three runs under the **same two-CPU/full-Chromium setup** passed
without retries: image p50 ranges were 16.7–33.4 ms (50 items), 49.9–66.6 ms
(200), and 33.4–50.0 ms (500). Deferred-video p50 stayed at 16.7–33.3 ms.
Three four-CPU/headless-shell runs also passed, with image p50 at 16.7–33.4 ms.

CDP rendering traces show small layout/style costs rather than an 83 ms React
callback: at 200 images, approximately 11 ms total UpdateLayoutTree and 2.8 ms
Layout across the entire unfixed pan capture. With working fixtures the native
worker actually finalizes image frames, and the page presents faster. Culling
keeps the mounted item count at 80 for both 200 and 500 fixtures. These traces
and the blur ablation support compositing/loading-state cost, not a newly
introduced O(N) render or forced-layout loop.

## Regression protection and diagnostics

- Keep the original absolute timing budgets; no threshold increase or new skip.
- Add a native-compositor E2E test that requires a displayed decoded preview.
- Require an image to be displayed before measuring the image scenarios.
- Assert at least 40 complete frame samples and the expected measured wheel-pan
  displacement of -720 / -480 px. A no-op pan cannot pass on fast idle rAFs.
- Attach each fixture before soft assertions, so timing failures still collect
  all six cases. Include raw frame deltas, p50/p90/p95/p99, average, maximum,
  FPS, observation duration and measurement-local long tasks.
- Record actual browser/Node versions, platform, hardware concurrency,
  visibility state and device-pixel ratio.

## Limits

The x64 Ubuntu container runs under emulation on macOS; it reproduces the same
failure mechanism and exact value, not the physical Azure host. Old May CI logs
have expired (GitHub HTTP 410), so the original pre-PR runner image cannot be
verified. Absolute timing remains sensitive to severe machine contention.
The patched GitHub workflow still needs its normal CI run. No dependency or
workflow-version changes were necessary.

## Verification

All host checks used Node 24.21.0 and pnpm 10.32.1:

- `pnpm install --frozen-lockfile`: passed; lockfile unchanged.
- `pnpm test:e2e` and `CI=1 pnpm test:e2e`: both 27 passed, one existing skipped test.
- `CI=1 pnpm exec playwright test e2e/performance.spec.ts --grep scalability --repeat-each=3 --workers=1`: three passed.
- `CI=1 pnpm exec playwright test e2e/performance.spec.ts --repeat-each=3 --workers=1`: nine passed, three repeats of the existing skip.
- `pnpm test`: 128 passed across 20 files.
- `pnpm build`: passed (existing Vite chunk-size advisory).
- `pnpm lint` and `pnpm lint:apply`: passed, no fixes applied.
- `git diff --check`: passed.

Linux verification used
`mcr.microsoft.com/playwright:v1.63.0-noble` (Ubuntu 24.04, linux/amd64),
Node 24.21.0 and pnpm 10.32.1. Container commands were:

```sh
docker run --rm --platform linux/amd64 --cpus=4 --ipc=host \
  -v /tmp/sigma-linux:/work -w /work \
  mcr.microsoft.com/playwright:v1.63.0-noble bash ./verify.sh

docker run --rm --platform linux/amd64 --cpus=2 --ipc=host \
  -v /tmp/sigma-linux:/work -w /work \
  mcr.microsoft.com/playwright:v1.63.0-noble bash ./contention.sh

docker run --rm --platform linux/amd64 --cpus=2 --ipc=host \
  -v /tmp/sigma-linux:/work -w /work \
  mcr.microsoft.com/playwright:v1.63.0-noble bash ./contention-fixed.sh
```

The temporary scripts installed pnpm and selected Node 24 with npx, then ran
the targeted benchmark. `verify.sh` tested the patch three times with the
bundled headless shell. `contention.sh` tested the original fixtures and
70 ms gate once with explicit full Chromium. `contention-fixed.sh` tested the
patch three times with that same full Chromium and no retries. Diagnostic
fixture/browser/blur overrides were confined to temporary copies; none is
in the repository patch.

An initial default parallel E2E run lost its page execution context during
container-runtime startup. An initial Vitest run also hit a test timeout and
worker-start errors. After startup completed, Vitest and both the default
parallel and CI-style E2E suites passed without source changes for those failures.
