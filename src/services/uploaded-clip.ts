import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Asset, Scene } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sha256Bytes } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { projectSubdir, toAbsolute, toRelative, uuidFilename } from "@/lib/paths";
import { ffmpeg, ffprobe } from "@/media/ffmpeg";
import { fileSha256 } from "@/services/asset-content";
import { CLIP_CLEARED, storeImportedImage } from "@/services/imported-image";
import {
  ALLOWED_CLIP_EXTENSIONS,
  CLIP_EXTENSION,
  CLIP_MAX_BYTES,
  CLIP_MIME,
  MISSING_CLIP_MESSAGE,
  allowedClipName,
  asClipFrame,
  asClipShortMode,
  clipWindow,
  describeShape,
  formatMatches,
  parseClipInfo,
  parseRate,
  sniffClipContainer,
  trimProblem,
  usesUserClip,
  type ClipFrame,
  type ClipMediaInfo,
  type ClipShortMode,
} from "@/domain/user-clip";

/**
 * UPLOADED VIDEO CLIP INPUT.
 *
 *   USER VIDEO = REUSE = $0 VIDEO API COST
 *
 * A person's clip is checked by its CONTENT (container header + ffprobe + one
 * decoded frame - never the name), copied into the project's own `videos`
 * folder, recorded as an `Asset` (kind "video", source IMPORTED) with what
 * ffprobe measured, and becomes a scene's visual. Nothing here can reach a
 * provider. Its first frame becomes the scene's keyframe (an IMPORTED picture,
 * $0), so no picture is ever bought for a scene that has a clip.
 *
 * The clip is rendered by the SAME pipeline as an AI clip (render.ts): one
 * normaliser, one timing engine, one mixer.
 */

export type ClipErrorCode = "clip_empty" | "clip_too_large" | "clip_extension_not_allowed" | "clip_not_a_video" | "clip_undecodable" | "clip_no_video_stream";

export class ClipUploadError extends Error {
  constructor(
    message: string,
    readonly code: ClipErrorCode,
  ) {
    super(message);
    this.name = "ClipUploadError";
  }
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
}

/** Measure a video file with ffprobe. Throws a friendly error when it is not a usable clip. */
export async function probeClipFile(file: string, label: string, bytes: number): Promise<Omit<ClipMediaInfo, "container">> {
  let json: { streams?: ProbeStream[]; format?: { duration?: string; format_name?: string } };
  try {
    const { stdout } = await ffprobe(["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
    json = JSON.parse(stdout);
  } catch {
    throw new ClipUploadError(`"${label}" không đọc được như một video (file hỏng hoặc không phải video).`, "clip_undecodable");
  }
  const video = (json.streams ?? []).find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (!video || !video.width || !video.height) {
    throw new ClipUploadError(`"${label}" không có hình (không có luồng video).`, "clip_no_video_stream");
  }
  const audio = (json.streams ?? []).find((s) => s.codec_type === "audio");
  const durationSec = Number.parseFloat(json.format?.duration ?? video.duration ?? "0");
  if (!(durationSec > 0)) {
    throw new ClipUploadError(`"${label}" không xác định được độ dài video.`, "clip_undecodable");
  }
  const rawRotation = video.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation ?? Number(video.tags?.rotate ?? 0);
  const rotation = (((Math.round(rawRotation / 90) * 90) % 360) + 360) % 360;
  const turned = rotation === 90 || rotation === 270;
  const width = turned ? video.height : video.width;
  const height = turned ? video.width : video.height;
  const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate);
  return {
    durationSec: Math.round(durationSec * 1000) / 1000,
    width,
    height,
    fps,
    codec: video.codec_name ?? "unknown",
    pixelFormat: video.pix_fmt ?? null,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ?? null,
    rotation,
    ...describeShape(width, height),
    bytes,
  };
}

export interface InspectedClip {
  info: ClipMediaInfo;
  sha256: string;
}

/**
 * Prove a file is a clip this pipeline can play, or say exactly why not: the
 * name, the container header, ffprobe's reading of the container, a video
 * stream, a length, and one REAL decoded frame (a header can be perfect on a
 * truncated file).
 */
export async function inspectClipBytes(bytes: Buffer, label: string): Promise<InspectedClip> {
  if (!allowedClipName(label)) {
    throw new ClipUploadError(`"${label}" không phải video được nhận. Chỉ nhận: ${ALLOWED_CLIP_EXTENSIONS.join(", ")}.`, "clip_extension_not_allowed");
  }
  if (bytes.length === 0) throw new ClipUploadError(`"${label}" rỗng (0 byte).`, "clip_empty");
  if (bytes.length > CLIP_MAX_BYTES) {
    throw new ClipUploadError(
      `"${label}" nặng ${(bytes.length / 1024 / 1024).toFixed(0)} MB, vượt giới hạn ${CLIP_MAX_BYTES / 1024 / 1024} MB.`,
      "clip_too_large",
    );
  }
  const container = sniffClipContainer(bytes);
  if (!container) {
    throw new ClipUploadError(`"${label}" có đuôi video nhưng nội dung không phải MP4 / MOV / WebM. Không nhận.`, "clip_not_a_video");
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "clip-check-"));
  const file = path.join(scratch, `probe${CLIP_EXTENSION[container]}`);
  try {
    fs.writeFileSync(file, bytes);
    const measured = await probeClipFile(file, label, bytes.length);
    const { stdout } = await ffprobe(["-v", "error", "-show_entries", "format=format_name", "-of", "default=nw=1:nk=1", file]).catch(() => ({ stdout: "" }));
    if (!formatMatches(stdout.trim(), container)) {
      throw new ClipUploadError(`"${label}" có phần đầu giống video nhưng FFmpeg không đọc được vùng chứa. Không nhận.`, "clip_undecodable");
    }
    try {
      await ffmpeg(["-v", "error", "-i", file, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"]);
    } catch {
      throw new ClipUploadError(`"${label}" không giải mã được hình (codec lỗi hoặc file bị cắt cụt).`, "clip_undecodable");
    }
    return { info: { container, ...measured }, sha256: sha256Bytes(bytes) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** A still of the clip at `atSec` (rotation applied), as PNG bytes. Local FFmpeg, $0. */
export async function clipFrame(absoluteClip: string, atSec: number): Promise<Buffer> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "clip-frame-"));
  const out = path.join(scratch, "frame.png");
  try {
    await ffmpeg(["-v", "error", "-y", "-ss", String(Math.max(0, atSec)), "-i", absoluteClip, "-frames:v", "1", out]);
    if (!fs.existsSync(out)) await ffmpeg(["-v", "error", "-y", "-i", absoluteClip, "-frames:v", "1", out]);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export interface StoredClip {
  asset: Asset;
  info: ClipMediaInfo;
  /** The same bytes were already in this project: that asset is reused. */
  deduplicated: boolean;
}

/**
 * Copy a clip into the project's `videos` folder and record it. Spends nothing.
 * The same bytes uploaded again come back as the SAME asset (no duplicate);
 * when that asset's file had gone missing, these bytes put it back.
 */
export async function storeUploadedClip(opts: { projectId: string; bytes: Buffer; originalFilename: string }): Promise<StoredClip> {
  const { info, sha256 } = await inspectClipBytes(opts.bytes, opts.originalFilename);
  await prisma.project.findUniqueOrThrow({ where: { id: opts.projectId }, select: { id: true } });
  const twin = await prisma.asset.findFirst({
    where: { projectId: opts.projectId, kind: "video", source: "IMPORTED", sha256 },
    orderBy: { createdAt: "asc" },
  });
  if (twin) {
    const abs = toAbsolute(twin.filePath);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, opts.bytes);
    }
    const known = parseClipInfo(twin.mediaInfoJson);
    if (known?.posterPath && !fs.existsSync(toAbsolute(known.posterPath))) await writePoster(twin, known);
    await logger.info({ event: "clip.upload_deduplicated", projectId: opts.projectId, message: `Clip "${opts.originalFilename}" đã có trong dự án - dùng lại, không lưu bản thứ hai.` });
    return { asset: await prisma.asset.findUniqueOrThrow({ where: { id: twin.id } }), info: parseClipInfo((await prisma.asset.findUniqueOrThrow({ where: { id: twin.id } })).mediaInfoJson) ?? info, deduplicated: true };
  }

  const dir = projectSubdir(opts.projectId, "videos");
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, `upload-${uuidFilename(CLIP_EXTENSION[info.container])}`);
  fs.writeFileSync(abs, opts.bytes);
  const asset = await prisma.asset.create({
    data: {
      projectId: opts.projectId,
      sceneId: null,
      kind: "video",
      provider: "upload",
      model: "user-clip",
      source: "IMPORTED",
      status: "completed",
      estimatedCost: 0,
      actualCost: 0,
      filePath: toRelative(abs),
      bytes: opts.bytes.length,
      originalFilename: path.basename(opts.originalFilename),
      mimeType: CLIP_MIME[info.container],
      width: info.width,
      height: info.height,
      durationSec: info.durationSec,
      sha256,
      mediaInfoJson: JSON.stringify(info),
    },
  });
  const withPoster = await writePoster(asset, info);
  await logger.info({
    event: "clip.uploaded",
    projectId: opts.projectId,
    message: `Đã tải clip "${opts.originalFilename}" (${info.durationSec.toFixed(2)} giây, ${info.width}×${info.height}, ${info.fps} fps). Không gọi API, $0.`,
  });
  return { asset: withPoster.asset, info: withPoster.info, deduplicated: false };
}

async function writePoster(asset: Asset, info: ClipMediaInfo): Promise<{ asset: Asset; info: ClipMediaInfo }> {
  const png = await clipFrame(toAbsolute(asset.filePath), Math.min(0.1, info.durationSec / 2));
  const dir = projectSubdir(asset.projectId, "images");
  fs.mkdirSync(dir, { recursive: true });
  const poster = path.join(dir, `poster-${uuidFilename(".png")}`);
  fs.writeFileSync(poster, png);
  const next = { ...info, posterPath: toRelative(poster) };
  const updated = await prisma.asset.update({ where: { id: asset.id }, data: { mediaInfoJson: JSON.stringify(next) } });
  return { asset: updated, info: next };
}

export function clipFileExists(asset: Pick<Asset, "filePath"> | null | undefined): boolean {
  if (!asset) return false;
  try {
    return fs.existsSync(toAbsolute(asset.filePath));
  } catch {
    return false;
  }
}

export interface ClipAssignResult {
  scene: Scene;
  /** The project had a finished MP4, which now shows the old visual: a LOCAL re-render ($0). */
  needsRerender: boolean;
}

/**
 * Make an uploaded clip the scene's visual. The clip's first frame (at the
 * trim start) becomes the scene's keyframe - an IMPORTED picture, $0 - so the
 * scene never buys a picture either. The previous media is not deleted: its
 * Asset rows stay. Narration, dialogue, voice files and subtitles are not
 * touched (a new clip is a local re-render only).
 */
export async function assignClipToScene(sceneId: string, assetId: string): Promise<ClipAssignResult> {
  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId }, include: { project: { select: { finalVideoPath: true } } } });
  const asset = await prisma.asset.findFirstOrThrow({ where: { id: assetId, projectId: scene.projectId, kind: "video", source: "IMPORTED" } });
  if (!clipFileExists(asset)) throw new Error(`${MISSING_CLIP_MESSAGE} Hãy tải lại file "${asset.originalFilename ?? ""}".`);
  const info = parseClipInfo(asset.mediaInfoJson);
  const same = scene.videoSource === "UPLOADED" && scene.videoAssetId === asset.id;
  const keyframe = await keyframeFromClip(scene.projectId, scene.id, asset, info, same ? scene.clipStartSec ?? 0 : 0);
  const updated = await prisma.scene.update({
    where: { id: sceneId },
    data: {
      videoSource: "UPLOADED",
      videoAssetId: asset.id,
      videoPath: asset.filePath,
      videoProvider: "upload",
      videoModel: "user-clip",
      videoModelPinned: false,
      ...(same ? {} : { clipStartSec: null, clipEndSec: null, clipShortMode: "AUTO", clipFrame: "AUTO" }),
      imageSource: "IMPORTED",
      imagePath: keyframe.imagePath,
      imageAssetId: keyframe.assetId,
      errorMessage: null,
      ...(scene.status === "skipped" ? {} : { status: "video_ready" }),
    },
  });
  await logger.info({
    event: "scene.user_clip_assigned",
    projectId: scene.projectId,
    sceneId,
    message: `Cảnh ${scene.sceneNumber} dùng Video của bạn "${asset.originalFilename ?? ""}". Không gọi Video AI / Image AI, $0. Lời thoại và phụ đề giữ nguyên.`,
  });
  return { scene: updated, needsRerender: !same && scene.project.finalVideoPath !== null };
}

async function keyframeFromClip(projectId: string, sceneId: string, asset: Asset, info: ClipMediaInfo | null, atSec: number): Promise<{ imagePath: string; assetId: string }> {
  const png =
    atSec <= 0.1 && info?.posterPath && fs.existsSync(toAbsolute(info.posterPath))
      ? fs.readFileSync(toAbsolute(info.posterPath))
      : await clipFrame(toAbsolute(asset.filePath), Math.max(atSec, Math.min(0.1, (info?.durationSec ?? 1) / 2)));
  const stored = await storeImportedImage({ projectId, sceneId, bytes: png, originalFilename: `${path.parse(asset.originalFilename ?? "clip").name}-frame.png`, via: "clip-poster" });
  return { imagePath: stored.imagePath, assetId: stored.asset.id };
}

/**
 * The scene stops using a person's clip ("Bỏ gán"). The clip asset stays in the
 * project. The keyframe goes back to the scene's own earlier picture when one
 * exists on disk; otherwise the clip's frame stays as an imported picture ($0),
 * so nothing is bought behind the person's back. Video AI is used only if the
 * person chooses it afterwards.
 */
export async function unassignClip(sceneId: string): Promise<Scene> {
  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  if (!usesUserClip(scene)) return scene;
  const posterAsset = scene.imageAssetId ? await prisma.asset.findUnique({ where: { id: scene.imageAssetId } }) : null;
  const keyframeIsPoster = posterAsset?.model === "clip-poster";
  const earlier = keyframeIsPoster
    ? await prisma.asset.findFirst({
        where: { sceneId, kind: "image", NOT: { model: "clip-poster" }, status: "completed" },
        orderBy: { createdAt: "desc" },
      })
    : null;
  const back = earlier && clipFileExists(earlier) ? earlier : null;
  const updated = await prisma.scene.update({
    where: { id: sceneId },
    data: {
      ...clearedClip(),
      videoPath: null,
      videoProvider: null,
      videoModel: null,
      ...(back
        ? back.source === "IMPORTED"
          ? { imageSource: "IMPORTED", imagePath: back.filePath, imageAssetId: back.id }
          : { imageSource: "GENERATED", imagePath: back.filePath, imageAssetId: null }
        : {}),
      errorMessage: null,
      ...(scene.status === "skipped" ? {} : { status: "image_ready" }),
    },
  });
  await logger.info({ event: "scene.user_clip_unassigned", projectId: scene.projectId, sceneId, message: `Cảnh ${scene.sceneNumber} bỏ Video của bạn. Không gọi API.` });
  return updated;
}

/** The scene columns of a clip, back to "no clip". */
export function clearedClip() {
  return { ...CLIP_CLEARED };
}

export interface ClipSettingsChange {
  startSec?: number | null;
  endSec?: number | null;
  audio?: "OFF" | "ON";
  audioGain?: number;
  shortMode?: ClipShortMode;
  frame?: ClipFrame;
}

/** Trim / sound / short-clip strategy / framing. All local: a re-render only, $0. */
export async function updateClipSettings(sceneId: string, change: ClipSettingsChange): Promise<Scene> {
  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  if (!usesUserClip(scene) || !scene.videoAssetId) throw new Error("Cảnh này chưa dùng video của bạn.");
  const asset = await prisma.asset.findUniqueOrThrow({ where: { id: scene.videoAssetId } });
  const duration = asset.durationSec ?? parseClipInfo(asset.mediaInfoJson)?.durationSec ?? 0;
  const start = change.startSec !== undefined ? change.startSec : scene.clipStartSec;
  const end = change.endSec !== undefined ? change.endSec : scene.clipEndSec;
  const problem = trimProblem(start, end, duration);
  if (problem) throw new Error(problem);
  const gain = change.audioGain !== undefined ? Math.min(1, Math.max(0, change.audioGain)) : undefined;
  const updated = await prisma.scene.update({
    where: { id: sceneId },
    data: {
      ...(change.startSec !== undefined ? { clipStartSec: change.startSec } : {}),
      ...(change.endSec !== undefined ? { clipEndSec: change.endSec !== null && change.endSec >= duration ? null : change.endSec } : {}),
      ...(change.audio ? { clipAudio: change.audio } : {}),
      ...(gain !== undefined ? { clipAudioGain: gain } : {}),
      ...(change.shortMode ? { clipShortMode: asClipShortMode(change.shortMode) } : {}),
      ...(change.frame ? { clipFrame: asClipFrame(change.frame) } : {}),
    },
  });
  // A new start point: the keyframe follows it, so preview / thumbnail show what plays.
  if (change.startSec !== undefined && (change.startSec ?? 0) !== (scene.clipStartSec ?? 0) && clipFileExists(asset)) {
    const keyframe = await keyframeFromClip(scene.projectId, scene.id, asset, parseClipInfo(asset.mediaInfoJson), change.startSec ?? 0);
    return prisma.scene.update({ where: { id: sceneId }, data: { imagePath: keyframe.imagePath, imageAssetId: keyframe.assetId } });
  }
  return updated;
}

export interface ProjectClip {
  asset: Asset;
  info: ClipMediaInfo | null;
  exists: boolean;
  /** Scene numbers that show this clip. */
  usedBy: number[];
}

export async function projectClips(projectId: string): Promise<ProjectClip[]> {
  const assets = await prisma.asset.findMany({ where: { projectId, kind: "video", source: "IMPORTED" }, orderBy: { createdAt: "asc" } });
  const scenes = await prisma.scene.findMany({ where: { projectId, videoSource: "UPLOADED" }, select: { sceneNumber: true, videoAssetId: true }, orderBy: { sceneNumber: "asc" } });
  return assets.map((asset) => ({
    asset,
    info: parseClipInfo(asset.mediaInfoJson),
    exists: clipFileExists(asset),
    usedBy: scenes.filter((s) => s.videoAssetId === asset.id).map((s) => s.sceneNumber),
  }));
}

export interface ClipDeleteResult {
  deleted: boolean;
  /** In use and not confirmed: nothing was removed. */
  needsConfirmation: boolean;
  usedBy: number[];
}

/**
 * Remove an uploaded clip from the project. A clip in use is never removed
 * silently: the first call answers `needsConfirmation` with the scene numbers
 * ("Video này đang được sử dụng ở X scene"); with `confirm` those scenes stop
 * using it first. The file is deleted only when no other asset row points at it.
 */
export async function deleteUploadedClip(assetId: string, opts: { confirm?: boolean } = {}): Promise<ClipDeleteResult> {
  const asset = await prisma.asset.findFirstOrThrow({ where: { id: assetId, kind: "video", source: "IMPORTED" } });
  const users = await prisma.scene.findMany({ where: { projectId: asset.projectId, videoSource: "UPLOADED", videoAssetId: asset.id }, orderBy: { sceneNumber: "asc" } });
  const usedBy = users.map((s) => s.sceneNumber);
  if (usedBy.length > 0 && !opts.confirm) return { deleted: false, needsConfirmation: true, usedBy };
  for (const s of users) await unassignClip(s.id);
  await prisma.asset.delete({ where: { id: asset.id } });
  const others = await prisma.asset.count({ where: { filePath: asset.filePath } });
  if (others === 0) {
    try {
      fs.rmSync(toAbsolute(asset.filePath), { force: true });
    } catch {
      // Already gone or locked: the row is what the project reads.
    }
  }
  await logger.info({ event: "clip.deleted", projectId: asset.projectId, message: `Đã xoá clip "${asset.originalFilename ?? ""}"${usedBy.length ? ` (đã gỡ khỏi cảnh ${usedBy.join(", ")})` : ""}.` });
  return { deleted: true, needsConfirmation: false, usedBy };
}

/** Upload + assign: the path the Scene Editor uses (also "Chọn lại file" for a missing clip). */
export async function uploadClipToScene(opts: { sceneId: string; bytes: Buffer; originalFilename: string }): Promise<ClipAssignResult & { stored: StoredClip }> {
  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: opts.sceneId }, select: { projectId: true } });
  const stored = await storeUploadedClip({ projectId: scene.projectId, bytes: opts.bytes, originalFilename: opts.originalFilename });
  const assigned = await assignClipToScene(opts.sceneId, stored.asset.id);
  return { ...assigned, stored };
}

/** What the renderer needs to play a scene's clip. Null = the scene has no user clip. */
export interface SceneClipRender {
  startSec: number;
  lengthSec: number;
  shortMode: ClipShortMode;
  frame: ClipFrame;
  /** Null = the clip's own sound is not used (OFF, or the file has none). */
  audioGain: number | null;
}

export function sceneClipRender(
  scene: Pick<Scene, "videoSource" | "clipStartSec" | "clipEndSec" | "clipAudio" | "clipAudioGain" | "clipShortMode" | "clipFrame">,
  asset: Pick<Asset, "durationSec" | "mediaInfoJson"> | null,
): SceneClipRender | null {
  if (!usesUserClip(scene) || !asset) return null;
  const info = parseClipInfo(asset.mediaInfoJson);
  const window = clipWindow(scene, asset.durationSec ?? info?.durationSec ?? 0);
  return {
    startSec: window.startSec,
    lengthSec: window.lengthSec,
    shortMode: asClipShortMode(scene.clipShortMode),
    frame: asClipFrame(scene.clipFrame),
    audioGain: scene.clipAudio === "ON" && info?.hasAudio ? Math.min(1, Math.max(0, scene.clipAudioGain)) : null,
  };
}

/** Each scene with a user clip whose file is gone - never a reason to buy one. */
export async function missingUserClips(projectId: string): Promise<{ sceneId: string; sceneNumber: number; filename: string | null }[]> {
  const scenes = await prisma.scene.findMany({ where: { projectId, videoSource: "UPLOADED", skipped: false }, orderBy: { sceneNumber: "asc" } });
  const out: { sceneId: string; sceneNumber: number; filename: string | null }[] = [];
  for (const s of scenes) {
    const asset = s.videoAssetId ? await prisma.asset.findUnique({ where: { id: s.videoAssetId } }) : null;
    const file = asset?.filePath ?? s.videoPath;
    let ok = false;
    try {
      ok = Boolean(file) && fs.existsSync(toAbsolute(file!));
    } catch {
      ok = false;
    }
    if (!ok) out.push({ sceneId: s.id, sceneNumber: s.sceneNumber, filename: asset?.originalFilename ?? null });
  }
  return out;
}

/** The same clip content is still what the asset recorded (resume safety). */
export function clipStillMatches(asset: Pick<Asset, "filePath" | "sha256">): boolean {
  if (!clipFileExists(asset)) return false;
  if (!asset.sha256) return true;
  try {
    return fileSha256(toAbsolute(asset.filePath)) === asset.sha256;
  } catch {
    return false;
  }
}
