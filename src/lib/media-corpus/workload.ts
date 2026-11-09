import type { Rng } from "./random.ts";

export type CanvasOperation =
  | { kind: "pan"; dx: number; dy: number }
  | { kind: "zoom"; deltaY: number; mouseX: number; mouseY: number }
  | { kind: "select"; slot: number }
  | { kind: "deselect" }
  | { kind: "move"; slot: number; dx: number; dy: number }
  | { kind: "resize"; slot: number; scale: number }
  | { kind: "reorder"; slot: number }
  | { kind: "scrub"; slot: number; fraction: number }
  | { kind: "import"; assetSlots: number[] }
  | { kind: "remove"; slot: number }
  | { kind: "save" }
  | { kind: "reload" };

export type OperationKind = CanvasOperation["kind"];

export const DEFAULT_OPERATION_WEIGHTS: Record<OperationKind, number> = {
  pan: 14,
  zoom: 10,
  select: 10,
  deselect: 3,
  move: 14,
  resize: 8,
  reorder: 5,
  scrub: 10,
  import: 8,
  remove: 6,
  save: 6,
  reload: 6,
};

/**
 * Generates a deterministic operation sequence. Slots are abstract integers
 * resolved modulo the live item / asset count when applied, so the same seed
 * produces the same sequence regardless of corpus size.
 */
export const generateWorkload = (
  rng: Rng,
  count: number,
  weights: Record<OperationKind, number> = DEFAULT_OPERATION_WEIGHTS,
): CanvasOperation[] => {
  const kinds = Object.keys(weights) as OperationKind[];
  const total = kinds.reduce((sum, kind) => sum + weights[kind], 0);
  const pickKind = (): OperationKind => {
    let roll = rng.next() * total;
    for (const kind of kinds) {
      roll -= weights[kind];
      if (roll < 0) return kind;
    }
    return kinds[kinds.length - 1] as OperationKind;
  };
  const slot = () => rng.int(0, 1 << 20);
  const operations: CanvasOperation[] = [];
  for (let index = 0; index < count; index += 1) {
    const kind = pickKind();
    switch (kind) {
      case "pan":
        operations.push({
          kind,
          dx: rng.int(-2000, 2001),
          dy: rng.int(-2000, 2001),
        });
        break;
      case "zoom":
        // Includes extreme wheel deltas to drive zoom into both clamps.
        operations.push({
          kind,
          deltaY: rng.chance(0.1)
            ? rng.pick([-5000, 5000])
            : rng.int(-600, 601),
          mouseX: rng.int(0, 1600),
          mouseY: rng.int(0, 1000),
        });
        break;
      case "select":
      case "reorder":
      case "remove":
        operations.push({ kind, slot: slot() });
        break;
      case "deselect":
      case "save":
      case "reload":
        operations.push({ kind });
        break;
      case "move":
        operations.push({
          kind,
          slot: slot(),
          // Large spatial extents: occasionally fling far across the canvas.
          dx: rng.chance(0.05) ? rng.int(-1e7, 1e7) : rng.int(-800, 801),
          dy: rng.chance(0.05) ? rng.int(-1e7, 1e7) : rng.int(-800, 801),
        });
        break;
      case "resize":
        operations.push({
          kind,
          slot: slot(),
          scale: 0.25 + rng.next() * 3.75,
        });
        break;
      case "scrub":
        // Fractions outside [0, 1] exercise clamping at both ends.
        operations.push({
          kind,
          slot: slot(),
          fraction: -0.1 + rng.next() * 1.2,
        });
        break;
      case "import":
        operations.push({
          kind,
          assetSlots: Array.from({ length: rng.int(1, 5) }, slot),
        });
        break;
    }
  }
  return operations;
};

export const describeOperation = (operation: CanvasOperation) =>
  JSON.stringify(operation);
