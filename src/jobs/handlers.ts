import path from "node:path";
import type { Job } from "@prisma/client";
import type { JobType, QualityMode } from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parseJson } from "@/lib/utils";
import { getSettings } from "@/lib/settings";
import { projectSubdir, toAbsolute, toRelative } from "@/lib/paths";
import {
  evaluateScene,
  generateSceneImage,
  generateSceneVideo,
  generateSceneVoice,
} from "@/services/generation";
import { syncBatchActualCost, syncProjectActualCost } from "@/services/cost-tracker";
import { renderProject, targetForAspect } from "@/media/render";
import { deferJob, enqueue } from "./queue";

/**
 * Job handlers.
 *
 * Each handler is small and idempotent: re-running one after a crash must be
 * safe, because the queue's retry path will do exactly that. The expensive
 * safety property (never paying twice) lives one layer down, in
 * services/generation.ts.
 */

export type HandlerResult = { deferred: true } | { deferred: false; result?: unknown };

const DONE: HandlerResult = { deferred: false };

export async function runJob(job: Job): Promise<HandlerResult> {
  const type = job.type as JobType;
  switch (type) {
    case "generate_scene_media":
      return handleSceneMedia(job);
    case "generate_scene_image":
      return single(job, generateSceneImage);
    case "generate_scene_video":
      return single(job, generateSceneVideo);
    case "generate_scene_voice":
      return single(job, generateSceneVoice);
    case "evaluate_scene_quality":
      return single(job, async (sceneId) => {
        const outcome = await evaluateScene(sceneId);
        return outcome?.score ?? null;
      });
    case "render_final":
      return handleRenderFinal(job);
    case "batch_expand":
      return handleBatchExpand(job);
    case "generate_script":
      // Scripts are generated synchronously from the UI so the operator can read
      // and edit them before anything is queued. Nothing to do here.
      return DONE;
    default:
      throw new Error(`Loại job không được hỗ trợ: ${job.type}`);
  }
}

async function single(
  job: Job,
  fn: (sceneId: string) => Promise<unknown>,
): Promise<HandlerResult> {
  if (!job.sceneId) throw new Error("Job thiếu sceneId.");
  const result = await fn(job.sceneId);
  return { deferred: false, result };
}

/**
 * The full chain for one scene: keyframe -> video -> voice -> quality check.
 *
 * If the quality check says the output is not good enough and retries remain,
 * the scene's retry counter is bumped (which invalidates the idempotency key, so
 * the next attempt is a genuinely new generation) and the job is re-queued.
 */
async function handleSceneMedia(job: Job): Promise<HandlerResult> {
  const sceneId = job.sceneId;
  if (!sceneId) throw new Error("Job thiếu sceneId.");

  const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
  if (!scene) throw new Error(`Không tìm thấy cảnh ${sceneId}`);
  if (scene.skipped) {
    await logger.info({
      event: "scene.skipped",
      sceneId,
      projectId: scene.projectId,
      message: `Bỏ qua cảnh ${scene.sceneNumber}.`,
    });
    return DONE;
  }

  await generateSceneImage(sceneId);
  await generateSceneVideo(sceneId);
  await generateSceneVoice(sceneId);

  const outcome = await evaluateScene(sceneId);
  if (outcome?.shouldRetry) {
    await prisma.scene.update({
      where: { id: sceneId },
      data: { retryCount: { increment: 1 }, status: "pending" },
    });
    await logger.warn({
      event: "scene.quality_retry",
      sceneId,
      projectId: scene.projectId,
      message: outcome.reason,
    });
    await enqueue({
      type: "generate_scene_media",
      sceneId,
      projectId: scene.projectId,
      priority: job.priority,
    });
    return DONE;
  }

  await prisma.scene.update({
    where: { id: sceneId },
    data: { status: "completed", errorMessage: null },
  });
  return DONE;
}

/**
 * Final render. Waits for every non-skipped scene to have media before it runs -
 * rather than tracking dependencies in the queue, it simply defers itself.
 */
async function handleRenderFinal(job: Job): Promise<HandlerResult> {
  const projectId = job.projectId;
  if (!projectId) throw new Error("Job thiếu projectId.");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { scenes: { orderBy: { sceneNumber: "asc" } }, idiom: true },
  });
  if (!project) throw new Error(`Không tìm thấy dự án ${projectId}`);

  const active = project.scenes.filter((s) => !s.skipped);
  const pending = active.filter((s) => !s.videoPath && !s.imagePath);

  // A scene whose generation gave up will never produce media, so waiting for it
  // is waiting forever. Fail now with something the operator can act on rather
  // than spinning in the queue for minutes first.
  const dead = pending.filter((s) => s.status === "failed");
  if (dead.length > 0) {
    throw new Error(
      `Không thể render: ${dead.length} cảnh (${dead
        .map((s) => s.sceneNumber)
        .join(", ")}) tạo media thất bại. ` +
        `Hãy tạo lại các cảnh đó hoặc bấm "Bỏ qua cảnh" rồi render lại.`,
    );
  }

  if (pending.length > 0) {
    const waited = parseJson<{ waited?: number }>(job.payloadJson, {}).waited ?? 0;
    if (waited > 240) {
      throw new Error(
        `Vẫn còn ${pending.length} cảnh chưa có media sau khi chờ. Hãy kiểm tra nhật ký lỗi.`,
      );
    }
    await prisma.job.update({
      where: { id: job.id },
      data: { payloadJson: JSON.stringify({ waited: waited + 1 }) },
    });
    await deferJob(job.id, 3000);
    return { deferred: true };
  }

  await prisma.project.update({
    where: { id: projectId },
    data: { status: "rendering" },
  });

  const settings = await getSettings();
  const result = await renderProject({
    projectId,
    target: targetForAspect(project.aspectRatio),
    burnSubtitles: settings.burnSubtitles,
    highlightPhrase: project.idiom.phrase,
    scenes: active.map((s) => ({
      sceneNumber: s.sceneNumber,
      duration: s.duration,
      subtitle: s.subtitle,
      videoPath: s.videoPath ? toAbsolute(s.videoPath) : null,
      audioPath: s.audioPath ? toAbsolute(s.audioPath) : null,
      imagePath: s.imagePath ? toAbsolute(s.imagePath) : null,
    })),
  });

  await prisma.asset.create({
    data: {
      projectId,
      kind: "final",
      provider: "ffmpeg",
      model: "libx264",
      status: "completed",
      filePath: toRelative(result.videoPath),
      bytes: result.bytes,
    },
  });

  await prisma.project.update({
    where: { id: projectId },
    data: {
      status: "completed",
      finalVideoPath: toRelative(result.videoPath),
      subtitlePath: toRelative(result.subtitlePathSrt),
      errorMessage: null,
    },
  });
  await prisma.idiom.update({
    where: { id: project.idiomId },
    data: {
      status: "generated",
      timesUsed: { increment: 1 },
      lastUsedAt: new Date(),
    },
  });

  await syncProjectActualCost(projectId);
  if (project.batchId) await syncBatchActualCost(project.batchId);

  await logger.info({
    event: "project.rendered",
    projectId,
    message: `Xuất video ${path.basename(result.videoPath)} (${result.durationSeconds.toFixed(1)}s)`,
    data: {
      subtitlesBurned: result.subtitlesBurned,
      bytes: result.bytes,
    },
  });

  return { deferred: false, result: { videoPath: toRelative(result.videoPath) } };
}

/**
 * Turn a batch definition into real projects. Kept as a job so creating 50
 * videos does not block an HTTP request.
 */
async function handleBatchExpand(job: Job): Promise<HandlerResult> {
  const batchId = job.batchId;
  if (!batchId) throw new Error("Job thiếu batchId.");

  const batch = await prisma.batch.findUnique({ where: { id: batchId } });
  if (!batch) throw new Error(`Không tìm thấy lô ${batchId}`);

  const { createProjectForIdiom } = await import("@/services/project-service");

  const idioms = await prisma.idiom.findMany({
    where: {
      status: { in: ["unused", "planned"] },
      ...(batch.category ? { category: batch.category } : {}),
      ...(batch.difficulty ? { difficulty: batch.difficulty } : {}),
    },
    orderBy: [{ timesUsed: "asc" }, { createdAt: "asc" }],
    take: batch.amount,
  });

  if (idioms.length === 0) {
    throw new Error(
      "Không còn thành ngữ phù hợp với bộ lọc của lô này. Hãy thêm thành ngữ hoặc đổi bộ lọc.",
    );
  }

  // Split the batch budget evenly so one runaway project cannot eat the lot.
  const perProjectBudget = batch.maxBudget / Math.max(1, idioms.length);
  let created = 0;

  for (const idiom of idioms) {
    try {
      await createProjectForIdiom({
        idiomId: idiom.id,
        qualityMode: batch.qualityMode as QualityMode,
        stylePresetId: batch.stylePresetId ?? undefined,
        targetDuration: batch.targetDuration,
        maxBudget: perProjectBudget,
        batchId: batch.id,
        autoGenerateScript: true,
        autoStartMedia: true,
      });
      created++;
    } catch (err) {
      await logger.error({
        event: "batch.project_failed",
        message: `Không tạo được dự án cho "${idiom.phrase}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  await prisma.batch.update({
    where: { id: batchId },
    data: { status: created > 0 ? "processing" : "failed" },
  });

  return { deferred: false, result: { created, requested: batch.amount } };
}

/**
 * Side effects for a job that has exhausted its retries.
 *
 * Marking the scene - not just the job - is what lets the renderer fail fast and
 * what puts a red badge on the right card in the storyboard. Shared by the
 * worker and the test harness so both agree on what "gave up" means.
 */
export async function onJobExhausted(
  job: Pick<Job, "projectId" | "sceneId" | "type">,
  error: unknown,
): Promise<void> {
  const message =
    error instanceof Error ? error.message : String(error ?? "Lỗi không xác định");

  if (job.sceneId) {
    await prisma.scene
      .update({
        where: { id: job.sceneId },
        data: { status: "failed", errorMessage: message.slice(0, 1000) },
      })
      .catch(() => undefined);
  }

  if (job.projectId) {
    await prisma.project
      .update({
        where: { id: job.projectId },
        data: { status: "failed", errorMessage: message.slice(0, 1000) },
      })
      .catch(() => undefined);
  }
}

/** Where a project's media lives, for the media browser. */
export function projectMediaDirs(projectId: string): Record<string, string> {
  return {
    images: projectSubdir(projectId, "images"),
    videos: projectSubdir(projectId, "videos"),
    audio: projectSubdir(projectId, "audio"),
    subtitles: projectSubdir(projectId, "subtitles"),
    final: projectSubdir(projectId, "final"),
  };
}
