import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { round } from "@/lib/utils";
import { planSceneVoice, type SceneVoicePlan } from "./generation";
import { videoBudget } from "./video-budget";
import { budgetProblem, type BudgetProblem } from "@/domain/budget-message";

/**
 * "NGHE THỬ GIỌNG" / "Tạo giọng" for ONE scene (voice preview, QĐ-117).
 *
 * The preview IS the production voice: it runs the same generateSceneVoice the
 * batch runs, so the audio is saved as the scene's Asset under its reuse key,
 * and DUYỆT & CHẠY, TIẾP TỤC and render later find it and buy nothing.
 *
 *   all lines DONE / REUSE   -> runs at $0, no TTS POST
 *   any line to buy          -> NEEDS_CONFIRMATION with the cost, no POST
 *   confirmed, same plan     -> exactly the POSTs shown
 *   a lost paid file         -> shown as MISSING_LOCAL_FILE; bought again only
 *                               on this explicit confirmation
 *
 * A second press while the first runs answers ALREADY_RUNNING (per-scene lock,
 * taken before the first await), and the per-reuse-key creation lock inside
 * generateSceneVoice still guards any other caller of the same line.
 */

export type SceneVoiceStatus = "DONE" | "NEEDS_CONFIRMATION" | "NEEDS_BUDGET" | "BLOCKED" | "ALREADY_RUNNING" | "FAILED";

export interface SceneVoiceResult {
  status: SceneVoiceStatus;
  message: string;
  plan: SceneVoicePlan | null;
  /** TTS ProviderJobs this call created (0 for a reuse). */
  postsMade: number;
  /** Set when a budget stands in the way (QĐ-119): the numbers for the friendly message. */
  budget?: BudgetProblem & { projectId: string; videoLimit: number | null };
}

const running = new Set<string>();

export async function sceneVoiceStatus(sceneId: string): Promise<SceneVoicePlan> {
  return planSceneVoice(sceneId);
}

export async function makeSceneVoice(
  sceneId: string,
  opts: { confirmPaid?: boolean; expectedCost?: number } = {},
): Promise<SceneVoiceResult> {
  if (running.has(sceneId)) {
    return { status: "ALREADY_RUNNING", message: "Giọng của cảnh này đang được tạo - không gửi request thứ hai.", plan: null, postsMade: 0 };
  }
  running.add(sceneId);
  try {
    const plan = await planSceneVoice(sceneId);
    if (plan.lines.length === 0) {
      return { status: "BLOCKED", message: "Cảnh này không có lời thoại / lời dẫn để đọc.", plan, postsMade: 0 };
    }
    const stuck = plan.lines.filter((l) => l.state === "BLOCKED" || l.state === "NEEDS_RECOVERY" || l.state === "INVALID");
    if (stuck.length > 0) {
      return {
        status: "BLOCKED",
        message: stuck.map((l) => `Câu ${l.lineNumber}: ${l.state}${l.message ? ` - ${l.message}` : ""}`).join(" · ") + " KHÔNG gửi request.",
        plan,
        postsMade: 0,
      };
    }
    const money = (n: number) => `$${n.toFixed(6)}${plan.mockMode ? " (giá giả lập Mock Mode)" : ""}`;
    const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId }, select: { projectId: true } });
    if (plan.expectedPosts > 0) {
      // Budget first, in the person's terms - before asking them to confirm a
      // purchase the guards would refuse anyway. The guards still check again.
      const shortfall = await budgetShortfall(scene.projectId, plan.incrementalCost, plan.mockMode);
      if (shortfall) {
        return { status: "NEEDS_BUDGET", message: shortfall.detail, plan, postsMade: 0, budget: shortfall };
      }
      if (!opts.confirmPaid) {
        return {
          status: "NEEDS_CONFIRMATION",
          message: `Cần tạo ${plan.expectedPosts} câu giọng mới, dự toán ${money(plan.incrementalCost)}. Cần xác nhận trước khi gửi.`,
          plan,
          postsMade: 0,
        };
      }
      if (opts.expectedCost !== undefined && Math.abs(round(opts.expectedCost) - plan.incrementalCost) > 1e-9) {
        return {
          status: "BLOCKED",
          message: "PLAN_CHANGED: chi phí giọng đã đổi từ lúc bạn xem. KHÔNG gửi request - hãy xem lại rồi xác nhận.",
          plan,
          postsMade: 0,
        };
      }
    }

    const before = await prisma.providerJob.count({ where: { sceneId, kind: "audio" } });
    try {
      const { executeSceneAsset } = await import("./batch-executor");
      await executeSceneAsset(sceneId, "voice", { allowRebuyMissingVoice: opts.confirmPaid === true && plan.expectedPosts > 0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const problem = budgetProblem(message);
      if (problem) {
        const vb = await videoBudget(scene.projectId);
        return {
          status: "NEEDS_BUDGET",
          message,
          plan,
          postsMade: 0,
          budget: { ...problem, needed: problem.needed ?? plan.incrementalCost, projectId: scene.projectId, videoLimit: vb.videoLimit },
        };
      }
      return { status: "FAILED", message, plan, postsMade: 0 };
    }
    const postsMade = (await prisma.providerJob.count({ where: { sceneId, kind: "audio" } })) - before;
    const after = await planSceneVoice(sceneId);
    await logger.info({
      event: "voice.scene_made",
      sceneId,
      message: `Giọng cảnh ${after.sceneNumber}: ${postsMade} TTS POST, ${after.lines.length} câu sẵn sàng.`,
    });
    return {
      status: "DONE",
      message:
        postsMade === 0
          ? "Giọng không đổi - dùng lại file đã có, 0 TTS POST, $0."
          : `Đã tạo ${postsMade} câu giọng mới (${money(plan.incrementalCost)}). Lần chạy sau sẽ dùng lại, $0.`,
      plan: after,
      postsMade,
    };
  } finally {
    running.delete(sceneId);
  }
}

/**
 * Would `cost` more fit the budgets that bind this video? Null when it does.
 * The same limits the guards enforce (video budget, a live approval, the
 * global cap - the last only for real money), read through videoBudget.
 */
async function budgetShortfall(
  projectId: string,
  cost: number,
  mockMode: boolean,
): Promise<(BudgetProblem & { projectId: string; videoLimit: number | null }) | null> {
  const vb = await videoBudget(projectId);
  const eps = 1e-9;
  const base = { projectId, videoLimit: vb.videoLimit, needed: cost };
  if (vb.limit === null) {
    return { ...base, scope: "VIDEO", used: vb.used, limit: null, remaining: null, detail: "VIDEO_BUDGET_UNSET: video này chưa có ngân sách. Đặt ngân sách video trước khi tạo nội dung trả phí." };
  }
  if (cost > (vb.remaining ?? 0) + eps) {
    return {
      ...base,
      scope: vb.source === "APPROVED_BATCH" ? "BATCH" : "VIDEO",
      used: vb.used,
      limit: vb.limit,
      remaining: vb.remaining,
      detail: `VIDEO_LIMIT_EXCEEDED: video đã chi $${vb.used.toFixed(6)}, giới hạn $${vb.limit.toFixed(6)}, còn $${(vb.remaining ?? 0).toFixed(6)}; thao tác cần $${cost.toFixed(6)}.`,
    };
  }
  if (vb.approval?.status === "APPROVED" && cost > vb.approval.batchRemaining + eps) {
    return {
      ...base,
      scope: "BATCH",
      used: vb.approval.batchUsed,
      limit: vb.approval.batchCeiling,
      remaining: vb.approval.batchRemaining,
      detail: `BATCH_LIMIT_EXCEEDED: lô đã duyệt còn $${vb.approval.batchRemaining.toFixed(6)}; thao tác cần $${cost.toFixed(6)}.`,
    };
  }
  if (!mockMode && cost > vb.global.remaining + eps) {
    return {
      ...base,
      scope: "GLOBAL",
      used: vb.global.spent,
      limit: vb.global.cap,
      remaining: vb.global.remaining,
      detail: `GLOBAL_LIMIT_EXCEEDED: hạn mức toàn hệ thống còn $${vb.global.remaining.toFixed(6)}; thao tác cần $${cost.toFixed(6)}.`,
    };
  }
  return null;
}
