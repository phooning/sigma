import {
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
} from "react";
import {
  clampVideoTime,
  getLoopRange,
  initialLoopState,
  type LoopState,
} from "../utils/videoUtils";
import { useRefState } from "./useRefState";

interface UseVideoLoopArgs {
  videoRef: RefObject<HTMLVideoElement | null>;
  timelineRef: RefObject<HTMLDivElement | null>;
  durationRef: MutableRefObject<number>;
  externalLoopRef: MutableRefObject<LoopState>;
  initialLoop?: LoopState;
  duration: number;
  url: string;
  syncTimelineFromVideo: (time: number, nextDuration?: number) => void;
}

export function useVideoLoop({
  videoRef,
  timelineRef,
  durationRef,
  externalLoopRef,
  initialLoop = initialLoopState,
  duration,
  url,
  syncTimelineFromVideo,
}: UseVideoLoopArgs) {
  const [loop, loopRef, setLoop] = useRefState<LoopState>(initialLoop);
  externalLoopRef.current = loopRef.current;

  const writeLoopPosition = useCallback(
    (nextLoop: LoopState) => {
      const duration = durationRef.current;
      const timeline = timelineRef.current;
      if (duration <= 0 || !timeline) return;

      const aPosition =
        nextLoop.a === null
          ? "-100%"
          : `${(clampVideoTime(nextLoop.a, duration) / duration) * 100}%`;
      const bPosition =
        nextLoop.b === null
          ? "-100%"
          : `${(clampVideoTime(nextLoop.b, duration) / duration) * 100}%`;
      const range = getLoopRange(nextLoop);
      const rangeStart =
        range === null
          ? "0%"
          : `${(clampVideoTime(range.start, duration) / duration) * 100}%`;
      const rangeEnd =
        range === null
          ? "0%"
          : `${(clampVideoTime(range.end, duration) / duration) * 100}%`;

      timeline.style.setProperty("--video-loop-a-position", aPosition);
      timeline.style.setProperty("--video-loop-b-position", bPosition);
      timeline.style.setProperty("--video-loop-start-position", rangeStart);
      timeline.style.setProperty("--video-loop-end-position", rangeEnd);
    },
    [durationRef, timelineRef],
  );

  const updateLoop = useCallback(
    (getNextLoop: (previous: LoopState) => LoopState) => {
      setLoop((previous) => {
        const nextLoop = getNextLoop(previous);
        externalLoopRef.current = nextLoop;
        writeLoopPosition(nextLoop);
        return nextLoop;
      });
    },
    [externalLoopRef, setLoop, writeLoopPosition],
  );

  const setLoopPoint = useCallback(
    (point: "a" | "b") => {
      const video = videoRef.current;
      const duration = durationRef.current;
      if (!video || duration <= 0) return;

      const nextPoint = clampVideoTime(video.currentTime, duration);
      updateLoop((previous) => ({
        ...previous,
        [point]: nextPoint,
        enabled:
          previous.enabled &&
          (point === "a"
            ? previous.b !== null && previous.b !== nextPoint
            : previous.a !== null && previous.a !== nextPoint),
      }));
    },
    [durationRef, updateLoop, videoRef],
  );

  const toggleLoop = useCallback(() => {
    const previous = loopRef.current;
    const range = getLoopRange(previous);
    const nextLoop = {
      ...previous,
      enabled: range === null ? false : !previous.enabled,
    };

    externalLoopRef.current = nextLoop;
    setLoop(nextLoop);
    writeLoopPosition(nextLoop);

    if (nextLoop.enabled && range !== null && videoRef.current) {
      const video = videoRef.current;
      if (video.currentTime < range.start || video.currentTime > range.end) {
        video.currentTime = range.start;
        syncTimelineFromVideo(range.start);
      }
    }
  }, [
    externalLoopRef,
    loopRef,
    setLoop,
    syncTimelineFromVideo,
    videoRef,
    writeLoopPosition,
  ]);

  const clearLoop = useCallback(() => {
    updateLoop(() => initialLoopState);
  }, [updateLoop]);

  useEffect(() => {
    externalLoopRef.current = loop;
    writeLoopPosition(loop);
  }, [duration, externalLoopRef, loop, writeLoopPosition]);

  useEffect(() => {
    externalLoopRef.current = initialLoop;
    setLoop(initialLoop);
  }, [externalLoopRef, initialLoop, setLoop, url]);

  return {
    loop,
    loopRef,
    setLoopPoint,
    toggleLoop,
    clearLoop,
  };
}
