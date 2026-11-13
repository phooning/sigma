import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const directory = await realpath(
  await mkdtemp(join(tmpdir(), "sigma-desktop-")),
);
const project = join(directory, "canvas.json");
const image = join(directory, "fixture.png");
const video = join(directory, "fixture.mp4");
const decoderPids = new Set();
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lB8AAAAASUVORK5CYII=";
await writeFile(image, Buffer.from(png, "base64"));
let child;
let port;
let currentSession;
async function choosePort() {
  const server = createServer();
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const selected = server.address().port;
  await new Promise((ok) => server.close(ok));
  return selected;
}
async function request(path, method = "GET", body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error)
    throw new Error(`WebDriver ${path}: ${JSON.stringify(result)}`);
  return result.value;
}
async function launch(grant, saveDelay = 0) {
  port = await choosePort();
  const env = {
    ...process.env,
    TAURI_WEBDRIVER_PORT: String(port),
    WDIO_EMBEDDED_SERVER: "true",
    SIGMA_DESKTOP_SAVE_DELAY_MS: String(saveDelay),
  };
  if (grant) env.SIGMA_DESKTOP_FIXTURE_DIR = directory;
  else delete env.SIGMA_DESKTOP_FIXTURE_DIR;
  child = spawn(resolve("src-tauri/target/debug/sigma"), [], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  console.log(
    `Lifecycle application PID: ${child.pid}, fixture grant: ${grant}`,
  );
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Application exited during startup");
    try {
      await request("/status");
      break;
    } catch {
      if (attempt === 199) throw new Error("WebDriver startup timed out");
    }
    await delay(100);
  }
  const session = await request("/session", "POST", {
    capabilities: { alwaysMatch: {} },
  });
  const id = session.sessionId;
  assert.ok(id, `Missing session id: ${JSON.stringify(session)}`);
  currentSession = id;
  for (let attempt = 0; attempt < 200; attempt++) {
    const ready = await request(`/session/${id}/execute/sync`, "POST", {
      script:
        "return !!document.querySelector('.canvas-container') && !!window.__SIGMA_DESKTOP_TEST__",
      args: [],
    });
    if (ready) return id;
    await delay(100);
  }
  throw new Error("Canvas did not initialize");
}
async function execute(id, body, args) {
  const value = await request(`/session/${id}/execute/async`, "POST", {
    script: body,
    args,
  });
  if (!value?.ok)
    throw new Error(`Application operation failed: ${JSON.stringify(value)}`);
  return value;
}
async function close(id, applicationQuit = false) {
  const startedAt = performance.now();
  const stopped = new Promise((ok, fail) => {
    const timer = setTimeout(
      () =>
        fail(
          new Error(`Application ${child.pid} did not exit after window close`),
        ),
      12000,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      ok({ code, signal });
    });
  });
  try {
    if (applicationQuit) {
      // NSRunningApplication targets this exact child PID and sends a normal
      // application termination request (the menu-quit path), never SIGTERM.
      const quit = spawnSync(
        "osascript",
        [
          "-l",
          "JavaScript",
          "-e",
          `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}).terminate;`,
        ],
        { encoding: "utf8" },
      );
      assert.equal(quit.status, 0, quit.stderr);
      assert.equal(
        quit.stdout.trim(),
        "true",
        "Native application quit request was refused",
      );
    } else {
      await request(`/session/${id}/window`, "DELETE");
    }
  } catch (error) {
    if (
      !["ECONNRESET", "ECONNREFUSED", "UND_ERR_SOCKET"].includes(
        error.cause?.code,
      )
    )
      throw error;
    console.log(`Window-close transport ended: ${error.cause.code}`);
  }
  const result = await stopped;
  console.log(`Application ${child.pid} exited: ${JSON.stringify(result)}`);
  console.log(
    `${applicationQuit ? "Application quit" : "Window close"} completed in ${(performance.now() - startedAt).toFixed(0)} ms`,
  );
  assert.equal(
    result.code,
    0,
    "Application should exit normally after closing its window",
  );
  child = undefined;
  currentSession = undefined;
}
function commandFor(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    if (error.status === 1) return "";
    throw error;
  }
}
async function decoderFor(parent) {
  for (let attempt = 0; attempt < 100; attempt++) {
    let pids = [];
    try {
      pids = execFileSync("pgrep", ["-P", String(parent)], { encoding: "utf8" })
        .trim()
        .split(/\s+/)
        .map(Number);
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    const pid = pids.find((value) => commandFor(value).includes(video));
    if (pid) {
      decoderPids.add(pid);
      console.log(`FFmpeg decoder PID: ${pid}, parent: ${parent}`);
      return pid;
    }
    await delay(100);
  }
  throw new Error("No FFmpeg decoder appeared for the fixture");
}
async function decoderExited(pid, context) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!commandFor(pid).includes(video)) {
      console.log(`FFmpeg ${pid} exited after ${context}`);
      return;
    }
    await delay(100);
  }
  throw new Error(`FFmpeg ${pid} survived ${context}`);
}
async function manifest(id, paths) {
  return execute(
    id,
    `const [paths, done] = arguments;
    const assets = paths.map(path => ({id:'test-video',path,sourceWidth:64,sourceHeight:64,
      screenX:0,screenY:0,renderedWidthPx:320,renderedHeightPx:320,visibleAreaPx:102400,
      focusWeight:1,centerWeight:1,targetFps:15}));
    window.__TAURI_INTERNALS__.invoke('native_video_update_manifest',
      {manifest:{canvasWidth:800,canvasHeight:600,viewportZoom:1,assets}})
      .then(value=>done({ok:true,states:value.allocations.map(a=>a.state)}),
        e=>done({ok:false,reason:String(e)}));`,
    [paths],
  );
}
async function stopAll(id) {
  return execute(
    id,
    `const done = arguments[0];
    window.__TAURI_INTERNALS__.invoke('native_video_stop_all')
      .then(()=>done({ok:true}),e=>done({ok:false,reason:String(e)}));`,
    [],
  );
}

async function waitForWrite() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await readFile(join(directory, "save-started"));
      return;
    } catch {}
    await delay(50);
  }
  throw new Error("Save did not reach the pre-replace barrier");
}

async function queueSaves(id, positions, destination = project) {
  await rm(join(directory, "save-started"), { force: true });
  return request(`/session/${id}/execute/sync`, "POST", {
    script:
      "return window.__SIGMA_DESKTOP_TEST__.queueFixtureSaves(arguments[0], arguments[1])",
    args: [destination, positions],
  });
}

async function snapshot(id) {
  return request(`/session/${id}/execute/sync`, "POST", {
    script: "return window.__SIGMA_DESKTOP_TEST__.sessionSnapshot()",
    args: [],
  });
}
try {
  const generated = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=64x64:rate=15",
      "-t",
      "2",
      "-c:v",
      "mpeg4",
      "-threads",
      "1",
      video,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    generated.status,
    0,
    `Could not generate video fixture: ${generated.stderr ?? generated.error}`,
  );
  let first = await launch(true);
  const staleOptIn = await request(`/session/${first}/execute/sync`, "POST", {
    script:
      "return localStorage.getItem('sigma.nativeVideo.enabled') === 'true'",
    args: [],
  });
  if (staleOptIn) {
    await request(`/session/${first}/execute/sync`, "POST", {
      script:
        "localStorage.removeItem('sigma.nativeVideo.enabled'); window.__SIGMA_DESKTOP_TEST__.clearFixture(); return true",
      args: [],
    });
    await close(first);
    first = await launch(true);
  }
  const nativeCanvas = await request(`/session/${first}/execute/sync`, "POST", {
    script:
      "return typeof Worker !== 'undefined' && 'transferControlToOffscreen' in HTMLCanvasElement.prototype",
    args: [],
  });
  console.log(`WKWebView offscreen canvas support: ${nativeCanvas}`);
  await execute(
    first,
    `const [project, image, done] = arguments;
    (async () => {
      const result = await window.__SIGMA_DESKTOP_TEST__.saveFixture(project, image);
      done({ok:result.ok, reason:result.ok ? undefined : String(result.error ?? result.reason)});
    })().catch(e => done({ok:false, reason:String(e)}));`,
    [project, image],
  );
  const saved = JSON.parse(await readFile(project, "utf8"));
  assert.equal(saved.items[0].id, "lifecycle-image");
  assert.equal(saved.items[0].filePath, "fixture.png");
  assert.equal(saved.items.length, 2);
  assert.deepEqual(saved.items[1].crop, {
    top: 5,
    right: 10,
    bottom: 5,
    left: 10,
  });
  assert.deepEqual(saved.viewport, { x: 10, y: -20, zoom: 0.8 });
  await execute(
    first,
    `const done = arguments[0];
    window.__SIGMA_DESKTOP_TEST__.captureFrames().then(()=>done({ok:true}),e=>done({ok:false,reason:String(e)}));`,
    [],
  );
  const firstAllocation = await manifest(first, [video]);
  assert.ok(
    firstAllocation.states.some((state) => state.toLowerCase() === "active"),
    JSON.stringify(firstAllocation),
  );
  const removedDecoder = await decoderFor(child.pid);
  let frame;
  for (let attempt = 0; attempt < 100; attempt++) {
    frame = await request(`/session/${first}/execute/sync`, "POST", {
      script: "return window.__SIGMA_DESKTOP_TEST__.frameInfo()",
      args: [],
    });
    if (frame.packetBytes > 64) break;
    await delay(100);
  }
  assert.ok(
    frame.packetBytes > 64,
    `No decoded frame arrived: ${JSON.stringify(frame)}`,
  );
  assert.equal(frame.packetMagic, "SVF1");
  console.log(
    `Real decoded frame received: ${frame.packetBytes} bytes, magic ${frame.packetMagic}`,
  );
  await manifest(first, []);
  await decoderExited(removedDecoder, "manifest removal");
  await manifest(first, [video]);
  const canceledDecoder = await decoderFor(child.pid);
  await stopAll(first);
  await decoderExited(canceledDecoder, "stop all");
  await manifest(first, [video]);
  const closingDecoder = await decoderFor(child.pid);
  await request(`/session/${first}/execute/sync`, "POST", {
    script:
      "localStorage.setItem('sigma.nativeVideo.enabled', 'true'); return true",
    args: [],
  });
  await close(first);
  await decoderExited(closingDecoder, "application shutdown");
  const second = await launch(false);
  const restored = await request(`/session/${second}/execute/sync`, "POST", {
    script: "return window.__SIGMA_DESKTOP_TEST__.firstItem()",
    args: [],
  });
  assert.equal(restored.id, "lifecycle-image");
  assert.equal(restored.path, image);
  const restoredState = await snapshot(second);
  assert.equal(restoredState.items.length, 2);
  assert.equal(restoredState.items[1].x, 400);
  assert.equal(restoredState.items[1].y, 300);
  assert.deepEqual(restoredState.items[1].crop, saved.items[1].crop);
  assert.deepEqual(restoredState.viewport, saved.viewport);
  console.log(
    "Canvas session restored its image across restart before reopening the file.",
  );
  const loaded = await execute(
    second,
    `const [project, done] = arguments;
    (async () => {
      const result = await window.__SIGMA_DESKTOP_TEST__.reopenFixture(project);
      done(result);
    })().catch(e => done({ok:false, reason:String(e)}));`,
    [project],
  );
  assert.equal(loaded.id, "lifecycle-image");
  assert.equal(loaded.path, image);
  const probe = await execute(
    second,
    `const [image, done] = arguments;
    window.__TAURI_INTERNALS__.invoke('probe_images', {paths:[image]})
      .then(images=>done({ok:true,width:images[0]?.width,height:images[0]?.height}),
        e=>done({ok:false,reason:String(e)}));`,
    [image],
  );
  assert.equal(probe.width, 1);
  assert.equal(probe.height, 1);
  console.log(
    `Reopened image decoded through native probe: ${probe.width}x${probe.height}`,
  );
  const rendered = await request(`/session/${second}/execute/sync`, "POST", {
    script: "return document.querySelectorAll('.media-item').length",
    args: [],
  });
  assert.equal(rendered, 2);
  console.log(
    "Fixture-granted save, persisted scope, reopen and canvas rendering passed.",
  );
  let surfaceReady = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    surfaceReady = await request(`/session/${second}/execute/sync`, "POST", {
      script:
        "return !!window.__SIGMA_DESKTOP_TEST__ && !!document.querySelector('.native-video-surface')",
      args: [],
    });
    if (surfaceReady) break;
    await delay(100);
  }
  assert.equal(surfaceReady, true, "Native video surface did not start");
  await request(`/session/${second}/execute/sync`, "POST", {
    script:
      "window.__SIGMA_DESKTOP_TEST__.replaceWithVideo(arguments[0]); return true",
    args: [video],
  });
  const uiRemovedDecoder = await decoderFor(child.pid);
  await request(`/session/${second}/execute/sync`, "POST", {
    script: "window.__SIGMA_DESKTOP_TEST__.removeVideos(); return true",
    args: [],
  });
  await decoderExited(uiRemovedDecoder, "frontend media removal");
  await request(`/session/${second}/execute/sync`, "POST", {
    script:
      "window.__SIGMA_DESKTOP_TEST__.replaceWithVideo(arguments[0]); return true",
    args: [video],
  });
  const replacedDecoder = await decoderFor(child.pid);
  await execute(
    second,
    `const [project, done] = arguments;
    window.__SIGMA_DESKTOP_TEST__.reopenFixture(project).then(done,e=>done({ok:false,reason:String(e)}));`,
    [project],
  );
  await decoderExited(replacedDecoder, "frontend session replacement");
  await request(`/session/${second}/execute/sync`, "POST", {
    script:
      "localStorage.removeItem('sigma.nativeVideo.enabled'); window.__SIGMA_DESKTOP_TEST__.clearFixture(); return true",
    args: [],
  });
  await close(second);

  // The write barrier runs after fsync of the temporary file, before rename.
  // Closing here must drain both requested store snapshots in order.
  const racing = await launch(true, 1500);
  await execute(
    racing,
    `const [project, done] = arguments;
    window.__SIGMA_DESKTOP_TEST__.reopenFixture(project).then(done);`,
    [project],
  );
  await queueSaves(racing, [100, 200]);
  await waitForWrite();
  assert.equal(JSON.parse(await readFile(project, "utf8")).items[0].x, 40);
  const closeStarted = performance.now();
  // Repeated requests must join the same pending shutdown.
  await request(`/session/${racing}/window`, "DELETE");
  await close(racing);
  assert.equal(JSON.parse(await readFile(project, "utf8")).items[0].x, 200);
  console.log(
    `Close drained two pending saves in ${(performance.now() - closeStarted).toFixed(0)} ms`,
  );

  // Forced process termination is a separate test, never described as graceful.
  const crashing = await launch(true, 1500);
  assert.equal((await snapshot(crashing)).items[0].x, 200);
  await queueSaves(crashing, [300]);
  await waitForWrite();
  const crashed = new Promise((ok) =>
    child.once("exit", (code, signal) => ok({ code, signal })),
  );
  child.kill("SIGKILL");
  assert.equal((await crashed).signal, "SIGKILL");
  child = undefined;
  currentSession = undefined;
  assert.equal(JSON.parse(await readFile(project, "utf8")).items[0].x, 200);
  console.log("SIGKILL before rename preserved the previous committed canvas");

  const recovered = await launch(true);
  await execute(
    recovered,
    `const [project, done] = arguments;
    window.__SIGMA_DESKTOP_TEST__.reopenFixture(project).then(done);`,
    [project],
  );
  assert.equal((await snapshot(recovered)).items[0].x, 200);

  // A rejected native save keeps the process alive, then permits a real retry.
  await queueSaves(recovered, [400], join(directory, "not-granted.json"));
  await request(`/session/${recovered}/window`, "DELETE");
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await snapshot(recovered);
    if (!state.inert && state.isDirty) break;
    await delay(50);
  }
  assert.equal(child.exitCode, null);
  assert.equal((await snapshot(recovered)).isDirty, true);
  assert.equal((await snapshot(recovered)).inert, false);
  await queueSaves(recovered, [401]);
  await close(recovered);
  assert.equal(JSON.parse(await readFile(project, "utf8")).items[0].x, 401);
  console.log(
    "Failed save prevented exit; successful retry committed before exit",
  );

  // This command bypasses the frontend store queue: the native operation guard
  // must still keep the process alive until its atomic replacement completes.
  const direct = await launch(true, 1500);
  const directContents = JSON.parse(await readFile(project, "utf8"));
  directContents.items[0].x = 450;
  await rm(join(directory, "save-started"), { force: true });
  await request(`/session/${direct}/execute/sync`, "POST", {
    script:
      "window.__TAURI_INTERNALS__.invoke('save_canvas_atomic', {path:arguments[0], contents:arguments[1]}).catch(console.error); return true",
    args: [project, JSON.stringify(directContents)],
  });
  await waitForWrite();
  await close(direct);
  assert.equal(JSON.parse(await readFile(project, "utf8")).items[0].x, 450);
  console.log(
    "Native shutdown drained a write outside the frontend save queue",
  );

  const quitting = await launch(true, 1500);
  await queueSaves(quitting, [475]);
  await waitForWrite();
  await close(quitting, true);
  assert.equal(JSON.parse(await readFile(project, "utf8")).items[0].x, 475);
  console.log("Native application quit drained the pending save");

  const stalled = await launch(true, 15000);
  await queueSaves(stalled, [500]);
  await waitForWrite();
  await request(`/session/${stalled}/window`, "DELETE");
  let observedWaiting = false;
  let observedTimeout = false;
  for (let attempt = 0; attempt < 130; attempt++) {
    const state = await snapshot(stalled);
    observedWaiting ||= state.inert;
    if (observedWaiting && !state.inert) {
      observedTimeout = true;
      break;
    }
    await delay(100);
  }
  assert.equal(
    observedTimeout,
    true,
    "Shutdown must time out and restore interaction",
  );
  assert.equal(child.exitCode, null);
  // Wait for the original acknowledgment, which is now stale, to arrive.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await snapshot(stalled)).isDirty) break;
    await delay(100);
  }
  assert.equal(JSON.parse(await readFile(project, "utf8")).items[0].x, 500);
  await delay(250);
  assert.equal(
    child.exitCode,
    null,
    "A stale acknowledgment must not exit the process",
  );
  await close(stalled);
  console.log(
    "Ten-second deadline retained the process; late acknowledgment could not exit it",
  );

  // Missing source files retain their identity and geometry on reopen.
  await rm(image);
  const missing = await launch(true);
  await execute(
    missing,
    `const [project, done] = arguments;
    window.__SIGMA_DESKTOP_TEST__.reopenFixture(project).then(done);`,
    [project],
  );
  const missingState = await snapshot(missing);
  assert.equal(missingState.items[0].filePath, image);
  assert.equal(missingState.items[0].x, 500);
  await close(missing);
  console.log("Missing media retained canvas identity and geometry");

  // A protected recovery value must survive a launch, an export, and any
  // ordinary edits until the user deliberately discards it. The exported file
  // uses the disposable, pre-granted canvas path after its old fixture is gone.
  await rm(project);
  const corrupt = "{broken native recovery";
  const seed = await launch(true);
  await request(`/session/${seed}/execute/sync`, "POST", {
    script:
      "window.__SIGMA_DESKTOP_TEST__.clearFixture(); localStorage.setItem('sigma:canvas-session', arguments[0]); return true",
    args: [corrupt],
  });
  await close(seed);
  const protectedLaunch = await launch(true);
  let recoveryShown = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    recoveryShown = await request(
      `/session/${protectedLaunch}/execute/sync`,
      "POST",
      {
        script:
          "return document.body.innerText.includes('Canvas recovery failed')",
        args: [],
      },
    );
    if (recoveryShown) break;
    await delay(100);
  }
  assert.equal(
    recoveryShown,
    true,
    "Protected recovery warning was not visible",
  );
  await execute(
    protectedLaunch,
    `const [path, done] = arguments;
    window.__SIGMA_DESKTOP_TEST__.exportProtectedRecoveryData(path).then(done);`,
    [project],
  );
  assert.equal(await readFile(project, "utf8"), corrupt);
  assert.equal(
    await request(`/session/${protectedLaunch}/execute/sync`, "POST", {
      script: "return window.__SIGMA_DESKTOP_TEST__.recoveryValue()",
      args: [],
    }),
    corrupt,
  );
  let discardClicked = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    discardClicked = await request(
      `/session/${protectedLaunch}/execute/sync`,
      "POST",
      {
        script:
          "const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('Discard original data')); if (button) button.click(); return !!button",
        args: [],
      },
    );
    if (discardClicked) break;
    await delay(100);
  }
  assert.equal(
    discardClicked,
    true,
    "Discard action was not visible after export",
  );
  const replacement = await request(
    `/session/${protectedLaunch}/execute/sync`,
    "POST",
    {
      script: "return window.__SIGMA_DESKTOP_TEST__.recoveryValue()",
      args: [],
    },
  );
  assert.notEqual(replacement, corrupt);
  assert.deepEqual(JSON.parse(replacement).state.items, []);
  await close(protectedLaunch);
  const cleanLaunch = await launch(true);
  assert.equal(
    await request(`/session/${cleanLaunch}/execute/sync`, "POST", {
      script:
        "return document.body.innerText.includes('Canvas recovery failed')",
      args: [],
    }),
    false,
  );
  assert.deepEqual(
    JSON.parse(
      await request(`/session/${cleanLaunch}/execute/sync`, "POST", {
        script: "return window.__SIGMA_DESKTOP_TEST__.recoveryValue()",
        args: [],
      }),
    ).state.items,
    [],
  );
  await close(cleanLaunch);
  console.log(
    "Protected recovery exported, explicitly discarded, and stayed clear on relaunch",
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    if (currentSession) {
      try {
        await request(`/session/${currentSession}/execute/sync`, "POST", {
          script:
            "localStorage.removeItem('sigma.nativeVideo.enabled'); window.__SIGMA_DESKTOP_TEST__?.clearFixture(); return true",
          args: [],
        });
      } catch (error) {
        console.error(`Could not clear isolated test state: ${String(error)}`);
      }
    }
    child.kill("SIGKILL");
    await new Promise((ok) => child.once("exit", ok));
  }
  for (const pid of decoderPids) {
    if (commandFor(pid).includes(video)) {
      console.error(`Cleaning up surviving fixture decoder ${pid}`);
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  await rm(directory, { recursive: true, force: true });
}
