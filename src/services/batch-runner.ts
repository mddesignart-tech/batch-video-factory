import type { Batch } from "@prisma/client";
import type { BatchStatus, VideoPlanStatus } from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parseJson, round } from "@/lib/utils";
import { enqueue } from "@/jobs/queue";
import {
  approveAuthorization,
  BatchAuthorizationError,
  closeAuthorization,
  resumeAuthorization,
} from "./batch-authorization";
import { reservationLedger, type ReservationLedger } from "./cost-reservation";
import type { BatchPlan, PlannedVideo } from "./batch-planner";

/**
 * Running an approved batch, and being able to stop.
 *
 * The shape the operator asked for, and the reason it is shaped that way:
 *
 *   plan    free, repeatable, contacts nobody
 *   approve one decision, one ceiling, one list of providers
 *   run     unattended - no per-scene prompts, because a prompt every scene is
 *           a prompt nobody reads
 *
 * "Unattended" is the part that has to be earned. A button that runs until the
 * money is gone is not a feature, so the run stops on its own for five
 * reasons, all of them checked without a human present:
 *
 *   BUDGET_EXHAUSTED  the authorised ceiling is reached
 *   NEEDS_REVIEW      a video is over its own ceiling, or needs a provider
 *   FAILED            work failed in a way a retry cannot fix
 *   CANCELLED         the operator pressed stop
 *   COMPLETED         there is nothing left to do
 */

export interface BatchProgressVideo {
  projectId: string;
  title: string;
  phrase: string;
  status: string;
  sceneCount: number;
  scenesCompleted: number;
  scenesFailed: number;
  localMotionScenes: number;
  aiVideoScenes: number;
  estimatedCost: number;
  actualCost: number;
  finalVideoPath: string | null;
  errorMessage: string | null;
  /** Per-stage progress, counted from the scene rows the pipeline writes. */
  imagesDone: number;
  clipsDone: number;
  voicesDone: number;
}

export interface BatchProgress {
  batch: Batch;
  status: BatchStatus;
  authorization: {
    status: string;
    authorizedMaxSpend: number;
    maxCostPerVideo: number;
    estimatedCost: number;
    providerScope: string[];
    approvedAt: Date | null;
    closedReason: string;
  } | null;
  ledger: ReservationLedger | null;
  videos: BatchProgressVideo[];
  counts: {
    total: number;
    completed: number;
    running: number;
    queued: number;
    failed: number;
    needsReview: number;
  };
  /** Videos in the approved plan that no project exists for yet. */
  notStarted: number;
}

/**
 * Store a costed plan on the batch and open a DRAFT approval.
 *
 * The plan is written to `planJson` verbatim rather than recomputed later.
 * Prices, model availability and the registry all move; "what did I agree to"
 * must not move with them.
 */
export async function savePlan(batchId: string, plan: BatchPlan): Promise<void> {
  await prisma.batch.update({
    where: { id: batchId },
    data: {
      planJson: JSON.stringify(plan),
      estimatedCost: plan.estimatedTotal,
      maxCostPerVideo: plan.maxCostPerVideo,
      amount: plan.videos.length,
      qualityMode: plan.qualityMode,
      idiomIdsJson: JSON.stringify(plan.videos.map((v) => v.idiomId)),
      status: "PLANNED",
    },
  });
}

export function storedPlan(batch: Pick<Batch, "planJson">): BatchPlan | null {
  const plan = parseJson<BatchPlan | null>(batch.planJson, null);
  return plan && Array.isArray(plan.videos) ? plan : null;
}

/**
 * Approve the stored plan and start the run.
 *
 * One call on purpose: the operator pressed one button, and splitting it would
 * leave a window where the money is authorised but nothing is running - a state
 * that looks identical to a batch that has quietly stalled.
 */
export async function approveAndStart(opts: {
  batchId: string;
  authorizedMaxSpend: number;
  note?: string;
}): Promise<{ started: boolean; message: string }> {
  const batch = await prisma.batch.findUnique({ where: { id: opts.batchId } });
  if (!batch) throw new Error("Không tìm thấy lô.");

  const plan = storedPlan(batch);
  if (!plan) {
    throw new BatchAuthorizationError(
      "Lô này chưa có bản dự toán. Hãy bấm PHÂN TÍCH & DỰ TOÁN trước khi duyệt.",
      "no_authorization",
    );
  }
  if (plan.runnableCount === 0) {
    throw new BatchAuthorizationError(
      "Không có video nào chạy được trong bản dự toán này. Hãy sửa nguyên nhân " +
        "ở cột trạng thái rồi dự toán lại.",
      "not_approved",
    );
  }

  await approveAuthorization({
    batchId: opts.batchId,
    authorizedMaxSpend: opts.authorizedMaxSpend,
    note: opts.note,
  });

  await prisma.batch.update({
    where: { id: opts.batchId },
    data: { status: "QUEUED", maxBudget: round(opts.authorizedMaxSpend, 6) },
  });

  // Expanding into projects happens in the queue: writing ten scripts is not
  // something an HTTP request should hold open.
  await enqueue({ type: "batch_expand", batchId: opts.batchId, priority: 10 });

  await logger.warn({
    event: "batch.started",
    message:
      `Lô "${batch.name}" được duyệt chi tối đa $${opts.authorizedMaxSpend.toFixed(2)} ` +
      `cho ${plan.runnableCount} video. Bắt đầu chạy.`,
  });

  return {
    started: true,
    message:
      `Đã duyệt và bắt đầu lô "${batch.name}": ${plan.runnableCount} video, ` +
      `hạn mức $${opts.authorizedMaxSpend.toFixed(2)}.`,
  };
}

/**
 * Stop the batch.
 *
 * Three things happen, and one deliberately does not:
 *
 *   - the approval is closed, so no further paid request passes the gate;
 *   - queued jobs are cancelled, because they have not started;
 *   - processing jobs are LEFT ALONE.
 *
 * That last one is the honest part. A request already accepted by Runway or
 * OpenAI is going to be billed whether or not this app is still watching, and
 * most of these vendors expose no cancel at all. Killing the job locally would
 * make the UI say "cancelled" while the money left anyway, and would throw away
 * the clip that was paid for. So in-flight work is followed to its result; it
 * is the last thing this batch spends.
 */
export async function cancelBatch(
  batchId: string,
  reason = "Người dùng bấm DỪNG BATCH.",
): Promise<{ cancelledJobs: number; inFlight: number }> {
  await closeAuthorization(batchId, "CANCELLED", reason);

  const cancelled = await prisma.job.updateMany({
    where: { batchId, status: "queued" },
    data: { status: "cancelled", finishedAt: new Date() },
  });

  // Scene jobs are keyed to the project, not the batch, so they have to be
  // found through it. Same rule: queued only.
  const projects = await prisma.project.findMany({
    where: { batchId },
    select: { id: true },
  });
  const projectIds = projects.map((p) => p.id);
  const cancelledScenes = await prisma.job.updateMany({
    where: { projectId: { in: projectIds }, status: "queued" },
    data: { status: "cancelled", finishedAt: new Date() },
  });

  const inFlight = await prisma.job.count({
    where: {
      status: "processing",
      OR: [{ batchId }, { projectId: { in: projectIds } }],
    },
  });

  await prisma.batch.update({ where: { id: batchId }, data: { status: "CANCELLED" } });

  await logger.warn({
    event: "batch.cancelled",
    message:
      `Dừng lô ${batchId}: huỷ ${cancelled.count + cancelledScenes.count} job đang chờ. ` +
      (inFlight > 0
        ? `${inFlight} job đã gửi đi vẫn được theo dõi tới khi có kết quả — ` +
          `nhà cung cấp có thể đã tính phí, huỷ phía ta không lấy lại được tiền.`
        : "Không có job nào đang chạy."),
  });

  return { cancelledJobs: cancelled.count + cancelledScenes.count, inFlight };
}

/**
 * Pick a stopped batch back up.
 *
 * Resuming re-uses the same authorisation, the same ceiling and the same spend
 * total. It creates no new permission - a batch that stopped because it ran out
 * of money cannot be resumed into more money, and says so.
 *
 * Nothing already finished is redone: expansion skips idioms that already have
 * a project, and every paid request finds its own reservation and ProviderJob
 * under the same idempotency key.
 */
export async function resumeBatch(batchId: string): Promise<{ message: string }> {
  await resumeAuthorization(batchId);
  await prisma.batch.update({ where: { id: batchId }, data: { status: "QUEUED" } });
  await enqueue({ type: "batch_expand", batchId, priority: 10 });

  await logger.warn({
    event: "batch.resumed",
    message:
      `Chạy tiếp lô ${batchId}. Giữ nguyên hạn mức và số tiền đã chi — ` +
      `resume KHÔNG cấp thêm quyền chi.`,
  });
  return { message: "Đã chạy tiếp lô. Công việc đã hoàn thành sẽ không làm lại." };
}

/** Put one video back in the queue without re-approving anything. */
export async function retryVideo(projectId: string): Promise<{ jobsQueued: number }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { scenes: { where: { skipped: false }, orderBy: { sceneNumber: "asc" } } },
  });
  if (!project) throw new Error("Không tìm thấy dự án.");
  if (!project.batchId) throw new Error("Dự án này không thuộc lô nào.");

  // The gate is re-asked for every request either way, so a retry cannot spend
  // outside the ceiling. What it must not do is bypass a CLOSED approval.
  const auth = await prisma.batchAuthorization.findUnique({
    where: { batchId: project.batchId },
  });
  if (auth?.status !== "APPROVED") {
    throw new BatchAuthorizationError(
      `Quyền chi của lô đang ở trạng thái ${auth?.status ?? "chưa có"}. ` +
        `Hãy chạy tiếp lô trước khi thử lại video này.`,
      "not_approved",
    );
  }

  const { generateProjectScript, startMediaGeneration } = await import(
    "./project-service"
  );

  // "Thử lại" is the button an operator presses on the row that looks broken,
  // so it has to handle the way a row actually breaks. A project whose script
  // generation died sits at `draft` with no scenes, and `startMediaGeneration`
  // refuses it for want of a script - which would make the retry button reply
  // "no script" forever on the one row it exists to rescue.
  if (!project.scriptJson || project.scenes.length === 0) {
    await logger.warn({
      event: "batch.repairing_script",
      projectId,
      message: "Dự án chưa có kịch bản (lần tạo trước hỏng). Đang viết lại trước khi tạo media.",
    });
    await generateProjectScript(projectId);
  }

  const result = await startMediaGeneration(projectId, { skipBudgetPrompt: true });
  return { jobsQueued: result.jobsQueued };
}

/**
 * Retry ONE scene.
 *
 * Bumps `retryCount`, which changes the idempotency key. That is the whole
 * mechanism: a transient failure reuses the key and resumes the vendor job for
 * free, while an explicit retry deliberately buys a new one - and the operator
 * asking for this has said which they want.
 */
export async function retryScene(sceneId: string): Promise<void> {
  const scene = await prisma.scene.findUnique({
    where: { id: sceneId },
    include: { project: true },
  });
  if (!scene) throw new Error("Không tìm thấy cảnh.");

  await prisma.scene.update({
    where: { id: sceneId },
    data: { retryCount: { increment: 1 }, status: "pending", errorMessage: null },
  });
  await enqueue({
    type: "generate_scene_media",
    sceneId,
    projectId: scene.projectId,
    priority: 100 + scene.sceneNumber,
  });

  // Revive the render this scene took down with it.
  //
  // `handleRenderFinal` refuses outright when a scene has given up - waiting on
  // one that will never produce media is waiting forever - so it burns its
  // attempts and ends `failed`. Fixing the scene afterwards then leaves the
  // video one job short of finished, with nothing in the queue to notice: the
  // project sits at `rendering` for good, and the only symptom is an MP4 that
  // never appears. An operator retrying a scene is trying to finish the video,
  // so the render goes back in the queue behind it.
  const render = await prisma.job.findFirst({
    where: { projectId: scene.projectId, type: "render_final", status: "failed" },
    orderBy: { createdAt: "desc" },
  });
  if (render) {
    await prisma.job.update({
      where: { id: render.id },
      data: {
        status: "queued",
        attempts: 0,
        error: null,
        finishedAt: null,
        nextRunAt: new Date(),
        // The deferral counter is per attempt at rendering, not per lifetime.
        payloadJson: "{}",
      },
    });
    await logger.info({
      event: "render.requeued_after_retry",
      projectId: scene.projectId,
      sceneId,
      message:
        `Đã xếp lại bước render của dự án: nó từng hỏng vì cảnh ${scene.sceneNumber} ` +
        `không có media, và cảnh đó vừa được cho chạy lại.`,
    });
  }
}

/** Everything the batch detail page needs, in one read. */
export async function batchProgress(batchId: string): Promise<BatchProgress | null> {
  const batch = await prisma.batch.findUnique({ where: { id: batchId } });
  if (!batch) return null;

  const [auth, projects] = await Promise.all([
    prisma.batchAuthorization.findUnique({ where: { batchId } }),
    prisma.project.findMany({
      where: { batchId },
      orderBy: { createdAt: "asc" },
      include: {
        idiom: { select: { phrase: true } },
        scenes: {
          where: { skipped: false },
          select: {
            status: true,
            motionSource: true,
            imagePath: true,
            videoPath: true,
            audioPath: true,
          },
        },
      },
    }),
  ]);

  const ledger = auth
    ? await reservationLedger(batchId, auth.authorizedMaxSpend)
    : null;

  const videos: BatchProgressVideo[] = projects.map((p) => ({
    projectId: p.id,
    title: p.title,
    phrase: p.idiom.phrase,
    status: p.status,
    sceneCount: p.scenes.length,
    scenesCompleted: p.scenes.filter((s) => s.status === "completed").length,
    scenesFailed: p.scenes.filter((s) => s.status === "failed").length,
    localMotionScenes: p.scenes.filter((s) => s.motionSource === "LOCAL_MOTION").length,
    aiVideoScenes: p.scenes.filter((s) => s.motionSource !== "LOCAL_MOTION").length,
    estimatedCost: p.estimatedCost,
    actualCost: p.actualCost,
    finalVideoPath: p.finalVideoPath,
    errorMessage: p.errorMessage,
    imagesDone: p.scenes.filter((s) => s.imagePath).length,
    clipsDone: p.scenes.filter((s) => s.motionSource !== "LOCAL_MOTION" && s.videoPath).length,
    voicesDone: p.scenes.filter((s) => s.audioPath).length,
  }));

  const counts = {
    total: videos.length,
    completed: videos.filter((v) => v.status === "completed").length,
    running: videos.filter((v) =>
      ["media_generating", "rendering"].includes(v.status),
    ).length,
    queued: videos.filter((v) =>
      ["draft", "script_ready", "media_ready"].includes(v.status),
    ).length,
    failed: videos.filter((v) => v.status === "failed").length,
    needsReview: videos.filter((v) =>
      ["needs_review", "budget_exhausted"].includes(v.status),
    ).length,
  };

  const plan = storedPlan(batch);

  return {
    batch,
    status: batch.status as BatchStatus,
    authorization: auth
      ? {
          status: auth.status,
          authorizedMaxSpend: auth.authorizedMaxSpend,
          maxCostPerVideo: auth.maxCostPerVideo,
          estimatedCost: auth.estimatedCost,
          providerScope: parseJson<string[]>(auth.providerScopeJson, []),
          approvedAt: auth.approvedAt,
          closedReason: auth.closedReason,
        }
      : null,
    ledger,
    videos,
    counts,
    notStarted: Math.max(0, (plan?.runnableCount ?? batch.amount) - videos.length),
  };
}

/**
 * Settle a batch that has nothing left to do.
 *
 * Called after each video finishes rather than on a timer, so the terminal
 * state is reached by the same code path that produced it.
 */
export async function settleBatchIfDone(batchId: string): Promise<BatchStatus | null> {
  const progress = await batchProgress(batchId);
  if (!progress) return null;
  if (progress.counts.running > 0 || progress.counts.queued > 0) return null;

  // Videos in the plan that no project exists for yet mean expansion has more
  // to do - but ONLY while the approval is still live. A batch that stopped
  // because it ran out of money, or because the operator cancelled, will never
  // start those videos, and waiting for them would leave it reading RUNNING
  // forever with nothing running.
  const approvalLive = progress.authorization?.status === "APPROVED";
  if (progress.notStarted > 0 && approvalLive) return null;

  const { counts } = progress;
  let status: BatchStatus = "COMPLETED";
  let reason = "Mọi video trong lô đã xong.";

  if (progress.authorization?.status === "CANCELLED") {
    status = "CANCELLED";
    reason = progress.authorization.closedReason;
  } else if (progress.authorization?.status === "EXHAUSTED") {
    status = "BUDGET_EXHAUSTED";
    reason = "Đã dùng hết hạn mức được duyệt.";
  } else if (counts.needsReview > 0) {
    status = "NEEDS_REVIEW";
    reason = `${counts.needsReview} video cần người xem lại.`;
  } else if (counts.failed > 0 && counts.completed === 0) {
    status = "FAILED";
    reason = "Không video nào hoàn thành.";
  } else if (counts.failed > 0) {
    status = "NEEDS_REVIEW";
    reason = `${counts.failed} video thất bại, ${counts.completed} video hoàn thành.`;
  }

  await prisma.batch.update({ where: { id: batchId }, data: { status } });
  if (status === "COMPLETED" && progress.authorization?.status === "APPROVED") {
    await closeAuthorization(batchId, "COMPLETED", reason);
  }
  await logger.info({
    event: "batch.settled",
    message: `Lô ${batchId} kết thúc ở trạng thái ${status}. ${reason}`,
  });
  return status;
}

/** Plan-row lookup used by expansion, so the runner and the plan cannot drift. */
export function plannedVideoFor(
  plan: BatchPlan | null,
  idiomId: string,
): PlannedVideo | null {
  return plan?.videos.find((v) => v.idiomId === idiomId) ?? null;
}

export function isRunnable(status: VideoPlanStatus): boolean {
  return status === "OK";
}
