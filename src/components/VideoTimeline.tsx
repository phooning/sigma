import { formatVideoTime, getLoopRange } from "../utils/videoUtils";
import type { VideoTimelineProps } from "./VideoTimeline.types";

export function VideoTimeline({
  clearLoop,
  currentTime,
  duration,
  isPaused,
  isScrubbing,
  isScrubbingRef,
  layout = "inline",
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
}: VideoTimelineProps) {
  const loopRange = getLoopRange(loop);
  const timelineClassName = [
    "video-timeline",
    layout === "footer" && "video-timeline-footer",
    isScrubbing && "is-scrubbing",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      {duration > 0 && (
        <div className={timelineClassName}>
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
            aria-valuemax={duration}
            aria-valuenow={currentTime}
            aria-valuetext={`${formatVideoTime(currentTime, {
              includeSubseconds: true,
            })} of ${formatVideoTime(duration)}`}
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
            {loopRange !== null && (
              <div
                className={`video-loop-range ${loop.enabled ? "is-enabled" : ""}`}
                aria-hidden="true"
              />
            )}
            <div className="video-timeline-progress" />
            <div className="video-timeline-thumb" />
          </div>
          <div className="video-timeline-time">
            {formatVideoTime(currentTime, {
              includeSubseconds: isScrubbing,
            })}{" "}
            / {formatVideoTime(duration)}
          </div>
          <div className="video-loop-controls">
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
              disabled={loopRange === null}
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
