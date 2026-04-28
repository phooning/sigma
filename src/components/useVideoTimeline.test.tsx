import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LoopState } from "../utils/videoUtils";
import type { MediaItem } from "../utils/media.types";
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

describe("useVideoTimeline", () => {
  it("loops playback back to point A after reaching point B", () => {
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

    const { result } = renderHook(() =>
      useVideoTimeline({
        videoRef: { current: video },
        url: videoItem.url,
        item: videoItem,
        loopRef,
      }),
    );

    act(() => {
      result.current.timelineRef.current = timeline;
      result.current.syncTimelineFromVideo(currentTime, 20);
      result.current.startTimelineAnimation();
    });

    expect(animationFrames).toHaveLength(1);

    act(() => {
      animationFrames[0]?.(1000);
    });

    expect(currentTime).toBe(5);
    expect(result.current.currentTime).toBe(5);
    expect(timeline.style.getPropertyValue("--video-playhead-position")).toBe(
      "25%",
    );

    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
    performanceNowSpy.mockRestore();
  });
});
