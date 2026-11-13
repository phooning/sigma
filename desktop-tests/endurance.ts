// Bounded native endurance scenario (macOS, test build with the WebDriver
// plugin). Launched by scripts/run-desktop-tests.mjs when
// SIGMA_DESKTOP_ENDURANCE is set. Uses only generated, disposable media in the
// OS temp directory. Each app session runs several cycles of:
//   import → thumbnails → native decoders start/stop/restart → <video>
//   playback → save → reopen → hide/unhide (background/foreground) → remove
// then closes the window gracefully and relaunches (session restore).
// Writes a JSON time series to SIGMA_DESKTOP_ENDURANCE_REPORT.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const sessions = Number(process.env.SIGMA_ENDURANCE_SESSIONS ?? 4);
const cyclesPerSession = Number(process.env.SIGMA_ENDURANCE_CYCLES ?? 10);
const reportPath =
  process.env.SIGMA_DESKTOP_ENDURANCE_REPORT ??
  resolve("desktop-test-results/endurance-report.json");
const binary = resolve("src-tauri/target/debug/sigma");

const mediaDir = realpathSync(
  mkdtempSync(join(tmpdir(), "sigma-desktop-media-endurance-")),
);
const fixtureDir = realpathSync(
  mkdtempSync(join(tmpdir(), "sigma-desktop-endurance-")),
);
const project = join(fixtureDir, "canvas.json");
const videos = [
  ["a.mp4", "testsrc=size=320x240:rate=30", 10],
  ["b.mp4", "testsrc2=size=640x360:rate=24", 8],
  ["c.mp4", "mandelbrot=size=1280x720:rate=30", 6],
].map(([name, source, seconds]) => {
  const path = join(mediaDir, String(name));
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    String(source),
    "-t",
    String(seconds),
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-y",
    path,
  ]);
  return path;
});
const image = join(mediaDir, "still.png");
execFileSync("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc=size=800x600:duration=1",
  "-frames:v",
  "1",
  "-y",
  image,
]);

const samples: Array<Record<string, unknown>> = [];
const sessionsReport: Array<Record<string, unknown>> = [];
const failures: string[] = [];
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
    signal: AbortSignal.timeout(60_000),
  });
  const result = (await response.json()) as {
    value?: JsonValue & { error?: unknown };
  };
  if (
    !response.ok ||
    (result.value &&
      typeof result.value === "object" &&
      "error" in result.value)
  )
    throw new Error(`WebDriver ${path}: ${JSON.stringify(result)}`);
  return result.value ?? null;
};
const sync = (script: string, args: unknown[] = []) =>
  request(`/session/${session}/execute/sync`, "POST", { script, args });
const run = async <T>(script: string, args: unknown[] = []) => {
  const value = (await request(`/session/${session}/execute/async`, "POST", {
    script: `const done = arguments[arguments.length - 1]; const args = Array.from(arguments).slice(0, -1);
      (async () => { ${script} })().then(done, (e) => done({ failed: String(e) }));`,
    args,
  })) as T & { failed?: string };
  if (value && typeof value === "object" && "failed" in value && value.failed)
    throw new Error(value.failed);
  return value as T;
};
const invoke = (command: string, args: unknown = {}) =>
  run<JsonValue>(
    "return await window.__TAURI_INTERNALS__.invoke(args[0], args[1]);",
    [command, args],
  );

const ps = (args: string[]) => {
  try {
    return execFileSync("ps", args, { encoding: "utf8" });
  } catch {
    return "";
  }
};
const rss = (pid: number) =>
  Number(ps(["-o", "rss=", "-p", String(pid)]).trim()) * 1024 || null;
const fds = (pid: number) => {
  try {
    return (
      execFileSync("lsof", ["-p", String(pid)], { encoding: "utf8" })
        .trim()
        .split("\n").length - 1
    );
  } catch {
    return null;
  }
};
const children = (pid: number | undefined) => {
  if (!pid) return [];
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((p) =>
        ps(["-p", String(p), "-o", "command="]).includes("ffmpeg"),
      );
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
// WKWebView helpers are XPC services owned by launchd, not children of the
// app. Attribute the ones that appear after launch (INFERRED ownership).
const webkitHelpers = () =>
  ps(["-axo", "pid=,rss=,comm="])
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 3))
    .filter(([, , comm]) => comm?.includes("com.apple.WebKit"))
    .map(([pid, kib, comm]) => ({
      pid: Number(pid),
      rss: Number(kib) * 1024,
      kind: comm.includes("WebContent")
        ? "webcontent"
        : comm.includes("GPU")
          ? "gpu"
          : "networking",
    }));
// macOS hides/unhides an app without Accessibility permission.
const setHidden = (pid: number, hidden: boolean) =>
  execFileSync("osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import('AppKit'); const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); app.${hidden ? "hide" : "unhide"}; app.activateWithOptions(0); 'ok'`,
  ]);

let preexistingHelpers = new Set<number>();
const launch = async () => {
  preexistingHelpers = new Set(webkitHelpers().map((helper) => helper.pid));
  port = await choosePort();
  child = spawn(binary, [], {
    env: {
      ...process.env,
      TAURI_WEBDRIVER_PORT: String(port),
      WDIO_EMBEDDED_SERVER: "true",
      SIGMA_DESKTOP_MEDIA_DIRS: mediaDir,
      SIGMA_DESKTOP_FIXTURE_DIR: fixtureDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    if (/panic|ERROR/i.test(text)) process.stderr.write(chunk);
  });
  for (let attempt = 0; ; attempt += 1) {
    if (child.exitCode !== null) throw new Error("app exited during startup");
    try {
      await request("/status");
      break;
    } catch {
      if (attempt > 300) throw new Error("WebDriver startup timed out");
      await delay(100);
    }
  }
  const created = (await request("/session", "POST", {
    capabilities: { alwaysMatch: {} },
  })) as { sessionId?: string };
  session = created.sessionId ?? "";
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (
      await sync(
        "return !!document.querySelector('.canvas-container') && !!window.__SIGMA_DESKTOP_TEST__",
      )
    )
      return;
    await delay(100);
  }
  throw new Error("canvas did not initialize");
};

const closeWindow = async () => {
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (ok, fail) => {
      const timer = setTimeout(
        () => fail(new Error("no exit after close")),
        20_000,
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

const manifest = (active: string[]) => ({
  canvasWidth: 1600,
  canvasHeight: 1000,
  viewportZoom: 1,
  assets: active.map((path, index) => ({
    id: `endurance-${index}`,
    path,
    sourceWidth: 640,
    sourceHeight: 360,
    screenX: index * 400,
    screenY: 0,
    renderedWidthPx: 400,
    renderedHeightPx: 225,
    visibleAreaPx: 90000,
    focusWeight: index === 0 ? 1 : 0.3,
    centerWeight: 1,
    targetFps: 30,
  })),
});

const sample = (
  label: string,
  sessionIndex: number,
  cycle: number,
  extra = {},
) => {
  const pid = child?.pid ?? 0;
  const helpers = webkitHelpers().filter(
    (helper) => !preexistingHelpers.has(helper.pid),
  );
  const entry = {
    label,
    session: sessionIndex,
    cycle,
    at: Date.now(),
    hostRss: rss(pid),
    hostFds: fds(pid),
    webContentRss: helpers
      .filter((h) => h.kind === "webcontent")
      .reduce((s, h) => s + h.rss, 0),
    gpuRss: helpers
      .filter((h) => h.kind === "gpu")
      .reduce((s, h) => s + h.rss, 0),
    helperCount: helpers.length,
    decoderPids: children(pid),
    ...extra,
  };
  samples.push(entry);
  return entry;
};

const started = Date.now();
try {
  for (let s = 0; s < sessions; s += 1) {
    const launchStarted = Date.now();
    await launch();
    const restoredItems = Number(
      await sync("return window.__SIGMA_DESKTOP_TEST__.sessionItemCount()"),
    );
    const sessionEntry: Record<string, unknown> = {
      session: s,
      launchMs: Date.now() - launchStarted,
      restoredItems,
      timeouts: 0,
      errors: [] as string[],
    };
    sessionsReport.push(sessionEntry);
    await run(
      "await window.__SIGMA_DESKTOP_TEST__.captureFrames(); return true;",
    );
    for (let c = 0; c < cyclesPerSession; c += 1) {
      const cycleStarted = Date.now();
      try {
        // Import (real drop path: native probe + item creation).
        await run("window.__SIGMA_DESKTOP_TEST__.clearFixture(); return true;");
        const imported = await run<{ items: unknown[] }>(
          "return await window.__SIGMA_DESKTOP_TEST__.importPaths(args[0]);",
          [[...videos, image]],
        );
        assert.equal(imported.items.length, videos.length + 1, "import count");
        // Thumbnails: cold every 3rd cycle, otherwise warm cache hits.
        if (c % 3 === 0) await invoke("clear_media_cache");
        for (const [index, path] of videos.entries()) {
          const value = await invoke("request_decode", {
            itemId: `thumb-${s}-${c}-${index}`,
            path,
            lod: 256,
            generation: c + 1,
            priority: "visible",
          });
          assert.equal(typeof value, "string", "thumbnail path");
        }
        // Native decoders: start, stop, restart with a different set.
        await invoke("native_video_update_manifest", {
          manifest: manifest(videos),
        });
        let frameBytes = 0;
        for (let attempt = 0; attempt < 80 && frameBytes <= 64; attempt += 1) {
          frameBytes = (
            (await sync(
              "return window.__SIGMA_DESKTOP_TEST__.frameInfo()",
            )) as {
              packetBytes: number;
            }
          ).packetBytes;
          await delay(50);
        }
        if (frameBytes <= 64) {
          (sessionEntry.timeouts as number) += 1;
          failures.push(`s${s}c${c}: no native frame within 4 s`);
        }
        const running = children(child?.pid);
        await invoke("native_video_stop_all");
        for (let attempt = 0; attempt < 50 && running.some(alive); attempt += 1)
          await delay(100);
        const survivors = running.filter(alive);
        if (survivors.length)
          failures.push(`s${s}c${c}: decoders survived stop-all ${survivors}`);
        await invoke("native_video_update_manifest", {
          manifest: manifest(videos.slice(1)),
        });
        await delay(500);
        // WKWebView playback of two clips.
        const playback = await run<
          Array<{ status: string; advanced?: boolean }>
        >(
          `const { convertFileSrc } = window.__TAURI_INTERNALS__;
           const results = [];
           for (const path of args[0]) {
             const video = document.createElement('video');
             video.muted = true; video.playsInline = true;
             const status = await new Promise((ok) => {
               const t = setTimeout(() => ok('timeout'), 15000);
               video.addEventListener('canplay', () => { clearTimeout(t); ok('ready'); }, { once: true });
               video.addEventListener('error', () => { clearTimeout(t); ok('error'); }, { once: true });
               video.src = convertFileSrc(path);
               document.body.appendChild(video);
             });
             let advanced = false;
             if (status === 'ready') {
               await video.play().catch(() => undefined);
               const t0 = performance.now();
               while (video.currentTime < 0.2 && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
               advanced = video.currentTime >= 0.2;
               video.pause();
             }
             video.removeAttribute('src'); video.load(); video.remove();
             results.push({ status, advanced });
           }
           return results;`,
          [videos.slice(0, 2)],
        );
        for (const result of playback)
          if (result.status !== "ready" || !result.advanced) {
            (sessionEntry.timeouts as number) += 1;
            failures.push(`s${s}c${c}: playback ${JSON.stringify(result)}`);
          }
        // Save through the production queue, then reopen from disk.
        const x = 1000 * s + c;
        await run(
          "window.__SIGMA_DESKTOP_TEST__.queueFixtureSaves(args[0], [args[1]]); await new Promise((r) => setTimeout(r, 300)); return true;",
          [project, x],
        );
        let snapshot = { isDirty: true };
        for (let attempt = 0; attempt < 50 && snapshot.isDirty; attempt += 1) {
          snapshot = (await sync(
            "return window.__SIGMA_DESKTOP_TEST__.sessionSnapshot()",
          )) as {
            isDirty: boolean;
          };
          await delay(100);
        }
        const onDisk = JSON.parse(readFileSync(project, "utf8")) as {
          items: Array<{ x: number }>;
        };
        if (snapshot.isDirty || !onDisk.items.every((item) => item.x === x))
          failures.push(`s${s}c${c}: save did not commit x=${x}`);
        const reopened = await run<{ ok: boolean }>(
          "return await window.__SIGMA_DESKTOP_TEST__.reopenFixture(args[0]);",
          [project],
        );
        if (!reopened.ok) failures.push(`s${s}c${c}: reopen failed`);
        // Background / foreground.
        if (child?.pid) {
          setHidden(child.pid, true);
          await delay(400);
          const hiddenState = await sync("return document.visibilityState");
          setHidden(child.pid, false);
          await delay(400);
          const shownState = await sync("return document.visibilityState");
          if (c === 0)
            sessionEntry.visibility = {
              hidden: hiddenState,
              shown: shownState,
            };
        }
        // Removal: stop decoders and empty the canvas.
        await invoke("native_video_stop_all");
        await run("window.__SIGMA_DESKTOP_TEST__.removeVideos(); return true;");
        const cache = (await invoke("media_cache_stats")) as {
          totalBytes?: number;
        } | null;
        await delay(300);
        sample("cycle-end", s, c, {
          cycleMs: Date.now() - cycleStarted,
          cacheBytes: cache?.totalBytes ?? null,
          items: await sync(
            "return window.__SIGMA_DESKTOP_TEST__.sessionItemCount()",
          ),
        });
      } catch (error) {
        (sessionEntry.errors as string[]).push(String(error).split("\n")[0]);
        failures.push(`s${s}c${c}: ${String(error).split("\n")[0]}`);
        sample("cycle-error", s, c);
      }
    }
    // Leave one item so the next launch exercises session restore.
    await run(
      "window.__SIGMA_DESKTOP_TEST__.reopenFixture(args[0]); return true;",
      [project],
    );
    const pid = child?.pid;
    const before = children(pid);
    const exit = await closeWindow();
    await delay(500);
    sessionEntry.exit = exit;
    sessionEntry.orphanDecoders = before.filter(alive);
    if (exit.code !== 0)
      failures.push(`session ${s}: exit ${JSON.stringify(exit)}`);
    if ((sessionEntry.orphanDecoders as number[]).length)
      failures.push(`session ${s}: orphan decoders`);
    child = undefined;
  }
} catch (error) {
  failures.push(`fatal: ${String((error as Error).stack ?? error)}`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    for (const pid of children(child.pid)) process.kill(pid, "SIGKILL");
    child.kill("SIGKILL");
  }
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        schema: "sigma.desktop-endurance-report.v1",
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        sessions,
        cyclesPerSession,
        media: videos.map((path) => path.split("/").pop()),
        sessionsReport,
        samples,
        failures,
      },
      null,
      2,
    ),
  );
  rmSync(mediaDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
  console.log(`[endurance] ${failures.length} failures; report ${reportPath}`);
  if (failures.length) process.exitCode = 1;
}
