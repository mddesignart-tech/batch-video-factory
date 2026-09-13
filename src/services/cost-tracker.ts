import type { CostCategory } from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { round } from "@/lib/utils";

/**
 * Money is rounded to six decimal places, not the four that `round()` defaults
 * to. A single text call can legitimately cost $0.000045; at four places that
 * becomes $0.0000 and the spend simply disappears. Six places keeps fractions of
 * a cent, which is the scale these APIs actually bill at.
 */
const MONEY_DIGITS = 6;
const money = (value: number): number => round(value, MONEY_DIGITS);

/**
 * Cost ledger.
 *
 * Every charge - estimated or actual, first attempt or retry - becomes a row.
 * Project and batch totals are derived from those rows rather than incremented
 * in place, so a crash mid-generation cannot leave a total that disagrees with
 * its own history.
 */

export interface RecordCostInput {
  projectId?: string | null;
  batchId?: string | null;
  sceneId?: string | null;
  category: CostCategory;
  provider: string;
  model: string;
  amount: number;
  estimated?: boolean;
  isRetry?: boolean;
  note?: string;
}

export async function recordCost(input: RecordCostInput): Promise<void> {
  if (!Number.isFinite(input.amount)) return;
  await prisma.costEntry.create({
    data: {
      projectId: input.projectId ?? null,
      batchId: input.batchId ?? null,
      sceneId: input.sceneId ?? null,
      category: input.category,
      provider: input.provider,
      model: input.model,
      amount: money(input.amount),
      estimated: input.estimated ?? false,
      isRetry: input.isRetry ?? false,
      note: input.note ?? "",
    },
  });
  if (input.projectId && !input.estimated) {
    await syncProjectActualCost(input.projectId);
  }
}

export async function syncProjectActualCost(projectId: string): Promise<number> {
  const agg = await prisma.costEntry.aggregate({
    where: { projectId, estimated: false },
    _sum: { amount: true },
  });
  const total = money(agg._sum.amount ?? 0);
  await prisma.project.update({
    where: { id: projectId },
    data: { actualCost: total },
  });
  return total;
}

export async function syncBatchActualCost(batchId: string): Promise<number> {
  const agg = await prisma.project.aggregate({
    where: { batchId },
    _sum: { actualCost: true },
  });
  const total = money(agg._sum.actualCost ?? 0);
  await prisma.batch.update({
    where: { id: batchId },
    data: { actualCost: total },
  });
  return total;
}

/** Dollars already committed on a project - the router's remaining headroom. */
export async function spentOnProject(projectId: string): Promise<number> {
  const agg = await prisma.costEntry.aggregate({
    where: { projectId, estimated: false },
    _sum: { amount: true },
  });
  return money(agg._sum.amount ?? 0);
}

export type CostPeriod = "today" | "week" | "month" | "all";

export function periodStart(period: CostPeriod, now = new Date()): Date {
  const d = new Date(now);
  switch (period) {
    case "today":
      d.setHours(0, 0, 0, 0);
      return d;
    case "week": {
      // Week starts Monday, which is what a Vietnamese operator expects.
      const day = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - day);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case "month":
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      return d;
    case "all":
    default:
      return new Date(0);
  }
}

export interface CostSummary {
  period: CostPeriod;
  byCategory: Record<string, number>;
  /**
   * Money genuinely billed by a real provider. This is the only figure that
   * represents spending; everything else below is context.
   */
  actualApiCost: number;
  /** Forecasts recorded before work ran. Never real money. */
  estimatedCost: number;
  /**
   * What mock providers "charged": always 0. Reported separately so a reader
   * can see that mock activity happened without mistaking it for spending.
   */
  mockCost: number;
  /** Number of ledger rows attributed to mock providers. */
  mockCalls: number;
  /** Alias of actualApiCost, kept for existing callers. */
  total: number;
  videosGenerated: number;
  videosSucceeded: number;
  videosFailed: number;
  averageCostPerVideo: number;
}

export async function costSummary(period: CostPeriod): Promise<CostSummary> {
  const from = periodStart(period);

  const [rows, projects, realAgg, estimatedAgg, mockAgg] = await Promise.all([
    prisma.costEntry.groupBy({
      by: ["category"],
      where: { estimated: false, provider: { not: "mock" }, createdAt: { gte: from } },
      _sum: { amount: true },
    }),
    prisma.project.groupBy({
      by: ["status"],
      where: { createdAt: { gte: from } },
      _count: { _all: true },
    }),
    prisma.costEntry.aggregate({
      where: { estimated: false, provider: { not: "mock" }, createdAt: { gte: from } },
      _sum: { amount: true },
    }),
    prisma.costEntry.aggregate({
      where: { estimated: true, createdAt: { gte: from } },
      _sum: { amount: true },
    }),
    prisma.costEntry.aggregate({
      where: { estimated: false, provider: "mock", createdAt: { gte: from } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  // byCategory covers REAL spending only. Folding mock rows in here would make
  // a $0 mock run look like a stage that cost nothing rather than one that was
  // never billed at all.
  const byCategory: Record<string, number> = {};
  for (const row of rows) {
    byCategory[row.category] = money(row._sum.amount ?? 0);
  }
  const actualApiCost = money(realAgg._sum.amount ?? 0);

  const countOf = (status: string) =>
    projects.find((p) => p.status === status)?._count._all ?? 0;

  const succeeded = countOf("completed");
  const failed = countOf("failed");
  const generated = projects.reduce((sum, p) => sum + p._count._all, 0);

  return {
    period,
    byCategory,
    actualApiCost,
    estimatedCost: money(estimatedAgg._sum.amount ?? 0),
    mockCost: money(mockAgg._sum.amount ?? 0),
    mockCalls: mockAgg._count._all,
    total: actualApiCost,
    videosGenerated: generated,
    videosSucceeded: succeeded,
    videosFailed: failed,
    averageCostPerVideo: succeeded > 0 ? money(actualApiCost / succeeded) : 0,
  };
}
