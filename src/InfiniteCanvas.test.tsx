import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import packageJson from "../package.json";
import { useDevStore } from "./stores/useDevStore";
import {
  dropFiles,
  getCanvasContainer,
  open,
  renderCanvas,
  save,
  writeTextFile,
} from "./test/infiniteCanvasHarness";

describe("Settings and persistence", () => {
  it("opens the settings modal from the toolbar cog", () => {
    renderCanvas();

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));

    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Hotkeys" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Debug" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "About" })).toBeInTheDocument();
    expect(
      screen.getByText(`Version ${packageJson.version}`),
    ).toBeInTheDocument();
  });

  it("toggles development stats from the debug settings section", () => {
    renderCanvas();

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    fireEvent.click(screen.getByRole("tab", { name: "Debug" }));
    fireEvent.click(screen.getByRole("switch", { name: /development mode/i }));

    expect(screen.getByLabelText("Development stats")).toBeInTheDocument();
    expect(screen.getByText("FPS")).toBeInTheDocument();
    expect(screen.getByText("Frame time (ms)")).toBeInTheDocument();
    expect(screen.getByText("CPU frame time")).toBeInTheDocument();
    expect(screen.getByText("GPU frame time")).toBeInTheDocument();
    expect(screen.getByText("UI thread time")).toBeInTheDocument();
    expect(screen.getByText("Render thread time")).toBeInTheDocument();
    expect(screen.getByText("Compositor time")).toBeInTheDocument();
    expect(screen.getByText("Swap/present time")).toBeInTheDocument();
    expect(screen.getByText("Frames queued")).toBeInTheDocument();
    expect(screen.getByText("Frames dropped")).toBeInTheDocument();
    expect(screen.getByText("Frames missed vsync")).toBeInTheDocument();
    expect(
      screen.getByText("Rust backend frame/update time"),
    ).toBeInTheDocument();
    expect(screen.getByText("WebView JS frame time")).toBeInTheDocument();
    expect(screen.getByText("IPC roundtrip time")).toBeInTheDocument();
    expect(
      screen.getByText("Serialization/deserialization time"),
    ).toBeInTheDocument();
    expect(screen.getByText("Video count")).toBeInTheDocument();
  });

  it("lists available hotkeys in settings", async () => {
    renderCanvas();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Hotkeys" }));
    });

    expect(screen.getByText("F1")).toBeInTheDocument();
    expect(screen.getByText("Toggle development mode.")).toBeInTheDocument();
    expect(screen.getByText("Ctrl/Cmd+S")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Save the current canvas configuration, or open Save As when no path is set.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Spacebar")).toBeInTheDocument();
    expect(
      screen.getByText("Toggle playback for selected videos."),
    ).toBeInTheDocument();
    expect(screen.getByText("Arrow Left / Arrow Right")).toBeInTheDocument();
    expect(
      screen.getByText("Scrub the selected video by 1 frame."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Shift+Arrow Left / Shift+Arrow Right"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Scrub the selected video by 10 frames."),
    ).toBeInTheDocument();
    expect(screen.getByText("Ctrl/Cmd+A")).toBeInTheDocument();
    expect(
      screen.getByText("Select every item on the canvas."),
    ).toBeInTheDocument();
    expect(screen.getByText("Delete/Backspace")).toBeInTheDocument();
    expect(screen.getByText("Delete the selected items.")).toBeInTheDocument();
    expect(screen.getByText("Escape")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Clear the current selection and exit crop editing, or open settings when nothing is selected.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
    expect(
      screen.getByText("Enter crop mode for the active selected item."),
    ).toBeInTheDocument();
    expect(screen.getByText("R")).toBeInTheDocument();
    expect(
      screen.getByText("Reset the active selected item to its default size."),
    ).toBeInTheDocument();
  });

  it("toggles development mode from the F1 hotkey", async () => {
    renderCanvas();

    expect(useDevStore.getState().devMode).toBe(false);

    await act(async () => {
      fireEvent.keyDown(window, { key: "F1" });
    });

    expect(useDevStore.getState().devMode).toBe(true);
    expect(screen.getByLabelText("Development stats")).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(window, { key: "F1" });
    });

    expect(useDevStore.getState().devMode).toBe(false);
    expect(
      screen.queryByLabelText("Development stats"),
    ).not.toBeInTheDocument();
  });

  it("renders populated advanced development metrics", async () => {
    renderCanvas();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Debug" }));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("switch", { name: /development mode/i }),
      );
    });

    act(() => {
      useDevStore.getState().setPipelineStats({
        cpuFrameTimeMs: 12.3,
        gpuFrameTimeMs: 4.6,
        uiThreadTimeMs: 2.1,
        renderThreadTimeMs: 5.4,
        compositorTimeMs: 3.8,
        swapPresentTimeMs: 8.9,
        framesQueued: 2,
        framesDropped: 1,
        framesMissedVsync: 3,
        rustBackendFrameUpdateTimeMs: 6.7,
        webviewJsFrameTimeMs: 11.2,
        ipcRoundtripTimeMs: 1.4,
        serializationDeserializationTimeMs: 0.6,
      });
    });

    expect(screen.getByText("12.3 ms")).toBeInTheDocument();
    expect(screen.getByText("4.6 ms")).toBeInTheDocument();
    expect(screen.getByText("2.1 ms")).toBeInTheDocument();
    expect(screen.getByText("5.4 ms")).toBeInTheDocument();
    expect(screen.getByText("3.8 ms")).toBeInTheDocument();
    expect(screen.getByText("8.9 ms")).toBeInTheDocument();
    expect(screen.getByText("6.7 ms")).toBeInTheDocument();
    expect(screen.getByText("11.2 ms")).toBeInTheDocument();
    expect(screen.getByText("1.4 ms")).toBeInTheDocument();
    expect(screen.getByText("0.6 ms")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("chooses a screenshot directory from general settings", async () => {
    vi.mocked(open).mockResolvedValue("/shots");

    renderCanvas();

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    });

    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Choose screenshot directory",
      defaultPath: undefined,
    });
    expect(screen.getByText("/shots")).toBeInTheDocument();
    expect(localStorage.getItem("sigma:screenshot-directory")).toBe("/shots");
  });

  it("saves from the keyboard shortcut", async () => {
    renderCanvas();

    await act(async () => {
      fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    });

    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({
        defaultPath: "canvas.json",
        filters: [
          {
            extensions: ["json"],
            name: "Canvas Config",
          },
        ],
        title: "Save canvas",
      });
    });
  });

  it("uses Save As for a new path and then quick-saves to the same file only after changes", async () => {
    vi.mocked(save).mockResolvedValue("/tmp/scene.json");

    renderCanvas();

    const saveButton = screen.getByRole("button", { name: "Save" });
    const saveAsButton = screen.getByRole("button", { name: "Save As" });
    expect(saveButton).toBeDisabled();
    expect(saveAsButton).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(saveAsButton);
    });

    await waitFor(() => {
      expect(writeTextFile).toHaveBeenCalledWith(
        "/tmp/scene.json",
        expect.stringContaining('"items"'),
      );
    });
    expect(saveButton).toBeDisabled();

    vi.mocked(save).mockClear();
    vi.mocked(writeTextFile).mockClear();

    const canvas = getCanvasContainer();
    await act(async () => {
      fireEvent.wheel(canvas, {
        ctrlKey: true,
        deltaY: -200,
        clientX: 10,
        clientY: 10,
      });
    });

    expect(saveButton).toBeDisabled();

    await dropFiles(["/path/to/test.png"]);

    await waitFor(() => {
      expect(saveButton).toBeEnabled();
    });

    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(writeTextFile).toHaveBeenCalledWith(
        "/tmp/scene.json",
        expect.stringContaining('"items"'),
      );
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("marks debug setting changes as dirty and persists them on save", async () => {
    vi.mocked(save).mockResolvedValue("/tmp/debug-session.json");

    renderCanvas();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save As" }));
    });

    await waitFor(() => {
      expect(writeTextFile).toHaveBeenCalledWith(
        "/tmp/debug-session.json",
        expect.stringContaining('"devMode":false'),
      );
    });

    vi.mocked(writeTextFile).mockClear();

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Debug" }));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("switch", { name: /development mode/i }),
      );
    });

    await waitFor(() => {
      expect(saveButton).toBeEnabled();
    });
    expect(useDevStore.getState().devMode).toBe(true);

    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(writeTextFile).toHaveBeenCalledWith(
        "/tmp/debug-session.json",
        expect.stringContaining('"devMode":true'),
      );
    });
  });

  it("switches the canvas background from dots to grid", async () => {
    renderCanvas();

    expect(
      document.querySelector(".canvas-background.dots"),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Grid background" }));
    });

    expect(
      document.querySelector(".canvas-background.grid"),
    ).toBeInTheDocument();
    expect(document.querySelector(".canvas-grid-plus")).not.toBeInTheDocument();
    expect(localStorage.getItem("sigma:canvas-background-pattern")).toBe(
      "grid",
    );
  });

  it("clears all canvas items from the toolbar", async () => {
    renderCanvas();

    const clearButton = screen.getByRole("button", { name: "Clear" });
    expect(clearButton).toBeDisabled();

    await dropFiles(["/path/to/test.png", "/path/to/portrait.webp"]);

    await waitFor(() => {
      expect(screen.getByText("2 items")).toBeInTheDocument();
      expect(clearButton).toBeEnabled();
    });

    await act(async () => {
      fireEvent.click(clearButton);
    });

    await waitFor(() => {
      expect(screen.getByText("0 items")).toBeInTheDocument();
      expect(clearButton).toBeDisabled();
      expect(document.querySelectorAll(".media-item")).toHaveLength(0);
    });
  });
});
