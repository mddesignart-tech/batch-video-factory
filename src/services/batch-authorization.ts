import type { BatchAuthorization } from "@prisma/client";
import type { BatchAuthStatus, QualityMode } from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parseJson, round } from "@/lib/utils";
import { assertProviderBudget } from "./provider-budget";
import { spendStatus } from "./spend-guard";
import {
  projectReservedAndSpent,
  reservationLedger,
  reserve,
  ReservationError,
  type ReservationLedger,
} from "./cost-reservation";

/**
 * BATCH_SPEND_AUTHORIZATION - one approval, many requests.
 *
 * The existing CREATE_ATTEMPT_TOKEN means "one confirmation buys exactly one
 * POST create". That is the right shape for a benchmark, where the whole point
 * is that a human looks at each purchase. It is the wrong shape for a batch:
 * ten videos would demand fifty confirmations, and a human clicking through
 * fifty prompts has stopped reading them - which makes the safeguard worse than
 * useless, because it looks like consent and is not.
 *
 * So batches get a different instrument rather than a loosened version of the
 * same one. The token is untouched and still governs benchmarks, manual tests
 * and debugging; see services/create-token. A scene inside an APPROVED batch
 * presents this authorisation instead. Neither path can spend with nothing.
 *
 * What the operator is actually agreeing to when they approve:
 *
 *   authorizedMaxSpend  a hard ceiling in dollars, never raised by the app
 *   maxCostPerVideo     no single video may quietly eat the batch
 *   providerScope       who may be paid, named in advance
 *   videoCount          how many videos that money is for
 *
 * All four are checked before every paid request, not once at the start.
 */

export const DEFAULT_MAX_COST_PER_VIDEO = 2.5;

export class BatchAuthorizationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "no_authorization"
      | "not_approved"
      | "wrong_batch"
      | "over_batch_budget"
      | "over_video_budget"
      | "provider_out_of_scope"
      | "global_cap"
      | "provider_wallet"
      | "low_auto_not_approved",
  ) {
    super(message);
    this.name = "BatchAuthorizationError";
  }
}

export interface CreateAuthorizationInput {
  batchId: string;
  estimatedCost: number;
  maxCostPerVideo: number;
  providerScope: string[];
  videoCount: number;
  qualityMode: QualityMode;
  note?: string;
}

/**
 * Record a costed plan as a DRAFT approval. Spends nothing and permits nothing.
 *
 * Kept separate from `approve` so the plan the operator reads and the ceiling
 * they type are two distinct acts. A single call that planned and authorised in
 * one step would make "press the button" and "agree to the money" the same
 * gesture, which is the failure mode this whole feature exists to avoid.
 */
export async function createAuthorization(
  input: CreateAuthorizationInput,
): Promise<BatchAuthorization> {
  const data = {
    status: "DRAFT",
    estimatedCost: round(input.estimatedCost, 6),
    authorizedMaxSpend: 0,
    maxCostPerVideo: round(input.maxCostPerVideo, 6),
    providerScopeJson: JSON.stringify([...new Set(input.providerScope)].sort()),
    videoCount: input.videoCount,
    qualityMode: input.qualityMode,
    approvedAt: null,
    closedAt: null,
    closedReason: "",
    note: input.note ?? "",
  };

  return prisma.batchAuthorization.upsert({
    where: { batchId: input.batchId },
    create: { batchId: input.batchId, ...data },
    // Re-planning replaces the draft wholesale. An APPROVED authorisation is
    // never silently overwritten - see the guard in the server action.
    update: data,
  });
}

/**
 * Turn a draft into permission to spend, up to a ceiling the operator names.
 *
 * `authorizedMaxSpend` comes from the operator, not from the estimate. They are
 * allowed to authorise more than the forecast (estimates are wrong, and a batch
 * halting at 95% complete helps nobody) and allowed to authorise less. What
 * they are not allowed to do is authorise more than the app-wide cap still
 * permits, because that cap is a promise made to them at a higher level.
 */
export async function approveAuthorization(opts: {
  batchId: string;
  authorizedMaxSpend: number;
  note?: string;
  /**
   * Does the operator also agree the ROUTER may choose models by itself here?
   *
   * A SEPARATE yes, defaulting to no. Approving a ceiling is agreeing to an
   * amount; agreeing that a model may be picked automatically is agreeing to a
   * mechanism, and folding the second into the first would mean nobody ever
   * consciously granted it. Every approval signed before low-auto existed keeps
   * the default and can never fund a router-chosen clip.
   */
  lowAutoApproved?: boolean;
}): Promise<BatchAuthorization> {
  const auth = await prisma.batchAuthorization.findUnique({
    where: { batchId: opts.batchId },
  });
  if (!auth) {
    throw new BatchAuthorizationError(
      "Lô này chưa có bản dự toán. Hãy bấm PHÂN TÍCH & DỰ TOÁN trước.",
      "no_authorization",
    );
  }

  const ceiling = round(Math.max(0, opts.authorizedMaxSpend), 6);

  // The global cap is not a suggestion this can borrow against. Authorising a
  // batch ceiling larger than the app has left would create a permission that
  // cannot be honoured, and the failure would surface halfway through a run.
  const status = await spendStatus();
  if (ceiling > status.remaining) {
    throw new BatchAuthorizationError(
      `Hạn mức lô $${ceiling.toFixed(2)} vượt phần còn lại của hạn mức toàn ứng ` +
        `dụng ($${status.remaining.toFixed(6)} trên tổng $${status.cap.toFixed(2)}, ` +
        `đã chi $${status.spent.toFixed(6)}). Hạ hạn mức lô xuống, hoặc nâng hạn ` +
        `mức tổng trong trang Cài đặt — nhưng nâng hạn mức là cấp thêm quyền chi, ` +
        `không phải tạo thêm tiền.`,
      "global_cap",
    );
  }

  const updated = await prisma.batchAuthorization.update({
    where: { batchId: opts.batchId },
    data: {
      status: "APPROVED",
      authorizedMaxSpend: ceiling,
      approvedAt: new Date(),
      closedAt: null,
      closedReason: "",
      // Explicit every time. Not `?? auth.lowAutoApproved`: re-approving a batch
      // is a fresh decision, and silently carrying the permission forward would
      // let one deliberate yes become permanent.
      lowAutoApproved: opts.lowAutoApproved === true,
      note: opts.note ?? auth.note,
    },
  });

  await logger.warn({
    event: "batch.authorized",
    message:
      `Lô ${opts.batchId} được duyệt chi tối đa $${ceiling.toFixed(2)} cho ` +
      `${auth.videoCount} video (dự toán $${auth.estimatedCost.toFixed(4)}). ` +
      `Router tự chọn model (LOW_AUTO): ${opts.lowAutoApproved === true ? "CÓ" : "KHÔNG"}. ` +
      `Nhà cung cấp trong phạm vi: ${parseJson<string[]>(auth.providerScopeJson, []).join(", ") || "không có"}.`,
  });

  return updated;
}

/** Close an authorisation. No further paid request will pass the gate. */
export async function closeAuthorization(
  batchId: string,
  status: Extract<BatchAuthStatus, "CANCELLED" | "EXHAUSTED" | "COMPLETED">,
  reason: string,
): Promise<void> {
  await prisma.batchAuthorization.updateMany({
    where: { batchId },
    data: { status, closedReason: reason, closedAt: new Date() },
  });
  await logger.warn({
    event: "batch.authorization_closed",
    message: `Lô ${batchId}: quyền chi chuyển sang ${status}. ${reason}`,
  });
}

/**
 * Re-open an authorisation that was cancelled, keeping its ceiling and its
 * spend.
 *
 * Resuming must NOT reset `actualSpend`. The money already left; a resume that
 * started the tally from zero would let one batch spend its ceiling twice, and
 * the second run would look perfectly well-behaved the whole way.
 */
export async function resumeAuthorization(batchId: string): Promise<BatchAuthorization> {
  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId } });
  if (!auth) {
    throw new BatchAuthorizationError(
      "Không tìm thấy quyền chi của lô này.",
      "no_authorization",
    );
  }
  if (auth.status === "APPROVED") return auth;

  const ledger = await reservationLedger(batchId, auth.authorizedMaxSpend);
  if (ledger.available <= 0) {
    throw new BatchAuthorizationError(
      `Lô đã dùng hết hạn mức được duyệt ($${ledger.used.toFixed(6)}/` +
        `$${ledger.ceiling.toFixed(6)}). Muốn chạy tiếp phải duyệt hạn mức mới.`,
      "over_batch_budget",
    );
  }

  return prisma.batchAuthorization.update({
    where: { batchId },
    data: { status: "APPROVED", closedAt: null, closedReason: "" },
  });
}

export interface BatchGateInput {
  batchId: string;
  projectId: string;
  sceneId: string;
  kind: string;
  provider: string;
  model: string;
  estimatedCost: number;
  /** The same key used for the ProviderJob. Ties the reservation to the request. */
  idempotencyKey: string;
  /**
   * Did the ROUTER pick this model by itself under a LOW_AUTO grant?
   *
   * Defaults false, which is the shape of every call that existed before the
   * grant did. When true the approval must say, in its own row, that it covers
   * router-chosen clips - see `lowAutoApproved`.
   */
  lowAutoRouted?: boolean;
}

export interface BatchGateResult {
  ledger: ReservationLedger;
  /** True when this request already had a reservation - a resume, not a purchase. */
  reused: boolean;
}

/**
 * The gate every paid request inside a batch must pass.
 *
 * Six questions, in the order that fails cheapest first, and the request is not
 * sent unless all six answer yes:
 *
 *   1. is there an approval at all, and is it still APPROVED?
 *   2. does this request belong to the batch that was approved?
 *   2b. if the ROUTER chose this model itself, does the approval cover that?
 *   3. would it push the batch past its authorised ceiling?
 *   4. would it push THIS VIDEO past the per-video ceiling?
 *   5. is the provider inside the approved scope?
 *   6. does the app-wide cap and the provider's own wallet still cover it?
 *
 * Passing them all reserves the money as the last step, so the answer to
 * question 3 stays true for anyone who asks after us. `reserve` is keyed on the
 * idempotency key, which is what makes question 3 safe to re-ask after a crash:
 * the same request finds its own reservation instead of making a second.
 */
export async function assertBatchAuthorized(
  input: BatchGateInput,
): Promise<BatchGateResult> {
  // 1 - an approval exists and is live.
  const auth = await prisma.batchAuthorization.findUnique({
    where: { batchId: input.batchId },
  });
  if (!auth) {
    throw new BatchAuthorizationError(
      `Lô ${input.batchId} chưa có BATCH_SPEND_AUTHORIZATION. Không được gọi API ` +
        `trả phí. Hãy lập dự toán và bấm DUYỆT & CHẠY BATCH.`,
      "no_authorization",
    );
  }
  if (auth.status !== "APPROVED") {
    throw new BatchAuthorizationError(
      `Quyền chi của lô đang ở trạng thái ${auth.status}` +
        (auth.closedReason ? ` (${auth.closedReason})` : "") +
        `. Mọi request trả phí bị chặn cho tới khi được duyệt lại.`,
      auth.status === "EXHAUSTED" ? "over_batch_budget" : "not_approved",
    );
  }

  // 2 - this request belongs to the approved batch.
  //
  // This check reads as a tautology and very nearly is one: `auth` was just
  // fetched BY `input.batchId`, so the two can never differ. It is kept because
  // it is free and because the day someone changes the lookup - to "the newest
  // approved authorisation", say - it becomes the thing that catches it. What
  // it does NOT do is protect against a stale approval on the SAME batch, which
  // is a different problem and is what 2b is for.
  if (auth.batchId !== input.batchId) {
    throw new BatchAuthorizationError(
      `Request thuộc lô ${input.batchId} nhưng quyền chi được cấp cho lô ${auth.batchId}.`,
      "wrong_batch",
    );
  }

  // 2b - an approval covers the PLAN it was shown, not every future way of
  // choosing a model.
  //
  // The concrete case this exists for: batch 11af6ba6 was approved on
  // 2026-09-15 with a $0.90 ceiling against a plan of one named video, spent
  // $0.44, and stayed APPROVED with $0.46 of headroom and a project still
  // pointing at it. Switching on LOW_AUTO afterwards would have let the router
  // pick a clip nobody had seen when they approved, and pay for it out of that
  // leftover. The operator agreed to a bill, not to a mechanism.
  //
  // So the permission is explicit and per-authorisation. An approval predating
  // the feature has `lowAutoApproved = false` from the column default and can
  // never fund a router-chosen clip, no matter how much money is left in it.
  if (input.lowAutoRouted && !auth.lowAutoApproved) {
    throw new BatchAuthorizationError(
      `Clip này do router TỰ CHỌN theo LOW_AUTO, nhưng quyền chi của lô ` +
        `${input.batchId} được duyệt lúc ` +
        `${auth.approvedAt ? auth.approvedAt.toISOString().slice(0, 10) : "?"} ` +
        `chỉ bao gồm các clip đã nêu tên trong dự toán. Hãy lập dự toán mới và ` +
        `duyệt lại nếu bạn đồng ý cho router tự chọn model.`,
      "low_auto_not_approved",
    );
  }

  const cost = round(Math.max(0, input.estimatedCost), 6);

  // 5 - provider scope, checked before any money maths because it is the
  // cheapest question and the most surprising answer. Approving a plan that
  // named Runway is not approval to pay OpenAI.
  const scope = parseJson<string[]>(auth.providerScopeJson, []);
  if (scope.length > 0 && !scope.includes(input.provider)) {
    throw new BatchAuthorizationError(
      `Nhà cung cấp "${input.provider}" không nằm trong phạm vi đã duyệt ` +
        `(${scope.join(", ")}). Bản dự toán được duyệt có nêu tên nhà cung cấp, ` +
        `nên chi cho một nhà cung cấp khác là ngoài phạm vi cho phép.`,
      "provider_out_of_scope",
    );
  }

  // 4 - the per-video ceiling. Checked before the batch ceiling because a video
  // that breaches it is a plan problem, not a money-left problem, and the
  // operator should be told which.
  // Is this request already holding money under this exact key?
  //
  // If it is, nothing NEW is being spent - this is a resume, and `reserve`
  // below will recognise it and take nothing further. The ceiling checks must
  // know that, because `projectReservedAndSpent` already counts this request's
  // own hold: adding `cost` on top would charge it against the ceiling twice
  // and refuse a resume that costs nothing. That would break the one property
  // the idempotency key exists to provide.
  const alreadyReserved = await prisma.costReservation.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  });
  const newMoney = alreadyReserved ? 0 : cost;

  const alreadyOnVideo = await projectReservedAndSpent(input.projectId);
  if (round(alreadyOnVideo + newMoney, 6) > auth.maxCostPerVideo) {
    throw new BatchAuthorizationError(
      `Video này đã dùng $${alreadyOnVideo.toFixed(6)}; thêm $${newMoney.toFixed(6)} ` +
        `sẽ vượt hạn mức $${auth.maxCostPerVideo.toFixed(2)} cho MỘT video. ` +
        `Đánh dấu OVER_VIDEO_BUDGET và dừng video này, các video khác không ảnh hưởng.`,
      "over_video_budget",
    );
  }

  // 6 - the two limits that exist outside this batch entirely. The app-wide cap
  // says "this tool has spent what I authorised in total"; the provider wallet
  // says "that account has money". A batch approval overrides neither.
  const status = await spendStatus();
  if (round(status.spent + newMoney, 6) > status.cap) {
    throw new BatchAuthorizationError(
      `Hạn mức toàn ứng dụng còn $${status.remaining.toFixed(6)}, không đủ cho ` +
        `yêu cầu $${cost.toFixed(6)}. Quyền chi của lô không vượt qua được hạn ` +
        `mức tổng.`,
      "global_cap",
    );
  }
  await assertProviderBudget({
    provider: input.provider,
    model: input.model,
    // Zero on a resume: the vendor wallet was already checked when this request
    // first reserved, and charging it again would refuse a retry that is about
    // to spend nothing.
    estimatedCost: newMoney,
  });

  // 3 - the batch ceiling, and the reservation that makes the answer stick.
  // Last on purpose: it is the only step with a side effect, so every cheaper
  // refusal happens before anything is written.
  try {
    const { reused, ledger } = await reserve(
      {
        batchId: input.batchId,
        projectId: input.projectId,
        sceneId: input.sceneId,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        provider: input.provider,
        model: input.model,
        estimatedCost: cost,
      },
      auth.authorizedMaxSpend,
    );
    return { ledger, reused };
  } catch (err) {
    if (err instanceof ReservationError) {
      // Out of authorised money. Close the approval so the remaining jobs stop
      // asking rather than each discovering it in turn and logging an error.
      await closeAuthorization(
        input.batchId,
        "EXHAUSTED",
        "Đã dùng hết hạn mức được duyệt.",
      );
      throw new BatchAuthorizationError(err.message, "over_batch_budget");
    }
    throw err;
  }
}

/** Is this scene covered by a live batch approval? Used to pick the permit model. */
export async function batchApprovalFor(
  batchId: string | null | undefined,
): Promise<BatchAuthorization | null> {
  if (!batchId) return null;
  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId } });
  return auth?.status === "APPROVED" ? auth : null;
}

export async function authorizationSummary(batchId: string): Promise<{
  auth: BatchAuthorization | null;
  ledger: ReservationLedger | null;
}> {
  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId } });
  if (!auth) return { auth: null, ledger: null };
  return {
    auth,
    ledger: await reservationLedger(batchId, auth.authorizedMaxSpend),
  };
}
