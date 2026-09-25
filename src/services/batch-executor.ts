import fs from "node:fs";
import type { Job } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { toAbsolute } from "@/lib/paths";
import { parseJson } from "@/lib/utils";
import { peekCreateToken } from "@/services/create-token";
import { spendStatus } from "@/services/spend-guard";
import { providerSpendBreakdown } from "@/services/provider-budget";
import { availableProviderNames } from "@/services/provider-health";
import { approveAuthorization } from "@/services/batch-authorization";
import { release as releaseReservation } from "@/services/cost-reservation";
import { preflightImportedBatch, type ImportPreflight } from "@/services/import-preflight";
import { settleBatchIfDone } from "@/services/batch-runner";
import { generateSceneImage, generateSceneVideo, generateSceneVoice } from "@/services/generation";
import { exportProjectOutput } from "@/services/output-export";
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
  preflight: ImportPreflight;
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
 * Everything a person must see before approving money, computed by the same
 * preflight the CLI prints. `maxBatch` / `maxPerVideo` are the figures they are
 * about to type; given, they are checked too. Spends nothing, POSTs nothing.
 */
export async function preflightForApproval(
  batchId: string,
  opts: { maxBatch?: number; maxPerVideo?: number; resume?: boolean } = {},
): Promise<ApprovalPreflight> {
  const pre = await preflightImportedBatch(batchId);
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

  const runnable = pre.videos.filter((v) =>
    opts.resume ? v.lifecycle !== "BLOCKED" && v.lifecycle !== "COMPLETED" : v.lifecycle === "READY",
  );
  const blocked = pre.videos.filter((v) => v.lifecycle === "BLOCKED");

  add("Có video chạy được", runnable.length > 0 || Boolean(opts.resume), `${runnable.length} video`);
  for (const v of blocked) {
    // Named, never silent - and NOT blocking: one video's problem is its own.
    add(`${v.title}: BLOCKED — sẽ bỏ qua`, false, v.blockedReason ?? v.status, false);
  }

  if (opts.maxPerVideo !== undefined) {
    for (const v of runnable) {
      add(
        `${v.title} ≤ trần/video ${money(opts.maxPerVideo)}`,
        v.estimatedCost <= opts.maxPerVideo + 1e-9,
        money(v.estimatedCost),
      );
    }
  }
  if (opts.maxBatch !== undefined) {
    add("Trần lô > 0", opts.maxBatch > 0, money(opts.maxBatch));
    add(
      `Dự toán ≤ trần lô ${money(opts.maxBatch)}`,
      pre.estimatedTotal <= opts.maxBatch + 1e-9,
      money(pre.estimatedTotal),
    );
    add(
      "Trần lô ≤ ngân sách toàn cục còn lại",
      opts.maxBatch <= cap.remaining + 1e-9,
      `${money(opts.maxBatch)} vs còn ${money(cap.remaining)} — không tự nâng hạn mức`,
    );
  }
  add("Dự toán ≤ ngân sách toàn cục còn lại", pre.estimatedTotal <= cap.remaining + 1e-9, `${money(pre.estimatedTotal)} vs ${money(cap.remaining)}`);

  // The second money lock: a person looked at THIS model's price and agreed.
  const unconfirmed = pre.paidModels.filter((m) => !m.confirmed);
  add(
    "Mọi model trả phí đã được xác nhận giá",
    unconfirmed.length === 0,
    unconfirmed.length === 0 ? pre.paidModels.map((m) => m.key).join(", ") || "(không có)" : unconfirmed.map((m) => m.key).join(", "),
  );

  const plannedVideoModels = [
    ...new Set(runnable.flatMap((v) => v.scenes.map((s) => s.videoModel).filter((m): m is string => Boolean(m)))),
  ];
  for (const key of plannedVideoModels) {
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
    // models, so when a stage has exactly one, there is nothing to fall back
    // to. Counted, not assumed.
    const stages = new Set<string>();
    if (pre.counts.imagePosts > 0) stages.add("image");
    if (pre.counts.videoPosts > 0) stages.add("video");
    if (pre.counts.voicePosts > 0) stages.add("voice");
    for (const type of stages) {
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
    const scope = new Set(pre.paidModels.map((m) => m.key.split("/")[0]));
    for (const w of wallets) {
      if (!scope.has(w.provider)) continue;
      if (w.remainingUsd !== null && w.remainingUsd <= 0) {
        add(`Ví ${w.provider} còn tiền`, false, money(w.remainingUsd));
      }
    }
  }

  add("CREATE_ATTEMPT_TOKEN trống", token === null, token === null ? "null" : "CÒN");
  if (opts.resume) {
    add("Lô không bị huỷ", batch.status !== "CANCELLED", batch.status);
  } else {
    add("Lô đang PLANNED", batch.status === "PLANNED", batch.status);
    add("Quyền chi đang DRAFT", auth?.status === "DRAFT", auth?.status ?? "không có");
  }

  // A clip the ROUTER will choose (no hand pin) needs the separate LOW_AUTO yes.
  let usesLowAuto = false;
  for (const v of runnable) {
    const buying = v.scenes.filter((s) => s.plan.video === "BUY").map((s) => s.sceneNumber);
    if (buying.length === 0) continue;
    const unpinned = await prisma.scene.count({
      where: { projectId: v.projectId, sceneNumber: { in: buying }, videoModelPinned: false },
    });
    if (unpinned > 0) usesLowAuto = true;
  }

  return {
    batchId,
    preflight: pre,
    checks,
    ready: checks.every((c) => c.ok || !c.blocking),
    runnableVideos: runnable.length,
    blockedVideos: blocked.length,
    estimatedTotal: pre.estimatedTotal,
    globalRemaining: cap.remaining,
    globalCap: cap.cap,
    recommendedAuthorization: recommendAuthorization(pre.estimatedTotal, Number.MAX_SAFE_INTEGER).recommended,
    plannedVideoModels,
    usesLowAuto,
    imagePosts: pre.counts.imagePosts,
    videoPosts: pre.counts.videoPosts,
    voicePosts: pre.counts.voicePosts,
    importedImages: pre.counts.imageImported,
    willCreateImages: pre.counts.imageBuy,
    mockMode: mock,
    batchStatus: batch.status,
    authorizationStatus: auth?.status ?? "NONE",
  };
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
  const batch = await prisma.batch.findUniqueOrThrow({ where: { id: opts.batchId } });
  if (batch.status === "CANCELLED") throw new ExecutorError("Lô đã bị huỷ.");
  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId: opts.batchId } });
  if (!auth || auth.status === "DRAFT") {
    throw new ExecutorError("Lô chưa được duyệt chi. Hãy PREFLIGHT rồi DUYỆT & CHẠY trước.");
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

  // Which videos are BLOCKED is decided by the preflight - the same verdict the
  // person saw - not re-guessed here.
  const pre = await preflightImportedBatch(batchId);
  const blocked = new Map(pre.videos.filter((v) => v.lifecycle === "BLOCKED").map((v) => [v.projectId, v.blockedReason ?? v.status]));

  await prisma.batch.update({ where: { id: batchId }, data: { status: "RUNNING" } });
  const projects = await prisma.project.findMany({ where: { batchId }, orderBy: { createdAt: "asc" } });
  const outcomes: VideoOutcome[] = [];

  for (const project of projects) {
    if (opts.onlyProjectIds && !opts.onlyProjectIds.includes(project.id)) continue;
    const finished =
      project.status === "completed" &&
      Boolean(project.finalVideoPath) &&
      fs.existsSync(toAbsolute(project.finalVideoPath!));
    if (finished && opts.resume) {
      // Done is done: no scene is walked, nothing is re-rendered.
      outcomes.push({ projectId: project.id, title: project.title, stopped: "", rendered: true, skipped: false, outputDir: null });
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
        outputDir = await exportProjectOutput(project.id).catch(() => null);
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
