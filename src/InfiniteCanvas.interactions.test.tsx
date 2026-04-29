import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCanvasSessionStore } from "./stores/useCanvasSessionStore";
import {
  getCanvasContainer,
  getCanvasWorld,
  mockCanvasRect,
  renderCanvas
} from "./test/infiniteCanvasHarness";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fire a complete middle-click pan sequence and return the world element. */
function doPan(
  containerEl: HTMLElement,
  {
    from,
    to,
    pointerId = 1
  }: {
    from: { x: number; y: number };
    to: { x: number; y: number };
    pointerId?: number;
  }
) {
  fireEvent.pointerDown(containerEl, {
    button: 1,
    clientX: from.x,
    clientY: from.y,
    pointerId
  });
  fireEvent.pointerMove(containerEl, {
    clientX: to.x,
    clientY: to.y,
    pointerId
  });
  fireEvent.pointerUp(containerEl, { pointerId });
}

// ---------------------------------------------------------------------------
// Pan tests
// ---------------------------------------------------------------------------

describe("InfiniteCanvas - panning (middle-click drag)", () => {
  it("updates the world transform live during drag, then commits viewport on pointer-up", () => {
    vi.useFakeTimers();
    try {
      renderCanvas();
      vi.mocked(localStorage.setItem).mockClear();

      const containerEl = getCanvasContainer();
      const world = getCanvasWorld();

      // Baseline: no transform yet
      expect(world.style.transform).toContain("translate(0px, 0px)");

      fireEvent.pointerDown(containerEl, {
        button: 1,
        clientX: 100,
        clientY: 100,
        pointerId: 1
      });

      // --- first move ---
      fireEvent.pointerMove(containerEl, {
        clientX: 130,
        clientY: 140,
        pointerId: 1
      });
      act(() => {
        vi.advanceTimersByTime(100);
      });

      // DOM should already reflect the live offset mid-drag
      expect(world.style.transform).toContain("translate(30px, 40px)");

      // Session store must NOT be updated and localStorage must NOT be written mid-drag
      expect(useCanvasSessionStore.getState().viewport).toEqual({
        x: 0,
        y: 0,
        zoom: 1
      });
      expect(localStorage.setItem).not.toHaveBeenCalledWith(
        "sigma:canvas-session",
        expect.any(String)
      );

      // --- second move ---
      fireEvent.pointerMove(containerEl, {
        clientX: 160,
        clientY: 180,
        pointerId: 1
      });
      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(world.style.transform).toContain("translate(60px, 80px)");

      // Pointer up → commit
      fireEvent.pointerUp(containerEl, { pointerId: 1 });

      expect(world.style.transform).toContain("translate(60px, 80px)");
      expect(useCanvasSessionStore.getState().viewport).toEqual({
        x: 60,
        y: 80,
        zoom: 1
      });
      expect(localStorage.setItem).toHaveBeenCalledWith(
        "sigma:canvas-session",
        expect.stringContaining('"viewport":{"x":60,"y":80,"zoom":1}')
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("accumulates pan correctly when starting from a non-zero viewport", () => {
    renderCanvas();
    // Seed the store with a pre-existing offset
    act(() => {
      useCanvasSessionStore.setState({ viewport: { x: 50, y: -20, zoom: 1 } });
    });

    const containerEl = getCanvasContainer();
    const world = getCanvasWorld();

    doPan(containerEl, { from: { x: 0, y: 0 }, to: { x: 40, y: 30 } });

    expect(world.style.transform).toContain("translate(90px, 10px)");
    expect(useCanvasSessionStore.getState().viewport).toEqual({
      x: 90,
      y: 10,
      zoom: 1
    });
  });

  it("ends the pan cleanly on pointerCancel and preserves the latest viewport", () => {
    renderCanvas();
    vi.mocked(localStorage.setItem).mockClear();
    const containerEl = getCanvasContainer();
    const world = getCanvasWorld();

    fireEvent.pointerDown(containerEl, {
      button: 1,
      clientX: 100,
      clientY: 100,
      pointerId: 1
    });
    fireEvent.pointerMove(containerEl, {
      clientX: 160,
      clientY: 180,
      pointerId: 1
    });

    // Cancel instead of releasing
    fireEvent.pointerCancel(containerEl, { pointerId: 1 });

    expect(world.style.transform).toContain("translate(60px, 80px)");
    expect(useCanvasSessionStore.getState().viewport).toEqual({
      x: 60,
      y: 80,
      zoom: 1
    });
    expect(localStorage.setItem).toHaveBeenCalledWith(
      "sigma:canvas-session",
      expect.stringContaining('"viewport":{"x":60,"y":80,"zoom":1}')
    );
  });

  it("does not pan on left-click drag (button 0)", () => {
    renderCanvas();
    const containerEl = getCanvasContainer();
    const world = getCanvasWorld();

    fireEvent.pointerDown(containerEl, {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 1
    });
    fireEvent.pointerMove(containerEl, {
      clientX: 200,
      clientY: 200,
      pointerId: 1
    });
    fireEvent.pointerUp(containerEl, { pointerId: 1 });

    expect(world.style.transform).toContain("translate(0px, 0px)");
    expect(useCanvasSessionStore.getState().viewport).toEqual({
      x: 0,
      y: 0,
      zoom: 1
    });
  });

  it("pans on right-click drag (button 2), matching secondary-button canvas navigation", () => {
    renderCanvas();
    const containerEl = getCanvasContainer();
    const world = getCanvasWorld();

    fireEvent.pointerDown(containerEl, {
      button: 2,
      clientX: 100,
      clientY: 100,
      pointerId: 1
    });
    fireEvent.pointerMove(containerEl, {
      clientX: 200,
      clientY: 200,
      pointerId: 1
    });
    fireEvent.pointerUp(containerEl, { pointerId: 1 });

    expect(world.style.transform).toContain("translate(100px, 100px)");
    expect(useCanvasSessionStore.getState().viewport).toEqual({
      x: 100,
      y: 100,
      zoom: 1
    });
  });
});

// ---------------------------------------------------------------------------
// Selection-box tests
// ---------------------------------------------------------------------------

describe("InfiniteCanvas - selection box (left-click drag)", () => {
  it("creates a box, tracks width+height+position during drag, then removes it on pointer-up", () => {
    renderCanvas();
    const containerEl = getCanvasContainer();
    mockCanvasRect(containerEl);

    fireEvent.pointerDown(containerEl, {
      button: 0,
      clientX: 200,
      clientY: 200,
      pointerId: 2
    });

    let selBox = document.querySelector(".selection-box") as HTMLElement;
    expect(selBox).toBeInTheDocument();
    // Zero-size on creation
    expect(selBox.style.width).toBe("0px");
    expect(selBox.style.height).toBe("0px");
    // Positioned at the pointer-down origin
    expect(selBox.style.left).toBe("200px");
    expect(selBox.style.top).toBe("200px");

    fireEvent.pointerMove(containerEl, {
      clientX: 350,
      clientY: 280,
      pointerId: 2
    });

    selBox = document.querySelector(".selection-box") as HTMLElement;
    expect(selBox.style.width).toBe("150px");
    expect(selBox.style.height).toBe("80px");
    // Origin anchor must not shift during a forward drag
    expect(selBox.style.left).toBe("200px");
    expect(selBox.style.top).toBe("200px");

    fireEvent.pointerUp(containerEl, { pointerId: 2 });

    expect(document.querySelector(".selection-box")).not.toBeInTheDocument();
  });

  it("handles a reverse drag (right-to-left / bottom-to-top) with correct size and repositioned origin", () => {
    renderCanvas();
    const containerEl = getCanvasContainer();
    mockCanvasRect(containerEl);

    // Start at (350, 280), drag up-left to (200, 200)
    fireEvent.pointerDown(containerEl, {
      button: 0,
      clientX: 350,
      clientY: 280,
      pointerId: 2
    });
    fireEvent.pointerMove(containerEl, {
      clientX: 200,
      clientY: 200,
      pointerId: 2
    });

    const selBox = document.querySelector(".selection-box") as HTMLElement;
    // Size is always positive regardless of drag direction
    expect(selBox.style.width).toBe("150px");
    expect(selBox.style.height).toBe("80px");
    // The box origin should shift to the cursor (top-left of the bounding rect)
    expect(selBox.style.left).toBe("200px");
    expect(selBox.style.top).toBe("200px");

    fireEvent.pointerUp(containerEl, { pointerId: 2 });
  });

  it("removes the selection box on pointerCancel", () => {
    renderCanvas();
    const containerEl = getCanvasContainer();
    mockCanvasRect(containerEl);

    fireEvent.pointerDown(containerEl, {
      button: 0,
      clientX: 200,
      clientY: 200,
      pointerId: 2
    });
    fireEvent.pointerMove(containerEl, {
      clientX: 350,
      clientY: 280,
      pointerId: 2
    });
    expect(document.querySelector(".selection-box")).toBeInTheDocument();

    fireEvent.pointerCancel(containerEl, { pointerId: 2 });

    expect(document.querySelector(".selection-box")).not.toBeInTheDocument();
  });

  it("does not create a selection box on middle-click drag (interaction exclusivity)", () => {
    renderCanvas();
    const containerEl = getCanvasContainer();
    mockCanvasRect(containerEl);

    fireEvent.pointerDown(containerEl, {
      button: 1,
      clientX: 200,
      clientY: 200,
      pointerId: 1
    });
    fireEvent.pointerMove(containerEl, {
      clientX: 350,
      clientY: 280,
      pointerId: 1
    });

    expect(document.querySelector(".selection-box")).not.toBeInTheDocument();

    fireEvent.pointerUp(containerEl, { pointerId: 1 });
  });
});
