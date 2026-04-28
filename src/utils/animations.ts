import type { Viewport } from "./media.types";

type PanPosition = Pick<Viewport, "x" | "y">;

type AnimateKineticPanParams = {
  start: PanPosition;
  target: PanPosition;
  onUpdate: (position: PanPosition) => void;
  onComplete?: () => void;
  durationMs?: number;
  minDelta?: number;
  prefersReducedMotion?: () => boolean;
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
};

export const KINETIC_PAN_DURATION_MS = 900;
export const MIN_KINETIC_PAN_DELTA = 0.5;

const easeOutExpo = (progress: number) =>
  progress >= 1 ? 1 : 1 - 2 ** (-10 * progress);

const lerp = (start: number, end: number, progress: number) =>
  start + (end - start) * progress;

const getPrefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export const animateKineticPan = ({
  start,
  target,
  onUpdate,
  onComplete,
  durationMs = KINETIC_PAN_DURATION_MS,
  minDelta = MIN_KINETIC_PAN_DELTA,
  prefersReducedMotion = getPrefersReducedMotion,
  now = () => performance.now(),
  requestFrame = (callback) => window.requestAnimationFrame(callback),
  cancelFrame = (handle) => window.cancelAnimationFrame(handle),
}: AnimateKineticPanParams) => {
  const deltaX = target.x - start.x;
  const deltaY = target.y - start.y;
  const distance = Math.hypot(deltaX, deltaY);

  if (distance < minDelta || prefersReducedMotion()) {
    onUpdate(target);
    onComplete?.();
    return () => {};
  }

  let frameId: number | null = null;
  let isCancelled = false;
  const startedAt = now();

  const tick = (timestamp: number) => {
    if (isCancelled) return;

    const progress = Math.min(1, (timestamp - startedAt) / durationMs);
    const easedProgress = easeOutExpo(progress);
    const nextPosition =
      progress >= 1
        ? target
        : {
            x: lerp(start.x, target.x, easedProgress),
            y: lerp(start.y, target.y, easedProgress),
          };

    onUpdate(nextPosition);

    if (progress < 1) {
      frameId = requestFrame(tick);
      return;
    }

    frameId = null;
    onComplete?.();
  };

  frameId = requestFrame(tick);

  return () => {
    isCancelled = true;

    if (frameId !== null) {
      cancelFrame(frameId);
      frameId = null;
    }
  };
};
