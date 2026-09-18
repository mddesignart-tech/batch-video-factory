import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { round } from "@/lib/utils";
import { DATA_ROOT } from "@/lib/paths";
import { reservationLedger } from "./cost-reservation";

/**
 * The artefact a batch leaves behind, written from the ledger rather than from
 * whatever the run happened to remember.
 *
 * Every figure here is read back out of the tables that were written as the
 * money moved: `CostEntry` for what was actually charged, `ProviderJob` for
 * which vendor was asked what, `CostReservation` for whether anything is still
 * being held. A report assembled from in-memory counters would agree with
 * itself and could still disagree with the bill.
 */

export interface BatchReportVideo {
  video: string;
  projectId: string;
  status: string;
  durationSec: number | null;
  sceneCount: number;
  localMotionCount: number;
  videoAiCount: number;
  suppliedKeyframes: number;
  estimatedCost: number;
  actualCost: number;
  providerUsage: { provider: string; model: string; kind: string; calls: number; cost: number }[];
  outputPath: string | null;
  error: string | null;
}

export interface BatchReport {
  batchId: string;
  batchName: string;
  status: string;
  generatedAt: string;
  authorization: {
    status: string;
    ceiling: number;
    estimated: number;
    actualSpend: number;
    unused: number;
  } | null;
  reservations: { reserved: number; committed: number; ceiling: number };
  videos: BatchReportVideo[];
  totals: {
    videos: number;
    completed: number;
    failed: number;
    scenes: number;
    estimatedCost: number;
    actualCost: number;
  };
}

export async function buildBatchReport(batchId: string): Promise<BatchReport> {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: {
      authorization: true,
      projects: {
        orderBy: { createdAt: "asc" },
        include: { scenes: { where: { skipped: false }, orderBy: { sceneNumber: "asc" } } },
      },
    },
  });
  if (!batch) throw new Error(`Không tìm thấy lô ${batchId}.`);

  const videos: BatchReportVideo[] = [];
  for (const project of batch.projects) {
    const costs = await prisma.costEntry.groupBy({
      by: ["provider", "model", "category"],
      where: { projectId: project.id, estimated: false },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const actual = round(costs.reduce((n, c) => n + (c._sum.amount ?? 0), 0), 6);
    const duration = project.scenes.reduce((n, s) => n + s.duration, 0);

    videos.push({
      video: project.title,
      projectId: project.id,
      status: project.status,
      durationSec: project.finalVideoPath ? round(duration, 3) : null,
      sceneCount: project.scenes.length,
      localMotionCount: project.scenes.filter((s) => s.motionSource === "LOCAL_MOTION").length,
      videoAiCount: project.scenes.filter((s) => s.motionSource === "AI_VIDEO").length,
      suppliedKeyframes: project.scenes.filter((s) => s.imageSource === "IMPORTED").length,
      estimatedCost: round(project.estimatedCost, 6),
      actualCost: actual,
      providerUsage: costs
        .map((c) => ({
          provider: c.provider,
          model: c.model,
          kind: c.category,
          calls: c._count._all,
          cost: round(c._sum.amount ?? 0, 6),
        }))
        .sort((a, b) => b.cost - a.cost),
      outputPath: project.finalVideoPath,
      error: project.errorMessage,
    });
  }

  const ceiling = batch.authorization?.authorizedMaxSpend ?? 0;
  const ledger = await reservationLedger(batchId, ceiling);
  const actualTotal = round(videos.reduce((n, v) => n + v.actualCost, 0), 6);

  return {
    batchId,
    batchName: batch.name,
    status: batch.status,
    generatedAt: new Date().toISOString(),
    authorization: batch.authorization
      ? {
          status: batch.authorization.status,
          ceiling,
          estimated: round(batch.authorization.estimatedCost, 6),
          actualSpend: round(batch.authorization.actualSpend, 6),
          unused: round(Math.max(0, ceiling - batch.authorization.actualSpend), 6),
        }
      : null,
    reservations: {
      reserved: round(ledger.reserved, 6),
      committed: round(ledger.committed, 6),
      ceiling: round(ledger.ceiling, 6),
    },
    videos,
    totals: {
      videos: videos.length,
      completed: videos.filter((v) => v.status === "completed").length,
      failed: videos.filter((v) => v.error !== null).length,
      scenes: videos.reduce((n, v) => n + v.sceneCount, 0),
      estimatedCost: round(videos.reduce((n, v) => n + v.estimatedCost, 0), 6),
      actualCost: actualTotal,
    },
  };
}

/** Write `batch-report.json` next to the batch's outputs and return its path. */
export async function writeBatchReport(batchId: string): Promise<string> {
  const report = await buildBatchReport(batchId);
  const dir = path.join(DATA_ROOT, "reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `batch-report-${batchId.slice(0, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
  return file;
}
