// scripts/run-pre-push.mjs
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const hook = ".githooks/pre-push";

if (!existsSync(hook)) {
  console.error(`Missing ${hook}`);
  process.exit(1);
}

const candidates =
  process.platform === "win32"
    ? [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
        "bash",
      ]
    : ["bash", "sh"];

let result;

for (const shell of candidates) {
  result = spawnSync(shell, [hook], {
    stdio: "inherit",
    shell: false,
  });

  if (result.error?.code === "ENOENT") {
    continue;
  }

  process.exit(result.status ?? 1);
}

console.error("Could not find bash/sh. Install Git for Windows or MSYS2.");
process.exit(1);
