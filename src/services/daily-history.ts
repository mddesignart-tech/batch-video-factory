import { prisma } from "@/lib/prisma";
import { round } from "@/lib/utils";
import { FRIENDLY_BATCH_STATUS } from "@/domain/friendly-status";
import { startOfToday, todayDashboard, type TodayDashboard } from "./dashboard";
import { exportReadyOf, outputDirFor } from "./output-export";
import { isRunning, isVideoRunning } from "./run-registry";
import { isInterrupted } from "./restart-recovery";

/**
 * Queue, history and the "today" board of the daily workspace (V1.2 Phase 6,
 * QĐ-114). Read-only. Money figures are CostEntry rows with estimated=false and
 * a real provider - never an authorization amount, never a mock price, never a
 * batch total divided evenly.
 */

// ------------------------------------------------------------------ queue ---

export interface QueueRow {
  projectId: string;
  title: string;
  batchId: string | null;
  batchName: string;
  position: number | null;
  state: "ĐANG TẠO" | "ĐANG RENDER" | "ĐANG CHỜ" | "HOÀN THÀNH" | "CẦN XỬ LÝ" | "BỊ CHẶN";
  currentStep: string | null;
  scenesDone: number;
  scenesTotal: number;
  elapsedSec: number | null;
  authorizedCost: number;
  actualCost: number;
  retries: number;
  provider: string | null;
}

/**
 * Every video that is running, waiting inside an approval, or finished in the
 * last 12 hours. Progress is the scene rows the pipeline wrote - never a timer.
 */
export async function queueView(now = new Date()): Promise<QueueRow[]> {
  const since = new Date(now.getTime() - 12 * 3600_000);
  const projects = await prisma.project.findMany({
    where: {
      batchId: { not: null },
      OR: [
        { status: { in: ["media_generating", "rendering"] } },
        { queueOrder: { not: null }, runFinishedAt: null, status: { in: ["script_ready", "media_ready", "draft"] } },
        { runFinishedAt: { gte: since } },
      ],
    },
    select: {
      id: true,
      title: true,
      status: true,
      batchId: true,
      queueOrder: true,
      currentStep: true,
      errorMessage: true,
      runStartedAt: true,
      runFinishedAt: true,
      maxBudget: true,
      batch: { select: { name: true, createdAt: true, authorization: { select: { status: true, maxCostPerVideo: true, note: true } } } },
      scenes: { where: { skipped: false }, select: { status: true, retryCount: true } },
    },
    orderBy: [{ updatedAt: "desc" }],
    take: 300,
  });
  const ids = projects.map((p) => p.id);
  const [spent, jobs] = await Promise.all([
    prisma.costEntry.groupBy({
      by: ["projectId"],
      where: { projectId: { in: ids }, estimated: false, provider: { not: "mock" } },
      _sum: { amount: true },
    }),
    prisma.providerJob.findMany({
      where: { projectId: { in: ids }, status: { in: ["pending", "processing", "submitted"] } },
      select: { projectId: true, provider: true, model: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const spentBy = new Map(spent.map((s) => [s.projectId, s._sum.amount ?? 0]));
  const rows: QueueRow[] = [];
  for (const p of projects) {
    const active = isVideoRunning(p.id);
    // A waiting video only counts when its batch's approval covers it.
    if (["script_ready", "media_ready", "draft"].includes(p.status)) {
      const auth = p.batch?.authorization;
      if (!auth || auth.status !== "APPROVED") continue;
      const covered = (JSON.parse(auth.note || "{}") as { runnableProjectIds?: string[] | null }).runnableProjectIds;
      if (covered && !covered.includes(p.id)) continue;
    }
    const state: QueueRow["state"] =
      p.status === "rendering" && active
        ? "ĐANG RENDER"
        : p.status === "media_generating" && active
          ? "ĐANG TẠO"
          : ["media_generating", "rendering"].includes(p.status)
            ? // The row says running but nothing holds it: restart recovery will
              // classify it; until then it is not progress.
              "CẦN XỬ LÝ"
            : p.status === "completed"
              ? "HOÀN THÀNH"
              : p.status === "failed" || isInterrupted(p.errorMessage)
                ? "CẦN XỬ LÝ"
                : ["needs_review", "budget_exhausted"].includes(p.status)
                  ? "BỊ CHẶN"
                  : "ĐANG CHỜ";
    const job = jobs.find((j) => j.projectId === p.id);
    const end = p.runFinishedAt ?? (active ? now : null);
    rows.push({
      projectId: p.id,
      title: p.title,
      batchId: p.batchId,
      batchName: p.batch?.name ?? "",
      position: p.queueOrder,
      state,
      currentStep: active ? p.currentStep : null,
      scenesDone: p.scenes.filter((s) => s.status === "completed").length,
      scenesTotal: p.scenes.length,
      elapsedSec: p.runStartedAt && end ? Math.max(0, Math.round((end.getTime() - p.runStartedAt.getTime()) / 1000)) : null,
      authorizedCost: Math.min(p.maxBudget, p.batch?.authorization?.maxCostPerVideo ?? p.maxBudget),
      actualCost: round(spentBy.get(p.id) ?? 0, 6),
      retries: p.scenes.reduce((n, s) => n + s.retryCount, 0),
      provider: job ? `${job.provider}/${job.model}` : null,
    });
  }
  const order: Record<QueueRow["state"], number> = { "ĐANG TẠO": 0, "ĐANG RENDER": 0, "ĐANG CHỜ": 1, "CẦN XỬ LÝ": 2, "BỊ CHẶN": 3, "HOÀN THÀNH": 4 };
  return rows.sort(
    (a, b) =>
      order[a.state] - order[b.state] ||
      (a.batchName < b.batchName ? -1 : a.batchName > b.batchName ? 1 : 0) ||
      (a.position ?? 1e9) - (b.position ?? 1e9),
  );
}

// ---------------------------------------------------------------- history ---

export interface HistoryRow {
  id: string;
  name: string;
  status: string;
  statusLabel: string;
  createdAt: Date;
  videos: number;
  completed: number;
  failed: number;
  blocked: number;
  cost: number;
  durationSec: number;
  outputFolder: string | null;
  running: boolean;
  matchedVideos: string[];
}

export interface HistoryQuery {
  /** Batch name or video title, case-insensitive, accents ignored. */
  q?: string;
  /** YYYY-MM-DD (local). */
  date?: string;
  status?: string;
  limit?: number;
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();

export async function batchHistory(query: HistoryQuery = {}): Promise<HistoryRow[]> {
  const where: Record<string, unknown> = {};
  if (query.status) where.status = query.status;
  if (query.date && /^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
    const [y, m, d] = query.date.split("-").map(Number);
    const start = new Date(y!, m! - 1, d!);
    const end = new Date(y!, m! - 1, d! + 1);
    where.createdAt = { gte: start, lt: end };
  }
  const batches = await prisma.batch.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: query.q ? 500 : (query.limit ?? 50),
    select: {
      id: true,
      name: true,
      status: true,
      createdAt: true,
      slug: true,
      projects: { select: { id: true, title: true, status: true, exportReadyJson: true, outputDir: true } },
    },
  });
  const needle = query.q ? fold(query.q.trim()) : "";
  const kept = batches
    .map((b) => ({
      b,
      matched: needle ? b.projects.filter((p) => fold(p.title).includes(needle)).map((p) => p.title) : [],
    }))
    .filter(({ b, matched }) => !needle || fold(b.name).includes(needle) || matched.length > 0)
    .slice(0, query.limit ?? 50);
  const ids = kept.flatMap(({ b }) => b.projects.map((p) => p.id));
  const spent = await prisma.costEntry.groupBy({
    by: ["projectId"],
    where: { projectId: { in: ids }, estimated: false, provider: { not: "mock" } },
    _sum: { amount: true },
  });
  const spentBy = new Map(spent.map((s) => [s.projectId, s._sum.amount ?? 0]));
  return kept.map(({ b, matched }) => ({
    id: b.id,
    name: b.name,
    status: b.status,
    statusLabel: FRIENDLY_BATCH_STATUS[b.status] ?? b.status,
    createdAt: b.createdAt,
    videos: b.projects.length,
    completed: b.projects.filter((p) => p.status === "completed").length,
    failed: b.projects.filter((p) => p.status === "failed").length,
    blocked: b.projects.filter((p) => ["needs_review", "budget_exhausted"].includes(p.status)).length,
    cost: round(b.projects.reduce((n, p) => n + (spentBy.get(p.id) ?? 0), 0), 6),
    durationSec: round(
      b.projects.reduce((n, p) => n + (p.status === "completed" ? (exportReadyOf(p.exportReadyJson)?.durationSec ?? 0) : 0), 0),
      3,
    ),
    outputFolder: b.slug ? `output/${b.slug}` : null,
    running: isRunning(b.id),
    matchedVideos: matched,
  }));
}

// -------------------------------------------------------------- dashboard ---

export interface DailyBoard extends TodayDashboard {
  videosPending: number;
  /** What reused assets originally cost (real providers only) - money NOT spent today. */
  reuseSavedToday: number;
  batchesToday: number;
}

export async function dailyBoard(now = new Date()): Promise<DailyBoard> {
  const since = startOfToday(now);
  const [base, pending, reused, batchesToday] = await Promise.all([
    todayDashboard(now),
    prisma.project.count({
      where: { batchId: { not: null }, status: { in: ["script_ready", "media_ready", "media_generating", "rendering", "draft"] } },
    }),
    prisma.asset.findMany({
      where: { source: "REUSED", createdAt: { gte: since }, reusedFromAssetId: { not: null } },
      select: { reusedFromAssetId: true },
    }),
    prisma.batch.count({ where: { createdAt: { gte: since } } }),
  ]);
  const sources = reused.length
    ? await prisma.asset.findMany({
        where: { id: { in: reused.map((r) => r.reusedFromAssetId!) }, provider: { not: "mock" } },
        select: { id: true, actualCost: true },
      })
    : [];
  const price = new Map(sources.map((s) => [s.id, s.actualCost]));
  const saved = reused.reduce((n, r) => n + (price.get(r.reusedFromAssetId!) ?? 0), 0);
  return { ...base, videosPending: pending, reuseSavedToday: round(saved, 6), batchesToday };
}

/** Output folder of a finished video, absolute (for copy-path fallbacks). */
export function outputFolderOf(project: { id: string; title: string; outputDir?: string | null }): string {
  return outputDirFor(project);
}
