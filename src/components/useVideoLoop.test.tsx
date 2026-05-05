import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialLoopState, type LoopState } from "../utils/videoUtils";
import { useVideoLoop } from "./useVideoLoop";

describe("useVideoLoop", () => {
  it("keeps the external loop ref synchronized after setting A/B points", () => {
    let currentTime = 5;
    const video = document.createElement("video");
    const timeline = document.createElement("div");
    const durationRef = { current: 20 };
    const externalLoopRef = { current: initialLoopState };

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value) => {
        currentTime = value;
      },
    });

    const { result } = renderHook(() =>
      useVideoLoop({
        videoRef: { current: video },
        timelineRef: { current: timeline },
        durationRef,
        externalLoopRef,
        duration: 20,
        url: "asset:///tmp/video.mp4",
        syncTimelineFromVideo: () => {},
      }),
    );

    act(() => {
      result.current.setLoopPoint("a");
    });

    currentTime = 15;
    act(() => {
      result.current.setLoopPoint("b");
    });

    expect(externalLoopRef.current).toEqual<LoopState>({
      a: 5,
      b: 15,
      enabled: false,
    });
  });
});
