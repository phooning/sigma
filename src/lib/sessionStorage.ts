import { isStoredCanvasConfig } from "../utils/fs";
import { notify } from "../utils/notifications";
import { markPerformance } from "../utils/performance";

// A failed hydration must never turn the next viewport update into a destructive
// replacement of the only recovery copy. Keep its bytes until explicit recovery.
export function createSessionStorage() {
  let protectedData = false;
  let writeError: unknown;
  return {
    getItem(name: string) {
      try {
        const contents = localStorage.getItem(name);
        if (contents !== null) {
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
        protectedData = false;
        return contents;
      } catch (error) {
        protectedData = true;
        notify.error("Canvas recovery failed", {
          description:
            "The original recovery data has been preserved. Open a saved canvas or use Save As to preserve new work; automatic session recovery is disabled for this session.",
          duration: Infinity,
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
  };
}
