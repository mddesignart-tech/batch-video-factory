/**
 * Hierarchical spend limits - the ONE place a planned or requested amount is
 * judged against the four ceilings (V1.2 Phase 2, QĐ-108).
 *
 *   GLOBAL_PROJECT_LIMIT   what the whole app may ever spend (hard safety cap)
 *   BATCH_LIMIT            what this approval may spend
 *   VIDEO_LIMIT            what one video may spend
 *   SCENE_LIMIT            what one scene may spend (all its paid assets)
 *
 * Every result carries a reason code and the numbers behind it - never a bare
 * boolean - so the screen can say "Video 2 vượt giới hạn video $0.07
 * (dự toán $0.67, giới hạn $0.60)" instead of "không đủ ngân sách".
 *
 * Amounts are INCREMENTAL: an asset already bought and reusable costs $0 here,
 * whatever it cost when it was bought. A resume is judged by what is still
 * missing, never by the video's historical total.
 *
 * Pure: no database, no provider, no clock. The preflight plans with
 * `planBatchSpend`; the gate in front of every paid POST judges with
 * `evaluateSpendLimits`, inside the reservation lock, against the ledger as it
 * is at that moment (TOCTOU: a figure from the preflight is never trusted).
 */

export const SPEND_REASON_CODES = [
  "OK",
  "GLOBAL_LIMIT_EXCEEDED",
  "BATCH_LIMIT_EXCEEDED",
  "VIDEO_LIMIT_EXCEEDED",
  "SCENE_LIMIT_EXCEEDED",
  "PROVIDER_NOT_CONFIRMED",
  "MODEL_NOT_CONFIRMED",
  "PAID_ASSET_REQUIRES_APPROVAL",
  "PAID_ASSET_NEEDS_RECOVERY",
  /** Not runnable for a reason that is not money (e.g. no character reference). */
  "NOT_RUNNABLE",
] as const;
export type SpendReasonCode = (typeof SPEND_REASON_CODES)[number];

export type SpendStatus = "PASS" | "BLOCKED" | "WARNING";
export type SpendLayer = "GLOBAL" | "BATCH" | "VIDEO" | "SCENE" | "APPROVAL";

export interface SpendVerdict {
  status: SpendStatus;
  reasonCode: SpendReasonCode;
  layer: SpendLayer | null;
  /** Incremental amount being judged. */
  estimatedCost: number;
  /** The limit that decided it (Infinity-free: null when no limit applied). */
  limit: number | null;
  /** Headroom under that limit before / after this amount. */
  remainingBefore: number | null;
  remainingAfter: number | null;
  /** How far over the limit; 0 when it fits. */
  overBy: number;
  /** Vietnamese sentence naming the video / scene, the amount and the limit. */
  message: string;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
/** Cents for real prices; six decimals below a cent, so a tiny figure is never shown as $0.00. */
export const usd = (n: number): string =>
  n === 0 || Math.abs(n) >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(6)}`;
const EPS = 1e-9;

// -------------------------------------------------------------- one request --

export interface SpendRequest {
  /** Who is asking, for the message. */
  label: string;
  estimatedCost: number;
  /** Lifetime production spend + held reservations, and the global cap. */
  global: { cap: number; used: number };
  /** The batch's authorised ceiling and what it has spent + reserved. */
  batch?: { limit: number; used: number } | null;
  video?: { limit: number | null; used: number } | null;
  scene?: { limit: number | null; used: number } | null;
}

function verdict(
  layer: SpendLayer,
  reasonCode: SpendReasonCode,
  cost: number,
  limit: number,
  used: number,
  label: string,
  what: string,
): SpendVerdict {
  const remainingBefore = r6(limit - used);
  const remainingAfter = r6(limit - used - cost);
  const overBy = r6(Math.max(0, used + cost - limit));
  return {
    status: overBy > EPS ? "BLOCKED" : "PASS",
    reasonCode: overBy > EPS ? reasonCode : "OK",
    layer,
    estimatedCost: r6(cost),
    limit: r6(limit),
    remainingBefore,
    remainingAfter,
    overBy,
    message:
      overBy > EPS
        ? `${label} vượt giới hạn ${what} ${usd(overBy)} — dự toán ${usd(cost)}` +
          (used > EPS ? ` (đã dùng ${usd(used)})` : "") +
          `, giới hạn ${usd(limit)}.`
        : `${label}: ${usd(cost)} trong giới hạn ${what} ${usd(limit)} (còn ${usd(remainingAfter)}).`,
  };
}

/**
 * Judge ONE incremental amount against every layer, most specific first - the
 * operator should hear "scene 3 is over its cap" before "the batch is full".
 * The first layer that refuses is the answer; if none refuses, the tightest
 * layer is reported as the PASS.
 */
export function evaluateSpendLimits(req: SpendRequest): SpendVerdict {
  const cost = Math.max(0, req.estimatedCost);
  const checks: SpendVerdict[] = [];
  if (req.scene && req.scene.limit !== null) {
    checks.push(verdict("SCENE", "SCENE_LIMIT_EXCEEDED", cost, req.scene.limit, req.scene.used, req.label, "cảnh"));
  }
  if (req.video && req.video.limit !== null) {
    checks.push(verdict("VIDEO", "VIDEO_LIMIT_EXCEEDED", cost, req.video.limit, req.video.used, req.label, "video"));
  }
  if (req.batch) {
    checks.push(verdict("BATCH", "BATCH_LIMIT_EXCEEDED", cost, req.batch.limit, req.batch.used, req.label, "lô"));
  }
  checks.push(verdict("GLOBAL", "GLOBAL_LIMIT_EXCEEDED", cost, req.global.cap, req.global.used, req.label, "toàn cục"));

  const refused = checks.find((c) => c.status === "BLOCKED");
  if (refused) return refused;
  return checks.reduce((tight, c) => ((c.remainingAfter ?? Infinity) < (tight.remainingAfter ?? Infinity) ? c : tight));
}

// ------------------------------------------------------------- batch plan ---

export interface PlannedScene {
  sceneNumber: number;
  /** Incremental: REUSE = 0. */
  incrementalCost: number;
  /** Null = no scene cap. */
  limit: number | null;
}

export interface PlannedVideo {
  id: string;
  title: string;
  /** Higher runs first. Default 0. */
  priority?: number;
  /** Queue order (import order). Lower runs first. */
  order: number;
  scenes: PlannedScene[];
  /** Null = no per-video cap. */
  videoLimit: number | null;
  /**
   * Already not runnable for a reason that is not money (missing reference,
   * unconfirmed price, ...). Carried through untouched so the plan lists it.
   */
  preBlocked?: { reasonCode: SpendReasonCode; message: string; verdict?: SpendVerdict } | null;
}

export interface VideoSpendPlan {
  id: string;
  title: string;
  incrementalCost: number;
  videoLimit: number | null;
  verdict: SpendVerdict;
  scenes: (PlannedScene & { verdict: SpendVerdict })[];
  runnable: boolean;
}

export interface BatchSpendPlan {
  /** In the order they were decided: priority desc, queue order asc, id asc. */
  videos: VideoSpendPlan[];
  runnable: VideoSpendPlan[];
  blocked: VideoSpendPlan[];
  /** Sum of the runnable videos' incremental cost - what an approval covers. */
  authorizationAmount: number;
  /** Sum over every video, blocked included - shown, never authorised. */
  requestedTotal: number;
  batchLimit: number | null;
  globalRemaining: number;
}

/** Stable, deterministic run order: user priority, then queue order, then id. */
export function spendOrder(a: PlannedVideo, b: PlannedVideo): number {
  return (b.priority ?? 0) - (a.priority ?? 0) || a.order - b.order || a.id.localeCompare(b.id);
}

/**
 * Decide which videos of a batch may run, and why the others may not.
 *
 * 1. Each scene against its own cap, then each video against its own cap. A
 *    video over either is BLOCKED on its own and takes nothing from the batch.
 * 2. The rest, in `spendOrder`, first-fit into min(batch limit, global
 *    remaining). One that does not fit is BLOCKED (BATCH_ or
 *    GLOBAL_LIMIT_EXCEEDED, whichever binds) and the next one is still tried:
 *    a cheaper video later in the queue is not held hostage by a dear one.
 *
 * Never lowers quality, changes a model or raises a limit - it only says which
 * work fits the money a person has already agreed to.
 */
export function planBatchSpend(input: {
  videos: PlannedVideo[];
  batchLimit: number | null;
  globalRemaining: number;
}): BatchSpendPlan {
  const ordered = [...input.videos].sort(spendOrder);
  const plans: VideoSpendPlan[] = [];
  let batchUsed = 0;
  let globalUsed = 0;

  for (const v of ordered) {
    const scenes = v.scenes.map((s) => ({
      ...s,
      verdict: evaluateSpendLimits({
        label: `${v.title} · cảnh ${s.sceneNumber}`,
        estimatedCost: s.incrementalCost,
        global: { cap: Infinity, used: 0 },
        scene: { limit: s.limit, used: 0 },
      }),
    }));
    const cost = r6(scenes.reduce((n, s) => n + Math.max(0, s.incrementalCost), 0));
    const base = { id: v.id, title: v.title, incrementalCost: cost, videoLimit: v.videoLimit, scenes };

    if (v.preBlocked) {
      plans.push({
        ...base,
        // The figure the preflight judged it by (uncapped), not the part of it
        // the router managed to price before the limit ran out.
        incrementalCost: v.preBlocked.verdict?.estimatedCost ?? cost,
        runnable: false,
        verdict: v.preBlocked.verdict ?? {
          status: "BLOCKED",
          reasonCode: v.preBlocked.reasonCode,
          layer: "APPROVAL",
          estimatedCost: cost,
          limit: null,
          remainingBefore: null,
          remainingAfter: null,
          overBy: 0,
          message: `${v.title}: ${v.preBlocked.message}`,
        },
      });
      continue;
    }

    const overScene = scenes.find((s) => s.verdict.status === "BLOCKED");
    if (overScene) {
      plans.push({ ...base, runnable: false, verdict: { ...overScene.verdict, estimatedCost: cost } });
      continue;
    }

    const own = evaluateSpendLimits({
      label: v.title,
      estimatedCost: cost,
      global: { cap: Infinity, used: 0 },
      video: { limit: v.videoLimit, used: 0 },
    });
    if (own.status === "BLOCKED") {
      plans.push({ ...base, runnable: false, verdict: own });
      continue;
    }

    const shared = evaluateSpendLimits({
      label: v.title,
      estimatedCost: cost,
      global: { cap: input.globalRemaining, used: globalUsed },
      batch: input.batchLimit === null ? null : { limit: input.batchLimit, used: batchUsed },
      video: { limit: v.videoLimit, used: 0 },
    });
    if (shared.status === "BLOCKED") {
      plans.push({ ...base, runnable: false, verdict: shared });
      continue;
    }
    batchUsed = r6(batchUsed + cost);
    globalUsed = r6(globalUsed + cost);
    plans.push({ ...base, runnable: true, verdict: shared });
  }

  const runnable = plans.filter((p) => p.runnable);
  return {
    videos: plans,
    runnable,
    blocked: plans.filter((p) => !p.runnable),
    authorizationAmount: r6(runnable.reduce((n, p) => n + p.incrementalCost, 0)),
    requestedTotal: r6(plans.reduce((n, p) => n + p.incrementalCost, 0)),
    batchLimit: input.batchLimit,
    globalRemaining: input.globalRemaining,
  };
}

/** Short label for a reason code, for badges. */
export const REASON_LABEL: Record<SpendReasonCode, string> = {
  OK: "OK",
  GLOBAL_LIMIT_EXCEEDED: "Vượt hạn mức toàn cục",
  BATCH_LIMIT_EXCEEDED: "Vượt trần lô",
  VIDEO_LIMIT_EXCEEDED: "Vượt trần video",
  SCENE_LIMIT_EXCEEDED: "Vượt trần cảnh",
  PROVIDER_NOT_CONFIRMED: "Nhà cung cấp chưa xác nhận",
  MODEL_NOT_CONFIRMED: "Model chưa xác nhận giá",
  PAID_ASSET_REQUIRES_APPROVAL: "Cần duyệt chi",
  PAID_ASSET_NEEDS_RECOVERY: "Asset đã trả tiền cần kiểm tra",
  NOT_RUNNABLE: "Chưa chạy được",
};
