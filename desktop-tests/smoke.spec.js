import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("real Tauri desktop", () => {
  it("initializes the canvas and calls a native command", async () => {
    const canvas = await $(".canvas-container");
    await canvas.waitForDisplayed({ timeout: 30000 });
    await $('button[aria-label="Open settings"]').click();
    await $('[role="dialog"]').waitForDisplayed({ timeout: 10000 });
    const stats = await browser.executeAsync((done) => {
      window.__TAURI_INTERNALS__.invoke("media_cache_stats").then(
        (value) => done({ value }),
        (error) => done({ error: String(error) }),
      );
    });
    assert.equal(stats.error, undefined, `native IPC failed: ${stats.error}`);
    assert.equal(typeof stats.value.totalBytes, "number");
  });

  it("rejects a canvas write without a filesystem grant", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sigma-desktop-"));
    const destination = join(directory, "canvas.json");
    try {
      const outcome = await browser.executeAsync((path, done) => {
        window.__TAURI_INTERNALS__
          .invoke("save_canvas_atomic", {
            path,
            contents: "{}",
          })
          .then(
            () => done({ ok: true }),
            (error) => done({ ok: false, message: String(error) }),
          );
      }, destination);
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /scope/i);
      assert.equal(existsSync(destination), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
