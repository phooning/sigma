import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { isStoredCanvasConfig } from "../utils/fs";
import { notify } from "../utils/notifications";
import { markPerformance } from "../utils/performance";

function validateRecoveryEnvelope(contents: string) {
  const envelope: unknown = JSON.parse(contents);
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !("state" in envelope) ||
    !isStoredCanvasConfig(envelope.state) ||
    ("version" in envelope && envelope.version !== 0) ||
    ("saveFilePath" in envelope.state &&
      envelope.state.saveFilePath !== null &&
      typeof envelope.state.saveFilePath !== "string") ||
    ("lastSavedSignature" in envelope.state &&
      envelope.state.lastSavedSignature !== null &&
      typeof envelope.state.lastSavedSignature !== "string")
  )
    throw new Error("Invalid or unsupported canvas recovery data");
}

// A failed hydration must never turn the next viewport update into a destructive
// replacement of the only recovery copy. Keep its bytes until explicit recovery.
export function createSessionStorage(onDiscard?: () => void) {
  let protectedData = false;
  let writeError: unknown;
  let exportedValue: string | null = null;
  let recoveryNotice: string | number | undefined;
  let exportNotice: string | number | undefined;
  async function exportRecoveryData(
    name: string,
    destination?: string,
  ): Promise<boolean> {
    try {
      if (!protectedData)
        throw new Error("No protected recovery data is available");
      const original = localStorage.getItem(name);
      if (original === null)
        throw new Error("Recovery data is no longer available");
      const path =
        destination ??
        (await save({
          title: "Export original recovery data",
          defaultPath: "sigma-recovery-original.json",
          filters: [{ name: "Recovery data", extensions: ["json"] }],
        }));
      if (!path) return false;
      // A raw recovery value may not be a project. Never replace an existing
      // project if the export picker points at one.
      await invoke("save_canvas_atomic", {
        path,
        contents: original,
        createOnly: true,
      });
      exportedValue = original;
      exportNotice = notify.success("Recovery data exported", {
        description:
          "This raw backup may not be a valid Sigma project. The original remains in this app until you choose Discard original data.",
        duration: Infinity,
        action: {
          label: "Discard original data",
          onClick: () => discardRecoveryData(name),
        },
      });
      return true;
    } catch (error) {
      notify.error("Recovery export failed", { description: error });
      return false;
    }
  }
  function discardRecoveryData(name: string): boolean {
    if (!protectedData || exportedValue === null) return false;
    try {
      if (localStorage.getItem(name) !== exportedValue)
        throw new Error(
          "Recovery data changed after export. Export it again before discarding.",
        );
      localStorage.removeItem(name);
    } catch (error) {
      notify.error("Recovery discard failed", { description: error });
      return false;
    }
    protectedData = false;
    exportedValue = null;
    writeError = undefined;
    if (recoveryNotice !== undefined) notify.dismiss(recoveryNotice);
    if (exportNotice !== undefined) notify.dismiss(exportNotice);
    try {
      onDiscard?.();
    } catch (error) {
      writeError = error;
    }
    if (writeError) {
      notify.error("Session recovery could not be saved", {
        description:
          "The original data was discarded. Use Save As to preserve your current work.",
      });
    } else {
      notify.success("Session recovery resumed", {
        description: "Future edits will be saved for recovery again.",
      });
    }
    return true;
  }
  return {
    getItem(name: string) {
      try {
        const contents = localStorage.getItem(name);
        if (contents !== null) validateRecoveryEnvelope(contents);
        protectedData = false;
        exportedValue = null;
        return contents;
      } catch (error) {
        protectedData = true;
        exportedValue = null;
        recoveryNotice = notify.error("Canvas recovery failed", {
          description:
            "The original recovery data is preserved. Export it for repair, or use Save As for new work. The raw data may not be a valid Sigma project.",
          duration: Infinity,
          action: {
            label: "Export original data",
            onClick: () => void exportRecoveryData(name),
          },
        });
        throw error;
      }
    },
    removeItem(name: string) {
      if (!protectedData) localStorage.removeItem(name);
    },
    setItem(name: string, value: string) {
      if (protectedData) return;
      markPerformance("sigma:canvas-session:localStorage:setItem:start");
      try {
        validateRecoveryEnvelope(value);
        localStorage.setItem(name, value);
        writeError = undefined;
      } catch (error) {
        writeError = error;
        notify.error("Session recovery could not be saved", {
          description: "Use Save As to preserve your work in a canvas file.",
        });
      } finally {
        markPerformance("sigma:canvas-session:localStorage:setItem:end");
      }
    },
    assertWritable() {
      if (protectedData)
        throw new Error(
          "Automatic recovery is disabled because the original recovery data is invalid. Save your work to a canvas file before closing.",
        );
      if (writeError) throw writeError;
    },
    exportRecoveryData,
    discardRecoveryData,
  };
}
