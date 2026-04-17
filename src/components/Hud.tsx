import { MediaItem } from "../utils/media.types";

export interface ISelectionBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

const Hud = ({
  items,
  saveConfig,
  loadConfig,
}: {
  items: MediaItem[];
  saveConfig: () => void;
  loadConfig: () => void;
}) => {
  return (
    <div className="ui-overlay">
      <div className="hud-title">SIGMA Media Canvas</div>

      <div className="toolbar">
        <button className="hud-btn" onClick={saveConfig}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>{" "}
          Save
        </button>
        <button className="hud-btn" onClick={loadConfig}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 15v4c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-4M17 9l-5 5-5-5M12 12.8V2.5" />
          </svg>{" "}
          Load
        </button>

        <span className="item-count">{items.length} items</span>
      </div>
    </div>
  );
};

export { Hud };
