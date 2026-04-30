import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvasSessionStore } from "./stores/useCanvasSessionStore";
import {
  dropFiles,
  getCanvasContainer,
  getDropListenerRegistrationCount,
  getMediaItem,
  getMediaVideo,
  getMediaVideos,
  invoke,
  mockCanvasRect,
  open,
  renderCanvas,
  revealItemInDirMock,
  setViewportSize,
} from "./test/infiniteCanvasHarness";

describe("InfiniteCanvas media loading", () => {
  it("drops multiple videos as playable video elements without eager thumbnail work", async () => {
    const videoPath = new URL(
      "../fixtures/generated-lod-test-1080p.mp4",
      import.meta.url,
    ).pathname;

    setViewportSize({ width: 3000 });
    renderCanvas();
    await dropFiles([videoPath, videoPath]);

    await waitFor(() => {
      expect(document.querySelectorAll(".media-item")).toHaveLength(2);
      expect(getMediaVideos()).toHaveLength(2);
    });

    getMediaVideos().forEach((video) => {
      expect(video).toHaveAttribute("src", `asset://${videoPath}`);
    });
    expect(
      document.querySelector(".video-lod-thumbnail"),
    ).not.toBeInTheDocument();
    expect(document.querySelector(".video-lod-proxy")).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith(
      "request_decode",
      expect.objectContaining({
        path: expect.stringMatching(/\.(mp4|webm|mov|mkv)$/i),
      }),
    );
  });

  it("drops large videos as deferred load proxies until playback is requested", async () => {
    const heavyVideoPath = new URL(
      "../fixtures/heavy_video.mkv",
      import.meta.url,
    ).pathname;

    setViewportSize({ width: 3000 });
    renderCanvas();
    await dropFiles([heavyVideoPath]);

    await waitFor(() => {
      expect(document.querySelectorAll(".media-item")).toHaveLength(1);
      expect(
        screen.getByRole("button", { name: /load video/i }),
      ).toBeInTheDocument();
    });

    expect(
      document.querySelector("video.media-content"),
    ).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("probe_media", {
      path: heavyVideoPath,
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "request_decode",
        expect.objectContaining({
          itemId: expect.any(String),
          path: heavyVideoPath,
          lod: 256,
          priority: "visible",
        }),
      );
      expect(document.querySelector(".video-load-thumbnail")).toHaveAttribute(
        "src",
        "asset:///tmp/heavy-thumb.jpg",
      );
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /load video/i }));
    });

    await waitFor(() => {
      expect(getMediaVideos()).toHaveLength(1);
    });
    expect(getMediaVideo()).toHaveAttribute("src", `asset://${heavyVideoPath}`);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("drops images through native probe batches instead of browser Image probes", async () => {
    renderCanvas();
    await dropFiles(["/path/to/test.png", "/path/to/portrait.webp"]);

    await waitFor(() => {
      expect(document.querySelector(".item-count")?.textContent).toContain(
        "2 items",
      );
      expect(screen.getByAltText("canvas item")).toBeInTheDocument();
    });

    expect(invoke).toHaveBeenCalledWith("probe_images", {
      paths: ["/path/to/test.png", "/path/to/portrait.webp"],
    });
    expect(invoke).not.toHaveBeenCalledWith("probe_media", {
      path: "/path/to/test.png",
    });
    expect(invoke).not.toHaveBeenCalledWith("probe_media", {
      path: "/path/to/portrait.webp",
    });
  });

  it("keeps a single native drop listener across rerenders", async () => {
    renderCanvas();

    await act(async () => {
      setViewportSize({ width: 1400, height: 900 });
      window.dispatchEvent(new Event("resize"));
      setViewportSize({ width: 1600, height: 1000 });
      window.dispatchEvent(new Event("resize"));
    });

    expect(getDropListenerRegistrationCount()).toBe(1);
  });

  it("splits large image drops into bounded native probe batches", async () => {
    const imagePaths = Array.from(
      { length: 9 },
      (_, index) => `/path/to/gallery-${index}.png`,
    );

    renderCanvas();
    await dropFiles(imagePaths);

    await waitFor(() => {
      expect(document.querySelector(".item-count")?.textContent).toContain(
        "9 items",
      );
    });

    const probeImageCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "probe_images");

    expect(probeImageCalls).toHaveLength(2);
    expect(probeImageCalls[0][1]).toEqual({
      paths: imagePaths.slice(0, 8),
    });
    expect(probeImageCalls[1][1]).toEqual({
      paths: imagePaths.slice(8),
    });
  });

  it("renders images from the full asset at default canvas scale", async () => {
    renderCanvas();
    await dropFiles(["/path/to/test.png"]);

    expect(invoke).not.toHaveBeenCalledWith(
      "request_decode",
      expect.objectContaining({
        path: "/path/to/test.png",
        lod: 1024,
      }),
    );

    await waitFor(() => {
      expect(screen.getByAltText("canvas item")).toHaveAttribute(
        "src",
        "asset:///path/to/test.png",
      );
    });
  });

  it("requests a 256 preview when an image shrinks into the small-preview LOD", async () => {
    renderCanvas();
    await dropFiles(["/path/to/test.png"]);
    await screen.findByAltText("canvas item");

    const container = getCanvasContainer();
    mockCanvasRect(container);

    await act(async () => {
      fireEvent.wheel(container, {
        ctrlKey: true,
        deltaY: 900,
        clientX: 10,
        clientY: 10,
      });
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "request_decode",
        expect.objectContaining({
          itemId: expect.any(String),
          path: "/path/to/test.png",
          lod: 256,
          priority: "visible",
        }),
      );
    });
  });
});

describe("InfiniteCanvas media item interactions", () => {
  beforeEach(async () => {
    renderCanvas();
    await dropFiles(["/path/to/test.png"]);
    await screen.findByAltText("canvas item");
  });

  it("moves an item transiently during drag and commits it once on pointer up", async () => {
    const mediaItem = getMediaItem();
    const startItem = useCanvasSessionStore.getState().items[0];

    await act(async () => {
      fireEvent.pointerDown(mediaItem, {
        button: 0,
        clientX: 0,
        clientY: 0,
        pointerId: 16,
      });
    });
    vi.mocked(localStorage.setItem).mockClear();

    await act(async () => {
      fireEvent.pointerMove(mediaItem, {
        clientX: 100,
        clientY: 200,
        pointerId: 16,
        button: 0,
      });
    });

    expect(useCanvasSessionStore.getState().items[0]).toBe(startItem);
    expect(mediaItem.style.left).toBe(`${startItem.x}px`);
    expect(mediaItem.style.top).toBe(`${startItem.y}px`);
    expect(mediaItem.style.getPropertyValue("--media-transient-x")).toBe(
      "100px",
    );
    expect(mediaItem.style.getPropertyValue("--media-transient-y")).toBe(
      "200px",
    );
    expect(localStorage.setItem).not.toHaveBeenCalledWith(
      "sigma:canvas-session",
      expect.any(String),
    );

    await act(async () => {
      fireEvent.pointerUp(mediaItem, { pointerId: 16, button: 0 });
    });

    const endItem = useCanvasSessionStore.getState().items[0];
    expect(endItem.x).toBe(startItem.x + 100);
    expect(endItem.y).toBe(startItem.y + 200);
    expect(mediaItem.style.left).toBe(`${startItem.x + 100}px`);
    expect(mediaItem.style.top).toBe(`${startItem.y + 200}px`);
    expect(mediaItem.style.getPropertyValue("--media-transient-x")).toBe("");
    expect(localStorage.setItem).toHaveBeenCalledWith(
      "sigma:canvas-session",
      expect.stringContaining(`"x":${startItem.x + 100}`),
    );
  });

  it("preserves unchanged item identities while normalizing media urls", () => {
    const firstItem = useCanvasSessionStore.getState().items[0];
    const secondItem = {
      ...firstItem,
      id: "second-image",
      filePath: "/path/to/second.png",
      url: "asset:///path/to/second.png",
      x: firstItem.x + 40,
    };

    useCanvasSessionStore.getState().setItems([firstItem, secondItem]);
    const unchangedItem = useCanvasSessionStore.getState().items[1];

    useCanvasSessionStore
      .getState()
      .setItems((prev) =>
        prev.map((item) =>
          item.id === firstItem.id ? { ...item, x: item.x + 10 } : item,
        ),
      );

    expect(useCanvasSessionStore.getState().items[1]).toBe(unchangedItem);
  });

  it("resizes the image back to correct aspect ratio on rescale button click", async () => {
    const mediaItem = getMediaItem();
    expect(mediaItem).toBeInTheDocument();

    expect(mediaItem.style.width).toBe("1280px");
    expect(mediaItem.style.height).toBe("960px");

    const handle = document.querySelector(".resize-handle") as HTMLElement;
    mockCanvasRect(getCanvasContainer());

    await act(async () => {
      fireEvent.pointerDown(handle, {
        clientX: 0,
        clientY: 0,
        pointerId: 3,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerMove(mediaItem, {
        clientX: 100,
        clientY: 200,
        pointerId: 3,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerUp(mediaItem, { pointerId: 3, button: 0 });
    });

    expect(mediaItem.style.width).toBe("1380px");
    expect(mediaItem.style.height).toBe("1160px");

    const resetBtn = document.querySelector(".reset-btn") as HTMLElement;

    await act(async () => {
      fireEvent.pointerDown(resetBtn, { pointerId: 4, button: 0 });
      fireEvent.click(resetBtn);
    });

    expect(mediaItem.style.width).toBe("1280px");
    expect(mediaItem.style.height).toBe("960px");
  });

  it("locks the current resized aspect ratio when resizing with shift held", async () => {
    const mediaItem = getMediaItem();
    const handle = document.querySelector(".resize-handle") as HTMLElement;

    await act(async () => {
      fireEvent.pointerDown(handle, {
        clientX: 0,
        clientY: 0,
        pointerId: 6,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerMove(mediaItem, {
        clientX: 100,
        clientY: 200,
        pointerId: 6,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerUp(mediaItem, { pointerId: 6, button: 0 });
    });

    expect(mediaItem.style.width).toBe("1380px");
    expect(mediaItem.style.height).toBe("1160px");

    const resizedRatio = 1380 / 1160;

    await act(async () => {
      fireEvent.pointerDown(handle, {
        clientX: 0,
        clientY: 0,
        pointerId: 7,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerMove(mediaItem, {
        clientX: 100,
        clientY: 0,
        pointerId: 7,
        button: 0,
        shiftKey: true,
      });
    });
    await act(async () => {
      fireEvent.pointerUp(mediaItem, { pointerId: 7, button: 0 });
    });

    const width = parseFloat(mediaItem.style.width);
    const height = parseFloat(mediaItem.style.height);
    expect(width).toBeCloseTo(1480);
    expect(width / height).toBeCloseTo(resizedRatio);
  });

  it("deletes the media item on delete button click", async () => {
    const delBtn = document.querySelector(".delete-btn") as HTMLElement;
    expect(delBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.pointerDown(delBtn, { pointerId: 5, button: 0 });
      fireEvent.click(delBtn);
    });

    expect(screen.queryByAltText("canvas item")).not.toBeInTheDocument();
  });

  it("reveals the media file in the system file browser", async () => {
    const revealBtn = document.querySelector(".reveal-btn") as HTMLElement;
    expect(revealBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.pointerDown(revealBtn, { pointerId: 10, button: 0 });
      fireEvent.click(revealBtn);
    });

    expect(revealItemInDirMock).toHaveBeenCalledWith("/path/to/test.png");
  });

  it("saves a cropped screenshot using source-size crop ratios", async () => {
    vi.mocked(open).mockResolvedValue("/shots");

    const mediaItem = getMediaItem();
    const cropBtn = document.querySelector(".crop-btn") as HTMLElement;

    await act(async () => {
      fireEvent.click(cropBtn);
    });

    const westHandle = document.querySelector(".crop-handle-w") as HTMLElement;
    await act(async () => {
      fireEvent.pointerDown(westHandle, {
        clientX: 0,
        clientY: 0,
        pointerId: 11,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerMove(mediaItem, {
        clientX: 120,
        clientY: 0,
        pointerId: 11,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerUp(mediaItem, { pointerId: 11, button: 0 });
    });

    const screenshotBtn = document.querySelector(
      ".screenshot-btn",
    ) as HTMLElement;
    await act(async () => {
      fireEvent.pointerDown(screenshotBtn, { pointerId: 12, button: 0 });
      fireEvent.click(screenshotBtn);
    });

    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Choose screenshot directory",
    });
    expect(invoke).toHaveBeenCalledWith("save_media_screenshot", {
      path: "/path/to/test.png",
      mediaType: "image",
      outputDirectory: "/shots",
      currentTime: 0,
      crop: {
        x: 120 / 1280,
        y: 0,
        width: 1160 / 1280,
        height: 1,
        boxWidth: 1280,
        boxHeight: 960,
      },
    });
  });

  it("passes the selected video's current playback time to screenshots", async () => {
    const videoPath = new URL(
      "../fixtures/generated-lod-test-1080p.mp4",
      import.meta.url,
    ).pathname;
    let currentTime = 0;

    vi.mocked(open).mockResolvedValue("/shots");
    setViewportSize({ width: 3000 });
    await dropFiles([videoPath]);

    await waitFor(() => {
      expect(document.querySelector("video.media-content")).toBeInTheDocument();
    });

    const mediaItems = Array.from(
      document.querySelectorAll(".media-item"),
    ) as HTMLElement[];
    const mediaItem = mediaItems.at(-1);
    const video = Array.from(
      document.querySelectorAll("video.media-content"),
    ).at(-1) as HTMLVideoElement | undefined;

    expect(mediaItem).toBeDefined();
    expect(video).toBeDefined();
    if (!mediaItem || !video) {
      throw new Error("Expected video media item to be rendered");
    }

    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value) => {
        currentTime = value;
      },
    });

    currentTime = 2.25;

    const screenshotBtn = mediaItem.querySelector(
      ".screenshot-btn",
    ) as HTMLElement | null;
    expect(screenshotBtn).toBeTruthy();
    if (!screenshotBtn) {
      throw new Error("Expected screenshot button for video media item");
    }

    await act(async () => {
      fireEvent.pointerDown(screenshotBtn, { pointerId: 31, button: 0 });
      fireEvent.click(screenshotBtn);
    });

    expect(invoke).toHaveBeenCalledWith("save_media_screenshot", {
      path: videoPath,
      mediaType: "video",
      outputDirectory: "/shots",
      currentTime: 2.25,
      crop: {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        boxWidth: 1280,
        boxHeight: 720,
      },
    });
  });

  it("toggles playback for selected videos with the spacebar hotkey", async () => {
    const videoPath = new URL(
      "../fixtures/generated-lod-test-1080p.mp4",
      import.meta.url,
    ).pathname;
    let paused = false;

    setViewportSize({ width: 3000 });
    await dropFiles([videoPath]);

    await waitFor(() => {
      expect(document.querySelector("video.media-content")).toBeInTheDocument();
    });

    const mediaItems = Array.from(
      document.querySelectorAll(".media-item"),
    ) as HTMLElement[];
    const mediaItem = mediaItems.at(-1);
    const video = Array.from(
      document.querySelectorAll("video.media-content"),
    ).at(-1) as HTMLVideoElement | undefined;

    expect(mediaItem).toBeDefined();
    expect(video).toBeDefined();
    if (!mediaItem || !video) {
      throw new Error("Expected video media item to be rendered");
    }

    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => paused,
    });

    Object.defineProperty(video, "play", {
      configurable: true,
      value: vi.fn(() => {
        paused = false;
        fireEvent.play(video);
        return Promise.resolve();
      }),
    });
    Object.defineProperty(video, "pause", {
      configurable: true,
      value: vi.fn(() => {
        paused = true;
        fireEvent.pause(video);
      }),
    });

    const audioBtn = mediaItem.querySelector(
      ".audio-btn",
    ) as HTMLElement | null;
    expect(audioBtn).toBeTruthy();
    if (!audioBtn) {
      throw new Error("Expected audio button for video media item");
    }

    await act(async () => {
      fireEvent.click(audioBtn);
    });

    expect(mediaItem).toHaveClass("selected");

    await act(async () => {
      fireEvent.keyDown(window, { key: " ", code: "Space" });
    });
    expect(paused).toBe(true);

    await act(async () => {
      fireEvent.keyDown(window, { key: " ", code: "Space" });
    });
    expect(paused).toBe(false);
  });

  it("crops an image in place from side and corner handles", async () => {
    const mediaItem = getMediaItem();
    const image = screen.getByAltText("canvas item") as HTMLImageElement;
    const cropBox = image.parentElement as HTMLDivElement;
    const cropBtn = document.querySelector(".crop-btn") as HTMLElement;

    expect(cropBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(cropBtn);
    });

    expect(document.querySelectorAll(".crop-handle")).toHaveLength(8);

    const startLeft = parseFloat(mediaItem.style.left);
    const startTop = parseFloat(mediaItem.style.top);
    const westHandle = document.querySelector(".crop-handle-w") as HTMLElement;

    await act(async () => {
      fireEvent.pointerDown(westHandle, {
        clientX: 0,
        clientY: 0,
        pointerId: 8,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerMove(mediaItem, {
        clientX: 120,
        clientY: 0,
        pointerId: 8,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerUp(mediaItem, { pointerId: 8, button: 0 });
    });

    expect(mediaItem.style.left).toBe(`${startLeft + 120}px`);
    expect(mediaItem.style.width).toBe("1160px");
    expect(cropBox.style.left).toBe("-120px");
    expect(cropBox.style.width).toBe("1280px");

    const northWestHandle = document.querySelector(
      ".crop-handle-nw",
    ) as HTMLElement;

    await act(async () => {
      fireEvent.pointerDown(northWestHandle, {
        clientX: 120,
        clientY: 0,
        pointerId: 9,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerMove(mediaItem, {
        clientX: 70,
        clientY: 80,
        pointerId: 9,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerUp(mediaItem, { pointerId: 9, button: 0 });
    });

    expect(mediaItem.style.left).toBe(`${startLeft + 70}px`);
    expect(mediaItem.style.top).toBe(`${startTop + 80}px`);
    expect(mediaItem.style.width).toBe("1210px");
    expect(mediaItem.style.height).toBe("880px");
    expect(cropBox.style.left).toBe("-70px");
    expect(cropBox.style.top).toBe("-80px");
  });

  it("keeps the crop box stable while cropping a resized frame", async () => {
    const mediaItem = getMediaItem();
    const image = screen.getByAltText("canvas item") as HTMLImageElement;
    const cropBox = image.parentElement as HTMLDivElement;
    const resizeHandle = document.querySelector(
      ".resize-handle",
    ) as HTMLElement;

    await act(async () => {
      fireEvent.pointerDown(resizeHandle, {
        clientX: 0,
        clientY: 0,
        pointerId: 13,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerMove(mediaItem, {
        clientX: 100,
        clientY: 200,
        pointerId: 13,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerUp(mediaItem, { pointerId: 13, button: 0 });
    });

    const cropBtn = document.querySelector(".crop-btn") as HTMLElement;
    await act(async () => {
      fireEvent.click(cropBtn);
    });

    expect(cropBox.style.left).toBe("0px");
    expect(cropBox.style.width).toBe("1380px");

    const eastHandle = document.querySelector(".crop-handle-e") as HTMLElement;
    await act(async () => {
      fireEvent.pointerDown(eastHandle, {
        clientX: 0,
        clientY: 0,
        pointerId: 14,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerMove(mediaItem, {
        clientX: -120,
        clientY: 0,
        pointerId: 14,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerUp(mediaItem, { pointerId: 14, button: 0 });
    });

    expect(mediaItem.style.width).toBe("1260px");
    expect(cropBox.style.left).toBe("0px");
    expect(cropBox.style.width).toBe("1380px");

    const startLeft = parseFloat(mediaItem.style.left);
    const westHandle = document.querySelector(".crop-handle-w") as HTMLElement;
    await act(async () => {
      fireEvent.pointerDown(westHandle, {
        clientX: 0,
        clientY: 0,
        pointerId: 15,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerMove(mediaItem, {
        clientX: 120,
        clientY: 0,
        pointerId: 15,
        button: 0,
      });
    });
    await act(async () => {
      fireEvent.pointerUp(mediaItem, { pointerId: 15, button: 0 });
    });

    expect(mediaItem.style.left).toBe(`${startLeft + 120}px`);
    expect(mediaItem.style.width).toBe("1140px");
    expect(cropBox.style.left).toBe("-120px");
    expect(cropBox.style.width).toBe("1380px");
  });
});
