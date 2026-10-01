import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { isRunning, isVideoRunning } from "./run-registry";
import { settleBatchIfDone } from "./batch-runner";

/**
 * After the app restarts (V1.2 Phase 6, QĐ-114).
 *
 * A run lives in this process: its locks and its promise die with it. A video
 * the database still calls media_generating / rendering, with no run holding
 * it, is not running - it was INTERRUPTED. Left alone it would read "ĐANG TẠO"
 * forever and no button would be offered.
 *
 * So, once at startup, and never for a video some run in this process holds:
 *
 *   video media_generating / rendering  -> failed, "INTERRUPTED: ..." (resumable;
 *                                          TIẾP TỤC reuses everything that exists)
 *   batch RUNNING with no run            -> settled from its videos
 *
 * Nothing is sent. A paid request that was in flight is still a ProviderJob and
 * the per-video plan reports it as NEEDS_RECOVERY (paid-recovery.ts), which
 * takes precedence: the person checks it, nothing re-POSTs by itself. Ledger,
 * reservations and ProviderJobs are not touched here - money settles through
 * the same code as always when the person continues.
 */
export const INTERRUPTED_PREFIX = "INTERRUPTED:";

export async function reconcileInterruptedRuns(): Promise<{ videos: number; batches: number }> {
  const stuck = await prisma.project.findMany({
    where: { status: { in: ["media_generating", "rendering"] } },
    select: { id: true, title: true, batchId: true, status: true, currentStep: true },
  });
  let videos = 0;
  const batchIds = new Set<string>();
  for (const p of stuck) {
    if (isVideoRunning(p.id)) continue;
    if (p.batchId && isRunning(p.batchId)) continue;
    await prisma.project.update({
      where: { id: p.id },
      data: {
        status: "failed",
        currentStep: null,
        runFinishedAt: new Date(),
        errorMessage:
          `${INTERRUPTED_PREFIX} ứng dụng đã khởi động lại khi video đang ở bước "${p.currentStep ?? p.status}". ` +
          "Bấm TIẾP TỤC — phần đã có được dùng lại; không có yêu cầu trả phí nào được gửi tự động.",
      },
    });
    videos += 1;
    if (p.batchId) batchIds.add(p.batchId);
  }
  const runningBatches = await prisma.batch.findMany({ where: { status: "RUNNING" }, select: { id: true } });
  for (const b of runningBatches) if (!isRunning(b.id)) batchIds.add(b.id);
  let batches = 0;
  for (const id of batchIds) {
    if (isRunning(id)) continue;
    const settled = await settleBatchIfDone(id);
    if (settled === null) {
      // Videos still waiting inside the approval: nothing runs them now.
      await prisma.batch.update({ where: { id }, data: { status: "NEEDS_REVIEW" } });
    }
    batches += 1;
  }
  if (videos > 0 || batches > 0) {
    await logger.warn({
      event: "app.restart_recovery",
      message: `Khởi động lại: ${videos} video bị gián đoạn → CẦN XỬ LÝ (TIẾP TỤC); ${batches} lô được xếp lại trạng thái. Không gửi yêu cầu nào.`,
    });
  }
  return { videos, batches };
}

export function isInterrupted(errorMessage: string | null | undefined): boolean {
  return (errorMessage ?? "").startsWith(INTERRUPTED_PREFIX);
}
