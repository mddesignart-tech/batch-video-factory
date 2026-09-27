import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "@/lib/paths";
import { buildAssetReuseKey } from "@/domain/asset-reuse-key";
import { fileSha256OrNull } from "@/services/asset-content";
import { ffmpeg } from "./ffmpeg";

/**
 * LOCAL_MOTION / scene-normalise reuse (QĐ-112). A scene segment is FFmpeg
 * work at $0 - this saves COMPUTE, never money, and is reported as such.
 *
 * The key is the exact FFmpeg argument list with every input file replaced by
 * its content hash and the output by a placeholder: same picture/clip, same
 * audio, same duration, size, fps, motion (zoompan) and codec settings = same
 * segment. Anything that changes the output changes an argument, so it changes
 * the key. A missing or empty cached file is simply rendered again, locally.
 */

export const SEGMENT_CACHE_DIR = path.join(DATA_ROOT, "cache", "segments");

export function segmentKey(args: string[], inputs: string[], output: string): string {
  const named = new Set(inputs);
  const hashed = args.map((a) => {
    if (a === output) return "<out>";
    if (named.has(a)) return `sha256:${fileSha256OrNull(a) ?? "missing"}`;
    return a;
  });
  return buildAssetReuseKey({ kind: "local_motion", args: hashed });
}

export interface SegmentResult {
  reused: boolean;
  key: string;
}

/** Render one normalised segment, or copy it from the cache when identical work was done before. */
export async function renderSegmentCached(opts: {
  args: string[];
  inputs: string[];
  output: string;
  cwd?: string;
}): Promise<SegmentResult> {
  const key = segmentKey(opts.args, opts.inputs, opts.output);
  // An input that cannot be hashed cannot be identified: never serve (or
  // store) a cached segment for it - render it, as before.
  if (opts.inputs.some((f) => fileSha256OrNull(f) === null)) {
    await ffmpeg(opts.args, opts.cwd ? { cwd: opts.cwd } : {});
    return { reused: false, key };
  }
  const cached = path.join(SEGMENT_CACHE_DIR, `${key.split(":").pop()}.mp4`);
  const absoluteOut = opts.cwd ? path.resolve(opts.cwd, opts.output) : opts.output;
  if (fs.existsSync(cached) && fs.statSync(cached).size > 0) {
    fs.copyFileSync(cached, absoluteOut);
    return { reused: true, key };
  }
  await ffmpeg(opts.args, opts.cwd ? { cwd: opts.cwd } : {});
  try {
    fs.mkdirSync(SEGMENT_CACHE_DIR, { recursive: true });
    const tmp = `${cached}.${process.pid}.tmp`;
    fs.copyFileSync(absoluteOut, tmp);
    fs.renameSync(tmp, cached);
  } catch {
    // A cache that cannot be written only costs the next render some time.
  }
  return { reused: false, key };
}
