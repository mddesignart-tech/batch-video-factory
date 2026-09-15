import path from "node:path";
import type { Job } from "@prisma/client";
import type { JobType, QualityMode } from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { errorMessage, parseJson } from "@/lib/utils";
import { ProviderError } from "@/providers/types";
import { getSettings } from "@/lib/settings";
import { projectSubdir, toAbsolute, toRelative } from "@/lib/paths";
import {
  evaluateScene,
  generateSceneImage,
  generateSceneVideo,
  generateSceneVoice,
} from "@/services/generation";
import { syncBatchActualCost, syncProjectActualCost } from "@/services/cost-tracker";
import { closeAuthorization } from "@/services/batch-authorization";
import { reservationLedger } from "@/services/cost-reservation";
import { isRunnable, settleBatchIfDone, storedPlan } from "@/services/batch-runner";
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

  const batch = await prisma.batch.findUnique({ where: { id: batchId } });
  if (!batch) throw new Error(`Không tìm thấy lô ${batchId}`);

  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId } });
  if (auth?.status !== "APPROVED") {
    // Not an error: this is a batch that was stopped, or never approved. Saying
    // so and returning beats throwing, which would retry three times and log
    // three stack traces for a perfectly ordinary state.
    await logger.warn({
      event: "batch.expand_skipped",
      message:
        `Lô ${batchId} không có quyền chi đang hiệu lực ` +
        `(${auth?.status ?? "chưa duyệt"}), nên không mở rộng thành dự án.`,
    });
    return { deferred: false, result: { created: 0, skipped: "not_approved" } };
  }

  const plan = storedPlan(batch);
  const runnable = (plan?.videos ?? []).filter((v) => isRunnable(v.status));
  if (runnable.length === 0) {
    throw new Error(
      "Bản dự toán của lô không có video nào chạy được. Hãy dự toán lại.",
    );
  }

  await prisma.batch.update({ where: { id: batchId }, data: { status: "RUNNING" } });

  const { createProjectForIdiom } = await import("@/services/project-service");

  let created = 0;
  let skipped = 0;
  let stoppedReason = "";

  for (const planned of runnable) {
    // 1 - the approval can be revoked mid-expansion, by a cancel or by the gate
    // closing it on exhaustion. Re-read it every iteration rather than trusting
    // the copy taken before the loop.
    const live = await prisma.batchAuthorization.findUnique({ where: { batchId } });
    if (live?.status !== "APPROVED") {
      stoppedReason =
        `Quyền chi chuyển sang ${live?.status ?? "không còn"} giữa chừng. ` +
        `Dừng mở rộng, không tạo thêm dự án.`;
      break;
    }

    // Already expanded on an earlier run. A resume must not buy a second script
    // for a video that already has one.
    const existing = await prisma.project.findFirst({
      where: { batchId, idiomId: planned.idiomId },
    });
    if (existing) {
      // A project whose script generation died leaves a row at `draft` with no
      // scenes. That state is a dead end everywhere else: `startMediaGeneration`
      // refuses it ("chưa có kịch bản"), and so does the retry button - so the
      // video could never be recovered by resuming, only by hand.
      //
      // Seen for real: a SQLite socket timeout during expansion killed the third
      // video's script and left it stranded while the other two finished. The
      // error was transient; the stranding was permanent, and that is the part
      // worth fixing.
      if (existing.status === "draft" && !existing.scriptJson) {
        await logger.warn({
          event: "batch.repairing_script",
          projectId: existing.id,
          message:
            `Video "${planned.phrase}" có dự án nhưng chưa có kịch bản — ` +
            `lần tạo trước hỏng giữa chừng. Đang viết lại kịch bản.`,
        });
        const { generateProjectScript } = await import("@/services/project-service");
        await generateProjectScript(existing.id);
      }

      // A project stopped for review stays stopped: restarting it here would
      // spend money on exactly the thing a human was asked about.
      const current = await prisma.project.findUniqueOrThrow({
        where: { id: existing.id },
      });
      if (current.status === "draft" || current.status === "script_ready") {
        await startMediaForBatchVideo(current.id, live.maxCostPerVideo);
      }
      continue;
    }

    // 2 - room in the batch for this video's forecast, counting money already
    // held by requests in flight.
    const ledger = await reservationLedger(batchId, live.authorizedMaxSpend);
    if (ledger.available < planned.estimatedCost) {
      stoppedReason =
        `Hạn mức lô còn $${ledger.available.toFixed(6)}, không đủ cho video ` +
        `"${planned.phrase}" (dự toán $${planned.estimatedCost.toFixed(6)}). ` +
        `Dừng ở đây thay vì bắt đầu một video chắc chắn không chạy hết được.`;
      await closeAuthorization(batchId, "EXHAUSTED", stoppedReason);
      break;
    }

    try {
      // Writing the script is a paid text call, but a cheap one, and it has to
      // happen before the video can be priced honestly. It goes through the
      // ordinary spend guard like everything else.
      const project = await createProjectForIdiom({
        idiomId: planned.idiomId,
        qualityMode: batch.qualityMode as QualityMode,
        stylePresetId: batch.stylePresetId ?? undefined,
        targetDuration: batch.targetDuration,
        // The per-video ceiling IS this project's MAX BUDGET. Splitting the
        // batch budget evenly - what this used to do - let one video quietly
        // take a share that had been sized for several.
        maxBudget: live.maxCostPerVideo,
        batchId,
        autoGenerateScript: true,
        // Media starts below, AFTER the real script has been re-checked against
        // the ceiling. Starting it here would skip checkpoint 3.
        autoStartMedia: false,
      });

      const started = await startMediaForBatchVideo(project.id, live.maxCostPerVideo);
      if (started) created++;
      else skipped++;
    } catch (err) {
      skipped++;
      await logger.error({
        event: "batch.project_failed",
        message: `Không tạo được dự án cho "${planned.phrase}": ${errorMessage(err)}`,
      });
    }
  }

  if (stoppedReason) {
    await logger.warn({ event: "batch.expand_stopped", message: stoppedReason });
  }

  await settleBatchIfDone(batchId);

  return {
    deferred: false,
    result: { created, skipped, requested: runnable.length, stoppedReason },
  };
}

/**
 * Re-check one video against the per-video ceiling using its REAL script, then
 * start it or stop it.
 *
 * Returns whether media generation actually started. False is not a failure: it
 * means the video was correctly refused, and the project carries a status and a
 * message saying which refusal it was.
 */
async function startMediaForBatchVideo(
  projectId: string,
  maxCostPerVideo: number,
): Promise<boolean> {
  const { previewProjectCost, startMediaGeneration } = await import(
    "@/services/project-service"
  );

  const preview = await previewProjectCost(projectId);
  const total = preview.current.breakdown.total;

  // A plan that could not be routed is NOT a cheap plan.
  //
  // Scenes that fail to route cost nothing, so a video whose every scene was
  // refused totals about $0 and sails through the ceiling check below - then
  // starts, and fails one scene at a time at generation time. The codebase
  // already learned this once, in `withinBudget`: "an incomplete plan is not an
  // affordable one". This call site had the same hole.
  if (preview.current.errors.length > 0) {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        status: "needs_review",
        estimatedCost: total,
        errorMessage:
          `Không định tuyến được ${preview.current.errors.length} cảnh, nên dự ` +
          `toán $${total.toFixed(6)} KHÔNG phản ánh công việc thật. ` +
          preview.current.errors.join(" | "),
      },
    });
    await logger.warn({
      event: "batch.plan_incomplete",
      projectId,
      message: preview.current.errors.join(" | "),
    });
    return false;
  }

  if (total > maxCostPerVideo) {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        status: "needs_review",
        estimatedCost: total,
        errorMessage:
          `OVER_VIDEO_BUDGET: kịch bản thật tốn $${total.toFixed(6)}, vượt hạn mức ` +
          `$${maxCostPerVideo.toFixed(2)} cho một video. Video này KHÔNG chạy; ` +
          `các video khác trong lô không bị ảnh hưởng.`,
      },
    });
    await logger.warn({
      event: "batch.over_video_budget",
      projectId,
      estimatedCost: total,
      message:
        `Video vượt hạn mức/video ($${total.toFixed(6)} > ` +
        `$${maxCostPerVideo.toFixed(2)}). Đánh dấu OVER_VIDEO_BUDGET.`,
    });
    return false;
  }

  // skipBudgetPrompt means "the money was approved for the whole batch, stop
  // asking". It does NOT wave through a scene with no usable provider - that
  // check lives in startMediaGeneration and refuses either way.
  const result = await startMediaGeneration(projectId, { skipBudgetPrompt: true });
  return result.started;
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
