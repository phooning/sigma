import {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { CropInsets, MediaItem } from "../utils/media.types";
import { useVideoLoop } from "./useVideoLoop";
import { useVideoPlayback } from "./useVideoPlayback";
import { useVideoTimeline } from "./useVideoTimeline";
import {
  formatVideoTime,
  getLoopRange,
  getVideoLod,
  initialLoopState,
  shouldRequestVideoThumbnail,
} from "./videoUtils";

export {
  clampVideoTime,
  getVideoLod,
  shouldRequestVideoThumbnail,
} from "./videoUtils";

interface VideoMediaProps {
  url: string;
  crop: CropInsets;
  item: MediaItem;
  isInViewport: boolean;
  zoom: number;
  onThumbnailNeeded?: (item: MediaItem) => void;
}

export function VideoMedia({
  url,
  crop,
  item,
  isInViewport,
  zoom,
  onThumbnailNeeded,
}: VideoMediaProps) {
  const [isLoadRequested, setIsLoadRequested] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const externalLoopRef = useRef(initialLoopState);
  const lod = isLoadRequested
    ? "video"
    : getVideoLod(zoom, !!item.thumbnailUrl, item);
  const shouldDeferVideoLoad = !!item.deferVideoLoad && !isLoadRequested;

  const stopCanvasGesture = (
    e: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>,
  ) => {
    e.stopPropagation();
  };

  useEffect(() => {
    if (
      !item.thumbnailUrl &&
      (item.deferVideoLoad || shouldRequestVideoThumbnail(zoom, item))
    ) {
      onThumbnailNeeded?.(item);
    }
  }, [item, onThumbnailNeeded, zoom]);

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
    duration,
    url,
    syncTimelineFromVideo,
  });

  const {
    isPaused,
    playVideo,
    togglePlayback,
    handlePlay,
    handlePause,
  } = useVideoPlayback({
    videoRef,
    lod,
    isInViewport,
    shouldDeferVideoLoad,
    onPause: stopTimelineAnimation,
    onPlay: startTimelineAnimation,
    onPlaybackError: setPlaybackError,
  });

  const mediaStyle = {
    left: -crop.left,
    top: -crop.top,
    width: item.width + crop.left + crop.right,
    height: item.height + crop.top + crop.bottom,
  };

  if (shouldDeferVideoLoad) {
    return (
      <button
        className="video-lod-proxy video-load-proxy"
        aria-label="Load video"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setPlaybackError(null);
          setIsLoadRequested(true);
        }}
      >
        {item.thumbnailUrl && (
          <img
            className="media-content video-lod-thumbnail video-load-thumbnail"
            src={item.thumbnailUrl}
            alt=""
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            style={mediaStyle}
          />
        )}
        <span className="video-lod-icon" aria-hidden="true" />
        <span className="video-load-label">Load video</span>
      </button>
    );
  }

  if (lod === "thumbnail" && item.thumbnailUrl) {
    return (
      <img
        className="media-content video-lod-thumbnail"
        src={item.thumbnailUrl}
        alt="video thumbnail"
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        style={mediaStyle}
      />
    );
  }

  if (lod === "proxy") {
    return (
      <div className="video-lod-proxy" aria-label="video proxy">
        <span className="video-lod-icon" aria-hidden="true" />
      </div>
    );
  }

  return (
    <>
      <video
        ref={videoRef}
        className={`media-content ${isLoadRequested ? "video-load-requested" : ""}`}
        src={url}
        autoPlay={isInViewport}
        preload={isLoadRequested && isInViewport ? "auto" : "metadata"}
        loop={!loop.enabled}
        muted
        playsInline
        draggable={false}
        onLoadedMetadata={() => updateVideoMetadata(playVideo)}
        onCanPlay={() => {
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
          setPlaybackError("Playback failed. This file may need transcoding.");
        }}
        onDragStart={(e) => e.preventDefault()}
        style={mediaStyle}
      />
      {duration > 0 && (
        <div
          className={`video-timeline ${isScrubbing ? "is-scrubbing" : ""}`}
          onPointerDown={stopCanvasGesture}
          onPointerMove={stopCanvasGesture}
          onPointerUp={stopCanvasGesture}
          onClick={stopCanvasGesture}
        >
          <button
            type="button"
            className="video-playback-btn"
            aria-label={isPaused ? "Play video" : "Pause video"}
            aria-pressed={isPaused}
            onPointerDown={stopCanvasGesture}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              togglePlayback();
            }}
          >
            {isPaused ? "Play" : "Pause"}
          </button>
          <div
            ref={timelineRef}
            className="video-timeline-track"
            role="slider"
            aria-label="Video timeline"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(currentTime)}
            aria-valuetext={`${formatVideoTime(currentTime)} of ${formatVideoTime(duration)}`}
            tabIndex={0}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setTimelineScrubbing(true);
              stopTimelineAnimation();
              e.currentTarget.setPointerCapture(e.pointerId);
              seekFromPointer(e.clientX);
            }}
            onPointerMove={(e) => {
              e.stopPropagation();
              if (isScrubbingRef.current) {
                seekFromPointer(e.clientX);
              }
            }}
            onPointerUp={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setTimelineScrubbing(false);
              seekFromPointer(e.clientX);
              e.currentTarget.releasePointerCapture(e.pointerId);
              startTimelineAnimation();
            }}
            onPointerCancel={(e) => {
              e.stopPropagation();
              setTimelineScrubbing(false);
              startTimelineAnimation();
            }}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 10 : 5;
              if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                e.preventDefault();
                seekToRatio((currentTime - step) / duration);
              } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                e.preventDefault();
                seekToRatio((currentTime + step) / duration);
              } else if (e.key === "Home") {
                e.preventDefault();
                seekToRatio(0);
              } else if (e.key === "End") {
                e.preventDefault();
                seekToRatio(1);
              }
            }}
          >
            <div className="video-timeline-buffer" />
            {loop.a !== null && (
              <div
                className="video-loop-marker video-loop-marker-a"
                aria-hidden="true"
              >
                A
              </div>
            )}
            {loop.b !== null && (
              <div
                className="video-loop-marker video-loop-marker-b"
                aria-hidden="true"
              >
                B
              </div>
            )}
            {getLoopRange(loop) !== null && (
              <div
                className={`video-loop-range ${loop.enabled ? "is-enabled" : ""}`}
                aria-hidden="true"
              />
            )}
            <div className="video-timeline-progress" />
            <div className="video-timeline-thumb" />
          </div>
          <div className="video-timeline-time">
            {formatVideoTime(currentTime)} / {formatVideoTime(duration)}
          </div>
          <div className="video-loop-controls" aria-label="Loop controls">
            <button
              type="button"
              className="video-loop-btn"
              aria-label="Set loop A point"
              onPointerDown={stopCanvasGesture}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setLoopPoint("a");
              }}
            >
              A
            </button>
            <button
              type="button"
              className="video-loop-btn"
              aria-label="Set loop B point"
              onPointerDown={stopCanvasGesture}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setLoopPoint("b");
              }}
            >
              B
            </button>
            <button
              type="button"
              className="video-loop-btn video-loop-toggle"
              aria-label="Toggle A/B loop"
              aria-pressed={loop.enabled}
              disabled={getLoopRange(loop) === null}
              onPointerDown={stopCanvasGesture}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleLoop();
              }}
            >
              Loop
            </button>
            {(loop.a !== null || loop.b !== null) && (
              <button
                type="button"
                className="video-loop-btn"
                aria-label="Clear A/B loop"
                onPointerDown={stopCanvasGesture}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  clearLoop();
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
      {playbackError && (
        <div className="video-playback-error" role="status">
          {playbackError}
        </div>
      )}
    </>
  );
}
