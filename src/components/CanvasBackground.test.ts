import { afterEach, describe, expect, it } from "vitest";
import { getCanvasBackgroundStyle } from "./CanvasBackground";

describe("getCanvasBackgroundStyle", () => {
  afterEach(() => {
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });
  });

  it("keeps dot spacing locked to world-space zoom", () => {
    const canvasSize = { width: 3840, height: 2160 };

    for (const zoom of [0.2, 1, 5]) {
      const style = getCanvasBackgroundStyle({
        canvasSize,
        pattern: "dots",
        viewport: { x: 1234, y: -567, zoom },
      });
      const screenSpacing = Number.parseFloat(
        String(style.backgroundSize).split("px")[0],
      );

      expect(style.transform).toContain("translate3d");
      expect(style.transform).not.toContain("scale");
      expect(screenSpacing).toBeCloseTo(50 * zoom);
      expect(Number.parseFloat(String(style.width))).toBeCloseTo(
        canvasSize.width + screenSpacing * 2,
      );
      expect(Number.parseFloat(String(style.height))).toBeCloseTo(
        canvasSize.height + screenSpacing * 2,
      );
    }
  });

  it("uses the far grid when zoomed out beyond useful dot density", () => {
    const style = getCanvasBackgroundStyle({
      canvasSize: { width: 3840, height: 2160 },
      pattern: "dots",
      viewport: { x: 1234, y: -567, zoom: 0.05 },
    });

    expect(style.backgroundImage).toContain("linear-gradient");
    expect(style.backgroundSize).toBe("100px 100px");
  });

  it("changes dot spacing continuously during trackpad-scale zoom steps", () => {
    const canvasSize = { width: 3840, height: 2160 };
    const zoomSteps = Array.from(
      { length: 120 },
      (_, index) => 0.2 + index * 0.02,
    );
    let previousSpacing: number | null = null;

    for (const zoom of zoomSteps) {
      const style = getCanvasBackgroundStyle({
        canvasSize,
        pattern: "dots",
        viewport: { x: 1234, y: -567, zoom },
      });
      const screenSpacing = Number.parseFloat(
        String(style.backgroundSize).split("px")[0],
      );

      if (previousSpacing !== null) {
        expect(Math.abs(screenSpacing - previousSpacing)).toBeLessThanOrEqual(
          1.000001,
        );
      }

      previousSpacing = screenSpacing;
    }
  });

  it("leaves structural spacing unsnapped and snaps only the final transform", () => {
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });

    const style = getCanvasBackgroundStyle({
      canvasSize: { width: 3840, height: 2160 },
      pattern: "dots",
      viewport: { x: 1, y: 1, zoom: 0.333 },
    });
    const screenSpacing = Number.parseFloat(
      String(style.backgroundSize).split("px")[0],
    );

    expect(screenSpacing).toBeCloseTo(50 * 0.333);
    expect(screenSpacing).not.toBeCloseTo(16.5);
    expect(style.transform).toBe("translate3d(-24.5px, -24.5px, 0)");
  });
});
