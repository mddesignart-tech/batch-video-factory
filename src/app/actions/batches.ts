"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { QUALITY_MODES } from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { errorMessage } from "@/lib/utils";
import { createAuthorization, DEFAULT_MAX_COST_PER_VIDEO } from "@/services/batch-authorization";
import { planBatch, type BatchPlan } from "@/services/batch-planner";
import {
  approveAndStart,
  batchProgress,
  cancelBatch,
  resumeBatch,
  retryScene,
  retryVideo,
  savePlan,
  storedPlan,
  type BatchProgress,
} from "@/services/batch-runner";
import type { ActionResult } from "./idioms";

/**
 * Batch Video Factory - the two-step flow, as two separate server actions.
 *
 * `analyseBatch` costs nothing and can be run as often as the operator likes.
 * `approveBatch` is the one that authorises money. Keeping them apart in the
 * API, not just in the UI, is what makes "press the button" and "agree to the
 * spending" two different acts rather than one.
 */

const PlanInput = z.object({
  name: z.string().min(1, "Cần tên lô"),
  amount: z.coerce.number().min(1).max(200),
  category: z.string().optional(),
  difficulty: z.string().optional(),
  stylePresetId: z.string().optional(),
  qualityMode: z.enum(QUALITY_MODES).default("BALANCED"),
  targetDuration: z.coerce.number().min(15).max(60).default(25),
  maxCostPerVideo: z.coerce
    .number()
    .min(0)
    .max(1000)
    .default(DEFAULT_MAX_COST_PER_VIDEO),
  concurrency: z.coerce.number().min(1).max(8).default(2),
  /** Comma-separated idiom ids, when the operator picked them by hand. */
  idiomIds: z.string().optional(),
  /**
   * A batch this form has already planned into, so re-planning updates it.
   *
   * Without this, every press of PHÂN TÍCH & DỰ TOÁN creates another row - and
   * the whole point of a free planning step is that people press it repeatedly
   * while they adjust the numbers. Encouraging that while littering the batch
   * list with abandoned drafts would make the good behaviour look messy.
   */
  batchId: z.string().optional(),
});

export interface PlanActionResult extends ActionResult {
  batchId?: string;
  plan?: BatchPlan;
}

/**
 * Step A - plan and cost, spending nothing.
 *
 * Creates the batch row in PLANNED and a DRAFT authorisation with a ceiling of
 * zero. A DRAFT authorises nothing: the gate in services/batch-authorization
 * refuses anything that is not APPROVED, so a batch can sit here indefinitely
 * and remain unable to spend.
 */
export async function analyseBatch(formData: FormData): Promise<PlanActionResult> {
  const parsed = PlanInput.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ.",
    };
  }
  const input = parsed.data;
  const idiomIds = (input.idiomIds ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  try {
    const fields = {
      name: input.name,
      amount: input.amount,
      category: input.category || null,
      difficulty: input.difficulty || null,
      stylePresetId: input.stylePresetId || null,
      qualityMode: input.qualityMode,
      targetDuration: input.targetDuration,
      concurrency: input.concurrency,
      maxCostPerVideo: input.maxCostPerVideo,
      // No money is authorised yet. maxBudget is set when the operator approves
      // a ceiling, not before.
      maxBudget: 0,
      status: "PLANNED",
    };

    // Re-plan into the same row when the form already has one AND that row has
    // not been approved. An approved batch is never re-planned here: swapping
    // the plan out from under an approval the operator already gave is the one
    // thing a frozen plan exists to prevent.
    const reusable = input.batchId
      ? await prisma.batch.findFirst({
          where: {
            id: input.batchId,
            status: "PLANNED",
            OR: [{ authorization: null }, { authorization: { status: "DRAFT" } }],
          },
        })
      : null;

    const batch = reusable
      ? await prisma.batch.update({ where: { id: reusable.id }, data: fields })
      : await prisma.batch.create({ data: fields });

    const plan = await planBatch(
      {
        idiomIds,
        category: input.category || null,
        difficulty: input.difficulty || null,
        amount: input.amount,
        qualityMode: input.qualityMode,
        targetDuration: input.targetDuration,
        maxCostPerVideo: input.maxCostPerVideo,
      },
      batch.id,
    );

    await savePlan(batch.id, plan);
    await createAuthorization({
      batchId: batch.id,
      estimatedCost: plan.estimatedTotal,
      maxCostPerVideo: plan.maxCostPerVideo,
      providerScope: plan.providerScope,
      videoCount: plan.runnableCount,
      qualityMode: input.qualityMode,
      note: `Dự toán lúc ${plan.generatedAt}`,
    });

    revalidatePath("/batches");
    return {
      ok: true,
      batchId: batch.id,
      plan,
      message:
        `Đã dự toán ${plan.videos.length} video: ${plan.runnableCount} chạy được, ` +
        `${plan.blockedCount} bị chặn. Tổng dự toán $${plan.estimatedTotal.toFixed(4)}. ` +
        `CHƯA chi đồng nào — cần bấm DUYỆT & CHẠY BATCH.`,
      details: plan.warnings,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Re-cost an existing batch against the current registry and ledger. */
export async function reanalyseBatch(batchId: string): Promise<PlanActionResult> {
  try {
    const batch = await prisma.batch.findUnique({ where: { id: batchId } });
    if (!batch) return { ok: false, message: "Không tìm thấy lô." };

    const auth = await prisma.batchAuthorization.findUnique({ where: { batchId } });
    if (auth?.status === "APPROVED") {
      // Re-planning an approved batch would swap the plan out from under an
      // approval the operator already gave, which is the one thing a frozen
      // plan exists to prevent.
      return {
        ok: false,
        message:
          "Lô này đã được duyệt chi. Hãy DỪNG BATCH trước nếu muốn dự toán lại — " +
          "đổi kế hoạch dưới một quyền chi đã cấp là thay đổi thứ người dùng đã đồng ý.",
      };
    }

    const idiomIds = JSON.parse(batch.idiomIdsJson || "[]") as string[];
    const plan = await planBatch(
      {
        idiomIds: Array.isArray(idiomIds) ? idiomIds : [],
        category: batch.category,
        difficulty: batch.difficulty,
        amount: batch.amount,
        qualityMode: batch.qualityMode as (typeof QUALITY_MODES)[number],
        targetDuration: batch.targetDuration,
        maxCostPerVideo: batch.maxCostPerVideo,
      },
      batch.id,
    );

    await savePlan(batch.id, plan);
    await createAuthorization({
      batchId: batch.id,
      estimatedCost: plan.estimatedTotal,
      maxCostPerVideo: plan.maxCostPerVideo,
      providerScope: plan.providerScope,
      videoCount: plan.runnableCount,
      qualityMode: batch.qualityMode as (typeof QUALITY_MODES)[number],
      note: `Dự toán lại lúc ${plan.generatedAt}`,
    });

    revalidatePath(`/batches/${batchId}`);
    revalidatePath("/batches");
    return {
      ok: true,
      batchId,
      plan,
      message: `Đã dự toán lại: $${plan.estimatedTotal.toFixed(4)} cho ${plan.runnableCount} video.`,
      details: plan.warnings,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * Step B - the one action that authorises spending.
 *
 * `authorizedMaxSpend` is the operator's number, taken from the form. It is not
 * derived from the estimate here: the whole point is that a human looked at the
 * estimate and decided what they are willing to lose.
 */
export async function approveBatch(
  batchId: string,
  authorizedMaxSpend: number,
): Promise<ActionResult> {
  try {
    if (!Number.isFinite(authorizedMaxSpend) || authorizedMaxSpend <= 0) {
      return {
        ok: false,
        message: "Hạn mức duyệt chi phải là một số lớn hơn 0.",
      };
    }
    const result = await approveAndStart({ batchId, authorizedMaxSpend });
    revalidatePath(`/batches/${batchId}`);
    revalidatePath("/batches");
    return { ok: true, message: result.message };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function stopBatch(batchId: string): Promise<ActionResult> {
  try {
    const { cancelledJobs, inFlight } = await cancelBatch(batchId);
    revalidatePath(`/batches/${batchId}`);
    revalidatePath("/batches");
    return {
      ok: true,
      message:
        `Đã dừng lô: huỷ ${cancelledJobs} job đang chờ, không gửi request trả phí nào nữa.` +
        (inFlight > 0
          ? ` ${inFlight} job đã gửi tới nhà cung cấp vẫn được theo dõi tới khi có kết ` +
            `quả — không huỷ được ở phía nhà cung cấp, và tiền đó có thể đã bị tính.`
          : ""),
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function continueBatch(batchId: string): Promise<ActionResult> {
  try {
    const { message } = await resumeBatch(batchId);
    revalidatePath(`/batches/${batchId}`);
    revalidatePath("/batches");
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function retryBatchVideo(projectId: string): Promise<ActionResult> {
  try {
    const { jobsQueued } = await retryVideo(projectId);
    revalidatePath("/batches");
    return {
      ok: jobsQueued > 0,
      message:
        jobsQueued > 0
          ? `Đã đưa ${jobsQueued} job của video này vào hàng đợi.`
          : "Video chưa chạy lại được. Xem thông báo lỗi trên thẻ dự án.",
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function retryBatchScene(sceneId: string): Promise<ActionResult> {
  try {
    await retryScene(sceneId);
    return { ok: true, message: "Đã đưa cảnh vào hàng đợi để tạo lại." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Read-only helpers for the pages. */
export async function getBatchProgress(batchId: string): Promise<BatchProgress | null> {
  return batchProgress(batchId);
}

export async function getStoredPlan(batchId: string): Promise<BatchPlan | null> {
  const batch = await prisma.batch.findUnique({ where: { id: batchId } });
  return batch ? storedPlan(batch) : null;
}
