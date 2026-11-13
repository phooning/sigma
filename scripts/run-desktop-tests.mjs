import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve as resolvePath } from "node:path";

if (process.platform !== "darwin") {
  console.error(
    "The embedded desktop smoke test is currently verified only on macOS.",
  );
  process.exit(1);
}
let diagnostics = "";
function preserveFailure() {
  mkdirSync("desktop-test-results", { recursive: true });
  const path = `desktop-test-results/desktop-failure-${Date.now()}-${process.pid}.log`;
  writeFileSync(path, diagnostics);
  console.error(`Desktop test diagnostics saved to ${path}`);
}
const build = spawnSync(
  "pnpm",
  [
    "tauri",
    "build",
    "--debug",
    "--no-bundle",
    "--features",
    "tauri-plugin-wdio-webdriver",
    "--config",
    JSON.stringify({
      identifier: `com.asynthetic.sigmacanvas.desktoptest.run${Date.now()}`,
      app: { withGlobalTauri: true },
      build: {
        beforeBuildCommand:
          "pnpm exec tsc && pnpm exec vite build --mode desktop-test --outDir desktop-tests/dist",
        frontendDist: "../desktop-tests/dist",
      },
    }),
  ],
  {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, VITE_SIGMA_DESKTOP_TEST: "1" },
  },
);
diagnostics += (build.stdout ?? "") + (build.stderr ?? "");
process.stdout.write(build.stdout ?? "");
process.stderr.write(build.stderr ?? "");
if (build.status !== 0) {
  diagnostics += String(build.error ?? "");
  preserveFailure();
  rmSync("desktop-tests/dist", { recursive: true, force: true });
  process.exit(build.status ?? 1);
}

const server = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    "1420",
    "--strictPort",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
server.stdout.pipe(process.stdout);
server.stderr.pipe(process.stderr);
server.stdout.on("data", (chunk) => {
  diagnostics += String(chunk);
});
server.stderr.on("data", (chunk) => {
  diagnostics += String(chunk);
});
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Vite startup timed out.")),
      15000,
    );
    server.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Vite exited before tests: ${code}`));
    });
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Local:")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  const portProbe = createServer();
  await new Promise((resolve, reject) => {
    portProbe.once("error", reject);
    portProbe.listen(0, "127.0.0.1", resolve);
  });
  const driverPort = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const test = spawn(
    "pnpm",
    ["exec", "wdio", "run", "desktop-tests/wdio.conf.js"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SIGMA_DESKTOP_DRIVER_PORT: String(driverPort) },
    },
  );
  let testOutput = "";
  for (const [stream, output] of [
    [test.stdout, process.stdout],
    [test.stderr, process.stderr],
  ]) {
    stream.on("data", (chunk) => {
      testOutput += String(chunk);
      diagnostics += String(chunk);
      output.write(chunk);
    });
  }
  const result = await new Promise((resolve, reject) => {
    test.on("error", reject);
    test.on("close", (code) => resolve(code ?? 1));
  });
  const appPids = [
    ...testOutput.matchAll(/Tauri app spawned \(PID: (\d+)\)/g),
  ].map((match) => Number(match[1]));
  if (appPids.length !== 1)
    throw new Error(
      `Expected one managed app process, found ${appPids.length}`,
    );
  for (const pid of appPids) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      alive = false;
    }
    if (!alive) {
      console.log(`Managed desktop app ${pid} exited after service cleanup`);
      continue;
    }
    let command = "";
    try {
      command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {}
    if (command.includes(resolvePath("src-tauri/target/debug/sigma"))) {
      process.kill(pid, "SIGKILL");
    }
    throw new Error(
      `Managed desktop app PID ${pid} remains present after service cleanup`,
    );
  }
  if (result !== 0) {
    process.exitCode = result;
  } else {
    const lifecycle = spawn(process.execPath, ["desktop-tests/lifecycle.mjs"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const [stream, output] of [
      [lifecycle.stdout, process.stdout],
      [lifecycle.stderr, process.stderr],
    ]) {
      stream.on("data", (chunk) => {
        diagnostics += String(chunk);
        output.write(chunk);
      });
    }
    process.exitCode = await new Promise((resolve, reject) => {
      lifecycle.on("error", reject);
      lifecycle.on("close", (code) => resolve(code ?? 1));
    });
    // Optional real-media scenario, requested by scripts/media/run-media-suite.ts.
    if (process.exitCode === 0 && process.env.SIGMA_DESKTOP_MEDIA_PLAN) {
      const media = spawn(process.execPath, ["desktop-tests/media-corpus.ts"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const [stream, output] of [
        [media.stdout, process.stdout],
        [media.stderr, process.stderr],
      ]) {
        stream.on("data", (chunk) => {
          diagnostics += String(chunk);
          output.write(chunk);
        });
      }
      process.exitCode = await new Promise((resolve, reject) => {
        media.on("error", reject);
        media.on("close", (code) => resolve(code ?? 1));
      });
    }
    // Optional bounded native endurance scenario (generated media only).
    if (process.exitCode === 0 && process.env.SIGMA_DESKTOP_ENDURANCE) {
      const endurance = spawn(
        process.execPath,
        ["desktop-tests/endurance.ts"],
        { stdio: "inherit" },
      );
      process.exitCode = await new Promise((resolve, reject) => {
        endurance.on("error", reject);
        endurance.on("close", (code) => resolve(code ?? 1));
      });
    }
  }
} catch (error) {
  console.error(error);
  diagnostics += `\n${String(error)}\n`;
  process.exitCode = 1;
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await stopped;
  }
  rmSync("desktop-tests/dist", { recursive: true, force: true });
  if (process.exitCode) preserveFailure();
}
