import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { DATA_ROOT, toAbsolute, toRelative } from "@/lib/paths";
import { slugify } from "@/lib/utils";
import { ffmpeg, ffprobe, probeDuration } from "@/media/ffmpeg";
import { fileSha256, fileSha256OrNull } from "./asset-content";

/**
 * A finished video, laid out for a person rather than for the pipeline:
 *
 *   data/output/<video-slug>/
 *     final.mp4       copy of the rendered MP4
 *     thumbnail.jpg   one frame, local FFmpeg
 *     subtitles.srt   copy, when the project has one
 *     metadata.json   title, description, duration, aspect, cost, models, scenes
 *
 * Everything here is local: copying, FFmpeg, and reading the ledger. No API.
 * The project's own files stay where they are - this is an export, and can be
 * redone at any time without touching what was bought.
 */

export const OUTPUT_ROOT = path.join(DATA_ROOT, "output");

export function outputDirFor(project: { id: string; title: string }): string {
  const slug = slugify(project.title).slice(0, 60) || "video";
  return path.join(OUTPUT_ROOT, `${slug}-${project.id.slice(0, 8)}`);
}

export interface OutputMetadata {
  title: string;
  description: string;
  duration: number;
  aspectRatio: string;
  width: number;
  height: number;
  totalActualCost: number;
  providers: string[];
  sceneCount: number;
  createdAt: string;
  projectId: string;
  batchId: string | null;
}

/** Export (or re-export) a completed project. Returns the folder. */
export async function exportProjectOutput(projectId: string): Promise<string> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { idiom: true, scenes: { where: { skipped: false } } },
  });
  if (!project.finalVideoPath) throw new Error("Dự án chưa có MP4 cuối.");
  const mp4 = toAbsolute(project.finalVideoPath);
  if (!fs.existsSync(mp4)) throw new Error(`Không thấy MP4 cuối: ${project.finalVideoPath}`);

  const dir = outputDirFor(project);
  fs.mkdirSync(dir, { recursive: true });
  // Copy only when the export's MP4 is not already exactly this one.
  const copy = path.join(dir, "final.mp4");
  if (fileSha256OrNull(copy) !== fileSha256(mp4)) fs.copyFileSync(mp4, copy);
  if (project.subtitlePath && fs.existsSync(toAbsolute(project.subtitlePath))) {
    fs.copyFileSync(toAbsolute(project.subtitlePath), path.join(dir, "subtitles.srt"));
  }

  const duration = await probeDuration(mp4);
  await ensureThumbnail({ source: mp4, output: path.join(dir, "thumbnail.jpg"), duration });
  const { stdout } = await ffprobe([
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x", mp4,
  ]);
  const [width, height] = stdout.trim().split("x").map(Number);

  const [spent, jobs] = await Promise.all([
    prisma.costEntry.aggregate({ where: { projectId, estimated: false }, _sum: { amount: true } }),
    prisma.providerJob.findMany({
      where: { projectId, status: "completed" },
      select: { provider: true, model: true },
      distinct: ["provider", "model"],
    }),
  ]);
  const providers = jobs.map((j) => `${j.provider}/${j.model}`);
  if (project.scenes.some((s) => s.motionSource === "LOCAL_MOTION")) providers.push("ffmpeg/local-motion");
  if (project.scenes.some((s) => s.imageSource === "IMPORTED")) providers.push("import/user-supplied-images");

  const metadata: OutputMetadata = {
    title: project.title,
    description: [project.idiom.meaning, project.idiom.exampleSentence].filter(Boolean).join(" — "),
    duration: Math.round(duration * 1000) / 1000,
    aspectRatio: project.aspectRatio,
    width: width ?? 0,
    height: height ?? 0,
    totalActualCost: Math.round((spent._sum.amount ?? 0) * 1e6) / 1e6,
    providers: [...new Set(providers)].sort(),
    sceneCount: project.scenes.length,
    createdAt: new Date().toISOString(),
    projectId: project.id,
    batchId: project.batchId,
  };
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
  return dir;
}

/**
 * THUMBNAIL REUSE (QĐ-113). A thumbnail is one local FFmpeg frame, keyed by:
 *   the SOURCE's content hash + the frame position + the scale/crop filter +
 *   THUMBNAIL_VERSION (bump when the way a thumbnail is drawn changes).
 * The key and the thumbnail's own hash are kept beside it (thumbnail.json).
 *
 *   same key + thumbnail present + its hash matches  -> REUSE, nothing runs
 *   thumbnail missing / corrupt (hash mismatch)      -> drawn again, local, $0
 *   source content changed                           -> new key, drawn again
 *
 * Never an image API: FFmpeg on this machine, deterministic for the same input.
 */
export const THUMBNAIL_VERSION = "t1";
const THUMBNAIL_FILTER = "scale=540:-2";

export function thumbnailKey(sourceSha256: string, atSec: number): string {
  return `thumb:${THUMBNAIL_VERSION}:${sourceSha256}:${atSec.toFixed(3)}:${THUMBNAIL_FILTER}`;
}

export async function ensureThumbnail(opts: {
  source: string;
  output: string;
  duration: number;
}): Promise<{ reused: boolean; key: string }> {
  const atSec = Math.min(1, Math.max(0, opts.duration / 2));
  const key = thumbnailKey(fileSha256(opts.source), atSec);
  const sidecar = path.join(path.dirname(opts.output), `${path.parse(opts.output).name}.json`);
  let stored: { key?: string; sha256?: string } = {};
  try {
    stored = JSON.parse(fs.readFileSync(sidecar, "utf8")) as typeof stored;
  } catch {
    stored = {};
  }
  const current = fileSha256OrNull(opts.output);
  if (stored.key === key && current !== null && current === stored.sha256 && fs.statSync(opts.output).size > 0) {
    return { reused: true, key };
  }
  // Written to a temp name first, so a failed FFmpeg never leaves a half file
  // under the real name.
  const temp = `${opts.output}.tmp-${randomUUID()}.jpg`;
  try {
    await ffmpeg([
      "-v", "error", "-y", "-ss", String(atSec), "-i", opts.source,
      "-frames:v", "1", "-vf", THUMBNAIL_FILTER, temp,
    ]);
    fs.renameSync(temp, opts.output);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
  fs.writeFileSync(sidecar, JSON.stringify({ key, sha256: fileSha256(opts.output) }, null, 2) + "\n");
  return { reused: false, key };
}

/**
 * What an export folder is missing, if anything: final.mp4 (or a copy whose size
 * no longer matches the project's MP4), thumbnail.jpg, metadata.json, and
 * subtitles.srt when the project has subtitles. Empty = complete.
 */
export function missingOutputFiles(project: {
  id: string;
  title: string;
  finalVideoPath: string | null;
  subtitlePath: string | null;
}): string[] {
  const dir = outputDirFor(project);
  const missing: string[] = [];
  const copy = path.join(dir, "final.mp4");
  const source = project.finalVideoPath ? toAbsolute(project.finalVideoPath) : null;
  if (
    !fs.existsSync(copy) ||
    (source && fs.existsSync(source) && fs.statSync(copy).size !== fs.statSync(source).size)
  ) {
    missing.push("final.mp4");
  }
  if (!fs.existsSync(path.join(dir, "thumbnail.jpg"))) missing.push("thumbnail.jpg");
  if (!fs.existsSync(path.join(dir, "metadata.json"))) missing.push("metadata.json");
  if (project.subtitlePath && !fs.existsSync(path.join(dir, "subtitles.srt"))) missing.push("subtitles.srt");
  return missing;
}

/** The export folder if it exists, relative to data/ (for the media route). */
export function existingOutputFor(project: { id: string; title: string }): {
  dir: string;
  relative: string;
  metadata: OutputMetadata | null;
} | null {
  const dir = outputDirFor(project);
  if (!fs.existsSync(path.join(dir, "final.mp4"))) return null;
  let metadata: OutputMetadata | null = null;
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8")) as OutputMetadata;
  } catch {
    metadata = null;
  }
  return { dir, relative: toRelative(dir), metadata };
}
