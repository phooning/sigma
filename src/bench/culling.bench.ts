import { bench, describe } from "vitest";
import { BENCH_CANVAS_SIZE, BENCH_VIEWPORT, createBenchItems } from "./fixtures";
import {
  getCenterWeight,
  getIntersectingItemIds,
  projectItemToScreen,
} from "../utils/spatial";

const selectionCandidates = createBenchItems(10_000);
const visibleCandidates = createBenchItems(20_000);
const selectionRect = {
  x: 2_400,
  y: 1_200,
  width: 2_800,
  height: 1_600,
};

describe("culling algorithms", () => {
  bench("selection-box intersection scan", () => {
    const itemIds = getIntersectingItemIds(selectionCandidates, selectionRect);
    void itemIds;
  });

  bench("visible screen area projection scan", () => {
    const visibleCount = visibleCandidates
      .map((item) => projectItemToScreen(item, BENCH_VIEWPORT, BENCH_CANVAS_SIZE))
      .filter((rect) => rect.visibleAreaPx > 0).length;
    void visibleCount;
  });

  bench("center weighting for visible candidates", () => {
    let total = 0;

    visibleCandidates.forEach((item) => {
      const screenRect = projectItemToScreen(item, BENCH_VIEWPORT, BENCH_CANVAS_SIZE);

      if (screenRect.visibleAreaPx > 0) {
        total += getCenterWeight(screenRect, BENCH_CANVAS_SIZE);
      }
    });
    void total;
  });
});
