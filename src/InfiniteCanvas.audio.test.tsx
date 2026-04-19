import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  dropFiles,
  getCanvasContainer,
  getCanvasWorld,
  getMediaItem,
  getMediaVideo,
  invoke,
  mockCanvasRect,
  renderCanvas,
  save,
  setViewportSize,
} from "./test/infiniteCanvasHarness";

describe("InfiniteCanvas audio and export workflows", () => {
  it("enables clip audio from the video frame action and controls volume from the HUD", async () => {
    const videoPath = new URL(
      "../fixtures/generated-lod-test-1080p.mp4",
      import.meta.url,
    ).pathname;

    setViewportSize({ width: 3000 });
    renderCanvas();
    await dropFiles([videoPath]);

    await waitFor(() => {
      expect(document.querySelector("video.media-content")).toBeInTheDocument();
    });

    const video = getMediaVideo();
    expect(video.muted).toBe(true);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /enable audio playback/i }),
      );
    });

    const slider = (await screen.findByRole("slider", {
      name: /volume for generated-lod-test-1080p\.mp4/i,
    })) as HTMLInputElement;

    expect(
      screen.getAllByText("generated-lod-test-1080p.mp4").length,
    ).toBeGreaterThan(0);
    await waitFor(() => {
      expect(video.muted).toBe(false);
      expect(video.volume).toBeCloseTo(0.8);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /mute audio/i }));
    });

    await waitFor(() => {
      expect(video.muted).toBe(true);
      expect(video.volume).toBeCloseTo(0.8);
    });
    expect(
      screen.getByRole("button", { name: /unmute audio/i }),
    ).toHaveAttribute("aria-pressed", "true");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /unmute audio/i }));
    });

    await waitFor(() => {
      expect(video.muted).toBe(false);
      expect(video.volume).toBeCloseTo(0.8);
    });

    await act(async () => {
      fireEvent.change(slider, { target: { value: "0.25" } });
    });

    await waitFor(() => {
      expect(video.muted).toBe(false);
      expect(video.volume).toBeCloseTo(0.25);
    });

    await act(async () => {
      fireEvent.change(slider, { target: { value: "0" } });
    });

    await waitFor(() => {
      expect(video.muted).toBe(true);
      expect(video.volume).toBe(0);
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /disable audio playback/i }),
      );
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("slider", {
          name: /volume for generated-lod-test-1080p\.mp4/i,
        }),
      ).not.toBeInTheDocument();
      expect(video.muted).toBe(true);
    });
  });

  it("exports the selected video with the current A/B loop range", async () => {
    const videoPath = new URL(
      "../fixtures/generated-lod-test-1080p.mp4",
      import.meta.url,
    ).pathname;
    let currentTime = 0;

    setViewportSize({ width: 3000 });
    vi.mocked(save).mockResolvedValue("/exports/generated-lod-test-1080p");
    renderCanvas();
    await dropFiles([videoPath]);

    await waitFor(() => {
      expect(document.querySelector("video.media-content")).toBeInTheDocument();
    });

    const video = getMediaVideo();
    Object.defineProperty(video, "duration", {
      configurable: true,
      get: () => 8,
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value) => {
        currentTime = value;
      },
    });

    fireEvent.loadedMetadata(video);
    currentTime = 2;
    fireEvent.timeUpdate(video);
    fireEvent.click(screen.getByRole("button", { name: /set loop a point/i }));
    currentTime = 5;
    fireEvent.timeUpdate(video);
    fireEvent.click(screen.getByRole("button", { name: /set loop b point/i }));

    const mediaItem = getMediaItem();
    await act(async () => {
      fireEvent.pointerDown(mediaItem, {
        button: 0,
        clientX: 0,
        clientY: 0,
        pointerId: 21,
      });
      fireEvent.pointerUp(mediaItem, { pointerId: 21 });
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /export selected video/i }),
      );
    });

    expect(save).toHaveBeenCalledWith({
      title: "Export video",
      defaultPath: "generated-lod-test-1080p.mp4",
      filters: [
        {
          name: "MP4 Video",
          extensions: ["mp4"],
        },
      ],
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("export_video", {
        path: videoPath,
        outputPath: "/exports/generated-lod-test-1080p.mp4",
        crop: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          boxWidth: 1280,
          boxHeight: 720,
        },
        startTime: 2,
        endTime: 5,
      });
    });
  });

  it("selects the active audio video from the HUD filename without changing its casing", async () => {
    const videoPath = "/path/to/My Clip.MP4";

    renderCanvas();
    await dropFiles([videoPath]);

    await waitFor(() => {
      expect(document.querySelector("video.media-content")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /enable audio playback/i }),
      );
    });

    expect(screen.getAllByText("My Clip.MP4").length).toBeGreaterThan(0);
    expect(screen.queryByText("MY CLIP.MP4")).not.toBeInTheDocument();

    const mediaItem = getMediaItem();
    expect(mediaItem).toHaveClass("selected");

    const containerEl = getCanvasContainer();
    mockCanvasRect(containerEl);

    await act(async () => {
      fireEvent.pointerDown(containerEl, {
        button: 0,
        clientX: 10,
        clientY: 10,
        pointerId: 13,
      });
      fireEvent.pointerUp(containerEl, { pointerId: 13 });
    });

    expect(mediaItem).not.toHaveClass("selected");

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /audio clip: My Clip\.MP4/i }),
      );
    });

    expect(mediaItem).toHaveClass("selected");
  });

  it("keeps active audio video mounted when it is outside the culling window", async () => {
    setViewportSize({ width: 1000 });
    renderCanvas();
    await dropFiles(["/path/to/audio-video.mp4"]);

    await waitFor(() => {
      expect(document.querySelector("video.media-content")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /enable audio playback/i }),
      );
    });

    const containerEl = getCanvasContainer();
    await act(async () => {
      fireEvent.pointerDown(containerEl, {
        button: 1,
        clientX: 0,
        clientY: 0,
        pointerId: 14,
      });
    });
    await act(async () => {
      fireEvent.pointerMove(containerEl, {
        clientX: 10000,
        clientY: 0,
        pointerId: 14,
      });
    });
    await act(async () => {
      fireEvent.pointerUp(containerEl, { pointerId: 14 });
    });

    expect(document.querySelector("video.media-content")).toBeInTheDocument();
    expect(
      screen.getByRole("slider", { name: /volume for audio-video\.mp4/i }),
    ).toBeInTheDocument();
  });

  it("pans the canvas to fully show the active audio video when its HUD filename is clicked", async () => {
    setViewportSize({ width: 2000, height: 1200 });
    renderCanvas();
    await dropFiles(["/path/to/pan-target.mp4"]);

    await waitFor(() => {
      expect(document.querySelector("video.media-content")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /enable audio playback/i }),
      );
    });

    const containerEl = getCanvasContainer();
    const world = getCanvasWorld();
    await act(async () => {
      fireEvent.pointerDown(containerEl, {
        button: 1,
        clientX: 0,
        clientY: 0,
        pointerId: 15,
      });
    });
    await act(async () => {
      fireEvent.pointerMove(containerEl, {
        clientX: -1500,
        clientY: -1000,
        pointerId: 15,
      });
    });
    await act(async () => {
      fireEvent.pointerUp(containerEl, { pointerId: 15 });
    });

    expect(world.style.transform).toContain("translate(-1500px, -1000px)");

    const animationFrames: FrameRequestCallback[] = [];
    let animationFrameHandle = 0;
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        if (callback.name === "tick") {
          animationFrames.push(callback);
        }
        animationFrameHandle += 1;
        return animationFrameHandle;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    const performanceNowSpy = vi
      .spyOn(performance, "now")
      .mockImplementation(() => 0);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /audio clip: pan-target\.mp4/i }),
      );
    });

    expect(document.querySelector(".media-item")).toHaveClass("selected");
    expect(world.style.transform).toContain("translate(-1500px, -1000px)");
    expect(animationFrames).toHaveLength(1);

    await act(async () => {
      animationFrames.shift()?.(1);
    });

    expect(world.style.transform).not.toContain("translate(-1500px, -1000px)");
    expect(world.style.transform).not.toContain("translate(-950px, -502px)");

    await act(async () => {
      animationFrames.shift()?.(1000);
    });

    expect(world.style.transform).toContain("translate(-950px, -502px)");

    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
    performanceNowSpy.mockRestore();
  });
});
