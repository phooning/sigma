import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionStorage } from "./sessionStorage";

vi.mock("../utils/notifications", () => ({ notify: { error: vi.fn() } }));

describe("session recovery storage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("surfaces quota failures without breaking in-memory editing and recovers on retry", () => {
    const storage = createSessionStorage();
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new Error("quota exceeded");
      });
    expect(() => storage.setItem("recovery-test", "new state")).not.toThrow();
    expect(() => storage.assertWritable()).toThrow("quota exceeded");
    storage.setItem("recovery-test", "new state");
    expect(write).toHaveBeenCalledTimes(2);
    expect(() => storage.assertWritable()).not.toThrow();
    localStorage.removeItem("recovery-test");
  });
});
