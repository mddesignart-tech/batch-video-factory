import path from "node:path";
import type { Job } from "@prisma/client";
import type { JobType } from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { errorMessage, parseJson } from "@/lib/utils";
import { ProviderError } from "@/providers/types";
import { getSettings } from "@/lib/settings";
import { projectSubdir, toAbsolute, toRelative } from "@/lib/paths";
import { evaluateScene } from "@/services/generation";
import { syncBatchActualCost, syncProjectActualCost } from "@/services/cost-tracker";
import { settleBatchIfDone } from "@/services/batch-runner";
import { renderProject, targetForAspect } from "@/media/render";
import { deferJob } from "./queue";

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
    // The operator's "Tạo lại ảnh / video / giọng": one asset, through the
    // executor's step so it gets the same ceilings re-read before the POST.
    case "generate_scene_image":
      return single(job, (id) => executorAsset(id, "image"));
    case "generate_scene_video":
      return single(job, (id) => executorAsset(id, "video"));
    case "generate_scene_voice":
      return single(job, (id) => executorAsset(id, "voice"));
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

async function executorAsset(sceneId: string, kind: "image" | "video" | "voice"): Promise<unknown> {
  const { executeSceneAsset } = await import("@/services/batch-executor");
  return executeSceneAsset(sceneId, kind);
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

  // SCHEDULING ONLY. The step itself is the production executor's - the same
  // image -> clip -> voice order, the same headroom checks, the same gates.
  // There is deliberately no quality loop here any more: a below-threshold
  // verdict used to bump retryCount, which changes every key and re-buys the
  // image AND the clip - on the word of a mock model. See QĐ-103.
  const { executeScene } = await import("@/services/batch-executor");
  await executeScene(sceneId);
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
    include: {
      scenes: {
        orderBy: { sceneNumber: "asc" },
        // The real audio source. A scene with lines uses them; only a scene
        // with none falls back to its single legacy audio file.
        include: {
          dialogueLines: {
            orderBy: { lineNumber: "asc" },
            // The speaker's name decides where a pause goes, so it has to come
            // along rather than be looked up per line later.
            include: { character: { select: { name: true } } },
          },
        },
      },
      idiom: true,
    },
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
    mixSettings: settings.audioMix,
    scenes: active.map((s) => ({
      sceneNumber: s.sceneNumber,
      duration: s.duration,
      subtitle: s.subtitle,
      videoPath: s.videoPath ? toAbsolute(s.videoPath) : null,
      audioPath: s.audioPath ? toAbsolute(s.audioPath) : null,
      imagePath: s.imagePath ? toAbsolute(s.imagePath) : null,
      dialogueLines: s.dialogueLines
        .filter((l) => l.status === "completed" && l.outputPath.length > 0)
        .map((l) => ({
          lineNumber: l.lineNumber,
          speaker: l.character?.name ?? "",
          text: l.text,
          audioPath: toAbsolute(l.outputPath),
          durationSec: l.durationSec,
          pauseAfterMs: l.pauseAfterMs,
        })),
    })),
  });

  // Say which audio pipeline ran and what the mix measured. A render that
  // silently used the legacy path would look identical in the UI otherwise.
  await logger.info({
    event: "render.audio",
    projectId,
    message:
      `Âm thanh: ${result.audioPipeline}` +
      (result.audioMetrics
        ? `, ${result.audioMetrics.integratedLufs.toFixed(1)} LUFS, ` +
          `${result.audioMetrics.truePeakDb.toFixed(2)} dBTP, ` +
          `${result.audioMetrics.durationSec.toFixed(2)}s`
        : "") +
      (result.audioWarnings.length > 0
        ? `, ${result.audioWarnings.length} cảnh báo`
        : ""),
  });
  for (const warning of result.audioWarnings) {
    await logger.warn({
      event: `audio.${warning.kind}`,
      projectId,
      message: `${warning.message} ${warning.suggestion}`,
    });
  }

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

  // The same output layout for every video, whoever asked for the render:
  // data/output/<slug>/final.mp4 + thumbnail + subtitles + metadata. Local
  // copy and one FFmpeg frame; a failure here never fails the render.
  try {
    const { exportProjectOutput } = await import("@/services/output-export");
    await exportProjectOutput(projectId);
  } catch (err) {
    await logger.warn({
      event: "output.export_failed",
      projectId,
      message: `Không xuất được thư mục output: ${errorMessage(err)}`,
    });
  }
  if (project.batchId) {
    await syncBatchActualCost(project.batchId);
    // Settle here rather than on a timer: the batch reaches its terminal state
    // through the same code path that produced the last video, so there is no
    // window where everything is finished and the batch still says RUNNING.
    await settleBatchIfDone(project.batchId);
  }

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
 * Turn an APPROVED batch plan into real projects, one at a time.
 *
 * Sequential on purpose. Expanding in parallel would write several scripts at
 * once and then discover, all at once, that the last two do not fit the budget -
 * after paying for their scripts. Walking the list in order means each video is
 * checked against the money that is actually left when its turn comes.
 *
 * Three checkpoints per video, and nothing is generated until all three pass:
 *
 *   1. is the approval still live?           cancelled or exhausted -> stop
 *   2. does the batch have room for it?      no -> EXHAUSTED, stop
 *   3. does the REAL script fit the per-video ceiling?
 *                                            no -> NEEDS_REVIEW, skip this one
 *
 * Checkpoint 3 is why the plan's estimate is not the safeguard. The plan priced
 * most videos from a reference profile because they had no script yet; here the
 * script exists, so the ceiling is re-checked against what the video really is.
 * A video that turns out expensive stops by itself rather than taking the batch
 * down with it.
 */
async function handleBatchExpand(job: Job): Promise<HandlerResult> {
  const batchId = job.batchId;
  if (!batchId) throw new Error("Job thiếu batchId.");
  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId } });
  if (auth?.status !== "APPROVED") {
    await logger.warn({
      event: "batch.expand_skipped",
      message:
        `Lô ${batchId} không có quyền chi đang hiệu lực (${auth?.status ?? "chưa duyệt"}), ` +
        `nên không chạy.`,
    });
    return { deferred: false, result: { skipped: "not_approved" } };
  }
  // SCHEDULING ONLY: the batch is run by the production executor - idioms into
  // projects, every scene, render, export, settle. One engine. QĐ-103.
  const { startRun } = await import("@/services/batch-executor");
  const summary = await startRun(batchId, { resume: true });
  return {
    deferred: false,
    result: {
      videos: summary.outcomes.length,
      completed: summary.outcomes.filter((o) => !o.stopped).length,
      settled: summary.settledStatus,
    },
  };
}

/**
 * Side effects for a job that has exhausted its retries.
 *
 * Marking the scene - not just the job - is what lets the renderer fail fast and
 * what puts a red badge on the right card in the storyboard. Shared by the
 * worker and the test harness so both agree on what "gave up" means.
 */
/** "INTERNAL.BAD_OUTPUT.CODE01: An unexpected error occurred." */
function withFailureCode(error: unknown): string {
  const text =
    error instanceof Error ? error.message : String(error ?? "Lỗi không xác định");
  if (!(error instanceof ProviderError)) return text;
  // Our own generic codes add noise rather than information; only a vendor code
  // is worth the prefix.
  const code = error.code;
  if (!code || code === "provider_error" || code === "generation_failed") return text;
  return text.startsWith(code) ? text : `${code}: ${text}`;
}

export async function onJobExhausted(
  job: Pick<Job, "projectId" | "sceneId" | "type">,
  error: unknown,
): Promise<void> {
  // Carry the vendor's machine code into the text a person will actually read.
  //
  // `error.message` on its own is the vendor's prose, and Runway's prose for a
  // model refusing a shot is "An unexpected error occurred." - which tells the
  // operator nothing and sent us looking in the wrong place for a week. The
  // code is the part that identifies the failure, so it goes in front.
  const message = withFailureCode(error);

  if (job.sceneId) {
    await prisma.scene
      .update({
        where: { id: job.sceneId },
        data: { status: "failed", errorMessage: message.slice(0, 1000) },
      })
      .catch(() => undefined);
  }

  if (job.projectId) {
    const project = await prisma.project
      .update({
        where: { id: job.projectId },
        data: { status: "failed", errorMessage: message.slice(0, 1000) },
      })
      .catch(() => null);

    // A failed video must not leave its batch stuck on RUNNING forever. One
    // failure does not end the batch - `settleBatchIfDone` only acts when
    // nothing is left running or queued - but it is the moment to check.
    if (project?.batchId) {
      await settleBatchIfDone(project.batchId).catch(() => undefined);
    }
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
