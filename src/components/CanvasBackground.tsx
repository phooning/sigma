import { positiveModulo } from "@/utils/math";
import { Viewport } from "@/utils/media.types";

export const resizeBackgroundCanvas = (
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
) => {
  const pixelRatio = window.devicePixelRatio || 1;
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const pixelWidth = Math.round(safeWidth * pixelRatio);
  const pixelHeight = Math.round(safeHeight * pixelRatio);

  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  if (canvas.style.width !== `${safeWidth}px`)
    canvas.style.width = `${safeWidth}px`;
  if (canvas.style.height !== `${safeHeight}px`)
    canvas.style.height = `${safeHeight}px`;

  return { pixelRatio, width: safeWidth, height: safeHeight };
};

export const drawDotGrid = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: Viewport,
) => {
  const baseGridSize = 50;
  const minGridScreenSize = 28;
  const maxGridScreenSize = 96;
  let dotGridSize = baseGridSize;

  while (dotGridSize * viewport.zoom < minGridScreenSize) dotGridSize *= 2;
  while (
    dotGridSize > baseGridSize &&
    dotGridSize * viewport.zoom > maxGridScreenSize
  ) {
    dotGridSize /= 2;
  }

  const spacing = dotGridSize * viewport.zoom;
  const dotRadius = 1.35;
  const startX = positiveModulo(viewport.x * viewport.zoom, spacing);
  const startY = positiveModulo(viewport.y * viewport.zoom, spacing);

  context.fillStyle = "#334155";
  context.beginPath();
  for (let y = startY; y <= height; y += spacing) {
    for (let x = startX; x <= width; x += spacing) {
      context.moveTo(x + dotRadius, y);
      context.arc(x, y, dotRadius, 0, Math.PI * 2);
    }
  }
  context.fill();
};

const snapCanvasLine = (value: number) => Math.round(value) + 0.5;

export const drawLineGrid = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: Viewport,
) => {
  const gridWorldSize = 500;
  const spacing = gridWorldSize * viewport.zoom;
  if (spacing < 8) return;

  const startX = positiveModulo(viewport.x * viewport.zoom, spacing);
  const startY = positiveModulo(viewport.y * viewport.zoom, spacing);
  const lineAlpha = spacing < 40 ? 0.09 : 0.16;

  context.strokeStyle = `rgba(248, 250, 252, ${lineAlpha})`;
  context.lineWidth = 1;
  context.beginPath();

  for (let x = startX; x <= width; x += spacing) {
    const snappedX = snapCanvasLine(x);
    context.moveTo(snappedX, 0);
    context.lineTo(snappedX, height);
  }
  for (let y = startY; y <= height; y += spacing) {
    const snappedY = snapCanvasLine(y);
    context.moveTo(0, snappedY);
    context.lineTo(width, snappedY);
  }

  context.stroke();
  if (spacing < 72) return;

  const plusSize = Math.min(28, Math.max(12, spacing * 0.16));
  const halfPlusSize = plusSize / 2;

  context.strokeStyle = "rgba(248, 250, 252, 0.62)";
  context.lineWidth = Math.min(3, Math.max(2, spacing * 0.04));
  context.lineCap = "round";
  context.beginPath();

  for (let y = startY; y <= height; y += spacing) {
    const snappedY = snapCanvasLine(y);
    for (let x = startX; x <= width; x += spacing) {
      const snappedX = snapCanvasLine(x);
      context.moveTo(snappedX - halfPlusSize, snappedY);
      context.lineTo(snappedX + halfPlusSize, snappedY);
      context.moveTo(snappedX, snappedY - halfPlusSize);
      context.lineTo(snappedX, snappedY + halfPlusSize);
    }
  }

  context.stroke();
};
