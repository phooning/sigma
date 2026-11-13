// Native filesystem-fault scenario (macOS, test build with the WebDriver
// plugin). Mounts a disposable 4 MiB HFS+ image as the app's fixture folder and
// drives real saves through the production save queue:
//   A. disk full during save       B. folder made read-only (temp creation fails)
//   C. retry after each failure commits the newest state, never an older one
//   D. shutdown is refused while the last save failed
// Never touches the user's disk beyond the mounted image. Run directly:
//   node desktop-tests/disk-faults.ts   (after `pnpm test:desktop` built the app)
import assert from "node:assert/strict";
import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const binary = resolve("src-tauri/target/debug/sigma");
const reportPath =
  process.env.SIGMA_DISK_FAULT_REPORT ??
  resolve("desktop-test-results/disk-faults.json");
const work = realpathSync(mkdtempSync(join(tmpdir(), "sigma-diskfault-work-")));
const image = join(work, "volume.dmg");
// The test build grants canvas.json inside a temp folder named sigma-desktop-*.
const mount = join(
  realpathSync(tmpdir()),
  `sigma-desktop-diskfault-${process.pid}`,
);
const mediaDir = realpathSync(
  mkdtempSync(join(tmpdir(), "sigma-desktop-media-diskfault-")),
);
const project = join(mount, "canvas.json");
const results: Array<Record<string, unknown>> = [];
let attached = false;
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
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
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
const run = async <T>(script: string, args: unknown[] = []) =>
  (await request(`/session/${session}/execute/async`, "POST", {
    script: `const done = arguments[arguments.length - 1]; const args = Array.from(arguments).slice(0, -1);
      (async () => { ${script} })().then(done, (e) => done({ failed: String(e) }));`,
    args,
  })) as T;

type Snapshot = { isDirty: boolean; items: Array<{ x: number }> };
const snapshot = async () =>
  (await sync(
    "return window.__SIGMA_DESKTOP_TEST__.sessionSnapshot()",
  )) as Snapshot;
const onDiskX = () =>
  (
    JSON.parse(readFileSync(project, "utf8")) as { items: Array<{ x: number }> }
  ).items.map((i) => i.x);
const leftovers = () =>
  readdirSync(mount).filter((name) => name.startsWith(".sigma-canvas-"));
const saveAt = async (x: number) => {
  await run(
    "window.__SIGMA_DESKTOP_TEST__.queueFixtureSaves(args[0], [args[1]]); await new Promise((r) => setTimeout(r, 1200)); return true;",
    [project, x],
  );
  return snapshot();
};
const fill = () => {
  const fd = openSync(join(mount, "filler"), "w");
  const chunk = Buffer.alloc(16 * 1024, 0x61);
  try {
    for (;;) writeSync(fd, chunk);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOSPC") throw error;
  } finally {
    closeSync(fd);
  }
  // Fill the remaining partial block too.
  const tail = openSync(join(mount, "filler-tail"), "w");
  try {
    for (;;) writeSync(tail, Buffer.alloc(512, 0x62));
  } catch {
  } finally {
    closeSync(tail);
  }
};
const record = (
  name: string,
  pass: boolean,
  detail: Record<string, unknown>,
) => {
  results.push({ name, pass, ...detail });
  console.log(
    `[disk-faults] ${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`,
  );
};

try {
  execFileSync("hdiutil", [
    "create",
    "-size",
    "4m",
    "-fs",
    "HFS+",
    "-volname",
    "sigma-fault",
    "-quiet",
    image,
  ]);
  execFileSync("hdiutil", [
    "attach",
    image,
    "-mountpoint",
    mount,
    "-nobrowse",
    "-noautoopen",
    "-quiet",
  ]);
  attached = true;
  const video = join(mediaDir, "clip.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=30",
    "-t",
    "2",
    "-pix_fmt",
    "yuv420p",
    "-y",
    video,
  ]);

  port = await choosePort();
  child = spawn(binary, [], {
    env: {
      ...process.env,
      TAURI_WEBDRIVER_PORT: String(port),
      WDIO_EMBEDDED_SERVER: "true",
      SIGMA_DESKTOP_MEDIA_DIRS: mediaDir,
      SIGMA_DESKTOP_FIXTURE_DIR: mount,
    },
    stdio: ["ignore", "ignore", "pipe"],
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
  session = (
    (await request("/session", "POST", {
      capabilities: { alwaysMatch: {} },
    })) as { sessionId: string }
  ).sessionId;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (
      await sync(
        "return !!window.__SIGMA_DESKTOP_TEST__ && !!document.querySelector('.canvas-container')",
      )
    )
      break;
    await delay(100);
  }
  await run("window.__SIGMA_DESKTOP_TEST__.clearFixture(); return true;");
  await run(
    "return await window.__SIGMA_DESKTOP_TEST__.importPaths(args[0]);",
    [[video]],
  );

  // Baseline committed save.
  let state = await saveAt(100);
  assert.deepEqual(onDiskX(), [100]);
  assert.equal(state.isDirty, false);
  const baseline = readFileSync(project);

  // A. Disk full.
  fill();
  state = await saveAt(200);
  const recoveryCopy = String(
    await sync("return localStorage.getItem('sigma:canvas-session')"),
  );
  record(
    "disk-full: original bytes intact",
    readFileSync(project).equals(baseline),
    { onDisk: onDiskX() },
  );
  record("disk-full: session stays dirty", state.isDirty === true, {
    isDirty: state.isDirty,
  });
  record("disk-full: no temporary file left", leftovers().length === 0, {
    leftovers: leftovers(),
  });
  record(
    "disk-full: recovery copy holds unsaved edit",
    recoveryCopy.includes('"x":200'),
    {},
  );
  const toast = String(await sync("return document.body.innerText"));
  record("disk-full: error surfaced to the user", /Save failed/.test(toast), {
    message: toast.match(/Cannot (write|sync|create)[^\n]*/)?.[0] ?? null,
  });

  // D. Close is refused while the last save failed.
  const closeAttempt = await run<{ inert: boolean }>(
    "try { await window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }); } catch (e) {} await new Promise((r) => setTimeout(r, 1500)); return window.__SIGMA_DESKTOP_TEST__.sessionSnapshot();",
  ).catch(() => null);
  record(
    "disk-full: close refused after failed save",
    child.exitCode === null,
    {
      snapshot: closeAttempt,
    },
  );

  // C. Free space, edit further, retry: the newest state is committed.
  rmSync(join(mount, "filler"));
  rmSync(join(mount, "filler-tail"), { force: true });
  state = await saveAt(300);
  record(
    "retry after disk-full commits newest state",
    onDiskX()[0] === 300 && !state.isDirty,
    {
      onDisk: onDiskX(),
      isDirty: state.isDirty,
    },
  );

  // B. Folder becomes read-only: the temporary file cannot be created.
  const committed = readFileSync(project);
  chmodSync(mount, 0o555);
  state = await saveAt(400);
  record(
    "read-only folder: original bytes intact",
    readFileSync(project).equals(committed),
    {
      onDisk: onDiskX(),
    },
  );
  record("read-only folder: session stays dirty", state.isDirty === true, {
    isDirty: state.isDirty,
  });
  chmodSync(mount, 0o755);
  state = await saveAt(500);
  record(
    "retry after read-only commits newest state",
    onDiskX()[0] === 500 && !state.isDirty,
    {
      onDisk: onDiskX(),
    },
  );

  // Graceful close now succeeds.
  const exited = new Promise<number | null>((ok) =>
    child?.once("exit", (code) => ok(code)),
  );
  await request(`/session/${session}/window`, "DELETE").catch(() => undefined);
  const code = await Promise.race([
    exited,
    delay(20_000).then(() => "timeout"),
  ]);
  record("close succeeds once saved", code === 0, { code });
  child = undefined;
} catch (error) {
  record("scenario completed", false, {
    error: String((error as Error).stack ?? error),
  });
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  if (attached) {
    try {
      chmodSync(mount, 0o755);
    } catch {}
    spawnSync("hdiutil", ["detach", mount, "-force", "-quiet"]);
  }
  if (existsSync(mount)) rmSync(mount, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  rmSync(mediaDir, { recursive: true, force: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      { schema: "sigma.disk-faults.v1", at: new Date().toISOString(), results },
      null,
      2,
    ),
  );
  const failed = results.filter((entry) => !entry.pass);
  console.log(
    `[disk-faults] ${results.length - failed.length}/${results.length} passed`,
  );
  if (failed.length) process.exitCode = 1;
}
