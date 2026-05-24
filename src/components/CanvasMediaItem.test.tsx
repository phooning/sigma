import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../utils/media.types";
import { getImageLod } from "../utils/videoUtils";
import { CanvasMediaItem } from "./CanvasMediaItem";
import type { CanvasMediaItemProps } from "./CanvasMediaItem.types";
import { isNativeImageSourceReady } from "./native-image/manifest";

vi.mock("./ImageActions", () => ({
  ImageActions: ({
    allowFullResFallback,
    mountDomImage,
    onReadyChange,
    showDomImage,
  }: {
    allowFullResFallback: boolean;
    mountDomImage: boolean;
    onReadyChange?: (isReady: boolean) => void;
    showDomImage: boolean;
  }) =>
    mountDomImage ? (
      <button
        type="button"
        data-testid="image-ready"
        data-full-res-fallback={allowFullResFallback}
        data-visible={showDomImage}
        onClick={() => onReadyChange?.(true)}
      >
        ready
      </button>
    ) : null,
}));

vi.mock("./MediaFrameActions", () => ({
  CropOverlay: () => <div data-testid="crop-overlay" />,
  MediaFrameActions: () => <div data-testid="media-frame-actions" />,
}));

vi.mock("./Video", () => ({
  VideoMedia: ({
    onReadyChange,
  }: {
    onReadyChange?: (isReady: boolean) => void;
  }) => (
    <button
      type="button"
      data-testid="video-ready"
      onClick={() => onReadyChange?.(true)}
    >
      ready
    </button>
  ),
}));

const imageItem: MediaItem = {
  id: "image-1",
  type: "image",
  filePath: "/images/full-res.png",
  url: "asset:///images/full-res.png",
  x: 0,
  y: 0,
  width: 1200,
  height: 800,
  sourceWidth: 1200,
  sourceHeight: 800,
};

const videoItem: MediaItem = {
  id: "video-1",
  type: "video",
  filePath: "/videos/example.mp4",
  url: "asset:///videos/example.mp4",
  x: 0,
  y: 0,
  width: 1200,
  height: 800,
};

const baseProps: CanvasMediaItemProps = {
  deleteItem: vi.fn(),
  handleItemPointerDown: vi.fn(),
  handleItemPointerMove: vi.fn(),
  handleItemPointerUp: vi.fn(),
  item: imageItem,
  isActiveAudioItem: false,
  isCropping: false,
  isCropEditing: false,
  isDragging: false,
  useNativeImageSurface: false,
  isResizing: false,
  isSelected: false,
  requestImagePreview: vi.fn(),
  requestThumbnail: vi.fn(),
  resetSize: vi.fn(),
  revealItem: vi.fn(),
  screenshotItem: vi.fn(),
  startCropEdit: vi.fn(),
  toggleAudioPlayback: vi.fn(),
  viewBounds: {
    viewLeft: 0,
    viewTop: 0,
    viewRight: 1600,
    viewBottom: 1200,
  },
  zoom: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CanvasMediaItem readiness mask", () => {
  it("waits for DOM image readiness before fading the mask", () => {
    const animationFrames: FrameRequestCallback[] = [];
    let animationFrameHandle = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      animationFrameHandle += 1;
      return animationFrameHandle;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const { container } = render(<CanvasMediaItem {...baseProps} />);
    const mask = container.querySelector(".media-visibility-mask");

    expect(mask).toHaveStyle({
      opacity: "1",
      backdropFilter: "blur(12px)",
    });
    expect(animationFrames).toHaveLength(0);
    const image = container.querySelector('[data-testid="image-ready"]');
    if (!image) {
      throw new Error('Cannot find image from "image-ready".');
    }

    fireEvent.click(image);

    expect(animationFrames).toHaveLength(1);

    act(() => {
      animationFrames[0]?.(16);
    });

    expect(mask).toHaveStyle({
      opacity: "0",
      backdropFilter: "blur(0px)",
    });
  });

  it("waits for a native image asset-ready path before fading the mask", () => {
    const animationFrames: FrameRequestCallback[] = [];
    let animationFrameHandle = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      animationFrameHandle += 1;
      return animationFrameHandle;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const { container, rerender } = render(<CanvasMediaItem {...baseProps} />);
    const mask = container.querySelector(".media-visibility-mask");
    expect(mask).toHaveStyle({ opacity: "1" });

    rerender(
      <CanvasMediaItem
        {...baseProps}
        item={{
          ...imageItem,
          imagePreview1024Path: "/images/full-res-preview-1024.png",
          imagePreview1024Url: "asset:///images/full-res-preview-1024.png",
        }}
        nativeImageReadyPath="/images/full-res-preview-1024.png"
        useNativeImageSurface
        zoom={0.1}
      />,
    );

    expect(animationFrames).toHaveLength(1);

    act(() => {
      animationFrames[0]?.(16);
    });

    expect(mask).toHaveStyle({ opacity: "0" });
  });

  it("keeps DOM visible when native ready path belongs to the previous LOD", () => {
    const animationFrames: FrameRequestCallback[] = [];
    let animationFrameHandle = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      animationFrameHandle += 1;
      return animationFrameHandle;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const itemWithPreview: MediaItem = {
      ...imageItem,
      width: 3000,
      height: 2000,
      sourceWidth: 3000,
      sourceHeight: 2000,
      imagePreview1024Path: "/images/full-res-preview-1024.png",
      imagePreview1024Url: "asset:///images/full-res-preview-1024.png",
    };
    const zoom = 0.1;

    expect(getImageLod(zoom, itemWithPreview)).toBe("preview1024");
    expect(
      isNativeImageSourceReady(
        itemWithPreview,
        zoom,
        "/images/full-res-preview-1024.png",
      ),
    ).toBe(true);
    expect(
      isNativeImageSourceReady(itemWithPreview, zoom, "/images/full-res.png"),
    ).toBe(false);

    const { container, rerender } = render(
      <CanvasMediaItem
        {...baseProps}
        item={itemWithPreview}
        nativeImageReadyPath="/images/full-res.png"
        useNativeImageSurface
        zoom={zoom}
      />,
    );

    expect(screen.getByTestId("image-ready")).toHaveAttribute(
      "data-visible",
      "true",
    );
    expect(screen.getByTestId("image-ready")).toHaveAttribute(
      "data-full-res-fallback",
      "true",
    );

    rerender(
      <CanvasMediaItem
        {...baseProps}
        item={itemWithPreview}
        isSelected
        nativeImageReadyPath="/images/full-res.png"
        useNativeImageSurface
        zoom={zoom}
      />,
    );

    expect(screen.getByTestId("image-ready")).toHaveAttribute(
      "data-visible",
      "true",
    );
    expect(screen.getByTestId("image-ready")).toHaveAttribute(
      "data-full-res-fallback",
      "true",
    );

    fireEvent.click(screen.getByTestId("image-ready"));
    expect(animationFrames).toHaveLength(1);

    act(() => {
      animationFrames[0]?.(16);
    });

    expect(container.querySelector(".media-visibility-mask")).toHaveStyle({
      opacity: "0",
    });

    rerender(
      <CanvasMediaItem
        {...baseProps}
        item={itemWithPreview}
        nativeImageReadyPath="/images/full-res-preview-1024.png"
        useNativeImageSurface
        zoom={zoom}
      />,
    );

    expect(screen.queryByTestId("image-ready")).not.toBeInTheDocument();
  });

  it("does not use full-res DOM fallback for unready unselected native images without a prior full-res path", () => {
    render(
      <CanvasMediaItem
        {...baseProps}
        item={{
          ...imageItem,
          imagePreview1024Path: "/images/full-res-preview-1024.png",
          imagePreview1024Url: "asset:///images/full-res-preview-1024.png",
        }}
        useNativeImageSurface
        zoom={0.1}
      />,
    );

    expect(screen.getByTestId("image-ready")).toHaveAttribute(
      "data-visible",
      "true",
    );
  });

  it("skips the mask while the item is actively transforming", () => {
    const { container } = render(
      <CanvasMediaItem {...baseProps} isDragging useNativeImageSurface />,
    );
    const mask = container.querySelector(".media-visibility-mask");

    expect(mask).toHaveStyle({
      opacity: "0",
      backdropFilter: "blur(0px)",
    });
    expect(mask).toHaveStyle({ transition: "none" });
  });

  it("keeps a ready playing video clear while idle", () => {
    const animationFrames: FrameRequestCallback[] = [];
    let animationFrameHandle = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      animationFrameHandle += 1;
      return animationFrameHandle;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const { container } = render(
      <CanvasMediaItem {...baseProps} item={videoItem} />,
    );
    const mask = container.querySelector(".media-visibility-mask");

    expect(mask).toHaveStyle({
      opacity: "1",
      backdropFilter: "blur(12px)",
    });

    fireEvent.click(screen.getByTestId("video-ready"));

    expect(animationFrames).toHaveLength(1);

    act(() => {
      animationFrames[0]?.(16);
    });

    expect(mask).toHaveStyle({
      opacity: "0",
      backdropFilter: "blur(0px)",
    });
  });

  it("keeps a ready video clear during drag, resize, and crop interactions", () => {
    const animationFrames: FrameRequestCallback[] = [];
    let animationFrameHandle = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      animationFrameHandle += 1;
      return animationFrameHandle;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const { container, rerender } = render(
      <CanvasMediaItem {...baseProps} item={videoItem} />,
    );
    const mask = container.querySelector(".media-visibility-mask");

    fireEvent.click(screen.getByTestId("video-ready"));
    act(() => {
      animationFrames[0]?.(16);
    });

    expect(mask).toHaveStyle({
      opacity: "0",
      backdropFilter: "blur(0px)",
    });

    for (const interactionProps of [
      { isDragging: true },
      { isResizing: true },
      { isCropping: true },
    ]) {
      rerender(
        <CanvasMediaItem
          {...baseProps}
          {...interactionProps}
          item={videoItem}
        />,
      );

      expect(mask).toHaveStyle({
        opacity: "0",
        backdropFilter: "blur(0px)",
        transition: "none",
      });
    }
  });

  it("shows standard-size native images through the moving DOM layer while transforming", () => {
    render(<CanvasMediaItem {...baseProps} isDragging useNativeImageSurface />);

    expect(screen.getByTestId("image-ready")).toHaveAttribute(
      "data-visible",
      "true",
    );
  });

  it("uses a preloaded preview handoff for >4K native image transforms", () => {
    const largeItem: MediaItem = {
      ...imageItem,
      width: 5000,
      height: 3200,
      sourceWidth: 5000,
      sourceHeight: 3200,
      imagePreview1024Path: "/images/full-res-preview-1024.png",
      imagePreview1024Url: "asset:///images/full-res-preview-1024.png",
    };

    const { rerender } = render(
      <CanvasMediaItem
        {...baseProps}
        item={largeItem}
        isDragging
        useNativeImageSurface
      />,
    );

    expect(screen.getByTestId("image-ready")).toHaveAttribute(
      "data-visible",
      "true",
    );

    rerender(
      <CanvasMediaItem {...baseProps} item={largeItem} useNativeImageSurface />,
    );

    expect(screen.getByTestId("image-ready")).toHaveAttribute(
      "data-visible",
      "true",
    );

    rerender(
      <CanvasMediaItem
        {...baseProps}
        item={largeItem}
        nativeImageReadyPath="/images/full-res.png"
        useNativeImageSurface
      />,
    );

    expect(screen.getByTestId("image-ready")).toHaveAttribute(
      "data-visible",
      "false",
    );
  });
});
