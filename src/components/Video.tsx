import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAudioPlaybackStore } from "../stores/useAudioPlaybackStore";
import {
  getStoredVideoLoop,
  useVideoExportStore,
} from "../stores/useVideoExportStore";
import { getCropBoxStyle } from "../utils/media";
import {
  getVideoLod,
  initialLoopState,
  shouldRequestVideoThumbnail,
} from "../utils/videoUtils";
import { useVideoLoop } from "./useVideoLoop";
import { useVideoPlayback } from "./useVideoPlayback";
import { useVideoTimeline } from "./useVideoTimeline";
import type { VideoMediaProps, VideoTimelineController } from "./Video.types";
import { VideoLoadProxy, VideoProxy, VideoThumbnail } from "./VideoLodViews";
import { VideoTimeline } from "./VideoTimeline";
import type { StopCanvasGestureHandler } from "./VideoTimeline.types";

export {
  clampVideoTime,
  getVideoLod,
  shouldRequestVideoThumbnail,
} from "../utils/videoUtils";

export function VideoMedia({
  url,
  crop,
  item,
  isInViewport,
  zoom,
  onTimelineControllerChange,
  onReadyChange,
  onThumbnailNeeded,
  showTimelineInline = true,
}: VideoMediaProps) {
  const [isLoadRequested, setIsLoadRequested] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [initialLoop] = useState(() => getStoredVideoLoop(item.id));
  const videoRef = useRef<HTMLVideoElement>(null);
  const externalLoopRef = useRef(initialLoopState);
  const setVideoLoopState = useVideoExportStore((s) => s.setLoopState);

  const activeAudioItemId = useAudioPlaybackStore((s) => s.activeItemId);
  const audioVolume = useAudioPlaybackStore((s) => s.volume);
  const isAudioMuted = useAudioPlaybackStore((s) => s.muted);

  const isAudioActive = activeAudioItemId === item.id;
  const isVideoRequested = isLoadRequested || isAudioActive;
  const lod = isVideoRequested
    ? "video"
    : getVideoLod(zoom, !!item.thumbnailUrl, item);
  const shouldDeferVideoLoad = !!item.deferVideoLoad && !isVideoRequested;

  const stopCanvasGesture = useCallback<StopCanvasGestureHandler>((e) => {
    e.stopPropagation();
  }, []);

  useEffect(() => {
    if (
      !item.thumbnailUrl &&
      (item.deferVideoLoad || shouldRequestVideoThumbnail(zoom, item))
    ) {
      onThumbnailNeeded?.(item);
    }
  }, [item, onThumbnailNeeded, zoom]);

  useEffect(() => {
    if (shouldDeferVideoLoad) {
      onReadyChange?.(true);
      return;
    }

    if (lod === "thumbnail") {
      onReadyChange?.(false);
      return;
    }

    if (lod === "proxy") {
      onReadyChange?.(false);
      return;
    }

    onReadyChange?.(false);
  }, [lod, onReadyChange, shouldDeferVideoLoad]);

  const {
    currentTime,
    duration,
    durationRef,
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
  } = useVideoTimeline({
    videoRef,
    url,
    item,
    loopRef: externalLoopRef,
  });

  const { loop, setLoopPoint, toggleLoop, clearLoop } = useVideoLoop({
    videoRef,
    timelineRef,
    durationRef,
    externalLoopRef,
    initialLoop,
    duration,
    url,
    syncTimelineFromVideo,
  });

  useEffect(() => {
    setVideoLoopState(item.id, loop);
  }, [item.id, loop, setVideoLoopState]);

  const { isPaused, playVideo, togglePlayback, handlePlay, handlePause } =
    useVideoPlayback({
      videoRef,
      lod,
      isInViewport,
      shouldDeferVideoLoad,
      onPause: stopTimelineAnimation,
      onPlay: startTimelineAnimation,
      onPlaybackError: setPlaybackError,
    });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.volume = Math.min(1, Math.max(0, audioVolume));
    video.muted = !isAudioActive || isAudioMuted || audioVolume <= 0;

    if (isAudioActive) {
      playVideo();
    }
  }, [audioVolume, isAudioActive, isAudioMuted, playVideo]);

  const timelineController = useMemo<VideoTimelineController>(
    () => ({
      clearLoop,
      currentTime,
      duration,
      isPaused,
      isScrubbing,
      isScrubbingRef,
      loop,
      playbackError,
      seekFromPointer,
      seekToRatio,
      setLoopPoint,
      setTimelineScrubbing,
      startTimelineAnimation,
      stopCanvasGesture,
      stopTimelineAnimation,
      timelineRef,
      toggleLoop,
      togglePlayback,
    }),
    [
      clearLoop,
      currentTime,
      duration,
      isPaused,
      isScrubbing,
      isScrubbingRef,
      loop,
      playbackError,
      seekFromPointer,
      seekToRatio,
      setLoopPoint,
      setTimelineScrubbing,
      startTimelineAnimation,
      stopCanvasGesture,
      stopTimelineAnimation,
      timelineRef,
      toggleLoop,
      togglePlayback,
    ],
  );

  useEffect(() => {
    onTimelineControllerChange?.(item.id, timelineController);

    return () => {
      onTimelineControllerChange?.(item.id, null);
    };
  }, [item.id, onTimelineControllerChange, timelineController]);

  const cropBoxStyle = getCropBoxStyle(item, crop);

  // TODO: Interaction for massive video loads.
  if (shouldDeferVideoLoad) {
    return (
      <VideoLoadProxy
        cropBoxStyle={cropBoxStyle}
        thumbnailUrl={item.thumbnailUrl}
        onLoadRequested={() => {
          setPlaybackError(null);
          setIsLoadRequested(true);
        }}
      />
    );
  }

  if (lod === "thumbnail" && item.thumbnailUrl) {
    return (
      <VideoThumbnail
        cropBoxStyle={cropBoxStyle}
        thumbnailUrl={item.thumbnailUrl}
        onReadyChange={onReadyChange}
      />
    );
  }

  if (lod === "proxy") {
    return <VideoProxy />;
  }

  return (
    <>
      <div className="media-crop-box" style={cropBoxStyle}>
        <video
          ref={videoRef}
          className={`media-content ${isLoadRequested ? "video-load-requested" : ""}`}
          src={url}
          autoPlay={isInViewport}
          preload={isVideoRequested && isInViewport ? "auto" : "metadata"}
          loop={!loop.enabled}
          muted={!isAudioActive || isAudioMuted || audioVolume <= 0}
          playsInline
          draggable={false}
          onLoadedMetadata={() => updateVideoMetadata(playVideo)}
          onCanPlay={() => {
            onReadyChange?.(true);
            playVideo();
            startTimelineAnimation();
          }}
          onDurationChange={() => updateVideoMetadata()}
          onPlay={handlePlay}
          onPause={handlePause}
          onRateChange={(e) => {
            syncPlaybackRate(
              e.currentTarget.currentTime,
              e.currentTarget.playbackRate,
            );
          }}
          onSeeked={(e) => {
            syncTimelineFromVideo(e.currentTarget.currentTime);
            startTimelineAnimation();
          }}
          onTimeUpdate={(e) => {
            if (!isScrubbingRef.current) {
              syncTimelineFromVideo(e.currentTarget.currentTime);
            }
          }}
          onError={() => {
            onReadyChange?.(false);
            setPlaybackError(
              "Playback failed. This file may need transcoding.",
            );
          }}
          onDragStart={(e) => e.preventDefault()}
        />
      </div>
      {showTimelineInline && <VideoTimeline {...timelineController} />}
    </>
  );
}
