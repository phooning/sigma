import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../utils/media.types";
import { VideoMedia } from "./Video";

const videoItem: MediaItem = {
  id: "video-1",
  type: "video",
  filePath: "/tmp/video.mp4",
  url: "asset:///tmp/video.mp4",
  x: 0,
  y: 0,
  width: 1280,
  height: 720,
};

const crop = {
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
};

describe("VideoMedia timeline", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis.HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: vi.fn(() => Promise.resolve()),
    });
    Object.defineProperty(globalThis.HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("scrubs without starting the canvas drag gesture", async () => {
    let currentTime = 0;
    const parentPointerDown = vi.fn();

    render(
      <div onPointerDown={parentPointerDown}>
        <VideoMedia
          url="asset:///tmp/video.mp4"
          crop={crop}
          item={videoItem}
          isInViewport
          zoom={1}
        />
      </div>,
    );

    const video = document.querySelector("video");
    if (!(video instanceof HTMLVideoElement)) {
      throw new Error("Expected video element to be rendered");
    }
    expect(video).toBeInTheDocument();

    Object.defineProperty(video, "duration", {
      configurable: true,
      get: () => 20,
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value) => {
        currentTime = value;
      },
    });

    fireEvent.loadedMetadata(video);

    const timeline = await screen.findByRole("slider", {
      name: /video timeline/i,
    });
    Object.defineProperty(timeline, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 10,
        right: 210,
        top: 0,
        bottom: 18,
        width: 200,
        height: 18,
        x: 10,
        y: 0,
        toJSON: () => {},
      }),
    });

    fireEvent.pointerDown(timeline, {
      clientX: 110,
      pointerId: 1,
    });

    expect(parentPointerDown).not.toHaveBeenCalled();
    await waitFor(() => expect(currentTime).toBe(10));
    expect(timeline).toHaveAttribute("aria-valuenow", "10");
    expect(timeline).toHaveStyle("--video-playhead-position: 50%");
  });

  it("sets sticky A/B loop markers distinct from the playhead", async () => {
    let currentTime = 0;

    render(
      <VideoMedia
        url="asset:///tmp/video.mp4"
        crop={crop}
        item={videoItem}
        isInViewport
        zoom={1}
      />,
    );

    const video = document.querySelector("video");
    if (!(video instanceof HTMLVideoElement)) {
      throw new Error("Expected video element to be rendered");
    }
    expect(video).toBeInTheDocument();

    Object.defineProperty(video, "duration", {
      configurable: true,
      get: () => 20,
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value) => {
        currentTime = value;
      },
    });

    fireEvent.loadedMetadata(video);
    const timeline = await screen.findByRole("slider", {
      name: /video timeline/i,
    });

    currentTime = 5;
    fireEvent.timeUpdate(video);
    fireEvent.click(screen.getByRole("button", { name: /set loop a point/i }));

    currentTime = 15;
    fireEvent.timeUpdate(video);
    fireEvent.click(screen.getByRole("button", { name: /set loop b point/i }));

    const loopButton = screen.getByRole("button", {
      name: /toggle a\/b loop/i,
    });
    fireEvent.click(loopButton);

    expect(loopButton).toHaveAttribute("aria-pressed", "true");
    expect(timeline).toHaveStyle("--video-loop-a-position: 25%");
    expect(timeline).toHaveStyle("--video-loop-b-position: 75%");
    expect(timeline).toHaveStyle("--video-loop-start-position: 25%");
    expect(timeline).toHaveStyle("--video-loop-end-position: 75%");
    expect(timeline).toHaveStyle("--video-playhead-position: 75%");
  });

  it("keeps the timeline when media duration briefly becomes unavailable", async () => {
    const duration = Number.NaN;

    render(
      <VideoMedia
        url="asset:///tmp/video.mp4"
        crop={crop}
        item={{ ...videoItem, duration: 20 }}
        isInViewport
        zoom={1}
      />,
    );

    const video = document.querySelector("video");
    if (!(video instanceof HTMLVideoElement)) {
      throw new Error("Expected video element to be rendered");
    }
    expect(video).toBeInTheDocument();

    Object.defineProperty(video, "duration", {
      configurable: true,
      get: () => duration,
    });

    expect(
      await screen.findByRole("slider", { name: /video timeline/i }),
    ).toHaveAttribute("aria-valuemax", "20");

    fireEvent.durationChange(video);

    expect(
      screen.getByRole("slider", { name: /video timeline/i }),
    ).toHaveAttribute("aria-valuemax", "20");
  });

  it("pauses and resumes playback from the timeline controls", async () => {
    let paused = false;
    const parentPointerDown = vi.fn();

    render(
      <div onPointerDown={parentPointerDown}>
        <VideoMedia
          url="asset:///tmp/video.mp4"
          crop={crop}
          item={{ ...videoItem, duration: 20 }}
          isInViewport
          zoom={1}
        />
      </div>,
    );

    const video = document.querySelector("video");
    expect(video).toBeInTheDocument();

    if (!(video instanceof HTMLVideoElement)) {
      throw new Error("Expected video element to be rendered");
    }

    Object.defineProperty(video, "duration", {
      configurable: true,
      get: () => 20,
    });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => paused,
    });
    Object.defineProperty(video, "pause", {
      configurable: true,
      value: vi.fn(() => {
        paused = true;
        fireEvent.pause(video);
      }),
    });
    Object.defineProperty(video, "play", {
      configurable: true,
      value: vi.fn(() => {
        paused = false;
        fireEvent.play(video);
        return Promise.resolve();
      }),
    });

    fireEvent.loadedMetadata(video);

    const pauseButton = await screen.findByRole("button", {
      name: /pause video/i,
    });
    fireEvent.pointerDown(pauseButton, { pointerId: 1 });
    fireEvent.click(pauseButton);

    expect(parentPointerDown).not.toHaveBeenCalled();
    expect(video.pause).toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /play video/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /play video/i }));

    expect(video.play).toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /pause video/i }),
    ).toBeInTheDocument();
  });

  it("reports readiness only after the playable video can render", () => {
    const onReadyChange = vi.fn();

    render(
      <VideoMedia
        url="asset:///tmp/video.mp4"
        crop={crop}
        item={videoItem}
        isInViewport
        zoom={1}
        onReadyChange={onReadyChange}
      />,
    );

    const video = document.querySelector("video");
    if (!(video instanceof HTMLVideoElement)) {
      throw new Error("Expected video element to be rendered");
    }

    expect(onReadyChange).toHaveBeenLastCalledWith(false);

    fireEvent.canPlay(video);

    expect(onReadyChange).toHaveBeenLastCalledWith(true);
  });

  it("reports readiness when a thumbnail-sized video image loads", () => {
    const onReadyChange = vi.fn();

    render(
      <VideoMedia
        url="asset:///tmp/video.mp4"
        crop={crop}
        item={{ ...videoItem, thumbnailUrl: "asset:///tmp/video-thumb.jpg" }}
        isInViewport
        zoom={0.11}
        onReadyChange={onReadyChange}
      />,
    );

    const image = screen.getByAltText("video thumbnail");
    expect(onReadyChange).toHaveBeenLastCalledWith(false);

    fireEvent.load(image);

    expect(onReadyChange).toHaveBeenLastCalledWith(true);
  });
});
