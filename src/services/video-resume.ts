import fs from "node:fs";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { toAbsolute } from "@/lib/paths";
import { round } from "@/lib/utils";
import { evaluateSpendLimits, planBatchSpend, type SpendVerdict } from "@/domain/spend-limits";
import type { VideoLifecycle } from "@/domain/video-lifecycle";
import { preflightImportedBatch, type ImportVideoPreview } from "./import-preflight";
import { missingOutputFiles } from "./output-export";
import { projectReservedAndSpent, reservationLedger, totalReserved } from "./cost-reservation";
import { resumeAuthorization } from "./batch-authorization";
import { spendStatus } from "./spend-guard";
import { isVideoRunning, tryLockVideo, unlockVideo } from "./run-registry";
import { recoveryItemsForProject, type RecoveryItem } from "./paid-recovery";
import { executeSceneAsset, runBatch, type RunSummary } from "./batch-executor";
import { freezeVideoChoices, frozenChoicesForBatch, type FrozenVideoMap } from "./frozen-video";

/**
 * Per-video resume inside a batch (V1.2 Phase 3, QĐ-110).
 *
 * One video's next move is decided by ITS OWN rows - never by the batch's
 * status - and by one function, buildVideoResumePlan. Three different actions,
 * never folded into one "retry":
 *
 *   CONTINUE   do what is missing; reuse everything that exists ($0 for reuse).
 *   RETRY      = CONTINUE on a step that failed safely (the request never left,
 *              or the vendor said it was free) - the same path, same gates.
 *   RECOVER    a paid request whose outcome is unknown: re-attach to it (poll,
 *              no new POST) or, after a person has checked, archive it so the
 *              next attempt is a NEW, fully gated purchase.
 *
 * Money: the Phase 2 engine, untouched. The plan's cost is INCREMENTAL (REUSE =
 * $0); a paid step is re-checked against all four limits at the moment of the
 * POST (TOCTOU) by the gate every paid request passes.
 */

export type NextStep = "NONE" | "RENDER_ONLY" | "GENERATE" | "RECOVER" | "BLOCKED" | "ALREADY_RUNNING";

export interface AssetTally {
  image: number;
  video: number;
  voice: number;
}

export interface VideoResumePlan {
  videoId: string;
  title: string;
  batchId: string;
  currentStatus: VideoLifecycle;
  nextStep: NextStep;
  /** The one button the batch page shows for this video, or null. */
  nextAction: "TIẾP TỤC" | "KIỂM TRA LẠI" | "XEM LÝ DO" | "KIỂM TRA" | null;
  assetsPresent: AssetTally;
  assetsMissing: AssetTally;
  /** Present AND usable again as they are ($0). */
  assetsReusable: AssetTally;
  paidRequestsRequired: AssetTally & { total: number };
  /** FFmpeg-only work: local motion scenes, render, output export. */
  localWorkRequired: string[];
  /** Incremental only; null when the outcome of an earlier paid request is unknown. */
  estimatedIncrementalCost: number | null;
  blockedReason: string | null;
  recovery: RecoveryItem[];
  /** The money verdict behind a BLOCKED plan (reason code, limit, over by). */
  verdict: SpendVerdict | null;
  safeToContinue: boolean;
  /**
   * Every clip this continue would BUY, with the model it would use (QĐ-111).
   * `frozen` = an approval already fixed it; otherwise the person's confirmation
   * of THIS plan is what freezes it.
   */
  videoChoices: VideoChoice[];
  /** Changes whenever what would be bought changes; a confirmation carries it back. */
  fingerprint: string;
  /** 0-100, from the video's own scenes and output. */
  progress: number;
  budget: {
    videoLimit: number;
    videoRemaining: number;
    batchRemaining: number;
    globalRemaining: number;
  };
}

export interface VideoChoice {
  sceneNumber: number;
  sceneId: string;
  provider: string;
  model: string;
  durationSeconds: number;
  estimatedCost: number;
  lowAuto: boolean;
  frozen: boolean;
}

const tally = (): AssetTally => ({ image: 0, video: 0, voice: 0 });

function fingerprintOf(choices: VideoChoice[], cost: number | null, paid: number): string {
  return createHash("sha256")
    .update(JSON.stringify([choices.map((c) => [c.sceneId, c.provider, c.model, c.durationSeconds, c.estimatedCost]), cost, paid]))
    .digest("hex")
    .slice(0, 16);
}

async function budgetFor(batchId: string, projectId: string, videoLimit: number) {
  const [auth, status, held, used] = await Promise.all([
    prisma.batchAuthorization.findUnique({ where: { batchId } }),
    spendStatus(),
    totalReserved(),
    projectReservedAndSpent(projectId),
  ]);
  const batchUsed = auth ? (await reservationLedger(batchId, auth.authorizedMaxSpend)).used : 0;
  return {
    videoLimit,
    videoRemaining: round(Math.max(0, videoLimit - used), 6),
    batchRemaining: round(Math.max(0, (auth?.authorizedMaxSpend ?? 0) - batchUsed), 6),
    globalRemaining: round(Math.max(0, status.cap - status.spent - held), 6),
  };
}

function planFrom(
  v: ImportVideoPreview,
  project: { id: string; title: string; status: string; finalVideoPath: string | null; subtitlePath: string | null },
  batchId: string,
  recovery: RecoveryItem[],
  active: boolean,
  budget: VideoResumePlan["budget"],
  frozen: FrozenVideoMap | null,
): VideoResumePlan {
  const present = tally();
  const missing = tally();
  const reusable = tally();
  const count = (plan: string, key: keyof AssetTally) => {
    if (plan === "BUY") missing[key] += 1;
    if (plan === "REUSE") {
      present[key] += 1;
      reusable[key] += 1;
    }
  };
  for (const s of v.scenes) {
    count(s.plan.image, "image");
    count(s.plan.video, "video");
    count(s.plan.voice, "voice");
  }
  const videoChoices: VideoChoice[] = [];
  for (const sc of v.scenes) {
    if (sc.plan.video !== "BUY" || !sc.videoRoute || !sc.sceneId) continue;
    videoChoices.push({
      sceneNumber: sc.sceneNumber,
      sceneId: sc.sceneId,
      provider: sc.videoRoute.provider,
      model: sc.videoRoute.model,
      durationSeconds: sc.duration,
      estimatedCost: sc.videoRoute.estimatedCost,
      lowAuto: sc.videoRoute.lowAuto,
      frozen: Boolean(frozen?.[sc.sceneId]),
    });
  }
  const paid = {
    image: v.counts.imagePosts,
    video: v.counts.videoPosts,
    voice: v.counts.voicePosts,
    total: v.counts.imagePosts + v.counts.videoPosts + v.counts.voicePosts,
  };

  const finalOnDisk = Boolean(project.finalVideoPath && fs.existsSync(toAbsolute(project.finalVideoPath)));
  const subtitleOnDisk = !project.subtitlePath || fs.existsSync(toAbsolute(project.subtitlePath));
  const outputGaps = project.status === "completed" && finalOnDisk ? missingOutputFiles(project) : [];
  const local: string[] = [];
  const localMotion = v.scenes.filter((s) => s.motionSource === "LOCAL_MOTION").length;
  const renderNeeded = project.status !== "completed" || !finalOnDisk || !subtitleOnDisk;
  if (renderNeeded && localMotion > 0) local.push(`local_motion:${localMotion}`);
  if (renderNeeded) local.push("render");
  if (outputGaps.length > 0 || renderNeeded) local.push("export");

  let status: VideoLifecycle = v.lifecycle as VideoLifecycle;
  if (active) status = project.status === "rendering" ? "RENDERING" : "RUNNING";
  else if (recovery.length > 0 && project.status !== "completed") status = "NEEDS_RECOVERY";

  let nextStep: NextStep;
  let blockedReason: string | null = null;
  if (active) nextStep = "ALREADY_RUNNING";
  else if (status === "NEEDS_RECOVERY") {
    nextStep = "RECOVER";
    blockedReason = recovery.map((r) => r.message).join(" ");
  } else if (status === "BLOCKED" || (project.status !== "completed" && v.status !== "OK")) {
    // A preflight blocker holds a resumable video too: a FAILED video now over
    // its limit must not be "continued" as if its missing clip cost nothing -
    // the router does not even price a scene it cannot afford.
    nextStep = "BLOCKED";
    status = "BLOCKED";
    // An APPROVED_* stop of a frozen model (QĐ-111) is named as such - never
    // hidden behind the text of an older failure.
    const approvedStop = v.needsProvider.find((m) => /APPROVED_[A-Z_]+:/.test(m));
    blockedReason =
      v.spend.status === "BLOCKED"
        ? `${v.spend.reasonCode}: ${v.spend.message}`
        : (approvedStop ?? v.blockedReason ?? v.needsProvider[0] ?? v.warnings[0] ?? v.status);
  } else if (paid.total > 0) nextStep = "GENERATE";
  else if (renderNeeded || outputGaps.length > 0) nextStep = "RENDER_ONLY";
  else if (project.status === "completed") nextStep = "NONE";
  else nextStep = "RENDER_ONLY";

  const scenesDone = v.scenes.filter((s) => s.plan.image !== "BUY" && s.plan.video !== "BUY" && s.plan.voice !== "BUY").length;
  // A BLOCKED video that never finished has not started: the router does not
  // even price its scenes, so counting "nothing to buy" as done would read 90%.
  const progress =
    nextStep === "NONE"
      ? 100
      : nextStep === "BLOCKED" && project.status !== "completed"
        ? 0
        : v.scenes.length === 0
        ? 0
        : Math.min(95, Math.round((scenesDone / v.scenes.length) * 90 + (finalOnDisk ? 5 : 0)));

  // No paid request left = nothing will be sent = $0. The estimator also prices
  // a quality-scoring pass for HIGH-priority scenes, which the batch executor
  // never runs (no quality loop on paid work) - so a render-only video read
  // $0.0021 instead of $0 (found by the QĐ-111 render-only test).
  const incremental =
    nextStep === "RECOVER"
      ? null
      : nextStep === "RENDER_ONLY" || nextStep === "NONE"
        ? 0
        : round(Math.max(v.estimatedCost, v.uncappedCost ?? 0), 6);
  return {
    videoId: project.id,
    title: project.title,
    batchId,
    currentStatus: status,
    nextStep,
    nextAction:
      nextStep === "NONE"
        ? "KIỂM TRA LẠI"
        : nextStep === "GENERATE" || nextStep === "RENDER_ONLY"
          ? "TIẾP TỤC"
          : nextStep === "BLOCKED"
            ? "XEM LÝ DO"
            : nextStep === "RECOVER"
              ? "KIỂM TRA"
              : null,
    assetsPresent: present,
    assetsMissing: missing,
    assetsReusable: reusable,
    paidRequestsRequired: paid,
    localWorkRequired: local,
    // UNCAPPED: the estimator stops pricing when a video's limit runs out, so
    // estimatedCost can be only the part that fitted (QĐ-081). A resume must be
    // judged on the whole of what is still missing.
    estimatedIncrementalCost: incremental,
    blockedReason,
    recovery,
    verdict: nextStep === "BLOCKED" && v.spend.status === "BLOCKED" ? v.spend : null,
    safeToContinue: nextStep === "GENERATE" || nextStep === "RENDER_ONLY",
    videoChoices,
    fingerprint: fingerprintOf(videoChoices, incremental, paid.total),
    progress,
    budget,
  };
}

/** Plans for every video of a batch, from ONE preflight. */
export async function buildBatchResumePlans(batchId: string, opts: { ignoreLockOwnerFor?: Set<string> } = {}): Promise<VideoResumePlan[]> {
  const pre = await preflightImportedBatch(batchId);
  const projects = await prisma.project.findMany({
    where: { batchId },
    select: { id: true, title: true, status: true, finalVideoPath: true, subtitlePath: true, outputDir: true },
  });
  const byId = new Map(projects.map((p) => [p.id, p]));
  const frozen = await frozenChoicesForBatch(batchId);
  const plans: VideoResumePlan[] = [];
  for (const v of pre.videos) {
    const project = byId.get(v.projectId);
    if (!project) continue;
    const active = isVideoRunning(v.projectId) && !opts.ignoreLockOwnerFor?.has(v.projectId);
    const recovery = await recoveryItemsForProject(v.projectId, { isActive: active });
    plans.push(planFrom(v, project, batchId, recovery, active, await budgetFor(batchId, v.projectId, v.videoLimit), frozen));
  }
  return plans;
}

/** THE per-video resume plan. Reads only; spends and sends nothing. */
export async function buildVideoResumePlan(projectId: string, opts: { ignoreOwnLock?: boolean } = {}): Promise<VideoResumePlan> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { batchId: true } });
  if (!project.batchId) throw new Error("Video này không thuộc lô nào — hãy dùng DUYỆT & CHẠY của dự án.");
  const plans = await buildBatchResumePlans(project.batchId, {
    ignoreLockOwnerFor: opts.ignoreOwnLock ? new Set([projectId]) : undefined,
  });
  const plan = plans.find((p) => p.videoId === projectId);
  if (!plan) throw new Error(`Không tìm thấy video ${projectId} trong lô.`);
  return plan;
}

export type ContinueStatus =
  | "NOOP"
  | "STARTED"
  | "COMPLETED"
  | "NEEDS_CONFIRMATION"
  | "ALREADY_RUNNING"
  | "BLOCKED"
  | "NEEDS_RECOVERY";

export interface ContinueResult {
  status: ContinueStatus;
  message: string;
  plan?: VideoResumePlan;
  verdict?: SpendVerdict;
  run?: RunSummary;
}

/**
 * Before any paid step: the approval must be live (re-opened within its own
 * ceiling if it was closed), and the incremental cost must fit video, batch and
 * global headroom as they are NOW. The gate re-checks all of it again at the
 * POST itself.
 */
async function checkPaidContinue(batchId: string, plan: VideoResumePlan): Promise<SpendVerdict | string | null> {
  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId } });
  if (!auth || auth.status === "DRAFT") {
    return "Lô chưa được duyệt chi. Hãy PREFLIGHT rồi DUYỆT & CHẠY lô trước.";
  }
  if (auth.status === "CANCELLED") return "Quyền chi của lô đã bị huỷ.";
  const verdict = evaluateSpendLimits({
    label: plan.title,
    estimatedCost: plan.estimatedIncrementalCost ?? 0,
    global: { cap: plan.budget.globalRemaining, used: 0 },
    batch: { limit: plan.budget.batchRemaining, used: 0 },
    video: { limit: plan.budget.videoRemaining, used: 0 },
  });
  if (verdict.status === "BLOCKED") return verdict;
  try {
    await resumeAuthorization(batchId);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

function describeChoices(choices: VideoChoice[]): string {
  if (choices.length === 0) return "";
  return (
    " Clip sẽ mua: " +
    choices
      .map(
        (c) =>
          `cảnh ${c.sceneNumber} → ${c.provider}/${c.model} ${c.durationSeconds}s $${c.estimatedCost.toFixed(6)}` +
          (c.frozen ? " (model đã duyệt)" : " (MỚI — xác nhận này sẽ chốt model)"),
      )
      .join("; ") +
    "."
  );
}

/**
 * The person's yes to a continue is an approval of THESE clips: every clip not
 * yet frozen is frozen now, with the model it was shown with (QĐ-111).
 */
async function freezeConfirmed(batchId: string, plans: VideoResumePlan[]): Promise<void> {
  const at = new Date().toISOString();
  const entries: FrozenVideoMap = {};
  for (const plan of plans) {
    for (const c of plan.videoChoices) {
      if (c.frozen) continue;
      const scene = await prisma.scene.findUnique({ where: { id: c.sceneId }, select: { videoModelPinned: true } });
      entries[c.sceneId] = {
        provider: c.provider,
        model: c.model,
        durationSeconds: c.durationSeconds,
        estimatedCost: c.estimatedCost,
        lowAuto: c.lowAuto,
        pinned: scene?.videoModelPinned ?? false,
        frozenAt: at,
      };
    }
  }
  await freezeVideoChoices(batchId, entries, { approved: true });
}

const PLAN_CHANGED =
  "PLAN_CHANGED: kế hoạch (model / giá / số request) đã đổi từ lúc bạn xem. KHÔNG gửi request — hãy xem lại rồi xác nhận.";

/**
 * TIẾP TỤC for ONE video. Idempotent: a second call while the first is running
 * answers ALREADY_RUNNING; on a finished video it is a no-op that touches
 * nothing. Paid work asks first (confirmPaid); local-only work just runs.
 */
export async function continueVideo(
  projectId: string,
  opts: {
    confirmPaid?: boolean;
    wait?: boolean;
    /** The plan the person confirmed (VideoResumePlan.fingerprint). A different plan now is a stop. */
    expectedFingerprint?: string;
  } = {},
): Promise<ContinueResult> {
  const owner = `continue:${projectId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  // Taken before the first await: a double click cannot get past this line twice.
  if (!tryLockVideo(projectId, owner)) {
    return { status: "ALREADY_RUNNING", message: "ALREADY_RUNNING: video này đang chạy — không mở lần chạy thứ hai." };
  }
  let handedOff = false;
  try {
    const plan = await buildVideoResumePlan(projectId, { ignoreOwnLock: true });
    switch (plan.nextStep) {
      case "NONE":
        return { status: "NOOP", message: "Video đã hoàn thành.", plan };
      case "BLOCKED":
        return { status: "BLOCKED", message: `BLOCKED: ${plan.blockedReason ?? "không chạy được"}`, plan, verdict: plan.verdict ?? undefined };
      case "RECOVER":
        return { status: "NEEDS_RECOVERY", message: plan.blockedReason ?? "Cần kiểm tra trước khi gửi lại.", plan };
      case "ALREADY_RUNNING":
        return { status: "ALREADY_RUNNING", message: "ALREADY_RUNNING", plan };
    }
    if (plan.paidRequestsRequired.total > 0) {
      if (!opts.confirmPaid) {
        return {
          status: "NEEDS_CONFIRMATION",
          message:
            `Còn thiếu ${plan.paidRequestsRequired.total} request trả phí ` +
            `(ảnh ${plan.paidRequestsRequired.image} · video ${plan.paidRequestsRequired.video} · giọng ${plan.paidRequestsRequired.voice}), ` +
            `dự toán tăng thêm $${(plan.estimatedIncrementalCost ?? 0).toFixed(6)}.` +
            describeChoices(plan.videoChoices) +
            " Cần xác nhận.",
          plan,
        };
      }
      if (opts.expectedFingerprint !== undefined && opts.expectedFingerprint !== plan.fingerprint) {
        return { status: "BLOCKED", message: PLAN_CHANGED, plan };
      }
      const refusal = await checkPaidContinue(plan.batchId, plan);
      if (refusal) {
        return typeof refusal === "string"
          ? { status: "BLOCKED", message: `BLOCKED: ${refusal}`, plan }
          : { status: "BLOCKED", message: `${refusal.reasonCode}: ${refusal.message} KHÔNG gửi request.`, plan, verdict: refusal };
      }
      await freezeConfirmed(plan.batchId, [plan]);
    }
    await logger.info({
      event: "video.continue",
      projectId,
      message:
        `TIẾP TỤC "${plan.title}": ${plan.nextStep}, request trả phí ${plan.paidRequestsRequired.total}, ` +
        `việc tại máy [${plan.localWorkRequired.join(", ")}], dự toán tăng thêm $${(plan.estimatedIncrementalCost ?? 0).toFixed(6)}.`,
    });
    // The run takes over THIS lock (same owner) and releases it when done.
    const run = runBatch(plan.batchId, { resume: true, onlyProjectIds: [projectId], lockOwner: owner }).finally(() =>
      unlockVideo(projectId, owner),
    );
    handedOff = true;
    if (!opts.wait) {
      void run.catch(() => undefined);
      return { status: "STARTED", message: `Đang chạy tiếp "${plan.title}".`, plan };
    }
    const summary = await run;
    return { status: "COMPLETED", message: `Đã chạy tiếp "${plan.title}".`, plan, run: summary };
  } finally {
    if (!handedOff) unlockVideo(projectId, owner);
  }
}

export interface ContinueAllResult {
  status: "NOTHING_TO_DO" | "NEEDS_CONFIRMATION" | "STARTED" | "COMPLETED" | "BLOCKED";
  message: string;
  runnable: VideoResumePlan[];
  skipped: { plan: VideoResumePlan; why: string }[];
  /** Sum of the runnable videos' INCREMENTAL cost - what this covers. */
  authorizationAmount: number;
  /** Of the runnable plans together; a confirmation carries it back. */
  fingerprint?: string;
  run?: RunSummary;
  /**
   * V1.2 Phase 6 (QĐ-114), what a person reads before pressing anything:
   * "12 video: 8 tiếp tục $0 · 3 cần thêm $0.42 · 1 bị chặn".
   */
  summary: BulkResumeSummary;
}

export interface BulkResumeSummary {
  total: number;
  completed: number;
  /** Can continue without any paid request. */
  zeroCost: number;
  /** Need at least one paid request, and how much together (incremental). */
  paid: number;
  paidAmount: number;
  blocked: number;
  needsRecovery: number;
  running: number;
}

export function summarizeResumePlans(plans: VideoResumePlan[]): BulkResumeSummary {
  const s: BulkResumeSummary = { total: plans.length, completed: 0, zeroCost: 0, paid: 0, paidAmount: 0, blocked: 0, needsRecovery: 0, running: 0 };
  for (const p of plans) {
    if (p.nextStep === "NONE") s.completed += 1;
    else if (p.nextStep === "BLOCKED") s.blocked += 1;
    else if (p.nextStep === "RECOVER") s.needsRecovery += 1;
    else if (p.nextStep === "ALREADY_RUNNING") s.running += 1;
    else if (p.paidRequestsRequired.total > 0) {
      s.paid += 1;
      s.paidAmount += p.estimatedIncrementalCost ?? 0;
    } else s.zeroCost += 1;
  }
  s.paidAmount = round(s.paidAmount, 6);
  return s;
}

/**
 * TIẾP TỤC TẤT CẢ VIDEO ĐỦ ĐIỀU KIỆN. Still one plan per video; COMPLETED is
 * skipped, and so are BLOCKED, NEEDS_RECOVERY and ALREADY_RUNNING. What is left
 * is fitted into the batch / global headroom with the Phase 2 planner.
 */
export async function continueAllEligible(
  batchId: string,
  opts: {
    confirmPaid?: boolean;
    wait?: boolean;
    expectedFingerprint?: string;
    /** Phase 6: only the videos that need no paid request (no confirmation asked). */
    zeroCostOnly?: boolean;
    /** Phase 6: only these videos (TIẾP TỤC VIDEO ĐÃ CHỌN). */
    onlyProjectIds?: string[];
  } = {},
): Promise<ContinueAllResult> {
  const all = await buildBatchResumePlans(batchId);
  const plans = opts.onlyProjectIds ? all.filter((p) => opts.onlyProjectIds!.includes(p.videoId)) : all;
  const summary = summarizeResumePlans(plans);
  const skipped: ContinueAllResult["skipped"] = [];
  const eligible: VideoResumePlan[] = [];
  for (const p of plans) {
    if ((p.nextStep === "GENERATE" || p.nextStep === "RENDER_ONLY") && !(opts.zeroCostOnly && p.paidRequestsRequired.total > 0)) {
      eligible.push(p);
    } else {
      skipped.push({
        plan: p,
        why: p.nextStep === "NONE" ? "COMPLETED" : opts.zeroCostOnly && p.paidRequestsRequired.total > 0 ? "CẦN CHI PHÍ — không nằm trong lượt $0" : p.nextStep,
      });
    }
  }
  if (eligible.length === 0) {
    return { status: "NOTHING_TO_DO", message: "Không có video nào cần tiếp tục.", runnable: [], skipped, authorizationAmount: 0, summary };
  }
  const first = eligible[0]!.budget;
  const money = planBatchSpend({
    videos: eligible.map((p, i) => ({
      id: p.videoId,
      title: p.title,
      order: i,
      videoLimit: p.budget.videoRemaining,
      scenes: [{ sceneNumber: 0, incrementalCost: p.estimatedIncrementalCost ?? 0, limit: null }],
    })),
    batchLimit: first.batchRemaining,
    globalRemaining: first.globalRemaining,
  });
  const runnable = eligible.filter((p) => money.runnable.some((r) => r.id === p.videoId));
  for (const b of money.blocked) {
    const p = eligible.find((e) => e.videoId === b.id)!;
    skipped.push({ plan: p, why: `${b.verdict.reasonCode}: ${b.verdict.message}` });
  }
  const paid = runnable.reduce((n, p) => n + p.paidRequestsRequired.total, 0);
  const fingerprint = createHash("sha256")
    .update(runnable.map((p) => `${p.videoId}:${p.fingerprint}`).join("|"))
    .digest("hex")
    .slice(0, 16);
  const base = { runnable, skipped, authorizationAmount: money.authorizationAmount, fingerprint, summary };
  if (runnable.length === 0) return { ...base, status: "BLOCKED", message: "Không video nào vừa hạn mức còn lại." };
  if (paid > 0 && !opts.confirmPaid) {
    return {
      ...base,
      status: "NEEDS_CONFIRMATION",
      message:
        `${runnable.length} video, ${paid} request trả phí, dự toán tăng thêm $${money.authorizationAmount.toFixed(6)}.` +
        describeChoices(runnable.flatMap((p) => p.videoChoices)) +
        " Cần xác nhận.",
    };
  }
  if (paid > 0) {
    if (opts.expectedFingerprint !== undefined && opts.expectedFingerprint !== fingerprint) {
      return { ...base, status: "BLOCKED", message: PLAN_CHANGED };
    }
    try {
      await resumeAuthorization(batchId);
    } catch (err) {
      return { ...base, status: "BLOCKED", message: `BLOCKED: ${err instanceof Error ? err.message : String(err)}` };
    }
    await freezeConfirmed(batchId, runnable);
  }
  // Each video is locked for this run; one already taken is left to its owner.
  const owner = `continue-all:${batchId}:${Date.now().toString(36)}`;
  const mine = runnable.filter((p) => tryLockVideo(p.videoId, owner)).map((p) => p.videoId);
  const run = runBatch(batchId, { resume: true, onlyProjectIds: mine, lockOwner: owner }).finally(() => {
    for (const id of mine) unlockVideo(id, owner);
  });
  if (!opts.wait) {
    void run.catch(() => undefined);
    return { ...base, status: "STARTED", message: `Đang chạy tiếp ${mine.length} video.` };
  }
  return { ...base, status: "COMPLETED", message: `Đã chạy tiếp ${mine.length} video.`, run: await run };
}

/**
 * KIỂM TRA / RECOVER. For a request the vendor accepted and nobody is watching,
 * re-attach and poll it (the generation path finds the task id and never
 * creates a new one). A request that failed after it may have left is only
 * reported here: archiving it for a new purchase is a separate, explicit act
 * (acknowledgeRecovery).
 */
export async function recoverVideo(projectId: string): Promise<{ attached: number; needsAcknowledgement: RecoveryItem[]; message: string }> {
  const owner = `recover:${projectId}:${Date.now().toString(36)}`;
  if (!tryLockVideo(projectId, owner)) {
    return { attached: 0, needsAcknowledgement: [], message: "ALREADY_RUNNING: video này đang chạy." };
  }
  try {
    const items = await recoveryItemsForProject(projectId);
    let attached = 0;
    for (const item of items.filter((i) => i.reason === "IN_FLIGHT" && i.sceneId)) {
      const kind = item.kind === "audio" ? "voice" : (item.kind as "image" | "video");
      await executeSceneAsset(item.sceneId!, kind);
      attached += 1;
    }
    const needsAcknowledgement = items.filter((i) => i.reason === "POSSIBLY_CHARGED");
    return {
      attached,
      needsAcknowledgement,
      message:
        (attached > 0 ? `Đã theo dõi tiếp ${attached} yêu cầu đang chờ (không gửi lại). ` : "") +
        (needsAcknowledgement.length > 0
          ? `${needsAcknowledgement.length} yêu cầu có thể đã tính tiền: kiểm tra phía nhà cung cấp, rồi bấm "ĐÃ KIỂM TRA" nếu muốn mua lại.`
          : ""),
    };
  } finally {
    unlockVideo(projectId, owner);
  }
}
