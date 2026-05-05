import type { MediaItem } from "../utils/media.types";
import { getMediaFileName } from "./hud/utils";
import type { VideoTimelineController } from "./Video.types";
import { VideoTimeline } from "./VideoTimeline";

type VideoControlFooterProps = {
  selectedVideoItem: MediaItem | null;
  timelineController: VideoTimelineController | null;
};

export function VideoControlFooter({
  selectedVideoItem,
  timelineController,
}: VideoControlFooterProps) {
  if (!selectedVideoItem || !timelineController) {
    return null;
  }

  const selectedVideoName = getMediaFileName(selectedVideoItem.filePath);

  return (
    <div className="ui-overlay ui-overlay-footer">
      <div className="video-footer-heading">
        <div className="hud-title">Selected Video</div>
        <span className="item-count">{selectedVideoName}</span>
      </div>

      <div className="video-footer-toolbar">
        {timelineController.playbackError ? (
          <div className="video-footer-status video-footer-error" role="status">
            {timelineController.playbackError}
          </div>
        ) : timelineController.duration > 0 ? (
          <VideoTimeline {...timelineController} layout="footer" />
        ) : (
          <div className="video-footer-status" role="status">
            Preparing video controls…
          </div>
        )}
      </div>
    </div>
  );
}
