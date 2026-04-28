import { expect, test } from "@playwright/test";
import { canvasWorld, gotoApp } from "./helpers";

test("pans the canvas with a middle-mouse drag", async ({ page }) => {
  await gotoApp(page);

  const container = page.locator(".canvas-container");
  const box = await container.boundingBox();
  if (!box) {
    throw new Error("Canvas container is not visible.");
  }

  await expect(canvasWorld(page)).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, 0, 0)",
  );

  await page.mouse.move(box.x + 160, box.y + 160);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + 260, box.y + 240, { steps: 5 });
  await page.mouse.up({ button: "middle" });

  await expect
    .poll(async () => {
      return canvasWorld(page).evaluate(
        (element) => getComputedStyle(element).transform,
      );
    })
    .toBe("matrix(1, 0, 0, 1, 100, 80)");
});
