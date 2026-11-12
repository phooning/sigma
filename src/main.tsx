import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installNativeLifecycle } from "./lib/applicationLifecycle";
import "./styles/globals.css";
import "./styles/Canvas.css";
import "./styles/CropControls.css";
import "./styles/DevStats.css";
import "./styles/HUD.css";
import "./styles/MediaItem.css";
import "./styles/VideoPlayer.css";

const disposeLifecycle = installNativeLifecycle();
import.meta.hot?.dispose(disposeLifecycle);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (
  import.meta.env.MODE === "desktop-test" &&
  import.meta.env.VITE_SIGMA_DESKTOP_TEST === "1"
) {
  void import("./test/desktopBridge").then(({ desktopBridge }) => {
    window.__SIGMA_DESKTOP_TEST__ = desktopBridge;
  });
}
