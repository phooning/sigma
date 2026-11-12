import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { onDropMedia } from "../components/CanvasActions";
import { useCanvasSessionStore } from "../stores/useCanvasSessionStore";
import { useTauriDrop } from "./drag";
import { notify } from "./notifications";

const { register } = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: register }),
}));
vi.mock("../components/CanvasActions", () => ({ onDropMedia: vi.fn() }));
vi.mock("./notifications", () => ({ notify: { error: vi.fn() } }));

function mount() {
  return renderHook(() =>
    useTauriDrop({
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      setItems: vi.fn(),
    }),
  );
}

describe("native drop registration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("disposes a listener registered after unmount", async () => {
    let finish!: (dispose: () => void) => void;
    register.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const dispose = vi.fn();
    const hook = mount();
    hook.unmount();
    await act(async () => {
      finish(dispose);
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("handles an asynchronously rejected registration", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    register.mockRejectedValue(new Error("registration denied"));
    const hook = mount();
    await waitFor(() => expect(warning).toHaveBeenCalledOnce());
    hook.unmount();
    warning.mockRestore();
  });

  it("reports a failed import without an unhandled rejection", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    register.mockResolvedValue(vi.fn());
    vi.mocked(onDropMedia).mockRejectedValue(new Error("import failed"));
    const hook = mount();
    const callback = register.mock.calls[0][0];
    await act(async () => {
      callback({ payload: { type: "drop", paths: ["/photo.png"] } });
    });
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(
        "Media import failed",
        expect.anything(),
      ),
    );
    hook.unmount();
    log.mockRestore();
  });

  it("does not import into a replacement session when an old probe finishes", async () => {
    register.mockResolvedValue(vi.fn());
    let finish!: (items: Awaited<ReturnType<typeof onDropMedia>>) => void;
    vi.mocked(onDropMedia).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const setItems = vi.fn();
    const hook = renderHook(() =>
      useTauriDrop({
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        setItems,
      }),
    );
    await act(async () => {
      register.mock.calls[0][0]({
        payload: { type: "drop", paths: ["/old.png"] },
      });
      useCanvasSessionStore.getState().replaceSession({ items: [] });
      finish([
        {
          id: "old",
          type: "image",
          filePath: "/old.png",
          url: "",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
      ]);
    });
    expect(setItems).not.toHaveBeenCalled();
    hook.unmount();
  });
});
