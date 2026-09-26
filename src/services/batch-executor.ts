import fs from "node:fs";
import type { Job } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { toAbsolute } from "@/lib/paths";
import { parseJson } from "@/lib/utils";
import { peekCreateToken } from "@/services/create-token";
import { confirmedProviders, spendStatus } from "@/services/spend-guard";
import { providerSpendBreakdown } from "@/services/provider-budget";
import { availableProviderNames } from "@/services/provider-health";
import { approveAuthorization, resumeAuthorization } from "@/services/batch-authorization";
import { release as releaseReservation } from "@/services/cost-reservation";
import { preflightImportedBatch, type ImportPreflight } from "@/services/import-preflight";
import { isRunnable, settleBatchIfDone, storedPlan } from "@/services/batch-runner";
import {
  batchSource,
  checkVideoAgainstCap,
  materializeIdiomVideos,
  pendingIdiomVideos,
  type BatchSource,
} from "@/services/batch-sources";
import { generateSceneImage, generateSceneVideo, generateSceneVoice } from "@/services/generation";
import { existingOutputFor, exportProjectOutput, missingOutputFiles } from "@/services/output-export";
import { recommendAuthorization } from "@/domain/cost-basis";
import { currentRun, isRunning, registerRun } from "@/services/run-registry";
import { completeJob, failJob } from "@/jobs/queue";
import { runJob } from "@/jobs/handlers";

/**
 * THE production executor for a batch whose videos already exist as rows - an
 * imported storyboard batch. One implementation, two callers: the CLI
 * (`scripts/run-real-multi-batch.ts`) and the DUYỆT & CHẠY / TIẾP TỤC buttons.
 * There is no second pipeline for the UI.
 *
 * Why it does not go through the job queue: the queue retries a failed job
 * (`maxRetries`) and ends every scene with `evaluateScene`. Both are right for
 * free work and wrong for paid work, where the rule is ONE paid attempt per
 * asset, no automatic retry, no silent fallback. So scenes are driven here, one
 * step at a time, through the same generation functions - which keep every gate
 * of their own (idempotency key, reuse, global cap, batch authorisation,
 * per-video cap, provider scope, LOW_AUTO grant, reservation) in front of every
 * paid POST. Nothing here can bypass them; this file only decides the ORDER.
 *
 * On top of those gates it re-reads the four ceilings before every paid step
 * (this video, this batch, the project, each vendor wallet), because figures
 * captured when the batch started are stale by the third purchase - in the
 * direction that permits spending.
 *
 * A BLOCKED video is skipped and marked, never allowed to stop a READY one.
 * A failure stops THAT video at the scene that failed; the others continue.
 */

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const money = (n: number) => `$${n.toFixed(6)}`;

// ------------------------------------------------------------------ checks ---

export interface ApprovalCheck {
  label: string;
  ok: boolean;
  detail: string;
  /** A failing blocking check means the batch may not be approved or run. */
  blocking: boolean;
}

export interface ApprovalPreflight {
  batchId: string;
  /** Where the videos come from. The run after approval is identical for both. */
  source: BatchSource;
  /** Row-level preview (imported / existing projects). Null for an idiom plan. */
  preflight: ImportPreflight | null;
  maxCostPerVideo: number;
  textPosts: number;
  checks: ApprovalCheck[];
  ready: boolean;
  runnableVideos: number;
  blockedVideos: number;
  estimatedTotal: number;
  globalRemaining: number;
  globalCap: number;
  recommendedAuthorization: number;
  /** Video models the plan routes to. Anything else at run time is a stop. */
  plannedVideoModels: string[];
  /** True when at least one clip will be chosen by the router (LOW_AUTO). */
  usesLowAuto: boolean;
  imagePosts: number;
  videoPosts: number;
  voicePosts: number;
  importedImages: number;
  willCreateImages: number;
  mockMode: boolean;
  batchStatus: string;
  authorizationStatus: string;
}

/**
 * What the approval checks need, whatever the source. Both sources are reduced
 * to this shape and then judged by ONE function - there is one approval logic.
 */
interface ApprovalInput {
  source: BatchSource;
  preflight: ImportPreflight | null;
  maxCostPerVideo: number;
  runnable: { title: string; estimatedCost: number }[];
  blocked: { title: string; reason: string }[];
  estimatedTotal: number;
  paidModels: { key: string; confirmed: boolean }[];
  plannedVideoModels: string[];
  posts: { text: number; image: number; video: number; voice: number };
  importedImages: number;
  willCreateImages: number;
  usesLowAuto: boolean;
}

/** IDIOM_GENERATED, before its projects exist: priced from the approved plan. */
async function idiomApprovalInput(batchId: string): Promise<ApprovalInput> {
  const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
  const plan = storedPlan(batch);
  if (!plan) throw new ExecutorError("Lô này chưa có bản dự toán. Hãy PHÂN TÍCH & DỰ TOÁN trước.");
  const costing = plan.production ?? plan.runtime;
  const videos = costing.videos.filter((v) => v.idiomId);
  const runnable = videos.filter((v) => isRunnable(v.status));
  const blocked = videos.filter((v) => !isRunnable(v.status));
  const scenes = runnable.flatMap((v) => v.scenes);
  const plannedVideoModels = [
    ...new Set(
      scenes
        .filter((sc) => sc.motionSource !== "LOCAL_MOTION" && sc.videoProvider && sc.videoModel)
        .map((sc) => `${sc.videoProvider}/${sc.videoModel}`),
    ),
  ];
  // The plan does not name the text / image / voice models, so the one model
  // the router can pick for each stage is what gets confirmed. `gateChecks`
  // also refuses when a stage has more than one - so this IS the model used.
  const confirmed = await confirmedProviders();
  const providers = (await availableProviderNames()).filter((p) => p !== "mock");
  const paidModels: { key: string; confirmed: boolean }[] = [];
  for (const type of ["text", "image", "voice"]) {
    const pool = await prisma.modelRegistry.findMany({
      where: {
        enabled: true,
        type,
        provider: { in: providers },
        reliability: "OK",
        lifecycle: { notIn: ["DEPRECATED", "DISABLED", "PIN_ONLY"] },
      },
      select: { provider: true, modelId: true },
    });
    for (const m of pool) {
      const key = `${m.provider}/${m.modelId}`;
      paidModels.push({ key, confirmed: confirmed.includes(key) });
    }
  }
  for (const key of plannedVideoModels) {
    if (!key.startsWith("mock/")) paidModels.push({ key, confirmed: confirmed.includes(key) });
  }
  return {
    source: "IDIOM_GENERATED",
    preflight: null,
    maxCostPerVideo: batch.maxCostPerVideo,
    runnable: runnable.map((v) => ({ title: v.phrase, estimatedCost: v.estimatedCost })),
    blocked: blocked.map((v) => ({ title: v.phrase, reason: v.status })),
    estimatedTotal: costing.estimatedTotal,
    paidModels,
    plannedVideoModels,
    posts: {
      // One script per video; one keyframe and one voice track per scene (the
      // plan prices every scene's keyframe); one clip per scene off LOCAL_MOTION.
      text: runnable.length,
      image: scenes.length,
      video: scenes.filter((sc) => sc.motionSource !== "LOCAL_MOTION" && sc.videoModel).length,
      voice: scenes.length,
    },
    importedImages: 0,
    willCreateImages: scenes.length,
    usesLowAuto: plannedVideoModels.length > 0,
  };
}

/** Rows exist (imported storyboard, or a project wrapped into a batch). */
async function rowsApprovalInput(batchId: string, resume: boolean): Promise<ApprovalInput> {
  const pre = await preflightImportedBatch(batchId);
  const runnable = pre.videos.filter((v) =>
    resume ? v.lifecycle !== "BLOCKED" && v.lifecycle !== "COMPLETED" : v.lifecycle === "READY",
  );
  const blocked = pre.videos.filter((v) => v.lifecycle === "BLOCKED");
  // A clip the ROUTER will choose (no hand pin) needs the separate LOW_AUTO yes.
  let usesLowAuto = false;
  for (const v of runnable) {
    const buying = v.scenes.filter((sc) => sc.plan.video === "BUY").map((sc) => sc.sceneNumber);
    if (buying.length === 0) continue;
    const unpinned = await prisma.scene.count({
      where: { projectId: v.projectId, sceneNumber: { in: buying }, videoModelPinned: false },
    });
    if (unpinned > 0) usesLowAuto = true;
  }
  return {
    source: await batchSource(batchId),
    preflight: pre,
    maxCostPerVideo: pre.maxCostPerVideo,
    runnable: runnable.map((v) => ({ title: v.title, estimatedCost: v.estimatedCost })),
    blocked: blocked.map((v) => ({ title: v.title, reason: v.blockedReason ?? v.status })),
    estimatedTotal: pre.estimatedTotal,
    paidModels: pre.paidModels,
    plannedVideoModels: [
      ...new Set(runnable.flatMap((v) => v.scenes.map((sc) => sc.videoModel).filter((m): m is string => Boolean(m)))),
    ],
    posts: { text: 0, image: pre.counts.imagePosts, video: pre.counts.videoPosts, voice: pre.counts.voicePosts },
    importedImages: pre.counts.imageImported,
    willCreateImages: pre.counts.imageBuy,
    usesLowAuto,
  };
}

/** THE approval checks - one implementation for every source. */
async function gateChecks(
  batchId: string,
  input: ApprovalInput,
  opts: { maxBatch?: number; maxPerVideo?: number; resume?: boolean },
): Promise<ApprovalPreflight> {
  const [cap, providers, token, batch, auth, wallets] = await Promise.all([
    spendStatus(),
    availableProviderNames(),
    peekCreateToken(),
    prisma.batch.findUniqueOrThrow({ where: { id: batchId } }),
    prisma.batchAuthorization.findUnique({ where: { batchId } }),
    providerSpendBreakdown(),
  ]);
  const mock = isMockMode();
  const checks: ApprovalCheck[] = [];
  const add = (label: string, ok: boolean, detail: string, blocking = true) =>
    checks.push({ label, ok, detail, blocking });

  add("Có video chạy được", input.runnable.length > 0 || Boolean(opts.resume), `${input.runnable.length} video`);
  for (const v of input.blocked) {
    // Named, never silent - and NOT blocking: one video's problem is its own.
    add(`${v.title}: BLOCKED — sẽ bỏ qua`, false, v.reason, false);
  }
  if (opts.maxPerVideo !== undefined) {
    for (const v of input.runnable) {
      add(`${v.title} ≤ trần/video ${money(opts.maxPerVideo)}`, v.estimatedCost <= opts.maxPerVideo + 1e-9, money(v.estimatedCost));
    }
  }
  if (opts.maxBatch !== undefined) {
    add("Trần lô > 0", opts.maxBatch > 0, money(opts.maxBatch));
    add(`Dự toán ≤ trần lô ${money(opts.maxBatch)}`, input.estimatedTotal <= opts.maxBatch + 1e-9, money(input.estimatedTotal));
    add(
      "Trần lô ≤ ngân sách toàn cục còn lại",
      opts.maxBatch <= cap.remaining + 1e-9,
      `${money(opts.maxBatch)} vs còn ${money(cap.remaining)} — không tự nâng hạn mức`,
    );
  }
  add("Dự toán ≤ ngân sách toàn cục còn lại", input.estimatedTotal <= cap.remaining + 1e-9, `${money(input.estimatedTotal)} vs ${money(cap.remaining)}`);

  // The second money lock: a person looked at THIS model's price and agreed.
  const unconfirmed = input.paidModels.filter((m) => !m.confirmed);
  add(
    "Mọi model trả phí đã được xác nhận giá",
    unconfirmed.length === 0,
    unconfirmed.length === 0 ? input.paidModels.map((m) => m.key).join(", ") || "(không có)" : unconfirmed.map((m) => m.key).join(", "),
  );
  for (const key of input.plannedVideoModels) {
    const [provider, ...rest] = key.split("/");
    const row = await prisma.modelRegistry.findUnique({
      where: { provider_modelId: { provider: provider!, modelId: rest.join("/") } },
    });
    add(
      `${key}: không DEGRADED/DEPRECATED/DISABLED`,
      row !== null && row.reliability === "OK" && !["DEPRECATED", "DISABLED"].includes(row.lifecycle),
      row ? `${row.lifecycle} / ${row.reliability}` : "không có trong registry",
    );
  }

  if (!mock) {
    add("Mock KHÔNG khả dụng khi chạy thật", !providers.includes("mock"), providers.join(", "));
    // No silent fallback: `withFallback` only ever tries OTHER auto-routable
    // models, so when a stage has exactly one there is nothing to fall back to.
    const stages: [string, number][] = [
      ["text", input.posts.text],
      ["image", input.posts.image],
      ["video", input.posts.video],
      ["voice", input.posts.voice],
    ];
    for (const [type, posts] of stages) {
      if (posts === 0) continue;
      const pool = await prisma.modelRegistry.findMany({
        where: {
          enabled: true,
          type,
          provider: { in: providers.filter((p) => p !== "mock") },
          reliability: "OK",
          lifecycle: { notIn: ["DEPRECATED", "DISABLED", "PIN_ONLY"] },
        },
        select: { provider: true, modelId: true },
      });
      add(
        `${type}: 1 model tự chọn được → không có dự phòng ngầm`,
        pool.length <= 1,
        pool.map((m) => `${m.provider}/${m.modelId}`).join(", ") || "(chỉ ghim tay)",
      );
    }
    const scope = new Set(input.paidModels.map((m) => m.key.split("/")[0]));
    for (const w of wallets) {
      if (!scope.has(w.provider)) continue;
      if (w.remainingUsd !== null && w.remainingUsd <= 0) add(`Ví ${w.provider} còn tiền`, false, money(w.remainingUsd));
    }
  }

  add("CREATE_ATTEMPT_TOKEN trống", token === null, token === null ? "null" : "CÒN");
  if (opts.resume) {
    add("Lô không bị huỷ", batch.status !== "CANCELLED", batch.status);
  } else {
    add("Lô đang PLANNED", batch.status === "PLANNED", batch.status);
    add("Quyền chi đang DRAFT", auth?.status === "DRAFT", auth?.status ?? "không có");
  }

  return {
    batchId,
    source: input.source,
    preflight: input.preflight,
    maxCostPerVideo: input.maxCostPerVideo,
    textPosts: input.posts.text,
    checks,
    ready: checks.every((c) => c.ok || !c.blocking),
    runnableVideos: input.runnable.length,
    blockedVideos: input.blocked.length,
    estimatedTotal: input.estimatedTotal,
    globalRemaining: cap.remaining,
    globalCap: cap.cap,
    recommendedAuthorization: recommendAuthorization(input.estimatedTotal, Number.MAX_SAFE_INTEGER).recommended,
    plannedVideoModels: input.plannedVideoModels,
    usesLowAuto: input.usesLowAuto,
    imagePosts: input.posts.image,
    videoPosts: input.posts.video,
    voicePosts: input.posts.voice,
    importedImages: input.importedImages,
    willCreateImages: input.willCreateImages,
    mockMode: mock,
    batchStatus: batch.status,
    authorizationStatus: auth?.status ?? "NONE",
  };
}

/**
 * Everything a person must see before approving money, computed by the same
 * preflight the CLI prints. `maxBatch` / `maxPerVideo` are the figures they are
 * about to type; given, they are checked too. Spends nothing, POSTs nothing.
 *
 * Idioms not yet turned into projects are priced from the approved plan; rows
 * that exist are priced from the rows. The checks after that are the same
 * function for both.
 */
export async function preflightForApproval(
  batchId: string,
  opts: { maxBatch?: number; maxPerVideo?: number; resume?: boolean } = {},
): Promise<ApprovalPreflight> {
  const input =
    (await pendingIdiomVideos(batchId)) > 0
      ? await idiomApprovalInput(batchId)
      : await rowsApprovalInput(batchId, Boolean(opts.resume));
  return gateChecks(batchId, input, opts);
}

// ------------------------------------------------------------------ approve ---

export class ExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorError";
  }
}

/**
 * Approve an amount the PERSON typed, then start the run in the background.
 *
 * Never raises a budget: the global cap is checked by `approveAuthorization`
 * and by the preflight, and `maxBatch` above what is left is refused - not
 * trimmed. `lowAutoApproved` is a separate yes, exactly as on the CLI.
 */
export async function approveAndRun(opts: {
  batchId: string;
  maxBatch: number;
  maxPerVideo?: number;
  lowAutoApproved: boolean;
  /** Tests await the run; the UI does not. */
  wait?: boolean;
}): Promise<{ preflight: ApprovalPreflight; run?: RunSummary }> {
  if (!Number.isFinite(opts.maxBatch) || opts.maxBatch <= 0) {
    throw new ExecutorError("Trần chi của lô phải là một số lớn hơn 0.");
  }
  if (opts.maxPerVideo !== undefined && (!Number.isFinite(opts.maxPerVideo) || opts.maxPerVideo <= 0)) {
    throw new ExecutorError("Trần chi mỗi video phải là một số lớn hơn 0.");
  }
  if (isRunning(opts.batchId)) throw new ExecutorError("Lô này đang chạy.");

  const check = await preflightForApproval(opts.batchId, {
    maxBatch: opts.maxBatch,
    maxPerVideo: opts.maxPerVideo,
  });
  if (!check.ready) {
    const failed = check.checks.filter((c) => !c.ok && c.blocking).map((c) => `${c.label} (${c.detail})`);
    throw new ExecutorError(`Chưa duyệt được: ${failed.join(" · ")}`);
  }
  if (check.usesLowAuto && !opts.lowAutoApproved && !check.mockMode) {
    throw new ExecutorError(
      "Lô có clip do router tự chọn (LOW_AUTO). Hãy tick đồng ý cho router tự chọn model, hoặc ghim model cho cảnh.",
    );
  }

  if (opts.maxPerVideo !== undefined) {
    await prisma.batch.update({ where: { id: opts.batchId }, data: { maxCostPerVideo: opts.maxPerVideo } });
    await prisma.batchAuthorization.updateMany({
      where: { batchId: opts.batchId, status: "DRAFT" },
      data: { maxCostPerVideo: opts.maxPerVideo },
    });
  }
  // The note carries the plan the person approved, so the run can refuse a
  // model it did not show.
  await approveAuthorization({
    batchId: opts.batchId,
    authorizedMaxSpend: opts.maxBatch,
    note: JSON.stringify({ plannedVideoModels: check.plannedVideoModels }),
    lowAutoApproved: opts.lowAutoApproved,
  });

  const run = startRun(opts.batchId, { resume: false });
  return { preflight: check, run: opts.wait ? await run : undefined };
}

// ---------------------------------------------------------------------- run ---

export interface VideoOutcome {
  projectId: string;
  title: string;
  /** Empty when the video finished. */
  stopped: string;
  rendered: boolean;
  skipped: boolean;
  outputDir: string | null;
}

export interface RunSummary {
  batchId: string;
  outcomes: VideoOutcome[];
  settledStatus: string | null;
  releasedReservations: number;
}

export { isRunning } from "@/services/run-registry";

/** Start (or return) the run for a batch. The UI does not await it. */
export function startRun(
  batchId: string,
  opts: { resume: boolean; onlyProjectIds?: string[] },
): Promise<RunSummary> {
  const existing = currentRun<RunSummary>(batchId);
  if (existing) return existing;
  const run = runBatch(batchId, opts)
    .catch(async (err) => {
      await logger.error({
        event: "batch.run_crashed",
        message: `Lô ${batchId}: ${err instanceof Error ? err.message : String(err)}`,
      });
      await prisma.batch.update({ where: { id: batchId }, data: { status: "NEEDS_REVIEW" } }).catch(() => undefined);
      return { batchId, outcomes: [], settledStatus: "NEEDS_REVIEW", releasedReservations: 0 } as RunSummary;
    });
  return registerRun(batchId, run);
}

/** Resume: never re-approves. A closed approval can only reuse. */
export async function resumeRun(opts: {
  batchId: string;
  onlyProjectIds?: string[];
  wait?: boolean;
}): Promise<RunSummary | undefined> {
  if (isRunning(opts.batchId)) throw new ExecutorError("Lô này đang chạy.");
  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId: opts.batchId } });
  if (!auth || auth.status === "DRAFT") {
    throw new ExecutorError("Lô chưa được duyệt chi. Hãy PREFLIGHT rồi DUYỆT & CHẠY trước.");
  }
  // A batch the person STOPPED (or that ran out mid-way with money still left)
  // resumes on the SAME approval: same ceiling, same tally. Never a new one -
  // `resumeAuthorization` refuses when the ceiling is used up. A COMPLETED
  // approval stays closed: resuming a finished batch can only reuse.
  if (auth.status === "CANCELLED" || auth.status === "EXHAUSTED") {
    await resumeAuthorization(opts.batchId);
  }
  const run = startRun(opts.batchId, { resume: true, onlyProjectIds: opts.onlyProjectIds });
  return opts.wait ? run : undefined;
}

async function spentOnProject(projectId: string): Promise<number> {
  const row = await prisma.costEntry.aggregate({
    where: { projectId, estimated: false },
    _sum: { amount: true },
  });
  return round(row._sum.amount ?? 0);
}

async function spentOnBatch(batchId: string): Promise<number> {
  const projects = await prisma.project.findMany({ where: { batchId }, select: { id: true } });
  let total = 0;
  for (const p of projects) total += await spentOnProject(p.id);
  return round(total);
}

interface Ceilings {
  perVideo: number;
  batch: number;
  /**
   * Providers this batch was approved to pay. Only THEIR wallets can stop it:
   * an empty Runway wallet is no reason to stop a batch that only pays OpenAI.
   */
  providers: string[];
}

async function assertHeadroom(projectId: string, batchId: string, ceilings: Ceilings, what: string): Promise<void> {
  const [video, batch, cap, wallets] = await Promise.all([
    spentOnProject(projectId),
    spentOnBatch(batchId),
    spendStatus(),
    providerSpendBreakdown(),
  ]);
  if (video >= ceilings.perVideo) {
    throw new ExecutorError(`${what}: video đã chi ${money(video)} ≥ trần ${money(ceilings.perVideo)}. DỪNG.`);
  }
  if (batch >= ceilings.batch) {
    throw new ExecutorError(`${what}: lô đã chi ${money(batch)} ≥ trần ${money(ceilings.batch)}. DỪNG.`);
  }
  if (cap.remaining <= 0) {
    throw new ExecutorError(`${what}: hạn mức toàn cục đã hết (${money(cap.remaining)}). DỪNG.`);
  }
  for (const w of wallets) {
    if (!ceilings.providers.includes(w.provider)) continue;
    if (w.remainingUsd !== null && w.remainingUsd <= 0) {
      throw new ExecutorError(`${what}: ví ${w.provider} đã hết (${money(w.remainingUsd)}). DỪNG.`);
    }
  }
}

async function runScene(
  sceneId: string,
  projectId: string,
  batchId: string,
  ceilings: Ceilings,
  plannedVideoModels: Set<string>,
): Promise<void> {
  await generateSceneImage(sceneId);
  await assertHeadroom(projectId, batchId, ceilings, "sau ảnh");

  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  if (scene.motionMode === "VIDEO_AI" && scene.videoProvider && scene.videoModel && plannedVideoModels.size > 0) {
    const key = `${scene.videoProvider}/${scene.videoModel}`;
    // A model the approved plan did not show is a stop, not a thing to work around.
    if (!plannedVideoModels.has(key) && !(scene.videoProvider === "ffmpeg")) {
      throw new ExecutorError(
        `Cảnh ${scene.sceneNumber} đổi model: kế hoạch đã duyệt là ${[...plannedVideoModels].join(", ")}, thực tế ${key}.`,
      );
    }
  }

  await generateSceneVideo(sceneId);
  await assertHeadroom(projectId, batchId, ceilings, "sau clip");
  await generateSceneVoice(sceneId);

  const done = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  if (done.status !== "completed" || done.errorMessage !== null) {
    await prisma.scene.update({ where: { id: sceneId }, data: { status: "completed", errorMessage: null } });
  }
}

/**
 * One scene through the production step, for a caller that is NOT a batch run -
 * the queue's per-scene jobs. Same image -> clip -> voice order, same headroom
 * checks, no quality loop. Ceilings come from the batch approval when there is
 * one; a project outside any batch is held to its own MAX BUDGET, and its paid
 * requests still need the create token at the gateway.
 */
export async function executeScene(sceneId: string): Promise<void> {
  const scene = await prisma.scene.findUniqueOrThrow({
    where: { id: sceneId },
    include: { project: { select: { id: true, batchId: true, maxBudget: true } } },
  });
  const project = scene.project;
  const auth = project.batchId
    ? await prisma.batchAuthorization.findUnique({ where: { batchId: project.batchId } })
    : null;
  const ceilings: Ceilings = auth
    ? {
        perVideo: auth.maxCostPerVideo,
        batch: auth.authorizedMaxSpend,
        providers: parseJson<string[]>(auth.providerScopeJson, []),
      }
    : { perVideo: project.maxBudget, batch: Number.POSITIVE_INFINITY, providers: [] };
  const planned = new Set(parseJson<{ plannedVideoModels?: string[] }>(auth?.note, {}).plannedVideoModels ?? []);
  await assertHeadroom(project.id, project.batchId ?? "", ceilings, `cảnh ${scene.sceneNumber}`);
  await runScene(scene.id, project.id, project.batchId ?? "", ceilings, planned);
}

/** One asset of one scene (the "regenerate" buttons), with the same ceilings. */
export async function executeSceneAsset(sceneId: string, kind: "image" | "video" | "voice"): Promise<unknown> {
  const scene = await prisma.scene.findUniqueOrThrow({
    where: { id: sceneId },
    include: { project: { select: { id: true, batchId: true, maxBudget: true } } },
  });
  const project = scene.project;
  const auth = project.batchId
    ? await prisma.batchAuthorization.findUnique({ where: { batchId: project.batchId } })
    : null;
  const ceilings: Ceilings = auth
    ? { perVideo: auth.maxCostPerVideo, batch: auth.authorizedMaxSpend, providers: parseJson<string[]>(auth.providerScopeJson, []) }
    : { perVideo: project.maxBudget, batch: Number.POSITIVE_INFINITY, providers: [] };
  await assertHeadroom(project.id, project.batchId ?? "", ceilings, `cảnh ${scene.sceneNumber}`);
  if (kind === "image") return generateSceneImage(sceneId);
  if (kind === "video") return generateSceneVideo(sceneId);
  return generateSceneVoice(sceneId);
}

/**
 * Render with FFmpeg, locally. The job row is created already `processing` so
 * the background queue worker can never claim the same render.
 */
export async function renderProjectNow(projectId: string): Promise<void> {
  const job = await prisma.job.create({
    data: { type: "render_final", projectId, status: "processing", attempts: 1, maxAttempts: 1, payloadJson: "{}", startedAt: new Date() },
  });
  for (let i = 0; i < 120; i += 1) {
    const fresh = (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })) as Job;
    try {
      const outcome = await runJob(fresh);
      if (!outcome.deferred) {
        await completeJob(job.id, outcome.result);
        return;
      }
      await prisma.job.update({ where: { id: job.id }, data: { status: "processing" } });
    } catch (err) {
      await failJob(job.id, err);
      throw err;
    }
  }
  throw new ExecutorError("Render chờ media quá lâu.");
}

export async function runBatch(
  batchId: string,
  opts: { resume: boolean; onlyProjectIds?: string[] },
): Promise<RunSummary> {
  const auth = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
  const ceilings: Ceilings = {
    perVideo: auth.maxCostPerVideo,
    batch: auth.authorizedMaxSpend,
    providers: parseJson<string[]>(auth.providerScopeJson, []),
  };
  const plannedVideoModels = new Set(
    parseJson<{ plannedVideoModels?: string[] }>(auth.note, {}).plannedVideoModels ?? [],
  );

  await prisma.batch.update({ where: { id: batchId }, data: { status: "RUNNING" } });

  // IDIOM_GENERATED: write the scripts (paid Text AI, through the same gates)
  // and turn the plan into projects. Resumable - an idiom that already has a
  // project gets no second one. From here on both sources are the same.
  if ((await pendingIdiomVideos(batchId)) > 0) await materializeIdiomVideos(batchId);

  // Which videos are BLOCKED. For rows the person imported, the preflight
  // decides - the verdict they saw. For idiom projects, the per-video re-check
  // against the real script has already marked them needs_review.
  const blocked = new Map<string, string>();
  if ((await batchSource(batchId)) === "STORYBOARD_IMPORTED") {
    const pre = await preflightImportedBatch(batchId);
    for (const v of pre.videos) if (v.lifecycle === "BLOCKED") blocked.set(v.projectId, v.blockedReason ?? v.status);
  } else {
    const flagged = await prisma.project.findMany({
      where: { batchId, OR: [{ status: "needs_review" }, { scriptJson: null }] },
      select: { id: true, errorMessage: true },
    });
    for (const p of flagged) {
      // Asked for by name (Thử lại video này): re-check it against the ceiling.
      if (opts.onlyProjectIds?.includes(p.id) && (await checkVideoAgainstCap(p.id, ceilings.perVideo))) continue;
      blocked.set(p.id, (p.errorMessage ?? "chưa có kịch bản").replace(/^BLOCKED: /, ""));
    }
  }
  const projects = await prisma.project.findMany({ where: { batchId }, orderBy: { createdAt: "asc" } });
  const outcomes: VideoOutcome[] = [];

  for (const project of projects) {
    if (opts.onlyProjectIds && !opts.onlyProjectIds.includes(project.id)) continue;
    // Finished = the MP4 AND its subtitle file are still on disk. A missing
    // subtitle file sends the video back through the scenes (all reused, $0)
    // to a local re-render, which writes the subtitles again.
    const finished =
      project.status === "completed" &&
      Boolean(project.finalVideoPath) &&
      fs.existsSync(toAbsolute(project.finalVideoPath!)) &&
      (!project.subtitlePath || fs.existsSync(toAbsolute(project.subtitlePath)));
    if (finished && opts.resume) {
      // Done is done: no scene is walked, nothing is re-rendered, nothing is
      // bought. Only the export folder is checked, and re-made locally (copy +
      // one FFmpeg frame, $0) when a file in it has gone missing.
      let outputDir = existingOutputFor(project)?.dir ?? null;
      const missing = missingOutputFiles(project);
      if (missing.length > 0) {
        try {
          outputDir = await exportProjectOutput(project.id);
          await logger.info({
            event: "output.reexported",
            projectId: project.id,
            message: `Xuất lại output (thiếu ${missing.join(", ")}) tại máy, không gọi provider.`,
          });
        } catch (err) {
          outputDir = null;
          await logger.warn({
            event: "output.export_failed",
            projectId: project.id,
            message: `Không xuất được thư mục output (thiếu ${missing.join(", ")}): ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      outcomes.push({ projectId: project.id, title: project.title, stopped: "", rendered: true, skipped: false, outputDir });
      continue;
    }
    const reason = blocked.get(project.id);
    if (reason) {
      await prisma.project.update({
        where: { id: project.id },
        data: { status: "needs_review", errorMessage: `BLOCKED: ${reason}`.slice(0, 1000) },
      });
      outcomes.push({ projectId: project.id, title: project.title, stopped: `BLOCKED: ${reason}`, rendered: false, skipped: true, outputDir: null });
      continue;
    }

    await prisma.project.update({ where: { id: project.id }, data: { status: "media_generating", errorMessage: null } });
    const scenes = await prisma.scene.findMany({
      where: { projectId: project.id, skipped: false },
      orderBy: { sceneNumber: "asc" },
    });
    let stopped = "";
    for (const scene of scenes) {
      try {
        await assertHeadroom(project.id, batchId, ceilings, `cảnh ${scene.sceneNumber}`);
        await runScene(scene.id, project.id, batchId, ceilings, plannedVideoModels);
      } catch (err) {
        stopped = err instanceof Error ? err.message : String(err);
        await prisma.scene.update({
          where: { id: scene.id },
          data: { status: "failed", errorMessage: stopped.slice(0, 500) },
        });
        await logger.warn({
          event: "batch.video_stopped",
          projectId: project.id,
          sceneId: scene.id,
          message: `Dừng video "${project.title}" ở cảnh ${scene.sceneNumber}: ${stopped}. Không thử lại, không đổi provider.`,
        });
        break;
      }
    }

    // A render that fails never reaches back for the paid API - the assets are
    // on disk. Resume renders again from them.
    let rendered = false;
    let outputDir: string | null = null;
    if (!stopped) {
      try {
        await renderProjectNow(project.id);
        rendered = true;
        const done = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
        outputDir = existingOutputFor(done)?.dir ?? null;
      } catch (err) {
        stopped = `render: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (stopped) {
      await prisma.project.update({
        where: { id: project.id },
        data: { status: "failed", errorMessage: stopped.slice(0, 1000) },
      });
    }
    outcomes.push({ projectId: project.id, title: project.title, stopped, rendered, skipped: false, outputDir });
  }

  // Money held for a request that never finished is handed back - never left
  // hanging against the ceiling.
  const stranded = await prisma.costReservation.findMany({
    where: { batchId, status: "RESERVED" },
    select: { idempotencyKey: true },
  });
  for (const r of stranded) await releaseReservation(r.idempotencyKey, { billed: false });

  const settledStatus = await settleBatchIfDone(batchId);
  await logger.info({
    event: "batch.run_finished",
    message:
      `Lô ${batchId}: ${outcomes.filter((o) => !o.stopped).length}/${outcomes.length} video xong, ` +
      `chi lô ${money(await spentOnBatch(batchId))}, trạng thái ${settledStatus ?? "?"}.`,
  });
  return { batchId, outcomes, settledStatus, releasedReservations: stranded.length };
}
