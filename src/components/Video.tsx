import {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { CropInsets, MediaItem } from "../utils/media.types";

const THUMBNAIL_MAX_SCREEN_WIDTH = 144;
const PROXY_MAX_SCREEN_WIDTH = 96;
const PROXY_MAX_SCREEN_HEIGHT = 72;

interface VideoMediaProps {
  url: string;
  crop: CropInsets;
  item: MediaItem;
  isInViewport: boolean;
  zoom: number;
  onThumbnailNeeded?: (item: MediaItem) => void;
}

type VideoLod = "video" | "thumbnail" | "proxy";

interface LoopState {
  enabled: boolean;
  a: number | null;
  b: number | null;
}

export const clampVideoTime = (time: number, duration: number) => {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }

  return Math.min(Math.max(time, 0), duration);
};

const formatVideoTime = (time: number) => {
  const safeTime = Number.isFinite(time) ? Math.max(0, Math.floor(time)) : 0;
  const minutes = Math.floor(safeTime / 60);
  const seconds = safeTime % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const getFiniteDuration = (duration: number | undefined) =>
  typeof duration === "number" && Number.isFinite(duration) && duration > 0
    ? duration
    : 0;

export const getVideoLod = (
  zoom: number,
  hasThumbnail: boolean,
  item: MediaItem,
): VideoLod => {
  const screenWidth = item.width * zoom;
  const screenHeight = item.height * zoom;

  if (
    screenWidth <= PROXY_MAX_SCREEN_WIDTH ||
    screenHeight <= PROXY_MAX_SCREEN_HEIGHT
  ) {
    return "proxy";
  }

  if (screenWidth <= THUMBNAIL_MAX_SCREEN_WIDTH) {
    return hasThumbnail ? "thumbnail" : "proxy";
  }

  return "video";
};

export const shouldRequestVideoThumbnail = (zoom: number, item: MediaItem) => {
  const screenWidth = item.width * zoom;
  const screenHeight = item.height * zoom;

  return (
    screenWidth <= THUMBNAIL_MAX_SCREEN_WIDTH &&
    screenWidth > PROXY_MAX_SCREEN_WIDTH &&
    screenHeight > PROXY_MAX_SCREEN_HEIGHT
  );
};

const getLoopRange = (loop: LoopState) => {
  if (loop.a === null || loop.b === null || loop.a === loop.b) {
    return null;
  }

  return {
    start: Math.min(loop.a, loop.b),
    end: Math.max(loop.a, loop.b),
  };
};

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
  const [duration, setDuration] = useState(() =>
    getFiniteDuration(item.duration),
  );
  const [currentTime, setCurrentTime] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [loop, setLoop] = useState<LoopState>({
    enabled: false,
    a: null,
    b: null,
  });
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const durationRef = useRef(getFiniteDuration(item.duration));
  const isScrubbingRef = useRef(false);
  const loopRef = useRef<LoopState>({
    enabled: false,
    a: null,
    b: null,
  });
  const timelineStateRef = useRef({
    anchorTime: 0,
    anchorTimestamp: 0,
    playbackRate: 1,
  });
  const lod = isLoadRequested
    ? "video"
    : getVideoLod(zoom, !!item.thumbnailUrl, item);
  const shouldDeferVideoLoad = !!item.deferVideoLoad && !isLoadRequested;

  useEffect(() => {
    if (
      !item.thumbnailUrl &&
      (item.deferVideoLoad || shouldRequestVideoThumbnail(zoom, item))
    ) {
      onThumbnailNeeded?.(item);
    }
  }, [item, onThumbnailNeeded, zoom]);

  const playVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video || lod !== "video" || !isInViewport || shouldDeferVideoLoad) {
      return;
    }

    const playPromise = video.play();
    playPromise
      ?.then(() => setPlaybackError(null))
      .catch(() => {
        setPlaybackError("Playback failed. This file may need transcoding.");
      });
  }, [isInViewport, lod, shouldDeferVideoLoad]);

  const writePlayheadPosition = useCallback((time: number) => {
    const duration = durationRef.current;
    const timeline = timelineRef.current;
    if (duration <= 0 || !timeline) return;

    const ratio = clampVideoTime(time, duration) / duration;

    timeline.style.setProperty(
      "--video-playhead-position",
      `${ratio * 100}%`,
    );
  }, []);

  const writeLoopPosition = useCallback((nextLoop: LoopState) => {
    const duration = durationRef.current;
    const timeline = timelineRef.current;
    if (duration <= 0 || !timeline) return;

    const aPosition =
      nextLoop.a === null ? "-100%" : `${(clampVideoTime(nextLoop.a, duration) / duration) * 100}%`;
    const bPosition =
      nextLoop.b === null ? "-100%" : `${(clampVideoTime(nextLoop.b, duration) / duration) * 100}%`;
    const range = getLoopRange(nextLoop);
    const rangeStart =
      range === null ? "0%" : `${(clampVideoTime(range.start, duration) / duration) * 100}%`;
    const rangeEnd =
      range === null ? "0%" : `${(clampVideoTime(range.end, duration) / duration) * 100}%`;

    timeline.style.setProperty("--video-loop-a-position", aPosition);
    timeline.style.setProperty("--video-loop-b-position", bPosition);
    timeline.style.setProperty("--video-loop-start-position", rangeStart);
    timeline.style.setProperty("--video-loop-end-position", rangeEnd);
  }, []);

  const stopTimelineAnimation = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const tickTimeline = useCallback(
    (timestamp: number) => {
      const video = videoRef.current;
      const duration = durationRef.current;

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
    [writePlayheadPosition],
  );

  const startTimelineAnimation = useCallback(() => {
    const video = videoRef.current;
    if (!video || durationRef.current <= 0 || isScrubbingRef.current) return;

    timelineStateRef.current = {
      anchorTime: clampVideoTime(video.currentTime, durationRef.current),
      anchorTimestamp: performance.now(),
      playbackRate: video.playbackRate || 1,
    };

    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tickTimeline);
    }
  }, [tickTimeline]);

  const syncTimelineFromVideo = useCallback(
    (time: number, nextDuration = durationRef.current) => {
      const safeDuration = Number.isFinite(nextDuration) ? nextDuration : 0;
      const nextTime = clampVideoTime(time, safeDuration);
      const video = videoRef.current;

      durationRef.current = safeDuration;
      timelineStateRef.current = {
        anchorTime: nextTime,
        anchorTimestamp: performance.now(),
        playbackRate: video?.playbackRate || 1,
      };

      setCurrentTime(nextTime);
      writePlayheadPosition(nextTime);
    },
    [writePlayheadPosition],
  );

  const updateVideoMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    const nextDuration =
      getFiniteDuration(video.duration) || durationRef.current;
    durationRef.current = nextDuration;
    setDuration(nextDuration);
    syncTimelineFromVideo(video.currentTime, nextDuration);
    playVideo();
  }, [playVideo, syncTimelineFromVideo]);

  const seekToRatio = useCallback(
    (ratio: number) => {
      const video = videoRef.current;
      const duration = durationRef.current;
      if (!video || duration <= 0) return;

      const nextTime = clampVideoTime(ratio * duration, duration);
      video.currentTime = nextTime;
      syncTimelineFromVideo(nextTime, duration);
    },
    [syncTimelineFromVideo],
  );

  const seekFromPointer = useCallback(
    (clientX: number) => {
      const timeline = timelineRef.current;
      if (!timeline) return;

      const rect = timeline.getBoundingClientRect();
      const ratio =
        rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      seekToRatio(Math.min(Math.max(ratio, 0), 1));
    },
    [seekToRatio],
  );

  const stopCanvasGesture = (
    e: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>,
  ) => {
    e.stopPropagation();
  };

  const setTimelineScrubbing = useCallback((nextIsScrubbing: boolean) => {
    isScrubbingRef.current = nextIsScrubbing;
    setIsScrubbing(nextIsScrubbing);
  }, []);

  const updateLoop = useCallback(
    (getNextLoop: (previous: LoopState) => LoopState) => {
      setLoop((previous) => {
        const nextLoop = getNextLoop(previous);
        loopRef.current = nextLoop;
        writeLoopPosition(nextLoop);
        return nextLoop;
      });
    },
    [writeLoopPosition],
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
    [updateLoop],
  );

  const toggleLoop = useCallback(() => {
    const previous = loopRef.current;
    const range = getLoopRange(previous);
    const nextLoop = {
      ...previous,
      enabled: range === null ? false : !previous.enabled,
    };

    loopRef.current = nextLoop;
    setLoop(nextLoop);
    writeLoopPosition(nextLoop);

    if (nextLoop.enabled && range !== null && videoRef.current) {
      const video = videoRef.current;
      if (video.currentTime < range.start || video.currentTime > range.end) {
        video.currentTime = range.start;
        syncTimelineFromVideo(range.start);
      }
    }
  }, [syncTimelineFromVideo, writeLoopPosition]);

  const clearLoop = useCallback(() => {
    updateLoop(() => ({
      enabled: false,
      a: null,
      b: null,
    }));
  }, [updateLoop]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (lod === "video" && isInViewport && !shouldDeferVideoLoad) {
      playVideo();
    } else {
      video.pause();
      stopTimelineAnimation();
    }
  }, [
    isInViewport,
    lod,
    playVideo,
    shouldDeferVideoLoad,
    stopTimelineAnimation,
  ]);

  useEffect(() => {
    stopTimelineAnimation();
    const nextDuration = getFiniteDuration(item.duration);
    durationRef.current = nextDuration;
    isScrubbingRef.current = false;
    loopRef.current = { enabled: false, a: null, b: null };
    setDuration(nextDuration);
    setCurrentTime(0);
    setIsScrubbing(false);
    setLoop({ enabled: false, a: null, b: null });
  }, [item.duration, stopTimelineAnimation, url]);

  useEffect(() => {
    writePlayheadPosition(currentTime);
    writeLoopPosition(loop);
  }, [currentTime, duration, loop, writeLoopPosition, writePlayheadPosition]);

  useEffect(() => stopTimelineAnimation, [stopTimelineAnimation]);

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
        onLoadedMetadata={updateVideoMetadata}
        onCanPlay={() => {
          playVideo();
          startTimelineAnimation();
        }}
        onDurationChange={updateVideoMetadata}
        onPlay={startTimelineAnimation}
        onPause={stopTimelineAnimation}
        onRateChange={(e) => {
          timelineStateRef.current = {
            anchorTime: clampVideoTime(
              e.currentTarget.currentTime,
              durationRef.current,
            ),
            anchorTimestamp: performance.now(),
            playbackRate: e.currentTarget.playbackRate || 1,
          };
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
