// Seeded, platform-independent PRNG (mulberry32). Every stress workload takes
// an explicit seed so a failing sequence can be replayed exactly.

export type Rng = {
  readonly seed: number;
  next: () => number;
  int: (minInclusive: number, maxExclusive: number) => number;
  pick: <T>(values: readonly T[]) => T;
  chance: (probability: number) => boolean;
};

export const parseSeed = (value: string | number | undefined, fallback = 1) => {
  if (value === undefined || value === "") return fallback >>> 0;
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric)) return Math.trunc(numeric) >>> 0;
  // Hash arbitrary strings (FNV-1a) so seeds like "nightly-2026-11-08" work.
  let hash = 0x811c9dc5;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

export const createRng = (seed: number): Rng => {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed: seed >>> 0,
    next,
    int: (minInclusive, maxExclusive) => {
      if (maxExclusive <= minInclusive) return minInclusive;
      return minInclusive + Math.floor(next() * (maxExclusive - minInclusive));
    },
    pick: (values) => {
      if (values.length === 0) throw new Error("Cannot pick from empty list");
      return values[
        Math.floor(next() * values.length)
      ] as (typeof values)[number];
    },
    chance: (probability) => next() < probability,
  };
};
