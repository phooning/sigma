// Builds or verifies the deterministic media corpus manifest.
//
//   node scripts/media/build-manifest.ts          # (re)write fixtures/media-corpus.manifest.json
//   node scripts/media/build-manifest.ts --check  # fail if the corpus no longer matches
//
// The manifest contains no absolute paths or timestamps; assets are ordered by
// NFC code points so the output is independent of filesystem enumeration.
import { writeFileSync } from "node:fs";
import {
  classifyAsset,
  computeCoverage,
  selectRepresentativeSubset,
} from "../../src/lib/media-corpus/classify.ts";
import {
  type CorpusAsset,
  type CorpusManifest,
  MANIFEST_SCHEMA,
} from "../../src/lib/media-corpus/types.ts";
import {
  CORPUS_ROOT,
  CORPUS_ROOT_RELATIVE,
  contentHashOf,
  ffmpegVersion,
  listCorpusFiles,
  MANIFEST_PATH,
  probeAsset,
  readManifest,
  sha256File,
} from "./corpus.ts";

export const buildManifest = async ({ decodeChecks = true } = {}) => {
  const files = await listCorpusFiles(CORPUS_ROOT);
  const ffprobe = ffmpegVersion("ffprobe") ? "ffprobe" : null;
  const ffmpeg = ffmpegVersion("ffmpeg") ? "ffmpeg" : null;
  const assets: CorpusAsset[] = [];
  const seenHashes = new Map<string, string>();
  for (const file of files) {
    let sha256: string;
    try {
      sha256 = await sha256File(file.absolutePath);
    } catch (error) {
      const unreadable = {
        relativePath: file.relativePath,
        sizeBytes: 0,
        sha256: "",
        extension: (file.relativePath.split(".").pop() ?? "").toLowerCase(),
        container: null,
        durationSec: null,
        bitRate: null,
        streamCount: 0,
        video: null,
        audio: [],
        other: [],
        decode: {
          firstFrame: "not-run",
          seekMiddle: "not-run",
          seekNearEnd: "not-run",
          errors: [],
        },
        status: "unreadable",
        issues: [String(error)],
      } satisfies Omit<CorpusAsset, "groups" | "id">;
      assets.push({
        ...unreadable,
        id: `unreadable-${assets.length}`,
        groups: classifyAsset({ ...unreadable, id: "" }),
      });
      continue;
    }
    const probed = await probeAsset(file.absolutePath, file.relativePath, {
      ffprobe,
      ffmpeg,
      decodeChecks,
      sha256,
    });
    const baseId = `clip-${sha256.slice(0, 12)}`;
    const duplicateOf = seenHashes.get(sha256);
    let id = baseId;
    if (duplicateOf) {
      id = `${baseId}-dup${assets.filter((asset) => asset.sha256 === sha256).length}`;
      probed.issues.push(`identical content to ${duplicateOf}`);
    } else {
      seenHashes.set(sha256, file.relativePath);
    }
    const withId = { ...probed, id };
    assets.push({ ...withId, groups: classifyAsset(withId) });
    process.stderr.write(
      `  ${probed.status.padEnd(15)} ${file.relativePath}\n`,
    );
  }
  const manifest: CorpusManifest = {
    schema: MANIFEST_SCHEMA,
    corpusRoot: CORPUS_ROOT_RELATIVE,
    tool: { ffprobe: ffmpegVersion("ffprobe") },
    contentHash: contentHashOf(assets),
    assetCount: assets.length,
    totalBytes: assets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
    assets,
    coverage: computeCoverage(assets),
    subsets: { smoke: selectRepresentativeSubset(assets) },
  };
  return manifest;
};

export const serializeManifest = (manifest: CorpusManifest) =>
  `${JSON.stringify(manifest, null, 2)}\n`;

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const files = await listCorpusFiles(CORPUS_ROOT);
  if (files.length === 0) {
    console.error(
      `No media found under ${CORPUS_ROOT_RELATIVE}/. The full corpus is not committed; see docs/media-benchmarking.md.`,
    );
    process.exit(check ? 1 : 2);
  }
  console.error(
    `Probing ${files.length} files under ${CORPUS_ROOT_RELATIVE}/ …`,
  );
  const manifest = await buildManifest();
  const serialized = serializeManifest(manifest);
  if (check) {
    const existing = readManifest();
    if (!existing) {
      console.error(`Missing ${MANIFEST_PATH}`);
      process.exit(1);
    }
    if (serializeManifest(existing) !== serialized) {
      console.error(
        "Corpus manifest is out of date (content, metadata or tool output changed).",
      );
      console.error(
        `committed contentHash ${existing.contentHash}\ncurrent   contentHash ${manifest.contentHash}`,
      );
      process.exit(1);
    }
    console.error(
      `Manifest matches (${manifest.assetCount} assets, contentHash ${manifest.contentHash.slice(0, 16)}).`,
    );
  } else {
    writeFileSync(MANIFEST_PATH, serialized);
    console.error(
      `Wrote ${MANIFEST_PATH} (${manifest.assetCount} assets, contentHash ${manifest.contentHash.slice(0, 16)}).`,
    );
    console.error(`Smoke subset: ${manifest.subsets.smoke.join(", ")}`);
    console.error(`Coverage gaps: ${manifest.coverage.gaps.join(", ")}`);
  }
}
