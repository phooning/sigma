import { bench, describe } from "vitest";
import {
  createBenchNativeControllerSnapshot,
  createBenchNativeVideoManifest,
  createBenchNativeVideoProfile,
  createBenchProbeImagePaths,
} from "./fixtures";

type InvokePayload =
  | { manifest: ReturnType<typeof createBenchNativeVideoManifest> }
  | { paths: string[] }
  | undefined;

type MockInvoke = <T>(command: string, args?: InvokePayload) => Promise<T>;

const manifest = createBenchNativeVideoManifest(32);
const controllerSnapshot = createBenchNativeControllerSnapshot(32);
const profile = createBenchNativeVideoProfile();
const probeImagePaths = createBenchProbeImagePaths(24);

const createMockInvoke = (): MockInvoke => {
  return async <T>(command: string, args?: InvokePayload) => {
    const clonedArgs =
      args === undefined ? undefined : (structuredClone(args) as InvokePayload);

    switch (command) {
      case "native_video_get_profile":
        return structuredClone(profile) as T;
      case "native_video_update_manifest":
        if (!clonedArgs || !("manifest" in clonedArgs)) {
          throw new Error("manifest is required");
        }
        return structuredClone(controllerSnapshot) as T;
      case "probe_images":
        if (!clonedArgs || !("paths" in clonedArgs)) {
          throw new Error("paths are required");
        }
        return structuredClone(
          clonedArgs.paths.map((path, index) => ({
            path,
            width: index % 3 === 0 ? 1200 : 640,
            height: index % 3 === 0 ? 900 : 480,
            size: 256 * 1024,
          })),
        ) as T;
      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  };
};

describe("ipc latency (mocked invoke)", () => {
  bench("native_video_get_profile mocked round-trip", async () => {
    const invoke = createMockInvoke();

    for (let index = 0; index < 200; index += 1) {
      await invoke("native_video_get_profile");
    }
  });

  bench("native_video_update_manifest mocked round-trip", async () => {
    const invoke = createMockInvoke();

    for (let index = 0; index < 40; index += 1) {
      await invoke("native_video_update_manifest", { manifest });
    }
  });

  bench("probe_images mocked round-trip", async () => {
    const invoke = createMockInvoke();

    for (let index = 0; index < 100; index += 1) {
      await invoke("probe_images", { paths: probeImagePaths });
    }
  });
});
