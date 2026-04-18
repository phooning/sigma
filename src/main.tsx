import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import "./styles/Canvas.css";
import "./styles/CropControls.css";
import "./styles/DevStats.css";
import "./styles/HUD.css";
import "./styles/MediaItem.css";
import "./styles/SettingsModal.css";
import "./styles/VideoPlayer.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
