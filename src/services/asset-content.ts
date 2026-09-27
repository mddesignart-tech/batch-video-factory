import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ffprobe } from "@/media/ffmpeg";

/**
 * What a media file CONTAINS (QĐ-112). Identity is the SHA-256 of the bytes -
 * never the name: two files with different names and the same hash are the same
 * content; two files with the same name and different hashes are not.
 *
 * Hashes are memoised per (path, size, mtime), so a file that has not changed
 * is read once per process; a file replaced in place gets a new mtime/size and
 * is hashed again.
 */

const memo = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

export function fileSha256(absolute: string): string {
  const st = fs.statSync(absolute);
  const hit = memo.get(absolute);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sha256;
  const sha256 = createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
  memo.set(absolute, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
  return sha256;
}

/** The hash when the file is there, otherwise null (never throws). */
export function fileSha256OrNull(absolute: string | null | undefined): string | null {
  if (!absolute) return null;
  try {
    return fs.existsSync(absolute) ? fileSha256(absolute) : null;
  } catch {
    return null;
  }
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export interface ContentInfo {
  sha256: string;
  bytes: number;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

/** Hash + size + type, and width/height/duration from ffprobe when it can tell. */
export async function contentInfo(absolute: string): Promise<ContentInfo> {
  const bytes = fs.statSync(absolute).size;
  const info: ContentInfo = {
    sha256: fileSha256(absolute),
    bytes,
    mimeType: mimeFor(absolute),
    width: null,
    height: null,
    durationSec: null,
  };
  try {
    const probe = await ffprobe([
      "-v", "error",
      "-show_entries", "stream=width,height:format=duration",
      "-of", "json",
      absolute,
    ]);
    const parsed = JSON.parse(probe.stdout || "{}") as {
      streams?: { width?: number; height?: number }[];
      format?: { duration?: string };
    };
    const visual = parsed.streams?.find((s) => s.width && s.height);
    info.width = visual?.width ?? null;
    info.height = visual?.height ?? null;
    const d = Number(parsed.format?.duration);
    info.durationSec = Number.isFinite(d) && d > 0 && !info.mimeType.startsWith("image/") ? d : null;
  } catch {
    // Metadata is informative; the hash is what identity rests on.
  }
  return info;
}
