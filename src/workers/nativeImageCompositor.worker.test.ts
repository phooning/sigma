import { describe, expect, it } from "vitest";
import type { NativeImageManifestAsset } from "../components/native-image/types";
import {
  compareNativeImageCacheEvictionCandidates,
  getNativeImageResourcePolicy,
  selectDesiredNativeImageAssets,
  shouldQueueNativeImageAssetLoad,
} from "./nativeImageCompositor.worker";

const asset = (
  id: string,
  overrides: Partial<NativeImageManifestAsset> = {},
): NativeImageManifestAsset => ({
  id,
  path: `/images/${id}.png`,
  url: `asset:///images/${id}.png`,
  sourceWidth: 1024,
  sourceHeight: 1024,
  cropLeftRatio: 0,
  cropTopRatio: 0,
  cropWidthRatio: 1,
  cropHeightRatio: 1,
  drawOrder: 0,
  screenX: 0,
  screenY: 0,
  renderedWidthPx: 512,
  renderedHeightPx: 512,
  visibleAreaPx: 512 * 512,
  focusWeight: 1,
  centerWeight: 0.5,
  isSelected: false,
  ...overrides,
});

describe("native image resource policy", () => {
  it("scales active images and cache budget with display pixels and device memory", () => {
    const baseline = getNativeImageResourcePolicy({
      canvasWidth: 1920,
      canvasHeight: 1080,
      devicePixelRatio: 1,
      deviceMemoryGb: 8,
      hardwareConcurrency: 8,
    });
    const highHeadroom = getNativeImageResourcePolicy({
      canvasWidth: 5120,
      canvasHeight: 2160,
      devicePixelRatio: 1,
      deviceMemoryGb: 16,
      hardwareConcurrency: 16,
    });

    expect(baseline.maxActiveImages).toBe(24);
    expect(baseline.maxCacheBytes).toBe(192 * 1024 * 1024);
    expect(highHeadroom.maxActiveImages).toBeGreaterThan(
      baseline.maxActiveImages,
    );
    expect(highHeadroom.maxCacheBytes).toBeGreaterThan(baseline.maxCacheBytes);
    expect(highHeadroom.maxConcurrentLoads).toBeGreaterThanOrEqual(
      baseline.maxConcurrentLoads,
    );
  });

  it("evicts cache entries by lowest priority, then oldest use, then largest size", () => {
    const entries = [
      { id: "largest-tie", priorityScore: 10, lastUsedAt: 4, byteSize: 900 },
      { id: "recent-low", priorityScore: 1, lastUsedAt: 100, byteSize: 100 },
      { id: "oldest-tie", priorityScore: 10, lastUsedAt: 1, byteSize: 100 },
      { id: "high-priority", priorityScore: 50, lastUsedAt: 0, byteSize: 1000 },
      { id: "small-tie", priorityScore: 10, lastUsedAt: 4, byteSize: 200 },
    ];

    entries.sort(compareNativeImageCacheEvictionCandidates);

    expect(entries.map((entry) => entry.id)).toEqual([
      "recent-low",
      "oldest-tie",
      "largest-tie",
      "small-tie",
      "high-priority",
    ]);
  });

  it("keeps selected visible images even when active count and cache budget are tight", () => {
    const selected = asset("selected", {
      isSelected: true,
      visibleAreaPx: 1,
      renderedWidthPx: 4096,
      renderedHeightPx: 4096,
    });
    const prominent = asset("prominent", {
      visibleAreaPx: 2048 * 2048,
      renderedWidthPx: 2048,
      renderedHeightPx: 2048,
    });

    const desired = selectDesiredNativeImageAssets({
      assets: [prominent, selected],
      policy: {
        maxActiveImages: 1,
        maxCacheBytes: 1024,
      },
      devicePixelRatio: 1,
    });

    expect(desired.map((candidate) => candidate.id)).toContain("selected");
  });

  it("queues a new LOD path while retaining the last ready bitmap", () => {
    expect(
      shouldQueueNativeImageAssetLoad(
        asset("image", { path: "/preview.png" }),
        {
          path: "/full.png",
          status: "ready",
        },
      ),
    ).toBe(true);

    expect(
      shouldQueueNativeImageAssetLoad(
        asset("image", { path: "/preview.png" }),
        {
          loadingPath: "/preview.png",
          path: "/full.png",
          status: "ready",
        },
      ),
    ).toBe(false);
  });

  it("does not queue placeholder native image loads", () => {
    expect(
      shouldQueueNativeImageAssetLoad(
        asset("placeholder", {
          isPlaceholder: true,
          path: "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
        }),
      ),
    ).toBe(false);
  });

  it("does not queue fallback native image loads", () => {
    expect(
      shouldQueueNativeImageAssetLoad(
        asset("fallback", {
          isFallback: true,
          path: "asset:///images/fallback-thumbnail.png",
        }),
      ),
    ).toBe(false);
  });
});
