import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../utils/media.types";
import type { LoopState } from "../utils/videoUtils";
import { useVideoTimeline } from "./useVideoTimeline";

const videoItem: MediaItem = {
  id: "video-1",
  type: "video",
  filePath: "/tmp/video.mp4",
  url: "asset:///tmp/video.mp4",
  x: 0,
  y: 0,
  width: 1280,
  height: 720,
  duration: 20,
};

const flushEffects = () =>
  act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

describe("useVideoTimeline", () => {
  it("loops playback back to point A after reaching point B", async () => {
    let currentTime = 14.5;
    const video = document.createElement("video");
    const timeline = document.createElement("div");
    const loopRef = {
      current: {
        a: 5,
        b: 15,
        enabled: true,
      } satisfies LoopState,
    };
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

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value) => {
        currentTime = value;
      },
    });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "ended", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "playbackRate", {
      configurable: true,
      get: () => 1,
    });
    const videoRef = { current: video };

    const { result } = renderHook(() =>
      useVideoTimeline({
        videoRef,
        url: videoItem.url,
        item: videoItem,
        loopRef,
      }),
    );

    await flushEffects();

    act(() => {
      result.current.timelineRef.current = timeline;
    });
    act(() => {
      result.current.syncTimelineFromVideo(currentTime, 20);
    });
    act(() => {
      result.current.startTimelineAnimation();
    });

    expect(animationFrames).toHaveLength(1);

    act(() => {
      animationFrames[0]?.(1000);
    });

    expect(currentTime).toBe(14.5);
    expect(timeline.style.getPropertyValue("--video-playhead-position")).toBe(
      "72.5%",
    );

    act(() => {
      animationFrames[1]?.(1500);
    });

    expect(currentTime).toBe(5);

    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
    performanceNowSpy.mockRestore();
  });

  it("aligns passive re-anchors to the next raf timestamp", async () => {
    let currentTime = 5;
    const video = document.createElement("video");
    const timeline = document.createElement("div");
    const loopRef = {
      current: {
        a: null,
        b: null,
        enabled: false,
      } satisfies LoopState,
    };
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

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value) => {
        currentTime = value;
      },
    });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "ended", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "playbackRate", {
      configurable: true,
      get: () => 1,
    });
    const videoRef = { current: video };

    const { result } = renderHook(() =>
      useVideoTimeline({
        videoRef,
        url: videoItem.url,
        item: videoItem,
        loopRef,
      }),
    );

    await flushEffects();

    act(() => {
      result.current.timelineRef.current = timeline;
    });
    act(() => {
      result.current.startTimelineAnimation();
    });

    expect(animationFrames).toHaveLength(1);

    act(() => {
      animationFrames[0]?.(1000);
    });

    act(() => {
      result.current.syncTimelineFromVideo(6, 20, {
        alignToRafTimestamp: true,
        writePlayhead: false,
      });
    });

    act(() => {
      animationFrames[1]?.(1100);
    });

    expect(timeline.style.getPropertyValue("--video-playhead-position")).toBe(
      "30%",
    );
    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
    performanceNowSpy.mockRestore();
  });

  it("skips immediate state writes for passive timeline syncs", async () => {
    const video = document.createElement("video");
    const loopRef = {
      current: {
        a: null,
        b: null,
        enabled: false,
      } satisfies LoopState,
    };

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => 5,
    });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "ended", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "playbackRate", {
      configurable: true,
      get: () => 1,
    });
    const videoRef = { current: video };

    const { result } = renderHook(() =>
      useVideoTimeline({
        videoRef,
        url: videoItem.url,
        item: videoItem,
        loopRef,
      }),
    );

    await flushEffects();

    expect(result.current.currentTime).toBe(0);

    act(() => {
      result.current.syncTimelineFromVideo(6, 20, {
        alignToRafTimestamp: true,
        writePlayhead: false,
        writeState: false,
      });
    });

    expect(result.current.currentTime).toBe(0);
  });

  it("anchors the first playback frame to the raf timestamp instead of handler time", async () => {
    let currentTime = 5;
    const video = document.createElement("video");
    const timeline = document.createElement("div");
    const loopRef = {
      current: {
        a: null,
        b: null,
        enabled: false,
      } satisfies LoopState,
    };
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
      .mockImplementation(() => 900);

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value) => {
        currentTime = value;
      },
    });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "ended", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "playbackRate", {
      configurable: true,
      get: () => 1,
    });
    const videoRef = { current: video };

    const { result } = renderHook(() =>
      useVideoTimeline({
        videoRef,
        url: videoItem.url,
        item: videoItem,
        loopRef,
      }),
    );

    await flushEffects();

    act(() => {
      result.current.timelineRef.current = timeline;
    });
    act(() => {
      result.current.startTimelineAnimation();
    });

    expect(animationFrames).toHaveLength(1);

    act(() => {
      animationFrames[0]?.(1000);
    });

    expect(timeline.style.getPropertyValue("--video-playhead-position")).toBe(
      "25%",
    );

    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
    performanceNowSpy.mockRestore();
  });

  it("aligns playback-rate changes to the next raf timestamp", async () => {
    let currentTime = 5;
    let playbackRate = 2;
    const video = document.createElement("video");
    const timeline = document.createElement("div");
    const loopRef = {
      current: {
        a: null,
        b: null,
        enabled: false,
      } satisfies LoopState,
    };
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
      .mockImplementation(() => 900);

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value) => {
        currentTime = value;
      },
    });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "ended", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "playbackRate", {
      configurable: true,
      get: () => playbackRate,
      set: (value) => {
        playbackRate = value;
      },
    });
    const videoRef = { current: video };

    const { result } = renderHook(() =>
      useVideoTimeline({
        videoRef,
        url: videoItem.url,
        item: videoItem,
        loopRef,
      }),
    );

    await flushEffects();

    act(() => {
      result.current.timelineRef.current = timeline;
      result.current.syncTimelineFromVideo(5, 20);
      result.current.startTimelineAnimation();
    });

    act(() => {
      animationFrames[0]?.(1000);
    });

    act(() => {
      result.current.syncPlaybackRate(5, 2);
    });

    act(() => {
      animationFrames[1]?.(1100);
    });

    expect(timeline.style.getPropertyValue("--video-playhead-position")).toBe(
      "25%",
    );

    act(() => {
      animationFrames[2]?.(1200);
    });

    expect(timeline.style.getPropertyValue("--video-playhead-position")).toBe(
      "26%",
    );

    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
    performanceNowSpy.mockRestore();
  });

  it("prefers requestVideoFrameCallback when the browser supports it", async () => {
    const video = document.createElement("video");
    const timeline = document.createElement("div");
    const loopRef = {
      current: {
        a: null,
        b: null,
        enabled: false,
      } satisfies LoopState,
    };
    const frameCallbacks: VideoFrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 1);
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => 0,
    });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "ended", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "playbackRate", {
      configurable: true,
      get: () => 1,
    });
    Object.defineProperty(video, "requestVideoFrameCallback", {
      configurable: true,
      value: vi.fn((callback: VideoFrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    });
    Object.defineProperty(video, "cancelVideoFrameCallback", {
      configurable: true,
      value: vi.fn(),
    });
    const videoRef = { current: video };

    const { result } = renderHook(() =>
      useVideoTimeline({
        videoRef,
        url: videoItem.url,
        item: videoItem,
        loopRef,
      }),
    );

    await flushEffects();

    act(() => {
      result.current.timelineRef.current = timeline;
    });
    const rafCallsBeforeStart = requestAnimationFrameSpy.mock.calls.length;
    act(() => {
      result.current.startTimelineAnimation();
    });

    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1);
    expect(requestAnimationFrameSpy.mock.calls.length).toBe(
      rafCallsBeforeStart,
    );

    act(() => {
      frameCallbacks[0]?.(1000, {
        presentationTime: 1000,
        expectedDisplayTime: 1000,
        width: 1920,
        height: 1080,
        mediaTime: 6.25,
        presentedFrames: 1,
        processingDuration: 0,
      });
    });

    expect(timeline.style.getPropertyValue("--video-playhead-position")).toBe(
      "31.25%",
    );
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(2);

    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
  });

  it("throttles timeline state writes to animation cadence", async () => {
    const video = document.createElement("video");
    const timeline = document.createElement("div");
    const loopRef = {
      current: {
        a: null,
        b: null,
        enabled: false,
      } satisfies LoopState,
    };
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

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => 5,
    });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "ended", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, "playbackRate", {
      configurable: true,
      get: () => 1,
    });
    const videoRef = { current: video };

    const { result } = renderHook(() =>
      useVideoTimeline({
        videoRef,
        url: videoItem.url,
        item: videoItem,
        loopRef,
      }),
    );

    await flushEffects();

    act(() => {
      result.current.timelineRef.current = timeline;
      result.current.syncTimelineFromVideo(5, 20);
      result.current.startTimelineAnimation();
    });

    act(() => {
      animationFrames[0]?.(1000);
    });
    expect(result.current.currentTime).toBe(5);

    act(() => {
      animationFrames[1]?.(1050);
    });
    expect(result.current.currentTime).toBe(5.05);

    act(() => {
      animationFrames[2]?.(1100);
    });
    expect(result.current.currentTime).toBe(5.05);

    act(() => {
      animationFrames[3]?.(1150);
    });
    expect(result.current.currentTime).toBe(5.15);

    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
    performanceNowSpy.mockRestore();
  });
});
