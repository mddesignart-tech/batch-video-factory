import { prisma } from "@/lib/prisma";
import { spendStatus } from "@/services/spend-guard";
import { providerSpendBreakdown } from "@/services/provider-budget";

/**
 * The numbers an operator looks at first thing in the day, read from the
 * ledger and the project rows - never estimated. Spend is REAL spend
 * (`estimated: false`, mock excluded).
 */
/**
 * Projects produced ONLY by the mock provider: at least one mock ProviderJob and
 * no job at any real provider. They are real rows (a QA run on this database)
 * but not production output, so they stay out of production counts and
 * averages. A project with no provider job at all (every asset reused) is
 * production and is kept.
 */
export async function mockOnlyProjectIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const jobs = await prisma.providerJob.groupBy({
    by: ["projectId", "provider"],
    where: { projectId: { in: ids } },
  });
  const real = new Set(jobs.filter((j) => j.provider !== "mock").map((j) => j.projectId));
  return new Set(jobs.filter((j) => j.provider === "mock" && j.projectId && !real.has(j.projectId)).map((j) => j.projectId!));
}

export interface TodayDashboard {
  videosCompleted: number;
  /** Completed today on the mock provider only - shown apart, never in the production figures. */
  videosCompletedMock: number;
  videosFailed: number;
  apiSpend: number;
  /** Real spend of the videos completed today, divided by their count. */
  averageCostPerVideo: number | null;
  runwayRemainingUsd: number | null;
  /** Runway bills 100 credits per dollar. */
  runwayCredits: number | null;
  /** LIVE / CACHE / DECLARED, and when it was last read live - never shown bare. */
  runwaySource: string | null;
  runwayCheckedAt: string | null;
  /**
   * What the operator should read the number as: LIVE only when it was read
   * from the vendor in the last 10 minutes; otherwise CACHE (with its age) -
   * a stored LIVE reading is a claim about the past, not about now.
   */
  runwayFreshness: "LIVE" | "CACHE" | "DECLARED" | null;
  globalCap: number;
  globalSpent: number;
  globalRemaining: number;
}

export function startOfToday(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function todayDashboard(now = new Date()): Promise<TodayDashboard> {
  const since = startOfToday(now);
  const [completed, failed, spend, cap, wallets] = await Promise.all([
    prisma.project.findMany({
      where: { status: "completed", updatedAt: { gte: since } },
      select: { id: true },
    }),
    prisma.project.count({ where: { status: "failed", updatedAt: { gte: since } } }),
    prisma.costEntry.aggregate({
      where: { estimated: false, provider: { not: "mock" }, createdAt: { gte: since } },
      _sum: { amount: true },
    }),
    spendStatus(),
    providerSpendBreakdown(),
  ]);
  const mockOnly = await mockOnlyProjectIds(completed.map((p) => p.id));
  const production = completed.filter((p) => !mockOnly.has(p.id));
  let average: number | null = null;
  if (production.length > 0) {
    const perVideo = await prisma.costEntry.aggregate({
      where: { estimated: false, provider: { not: "mock" }, projectId: { in: production.map((p) => p.id) } },
      _sum: { amount: true },
    });
    average = Math.round(((perVideo._sum.amount ?? 0) / production.length) * 1e6) / 1e6;
  }
  const runway = wallets.find((w) => w.provider === "runway");
  return {
    videosCompleted: production.length,
    videosCompletedMock: mockOnly.size,
    videosFailed: failed,
    apiSpend: Math.round((spend._sum.amount ?? 0) * 1e6) / 1e6,
    averageCostPerVideo: average,
    runwayRemainingUsd: runway?.remainingUsd ?? null,
    runwayCredits: runway?.remainingUsd != null ? Math.round(runway.remainingUsd * 100) : null,
    runwaySource: runway?.budget?.source ?? null,
    runwayCheckedAt: runway?.budget?.checkedAt ?? null,
    runwayFreshness: !runway?.budget
      ? null
      : runway.budget.checkedAt && now.getTime() - new Date(runway.budget.checkedAt).getTime() <= 10 * 60_000
        ? "LIVE"
        : runway.budget.checkedAt
          ? "CACHE"
          : "DECLARED",
    globalCap: cap.cap,
    globalSpent: cap.spent,
    globalRemaining: cap.remaining,
  };
}

export interface RecentBatchRow {
  id: string;
  name: string;
  status: string;
  videos: number;
  completed: number;
  blocked: number;
  failed: number;
  cost: number;
  createdAt: Date;
}

export async function recentBatches(limit = 8): Promise<RecentBatchRow[]> {
  const batches = await prisma.batch.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { projects: { select: { id: true, status: true } } },
  });
  const rows: RecentBatchRow[] = [];
  for (const b of batches) {
    const spent = await prisma.costEntry.aggregate({
      where: { estimated: false, projectId: { in: b.projects.map((p) => p.id) } },
      _sum: { amount: true },
    });
    rows.push({
      id: b.id,
      name: b.name,
      status: b.status,
      videos: b.projects.length,
      completed: b.projects.filter((p) => p.status === "completed").length,
      blocked: b.projects.filter((p) => ["needs_review", "budget_exhausted"].includes(p.status)).length,
      failed: b.projects.filter((p) => p.status === "failed").length,
      cost: Math.round((spent._sum.amount ?? 0) * 1e6) / 1e6,
      createdAt: b.createdAt,
    });
  }
  return rows;
}
