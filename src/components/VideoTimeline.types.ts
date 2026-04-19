import type {
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import type { LoopState } from "../utils/videoUtils";

export type StopCanvasGestureHandler = (
  event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>,
) => void;

export type VideoTimelineProps = {
  clearLoop: () => void;
  currentTime: number;
  duration: number;
  isPaused: boolean;
  isScrubbing: boolean;
  isScrubbingRef: MutableRefObject<boolean>;
  loop: LoopState;
  playbackError: string | null;
  seekFromPointer: (clientX: number) => void;
  seekToRatio: (ratio: number) => void;
  setLoopPoint: (point: "a" | "b") => void;
  setTimelineScrubbing: (nextIsScrubbing: boolean) => void;
  startTimelineAnimation: () => void;
  stopCanvasGesture: StopCanvasGestureHandler;
  stopTimelineAnimation: () => void;
  timelineRef: RefObject<HTMLDivElement | null>;
  toggleLoop: () => void;
  togglePlayback: () => void;
};
