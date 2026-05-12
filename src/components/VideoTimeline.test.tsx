import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { VideoMedia } from "./Video";

const pauseMock = vi.fn();

vi.mock("@/stores/useVideoExportStore", async () => {
  const actual = await vi.importActual<
    typeof import("../stores/useVideoExportStore")
  >("@/stores/useVideoExportStore");

  return {
    ...actual,
    getStoredVideoLoop: () => ({
      a: null,
      b: null,
      enabled: false,
    }),
  };
});

describe("Video timeline keyboard scrubbing", () => {
  beforeEach(() => {
    pauseMock.mockReset();
    vi.restoreAllMocks();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
      function pause() {
        pauseMock();
        Object.defineProperty(this, "paused", {
          configurable: true,
          value: true,
        });
      },
    );
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
      async function play() {
        Object.defineProperty(this, "paused", {
          configurable: true,
          value: false,
        });
      },
    );
  });

  it("steps by frames without restarting timeline playback while paused", async () => {
    const requestAnimationFrameMock = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    render(
      <VideoMedia
        url="file:///video.mp4"
        crop={{ top: 0, right: 0, bottom: 0, left: 0 }}
        item={{
          id: "video-1",
          type: "video",
          filePath: "C:/video.mp4",
          url: "file:///video.mp4",
          duration: 12,
          x: 0,
          y: 0,
          width: 640,
          height: 360,
          videoLod: "video",
        }}
        isInViewport={false}
        zoom={1}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Video timeline" });
    const video = document.querySelector("video");

    expect(video).toBeInstanceOf(HTMLVideoElement);

    Object.defineProperty(video, "paused", {
      configurable: true,
      value: true,
    });
    fireEvent(video as HTMLVideoElement, new Event("pause"));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Play video" }),
      ).toBeInTheDocument(),
    );

    requestAnimationFrameMock.mockClear();
    fireEvent.keyDown(slider, { key: "ArrowRight" });

    expect(video?.currentTime).toBeCloseTo(1 / 30, 5);

    fireEvent(video as HTMLVideoElement, new Event("seeked"));

    expect(requestAnimationFrameMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Play video" }),
    ).toBeInTheDocument();
  });
});
