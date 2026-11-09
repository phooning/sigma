// Frontend correctness gates over the real-world media corpus.
//
// The Tauri boundary is replaced by the payloads the *real* Rust commands
// returned for each asset (see src/test/mediaCorpusFixtures.ts), so these
// tests exercise the production import, store, preview-queue and persistence
// code against the native contract. Test titles carry `[gate-id]` tags that
// scripts/media/run-media-suite.ts maps onto correctness gates.
// The harness must load first: it registers the Tauri module mocks that the
// application modules below bind to at import time.
import "../../test/infiniteCanvasHarness";
import { act, renderHook } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { onDropMedia } from "../../components/CanvasActions";
import {
  checkCanvasInvariants,
  diffNormalizedItems,
  normalizeItemsForComparison,
} from "../../lib/media-corpus/invariants";
import { createRng, parseSeed } from "../../lib/media-corpus/random";
import {
  describeOperation,
  generateWorkload,
} from "../../lib/media-corpus/workload";
import { useCanvasSessionStore } from "../../stores/useCanvasSessionStore";
import { useInteractionStore } from "../../stores/useInteractionStore";
import {
  dropFiles,
  invoke,
  open,
  readTextFile,
  renderCanvas,
  toast,
} from "../../test/infiniteCanvasHarness";
import {
  type CorpusFixture,
  envNumber,
  loadFixtureSet,
} from "../../test/mediaCorpusFixtures";
import { getCanvasConfigData } from "../../utils/fs";
import { useThumbnailQueue } from "../../utils/media";
import type { MediaItem, Viewport } from "../../utils/media.types";
import { clampVideoTime } from "../../utils/videoUtils";
import { pushItemToTop } from "../../utils/viewport";
import { applyPanDelta, applyZoomAtPoint } from "../../utils/viewportMath";

const fixtureSet = loadFixtureSet();
const fixtures = fixtureSet.fixtures;
const decodable = fixtures.filter((fixture) => fixture.expectProbe === "ok");
const byPath = new Map(fixtures.map((fixture) => [fixture.path, fixture]));
const SEED = parseSeed(process.env.SIGMA_MEDIA_SEED, 20261108);
const OPERATIONS = envNumber("SIGMA_MEDIA_OPS", 600);
const WORKSPACE = `${fixtureSet.corpusRoot.replace(/\/[^/]+$/, "")}/sigma-media-workspace.json`;
const LARGE_VIDEO_BYTES = 100 * 1024 * 1024;
const FALLBACK = { width: 1280, height: 720 };

type MetricSample = {
  key: string;
  unit: string;
  workload: string;
  samples: number[];
};
const metrics: MetricSample[] = [];
const fixtureOutcomes = new Map<string, string>();
const memfs = new Map<string, string>();
let saveFailure: string | null = null;
let saveWrites = 0;
let probeGate: ((path: string) => Promise<void>) | null = null;

const probeResult = async (path: string) => {
  if (probeGate) await probeGate(path);
  const fixture = byPath.get(path);
  if (!fixture)
    throw `Failed to read media file metadata: No such file (${path})`;
  if (!fixture.probe.ok) throw fixture.probe.error;
  return structuredClone(fixture.probe.value);
};

const installNativeBoundary = () => {
  invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case "probe_media":
          return probeResult(String(args?.path));
        case "probe_images":
          return [];
        case "save_canvas_atomic": {
          if (saveFailure) throw saveFailure;
          saveWrites += 1;
          memfs.set(String(args?.path), String(args?.contents));
          return null;
        }
        case "request_decode":
        case "generate_video_thumbnail":
          return null;
        default:
          return null;
      }
    },
  );
  vi.mocked(readTextFile).mockImplementation(async (path: string | URL) => {
    const contents = memfs.get(String(path));
    if (contents === undefined) throw new Error(`ENOENT: ${String(path)}`);
    return contents;
  });
};

/** Expected item metadata derived only from the native probe payload. */
const expectedMetadata = (fixture: CorpusFixture) => {
  if (!fixture.probe.ok) {
    return {
      sourceWidth: FALLBACK.width,
      sourceHeight: FALLBACK.height,
      failed: true,
    };
  }
  const value = fixture.probe.value as {
    width: number;
    height: number;
    duration: number;
    frameRate?: number;
    size: number;
  };
  return {
    sourceWidth: value.width || FALLBACK.width,
    sourceHeight: value.height || FALLBACK.height,
    duration: value.duration,
    frameRate: value.frameRate,
    fileSize: value.size,
    deferVideoLoad: value.size >= LARGE_VIDEO_BYTES,
    failed: false,
  };
};

const metadataFailures = (
  item: MediaItem | undefined,
  fixture: CorpusFixture,
) => {
  if (!item) return [`${fixture.relativePath}: no item imported`];
  const expected = expectedMetadata(fixture);
  const failures: string[] = [];
  if (item.filePath !== fixture.path)
    failures.push(`${fixture.relativePath}: filePath ${item.filePath}`);
  for (const key of [
    "sourceWidth",
    "sourceHeight",
    "duration",
    "frameRate",
    "fileSize",
  ] as const) {
    if (
      key in expected &&
      item[key] !== expected[key as keyof typeof expected]
    ) {
      failures.push(
        `${fixture.relativePath}: ${key} ${String(item[key])} != ${String(expected[key as keyof typeof expected])}`,
      );
    }
  }
  if (
    !expected.failed &&
    Boolean(item.deferVideoLoad) !== expected.deferVideoLoad
  ) {
    failures.push(
      `${fixture.relativePath}: deferVideoLoad ${String(item.deferVideoLoad)}`,
    );
  }
  const ratio = (item.height / item.width) * expected.sourceWidth;
  if (Math.abs(ratio - expected.sourceHeight) > 1e-6 * expected.sourceHeight) {
    failures.push(`${fixture.relativePath}: aspect ratio not preserved`);
  }
  return failures;
};

const viewportRef = (viewport: Viewport = { x: 0, y: 0, zoom: 1 }) => ({
  current: viewport,
});
const resetSession = () =>
  useCanvasSessionStore.getState().replaceSession({
    items: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    saveFilePath: null,
    lastSavedSignature: null,
  });

const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
};

beforeEach(() => {
  memfs.clear();
  saveFailure = null;
  probeGate = null;
  installNativeBoundary();
  resetSession();
});

afterAll(async () => {
  const out = process.env.SIGMA_MEDIA_FRONTEND_OUT;
  if (!out) return;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    out,
    JSON.stringify(
      {
        schema: "sigma.media-frontend-report.v1",
        source: fixtureSet.source,
        seed: SEED,
        operations: OPERATIONS,
        fixtureCount: fixtures.length,
        metrics,
        fixtureOutcomes: Object.fromEntries(fixtureOutcomes),
      },
      null,
      2,
    ),
  );
});

describe(`media corpus ingestion (${fixtureSet.source})`, () => {
  it("[ingest.single] imports every asset individually with its native metadata", async () => {
    expect(fixtures.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const fixture of fixtures) {
      vi.mocked(toast.error).mockClear();
      const items = await onDropMedia({
        paths: [fixture.path],
        viewportRef: viewportRef(),
      });
      const itemFailures = metadataFailures(items[0], fixture);
      if (items.length !== 1)
        itemFailures.push(`${fixture.relativePath}: ${items.length} items`);
      const reportedError = vi.mocked(toast.error).mock.calls.length > 0;
      if (reportedError !== !fixture.probe.ok) {
        itemFailures.push(
          `${fixture.relativePath}: probe failure reported=${reportedError}`,
        );
      }
      if (fixture.expectProbe === "ok" && !fixture.probe.ok) {
        itemFailures.push(
          `${fixture.relativePath}: native probe failed: ${fixture.probe.error}`,
        );
      }
      fixtureOutcomes.set(
        fixture.id,
        itemFailures.length === 0
          ? fixture.probe.ok
            ? "ok"
            : "controlled-error"
          : "FAIL",
      );
      failures.push(...itemFailures);
    }
    expect(failures).toEqual([]);
  });

  it("[ingest.batch-order] keeps input order and asset identity when probes finish out of order", async () => {
    const paths = fixtures.flatMap((fixture, index) => [
      fixture.path,
      ...(index % 4 === 0
        ? [`${fixtureSet.corpusRoot}/notes-${index}.txt`]
        : []),
    ]);
    // Later inputs resolve first, so completion order is the reverse of input.
    const ranks = new Map(
      paths.map((path, index) => [path, paths.length - index]),
    );
    probeGate = (path) =>
      new Promise((ok) => setTimeout(ok, ranks.get(path) ?? 0));
    const durations: number[] = [];
    let items: MediaItem[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      const started = performance.now();
      items = await onDropMedia({ paths, viewportRef: viewportRef() });
      durations.push(performance.now() - started);
    }
    metrics.push({
      key: "frontend.import.batch_ms",
      unit: "ms",
      workload: `${fixtures.length} assets, reverse-ordered probe completion (includes ≤${paths.length} ms injected delay)`,
      samples: durations,
    });
    expect(items.map((item) => item.filePath)).toEqual(
      fixtures.map((fixture) => fixture.path),
    );
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    const failures = fixtures.flatMap((fixture, index) =>
      metadataFailures(items[index], fixture),
    );
    expect(failures).toEqual([]);
    expect(checkCanvasInvariants(items, { x: 0, y: 0, zoom: 1 })).toEqual([]);
  });

  it("[ingest.duplicates] creates distinct items for repeated files without mixing metadata", async () => {
    const target = decodable[0] ?? fixtures[0];
    if (!target) throw new Error("no fixtures");
    const first = await onDropMedia({
      paths: [target.path, target.path],
      viewportRef: viewportRef(),
    });
    const second = await onDropMedia({
      paths: [target.path],
      viewportRef: viewportRef(),
    });
    const all = [...first, ...second];
    expect(all).toHaveLength(3);
    expect(new Set(all.map((item) => item.id)).size).toBe(3);
    expect(all.flatMap((item) => metadataFailures(item, target))).toEqual([]);
  });

  it("[ingest.concurrent] isolates concurrent imports", async () => {
    const half = Math.ceil(fixtures.length / 2);
    const left = fixtures.slice(0, half);
    const right = fixtures.slice(half);
    probeGate = (path) =>
      new Promise((ok) =>
        setTimeout(ok, (fixtures.findIndex((f) => f.path === path) * 7) % 11),
      );
    const [a, b] = await Promise.all([
      onDropMedia({
        paths: left.map((f) => f.path),
        viewportRef: viewportRef(),
      }),
      onDropMedia({
        paths: right.map((f) => f.path),
        viewportRef: viewportRef(),
      }),
    ]);
    expect(a.map((item) => item.filePath)).toEqual(left.map((f) => f.path));
    expect(b.map((item) => item.filePath)).toEqual(right.map((f) => f.path));
    const failures = [
      ...left.flatMap((fixture, index) => metadataFailures(a[index], fixture)),
      ...right.flatMap((fixture, index) => metadataFailures(b[index], fixture)),
    ];
    expect(failures).toEqual([]);
  });

  it("[ingest.cancel-unmount] discards an import that completes after the canvas unmounts", async () => {
    const gate = deferred();
    probeGate = () => gate.promise;
    const view = renderCanvas();
    await dropFiles(decodable.slice(0, 3).map((fixture) => fixture.path));
    view.unmount();
    gate.resolve();
    await act(async () => {
      await new Promise((ok) => setTimeout(ok, 10));
    });
    expect(useCanvasSessionStore.getState().items).toEqual([]);
  });

  it("[ingest.import-delete-cycles] leaves no residue across repeated import/delete cycles", async () => {
    const subset = decodable.slice(0, 4);
    const seenIds = new Set<string>();
    const durations: number[] = [];
    for (let cycle = 0; cycle < 25; cycle += 1) {
      const started = performance.now();
      const items = await onDropMedia({
        paths: subset.map((f) => f.path),
        viewportRef: viewportRef(),
      });
      useCanvasSessionStore
        .getState()
        .setItems((previous) => [...previous, ...items]);
      durations.push(performance.now() - started);
      for (const item of items) {
        expect(seenIds.has(item.id)).toBe(false);
        seenIds.add(item.id);
      }
      expect(useCanvasSessionStore.getState().items).toHaveLength(
        subset.length,
      );
      useCanvasSessionStore.getState().setItems([]);
      expect(useCanvasSessionStore.getState().items).toEqual([]);
    }
    metrics.push({
      key: "frontend.import.cycle_ms",
      unit: "ms",
      workload: `${subset.length} assets per cycle, 25 cycles`,
      samples: durations,
    });
  });

  it("[ingest.missing-file] reports files that disappeared before import and keeps a usable item", async () => {
    const missing = `${fixtureSet.corpusRoot}/vanished-before-probe.mp4`;
    const items = await onDropMedia({
      paths: [missing],
      viewportRef: viewportRef(),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      filePath: missing,
      sourceWidth: 1280,
      sourceHeight: 720,
    });
    expect(toast.error).toHaveBeenCalledWith(
      "Video metadata probe failed",
      expect.anything(),
    );
  });
});

describe("preview ownership", () => {
  it("[preview.stale-result] never applies a thumbnail to an item whose source changed or was removed", async () => {
    const [first, second] = decodable;
    if (!first || !second) throw new Error("need two decodable fixtures");
    const pending = new Map<string, (value: string) => void>();
    invoke.mockImplementation(
      (command: string, args?: Record<string, unknown>) =>
        command === "request_decode"
          ? new Promise((ok) =>
              pending.set(`${args?.itemId}:${args?.path}`, ok),
            )
          : Promise.resolve(null),
    );
    const item: MediaItem = {
      id: "preview-1",
      type: "video",
      filePath: first.path,
      url: "",
      x: 0,
      y: 0,
      width: 320,
      height: 180,
    };
    useCanvasSessionStore.getState().setItems([item]);
    const { result } = renderHook(() =>
      useThumbnailQueue(useCanvasSessionStore.getState().setItems),
    );
    act(() => result.current.requestThumbnail(item));
    // The user swaps the source of the same canvas node before decode finishes.
    useCanvasSessionStore
      .getState()
      .setItems([{ ...item, filePath: second.path }]);
    await act(async () => {
      pending.get(`preview-1:${first.path}`)?.("/cache/first.jpg");
    });
    expect(
      useCanvasSessionStore.getState().items[0]?.thumbnailPath,
    ).toBeUndefined();

    act(() =>
      result.current.requestThumbnail({ ...item, filePath: second.path }),
    );
    useCanvasSessionStore.getState().setItems([]);
    await act(async () => {
      pending.get(`preview-1:${second.path}`)?.("/cache/second.jpg");
    });
    expect(useCanvasSessionStore.getState().items).toEqual([]);
  });

  it("[preview.ownership] gives every node only its own thumbnail when decodes resolve shuffled", async () => {
    const pending: Array<{ resolve: (value: string) => void; path: string }> =
      [];
    invoke.mockImplementation(
      (command: string, args?: Record<string, unknown>) =>
        command === "request_decode"
          ? new Promise((ok) =>
              pending.push({ resolve: ok, path: String(args?.path) }),
            )
          : Promise.resolve(null),
    );
    const items: MediaItem[] = fixtures.map((fixture, index) => ({
      id: `node-${index}`,
      type: "video",
      filePath: fixture.path,
      url: "",
      x: index * 10,
      y: 0,
      width: 320,
      height: 180,
    }));
    useCanvasSessionStore.getState().setItems(items);
    const { result } = renderHook(() =>
      useThumbnailQueue(useCanvasSessionStore.getState().setItems),
    );
    act(() => {
      for (const item of items) result.current.requestThumbnail(item);
    });
    expect(pending).toHaveLength(items.length);
    const rng = createRng(SEED);
    const order = pending.map((_, index) => index).sort(() => rng.next() - 0.5);
    await act(async () => {
      for (const index of order) {
        const entry = pending[index];
        entry?.resolve(`/cache/${encodeURIComponent(entry.path)}.jpg`);
      }
    });
    for (const item of useCanvasSessionStore.getState().items) {
      expect(item.thumbnailPath).toBe(
        `/cache/${encodeURIComponent(item.filePath)}.jpg`,
      );
    }
  });
});

const applyOperation = async (
  operation: ReturnType<typeof generateWorkload>[number],
  selection: Set<string>,
  saved: { snapshot: unknown[] | null; viewport: Viewport | null },
) => {
  const store = useCanvasSessionStore.getState();
  const items = store.items;
  const at = (slot: number) =>
    items.length === 0 ? undefined : items[slot % items.length];
  switch (operation.kind) {
    case "pan":
      store.setViewport((viewport) =>
        applyPanDelta(viewport, operation.dx, operation.dy),
      );
      break;
    case "zoom":
      store.setViewport((viewport) =>
        applyZoomAtPoint({
          viewport,
          deltaY: operation.deltaY,
          mouseX: operation.mouseX,
          mouseY: operation.mouseY,
        }),
      );
      break;
    case "select": {
      const item = at(operation.slot);
      if (item) selection.add(item.id);
      break;
    }
    case "deselect":
      selection.clear();
      break;
    case "move": {
      const item = at(operation.slot);
      if (!item) break;
      const interaction = useInteractionStore.getState();
      interaction.startDragging(item.id);
      store.setItems((previous) =>
        previous.map((entry) =>
          entry.id === item.id || selection.has(entry.id)
            ? { ...entry, x: entry.x + operation.dx, y: entry.y + operation.dy }
            : entry,
        ),
      );
      interaction.clearItemInteraction();
      break;
    }
    case "resize": {
      const item = at(operation.slot);
      if (!item) break;
      store.setItems((previous) =>
        previous.map((entry) =>
          entry.id === item.id
            ? {
                ...entry,
                width: Math.max(100, entry.width * operation.scale),
                height:
                  Math.max(100, entry.width * operation.scale) *
                  (entry.height / entry.width),
              }
            : entry,
        ),
      );
      break;
    }
    case "reorder": {
      const item = at(operation.slot);
      if (item) store.setItems((previous) => pushItemToTop(previous, item.id));
      break;
    }
    case "scrub": {
      const item = at(operation.slot);
      const time = clampVideoTime(
        operation.fraction * (item?.duration ?? 0),
        item?.duration ?? 0,
      );
      if (item && (time < 0 || time > (item.duration ?? 0))) {
        throw new Error(`scrub produced ${time} outside [0, ${item.duration}]`);
      }
      break;
    }
    case "import": {
      const paths = operation.assetSlots.map(
        (slot) => (fixtures[slot % fixtures.length] as CorpusFixture).path,
      );
      const imported = await onDropMedia({
        paths,
        viewportRef: viewportRef(store.viewport),
      });
      useCanvasSessionStore
        .getState()
        .setItems((previous) => [...previous, ...imported]);
      break;
    }
    case "remove": {
      const item = at(operation.slot);
      if (!item) break;
      selection.delete(item.id);
      store.setItems((previous) =>
        previous.filter((entry) => entry.id !== item.id),
      );
      break;
    }
    case "save": {
      if (!store.saveFilePath)
        store.replaceSession({ saveFilePath: WORKSPACE });
      const current = useCanvasSessionStore.getState();
      const writesBefore = saveWrites;
      await current.saveSessionToFile();
      const after = useCanvasSessionStore.getState();
      // Save is a no-op when the session is clean. Viewport-only changes do not
      // dirty the session (by design), so only a real write moves the snapshot.
      if (saveWrites > writesBefore) {
        saved.snapshot = normalizeItemsForComparison(after.items);
        saved.viewport = after.viewport;
      } else if (after.isDirty) {
        throw new Error("dirty session was not written by save");
      }
      break;
    }
    case "reload": {
      if (!saved.snapshot) break;
      vi.mocked(open).mockResolvedValue(WORKSPACE);
      const loaded = await useCanvasSessionStore
        .getState()
        .loadSessionFromFile();
      if (!loaded) throw new Error("reload of saved workspace failed");
      const state = useCanvasSessionStore.getState();
      const diff = diffNormalizedItems(
        saved.snapshot,
        normalizeItemsForComparison(state.items),
      );
      if (diff.length > 0)
        throw new Error(
          `reload not equivalent: ${diff.slice(0, 3).join("; ")}`,
        );
      if (JSON.stringify(state.viewport) !== JSON.stringify(saved.viewport)) {
        throw new Error(
          `viewport ${JSON.stringify(state.viewport)} != ${JSON.stringify(saved.viewport)}`,
        );
      }
      if (state.isDirty) throw new Error("freshly loaded workspace is dirty");
      for (const id of [...selection])
        if (!state.items.some((item) => item.id === id)) selection.delete(id);
      break;
    }
  }
};

describe("seeded canvas workload", () => {
  it(`[state.seeded-workload] keeps state invariants across ${OPERATIONS} operations (seed ${SEED})`, async () => {
    const operations = generateWorkload(createRng(SEED), OPERATIONS);
    const selection = new Set<string>();
    const saved: { snapshot: unknown[] | null; viewport: Viewport | null } = {
      snapshot: null,
      viewport: null,
    };
    const knownPaths = new Set([...fixtures.map((fixture) => fixture.path)]);
    const latencies: number[] = [];
    const counts = new Map<string, number>();
    for (const [index, operation] of operations.entries()) {
      const started = performance.now();
      try {
        await applyOperation(operation, selection, saved);
      } catch (error) {
        throw new Error(
          `seed ${SEED} op #${index} ${describeOperation(operation)} failed: ${String(error)}\nreproduce: SIGMA_MEDIA_SEED=${SEED} SIGMA_MEDIA_OPS=${index + 1}`,
        );
      }
      latencies.push(performance.now() - started);
      counts.set(operation.kind, (counts.get(operation.kind) ?? 0) + 1);
      const state = useCanvasSessionStore.getState();
      const failures = checkCanvasInvariants(state.items, state.viewport, {
        knownPaths,
      });
      for (const id of selection) {
        if (!state.items.some((item) => item.id === id))
          failures.push(`selection holds removed ${id}`);
      }
      if (useInteractionStore.getState().mode !== "idle")
        failures.push("interaction left non-idle");
      if (failures.length > 0) {
        throw new Error(
          `seed ${SEED} op #${index} ${describeOperation(operation)} broke invariants: ${failures.slice(0, 5).join("; ")}\nreproduce: SIGMA_MEDIA_SEED=${SEED} SIGMA_MEDIA_OPS=${index + 1}`,
        );
      }
    }
    // The workload must actually exercise persistence to count as a gate.
    expect(counts.get("save") ?? 0).toBeGreaterThan(0);
    expect(saved.snapshot).not.toBeNull();
    metrics.push({
      key: "frontend.workload.op_ms",
      unit: "ms",
      workload: `${OPERATIONS} seeded ops, seed ${SEED}`,
      samples: latencies,
    });
  });

  it("[state.large-extents] round-trips extreme coordinates and zoom clamps exactly", async () => {
    const [fixture] = decodable;
    if (!fixture) throw new Error("no fixture");
    const items: MediaItem[] = [-1e9, -12345.678, 0, 9.999e8].map(
      (x, index) => ({
        id: `extent-${index}`,
        type: "video",
        filePath: fixture.path,
        url: "",
        x,
        y: -x / 3,
        width: 100 + index,
        height: 56.25 + index,
      }),
    );
    const store = useCanvasSessionStore.getState();
    store.replaceSession({
      items,
      saveFilePath: WORKSPACE,
      lastSavedSignature: null,
    });
    for (const deltaY of [5000, 5000, -5000, -5000, -5000]) {
      store.setViewport((viewport) =>
        applyZoomAtPoint({ viewport, deltaY, mouseX: 10, mouseY: 10 }),
      );
    }
    const state = useCanvasSessionStore.getState();
    expect(checkCanvasInvariants(state.items, state.viewport)).toEqual([]);
    await state.saveSessionToFile();
    const expected = normalizeItemsForComparison(
      useCanvasSessionStore.getState().items,
    );
    resetSession();
    vi.mocked(open).mockResolvedValue(WORKSPACE);
    expect(await useCanvasSessionStore.getState().loadSessionFromFile()).toBe(
      true,
    );
    expect(
      diffNormalizedItems(
        expected,
        normalizeItemsForComparison(useCanvasSessionStore.getState().items),
      ),
    ).toEqual([]);
    expect(useCanvasSessionStore.getState().viewport).toEqual(state.viewport);
  });
});

describe("workspace persistence", () => {
  // Fault fixtures live outside the project tree; paths are stored relative to
  // the workspace either way, but relocation is only meaningful for assets that
  // move with the project.
  const projectFixtures = fixtures.filter(
    (fixture) => fixture.kind === "corpus",
  );
  const importAll = async () => {
    const items = await onDropMedia({
      paths: projectFixtures.map((f) => f.path),
      viewportRef: viewportRef(),
    });
    useCanvasSessionStore.getState().replaceSession({
      items,
      saveFilePath: WORKSPACE,
      lastSavedSignature: null,
    });
    return items;
  };

  it("[persist.roundtrip] reloads the entire corpus workspace equivalently with project-relative paths", async () => {
    await importAll();
    // Repeated saves (each after a real edit) give the persistence budget enough samples.
    const saveMs: number[] = [];
    for (let sample = 0; sample < 7; sample += 1) {
      useCanvasSessionStore
        .getState()
        .setItems((items) =>
          items.map((item, index) =>
            index === 0 ? { ...item, x: item.x + 1 } : item,
          ),
        );
      const started = performance.now();
      await useCanvasSessionStore.getState().saveSessionToFile();
      saveMs.push(performance.now() - started);
    }
    const stored = JSON.parse(memfs.get(WORKSPACE) ?? "null") as {
      items: Array<{ filePath: string }>;
    };
    expect(stored.items).toHaveLength(projectFixtures.length);
    for (const item of stored.items) {
      expect(item.filePath.startsWith("/")).toBe(false);
      expect(item.filePath).not.toMatch(/^[A-Za-z]:/);
    }
    const expected = normalizeItemsForComparison(
      useCanvasSessionStore.getState().items,
    );
    const loadMs: number[] = [];
    vi.mocked(open).mockResolvedValue(WORKSPACE);
    for (let sample = 0; sample < 7; sample += 1) {
      resetSession();
      const loadStarted = performance.now();
      expect(await useCanvasSessionStore.getState().loadSessionFromFile()).toBe(
        true,
      );
      loadMs.push(performance.now() - loadStarted);
      expect(
        diffNormalizedItems(
          expected,
          normalizeItemsForComparison(useCanvasSessionStore.getState().items),
        ),
      ).toEqual([]);
    }
    metrics.push(
      {
        key: "frontend.persist.save_ms",
        unit: "ms",
        workload: `${projectFixtures.length} assets`,
        samples: saveMs,
      },
      {
        key: "frontend.persist.load_ms",
        unit: "ms",
        workload: `${projectFixtures.length} assets`,
        samples: loadMs,
      },
      {
        key: "frontend.persist.file_bytes",
        unit: "bytes",
        workload: `${projectFixtures.length} assets`,
        samples: [memfs.get(WORKSPACE)?.length ?? 0],
      },
    );
  });

  it("[persist.deterministic] produces byte-identical files for repeated saves of unchanged state", async () => {
    const items = await importAll();
    const viewport = { x: 12.5, y: -3, zoom: 0.75 };
    const first = getCanvasConfigData(items, viewport, WORKSPACE);
    for (let index = 0; index < 20; index += 1) {
      expect(getCanvasConfigData(items, viewport, WORKSPACE)).toBe(first);
    }
  });

  it("[persist.relocated] resolves relative asset references against a relocated workspace", async () => {
    await importAll();
    await useCanvasSessionStore.getState().saveSessionToFile();
    const moved = "/Volumes/archive/moved-project/sigma-media-workspace.json";
    memfs.set(moved, memfs.get(WORKSPACE) ?? "");
    resetSession();
    vi.mocked(open).mockResolvedValue(moved);
    expect(await useCanvasSessionStore.getState().loadSessionFromFile()).toBe(
      true,
    );
    const items = useCanvasSessionStore.getState().items;
    expect(items).toHaveLength(projectFixtures.length);
    const oldProject = WORKSPACE.replace(/\/[^/]+$/, "");
    items.forEach((item, index) => {
      const fixture = projectFixtures[index] as CorpusFixture;
      expect(item.filePath).toBe(
        `/Volumes/archive/moved-project${fixture.path.slice(oldProject.length)}`,
      );
    });
  });

  it("[persist.save-failure] keeps the session dirty and the last good file when a save is denied", async () => {
    await importAll();
    await useCanvasSessionStore.getState().saveSessionToFile();
    const lastGood = memfs.get(WORKSPACE);
    useCanvasSessionStore.getState().setItems((items) => items.slice(1));
    saveFailure = "Canvas destination is outside the application file scope";
    await useCanvasSessionStore.getState().saveSessionToFile();
    expect(memfs.get(WORKSPACE)).toBe(lastGood);
    expect(useCanvasSessionStore.getState().isDirty).toBe(true);
    expect(toast.error).toHaveBeenCalledWith("Save failed", expect.anything());
  });

  it("[persist.save-during-import] saves the committed state while an import is still probing", async () => {
    const [first, ...rest] = decodable;
    if (!first) throw new Error("no fixture");
    useCanvasSessionStore.getState().replaceSession({
      items: await onDropMedia({
        paths: [first.path],
        viewportRef: viewportRef(),
      }),
      saveFilePath: WORKSPACE,
      lastSavedSignature: null,
    });
    const gate = deferred();
    probeGate = () => gate.promise;
    const importing = onDropMedia({
      paths: rest.slice(0, 3).map((f) => f.path),
      viewportRef: viewportRef(),
    });
    await useCanvasSessionStore.getState().saveSessionToFile();
    gate.resolve();
    const imported = await importing;
    useCanvasSessionStore
      .getState()
      .setItems((items) => [...items, ...imported]);
    const stored = JSON.parse(memfs.get(WORKSPACE) ?? "null") as {
      items: unknown[];
    };
    expect(stored.items).toHaveLength(1);
    expect(useCanvasSessionStore.getState().isDirty).toBe(true);
  });
});

describe("state scaling (measurement only)", () => {
  it("[perf.store-scaling] records mutation and serialization cost by node count", () => {
    const base = decodable[0] ?? fixtures[0];
    if (!base) throw new Error("no fixture");
    for (const count of [1, 10, 25, 50, 100, 250]) {
      const items: MediaItem[] = Array.from({ length: count }, (_, index) => {
        const fixture = fixtures[index % fixtures.length] as CorpusFixture;
        return {
          id: `scale-${index}`,
          type: "video",
          filePath: fixture.path,
          url: "",
          x: (index % 20) * 1400,
          y: Math.floor(index / 20) * 900,
          width: 1280,
          height: 720,
          duration: 10,
          frameRate: 24,
          fileSize: 1e7,
        };
      });
      useCanvasSessionStore.getState().replaceSession({
        items,
        saveFilePath: null,
        lastSavedSignature: null,
      });
      const mutation: number[] = [];
      for (let sample = 0; sample < 40; sample += 1) {
        const started = performance.now();
        useCanvasSessionStore
          .getState()
          .setItems((previous) =>
            previous.map((item, index) =>
              index === sample % count ? { ...item, x: item.x + 1 } : item,
            ),
          );
        mutation.push(performance.now() - started);
      }
      const serialize: number[] = [];
      let bytes = 0;
      for (let sample = 0; sample < 20; sample += 1) {
        const started = performance.now();
        bytes = getCanvasConfigData(
          useCanvasSessionStore.getState().items,
          { x: 0, y: 0, zoom: 1 },
          WORKSPACE,
        ).length;
        serialize.push(performance.now() - started);
      }
      expect(useCanvasSessionStore.getState().items).toHaveLength(count);
      metrics.push(
        {
          key: `frontend.state.move_one_ms@${count}`,
          unit: "ms",
          workload: `${count} nodes`,
          samples: mutation,
        },
        {
          key: `frontend.persist.serialize_ms@${count}`,
          unit: "ms",
          workload: `${count} nodes`,
          samples: serialize,
        },
        {
          key: `frontend.persist.serialized_bytes@${count}`,
          unit: "bytes",
          workload: `${count} nodes`,
          samples: [bytes],
        },
      );
    }
  });
});
