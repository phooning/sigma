import { invoke } from "@tauri-apps/api/core";
import { type EventCallback, listen } from "@tauri-apps/api/event";
import { describe, expect, it, vi } from "vitest";
import {
  prepareSessionShutdown,
  resumeSession,
} from "../stores/useCanvasSessionStore";
import {
  installApplicationLifecycle,
  installNativeLifecycle,
} from "./applicationLifecycle";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../stores/useCanvasSessionStore", () => ({
  prepareSessionShutdown: vi.fn(),
  resumeSession: vi.fn(),
}));

vi.mock("../utils/notifications", () => ({ notify: { error: vi.fn() } }));

function fixture() {
  let request!: (id: number) => void;
  let finish!: () => void;
  const dispose = vi.fn();
  const boundary = {
    listen: vi.fn(async (callback: (id: number) => void) => {
      request = callback;
      return dispose;
    }),
    ready: vi.fn(async () => {}),
    complete: vi.fn(async (_id: number, _error: string | null) => {}),
    flush: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  return {
    boundary,
    dispose,
    request: (id: number) => request(id),
    finish: () => finish(),
  };
}

describe("application shutdown handshake", () => {
  it("does not thaw a newer close request when an old acknowledgment fails", async () => {
    const handlers = new Map<string, EventCallback<unknown>>();
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      handlers.set(event, handler as EventCallback<unknown>);
      return vi.fn();
    });
    let finish!: () => void;
    vi.mocked(prepareSessionShutdown)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockImplementationOnce(() => new Promise<void>(() => {}));
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "complete_shutdown") throw new Error("old response lost");
    });
    const stop = installNativeLifecycle();
    await vi.waitFor(() =>
      expect(handlers.has("sigma:shutdown-failed")).toBe(true),
    );
    const emit = (event: string, payload: unknown) =>
      handlers.get(event)?.({ event, id: 0, payload });
    emit("sigma:shutdown-request", 1);
    expect(document.documentElement.inert).toBe(true);
    emit("sigma:shutdown-failed", { id: 1, message: "timeout" });
    expect(document.documentElement.inert).toBeFalsy();
    emit("sigma:shutdown-request", 2);
    finish();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("complete_shutdown", {
        id: 1,
        error: null,
      }),
    );
    expect(document.documentElement.inert).toBe(true);
    expect(resumeSession).toHaveBeenCalledOnce();
    stop();
  });

  it("registers before readiness, coalesces close requests and acknowledges only after flush", async () => {
    const f = fixture();
    const stop = installApplicationLifecycle(f.boundary);
    expect(f.boundary.ready).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.boundary.ready).toHaveBeenCalledOnce());
    f.request(1);
    f.request(1);
    expect(f.boundary.flush).toHaveBeenCalledOnce();
    expect(f.boundary.complete).not.toHaveBeenCalled();
    f.finish();
    await vi.waitFor(() =>
      expect(f.boundary.complete).toHaveBeenCalledWith(1, null),
    );
    stop();
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it("reports a flush failure to native code rather than authorizing exit", async () => {
    const f = fixture();
    f.boundary.flush.mockRejectedValue(new Error("disk full"));
    const stop = installApplicationLifecycle(f.boundary);
    f.request(5);
    await vi.waitFor(() =>
      expect(f.boundary.complete).toHaveBeenCalledWith(5, "Error: disk full"),
    );
    stop();
  });

  it("disposes a late listener without announcing readiness", async () => {
    const f = fixture();
    const stop = installApplicationLifecycle(f.boundary);
    stop();
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
    expect(f.boundary.ready).not.toHaveBeenCalled();
    f.request(1);
    expect(f.boundary.flush).not.toHaveBeenCalled();
  });

  it("does not acknowledge a pending flush after disposal", async () => {
    const f = fixture();
    const stop = installApplicationLifecycle(f.boundary);
    await vi.waitFor(() => expect(f.boundary.ready).toHaveBeenCalledOnce());
    f.request(1);
    stop();
    f.finish();
    await Promise.resolve();
    expect(f.boundary.complete).not.toHaveBeenCalled();
  });
});
