// Generates malformed media fixtures in a fresh temp directory. The original
// corpus is only ever read (partial reads for truncation), never modified.
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createRng } from "../../src/lib/media-corpus/random.ts";
import { run } from "./corpus.ts";

export type FaultFixture = {
  id: string;
  path: string;
  relativePath: string;
  kind: "failure";
  /** Whether native probing is expected to succeed. */
  expect: "ok" | "error";
  /** Grant the path to the runtime scope (false = scope-denial check). */
  grant: boolean;
  expected: {
    width: number;
    height: number;
    duration: number | null;
    frameRate: number | null;
    size: number;
  } | null;
  description: string;
};

const copyRange = async (
  source: string,
  destination: string,
  start: number,
  end: number,
) => {
  await pipeline(
    createReadStream(source, { start, end: end - 1 }),
    createWriteStream(destination),
  );
};

export const createFaultFixtures = async ({
  seed,
  donor,
  ffmpeg,
}: {
  seed: number;
  /** A decodable asset whose `moov` atom is at the front (for truncation). */
  donor: {
    path: string;
    width: number;
    height: number;
    duration: number | null;
    frameRate: number | null;
    sizeBytes: number;
  } | null;
  ffmpeg: string | null;
}) => {
  // The desktop test build only grants temp directories with this prefix.
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "sigma-desktop-media-")),
  );
  const fixtures: FaultFixture[] = [];
  const add = (
    fixture: Omit<FaultFixture, "path" | "relativePath" | "kind" | "grant"> & {
      name: string;
      grant?: boolean;
    },
  ) => {
    const { name, grant = true, ...rest } = fixture;
    fixtures.push({
      ...rest,
      path: join(directory, name),
      relativePath: `faults/${name}`,
      kind: "failure",
      grant,
    });
  };
  const rng = createRng(seed);

  const garbage = Buffer.from(
    Array.from({ length: 64 * 1024 }, () => rng.int(0, 256)),
  );
  await writeFile(join(directory, "random-bytes.mp4"), garbage);
  add({
    id: "fault-random-bytes",
    name: "random-bytes.mp4",
    expect: "error",
    expected: null,
    description: "64 KiB of seeded random bytes",
  });

  await writeFile(join(directory, "empty.mp4"), Buffer.alloc(0));
  add({
    id: "fault-empty",
    name: "empty.mp4",
    expect: "error",
    expected: null,
    description: "zero-byte file",
  });

  await writeFile(
    join(directory, "text-as-video.mov"),
    "This is a text file with a video extension.\n",
  );
  add({
    id: "fault-text-as-video",
    name: "text-as-video.mov",
    expect: "error",
    expected: null,
    description: "plain text with a .mov extension",
  });

  await writeFile(join(directory, "vanished.mp4"), "temporary");
  await rm(join(directory, "vanished.mp4"));
  add({
    id: "fault-vanished",
    name: "vanished.mp4",
    expect: "error",
    expected: null,
    description: "granted path deleted before probing",
  });

  await writeFile(join(directory, "ungranted.mp4"), garbage.subarray(0, 1024));
  add({
    id: "fault-ungranted",
    name: "ungranted.mp4",
    grant: false,
    expect: "error",
    expected: null,
    description: "exists but outside the runtime file scope",
  });

  if (donor) {
    const headBytes = Math.min(donor.sizeBytes, 256 * 1024);
    await copyRange(
      donor.path,
      join(directory, "truncated-tail.mp4"),
      0,
      headBytes,
    );
    add({
      id: "fault-truncated-tail",
      name: "truncated-tail.mp4",
      expect: "ok",
      // Container metadata survives; only the media payload is cut off.
      // Duration is not asserted: ffprobe derives it inconsistently for
      // truncated payloads (observed 10.0 s for a 25.44 s source).
      expected: {
        width: donor.width,
        height: donor.height,
        duration: null,
        frameRate: donor.frameRate,
        size: headBytes,
      },
      description: `first ${headBytes} bytes of a corpus clip (moov intact, mdat truncated)`,
    });
    const tailStart = Math.max(0, donor.sizeBytes - 512 * 1024);
    await copyRange(
      donor.path,
      join(directory, "truncated-head.mp4"),
      tailStart,
      donor.sizeBytes,
    );
    add({
      id: "fault-truncated-head",
      name: "truncated-head.mp4",
      expect: "error",
      expected: null,
      description: "last 512 KiB of a corpus clip (no ftyp/moov)",
    });
  }

  if (ffmpeg) {
    const subSecond = join(directory, "sub-second.mp4");
    const generated = await run(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30",
      "-t",
      "0.4",
      "-c:v",
      "mpeg4",
      subSecond,
    ]);
    if (generated.code === 0) {
      add({
        id: "fault-sub-second",
        name: "sub-second.mp4",
        expect: "ok",
        expected: {
          width: 320,
          height: 180,
          duration: null,
          frameRate: 30,
          size: (await stat(subSecond)).size,
        },
        description: "0.4 s clip (no frame at the 1 s thumbnail offset)",
      });
    }
    const audioOnly = join(directory, "audio-only.mp4");
    const audio = await run(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:a",
      "aac",
      audioOnly,
    ]);
    if (audio.code === 0) {
      add({
        id: "fault-audio-only",
        name: "audio-only.mp4",
        expect: "error",
        expected: null,
        description: "AAC audio with no video stream",
      });
    }
    const unreadable = join(directory, "permission-denied.mp4");
    const small = await run(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=64x64:rate=15",
      "-t",
      "1",
      "-c:v",
      "mpeg4",
      unreadable,
    ]);
    if (small.code === 0 && process.getuid?.() !== 0) {
      await chmod(unreadable, 0o000);
      add({
        id: "fault-permission-denied",
        name: "permission-denied.mp4",
        expect: "error",
        expected: null,
        description: "mode 000 (unreadable by the app)",
      });
    }
  }

  const cleanup = async () => {
    for (const fixture of fixtures)
      await chmod(fixture.path, 0o600).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  };
  return { directory, fixtures, cleanup };
};
