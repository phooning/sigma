/**
 * Real out-of-space save test (macOS only).
 *
 * Creates a 4 MiB disposable HFS+ disk image, mounts it privately under the OS
 * temp directory, seeds a canvas, fills the remaining space, and runs the
 * ignored `disk_full_preserves_original_and_removes_temporary` Rust test
 * against it. The image is always detached and deleted afterwards.
 *
 *   node scripts/fs-faults/disk-full.ts
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "darwin") {
  console.error("disk-full fault test requires macOS hdiutil");
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "sigma-disk-full-"));
const image = join(work, "full.dmg");
const mount = join(work, "volume");
let attached = false;

const cleanup = () => {
  if (attached)
    spawnSync("hdiutil", ["detach", mount, "-force", "-quiet"], {
      stdio: "inherit",
    });
  rmSync(work, { recursive: true, force: true });
};

try {
  execFileSync("hdiutil", [
    "create",
    "-size",
    "4m",
    "-fs",
    "HFS+",
    "-volname",
    "sigma-full",
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
  const original = JSON.stringify({ schemaVersion: 1, items: [] });
  writeFileSync(join(mount, "canvas.json"), original);

  // Fill the volume until the kernel reports ENOSPC.
  const filler = openSync(join(mount, "filler"), "w");
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let filled = 0;
  try {
    for (;;) filled += writeSync(filler, chunk);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOSPC") throw error;
  } finally {
    closeSync(filler);
  }
  console.log(`filled ${filled} bytes; volume is out of space`);

  const result = spawnSync(
    "cargo",
    [
      "test",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--lib",
      "--",
      "--ignored",
      "--exact",
      "canvas_persistence::tests::disk_full_preserves_original_and_removes_temporary",
    ],
    { stdio: "inherit", env: { ...process.env, SIGMA_FULL_VOLUME_DIR: mount } },
  );
  process.exitCode = result.status ?? 1;
} finally {
  cleanup();
}
