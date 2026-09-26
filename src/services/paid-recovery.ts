import type { ProviderJob } from "@prisma/client";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { toAbsolute } from "@/lib/paths";

/**
 * Paid requests whose outcome is not settled - NEEDS_RECOVERY (V1.2 Phase 3,
 * QĐ-110).
 *
 * Two shapes, both of which must NEVER be answered with a second automatic
 * POST, because the first one may already have been billed:
 *
 *   IN_FLIGHT          a job the vendor accepted (it has a task id) that is still
 *                      pending/processing with nothing watching it - an app that
 *                      stopped mid-poll. RECOVER re-attaches and polls: a GET,
 *                      never a new create.
 *   POSSIBLY_CHARGED   a job that failed AFTER the request may have left: its
 *                      reservation was settled as billed (COMMITTED), or the
 *                      vendor took it (task id) without saying it was free.
 *                      Retrying under the same key would find that reservation,
 *                      hold no new money, and buy again - so it is refused until
 *                      a person has looked and said so (acknowledgeRecovery).
 *
 * A failure the vendor confirmed free, or one that never left this machine
 * (reservation RELEASED), is an ordinary FAILED step: safe to retry by policy.
 * The mock provider never bills anything and is never in recovery.
 */

export type RecoveryReason = "IN_FLIGHT" | "POSSIBLY_CHARGED";

export interface RecoveryItem {
  providerJobId: string;
  sceneId: string | null;
  kind: string;
  provider: string;
  model: string;
  externalId: string | null;
  reason: RecoveryReason;
  message: string;
}

export const RECOVERY_MESSAGE =
  "Yêu cầu trước có thể đã phát sinh chi phí. Cần kiểm tra trước khi gửi lại.";

/** Could this failed job have been billed? */
export async function jobPossiblyBilled(
  job: Pick<ProviderJob, "provider" | "idempotencyKey" | "externalId" | "billedUnits">,
): Promise<boolean> {
  if (job.provider === "mock") return false;
  // The vendor said it charged nothing: a fact beats any inference.
  // (ProviderJob.actualCost defaults to 0, so only billedUnits carries that fact.)
  if (job.billedUnits === 0) return false;
  const reservation = await prisma.costReservation.findUnique({
    where: { idempotencyKey: job.idempotencyKey },
    select: { status: true },
  });
  // Inside a batch the settlement already answered it: RELEASED = the request
  // never left (or was confirmed free); COMMITTED = it may have been billed.
  if (reservation) return reservation.status === "COMMITTED";
  // Outside a batch: the vendor accepted it if it handed back a task id.
  return job.externalId !== null;
}

/** Does the scene already hold the asset this job was buying? Then it is history, not a problem. */
function assetPresent(
  kind: string,
  scene: { imagePath: string | null; videoPath: string | null; audioPath: string | null } | null,
  linesDone: boolean,
): boolean {
  const onDisk = (p: string | null) => Boolean(p && fs.existsSync(toAbsolute(p)));
  if (!scene) return false;
  if (kind === "image") return onDisk(scene.imagePath);
  if (kind === "video") return onDisk(scene.videoPath);
  if (kind === "audio") return linesDone || onDisk(scene.audioPath);
  return false;
}

/** Every unsettled paid request of one video, oldest first. */
export async function recoveryItemsForProject(
  projectId: string,
  opts: { isActive?: boolean } = {},
): Promise<RecoveryItem[]> {
  const jobs = await prisma.providerJob.findMany({
    where: {
      projectId,
      provider: { not: "mock" },
      status: { in: ["pending", "processing", "failed"] },
      kind: { in: ["image", "video", "audio"] },
    },
    orderBy: { createdAt: "asc" },
  });
  const items: RecoveryItem[] = [];
  for (const job of jobs) {
    // Archived by acknowledgeRecovery: checked by a person, kept for history.
    if (job.idempotencyKey.includes("#reviewed-")) continue;
    const scene = job.sceneId
      ? await prisma.scene.findUnique({
          where: { id: job.sceneId },
          select: { imagePath: true, videoPath: true, audioPath: true, dialogueLines: { select: { status: true } } },
        })
      : null;
    const linesDone = Boolean(scene && scene.dialogueLines.length > 0 && scene.dialogueLines.every((l) => l.status === "completed"));
    if (assetPresent(job.kind, scene, linesDone)) continue;

    if (job.status === "pending" || job.status === "processing") {
      // Being watched right now by a live run: not orphaned.
      if (opts.isActive || !job.externalId) continue;
      items.push({
        providerJobId: job.id,
        sceneId: job.sceneId,
        kind: job.kind,
        provider: job.provider,
        model: job.model,
        externalId: job.externalId,
        reason: "IN_FLIGHT",
        message: `${job.kind} ${job.provider}/${job.model} (task ${job.externalId}) đã được nhà cung cấp nhận nhưng chưa có kết quả. ${RECOVERY_MESSAGE}`,
      });
    } else if (await jobPossiblyBilled(job)) {
      items.push({
        providerJobId: job.id,
        sceneId: job.sceneId,
        kind: job.kind,
        provider: job.provider,
        model: job.model,
        externalId: job.externalId,
        reason: "POSSIBLY_CHARGED",
        message:
          `${job.kind} ${job.provider}/${job.model}${job.externalId ? ` (task ${job.externalId})` : ""} thất bại sau khi ` +
          `có thể đã gửi đi${job.error ? ` — ${job.error.slice(0, 160)}` : ""}. ${RECOVERY_MESSAGE}`,
      });
    }
  }
  return items;
}

/**
 * A person has checked the vendor and accepts that the earlier request is
 * spent (or never produced anything usable). Its job and its reservation are
 * ARCHIVED under a new key - history and the money already counted both stay -
 * which frees the original key for a NEW purchase that goes through every gate
 * again: its own reservation, the four spend limits, the approval. Nothing is
 * sent by this call.
 */
export async function acknowledgeRecovery(providerJobId: string, note = ""): Promise<{ archivedKey: string }> {
  const job = await prisma.providerJob.findUniqueOrThrow({ where: { id: providerJobId } });
  if (job.status !== "failed") {
    throw new Error(
      `Job ${job.kind} đang ở trạng thái ${job.status} — chỉ xác nhận được job đã THẤT BẠI. Job đang chờ thì bấm KIỂM TRA để theo dõi tiếp (không gửi lại).`,
    );
  }
  const archivedKey = `${job.idempotencyKey}#reviewed-${Date.now().toString(36)}`;
  await prisma.$transaction([
    prisma.costReservation.updateMany({ where: { idempotencyKey: job.idempotencyKey }, data: { idempotencyKey: archivedKey } }),
    prisma.providerJob.update({ where: { id: job.id }, data: { idempotencyKey: archivedKey } }),
  ]);
  await logger.warn({
    event: "provider.recovery_acknowledged",
    provider: job.provider,
    model: job.model,
    projectId: job.projectId ?? undefined,
    sceneId: job.sceneId ?? undefined,
    message:
      `Đã xác nhận kiểm tra job ${job.kind} thất bại (${job.externalId ?? "không có task id"}). Tiền đã tính giữ nguyên; ` +
      `lần mua sau (nếu có) là một yêu cầu MỚI, qua đủ cổng chi.${note ? ` Ghi chú: ${note}` : ""}`,
  });
  return { archivedKey };
}
