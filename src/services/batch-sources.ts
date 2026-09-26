import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { errorMessage } from "@/lib/utils";
import type { QualityMode } from "@/domain/enums";
import { closeAuthorization } from "@/services/batch-authorization";
import { reservationLedger } from "@/services/cost-reservation";
import { isRunnable, storedPlan } from "@/services/batch-runner";

/**
 * Where a batch's videos come from. Two SOURCES, one production path:
 *
 *   IDIOM_GENERATED      the plan names idioms; each becomes a project whose
 *                        script is written by Text AI (a paid call, through the
 *                        ordinary gates) when the batch RUNS
 *   STORYBOARD_IMPORTED  the projects and scenes already exist as rows
 *
 * From "project and scenes exist" onwards there is no difference: the same
 * executor (batch-executor.ts) runs every scene, renders, exports and settles.
 * This module only turns idioms into projects - it never generates media and
 * never enqueues anything.
 */
export type BatchSource = "IDIOM_GENERATED" | "STORYBOARD_IMPORTED";

export async function batchSource(batchId: string): Promise<BatchSource> {
  const projects = await prisma.project.findMany({
    where: { batchId },
    select: { importFingerprint: true, scriptJson: true },
  });
  return projects.some((p) => p.importFingerprint !== null || (p.scriptJson ?? "").includes("IMPORT"))
    ? "STORYBOARD_IMPORTED"
    : "IDIOM_GENERATED";
}

/** Planned idiom videos that do not have a project yet. */
export async function pendingIdiomVideos(batchId: string): Promise<number> {
  const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
  const plan = storedPlan(batch);
  const runnable = (plan?.videos ?? []).filter((v) => v.idiomId && isRunnable(v.status));
  if (runnable.length === 0) return 0;
  const existing = await prisma.project.findMany({
    where: { batchId, idiomId: { in: runnable.map((v) => v.idiomId) } },
    select: { idiomId: true, status: true, scriptJson: true },
  });
  const done = new Set(existing.filter((p) => p.scriptJson).map((p) => p.idiomId));
  return runnable.filter((v) => !done.has(v.idiomId)).length;
}

/**
 * Re-price one video from its REAL script and hold it to the per-video ceiling.
 * Returns true when it may run; otherwise marks it needs_review with the reason.
 *
 * A plan with unroutable scenes is NOT a cheap plan - scenes that fail to route
 * cost nothing and would sail under any ceiling.
 */
export async function checkVideoAgainstCap(projectId: string, maxCostPerVideo: number): Promise<boolean> {
  const { previewProjectCost, freezeScenePlan } = await import("@/services/project-service");
  const preview = await previewProjectCost(projectId);
  const total = preview.current.breakdown.total;
  // A scene that wants a video model nobody approved stops this video - never
  // a silent still, never an unapproved model.
  if (preview.current.needsProvider.length > 0) {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        status: "needs_review",
        estimatedCost: total,
        errorMessage: `BLOCKED: ${preview.current.needsProvider.join(" | ")}`.slice(0, 1000),
      },
    });
    return false;
  }
  if (preview.current.errors.length > 0) {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        status: "needs_review",
        estimatedCost: total,
        errorMessage:
          `BLOCKED: Không định tuyến được ${preview.current.errors.length} cảnh, nên dự toán ` +
          `$${total.toFixed(6)} KHÔNG phản ánh công việc thật. ${preview.current.errors.join(" | ")}`,
      },
    });
    return false;
  }
  if (total > maxCostPerVideo + 1e-9) {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        status: "needs_review",
        estimatedCost: total,
        errorMessage:
          `BLOCKED: OVER_VIDEO_BUDGET — kịch bản thật tốn $${total.toFixed(6)}, vượt trần ` +
          `$${maxCostPerVideo.toFixed(2)} cho một video. Video này KHÔNG chạy; video khác không ảnh hưởng.`,
      },
    });
    return false;
  }
  // Freeze the motion decision and models the estimate was made with.
  await freezeScenePlan(projectId, preview);
  await prisma.project.update({ where: { id: projectId }, data: { estimatedCost: total } });
  return true;
}

export interface MaterializeResult {
  created: number;
  blocked: number;
  stoppedReason: string;
}

/**
 * IDIOM_GENERATED: turn the approved plan's idioms into projects with scripts.
 *
 * Resumable: an idiom that already has a project is not given a second one; a
 * project whose script died half-way is repaired rather than stranded. The
 * approval is re-read every iteration, and a video is only started when the
 * batch still has room for its forecast.
 */
export async function materializeIdiomVideos(batchId: string): Promise<MaterializeResult> {
  const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
  const plan = storedPlan(batch);
  const runnable = (plan?.videos ?? []).filter((v) => v.idiomId && isRunnable(v.status));
  const { createProjectForIdiom, generateProjectScript } = await import("@/services/project-service");

  let created = 0;
  let blocked = 0;
  let stoppedReason = "";
  for (const planned of runnable) {
    const live = await prisma.batchAuthorization.findUnique({ where: { batchId } });
    if (live?.status !== "APPROVED") {
      stoppedReason = `Quyền chi chuyển sang ${live?.status ?? "không còn"} giữa chừng. Không tạo thêm dự án.`;
      break;
    }
    const existing = await prisma.project.findFirst({ where: { batchId, idiomId: planned.idiomId } });
    if (existing) {
      if (!existing.scriptJson) {
        await logger.warn({
          event: "batch.repairing_script",
          projectId: existing.id,
          message: `Video "${planned.phrase}" có dự án nhưng chưa có kịch bản — viết lại kịch bản.`,
        });
        await generateProjectScript(existing.id);
        if (!(await checkVideoAgainstCap(existing.id, live.maxCostPerVideo))) blocked++;
      }
      continue;
    }
    const ledger = await reservationLedger(batchId, live.authorizedMaxSpend);
    if (ledger.available < planned.estimatedCost) {
      stoppedReason =
        `Hạn mức lô còn $${ledger.available.toFixed(6)}, không đủ cho video "${planned.phrase}" ` +
        `(dự toán $${planned.estimatedCost.toFixed(6)}). Dừng ở đây.`;
      await closeAuthorization(batchId, "EXHAUSTED", stoppedReason);
      break;
    }
    try {
      const project = await createProjectForIdiom({
        idiomId: planned.idiomId,
        qualityMode: batch.qualityMode as QualityMode,
        stylePresetId: batch.stylePresetId ?? undefined,
        targetDuration: batch.targetDuration,
        maxBudget: live.maxCostPerVideo,
        batchId,
        autoGenerateScript: true,
        autoStartMedia: false,
      });
      created++;
      if (!(await checkVideoAgainstCap(project.id, live.maxCostPerVideo))) blocked++;
    } catch (err) {
      blocked++;
      await logger.error({
        event: "batch.project_failed",
        message: `Không tạo được dự án cho "${planned.phrase}": ${errorMessage(err)}`,
      });
    }
  }
  if (stoppedReason) await logger.warn({ event: "batch.expand_stopped", message: stoppedReason });
  return { created, blocked, stoppedReason };
}
