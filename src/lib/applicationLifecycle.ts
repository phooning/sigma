import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  prepareSessionShutdown,
  resumeSession,
} from "../stores/useCanvasSessionStore";
import { notify } from "../utils/notifications";

type LifecycleBoundary = {
  listen: (
    onRequest: (id: number) => void,
    onFailure: (message: string) => void,
  ) => Promise<() => void>;
  ready: () => Promise<unknown>;
  complete: (id: number, error: string | null) => Promise<unknown>;
  flush: () => Promise<void>;
};

const reportFailure = (error: unknown) =>
  notify.error("Could not close safely", {
    description: String(error),
    duration: Infinity,
  });

// Installed once per webview, outside React's mount cycle. Native code owns the
// deadline and exit decision; a late acknowledgment can never authorize exit.
export function installApplicationLifecycle(boundary: LifecycleBoundary) {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const requests = new Set<number>();
  const onRequest = (id: number) => {
    if (disposed || requests.has(id)) return;
    requests.add(id);
    void (async () => {
      let error: string | null = null;
      try {
        await boundary.flush();
      } catch (failure) {
        error = String(failure);
      }
      if (!disposed) await boundary.complete(id, error);
    })()
      .catch(reportFailure)
      .finally(() => requests.delete(id));
  };
  void boundary
    .listen(onRequest, reportFailure)
    .then(async (dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
      await boundary.ready();
    })
    .catch(reportFailure);
  return () => {
    disposed = true;
    unlisten?.();
  };
}

export function installNativeLifecycle() {
  if (!isTauri()) return () => {};
  const previousInert = document.documentElement.inert;
  let activeRequest: number | undefined;
  const resume = () => {
    activeRequest = undefined;
    document.documentElement.inert = previousInert;
    resumeSession();
  };
  const dispose = installApplicationLifecycle({
    async listen(onRequest, onFailure) {
      const request = await listen<number>(
        "sigma:shutdown-request",
        (event) => {
          activeRequest = event.payload;
          onRequest(event.payload);
        },
      );
      try {
        const failure = await listen<{ id: number; message: string }>(
          "sigma:shutdown-failed",
          (event) => {
            if (activeRequest !== event.payload.id) return;
            resume();
            onFailure(event.payload.message);
          },
        );
        return () => {
          request();
          failure();
        };
      } catch (error) {
        request();
        throw error;
      }
    },
    ready: () => invoke("lifecycle_ready"),
    complete: async (id, error) => {
      try {
        await invoke("complete_shutdown", { id, error });
      } catch (failure) {
        if (activeRequest === id) resume();
        throw failure;
      }
    },
    flush: () => {
      document.documentElement.inert = true;
      return prepareSessionShutdown();
    },
  });
  return () => {
    dispose();
    resume();
  };
}
