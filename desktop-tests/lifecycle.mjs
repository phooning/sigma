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
async function launch(grant) {
  port = await choosePort();
  const env = {
    ...process.env,
    TAURI_WEBDRIVER_PORT: String(port),
    WDIO_EMBEDDED_SERVER: "true",
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
async function close(id) {
  const stopped = new Promise((ok, fail) => {
    const timer = setTimeout(
      () =>
        fail(
          new Error(`Application ${child.pid} did not exit after window close`),
        ),
      10000,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      ok({ code, signal });
    });
  });
  try {
    await request(`/session/${id}/window`, "DELETE");
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
  assert.equal(rendered, 1);
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
