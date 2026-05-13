import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

const getAppWindow = () => {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
};

const getPlatformName = () => {
  try {
    return platform();
  } catch {
    return null;
  }
};

export function WindowControls() {
  const os = getPlatformName();
  const [isMaximized, setIsMaximized] = useState(false);
  const appWindow = getAppWindow();

  useEffect(() => {
    if (!appWindow) {
      return;
    }

    appWindow.isMaximized().then(setIsMaximized);

    const unlistenPromise = appWindow.onResized(async () => {
      setIsMaximized(await appWindow.isMaximized());
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [appWindow]);

  // macOS usually should keep native traffic lights instead of fake Windows buttons.
  if (os === "macos" || !appWindow) {
    return null;
  }

  return (
    <div className="window-controls" data-tauri-drag-region="false">
      <button
        type="button"
        aria-label="Minimize"
        className="window-control-button"
        onClick={() => appWindow.minimize()}
        data-tauri-drag-region="false"
      >
        <Minus size={15} />
      </button>

      <button
        type="button"
        aria-label={isMaximized ? "Restore" : "Maximize"}
        className="window-control-button"
        onClick={async () => {
          await appWindow.toggleMaximize();
          setIsMaximized(await appWindow.isMaximized());
        }}
        data-tauri-drag-region="false"
      >
        {isMaximized ? <Copy size={13} /> : <Square size={13} />}
      </button>

      <button
        type="button"
        aria-label="Close"
        className="window-control-button window-control-button-close"
        onClick={() => appWindow.close()}
        data-tauri-drag-region="false"
      >
        <X size={16} />
      </button>
    </div>
  );
}
