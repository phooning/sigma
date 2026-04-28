import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_CROP } from "../utils/media";
import type { MediaItem } from "../utils/media.types";
import { ImageActions } from "./ImageActions";

const imageItem: MediaItem = {
  id: "image-1",
  type: "image",
  filePath: "/images/full-res.png",
  url: "asset:///images/full-res.png",
  x: 0,
  y: 0,
  width: 6000,
  height: 4000,
  sourceWidth: 6000,
  sourceHeight: 4000,
};

const renderImageActions = (item: MediaItem, requestImagePreview = vi.fn()) =>
  render(
    <ImageActions
      id={item.id}
      crop={EMPTY_CROP}
      item={item}
      isCropEditing={false}
      isDragging={false}
      isCropping={false}
      isResizing={false}
      useNativeImageSurface={false}
      handleItemPointerDown={vi.fn()}
      requestImagePreview={requestImagePreview}
      zoom={0.1}
    />,
  );

describe("ImageActions LOD fallback", () => {
  it("does not attach the full-res URL below 1x zoom while the 1024 preview is missing", async () => {
    const requestImagePreview = vi.fn();

    renderImageActions(imageItem, requestImagePreview);

    const image = screen.getByAltText("canvas item");
    expect(image).toHaveAttribute(
      "src",
      expect.stringMatching(/^data:image\/svg\+xml/),
    );
    expect(image).not.toHaveAttribute("src", "asset:///images/full-res.png");
    await waitFor(() => {
      expect(requestImagePreview).toHaveBeenCalledWith(imageItem, 1024);
    });
  });

  it("uses the 1024 preview below 1x zoom once available", () => {
    renderImageActions({
      ...imageItem,
      imagePreview1024Url: "asset:///images/full-res-preview-1024.png",
    });

    expect(screen.getByAltText("canvas item")).toHaveAttribute(
      "src",
      "asset:///images/full-res-preview-1024.png",
    );
  });
});
