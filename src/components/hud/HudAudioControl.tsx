import { useAudioPlaybackStore } from "@/stores/useAudioPlaybackStore";
import type { MediaItem } from "../../utils/media.types";

type HudAudioControlProps = {
  activeAudioItem: MediaItem;
  activeAudioName: string;
  onSelectActiveAudioItem: () => void;
};

export function HudAudioControl({
  activeAudioName,
  onSelectActiveAudioItem,
}: HudAudioControlProps) {
  const audioVolume = useAudioPlaybackStore((s) => s.volume);
  const isAudioMuted = useAudioPlaybackStore((s) => s.muted);
  const setAudioVolume = useAudioPlaybackStore((s) => s.setVolume);
  const toggleAudioMuted = useAudioPlaybackStore((s) => s.toggleMuted);

  const audioPercent = Math.round(audioVolume * 100);

  const renderAudioMarqueeItem = (isHidden = false) => (
    <span className="hud-audio-filename" aria-hidden={isHidden}>
      {activeAudioName}
    </span>
  );

  return (
    <div
      className="hud-audio-control"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      title={activeAudioName}
    >
      <button
        type="button"
        className="hud-audio-mute-btn"
        onClick={toggleAudioMuted}
        aria-label={isAudioMuted ? "Unmute audio" : "Mute audio"}
        aria-pressed={isAudioMuted}
        title={isAudioMuted ? "Unmute audio" : "Mute audio"}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M11 5 6 9H3v6h3l5 4V5z" />
          {isAudioMuted ? (
            <>
              <path d="m19 9-6 6" />
              <path d="m13 9 6 6" />
            </>
          ) : (
            <>
              <path d="M15.5 8.5a5 5 0 0 1 0 7" />
              <path d="M18.5 5.5a9 9 0 0 1 0 13" />
            </>
          )}
        </svg>
      </button>
      <button
        type="button"
        className="hud-audio-marquee"
        aria-label={`Audio clip: ${activeAudioName}`}
        onClick={onSelectActiveAudioItem}
      >
        <div className="hud-audio-marquee-track">
          {renderAudioMarqueeItem()}
          {renderAudioMarqueeItem(true)}
        </div>
      </button>
      <input
        className="hud-volume-slider"
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={audioVolume}
        aria-label={`Volume for ${activeAudioName}`}
        aria-valuetext={`${audioPercent}%`}
        onChange={(event) => setAudioVolume(Number(event.currentTarget.value))}
      />
    </div>
  );
}
