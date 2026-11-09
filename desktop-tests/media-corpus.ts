// Real-Tauri media corpus scenario (macOS, test build with the WebDriver
// plugin). Launched by scripts/run-desktop-tests.mjs when
// SIGMA_DESKTOP_MEDIA_PLAN is set. Exercises, inside the real app:
//   - probe_media / request_decode over real WKWebView IPC for every asset
//   - the production drop-import path through the frontend bridge
//   - WKWebView <video> playback and seeking through the asset protocol
//   - native FFmpeg decoders: throttling, frame delivery, shutdown while active
//   - app RSS at each stage and after cleanup
// Writes a JSON report; the orchestrator turns it into gates.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type PlanAsset = {
  id: string;
  path: string;
  relativePath: string;
  expect: "ok" | "error";
  expected: {
    width: number;
    height: number;
    frameRate: number | null;
    size: number;
  } | null;
};
type Plan = {
  mediaDirs: string[];
  assets: PlanAsset[];
  playbackAssetIds: string[];
  decodeAssetIds: string[];
  report: string;
};
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const planPath = process.env.SIGMA_DESKTOP_MEDIA_PLAN;
if (!planPath) throw new Error("SIGMA_DESKTOP_MEDIA_PLAN is required");
const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
const binary = resolve("src-tauri/target/debug/sigma");
const report: Record<string, unknown> = {
  schema: "sigma.desktop-media-report.v1",
  stages: [],
};
const stages = report.stages as Array<Record<string, unknown>>;
let child: ChildProcess | undefined;
let port = 0;
let session = "";

const choosePort = async () => {
  const server = createServer();
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const address = server.address();
  await new Promise((ok) => server.close(ok));
  return typeof address === "object" && address ? address.port : 0;
};

const request = async (
  path: string,
  method = "GET",
  body?: unknown,
): Promise<JsonValue> => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const result = (await response.json()) as {
    value?: JsonValue & { error?: unknown };
  };
  if (
    !response.ok ||
    (result.value &&
      typeof result.value === "object" &&
      "error" in result.value)
  ) {
    throw new Error(`WebDriver ${path}: ${JSON.stringify(result)}`);
  }
  return result.value ?? null;
};

const sync = (script: string, args: unknown[] = []) =>
  request(`/session/${session}/execute/sync`, "POST", { script, args });

/** Runs an async snippet; the snippet must call `done(value)`. */
const run = async <T>(script: string, args: unknown[] = []) =>
  (await request(`/session/${session}/execute/async`, "POST", {
    script: `const done = arguments[arguments.length - 1]; const args = Array.from(arguments).slice(0, -1);
      (async () => { ${script} })().then(done, (e) => done({ failed: String(e) }));`,
    args,
  })) as T;

const rssBytes = (pid: number | undefined) => {
  if (!pid) return null;
  try {
    return (
      Number(
        execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
          encoding: "utf8",
        }).trim(),
      ) * 1024
    );
  } catch {
    return null;
  }
};

const decoderPids = (parent: number | undefined) => {
  if (!parent) return [];
  try {
    return execFileSync("pgrep", ["-P", String(parent)], { encoding: "utf8" })
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((pid) => {
        try {
          return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
            encoding: "utf8",
          }).includes("ffmpeg");
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const stage = (name: string, data: Record<string, unknown> = {}) => {
  const entry = {
    name,
    rssBytes: rssBytes(child?.pid),
    at: Date.now(),
    ...data,
  };
  stages.push(entry);
  console.log(
    `[desktop-media] ${name} rss=${((entry.rssBytes ?? 0) / 1024 ** 2).toFixed(0)}MiB`,
  );
};

const launch = async () => {
  port = await choosePort();
  child = spawn(binary, [], {
    env: {
      ...process.env,
      TAURI_WEBDRIVER_PORT: String(port),
      WDIO_EMBEDDED_SERVER: "true",
      SIGMA_DESKTOP_MEDIA_DIRS: plan.mediaDirs.join(":"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  for (let attempt = 0; ; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error("Application exited during startup");
    try {
      await request("/status");
      break;
    } catch {
      if (attempt > 200) throw new Error("WebDriver startup timed out");
      await delay(100);
    }
  }
  const created = (await request("/session", "POST", {
    capabilities: { alwaysMatch: {} },
  })) as { sessionId?: string };
  session = created.sessionId ?? "";
  assert.ok(session, "missing session id");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      await sync(
        "return !!document.querySelector('.canvas-container') && !!window.__SIGMA_DESKTOP_TEST__",
      )
    )
      return;
    await delay(100);
  }
  throw new Error("Canvas did not initialize");
};

const closeWindow = async () => {
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (ok, fail) => {
      const timer = setTimeout(
        () => fail(new Error("app did not exit after window close")),
        15_000,
      );
      child?.once("exit", (code, signal) => {
        clearTimeout(timer);
        ok({ code, signal });
      });
    },
  );
  try {
    await request(`/session/${session}/window`, "DELETE");
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (
      !code ||
      !["ECONNRESET", "ECONNREFUSED", "UND_ERR_SOCKET"].includes(code)
    )
      throw error;
  }
  return exited;
};

try {
  await launch();
  stage("launched");

  // Thumbnails persist in the test build's app cache across runs; clear it so
  // the first request per asset is a genuine cold decode.
  report.cacheCleared = await run(
    "return await window.__TAURI_INTERNALS__.invoke('clear_media_cache');",
  );

  // 1. Native IPC over every asset, exactly as the frontend invokes it.
  const ipc = await run<Array<Record<string, unknown>>>(
    `const results = [];
     for (const asset of args[0]) {
       const started = performance.now();
       let probe; try { probe = { ok: true, value: await window.__TAURI_INTERNALS__.invoke('probe_media', { path: asset.path }) }; }
       catch (e) { probe = { ok: false, error: String(e) }; }
       const probeMs = performance.now() - started;
       const decodeStarted = performance.now();
       let thumbnail; try { thumbnail = await window.__TAURI_INTERNALS__.invoke('request_decode', { itemId: 'desktop-' + asset.id, path: asset.path, lod: 256, generation: 1, priority: 'visible' }); }
       catch (e) { thumbnail = { error: String(e) }; }
       results.push({ id: asset.id, probe, probeMs, thumbnail, thumbnailMs: performance.now() - decodeStarted });
     }
     return results;`,
    [plan.assets],
  );
  report.ipc = ipc;
  stage("ipc-probed", { assets: ipc.length });

  // 2. Production import path inside the real webview.
  const corpusPaths = plan.assets
    .filter((asset) => asset.expect === "ok")
    .map((asset) => asset.path);
  const imported = await run<{
    ok: boolean;
    elapsedMs: number;
    items: Array<Record<string, unknown>>;
  }>("return window.__SIGMA_DESKTOP_TEST__.importPaths(args[0]);", [
    corpusPaths,
  ]);
  report.import = imported;
  stage("imported", { items: imported.items?.length ?? 0 });

  // 3. WKWebView media element playback through the asset protocol.
  const playbackAssets = plan.assets.filter((asset) =>
    plan.playbackAssetIds.includes(asset.id),
  );
  report.playback = await run(
    `const { convertFileSrc } = window.__TAURI_INTERNALS__;
     const results = [];
     for (const asset of args[0]) {
       const video = document.createElement('video');
       video.muted = true; video.playsInline = true; video.preload = 'auto';
       const started = performance.now();
       const outcome = await new Promise((ok) => {
         const timer = setTimeout(() => ok({ status: 'timeout' }), 30000);
         video.addEventListener('error', () => { clearTimeout(timer); ok({ status: 'error', code: video.error && video.error.code }); }, { once: true });
         video.addEventListener('canplay', () => { clearTimeout(timer); ok({ status: 'ready' }); }, { once: true });
         video.src = convertFileSrc(asset.path);
         document.body.appendChild(video);
       });
       const result = { id: asset.id, ...outcome, readyMs: performance.now() - started };
       if (outcome.status === 'ready') {
         await video.play().catch((e) => { result.playError = String(e); });
         const advanced = await new Promise((ok) => { const t0 = performance.now(); const tick = () => video.currentTime > 0.2 ? ok(true) : performance.now() - t0 > 8000 ? ok(false) : setTimeout(tick, 50); tick(); });
         video.pause();
         const seekStarted = performance.now();
         const target = (video.duration || 1) / 2;
         await new Promise((ok) => { const t = setTimeout(ok, 15000); video.addEventListener('seeked', () => { clearTimeout(t); ok(); }, { once: true }); video.currentTime = target; });
         Object.assign(result, { advanced, seekMs: performance.now() - seekStarted, seekError: Math.abs(video.currentTime - target), width: video.videoWidth, height: video.videoHeight });
       }
       video.removeAttribute('src'); video.load(); video.remove();
       results.push(result);
     }
     return results;`,
    [playbackAssets],
  );
  stage("played");

  // 4. Native decoder throttling with several real 4K/HD sources at once.
  const decodeAssets = plan.assets.filter((asset) =>
    plan.decodeAssetIds.includes(asset.id),
  );
  const manifestFor = (assets: PlanAsset[]) => ({
    canvasWidth: 1600,
    canvasHeight: 1000,
    viewportZoom: 1,
    assets: assets.map((asset, index) => ({
      id: `native-${asset.id}`,
      path: asset.path,
      sourceWidth: asset.expected?.width ?? 1920,
      sourceHeight: asset.expected?.height ?? 1080,
      screenX: index * 400,
      screenY: 0,
      renderedWidthPx: 400,
      renderedHeightPx: 225,
      visibleAreaPx: 90000,
      focusWeight: index === 0 ? 1 : 0.2,
      centerWeight: 1,
      targetFps: 30,
    })),
  });
  await run(
    "await window.__SIGMA_DESKTOP_TEST__.captureFrames(); return true;",
  );
  const allocation = await run<{ allocations?: Array<{ state: string }> }>(
    "return await window.__TAURI_INTERNALS__.invoke('native_video_update_manifest', { manifest: args[0] });",
    [manifestFor(decodeAssets)],
  );
  let frame: { packetBytes: number; packetMagic: string } = {
    packetBytes: 0,
    packetMagic: "",
  };
  for (
    let attempt = 0;
    attempt < 150 && frame.packetBytes <= 64;
    attempt += 1
  ) {
    frame = (await sync(
      "return window.__SIGMA_DESKTOP_TEST__.frameInfo()",
    )) as typeof frame;
    await delay(100);
  }
  const activeDecoders = decoderPids(child?.pid);
  report.nativeDecode = {
    requested: decodeAssets.length,
    states: allocation.allocations?.map((entry) => entry.state) ?? [],
    decoderPids: activeDecoders,
    frame,
  };
  stage("native-decoding", { decoders: activeDecoders.length });

  // 5. Cleanup inside a live app: clear the canvas and stop decoders.
  await run(
    "await window.__TAURI_INTERNALS__.invoke('native_video_stop_all'); window.__SIGMA_DESKTOP_TEST__.clearFixture(); return true;",
  );
  for (
    let attempt = 0;
    attempt < 50 && activeDecoders.some(alive);
    attempt += 1
  )
    await delay(100);
  report.afterStopAll = {
    survivingDecoders: activeDecoders.filter(alive),
    items: await sync(
      "return window.__SIGMA_DESKTOP_TEST__.sessionItemCount()",
    ),
  };
  await delay(2000);
  stage("cleaned-up");

  // 6. Close the window while decoders are actively running.
  await run(
    "await window.__TAURI_INTERNALS__.invoke('native_video_update_manifest', { manifest: args[0] }); return true;",
    [manifestFor(decodeAssets)],
  );
  let closingDecoders: number[] = [];
  for (
    let attempt = 0;
    attempt < 100 && closingDecoders.length === 0;
    attempt += 1
  ) {
    closingDecoders = decoderPids(child?.pid);
    await delay(100);
  }
  // Clear the test cache so this request cannot reuse the earlier IPC result.
  await run(
    "return await window.__TAURI_INTERNALS__.invoke('clear_media_cache');",
  );
  const source = decodeAssets[0]?.path;
  assert.ok(source, "shutdown scenario requires a thumbnail source");
  void sync(
    "window.__TAURI_INTERNALS__.invoke('request_decode', { itemId: 'closing', path: arguments[0], lod: 256, generation: 99, priority: 'visible' }); return true;",
    [source],
  ).catch(() => undefined);
  let thumbnailPidsAtClose: number[] = [];
  for (
    let attempt = 0;
    attempt < 500 && thumbnailPidsAtClose.length === 0;
    attempt += 1
  ) {
    thumbnailPidsAtClose = decoderPids(child?.pid).filter((pid) => {
      try {
        const command = execFileSync(
          "ps",
          ["-p", String(pid), "-o", "command="],
          { encoding: "utf8" },
        );
        return command.includes("-vframes 1") && command.includes(source);
      } catch {
        return false;
      }
    });
    if (!thumbnailPidsAtClose.length) await delay(10);
  }
  assert.ok(
    thumbnailPidsAtClose.some(alive),
    "cold thumbnail FFmpeg was not observed in flight",
  );
  closingDecoders = [...new Set([...closingDecoders, ...thumbnailPidsAtClose])];
  const exit = await closeWindow();
  for (
    let attempt = 0;
    attempt < 50 && closingDecoders.some(alive);
    attempt += 1
  )
    await delay(100);
  report.shutdown = {
    exit,
    decodersAtClose: closingDecoders,
    thumbnailPidsAtClose,
    survivingDecoders: closingDecoders.filter(alive),
  };
  console.log(`[desktop-media] shutdown ${JSON.stringify(report.shutdown)}`);
  child = undefined;
} catch (error) {
  report.error = String((error as Error).stack ?? error);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    const orphans = decoderPids(child.pid);
    child.kill("SIGKILL");
    for (const pid of orphans) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  writeFileSync(plan.report, JSON.stringify(report, null, 2));
  console.log(`[desktop-media] wrote ${plan.report}`);
}
