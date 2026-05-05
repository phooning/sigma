import {
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import type { MediaItem } from "../utils/media.types";
import {
  clampVideoTime,
  getFiniteDuration,
  getLoopRange,
  type LoopState,
} from "../utils/videoUtils";
import { useRefState } from "./useRefState";

interface UseVideoTimelineArgs {
  videoRef: RefObject<HTMLVideoElement | null>;
  url: string;
  item: MediaItem;
  loopRef: MutableRefObject<LoopState>;
}

interface SyncTimelineOptions {
  writePlayhead?: boolean;
  alignToRafTimestamp?: boolean;
  writeState?: boolean;
}

const TIMELINE_STATE_WRITE_INTERVAL_MS = 100;

export function useVideoTimeline({
  videoRef,
  url,
  item,
  loopRef,
}: UseVideoTimelineArgs) {
  const clampTimelineTime = useCallback(
    (time: number, duration: number) => clampVideoTime(time, duration),
    [],
  );
  const roundTimelineStateTime = useCallback(
    (time: number, duration: number) =>
      Number(clampVideoTime(time, duration).toFixed(3)),
    [],
  );

  const [duration, durationStateRef, setDuration] = useRefState(() =>
    getFiniteDuration(item.duration),
  );
  const [currentTime, currentTimeRef, setCurrentTime] = useRefState(0);
  const [isScrubbing, isScrubbingRef, setIsScrubbing] = useRefState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const videoFrameCallbackRef = useRef<number | null>(null);
  const timelineStateRef = useRef({
    anchorTime: 0,
    anchorTimestamp: null as number | null,
    playbackRate: 1,
  });
  const timelineStateWriteRef = useRef({
    lastTimestamp: Number.NEGATIVE_INFINITY,
    lastTime: Number.NaN,
  });

  const writePlayheadPosition = useCallback(
    (time: number) => {
      const duration = durationStateRef.current;
      const timeline = timelineRef.current;
      if (duration <= 0 || !timeline) return;

      const ratio = clampVideoTime(time, duration) / duration;

      timeline.style.setProperty(
        "--video-playhead-position",
        `${ratio * 100}%`,
      );
    },
    [durationStateRef],
  );

  const syncCurrentTimeState = useCallback(
    (
      time: number,
      duration: number,
      {
        force = false,
        timestamp,
      }: {
        force?: boolean;
        timestamp?: number;
      } = {},
    ) => {
      const roundedTime = roundTimelineStateTime(time, duration);
      const lastWrite = timelineStateWriteRef.current;
      if (!force) {
        if (roundedTime === lastWrite.lastTime) {
          return;
        }

        if (
          timestamp !== undefined &&
          timestamp - lastWrite.lastTimestamp < TIMELINE_STATE_WRITE_INTERVAL_MS
        ) {
          return;
        }
      }

      timelineStateWriteRef.current = {
        lastTimestamp:
          timestamp ?? Math.max(lastWrite.lastTimestamp, performance.now()),
        lastTime: roundedTime,
      };
      setCurrentTime(roundedTime);
    },
    [roundTimelineStateTime, setCurrentTime],
  );

  const supportsVideoFrameCallback = useCallback((video: HTMLVideoElement) => {
    return (
      "requestVideoFrameCallback" in video &&
      typeof video.requestVideoFrameCallback === "function" &&
      typeof video.cancelVideoFrameCallback === "function"
    );
  }, []);

  const stopTimelineAnimation = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const video = videoRef.current;
    if (
      videoFrameCallbackRef.current !== null &&
      video &&
      supportsVideoFrameCallback(video)
    ) {
      video.cancelVideoFrameCallback(videoFrameCallbackRef.current);
      videoFrameCallbackRef.current = null;
    }
  }, [supportsVideoFrameCallback, videoRef]);

  const handleLoopBoundary = useCallback(
    (video: HTMLVideoElement, timestamp: number, nextTime: number) => {
      const duration = durationStateRef.current;
      const loopRange = getLoopRange(loopRef.current);

      if (
        !loopRef.current.enabled ||
        loopRange === null ||
        nextTime < loopRange.end
      ) {
        return false;
      }

      video.currentTime = loopRange.start;
      timelineStateRef.current = {
        anchorTime: loopRange.start,
        anchorTimestamp: timestamp,
        playbackRate: video.playbackRate || 1,
      };
      // Loop jumps are the deliberate exception to the animation write throttle:
      // React state needs to reflect the wrapped playhead immediately so timeline
      // consumers do not spend a frame observing the stale pre-loop position.
      syncCurrentTimeState(loopRange.start, duration, {
        force: true,
        timestamp,
      });
      writePlayheadPosition(loopRange.start);
      return true;
    },
    [durationStateRef, loopRef, syncCurrentTimeState, writePlayheadPosition],
  );

  const scheduleVideoFrameCallback = useCallback(() => {
    const video = videoRef.current;
    const duration = durationStateRef.current;
    if (
      !video ||
      duration <= 0 ||
      video.paused ||
      video.ended ||
      isScrubbingRef.current ||
      !supportsVideoFrameCallback(video)
    ) {
      videoFrameCallbackRef.current = null;
      return;
    }

    videoFrameCallbackRef.current = video.requestVideoFrameCallback(
      (timestamp, metadata) => {
        videoFrameCallbackRef.current = null;

        const activeVideo = videoRef.current;
        const activeDuration = durationStateRef.current;
        if (
          !activeVideo ||
          activeDuration <= 0 ||
          activeVideo.paused ||
          activeVideo.ended ||
          isScrubbingRef.current
        ) {
          return;
        }

        const nextTime = clampTimelineTime(metadata.mediaTime, activeDuration);
        if (handleLoopBoundary(activeVideo, timestamp, nextTime)) {
          scheduleVideoFrameCallback();
          return;
        }

        writePlayheadPosition(nextTime);
        syncCurrentTimeState(nextTime, activeDuration, { timestamp });
        scheduleVideoFrameCallback();
      },
    );
  }, [
    clampTimelineTime,
    durationStateRef,
    handleLoopBoundary,
    isScrubbingRef,
    syncCurrentTimeState,
    supportsVideoFrameCallback,
    videoRef,
    writePlayheadPosition,
  ]);

  const tickTimeline = useCallback(
    (timestamp: number) => {
      const video = videoRef.current;
      const duration = durationStateRef.current;

      if (
        !video ||
        duration <= 0 ||
        video.paused ||
        video.ended ||
        isScrubbingRef.current
      ) {
        rafRef.current = null;
        return;
      }

      const state = timelineStateRef.current;
      if (state.anchorTimestamp === null) {
        timelineStateRef.current = {
          ...state,
          anchorTimestamp: timestamp,
        };
      }
      const anchorTimestamp =
        timelineStateRef.current.anchorTimestamp ?? timestamp;
      const elapsed = (timestamp - anchorTimestamp) / 1000;
      const nextTime = clampTimelineTime(
        timelineStateRef.current.anchorTime +
          elapsed * timelineStateRef.current.playbackRate,
        duration,
      );
      if (handleLoopBoundary(video, timestamp, nextTime)) {
        rafRef.current = requestAnimationFrame(tickTimeline);
        return;
      }

      writePlayheadPosition(nextTime);
      syncCurrentTimeState(nextTime, duration, { timestamp });
      rafRef.current = requestAnimationFrame(tickTimeline);
    },
    [
      durationStateRef,
      handleLoopBoundary,
      isScrubbingRef,
      clampTimelineTime,
      syncCurrentTimeState,
      videoRef,
      writePlayheadPosition,
    ],
  );

  const startTimelineAnimation = useCallback(() => {
    const video = videoRef.current;
    if (!video || durationStateRef.current <= 0 || isScrubbingRef.current) {
      return;
    }

    timelineStateRef.current = {
      anchorTime: clampTimelineTime(
        video.currentTime,
        durationStateRef.current,
      ),
      anchorTimestamp: null,
      playbackRate: video.playbackRate || 1,
    };

    if (supportsVideoFrameCallback(video)) {
      if (videoFrameCallbackRef.current === null) {
        scheduleVideoFrameCallback();
      }
      return;
    }

    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tickTimeline);
    }
  }, [
    clampTimelineTime,
    durationStateRef,
    isScrubbingRef,
    scheduleVideoFrameCallback,
    supportsVideoFrameCallback,
    tickTimeline,
    videoRef,
  ]);

  const syncTimelineFromVideo = useCallback(
    (
      time: number,
      nextDuration = durationStateRef.current,
      {
        writePlayhead = true,
        alignToRafTimestamp = false,
        writeState = true,
      }: SyncTimelineOptions = {},
    ) => {
      const safeDuration = Number.isFinite(nextDuration) ? nextDuration : 0;
      const nextTime = clampTimelineTime(time, safeDuration);
      const video = videoRef.current;
      const playbackRate = video?.playbackRate || 1;

      durationStateRef.current = safeDuration;
      if (alignToRafTimestamp) {
        timelineStateRef.current = {
          anchorTime: nextTime,
          anchorTimestamp: null,
          playbackRate,
        };
      } else {
        timelineStateRef.current = {
          anchorTime: nextTime,
          anchorTimestamp: performance.now(),
          playbackRate,
        };
      }

      if (writeState) {
        syncCurrentTimeState(nextTime, safeDuration, { force: true });
      }
      if (writePlayhead) {
        writePlayheadPosition(nextTime);
      }
    },
    [
      clampTimelineTime,
      durationStateRef,
      syncCurrentTimeState,
      videoRef,
      writePlayheadPosition,
    ],
  );

  const updateVideoMetadata = useCallback(
    (onMetadataReady?: () => void) => {
      const video = videoRef.current;
      if (!video) return;

      const nextDuration =
        getFiniteDuration(video.duration) || durationStateRef.current;
      setDuration(nextDuration);
      syncTimelineFromVideo(video.currentTime, nextDuration);
      onMetadataReady?.();
    },
    [durationStateRef, setDuration, syncTimelineFromVideo, videoRef],
  );

  const syncPlaybackRate = useCallback(
    (time: number, playbackRate: number) => {
      timelineStateRef.current = {
        anchorTime: clampTimelineTime(time, durationStateRef.current),
        anchorTimestamp: null,
        playbackRate: playbackRate || 1,
      };
    },
    [clampTimelineTime, durationStateRef],
  );

  const seekToRatio = useCallback(
    (ratio: number) => {
      const video = videoRef.current;
      const duration = durationStateRef.current;
      if (!video || duration <= 0) return;

      const nextTime = clampTimelineTime(ratio * duration, duration);
      video.currentTime = nextTime;
      syncTimelineFromVideo(nextTime, duration);
    },
    [clampTimelineTime, durationStateRef, syncTimelineFromVideo, videoRef],
  );

  const seekFromPointer = useCallback(
    (clientX: number) => {
      const timeline = timelineRef.current;
      if (!timeline) return;

      const rect = timeline.getBoundingClientRect();
      const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      seekToRatio(Math.min(Math.max(ratio, 0), 1));
    },
    [seekToRatio],
  );

  const setTimelineScrubbing = useCallback(
    (nextIsScrubbing: boolean) => {
      setIsScrubbing(nextIsScrubbing);
    },
    [setIsScrubbing],
  );

  const resetTimeline = useCallback(() => {
    stopTimelineAnimation();
    const nextDuration = getFiniteDuration(item.duration);
    setDuration(nextDuration);
    timelineStateWriteRef.current = {
      lastTimestamp: Number.NEGATIVE_INFINITY,
      lastTime: 0,
    };
    setCurrentTime(0);
    setTimelineScrubbing(false);
    writePlayheadPosition(0);
  }, [
    item.duration,
    setCurrentTime,
    setDuration,
    setTimelineScrubbing,
    stopTimelineAnimation,
    writePlayheadPosition,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: url intentionally resets timeline state when the backing media source changes.
  useEffect(() => {
    resetTimeline();
  }, [resetTimeline, url]);

  useEffect(() => stopTimelineAnimation, [stopTimelineAnimation]);

  return {
    currentTime,
    currentTimeRef,
    duration,
    durationRef: durationStateRef,
    isScrubbing,
    isScrubbingRef,
    timelineRef,
    seekFromPointer,
    seekToRatio,
    setTimelineScrubbing,
    startTimelineAnimation,
    stopTimelineAnimation,
    syncPlaybackRate,
    syncTimelineFromVideo,
    updateVideoMetadata,
  };
}
