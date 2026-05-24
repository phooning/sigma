import { expect, test } from "@playwright/test";
import { gotoApp, loadCanvasConfig, waitForAnimationFrames } from "./helpers";

type LodFixture = {
  name: string;
  path: string;
  width: number;
  height: number;
};

const fixtures: LodFixture[] = [
  {
    name: "4K",
    path: "/tmp/e2e/generated-lod-test-4k.png",
    width: 3840,
    height: 2160,
  },
  {
    name: "8K",
    path: "/tmp/e2e/generated-lod-test-8k.png",
    width: 7680,
    height: 4320,
  },
];

const frames = [
  { name: "720p", width: 1280, height: 720 },
  { name: "1080p", width: 1920, height: 1080 },
];

for (const frame of frames) {
  for (const fixture of fixtures) {
    test(`keeps a ${fixture.name} image visible when fit to a ${frame.name} frame`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: frame.width, height: frame.height });
      await gotoApp(page);

      await loadCanvasConfig(page, {
        items: [
          {
            id: `${fixture.name.toLowerCase()}-fit-image`,
            type: "image",
            filePath: fixture.path,
            sourceWidth: fixture.width,
            sourceHeight: fixture.height,
            x: 0,
            y: 0,
            width: fixture.width,
            height: fixture.height,
          },
        ],
        viewport: {
          x: 0,
          y: 0,
          zoom: frame.width / fixture.width,
        },
      });

      const mediaItem = page.getByTestId("media-item");
      await expect(mediaItem).toHaveCount(1);
      await expect(mediaItem).toHaveClass(/native-image-item/);
      await expect(mediaItem).toBeVisible();

      const bounds = await mediaItem.boundingBox();
      expect(bounds?.width).toBeCloseTo(frame.width, 0);
      expect(bounds?.height).toBeCloseTo(frame.height, 0);

      await waitForAnimationFrames(page, 2);
      await expect(page.getByTestId("media-visibility-mask")).toHaveAttribute(
        "data-visible",
        "true",
      );
    });
  }
}
