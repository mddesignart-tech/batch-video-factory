import { prisma } from "@/lib/prisma";
import { round } from "@/lib/utils";
import { spendStatus } from "./spend-guard";
import { spentOnProject } from "./cost-tracker";
import type { BudgetProblem } from "@/domain/budget-message";

/**
 * NGÂN SÁCH VIDEO - the one number a person manages day to day (QĐ-119).
 *
 * Read-only. It reports the limits the guards ALREADY enforce, in the order
 * they bind, and changes none of them:
 *
 *   video   project.maxBudget            router (budget left) + executor headroom
 *   batch   an approval that was given   executor headroom, POST gate while live
 *   global  Settings spend cap           spend guard at every paid POST
 *
 * A DRAFT approval approved nothing and sets no ceiling (QĐ-118). A video
 * budget of 0 or less is "chưa đặt", never a silent $0 lock: paid actions ask
 * the person to set one first.
 */
export interface VideoBudget {
  projectId: string;
  used: number;
  /** The video's own budget; null = not set. */
  videoLimit: number | null;
  /** The limit that binds now (lowest of video budget and an approved per-video ceiling). */
  limit: number | null;
  remaining: number | null;
  /** Who sets `limit`. */
  source: "VIDEO" | "APPROVED_BATCH" | "UNSET";
  /** An approval that was given and still bounds this video, if any. */
  approval: {
    batchId: string;
    status: string;
    perVideo: number;
    batchCeiling: number;
    batchUsed: number;
    batchRemaining: number;
  } | null;
  /** DUYỆT & CHẠY of a multi-video DRAFT batch also caps at the batch's per-video figure. */
  draftBatchPerVideo: number | null;
  global: { cap: number; spent: number; remaining: number };
}

export async function videoBudget(projectId: string): Promise<VideoBudget> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { id: true, maxBudget: true, batchId: true },
  });
  const [used, cap, auth, batch] = await Promise.all([
    spentOnProject(projectId),
    spendStatus(),
    project.batchId ? prisma.batchAuthorization.findUnique({ where: { batchId: project.batchId } }) : null,
    project.batchId ? prisma.batch.findUnique({ where: { id: project.batchId }, select: { maxCostPerVideo: true, _count: { select: { projects: true } } } }) : null,
  ]);
  const videoLimit = project.maxBudget > 0 ? project.maxBudget : null;

  let approval: VideoBudget["approval"] = null;
  if (auth && auth.status !== "DRAFT") {
    const batchUsed = round(
      (
        await prisma.costEntry.aggregate({
          where: { estimated: false, project: { batchId: auth.batchId } },
          _sum: { amount: true },
        })
      )._sum.amount ?? 0,
      6,
    );
    approval = {
      batchId: auth.batchId,
      status: auth.status,
      perVideo: auth.maxCostPerVideo,
      batchCeiling: auth.authorizedMaxSpend,
      batchUsed,
      batchRemaining: round(Math.max(0, auth.authorizedMaxSpend - batchUsed), 6),
    };
  }

  let limit = videoLimit;
  let source: VideoBudget["source"] = videoLimit === null ? "UNSET" : "VIDEO";
  if (approval && (limit === null || approval.perVideo < limit)) {
    limit = approval.perVideo;
    source = "APPROVED_BATCH";
  }
  return {
    projectId,
    used,
    videoLimit,
    limit,
    remaining: limit === null ? null : round(Math.max(0, limit - used), 6),
    source,
    approval,
    draftBatchPerVideo:
      auth?.status === "DRAFT" && batch && batch._count.projects > 1 && batch.maxCostPerVideo > 0 ? batch.maxCostPerVideo : null,
    global: { cap: cap.cap, spent: cap.spent, remaining: cap.remaining },
  };
}

/**
 * "Đổi ngân sách": set THIS video's budget. Must be > 0 - a person who wants
 * to stop spending stops the video; a $0 budget is how projects got locked.
 *
 * A batch of one made for this project (a DRAFT nobody approved) follows, so
 * its preflight and DUYỆT & CHẠY price against the same number. An approval
 * that was GIVEN is never raised from here: that is a new approval, on the
 * batch page.
 */
export async function setVideoBudget(projectId: string, amount: number): Promise<VideoBudget> {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ngân sách video phải lớn hơn $0.");
  if (amount > 1000) throw new Error("Ngân sách video tối đa $1000.");
  const value = round(amount, 2);
  const project = await prisma.project.update({ where: { id: projectId }, data: { maxBudget: value }, select: { batchId: true } });
  if (project.batchId) {
    const [auth, siblings] = await Promise.all([
      prisma.batchAuthorization.findUnique({ where: { batchId: project.batchId } }),
      prisma.project.count({ where: { batchId: project.batchId } }),
    ]);
    if (siblings === 1 && (!auth || auth.status === "DRAFT")) {
      await prisma.batch.update({ where: { id: project.batchId }, data: { maxCostPerVideo: value, maxBudget: value } });
      if (auth) await prisma.batchAuthorization.update({ where: { id: auth.id }, data: { maxCostPerVideo: value } });
    }
  }
  return videoBudget(projectId);
}

/**
 * Would `cost` more fit the budgets that bind this video? Null when it does.
 * The same limits the guards enforce (video budget, a live approval, the
 * global cap - the last only for real money), read through videoBudget.
 */
export async function budgetShortfall(
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
