import { type RefObject, useCallback, useEffect, useRef } from "react";
import type { VideoLod } from "../utils/videoUtils";
import { useRefState } from "./useRefState";

interface UseVideoPlaybackArgs {
  videoRef: RefObject<HTMLVideoElement | null>;
  lod: VideoLod;
  isInViewport: boolean;
  shouldDeferVideoLoad: boolean;
  onPause: () => void;
  onPlay: () => void;
  onPlaybackError: (message: string | null) => void;
}

export function useVideoPlayback({
  videoRef,
  lod,
  isInViewport,
  shouldDeferVideoLoad,
  onPause,
  onPlay,
  onPlaybackError,
}: UseVideoPlaybackArgs) {
  const [isPaused, isPausedRef, setIsPaused] = useRefState(false);
  const isPausedByUserRef = useRef(false);

  const playVideo = useCallback(() => {
    const video = videoRef.current;
    if (
      !video ||
      lod !== "video" ||
      !isInViewport ||
      shouldDeferVideoLoad ||
      isPausedByUserRef.current
    ) {
      return;
    }

    const playPromise = video.play();
    playPromise
      ?.then(() => onPlaybackError(null))
      .catch(() => {
        onPlaybackError("Playback failed. This file may need transcoding.");
      });
  }, [isInViewport, lod, onPlaybackError, shouldDeferVideoLoad, videoRef]);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      isPausedByUserRef.current = false;
      setIsPaused(false);
      playVideo();
      onPlay();
    } else {
      isPausedByUserRef.current = true;
      setIsPaused(true);
      video.pause();
      onPause();
    }
  }, [onPause, onPlay, playVideo, setIsPaused, videoRef]);

  const handlePlay = useCallback(() => {
    setIsPaused(false);
    onPlay();
  }, [onPlay, setIsPaused]);

  const handlePause = useCallback(() => {
    setIsPaused(true);
    onPause();
  }, [onPause, setIsPaused]);

  const resetPlaybackIntent = useCallback(() => {
    isPausedByUserRef.current = false;
    setIsPaused(false);
  }, [setIsPaused]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (lod === "video" && isInViewport && !shouldDeferVideoLoad) {
      playVideo();
    } else {
      video.pause();
      onPause();
    }
  }, [isInViewport, lod, onPause, playVideo, shouldDeferVideoLoad, videoRef]);

  return {
    isPaused,
    isPausedRef,
    isPausedByUserRef,
    playVideo,
    togglePlayback,
    handlePlay,
    handlePause,
    resetPlaybackIntent,
  };
}
