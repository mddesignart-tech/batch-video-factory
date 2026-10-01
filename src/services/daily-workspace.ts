import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { parseJson, round } from "@/lib/utils";
import { planBatchSpend } from "@/domain/spend-limits";
import { costClass, isZeroCost, type CostClass } from "@/domain/queue-order";
import { friendlyStatus, batchWorkflowStep, FRIENDLY_BATCH_STATUS, type FriendlyStatus, type WorkflowStep } from "@/domain/friendly-status";
import { friendlyError, type FriendlyError } from "@/domain/user-errors";
import { videoLifecycle, type VideoLifecycle } from "@/domain/video-lifecycle";
import { resolvePreset, type OutputPreset } from "@/domain/output-preset";
import { preflightImportedBatch, type ImportPreflight, type ImportVideoPreview } from "./import-preflight";
import { spendStatus } from "./spend-guard";
import { totalReserved } from "./cost-reservation";
import { isRunning, isVideoRunning } from "./run-registry";
import { recoveryItemsForProject } from "./paid-recovery";
import { existingOutputFor, exportReadyOf } from "./output-export";
import { isInterrupted } from "./restart-recovery";
import { batchSource } from "./batch-sources";
import { invalidVoiceLines, invalidVoiceMessage } from "./voice-validity";

/**
 * The daily workspace (V1.2 Phase 6, QĐ-114): one batch as a person runs it -
 * cards, a table, what it costs, what is next. Read-only: nothing here sends,
 * approves or renders. Every figure comes from the rows (and the one preflight
 * the engine already uses), so a refresh, a second tab or a restart shows the
 * same truth.
 */

export interface WorkspaceVideo {
  projectId: string;
  title: string;
  /** /api/media/... path for a small picture, or null. */
  thumbnail: string | null;
  sceneCount: number;
  /** Seconds: the exported file's when there is one, else the timed plan. */
  durationSec: number;
  aspectRatio: string;
  status: FriendlyStatus;
  lifecycle: VideoLifecycle;
  /** What continuing / running this video would add ($0 for reuse / local). */
  estimatedCost: number;
  /** Real money charged for this video so far. */
  actualCost: number;
  reuseSaving: number;
  costClass: CostClass;
  zeroCost: boolean;
  videoModels: string[];
  voices: string[];
  counts: { images: number; imagesToCreate: number; videoAi: number; local: number; voices: number; imported: number };
  problem: FriendlyError | null;
  invalidVoice: boolean;
  interrupted: boolean;
  output: { dir: string; relative: string } | null;
  exportReady: boolean | null;
  currentStep: string | null;
  queueOrder: number | null;
  /** Covered by the batch's current approval (runs on TIẾP TỤC without DUYỆT THÊM). */
  covered: boolean;
}

export interface PreflightSummary {
  totalVideos: number;
  ready: number;
  blocked: number;
  completed: number;
  reuse: number;
  imported: number;
  local: number;
  imageAi: number;
  videoAi: number;
  voice: number;
  render: number;
  requiredCost: number;
  optionalQa: number;
  retryReserve: number;
  recommendedAuthorization: number;
  globalRemaining: number;
  /** requiredCost of every runnable video minus what the global budget still has. */
  shortfall: number;
  zeroCostVideos: number;
  /** The videos that fit the global budget, in queue order ($0 first). */
  fitsBudget: { videos: number; amount: number };
}

export interface Workspace {
  batch: {
    id: string;
    name: string;
    status: string;
    statusLabel: string;
    mode: "PARTIAL" | "STRICT";
    presetId: string;
    slug: string | null;
    createdAt: Date;
    importBatch: boolean;
    running: boolean;
  };
  step: WorkflowStep;
  authorization: { status: string; ceiling: number; used: number; coveredIds: string[] | null } | null;
  preset: OutputPreset;
  presets: OutputPreset[];
  summary: PreflightSummary | null;
  videos: WorkspaceVideo[];
  totals: { actualCost: number; reuseSaving: number; durationSec: number; completed: number; exported: number };
  /** A preflight could not be computed (e.g. an idiom batch before expansion). */
  preflightError: string | null;
}

export function summarizePreflight(pre: ImportPreflight, globalRemaining: number): PreflightSummary {
  const runnable = pre.videos.filter((v) => v.lifecycle !== "BLOCKED" && v.lifecycle !== "COMPLETED");
  const sum = (f: (v: ImportVideoPreview) => number) => runnable.reduce((n, v) => n + f(v), 0);
  const requiredCost = round(sum((v) => v.estimatedCost), 6);
  const plan = planBatchSpend({
    videos: runnable
      .map((v) => ({ v, cls: videoCostClass(v) }))
      .sort((a, b) => rank(a.cls) - rank(b.cls) || a.v.order - b.v.order)
      .map(({ v }, i) => ({
        id: v.projectId,
        title: v.title,
        order: i,
        videoLimit: null,
        scenes: [{ sceneNumber: 0, incrementalCost: v.estimatedCost, limit: null }],
      })),
    batchLimit: null,
    globalRemaining,
  });
  return {
    totalVideos: pre.videos.length,
    ready: runnable.length,
    blocked: pre.videos.filter((v) => v.lifecycle === "BLOCKED").length,
    completed: pre.videos.filter((v) => v.lifecycle === "COMPLETED").length,
    reuse: sum((v) => v.counts.imageReuse - v.counts.imageImported + v.counts.videoReuse + v.counts.voiceReuse),
    imported: sum((v) => v.counts.imageImported),
    local: sum((v) => v.localMotionCount),
    imageAi: sum((v) => v.counts.imageBuy),
    videoAi: sum((v) => v.counts.videoBuy),
    voice: sum((v) => v.counts.voiceBuy),
    render: runnable.length,
    requiredCost,
    optionalQa: pre.reconciliation.optionalQa,
    retryReserve: pre.reconciliation.retryReserve,
    recommendedAuthorization: pre.reconciliation.recommendedAuthorization,
    globalRemaining: round(globalRemaining, 6),
    shortfall: round(Math.max(0, requiredCost - globalRemaining), 6),
    zeroCostVideos: runnable.filter((v) => videoZeroCost(v)).length,
    fitsBudget: { videos: plan.runnable.length, amount: plan.authorizationAmount },
  };
}

const RANK: Record<CostClass, number> = { FREE: 0, LOCAL: 1, PAID_LIGHT: 2, PAID_VIDEO: 3 };
const rank = (c: CostClass) => RANK[c];

function videoCostClass(v: ImportVideoPreview): CostClass {
  return costClass({
    buyImages: v.counts.imageBuy,
    buyVideos: v.counts.videoBuy,
    buyVoices: v.counts.voiceBuy,
    localMotion: v.localMotionCount,
    incrementalCost: v.estimatedCost,
  });
}

function videoZeroCost(v: ImportVideoPreview): boolean {
  return (
    isZeroCost({
      buyImages: v.counts.imageBuy,
      buyVideos: v.counts.videoBuy,
      buyVoices: v.counts.voiceBuy,
      localMotion: v.localMotionCount,
      incrementalCost: v.estimatedCost,
    }) && v.counts.imagePosts + v.counts.videoPosts + v.counts.voicePosts === 0
  );
}

export async function buildWorkspace(batchId: string): Promise<Workspace | null> {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: {
      authorization: true,
      projects: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          title: true,
          status: true,
          aspectRatio: true,
          errorMessage: true,
          finalVideoPath: true,
          outputDir: true,
          exportReadyJson: true,
          currentStep: true,
          queueOrder: true,
          estimatedCost: true,
        },
      },
    },
  });
  if (!batch) return null;
  const settings = await getSettings();
  const preset = resolvePreset(batch.outputPresetId || null, settings.defaultOutputPresetId, settings.customPresets);
  const ids = batch.projects.map((p) => p.id);
  const [spent, cap, held, source] = await Promise.all([
    prisma.costEntry.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, estimated: false }, _sum: { amount: true } }),
    spendStatus(),
    totalReserved(),
    ids.length > 0 ? batchSource(batchId) : Promise.resolve("IDIOM_GENERATED" as const),
  ]);
  const spentBy = new Map(spent.map((s) => [s.projectId, s._sum.amount ?? 0]));
  // Every video, finished ones included (QĐ-114 §49).
  const badVoices = await invalidVoiceLines(ids);
  const globalRemaining = Math.max(0, cap.cap - cap.spent - held);

  let pre: ImportPreflight | null = null;
  let preflightError: string | null = null;
  if (source === "STORYBOARD_IMPORTED") {
    try {
      // Read-only: this view is polled while videos run (see preflightImportedBatch).
      pre = await preflightImportedBatch(batchId, { persist: false });
    } catch (err) {
      preflightError = err instanceof Error ? err.message : String(err);
    }
  } else {
    preflightError = "Lô thành ngữ (tạo từ thư viện) — dùng trang lô cổ điển để duyệt và chạy.";
  }
  const byId = new Map((pre?.videos ?? []).map((v) => [v.projectId, v]));
  const note = parseJson<{ runnableProjectIds?: string[] | null }>(batch.authorization?.note, {});
  const coveredIds = note.runnableProjectIds ?? null;

  const videos: WorkspaceVideo[] = [];
  for (const p of batch.projects) {
    const v = byId.get(p.id);
    const active = isVideoRunning(p.id);
    const recovery = p.status !== "completed" ? await recoveryItemsForProject(p.id) : [];
    const lifecycle = videoLifecycle({
      projectStatus: p.status,
      authorizationStatus: batch.authorization?.status ?? null,
      planStatus: v ? (v.lifecycle === "BLOCKED" ? "BLOCKED" : "OK") : null,
      needsRecovery: recovery.length > 0,
      active,
    });
    const interrupted = isInterrupted(p.errorMessage);
    const invalidVoice = badVoices.has(p.id);
    const output = p.status === "completed" ? existingOutputFor(p) : null;
    const ready = exportReadyOf(p.exportReadyJson);
    const firstImage = v?.scenes.find((s) => s.imagePath)?.imagePath ?? null;
    const problemText = active
      ? null
      : recovery.length > 0
        ? `NEEDS_RECOVERY: ${recovery.length} yêu cầu trả phí chưa rõ kết quả.`
        : invalidVoice
          ? invalidVoiceMessage(badVoices.get(p.id)!) +
            (p.status === "completed" ? " MP4 hiện có vẫn giữ nguyên; chỉ không render lại được cho tới khi có giọng mới." : "")
        : p.status === "completed"
          ? null
          : (v?.lifecycle === "BLOCKED" ? v.blockedReason : null) ?? (["failed", "needs_review", "budget_exhausted"].includes(p.status) ? p.errorMessage : null);
    const counts = v?.counts;
    videos.push({
      projectId: p.id,
      title: p.title,
      thumbnail: output ? `/api/media/${output.relative}/thumbnail.jpg` : firstImage ? `/api/media/${firstImage}` : null,
      sceneCount: v?.sceneCount ?? 0,
      durationSec: ready?.durationSec ?? output?.metadata?.duration ?? v?.timedDuration ?? 0,
      aspectRatio: p.aspectRatio,
      status: friendlyStatus({ lifecycle, interrupted, invalidVoice }),
      lifecycle,
      estimatedCost: p.status === "completed" ? 0 : (v?.estimatedCost ?? 0),
      actualCost: round(spentBy.get(p.id) ?? 0, 6),
      reuseSaving: v?.savings.total ?? 0,
      costClass: v ? videoCostClass(v) : "FREE",
      // A blocked video's estimate is truncated; it is never "$0 to run".
      zeroCost: v && v.lifecycle !== "BLOCKED" ? videoZeroCost(v) : false,
      videoModels: [...new Set((v?.scenes ?? []).map((s) => s.videoModel).filter((m): m is string => Boolean(m)))],
      voices: [...new Set((v?.scenes ?? []).map((s) => s.models.voice).filter((m): m is string => Boolean(m)))],
      counts: {
        images: (counts?.imageBuy ?? 0) + (counts?.imageReuse ?? 0),
        imagesToCreate: counts?.imageBuy ?? 0,
        videoAi: (counts?.videoBuy ?? 0) + (counts?.videoReuse ?? 0),
        local: v?.localMotionCount ?? 0,
        voices: (counts?.voiceBuy ?? 0) + (counts?.voiceReuse ?? 0),
        imported: counts?.imageImported ?? 0,
      },
      problem: friendlyError(problemText),
      invalidVoice,
      interrupted,
      output: output ? { dir: output.dir, relative: output.relative } : null,
      exportReady: ready ? ready.ready : null,
      currentStep: p.currentStep,
      queueOrder: p.queueOrder,
      covered: coveredIds === null ? batch.authorization?.status !== "DRAFT" && batch.authorization !== null : coveredIds.includes(p.id),
    });
  }

  const summary = pre ? summarizePreflight(pre, globalRemaining) : null;
  const completed = videos.filter((v) => v.lifecycle === "COMPLETED").length;
  const exported = videos.filter((v) => v.output !== null).length;
  const auth = batch.authorization;
  let used = 0;
  if (auth) {
    const { reservationLedger } = await import("./cost-reservation");
    used = (await reservationLedger(batchId, auth.authorizedMaxSpend)).used;
  }
  return {
    batch: {
      id: batch.id,
      name: batch.name,
      status: batch.status,
      statusLabel: FRIENDLY_BATCH_STATUS[batch.status] ?? batch.status,
      mode: batch.batchMode === "STRICT" ? "STRICT" : "PARTIAL",
      presetId: batch.outputPresetId,
      slug: batch.slug,
      createdAt: batch.createdAt,
      importBatch: source === "STORYBOARD_IMPORTED",
      running: isRunning(batchId),
    },
    step: batchWorkflowStep({
      videos: videos.length,
      priced: pre !== null,
      approved: auth?.status === "APPROVED" || auth?.status === "COMPLETED",
      running: videos.filter((v) => v.lifecycle === "RUNNING").length,
      rendering: videos.filter((v) => v.lifecycle === "RENDERING").length,
      completed,
      exported,
    }),
    authorization: auth
      ? { status: auth.status, ceiling: auth.authorizedMaxSpend, used: round(used, 6), coveredIds }
      : null,
    preset,
    presets: [...(await import("@/domain/output-preset")).BUILT_IN_PRESETS, ...settings.customPresets],
    summary,
    videos,
    totals: {
      actualCost: round(videos.reduce((n, v) => n + v.actualCost, 0), 6),
      reuseSaving: round(videos.reduce((n, v) => n + v.reuseSaving, 0), 6),
      durationSec: round(videos.filter((v) => v.lifecycle === "COMPLETED").reduce((n, v) => n + v.durationSec, 0), 3),
      completed,
      exported,
    },
    preflightError,
  };
}
