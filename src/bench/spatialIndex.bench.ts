import { bench, describe } from "vitest";
import {
  createSpatialGridIndex,
  getIntersectingItemIds,
  querySpatialGridIndex,
} from "../utils/spatial";
import { createBenchItems } from "./fixtures";

const items = createBenchItems(20_000);
const queryRect = {
  x: 4_000,
  y: 2_400,
  width: 3_200,
  height: 1_800,
};
const spatialIndex = createSpatialGridIndex(items, 512);

describe("spatial indexing", () => {
  bench("brute-force rect query", () => {
    const itemIds = getIntersectingItemIds(items, queryRect);
    void itemIds;
  });

  bench("grid index build", () => {
    const index = createSpatialGridIndex(items, 512);
    void index;
  });

  bench("grid index rect query", () => {
    const matches = querySpatialGridIndex(spatialIndex, queryRect);
    void matches;
  });
});
