import type { CSSProperties } from "react";
import type { CanvasBackgroundPattern } from "@/stores/useSettingsStore";
import { positiveModulo } from "@/utils/math";
import type { Viewport } from "@/utils/media.types";
import { markPerformance } from "@/utils/performance";

const DOT_GRID_BASE_SIZE = 50;
const DOT_GRID_MIN_VISIBLE_SCREEN_SIZE = 8;
const DOT_GRID_FULL_OPACITY_SCREEN_SIZE = 18;
const DOT_GRID_WORLD_RADIUS = 2;

const LINE_GRID_WORLD_SIZE = 500;
const LINE_GRID_MIN_SCREEN_SIZE = 96;
const LINE_GRID_MAX_SCREEN_SIZE = 320;

// Activates when dot spacing falls below this screen-pixel threshold.
const FAR_GRID_DOT_FADE_SCREEN_SIZE = DOT_GRID_MIN_VISIBLE_SCREEN_SIZE; // 8px
const FAR_GRID_WORLD_SIZE = 500; // world units between far-grid lines
const FAR_GRID_MAX_OPACITY = 0.1; // kept very low – thin, minimalist

const SAFE_MIN_ZOOM = 0.001;

// Keep structural grid math exact and only snap the final layer translation to
// physical display pixels. Snapping tile sizes causes phase jumps during
// trackpad micro-zoom events on HiDPI / ProMotion displays.
const getDpr = () => {
  if (typeof window === "undefined") return 1;

  const dpr = window.devicePixelRatio || 1;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
};

const snapToDevicePx = (v: number) => {
  const dpr = getDpr();
  return Math.round(v * dpr) / dpr;
};

type CanvasSize = { width: number; height: number };
type CanvasBackgroundStyleOptions = {
  canvasSize: CanvasSize;
  pattern: CanvasBackgroundPattern;
  viewport: Viewport;
};

type FarGridGeometry = {
  alpha: number;
  screenSize: number;
};

const svgBg = (svg: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

// Corner-plus markers for the normal line grid
const LINE_GRID_PLUS_IMAGE = svgBg(`
<svg xmlns="http://www.w3.org/2000/svg"
     width="${LINE_GRID_WORLD_SIZE}" height="${LINE_GRID_WORLD_SIZE}"
     viewBox="0 0 ${LINE_GRID_WORLD_SIZE} ${LINE_GRID_WORLD_SIZE}">
  <path d="M0 0V14M0 0H14M500 0V14M486 0H500M0 486V500M0 500H14M500 486V500M486 500H500"
        stroke="#f8fafc" stroke-opacity="0.58" stroke-width="8"
        stroke-linecap="round"/>
</svg>`);

// Thin line grid used at far zoom; alpha is baked in via CSS, not the SVG.
// We use a single-pixel SVG cross so it tiles cleanly at any screen size.
const makeFarGridImage = (alpha: number) => {
  const color = `rgba(248,250,252,${alpha.toFixed(3)})`;
  return [
    `linear-gradient(to right, ${color} 1px, transparent 1px)`,
    `linear-gradient(to bottom, ${color} 1px, transparent 1px)`,
  ].join(", ");
};

const getLineGridWorldSize = (zoom: number) => {
  let size = LINE_GRID_WORLD_SIZE;
  while (size * zoom < LINE_GRID_MIN_SCREEN_SIZE) size *= 2;
  while (size * zoom > LINE_GRID_MAX_SCREEN_SIZE) size /= 2;
  return size;
};

const getPatternWorldSize = (pattern: CanvasBackgroundPattern, zoom: number) =>
  pattern === "dots" ? DOT_GRID_BASE_SIZE : getLineGridWorldSize(zoom);

const getDotOpacity = (screenSpacing: number) => {
  if (screenSpacing <= DOT_GRID_MIN_VISIBLE_SCREEN_SIZE) return 0;
  if (screenSpacing >= DOT_GRID_FULL_OPACITY_SCREEN_SIZE) return 1;
  return (
    (screenSpacing - DOT_GRID_MIN_VISIBLE_SCREEN_SIZE) /
    (DOT_GRID_FULL_OPACITY_SCREEN_SIZE - DOT_GRID_MIN_VISIBLE_SCREEN_SIZE)
  );
};

const getDotBackgroundImage = (zoom: number, screenSpacing: number) => {
  const opacity = getDotOpacity(screenSpacing);
  if (opacity === 0) return null; // signal to caller: dots invisible

  const solidStop = Math.max(0.75, DOT_GRID_WORLD_RADIUS * zoom);
  const transparentStop = solidStop + 0.45;
  return `radial-gradient(circle at center, rgba(148,163,184,${(0.78 * opacity).toFixed(3)}) 0 ${solidStop}px, transparent ${transparentStop}px)`;
};

/**
 * When dots are invisible (screen spacing < FAR_GRID_DOT_FADE_SCREEN_SIZE),
 * we cross-fade in a minimalist thin line grid so the canvas never feels
 * completely empty.  The far grid uses its own world size / screen spacing so
 * it can be tuned independently of the dot grid.
 *
 * Returns { image, size } or null when the far grid is fully transparent.
 */
const getFarGridGeometry = (
  zoom: number,
  dotScreenSpacing: number,
): FarGridGeometry | null => {
  // Opacity: 0 → FAR_GRID_MAX_OPACITY as dot spacing shrinks from
  // FAR_GRID_DOT_FADE_SCREEN_SIZE → 0.  We invert the dot-opacity lerp.
  const t = 1 - dotScreenSpacing / FAR_GRID_DOT_FADE_SCREEN_SIZE; // 0..1
  if (t <= 0) return null;

  const alpha = FAR_GRID_MAX_OPACITY * Math.min(t, 1);

  // Pick a world size that keeps lines 80-240px apart on screen
  let worldSize = FAR_GRID_WORLD_SIZE;
  while (worldSize * zoom < 80) worldSize *= 2;
  while (worldSize * zoom > 240) worldSize /= 2;

  return {
    alpha,
    screenSize: worldSize * zoom,
  };
};

const getFarGridLayer = (
  zoom: number,
  dotScreenSpacing: number,
): { image: string; screenSize: number } | null => {
  const geometry = getFarGridGeometry(zoom, dotScreenSpacing);
  if (!geometry) return null;

  return {
    image: makeFarGridImage(geometry.alpha),
    screenSize: geometry.screenSize,
  };
};

const getLineGridImage = (screenSpacing: number) => {
  const lineAlpha = screenSpacing < 144 ? 0.1 : 0.16;
  const c = `rgba(248,250,252,${lineAlpha})`;
  return [
    LINE_GRID_PLUS_IMAGE,
    `linear-gradient(to right, ${c} 1px, transparent 1px)`,
    `linear-gradient(to bottom, ${c} 1px, transparent 1px)`,
  ].join(", ");
};

const getPatternOffset = (
  pattern: CanvasBackgroundPattern,
  screenOffset: number,
  screenSpacing: number,
) => {
  const centeredDotOffset = pattern === "dots" ? screenSpacing / 2 : 0;
  return screenOffset - screenSpacing - centeredDotOffset;
};

const snapCanvasLineToDevicePx = (v: number) => {
  const dpr = getDpr();
  return (Math.round(v * dpr) + 0.5) / dpr;
};

const canDrawCanvas = (
  context: CanvasRenderingContext2D | null,
): context is CanvasRenderingContext2D => {
  if (!context) return false;

  const candidate = context as Partial<CanvasRenderingContext2D>;
  return (
    typeof candidate.setTransform === "function" &&
    typeof candidate.clearRect === "function" &&
    typeof candidate.save === "function" &&
    typeof candidate.restore === "function" &&
    typeof candidate.beginPath === "function" &&
    typeof candidate.moveTo === "function" &&
    typeof candidate.lineTo === "function" &&
    typeof candidate.stroke === "function" &&
    typeof candidate.fillRect === "function"
  );
};

export const resizeBackgroundCanvas = (
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
) => {
  const pixelRatio = getDpr();
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const pixelWidth = Math.ceil(safeWidth * pixelRatio);
  const pixelHeight = Math.ceil(safeHeight * pixelRatio);
  const styleWidth = `${safeWidth}px`;
  const styleHeight = `${safeHeight}px`;

  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  if (canvas.style.width !== styleWidth) canvas.style.width = styleWidth;
  if (canvas.style.height !== styleHeight) canvas.style.height = styleHeight;

  return { pixelRatio, width: safeWidth, height: safeHeight };
};

const drawGridLines = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: Viewport,
  screenSpacing: number,
  alpha: number,
) => {
  if (screenSpacing <= 0) return;

  const zoom = Math.max(viewport.zoom, SAFE_MIN_ZOOM);
  const startX = positiveModulo(viewport.x * zoom, screenSpacing);
  const startY = positiveModulo(viewport.y * zoom, screenSpacing);

  context.save();
  context.strokeStyle = `rgba(248, 250, 252, ${alpha})`;
  context.lineWidth = 1 / getDpr();
  context.beginPath();

  for (let x = startX; x <= width; x += screenSpacing) {
    const snappedX = snapCanvasLineToDevicePx(x);
    context.moveTo(snappedX, 0);
    context.lineTo(snappedX, height);
  }

  for (let y = startY; y <= height; y += screenSpacing) {
    const snappedY = snapCanvasLineToDevicePx(y);
    context.moveTo(0, snappedY);
    context.lineTo(width, snappedY);
  }

  context.stroke();
  context.restore();
};

const drawLineGridPluses = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: Viewport,
  screenSpacing: number,
) => {
  if (screenSpacing < 72) return;

  const zoom = Math.max(viewport.zoom, SAFE_MIN_ZOOM);
  const startX = positiveModulo(viewport.x * zoom, screenSpacing);
  const startY = positiveModulo(viewport.y * zoom, screenSpacing);
  const plusSize = Math.min(28, Math.max(12, screenSpacing * 0.16));
  const halfPlusSize = plusSize / 2;

  context.save();
  context.strokeStyle = "rgba(248, 250, 252, 0.58)";
  context.lineWidth = Math.min(3, Math.max(2, screenSpacing * 0.012));
  context.lineCap = "round";
  context.beginPath();

  for (let y = startY; y <= height; y += screenSpacing) {
    const snappedY = snapToDevicePx(y);

    for (let x = startX; x <= width; x += screenSpacing) {
      const snappedX = snapToDevicePx(x);
      context.moveTo(snappedX - halfPlusSize, snappedY);
      context.lineTo(snappedX + halfPlusSize, snappedY);
      context.moveTo(snappedX, snappedY - halfPlusSize);
      context.lineTo(snappedX, snappedY + halfPlusSize);
    }
  }

  context.stroke();
  context.restore();
};

export const drawDotGrid = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: Viewport,
) => {
  const zoom = Math.max(viewport.zoom, SAFE_MIN_ZOOM);
  const screenSpacing = DOT_GRID_BASE_SIZE * zoom;
  const opacity = getDotOpacity(screenSpacing);

  if (opacity <= 0) return;

  const startX = positiveModulo(viewport.x * zoom, screenSpacing);
  const startY = positiveModulo(viewport.y * zoom, screenSpacing);
  const dotSize = 2;
  const halfDotSize = dotSize / 2;

  context.save();
  context.fillStyle = `rgba(148, 163, 184, ${(0.78 * opacity).toFixed(3)})`;

  for (let y = startY; y <= height; y += screenSpacing) {
    const snappedY = snapToDevicePx(y - halfDotSize);

    for (let x = startX; x <= width; x += screenSpacing) {
      context.fillRect(
        snapToDevicePx(x - halfDotSize),
        snappedY,
        dotSize,
        dotSize,
      );
    }
  }

  context.restore();
};

export const drawLineGrid = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: Viewport,
) => {
  const zoom = Math.max(viewport.zoom, SAFE_MIN_ZOOM);
  const screenSpacing = getLineGridWorldSize(zoom) * zoom;
  const lineAlpha = screenSpacing < 144 ? 0.1 : 0.16;

  drawGridLines(context, width, height, viewport, screenSpacing, lineAlpha);
  drawLineGridPluses(context, width, height, viewport, screenSpacing);
};

export const drawCanvasBackground = (
  canvas: HTMLCanvasElement,
  { canvasSize, pattern, viewport }: CanvasBackgroundStyleOptions,
) => {
  markPerformance("sigma:drawCanvasBackground:start");

  try {
    const { pixelRatio, width, height } = resizeBackgroundCanvas(
      canvas,
      canvasSize.width,
      canvasSize.height,
    );
    let context: CanvasRenderingContext2D | null = null;

    try {
      context = canvas.getContext("2d", { alpha: true });
    } catch {
      return;
    }

    if (!canDrawCanvas(context)) return;

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    if (pattern === "dots") {
      const zoom = Math.max(viewport.zoom, SAFE_MIN_ZOOM);
      const dotScreenSpacing = DOT_GRID_BASE_SIZE * zoom;
      const farGrid = getFarGridGeometry(zoom, dotScreenSpacing);

      if (farGrid) {
        drawGridLines(
          context,
          width,
          height,
          viewport,
          farGrid.screenSize,
          farGrid.alpha,
        );
      }

      drawDotGrid(context, width, height, viewport);
      return;
    }

    drawLineGrid(context, width, height, viewport);
  } finally {
    markPerformance("sigma:drawCanvasBackground:end");
  }
};

export const getCanvasBackgroundStyle = ({
  canvasSize,
  pattern,
  viewport,
}: CanvasBackgroundStyleOptions): CSSProperties => {
  const zoom = Math.max(viewport.zoom, SAFE_MIN_ZOOM);
  const patternWorldSize = getPatternWorldSize(pattern, zoom);

  // Keep spacing exact so the tiled grid scales continuously without stepping.
  const screenSpacing = patternWorldSize * zoom;

  const exactOffsetX = positiveModulo(viewport.x * zoom, screenSpacing);
  const exactOffsetY = positiveModulo(viewport.y * zoom, screenSpacing);

  const offsetX = getPatternOffset(pattern, exactOffsetX, screenSpacing);
  const offsetY = getPatternOffset(pattern, exactOffsetY, screenSpacing);

  // Extend the element slightly beyond the viewport so exact fractional spacing
  // never exposes a gap at the viewport edge.
  const width = Math.ceil(canvasSize.width + screenSpacing * 2);
  const height = Math.ceil(canvasSize.height + screenSpacing * 2);

  let backgroundImage: string;
  let backgroundSize: string;

  if (pattern === "dots") {
    const dotImage = getDotBackgroundImage(zoom, screenSpacing);

    if (dotImage === null) {
      // Fully zoomed out: dots invisible – try far grid
      const far = getFarGridLayer(zoom, screenSpacing);
      if (far) {
        backgroundImage = far.image;
        // Far grid has its own spacing; we embed it in a single size string.
        // Since both layers share the same backgroundSize, pick the far size.
        backgroundSize = `${far.screenSize}px ${far.screenSize}px`;
      } else {
        backgroundImage = "none";
        backgroundSize = `${screenSpacing}px ${screenSpacing}px`;
      }
    } else {
      // Normal zoom: dots visible.  Optionally blend a very faint far grid
      // behind them for spatial reference when dots are still sparse.
      const far = getFarGridLayer(zoom, screenSpacing);
      if (far) {
        // We can't mix two different backgroundSizes cleanly with shorthand,
        // so render them as separate layers with the same primary size.
        // The far grid image is appended last (painted first / behind).
        backgroundImage = [dotImage, far.image].join(", ");
        // All four layers share the dot spacing; far grid looks denser but
        // that's fine – it just adds a subtle cross-hatch rhythm.
        backgroundSize = `${screenSpacing}px ${screenSpacing}px`;
      } else {
        backgroundImage = dotImage;
        backgroundSize = `${screenSpacing}px ${screenSpacing}px`;
      }
    }
  } else {
    // "lines" pattern – unchanged behaviour
    backgroundImage = getLineGridImage(screenSpacing);
    backgroundSize = `${screenSpacing}px ${screenSpacing}px`;
  }

  return {
    // GPU compositor layer hint – keeps transforms off the main paint thread
    willChange: "transform",
    // Prevent sub-pixel blending artefacts on Retina/HiDPI
    backfaceVisibility: "hidden",
    backgroundImage,
    backgroundSize,
    height: `${height}px`,
    transform: `translate3d(${snapToDevicePx(offsetX)}px, ${snapToDevicePx(offsetY)}px, 0)`,
    width: `${width}px`,
  };
};
