import "@testing-library/jest-dom";

if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}

HTMLCanvasElement.prototype.getContext = function getContext(contextId) {
  if (contextId !== "2d") return null;

  return {
    arc: () => {},
    beginPath: () => {},
    clearRect: () => {},
    fill: () => {},
    lineTo: () => {},
    moveTo: () => {},
    setTransform: () => {},
    stroke: () => {},
    set fillStyle(_value: string) {},
    set lineCap(_value: CanvasLineCap) {},
    set lineWidth(_value: number) {},
    set strokeStyle(_value: string) {},
  } as unknown as CanvasRenderingContext2D;
} as HTMLCanvasElement["getContext"];
