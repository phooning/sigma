import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notify } from "../utils/notifications";
import { createSessionStorage } from "./sessionStorage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../utils/notifications", () => ({
  notify: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}));

describe("session recovery storage", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("surfaces quota failures without breaking in-memory editing and recovers on retry", () => {
    const storage = createSessionStorage();
    const valid = JSON.stringify({ state: { items: [] }, version: 0 });
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new Error("quota exceeded");
      });
    expect(() => storage.setItem("recovery-test", valid)).not.toThrow();
    expect(() => storage.assertWritable()).toThrow("quota exceeded");
    storage.setItem("recovery-test", valid);
    expect(write).toHaveBeenCalledTimes(2);
    expect(() => storage.assertWritable()).not.toThrow();
    localStorage.removeItem("recovery-test");
  });

  it("exports exact invalid recovery bytes while keeping the original protected", async () => {
    const storage = createSessionStorage();
    const original = "{broken original bytes";
    localStorage.setItem("recovery-test", original);
    expect(() => storage.getItem("recovery-test")).toThrow();
    vi.mocked(save).mockResolvedValue("/backup.json");
    await storage.exportRecoveryData("recovery-test");
    expect(invoke).toHaveBeenCalledWith("save_canvas_atomic", {
      path: "/backup.json",
      contents: original,
      createOnly: true,
    });
    expect(localStorage.getItem("recovery-test")).toBe(original);
    storage.setItem("recovery-test", "new state");
    expect(localStorage.getItem("recovery-test")).toBe(original);
    expect(notify.success).toHaveBeenCalled();
    expect(storage.discardRecoveryData("recovery-test")).toBe(true);
    expect(localStorage.getItem("recovery-test")).toBeNull();
    localStorage.removeItem("recovery-test");
  });

  it("requires a successful export before discard and restores persistence afterward", async () => {
    const original = "{broken recovery";
    const valid = JSON.stringify({ state: { items: [] }, version: 0 });
    localStorage.setItem("recovery-test", original);
    let storage!: ReturnType<typeof createSessionStorage>;
    storage = createSessionStorage(() =>
      storage.setItem("recovery-test", valid),
    );
    expect(() => storage.getItem("recovery-test")).toThrow();
    expect(storage.discardRecoveryData("recovery-test")).toBe(false);
    vi.mocked(save).mockResolvedValueOnce(null);
    expect(await storage.exportRecoveryData("recovery-test")).toBe(false);
    expect(storage.discardRecoveryData("recovery-test")).toBe(false);
    expect(localStorage.getItem("recovery-test")).toBe(original);
    vi.mocked(save).mockResolvedValueOnce("/backup.json");
    vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));
    expect(await storage.exportRecoveryData("recovery-test")).toBe(false);
    expect(storage.discardRecoveryData("recovery-test")).toBe(false);
    expect(localStorage.getItem("recovery-test")).toBe(original);
    vi.mocked(save).mockResolvedValueOnce("/backup.json");
    expect(await storage.exportRecoveryData("recovery-test")).toBe(true);
    expect(storage.discardRecoveryData("recovery-test")).toBe(true);
    expect(localStorage.getItem("recovery-test")).toBe(valid);
    expect(() => createSessionStorage().getItem("recovery-test")).not.toThrow();
    localStorage.removeItem("recovery-test");
  });

  it("does not treat an export from an earlier launch as permission to discard", async () => {
    const original = "{broken recovery";
    localStorage.setItem("recovery-test", original);
    const first = createSessionStorage();
    expect(() => first.getItem("recovery-test")).toThrow();
    vi.mocked(save).mockResolvedValue("/backup.json");
    expect(await first.exportRecoveryData("recovery-test")).toBe(true);
    const second = createSessionStorage();
    expect(() => second.getItem("recovery-test")).toThrow();
    expect(second.discardRecoveryData("recovery-test")).toBe(false);
    expect(localStorage.getItem("recovery-test")).toBe(original);
    localStorage.removeItem("recovery-test");
  });

  it("reports a failed post-discard snapshot without claiming the original remains", async () => {
    const original = "{broken recovery";
    localStorage.setItem("recovery-test", original);
    const storage = createSessionStorage(() => {
      throw new Error("quota exceeded");
    });
    expect(() => storage.getItem("recovery-test")).toThrow();
    expect(
      await storage.exportRecoveryData("recovery-test", "/backup.json"),
    ).toBe(true);
    expect(storage.discardRecoveryData("recovery-test")).toBe(true);
    expect(localStorage.getItem("recovery-test")).toBeNull();
    expect(() => storage.assertWritable()).toThrow("quota exceeded");
    expect(notify.error).toHaveBeenCalledWith(
      "Session recovery could not be saved",
      expect.objectContaining({
        description: expect.stringContaining("original data was discarded"),
      }),
    );
  });

  it("refuses an invalid recovery snapshot before it can replace a valid one", () => {
    const storage = createSessionStorage();
    const valid = JSON.stringify({ state: { items: [] }, version: 0 });
    storage.setItem("recovery-test", valid);
    storage.setItem(
      "recovery-test",
      JSON.stringify({
        state: { items: [{ id: "bad", x: null }] },
        version: 0,
      }),
    );
    expect(localStorage.getItem("recovery-test")).toBe(valid);
    expect(() => storage.assertWritable()).toThrow();
    localStorage.removeItem("recovery-test");
  });
});
