import {
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
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
  syncTimelineFromVideo: (
    time: number,
    nextDuration?: number,
    options?: { writePlayhead?: boolean },
  ) => void;
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
  const formatLoopPercent = useCallback(
    (time: number, duration: number) =>
      `${Number(((clampVideoTime(time, duration) / duration) * 100).toFixed(3))}%`,
    [],
  );

  const writeLoopPosition = useCallback(
    (nextLoop: LoopState) => {
      const duration = durationRef.current;
      const timeline = timelineRef.current;
      if (duration <= 0 || !timeline) return;

      const aPosition =
        nextLoop.a === null ? "-100%" : formatLoopPercent(nextLoop.a, duration);
      const bPosition =
        nextLoop.b === null ? "-100%" : formatLoopPercent(nextLoop.b, duration);
      const range = getLoopRange(nextLoop);
      const rangeStart =
        range === null ? "0%" : formatLoopPercent(range.start, duration);
      const rangeEnd =
        range === null ? "0%" : formatLoopPercent(range.end, duration);

      timeline.style.setProperty("--video-loop-a-position", aPosition);
      timeline.style.setProperty("--video-loop-b-position", bPosition);
      timeline.style.setProperty("--video-loop-start-position", rangeStart);
      timeline.style.setProperty("--video-loop-end-position", rangeEnd);
    },
    [durationRef, formatLoopPercent, timelineRef],
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
      updateLoop((previous) => {
        const nextLoop = { ...previous, [point]: nextPoint };

        if (point === "b" && previous.a !== null && nextPoint < previous.a) {
          nextLoop.a = null;
        }

        if (point === "a" && previous.b !== null && nextPoint > previous.b) {
          nextLoop.b = null;
        }

        // Note: If the loop was previously disabled, it remains disabled even after setting a valid A/B pair.
        // This requires an explicit toggleLoop call to enable it, which is intentional UX.
        nextLoop.enabled =
          previous.enabled &&
          (point === "a"
            ? nextLoop.b !== null && nextLoop.b !== nextPoint
            : nextLoop.a !== null && nextLoop.a !== nextPoint);

        return nextLoop;
      });
    },
    [durationRef, updateLoop, videoRef],
  );

  const toggleLoop = useCallback(() => {
    updateLoop((previous) => {
      const range = getLoopRange(previous);
      const nextLoop = {
        ...previous,
        enabled: range === null ? false : !previous.enabled,
      };

      if (nextLoop.enabled && range !== null && videoRef.current) {
        const video = videoRef.current;
        if (video.currentTime < range.start || video.currentTime > range.end) {
          video.currentTime = range.start;
          syncTimelineFromVideo(range.start);
        }
      }

      return nextLoop;
    });
  }, [syncTimelineFromVideo, updateLoop, videoRef]);

  const clearLoop = useCallback(() => {
    updateLoop(() => initialLoopState);
  }, [updateLoop]);

  const initialLoopRef = useRef(initialLoop);
  const previousUrlRef = useRef(url);

  // biome-ignore lint/correctness/useExhaustiveDependencies: duration intentionally retriggers loop marker writes after ref-backed metadata changes.
  useEffect(() => {
    externalLoopRef.current = loop;
    writeLoopPosition(loop);
  }, [duration, externalLoopRef, loop, writeLoopPosition]);

  useEffect(() => {
    initialLoopRef.current = initialLoop;
    if (previousUrlRef.current === url) return;

    previousUrlRef.current = url;
    initialLoopRef.current = initialLoop;
    externalLoopRef.current = initialLoopRef.current;
    setLoop(initialLoopRef.current);
    writeLoopPosition(initialLoopRef.current);
  }, [externalLoopRef, initialLoop, setLoop, url, writeLoopPosition]);

  return {
    loop,
    loopRef,
    setLoopPoint,
    toggleLoop,
    clearLoop,
  };
}
