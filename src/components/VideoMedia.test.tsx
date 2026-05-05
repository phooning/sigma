import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVideoExportStore } from "../stores/useVideoExportStore";
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

async function renderVideoTimeline({
  duration = 20,
  paused = false,
}: {
  duration?: number;
  paused?: boolean;
} = {}) {
  const itemId = `video-${crypto.randomUUID()}`;
  let currentTime = 0;
  let isPaused = paused;

  render(
    <VideoMedia
      url="asset:///tmp/video.mp4"
      crop={crop}
      item={{ ...videoItem, id: itemId, duration }}
      isInViewport
      zoom={1}
    />,
  );

  const video = document.querySelector("video");
  if (!(video instanceof HTMLVideoElement)) {
    throw new Error("Expected video element to be rendered");
  }

  Object.defineProperty(video, "duration", {
    configurable: true,
    get: () => duration,
  });
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => currentTime,
    set: (value) => {
      currentTime = value;
    },
  });
  Object.defineProperty(video, "paused", {
    configurable: true,
    get: () => isPaused,
  });
  Object.defineProperty(video, "pause", {
    configurable: true,
    value: vi.fn(() => {
      isPaused = true;
      fireEvent.pause(video);
    }),
  });
  Object.defineProperty(video, "play", {
    configurable: true,
    value: vi.fn(() => {
      isPaused = false;
      fireEvent.play(video);
      return Promise.resolve();
    }),
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

  const setTime = (value: number) => {
    currentTime = value;
    fireEvent.timeUpdate(video);
  };

  return {
    timeline,
    video,
    setPaused: (value: boolean) => {
      isPaused = value;
    },
    setTime,
  };
}

describe("VideoMedia timeline", () => {
  beforeEach(() => {
    useVideoExportStore.getState().resetVideoExportState();
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

  it("supports sub-second playhead adjustments while dragging", async () => {
    const { timeline, video } = await renderVideoTimeline();

    fireEvent.pointerDown(timeline, {
      clientX: 63,
      pointerId: 1,
    });

    expect(video.currentTime).toBeCloseTo(5.3, 5);
    expect(timeline).toHaveAttribute("aria-valuenow", "5.3");
    expect(timeline).toHaveAttribute("aria-valuetext", "0:05.3 of 0:20");
    expect(screen.getByText("0:05.3 / 0:20")).toBeInTheDocument();

    fireEvent.pointerUp(timeline, {
      clientX: 63,
      pointerId: 1,
    });

    expect(video.currentTime).toBeCloseTo(5.3, 5);
    expect(timeline).toHaveStyle("--video-playhead-position: 26.5%");
    expect(screen.getByText("0:05 / 0:20")).toBeInTheDocument();
  });

  it("sets sticky A/B loop markers distinct from the playhead", async () => {
    const { setTime, timeline, video } = await renderVideoTimeline();

    expect(video).toBeInTheDocument();

    setTime(5);
    fireEvent.click(screen.getByRole("button", { name: /set loop a point/i }));

    setTime(15);
    fireEvent.click(screen.getByRole("button", { name: /set loop b point/i }));
    fireEvent.seeked(video);

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

  it("preserves sub-second loop points after dragging the playhead", async () => {
    const { timeline } = await renderVideoTimeline();

    fireEvent.pointerDown(timeline, {
      clientX: 63,
      pointerId: 1,
    });
    fireEvent.pointerUp(timeline, {
      clientX: 63,
      pointerId: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: /set loop a point/i }));

    fireEvent.pointerDown(timeline, {
      clientX: 167,
      pointerId: 2,
    });
    fireEvent.pointerUp(timeline, {
      clientX: 167,
      pointerId: 2,
    });
    fireEvent.click(screen.getByRole("button", { name: /set loop b point/i }));

    expect(timeline).toHaveStyle("--video-loop-a-position: 26.5%");
    expect(timeline).toHaveStyle("--video-loop-b-position: 78.5%");
    expect(timeline).toHaveStyle("--video-loop-start-position: 26.5%");
    expect(timeline).toHaveStyle("--video-loop-end-position: 78.5%");
  });

  it("sets A and B independently before loop mode can be enabled", async () => {
    const { setTime, timeline } = await renderVideoTimeline();
    const loopButton = screen.getByRole("button", {
      name: /toggle a\/b loop/i,
    });

    expect(loopButton).toBeDisabled();

    setTime(4);
    fireEvent.click(screen.getByRole("button", { name: /set loop a point/i }));

    expect(timeline).toHaveStyle("--video-loop-a-position: 20%");
    expect(timeline).toHaveStyle("--video-loop-b-position: -100%");
    expect(loopButton).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /clear a\/b loop/i }));

    expect(timeline).toHaveStyle("--video-loop-a-position: -100%");
    expect(timeline).toHaveStyle("--video-loop-b-position: -100%");
    expect(loopButton).toBeDisabled();

    setTime(16);
    fireEvent.click(screen.getByRole("button", { name: /set loop b point/i }));

    expect(timeline).toHaveStyle("--video-loop-a-position: -100%");
    expect(timeline).toHaveStyle("--video-loop-b-position: 80%");
    expect(loopButton).toBeDisabled();
  });

  it("sets A and B while paused and while playing", async () => {
    const { setPaused, setTime, timeline } = await renderVideoTimeline();

    setPaused(false);
    setTime(6);
    fireEvent.click(screen.getByRole("button", { name: /set loop a point/i }));

    fireEvent.click(screen.getByRole("button", { name: /pause video/i }));
    setTime(14);
    fireEvent.click(screen.getByRole("button", { name: /set loop b point/i }));

    const loopButton = screen.getByRole("button", {
      name: /toggle a\/b loop/i,
    });
    fireEvent.click(loopButton);

    expect(
      screen.getByRole("button", { name: /play video/i }),
    ).toBeInTheDocument();
    expect(loopButton).toHaveAttribute("aria-pressed", "true");
    expect(timeline).toHaveStyle("--video-loop-a-position: 30%");
    expect(timeline).toHaveStyle("--video-loop-b-position: 70%");
    expect(timeline).toHaveStyle("--video-loop-start-position: 30%");
    expect(timeline).toHaveStyle("--video-loop-end-position: 70%");
  });

  it("loops active playback back to point A after setting A/B through the controls", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    let animationFrameHandle = 0;
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        animationFrames.push(callback);
        animationFrameHandle += 1;
        return animationFrameHandle;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    const performanceNowSpy = vi
      .spyOn(performance, "now")
      .mockImplementation(() => 0);
    const { setTime, video } = await renderVideoTimeline();

    setTime(5);
    fireEvent.click(screen.getByRole("button", { name: /set loop a point/i }));

    setTime(15);
    fireEvent.click(screen.getByRole("button", { name: /set loop b point/i }));
    fireEvent.click(screen.getByRole("button", { name: /toggle a\/b loop/i }));

    setTime(14.5);
    fireEvent.seeked(video);

    expect(animationFrames.length).toBeGreaterThan(0);

    act(() => {
      animationFrames.at(-1)?.(1000);
    });

    expect(video.currentTime).toBe(14.5);

    act(() => {
      animationFrames.at(-1)?.(1500);
    });

    expect(video.currentTime).toBe(5);

    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
    performanceNowSpy.mockRestore();
  });

  it("allows redundant A and B points at the beginning and end", async () => {
    const { setTime, timeline } = await renderVideoTimeline();
    const loopButton = screen.getByRole("button", {
      name: /toggle a\/b loop/i,
    });

    setTime(0);
    fireEvent.click(screen.getByRole("button", { name: /set loop a point/i }));

    setTime(20);
    fireEvent.click(screen.getByRole("button", { name: /set loop b point/i }));

    expect(loopButton).toBeEnabled();
    expect(timeline).toHaveStyle("--video-loop-a-position: 0%");
    expect(timeline).toHaveStyle("--video-loop-b-position: 100%");
    expect(timeline).toHaveStyle("--video-loop-start-position: 0%");
    expect(timeline).toHaveStyle("--video-loop-end-position: 100%");

    setTime(0);
    fireEvent.click(screen.getByRole("button", { name: /set loop a point/i }));
    setTime(20);
    fireEvent.click(screen.getByRole("button", { name: /set loop b point/i }));

    expect(loopButton).toBeEnabled();
    expect(timeline).toHaveStyle("--video-loop-a-position: 0%");
    expect(timeline).toHaveStyle("--video-loop-b-position: 100%");
  });

  it("sets A and B after dragging the playhead to new positions", async () => {
    const { timeline } = await renderVideoTimeline();

    fireEvent.pointerDown(timeline, {
      clientX: 60,
      pointerId: 1,
    });
    fireEvent.pointerMove(timeline, {
      clientX: 60,
      pointerId: 1,
    });
    fireEvent.pointerUp(timeline, {
      clientX: 60,
      pointerId: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: /set loop a point/i }));

    fireEvent.pointerDown(timeline, {
      clientX: 170,
      pointerId: 2,
    });
    fireEvent.pointerMove(timeline, {
      clientX: 170,
      pointerId: 2,
    });
    fireEvent.pointerUp(timeline, {
      clientX: 170,
      pointerId: 2,
    });
    fireEvent.click(screen.getByRole("button", { name: /set loop b point/i }));

    expect(timeline).toHaveAttribute("aria-valuenow", "16");
    expect(timeline).toHaveStyle("--video-playhead-position: 80%");
    expect(timeline).toHaveStyle("--video-loop-a-position: 25%");
    expect(timeline).toHaveStyle("--video-loop-b-position: 80%");
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

  it("updates the timeline controls when playback resumes externally", async () => {
    let paused = false;

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

    fireEvent.click(
      await screen.findByRole("button", { name: /pause video/i }),
    );
    expect(
      screen.getByRole("button", { name: /play video/i }),
    ).toBeInTheDocument();

    await video.play();

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
