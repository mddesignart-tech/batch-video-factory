import type { CostCategory } from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { round } from "@/lib/utils";

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
      amount: round(input.amount),
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
  const total = round(agg._sum.amount ?? 0);
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
  const total = round(agg._sum.actualCost ?? 0);
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
  return round(agg._sum.amount ?? 0);
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
  total: number;
  videosGenerated: number;
  videosSucceeded: number;
  videosFailed: number;
  averageCostPerVideo: number;
}

export async function costSummary(period: CostPeriod): Promise<CostSummary> {
  const from = periodStart(period);

  const [rows, projects] = await Promise.all([
    prisma.costEntry.groupBy({
      by: ["category"],
      where: { estimated: false, createdAt: { gte: from } },
      _sum: { amount: true },
    }),
    prisma.project.groupBy({
      by: ["status"],
      where: { createdAt: { gte: from } },
      _count: { _all: true },
    }),
  ]);

  const byCategory: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const amount = round(row._sum.amount ?? 0);
    byCategory[row.category] = amount;
    total += amount;
  }
  total = round(total);

  const countOf = (status: string) =>
    projects.find((p) => p.status === status)?._count._all ?? 0;

  const succeeded = countOf("completed");
  const failed = countOf("failed");
  const generated = projects.reduce((sum, p) => sum + p._count._all, 0);

  return {
    period,
    byCategory,
    total,
    videosGenerated: generated,
    videosSucceeded: succeeded,
    videosFailed: failed,
    averageCostPerVideo: succeeded > 0 ? round(total / succeeded) : 0,
  };
}
