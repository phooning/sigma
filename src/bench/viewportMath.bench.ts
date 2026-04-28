import { bench, describe } from "vitest";
import {
  applyPanDelta,
  applyZoomAtPoint,
  getNextZoom,
} from "../utils/viewportMath";
import { BENCH_VIEWPORT } from "./fixtures";

describe("viewport math", () => {
  bench("applyPanDelta for repeated trackpad pans", () => {
    let viewport = BENCH_VIEWPORT;

    for (let index = 0; index < 2_000; index += 1) {
      viewport = applyPanDelta(viewport, 12, -8);
    }
    void viewport;
  });

  bench("applyZoomAtPoint for pointer-centered zooming", () => {
    let viewport = BENCH_VIEWPORT;

    for (let index = 0; index < 1_500; index += 1) {
      viewport = applyZoomAtPoint({
        viewport,
        deltaY: index % 2 === 0 ? -18 : 12,
        mouseX: 960,
        mouseY: 540,
      });
    }
    void viewport;
  });

  bench("getNextZoom clamp path", () => {
    let zoom = BENCH_VIEWPORT.zoom;

    for (let index = 0; index < 10_000; index += 1) {
      zoom = getNextZoom(zoom, index % 3 === 0 ? -24 : 10);
    }
    void zoom;
  });
});
