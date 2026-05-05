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

    expect(screen.getByText("Ctrl/Cmd+S")).toBeInTheDocument();
    expect(
      screen.getByText("Save the current canvas configuration."),
    ).toBeInTheDocument();
    expect(screen.getByText("Spacebar")).toBeInTheDocument();
    expect(
      screen.getByText("Toggle playback for selected videos."),
    ).toBeInTheDocument();
    expect(screen.getByText("Ctrl/Cmd+A")).toBeInTheDocument();
    expect(
      screen.getByText("Select every item on the canvas."),
    ).toBeInTheDocument();
    expect(screen.getByText("Delete/Backspace")).toBeInTheDocument();
    expect(screen.getByText("Delete the selected items.")).toBeInTheDocument();
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

    expect(save).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
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
