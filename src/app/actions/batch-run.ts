"use server";

import { revalidatePath } from "next/cache";
import { errorMessage } from "@/lib/utils";
import {
  approveAndRun,
  isRunning,
  preflightForApproval,
  resumeRun,
  type ApprovalPreflight,
} from "@/services/batch-executor";
import { exportProjectOutput } from "@/services/output-export";
import type { ActionResult } from "./idioms";
import {
  buildBatchResumePlans,
  continueAllEligible,
  continueVideo,
  recoverVideo,
  type ContinueAllResult,
  type ContinueResult,
  type VideoResumePlan,
} from "@/services/video-resume";
import { acknowledgeRecovery, type RecoveryItem } from "@/services/paid-recovery";

/**
 * The UI side of the production executor. Every button here calls the SAME
 * functions the CLI does (src/services/batch-executor.ts) - there is no UI
 * pipeline. Preflight spends nothing. DUYỆT & CHẠY approves the amount the
 * person typed and starts the run in the background; the page then follows it
 * by polling the batch's rows.
 */

export interface PreflightResult extends ActionResult {
  preflight?: ApprovalPreflight;
}

export async function preflightBatch(
  batchId: string,
  opts: { maxBatch?: number; maxPerVideo?: number; resume?: boolean } = {},
): Promise<PreflightResult> {
  try {
    const preflight = await preflightForApproval(batchId, opts);
    return {
      ok: preflight.ready,
      message: preflight.ready
        ? "Preflight đạt. Chưa gọi API nào, chưa chi đồng nào."
        : "Preflight chưa đạt — xem các dòng HỎNG.",
      preflight,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function approveAndRunBatch(input: {
  batchId: string;
  maxBatch: number;
  maxPerVideo?: number;
  lowAutoApproved: boolean;
  /** The person ticked "tôi đồng ý chi tối đa $X". */
  confirmed: boolean;
}): Promise<ActionResult> {
  try {
    if (!input.confirmed) {
      return { ok: false, message: "Chưa xác nhận hạn mức chi. Không chạy." };
    }
    await approveAndRun({
      batchId: input.batchId,
      maxBatch: input.maxBatch,
      maxPerVideo: input.maxPerVideo,
      lowAutoApproved: input.lowAutoApproved,
    });
    revalidatePath(`/batches/${input.batchId}`);
    revalidatePath("/batches");
    return {
      ok: true,
      message:
        `Đã duyệt tối đa $${input.maxBatch.toFixed(2)} và bắt đầu chạy. ` +
        `Mỗi asset 1 lần gọi trả phí, không tự thử lại, không đổi model.`,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function resumeBatchRun(batchId: string, projectId?: string): Promise<ActionResult> {
  try {
    await resumeRun({ batchId, onlyProjectIds: projectId ? [projectId] : undefined });
    revalidatePath(`/batches/${batchId}`);
    return {
      ok: true,
      message:
        "Đang chạy tiếp. Không duyệt lại tiền; asset đã xong được dùng lại, " +
        "chỉ phần còn thiếu mới được tạo; lỗi chỉ ở render thì chỉ render lại.",
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function batchIsRunning(batchId: string): Promise<boolean> {
  return isRunning(batchId);
}

export async function exportOutput(projectId: string): Promise<ActionResult> {
  try {
    const dir = await exportProjectOutput(projectId);
    return { ok: true, message: `Đã xuất: ${dir}` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

// ------------------------------------------------ per-video resume (QĐ-110) ---

/** Every video's own resume plan. Reads only. */
export async function videoResumePlans(batchId: string): Promise<{ ok: boolean; message: string; plans?: VideoResumePlan[] }> {
  try {
    return { ok: true, message: "", plans: await buildBatchResumePlans(batchId) };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** TIẾP TỤC one video. Without confirmPaid, paid work only answers NEEDS_CONFIRMATION. */
export async function continueVideoAction(projectId: string, confirmPaid: boolean): Promise<ContinueResult & { ok: boolean }> {
  try {
    const r = await continueVideo(projectId, { confirmPaid });
    const plan = r.plan;
    if (plan) revalidatePath(`/batches/${plan.batchId}`);
    return { ...r, ok: r.status === "STARTED" || r.status === "NOOP" || r.status === "NEEDS_CONFIRMATION" };
  } catch (err) {
    return { ok: false, status: "BLOCKED", message: errorMessage(err) };
  }
}

/** TIẾP TỤC TẤT CẢ VIDEO ĐỦ ĐIỀU KIỆN. */
export async function continueAllAction(batchId: string, confirmPaid: boolean): Promise<ContinueAllResult & { ok: boolean }> {
  try {
    const r = await continueAllEligible(batchId, { confirmPaid });
    revalidatePath(`/batches/${batchId}`);
    return { ...r, ok: r.status !== "BLOCKED" };
  } catch (err) {
    return { ok: false, status: "BLOCKED", message: errorMessage(err), runnable: [], skipped: [], authorizationAmount: 0 };
  }
}

/** KIỂM TRA: re-attach to requests the vendor accepted; report the possibly-charged ones. Never re-sends. */
export async function recoverVideoAction(projectId: string): Promise<ActionResult & { needsAcknowledgement?: RecoveryItem[] }> {
  try {
    const r = await recoverVideo(projectId);
    return { ok: true, message: r.message || "Không còn yêu cầu nào cần kiểm tra.", needsAcknowledgement: r.needsAcknowledgement };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** ĐÃ KIỂM TRA — archive one possibly-charged request so a NEW, fully gated attempt may follow. Sends nothing. */
export async function acknowledgeRecoveryAction(providerJobId: string): Promise<ActionResult> {
  try {
    await acknowledgeRecovery(providerJobId, "xác nhận trên trang lô");
    return { ok: true, message: "Đã ghi nhận. Lần mua sau (nếu bấm TIẾP TỤC) là yêu cầu MỚI và phải qua đủ cổng chi." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
