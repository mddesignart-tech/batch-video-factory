import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { getSettings } from "@/lib/settings";
import { parseJson } from "@/lib/utils";
import { ensureProjectDirs, toAbsolute, toRelative, uuidFilename } from "@/lib/paths";
import { sniffImageType } from "@/lib/image-sniff";
import { findPreset } from "@/domain/output-preset";
import { socialMetaSchema, normalizeHashtags, normalizeTags, type SocialMetaInput } from "@/domain/social-metadata";
import { checkSubtitleSafeArea, safeAreaFor, type SafeAreaWarning } from "@/domain/safe-area";
import { wrapSubtitle } from "@/media/subtitles";
import {
  approveAndRun,
  extendApproval,
  ExecutorError,
  isRunning,
  isZeroCostVideo,
  renderProjectNow,
  type RunSummary,
} from "./batch-executor";
import { continueAllEligible, type ContinueAllResult } from "./video-resume";
import { preflightImportedBatch } from "./import-preflight";
import { exportProjectOutput, exportReadyOf, existingOutputFor, thumbnailChoiceOf, type ThumbnailChoice } from "./output-export";
import { renderSettingsFor } from "./output-layout";
import { tryLockVideo, unlockVideo } from "./run-registry";
import { invalidVoiceLines, invalidVoiceMessage } from "./voice-validity";

/**
 * What the daily workspace's buttons do (V1.2 Phase 6, QĐ-114), kept out of the
 * "use server" file so tests call exactly the same code. Every run goes through
 * the production executor and its gates; nothing here sends a request itself.
 */

// ------------------------------------------------------------ batch setup ---

export async function renameBatch(batchId: string, name: string): Promise<void> {
  const clean = name.trim().replace(/\s+/g, " ");
  if (clean.length === 0 || clean.length > 120) throw new ExecutorError("Tên lô phải có 1–120 ký tự.");
  // The output folder name (Batch.slug) is assigned once and does not move.
  await prisma.batch.update({ where: { id: batchId }, data: { name: clean } });
}

async function assertNotStarted(batchId: string, what: string): Promise<void> {
  if (isRunning(batchId)) throw new ExecutorError(`Lô đang chạy — không đổi ${what} giữa chừng.`);
}

/** PARTIAL / STRICT. Never changed while running or once money is approved. */
export async function setBatchMode(batchId: string, mode: "PARTIAL" | "STRICT"): Promise<void> {
  await assertNotStarted(batchId, "chế độ lô");
  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId }, select: { status: true } });
  if (auth && auth.status !== "DRAFT") {
    throw new ExecutorError("Lô đã được duyệt — chế độ PARTIAL/STRICT không đổi giữa chừng.");
  }
  await prisma.batch.update({ where: { id: batchId }, data: { batchMode: mode === "STRICT" ? "STRICT" : "PARTIAL" } });
}

/**
 * Output preset of a batch. Only render/export change: finished videos are
 * re-rendered locally when a person presses RENDER LẠI; nothing is re-bought.
 */
export async function setBatchPreset(batchId: string, presetId: string): Promise<void> {
  await assertNotStarted(batchId, "preset");
  const settings = await getSettings();
  if (presetId !== "" && !findPreset(presetId, settings.customPresets)) throw new ExecutorError(`Không có preset "${presetId}".`);
  await prisma.batch.update({ where: { id: batchId }, data: { outputPresetId: presetId } });
}

// ------------------------------------------------------------------- runs ---

export interface RunSelectedResult {
  path: "APPROVED" | "EXTENDED" | "CONTINUED";
  message: string;
  videos: string[];
  run?: RunSummary;
  continued?: ContinueAllResult;
}

/**
 * CHẠY VIDEO ĐÃ CHỌN. BLOCKED videos are never run. Which door it takes is
 * decided by the batch's approval, never by guessing:
 *
 *   no approval yet (DRAFT)             -> DUYỆT & CHẠY for exactly these videos
 *   approved, the videos are covered    -> TIẾP TỤC for these videos (paid work
 *                                          asks for confirmation first)
 *   approved, some are not covered      -> DUYỆT THÊM for those (typed amount)
 */
export async function runSelectedVideos(opts: {
  batchId: string;
  projectIds: string[];
  /** The amount typed for a DRAFT approval or a DUYỆT THÊM. */
  maxBatch?: number;
  maxPerVideo?: number;
  lowAutoApproved?: boolean;
  expectedVideoModels?: string[];
  confirmPaid?: boolean;
  expectedFingerprint?: string;
  wait?: boolean;
}): Promise<RunSelectedResult> {
  if (opts.projectIds.length === 0) throw new ExecutorError("Chưa chọn video nào.");
  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId: opts.batchId } });
  if (!auth) throw new ExecutorError("Lô chưa có dự toán. Bấm KIỂM TRA & DỰ TOÁN trước.");
  if (auth.status === "DRAFT") {
    if (opts.maxBatch === undefined) throw new ExecutorError("Nhập số tiền tối đa cho các video đã chọn.");
    const r = await approveAndRun({
      batchId: opts.batchId,
      maxBatch: opts.maxBatch,
      maxPerVideo: opts.maxPerVideo,
      lowAutoApproved: opts.lowAutoApproved === true,
      expectedVideoModels: opts.expectedVideoModels,
      onlyProjectIds: opts.projectIds,
      wait: opts.wait,
    });
    const ids = r.preflight.runnableProjectIds ?? [];
    return { path: "APPROVED", message: `Đã duyệt và bắt đầu ${ids.length} video đã chọn.`, videos: ids, run: r.run };
  }
  const covered = parseJson<{ runnableProjectIds?: string[] | null }>(auth.note, {}).runnableProjectIds ?? null;
  const uncovered = covered ? opts.projectIds.filter((id) => !covered.includes(id)) : [];
  const pre = await preflightImportedBatch(opts.batchId);
  const eligibleUncovered = uncovered.filter((id) => {
    const v = pre.videos.find((x) => x.projectId === id);
    return v && v.lifecycle !== "BLOCKED" && v.lifecycle !== "COMPLETED";
  });
  if (eligibleUncovered.length > 0) {
    if (opts.maxBatch === undefined) {
      const need = pre.videos.filter((v) => eligibleUncovered.includes(v.projectId)).reduce((n, v) => n + v.estimatedCost, 0);
      throw new ExecutorError(
        `NEEDS_APPROVAL: ${eligibleUncovered.length} video chưa nằm trong phần đã duyệt — cần DUYỆT THÊM (dự toán $${need.toFixed(6)}).`,
      );
    }
    const r = await extendApproval({
      batchId: opts.batchId,
      addMaxSpend: opts.maxBatch,
      onlyProjectIds: eligibleUncovered,
      lowAutoApproved: opts.lowAutoApproved === true,
      expectedVideoModels: opts.expectedVideoModels,
      wait: opts.wait,
    });
    return { path: "EXTENDED", message: `Đã duyệt thêm và bắt đầu ${r.added.length} video.`, videos: r.added, run: r.run };
  }
  const r = await continueAllEligible(opts.batchId, {
    onlyProjectIds: opts.projectIds,
    confirmPaid: opts.confirmPaid,
    expectedFingerprint: opts.expectedFingerprint,
    wait: opts.wait,
  });
  return { path: "CONTINUED", message: r.message, videos: r.runnable.map((p) => p.videoId), continued: r, run: r.run };
}

/**
 * CHẠY VIDEO $0 TRƯỚC. Only videos with no paid request at all: imported /
 * reused / local motion / cached voice / local render. No money is approved:
 *
 *   DRAFT batch   -> an approval with a $0 ceiling covering exactly those videos
 *                    (a paid POST could not pass the gate even by mistake)
 *   approved      -> TIẾP TỤC for the covered $0 videos; the uncovered $0 videos
 *                    are added with DUYỆT THÊM $0
 *
 * A paid video in the same batch never holds these back (PARTIAL) - Phase 2
 * limits still apply to everything.
 */
export async function runZeroCostVideos(batchId: string, opts: { wait?: boolean } = {}): Promise<RunSelectedResult> {
  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId } });
  if (!auth) throw new ExecutorError("Lô chưa có dự toán. Bấm KIỂM TRA & DỰ TOÁN trước.");
  if (auth.status === "DRAFT") {
    const r = await approveAndRun({ batchId, maxBatch: 0, lowAutoApproved: false, zeroCostOnly: true, wait: opts.wait });
    const ids = r.preflight.runnableProjectIds ?? [];
    return { path: "APPROVED", message: `Đang chạy ${ids.length} video $0 — không có yêu cầu trả phí nào được phép.`, videos: ids, run: r.run };
  }
  const covered = parseJson<{ runnableProjectIds?: string[] | null }>(auth.note, {}).runnableProjectIds ?? null;
  const pre = await preflightImportedBatch(batchId);
  const zero = pre.videos.filter((v) => v.lifecycle !== "BLOCKED" && v.lifecycle !== "COMPLETED" && isZeroCostVideo(v));
  const uncovered = covered ? zero.filter((v) => !covered.includes(v.projectId)).map((v) => v.projectId) : [];
  if (uncovered.length > 0) {
    const r = await extendApproval({ batchId, addMaxSpend: 0, onlyProjectIds: uncovered, lowAutoApproved: auth.lowAutoApproved, wait: opts.wait });
    return { path: "EXTENDED", message: `Đang chạy ${r.added.length} video $0.`, videos: r.added, run: r.run };
  }
  const r = await continueAllEligible(batchId, { zeroCostOnly: true, wait: opts.wait });
  return { path: "CONTINUED", message: r.message, videos: r.runnable.map((p) => p.videoId), continued: r, run: r.run };
}

/**
 * RENDER LẠI / XUẤT LẠI: FFmpeg on this machine with the batch's preset, then
 * the export. Never a purchase - the render only reads media that exists, and
 * an unchanged recipe with an intact MP4 is not rendered again (QĐ-113).
 */
export async function rerenderVideo(projectId: string): Promise<{ dir: string }> {
  const owner = `rerender:${projectId}:${Date.now().toString(36)}`;
  if (!tryLockVideo(projectId, owner)) throw new ExecutorError("ALREADY_RUNNING: video này đang chạy.");
  try {
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { status: true, finalVideoPath: true } });
    if (p.status !== "completed" || !p.finalVideoPath) {
      throw new ExecutorError("Chỉ render lại được video đã HOÀN THÀNH. Video chưa xong: dùng TIẾP TỤC.");
    }
    // A render from a broken voice file would be silent there: refuse, never re-buy.
    const bad = (await invalidVoiceLines([projectId])).get(projectId);
    if (bad) throw new ExecutorError(invalidVoiceMessage(bad));
    await renderProjectNow(projectId);
    const dir = await exportProjectOutput(projectId);
    await logger.info({ event: "output.rerendered", projectId, message: "RENDER LẠI tại máy theo preset — không gọi provider." });
    return { dir };
  } finally {
    unlockVideo(projectId, owner);
  }
}

export async function exportVideos(projectIds: string[]): Promise<Array<{ projectId: string; ok: boolean; message: string }>> {
  const out: Array<{ projectId: string; ok: boolean; message: string }> = [];
  for (const id of projectIds) {
    const owner = `export:${id}:${Date.now().toString(36)}`;
    if (!tryLockVideo(id, owner)) {
      out.push({ projectId: id, ok: false, message: "Video đang chạy." });
      continue;
    }
    try {
      const p = await prisma.project.findUniqueOrThrow({ where: { id }, select: { status: true } });
      if (p.status !== "completed") {
        out.push({ projectId: id, ok: false, message: "Chưa hoàn thành." });
        continue;
      }
      const dir = await exportProjectOutput(id);
      out.push({ projectId: id, ok: true, message: dir });
    } catch (err) {
      out.push({ projectId: id, ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      unlockVideo(id, owner);
    }
  }
  return out;
}

// ---------------------------------------------------------- per video ---

export async function saveSocialMeta(projectId: string, input: SocialMetaInput): Promise<void> {
  const parsed = socialMetaSchema.parse(input);
  const clean: SocialMetaInput = {
    title: parsed.title?.trim() || undefined,
    description: parsed.description?.trim() || undefined,
    tags: parsed.tags ? normalizeTags(parsed.tags) : undefined,
    hashtags: parsed.hashtags ? normalizeHashtags(parsed.hashtags) : undefined,
  };
  await prisma.project.update({ where: { id: projectId }, data: { socialMetaJson: JSON.stringify(clean) } });
}

export async function setThumbnailChoice(projectId: string, choice: ThumbnailChoice): Promise<void> {
  const safe = thumbnailChoiceOf(JSON.stringify(choice));
  if (safe.mode === "SCENE") {
    const scene = await prisma.scene.findFirst({ where: { projectId, sceneNumber: safe.sceneNumber, skipped: false }, select: { imagePath: true } });
    if (!scene?.imagePath) throw new ExecutorError(`Cảnh ${safe.sceneNumber} chưa có ảnh.`);
  }
  await prisma.project.update({ where: { id: projectId }, data: { thumbnailChoiceJson: JSON.stringify(safe) } });
}

/** A person's own thumbnail picture: stored under the project, never sent anywhere. */
export async function storeThumbnailUpload(projectId: string, bytes: Buffer): Promise<string> {
  if (bytes.length === 0 || bytes.length > 15 * 1024 * 1024) throw new ExecutorError("Ảnh phải từ 1 byte đến 15 MB.");
  const ext = sniffImageType(bytes);
  if (!ext) throw new ExecutorError("Chỉ nhận ảnh PNG, JPG hoặc WEBP.");
  const dir = path.join(ensureProjectDirs(projectId), "thumbnail-upload");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, uuidFilename(ext));
  fs.writeFileSync(file, bytes);
  const rel = toRelative(file);
  await setThumbnailChoice(projectId, { mode: "UPLOAD", path: rel });
  return rel;
}

export interface VideoDetail {
  projectId: string;
  title: string;
  social: SocialMetaInput;
  thumbnail: ThumbnailChoice;
  scenes: Array<{ sceneNumber: number; imagePath: string | null; subtitle: string }>;
  safeArea: { platform: string; warnings: SafeAreaWarning[]; zones: { top: number; bottom: number; right: number; left: number } | null };
  exportReady: ReturnType<typeof exportReadyOf>;
  output: { dir: string; relative: string; files: string[] } | null;
  preset: { id: string; name: string; subtitleMode: string; width: number; height: number };
  aspectNote: string | null;
}

export async function videoDetail(projectId: string): Promise<VideoDetail> {
  const p = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      id: true,
      title: true,
      status: true,
      outputDir: true,
      socialMetaJson: true,
      thumbnailChoiceJson: true,
      exportReadyJson: true,
      scenes: { where: { skipped: false }, orderBy: { sceneNumber: "asc" }, select: { sceneNumber: true, imagePath: true, subtitle: true } },
    },
  });
  const render = await renderSettingsFor(projectId);
  const zones = safeAreaFor(render.preset.platform);
  const output = p.status === "completed" ? existingOutputFor(p) : null;
  const social = socialMetaSchema.safeParse(parseJson<unknown>(p.socialMetaJson, {}));
  return {
    projectId: p.id,
    title: p.title,
    social: social.success ? social.data : {},
    thumbnail: thumbnailChoiceOf(p.thumbnailChoiceJson),
    scenes: p.scenes.map((s) => ({ sceneNumber: s.sceneNumber, imagePath: s.imagePath, subtitle: s.subtitle })),
    safeArea: {
      platform: render.preset.platform,
      zones: zones ? { top: zones.top, bottom: zones.bottom, right: zones.right, left: zones.left } : null,
      warnings: checkSubtitleSafeArea({
        platform: render.preset.platform,
        width: render.render.target.width,
        height: render.render.target.height,
        subtitles: p.scenes.map((s) => s.subtitle).filter((s) => s.trim().length > 0),
        burnt: render.render.burnSubtitles,
        wrap: wrapSubtitle,
      }),
    },
    exportReady: exportReadyOf(p.exportReadyJson),
    output: output
      ? {
          dir: output.dir,
          relative: output.relative,
          files: fs.existsSync(output.dir) ? fs.readdirSync(output.dir).filter((f) => !f.startsWith(".") && !f.includes(".tmp-")) : [],
        }
      : null,
    preset: {
      id: render.preset.id,
      name: render.preset.name,
      subtitleMode: render.preset.subtitleMode,
      width: render.render.target.width,
      height: render.render.target.height,
    },
    aspectNote: render.aspectNote,
  };
}

/** The absolute file a data-relative path points at, if it is inside data/. */
export function mediaFile(rel: string): string {
  return toAbsolute(rel);
}
