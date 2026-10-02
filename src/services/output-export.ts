import { sceneSubtitleText } from "@/domain/scene-subtitles";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { toAbsolute, toRelative } from "@/lib/paths";
import { getSettings } from "@/lib/settings";
import { parseJson } from "@/lib/utils";
import { ffmpeg, probeDuration } from "@/media/ffmpeg";
import { fileSha256, fileSha256OrNull } from "./asset-content";
import { buildSocialMeta, socialMetaSchema, type SocialMetaInput } from "@/domain/social-metadata";
import { exportsSrt } from "@/domain/output-preset";
import { localDate } from "@/domain/output-naming";
import {
  ensureOutputDir,
  OUTPUT_ROOT as LAYOUT_ROOT,
  outputDirFor as layoutDirFor,
  renderSettingsFor,
} from "./output-layout";
import { checkExportFolder, projectHasVoice, type ExportReadyResult } from "./export-ready";

/**
 * A finished video, laid out for a person rather than for the pipeline
 * (V1.2 Phase 6 layout, QĐ-114):
 *
 *   data/output/<batch-slug>/<video-slug>/
 *     final.mp4        copy of the rendered MP4 (rendered with the batch's preset)
 *     thumbnail.jpg    one local frame / the chosen scene / the uploaded picture
 *     subtitles.srt    when the preset exports SRT
 *     metadata.json    title, description, tags, hashtags, duration, cost, models...
 *     storyboard.json  the scenes the video was made from
 *     captions.txt     subtitle text, one cue per line   (preset.textFiles)
 *     description.txt  the description, ready to paste    (preset.textFiles)
 *     .export.json     which files this export promised (for the resume check)
 *
 * Everything here is local: copying, FFmpeg, and reading the ledger. No API,
 * never a regenerated asset. A video exported before Phase 6 keeps its legacy
 * data/output/<title>-<id8>/ folder (output-layout.ts).
 */

export const OUTPUT_ROOT = LAYOUT_ROOT;
export const outputDirFor = layoutDirFor;

export interface OutputMetadata {
  schemaVersion: 2;
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  duration: number;
  /** "1080x1920" */
  resolution: string;
  width: number;
  height: number;
  fps: number;
  language: string;
  aspectRatio: string;
  generatedAt: string;
  /** Kept from V1 for readers of old files: same as generatedAt. */
  createdAt: string;
  /** The storyboard's own video_id (imported videos), else null. */
  storyboardId: string | null;
  importFingerprint: string | null;
  projectId: string;
  batchId: string | null;
  preset: { id: string; name: string; subtitleMode: string };
  scenes: Array<{ sceneNumber: number; duration: number; motion: string; image: string; subtitle: string }>;
  sceneCount: number;
  subtitleFile: string | null;
  thumbnailFile: string | null;
  /** Real money charged for THIS video (CostEntry, estimated=false). Never an authorization. */
  totalActualCost: number;
  /** Media this video used without buying it (IMPORTED + REUSED assets). */
  reusedAssetCount: number;
  /** provider/model pairs that produced media for this video. */
  providers: string[];
}

interface ExportManifest {
  files: string[];
  presetId: string;
}

const MANIFEST = ".export.json";

function readManifest(dir: string): ExportManifest | null {
  return parseJson<ExportManifest | null>(
    (() => {
      try {
        return fs.readFileSync(path.join(dir, MANIFEST), "utf8");
      } catch {
        return null;
      }
    })(),
    null,
  );
}

export interface ThumbnailChoice {
  mode: "DEFAULT" | "SCENE" | "UPLOAD";
  sceneNumber?: number;
  /** data/-relative path of the uploaded picture (UPLOAD). */
  path?: string;
}

export function thumbnailChoiceOf(json: string | null | undefined): ThumbnailChoice {
  const c = parseJson<ThumbnailChoice>(json, { mode: "DEFAULT" });
  if (c.mode === "SCENE" && typeof c.sceneNumber === "number") return { mode: "SCENE", sceneNumber: c.sceneNumber };
  if (c.mode === "UPLOAD" && typeof c.path === "string" && c.path.length > 0) return { mode: "UPLOAD", path: c.path };
  return { mode: "DEFAULT" };
}

/** Plain caption text from an SRT: one cue per line, no numbers or timestamps. */
export function captionsFromSrt(srt: string): string {
  return srt
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0 && !/^\d+$/.test(l.trim()) && !l.includes("-->"))
        .join(" ")
        .replace(/<[^>]+>/g, "")
        .trim(),
    )
    .filter((l) => l.length > 0)
    .join("\n");
}

/** Export (or re-export) a completed project. Returns the folder. */
export async function exportProjectOutput(projectId: string): Promise<string> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      idiom: true,
      batch: { select: { name: true } },
      scenes: { where: { skipped: false }, orderBy: { sceneNumber: "asc" } },
    },
  });
  if (!project.finalVideoPath) throw new Error("Dự án chưa có MP4 cuối.");
  const mp4 = toAbsolute(project.finalVideoPath);
  if (!fs.existsSync(mp4)) throw new Error(`Không thấy MP4 cuối: ${project.finalVideoPath}`);

  const [settings, render] = await Promise.all([getSettings(), renderSettingsFor(projectId)]);
  const preset = render.preset;
  const dir = await ensureOutputDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = ["final.mp4"];

  // Copy only when the export's MP4 is not already exactly this one.
  const copy = path.join(dir, "final.mp4");
  if (fileSha256OrNull(copy) !== fileSha256(mp4)) copyReplacing(mp4, copy);

  const srtSource = project.subtitlePath ? toAbsolute(project.subtitlePath) : null;
  const srtOut = path.join(dir, "subtitles.srt");
  // The renderer writes an SRT even for a silent video; one without a single
  // cue is not a subtitle file worth posting (or promising in metadata.json).
  const wantSrt =
    exportsSrt(preset) &&
    srtSource !== null &&
    fs.existsSync(srtSource) &&
    captionsFromSrt(fs.readFileSync(srtSource, "utf8")).length > 0;
  if (wantSrt) {
    copyReplacing(srtSource, srtOut);
    files.push("subtitles.srt");
  } else if (fs.existsSync(srtOut)) {
    // A preset without SRT: an old copy would contradict it.
    fs.rmSync(srtOut, { force: true });
  }

  const duration = await probeDuration(mp4);
  const target = render.render.target;
  const thumbOut = path.join(dir, "thumbnail.jpg");
  if (preset.thumbnail) {
    await drawThumbnail(project, thumbOut, mp4, duration, target);
    files.push("thumbnail.jpg");
  }

  const [spent, jobs, reused] = await Promise.all([
    prisma.costEntry.aggregate({ where: { projectId, estimated: false }, _sum: { amount: true } }),
    prisma.providerJob.findMany({
      where: { projectId, status: "completed" },
      select: { provider: true, model: true },
      distinct: ["provider", "model"],
    }),
    prisma.asset.count({ where: { projectId, source: { in: ["IMPORTED", "REUSED"] } } }),
  ]);
  const providers = jobs.map((j) => `${j.provider}/${j.model}`);
  if (project.scenes.some((s) => s.motionSource === "LOCAL_MOTION")) providers.push("ffmpeg/local-motion");
  if (project.scenes.some((s) => s.imageSource === "IMPORTED")) providers.push("import/user-supplied-images");

  const input = socialMetaSchema.safeParse(parseJson<unknown>(project.socialMetaJson, {}));
  const social = buildSocialMeta({
    title: project.title,
    summary: [project.idiom.meaning, project.idiom.exampleSentence].filter(Boolean).join(" — "),
    input: input.success ? (input.data as SocialMetaInput) : null,
    templates: settings.socialTemplates,
    batchName: project.batch?.name,
    date: localDate(),
  });
  const script = parseJson<{ source?: string; videoId?: string; sourceFile?: string; scenes?: unknown[] }>(project.scriptJson, {});
  const at = new Date().toISOString();
  const { width, height, fps } = await probeFrame(mp4, target);

  if (preset.metadata) {
    const metadata: OutputMetadata = {
      schemaVersion: 2,
      title: social.title,
      description: social.description,
      tags: social.tags,
      hashtags: social.hashtags,
      duration: Math.round(duration * 1000) / 1000,
      resolution: `${width}x${height}`,
      width,
      height,
      fps,
      language: project.language,
      aspectRatio: project.aspectRatio,
      generatedAt: at,
      createdAt: at,
      storyboardId: script.source === "IMPORT" ? (script.videoId ?? null) : null,
      importFingerprint: project.importFingerprint,
      projectId: project.id,
      batchId: project.batchId,
      preset: { id: preset.id, name: preset.name, subtitleMode: preset.subtitleMode },
      scenes: project.scenes.map((s) => ({
        sceneNumber: s.sceneNumber,
        duration: s.finalDuration ?? s.duration,
        motion: s.motionSource,
        image: s.imageSource,
        // Every speaker's line, in order - not the one line the stored field holds (QĐ-122).
        subtitle: sceneSubtitleText(s),
      })),
      sceneCount: project.scenes.length,
      subtitleFile: wantSrt ? "subtitles.srt" : null,
      thumbnailFile: preset.thumbnail ? "thumbnail.jpg" : null,
      totalActualCost: Math.round((spent._sum.amount ?? 0) * 1e6) / 1e6,
      reusedAssetCount: reused,
      providers: [...new Set(providers)].sort(),
    };
    writeText(path.join(dir, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
    files.push("metadata.json");
  }

  writeText(
    path.join(dir, "storyboard.json"),
    JSON.stringify(
      {
        title: project.title,
        storyboardId: script.videoId ?? null,
        sourceFile: script.sourceFile ?? null,
        scenes:
          script.source === "IMPORT" && Array.isArray(script.scenes)
            ? script.scenes
            : project.scenes.map((s) => ({
                sceneNumber: s.sceneNumber,
                duration: s.duration,
                subtitle: s.subtitle,
                visualDescription: s.visualDescription,
                motionSource: s.motionSource,
              })),
      },
      null,
      2,
    ) + "\n",
  );
  files.push("storyboard.json");

  if (preset.textFiles) {
    const captions = srtSource && fs.existsSync(srtSource) ? captionsFromSrt(fs.readFileSync(srtSource, "utf8")) : "";
    writeText(path.join(dir, "captions.txt"), captions + "\n");
    writeText(path.join(dir, "description.txt"), `${social.title}\n\n${social.description}\n`);
    files.push("captions.txt", "description.txt");
  }

  writeText(path.join(dir, MANIFEST), JSON.stringify({ files, presetId: preset.id } satisfies ExportManifest, null, 2) + "\n");

  const ready = await checkExportFolder({
    dir,
    expectAudio: await projectHasVoice(projectId),
    expectSrt: wantSrt,
    expectThumbnail: preset.thumbnail,
    expectMetadata: preset.metadata,
  });
  await prisma.project.update({ where: { id: projectId }, data: { exportReadyJson: JSON.stringify(ready) } });
  return dir;
}

/**
 * Write through a temp file and rename, so a media player holding the old file
 * open never sees half a file. If the target is locked (Windows: open in a
 * player), the error names the file instead of leaving a partial write.
 */
function copyReplacing(from: string, to: string): void {
  const temp = `${to}.tmp-${randomUUID().slice(0, 8)}`;
  try {
    fs.copyFileSync(from, temp);
    try {
      fs.renameSync(temp, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        throw new Error(`Không ghi đè được ${path.basename(to)} — file đang được mở (vd. trong trình phát video). Đóng file rồi thử lại.`);
      }
      throw err;
    }
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

function writeText(file: string, text: string): void {
  const temp = `${file}.tmp-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(temp, text, "utf8");
  try {
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
      throw new Error(`Không ghi được ${path.basename(file)} — file đang được mở ở chương trình khác.`);
    }
    throw err;
  }
}

async function probeFrame(
  mp4: string,
  fallback: { width: number; height: number; fps: number },
): Promise<{ width: number; height: number; fps: number }> {
  try {
    const { ffprobe } = await import("@/media/ffmpeg");
    const { stdout } = await ffprobe([
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0:s=x", mp4,
    ]);
    const [w, h, rate] = stdout.trim().split("x");
    const [num, den] = (rate ?? "").split("/").map(Number);
    return {
      width: Number(w) || fallback.width,
      height: Number(h) || fallback.height,
      fps: num && den ? Math.round((num / den) * 100) / 100 : fallback.fps,
    };
  } catch {
    return fallback;
  }
}

async function drawThumbnail(
  project: { id: string; thumbnailChoiceJson: string | null; scenes: Array<{ sceneNumber: number; imagePath: string | null }> },
  output: string,
  mp4: string,
  duration: number,
  target: { width: number; height: number },
): Promise<void> {
  const choice = thumbnailChoiceOf(project.thumbnailChoiceJson);
  // A picture (scene keyframe or upload) is scaled and centre-cropped to the
  // video's shape. Local FFmpeg; the picture itself is never changed.
  const w = 540;
  const h = Math.round((w * target.height) / target.width / 2) * 2;
  const cover = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  if (choice.mode === "SCENE") {
    const scene = project.scenes.find((s) => s.sceneNumber === choice.sceneNumber);
    const image = scene?.imagePath ? toAbsolute(scene.imagePath) : null;
    if (image && fs.existsSync(image)) {
      await ensureThumbnail({ source: image, output, duration: 0, atSec: 0, filter: cover });
      return;
    }
  }
  if (choice.mode === "UPLOAD" && choice.path) {
    const image = toAbsolute(choice.path);
    if (fs.existsSync(image)) {
      await ensureThumbnail({ source: image, output, duration: 0, atSec: 0, filter: cover });
      return;
    }
  }
  await ensureThumbnail({ source: mp4, output, duration });
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

export function thumbnailKey(sourceSha256: string, atSec: number, filter: string = THUMBNAIL_FILTER): string {
  return `thumb:${THUMBNAIL_VERSION}:${sourceSha256}:${atSec.toFixed(3)}:${filter}`;
}

export async function ensureThumbnail(opts: {
  source: string;
  output: string;
  duration: number;
  /** Frame position; default = min(1s, half the video). 0 for a still picture. */
  atSec?: number;
  filter?: string;
}): Promise<{ reused: boolean; key: string }> {
  const atSec = opts.atSec ?? Math.min(1, Math.max(0, opts.duration / 2));
  const filter = opts.filter ?? THUMBNAIL_FILTER;
  const key = thumbnailKey(fileSha256(opts.source), atSec, filter);
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
      "-frames:v", "1", "-vf", filter, temp,
    ]);
    fs.renameSync(temp, opts.output);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
  fs.writeFileSync(sidecar, JSON.stringify({ key, sha256: fileSha256(opts.output) }, null, 2) + "\n");
  return { reused: false, key };
}

/**
 * What an export folder is missing, if anything. With a Phase 6 manifest: every
 * file that export promised (final.mp4 also when its size no longer matches the
 * project's MP4). Without one (a legacy folder): final.mp4, thumbnail.jpg,
 * metadata.json, and subtitles.srt when the project has subtitles. Empty =
 * complete.
 */
export function missingOutputFiles(project: {
  id: string;
  title: string;
  outputDir?: string | null;
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
  const manifest = readManifest(dir);
  const expected = manifest
    ? manifest.files.filter((f) => f !== "final.mp4")
    : ["thumbnail.jpg", "metadata.json", ...(project.subtitlePath ? ["subtitles.srt"] : [])];
  for (const f of expected) if (!fs.existsSync(path.join(dir, f))) missing.push(f);
  return missing;
}

/** The export folder if it exists, relative to data/ (for the media route). */
export function existingOutputFor(project: { id: string; title: string; outputDir?: string | null }): {
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

/** The last EXPORT READY verdict stored on the row, or null. */
export function exportReadyOf(json: string | null | undefined): ExportReadyResult | null {
  return parseJson<ExportReadyResult | null>(json, null);
}
