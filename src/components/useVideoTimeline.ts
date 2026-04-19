import {
  MutableRefObject,
  RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { MediaItem } from "../utils/media.types";
import { useRefState } from "./useRefState";
import {
  clampVideoTime,
  getFiniteDuration,
  getLoopRange,
  LoopState,
} from "../utils/videoUtils";

interface UseVideoTimelineArgs {
  videoRef: RefObject<HTMLVideoElement | null>;
  url: string;
  item: MediaItem;
  loopRef: MutableRefObject<LoopState>;
}

export function useVideoTimeline({
  videoRef,
  url,
  item,
  loopRef,
}: UseVideoTimelineArgs) {
  const [duration, durationStateRef, setDuration] = useRefState(() =>
    getFiniteDuration(item.duration),
  );
  const [currentTime, currentTimeRef, setCurrentTime] = useRefState(0);
  const [isScrubbing, isScrubbingRef, setIsScrubbing] = useRefState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const timelineStateRef = useRef({
    anchorTime: 0,
    anchorTimestamp: 0,
    playbackRate: 1,
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

  const stopTimelineAnimation = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

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
      const elapsed = (timestamp - state.anchorTimestamp) / 1000;
      const nextTime = clampVideoTime(
        state.anchorTime + elapsed * state.playbackRate,
        duration,
      );
      const loopRange = getLoopRange(loopRef.current);

      if (
        loopRef.current.enabled &&
        loopRange !== null &&
        nextTime >= loopRange.end
      ) {
        video.currentTime = loopRange.start;
        timelineStateRef.current = {
          anchorTime: loopRange.start,
          anchorTimestamp: timestamp,
          playbackRate: video.playbackRate || 1,
        };
        setCurrentTime(loopRange.start);
        writePlayheadPosition(loopRange.start);
        rafRef.current = requestAnimationFrame(tickTimeline);
        return;
      }

      writePlayheadPosition(nextTime);
      rafRef.current = requestAnimationFrame(tickTimeline);
    },
    [
      durationStateRef,
      isScrubbingRef,
      loopRef,
      setCurrentTime,
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
      anchorTime: clampVideoTime(video.currentTime, durationStateRef.current),
      anchorTimestamp: performance.now(),
      playbackRate: video.playbackRate || 1,
    };

    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tickTimeline);
    }
  }, [durationStateRef, isScrubbingRef, tickTimeline, videoRef]);

  const syncTimelineFromVideo = useCallback(
    (time: number, nextDuration = durationStateRef.current) => {
      const safeDuration = Number.isFinite(nextDuration) ? nextDuration : 0;
      const nextTime = clampVideoTime(time, safeDuration);
      const video = videoRef.current;

      durationStateRef.current = safeDuration;
      timelineStateRef.current = {
        anchorTime: nextTime,
        anchorTimestamp: performance.now(),
        playbackRate: video?.playbackRate || 1,
      };

      setCurrentTime(nextTime);
      writePlayheadPosition(nextTime);
    },
    [durationStateRef, setCurrentTime, videoRef, writePlayheadPosition],
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
        anchorTime: clampVideoTime(time, durationStateRef.current),
        anchorTimestamp: performance.now(),
        playbackRate: playbackRate || 1,
      };
    },
    [durationStateRef],
  );

  const seekToRatio = useCallback(
    (ratio: number) => {
      const video = videoRef.current;
      const duration = durationStateRef.current;
      if (!video || duration <= 0) return;

      const nextTime = clampVideoTime(ratio * duration, duration);
      video.currentTime = nextTime;
      syncTimelineFromVideo(nextTime, duration);
    },
    [durationStateRef, syncTimelineFromVideo, videoRef],
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
    setCurrentTime(0);
    setTimelineScrubbing(false);
  }, [
    item.duration,
    setCurrentTime,
    setDuration,
    setTimelineScrubbing,
    stopTimelineAnimation,
  ]);

  useEffect(() => {
    resetTimeline();
  }, [resetTimeline, url]);

  useEffect(() => {
    writePlayheadPosition(currentTime);
  }, [currentTime, duration, writePlayheadPosition]);

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
