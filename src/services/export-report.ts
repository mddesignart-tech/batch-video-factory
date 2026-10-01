import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { round } from "@/lib/utils";
import { ensureBatchSlug, OUTPUT_ROOT } from "./output-layout";
import { existingOutputFor, exportReadyOf } from "./output-export";
import { friendlyError } from "@/domain/user-errors";

/**
 * EXPORT REPORT and BATCH SUMMARY (V1.2 Phase 6, QĐ-114). Local, $0: read from
 * the ledger (CostEntry estimated=false), the ProviderJob rows (POST counts) and
 * the export folders. Written beside the videos:
 *
 *   data/output/<batch-slug>/batch-report.csv
 *   data/output/<batch-slug>/batch-report.json
 */

export const REPORT_COLUMNS = [
  "batch",
  "video",
  "title",
  "status",
  "duration",
  "output_path",
  "thumbnail",
  "subtitle",
  "cost",
  "reuse_saved",
  "image_posts",
  "video_posts",
  "voice_posts",
  "retries",
  "provider",
  "model",
  "error_reason",
] as const;
export type ReportRow = Record<(typeof REPORT_COLUMNS)[number], string | number>;

export interface BatchSummary {
  batchId: string;
  batchName: string;
  videos: number;
  completed: number;
  needsAttention: number;
  blocked: number;
  pending: number;
  totalDurationSec: number;
  apiSpent: number;
  reusedValue: number;
  localScenes: number;
  videoAiClips: number;
  rows: ReportRow[];
}

function csvCell(value: string | number): string {
  const s = String(value);
  // Formula injection: a cell starting with = + - @ is text, not a formula.
  const safe = /^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: ReportRow[]): string {
  const lines = [REPORT_COLUMNS.join(",")];
  for (const r of rows) lines.push(REPORT_COLUMNS.map((c) => csvCell(r[c])).join(","));
  // BOM so Excel opens Vietnamese text as UTF-8.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export async function buildBatchSummary(batchId: string): Promise<BatchSummary> {
  const batch = await prisma.batch.findUniqueOrThrow({
    where: { id: batchId },
    select: {
      id: true,
      name: true,
      projects: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          title: true,
          status: true,
          errorMessage: true,
          outputDir: true,
          outputSlug: true,
          exportReadyJson: true,
          scenes: { where: { skipped: false }, select: { motionSource: true, retryCount: true } },
        },
      },
    },
  });
  const ids = batch.projects.map((p) => p.id);
  const [costs, jobs, reused] = await Promise.all([
    prisma.costEntry.groupBy({
      by: ["projectId"],
      where: { projectId: { in: ids }, estimated: false, provider: { not: "mock" } },
      _sum: { amount: true },
    }),
    prisma.providerJob.findMany({
      // A POST that left this machine: finished, or carrying the vendor's task id.
      where: { projectId: { in: ids }, OR: [{ status: "completed" }, { externalId: { not: null } }] },
      select: { projectId: true, kind: true, provider: true, model: true, status: true },
    }),
    prisma.asset.findMany({
      where: { projectId: { in: ids }, source: "REUSED", reusedFromAssetId: { not: null } },
      select: { projectId: true, reusedFromAssetId: true },
    }),
  ]);
  const sourcePrices = reused.length
    ? await prisma.asset.findMany({
        where: { id: { in: reused.map((r) => r.reusedFromAssetId!) }, provider: { not: "mock" } },
        select: { id: true, actualCost: true },
      })
    : [];
  const price = new Map(sourcePrices.map((s) => [s.id, s.actualCost]));
  const spentBy = new Map(costs.map((c) => [c.projectId, c._sum.amount ?? 0]));

  const rows: ReportRow[] = [];
  let totalDuration = 0;
  for (const p of batch.projects) {
    const mine = jobs.filter((j) => j.projectId === p.id && j.provider !== "mock");
    const posts = (kind: string) => mine.filter((j) => j.kind === kind || (kind === "voice" && j.kind === "audio")).length;
    const output = p.status === "completed" ? existingOutputFor(p) : null;
    const ready = exportReadyOf(p.exportReadyJson);
    const duration = p.status === "completed" ? (ready?.durationSec ?? output?.metadata?.duration ?? 0) : 0;
    totalDuration += duration;
    const models = [...new Set(mine.map((j) => `${j.provider}/${j.model}`))];
    const saved = reused.filter((r) => r.projectId === p.id).reduce((n, r) => n + (price.get(r.reusedFromAssetId!) ?? 0), 0);
    rows.push({
      batch: batch.name,
      video: p.outputSlug ?? p.id.slice(0, 8),
      title: p.title,
      status: p.status,
      duration: round(duration, 3),
      output_path: output ? path.join(output.dir, "final.mp4") : "",
      thumbnail: output && fs.existsSync(path.join(output.dir, "thumbnail.jpg")) ? "thumbnail.jpg" : "",
      subtitle: output && fs.existsSync(path.join(output.dir, "subtitles.srt")) ? "subtitles.srt" : "",
      cost: round(spentBy.get(p.id) ?? 0, 6),
      reuse_saved: round(saved, 6),
      image_posts: posts("image"),
      video_posts: posts("video"),
      voice_posts: posts("voice"),
      retries: p.scenes.reduce((n, s) => n + s.retryCount, 0),
      provider: [...new Set(mine.map((j) => j.provider))].join(" "),
      model: models.join(" "),
      error_reason: p.status === "completed" ? "" : (friendlyError(p.errorMessage)?.title ?? ""),
    });
  }
  const all = batch.projects;
  return {
    batchId,
    batchName: batch.name,
    videos: all.length,
    completed: all.filter((p) => p.status === "completed").length,
    needsAttention: all.filter((p) => p.status === "failed").length,
    blocked: all.filter((p) => ["needs_review", "budget_exhausted"].includes(p.status)).length,
    pending: all.filter((p) => !["completed", "failed", "needs_review", "budget_exhausted"].includes(p.status)).length,
    totalDurationSec: round(totalDuration, 3),
    apiSpent: round([...spentBy.values()].reduce((n, v) => n + v, 0), 6),
    reusedValue: round(rows.reduce((n, r) => n + Number(r.reuse_saved), 0), 6),
    localScenes: all.reduce((n, p) => n + p.scenes.filter((s) => s.motionSource === "LOCAL_MOTION").length, 0),
    videoAiClips: rows.reduce((n, r) => n + Number(r.video_posts), 0),
    rows,
  };
}

/** Write CSV + JSON beside the batch's videos. Returns both paths. */
export async function writeExportReport(batchId: string): Promise<{ csv: string; json: string; summary: BatchSummary }> {
  const summary = await buildBatchSummary(batchId);
  const dir = path.join(OUTPUT_ROOT, await ensureBatchSlug(batchId));
  fs.mkdirSync(dir, { recursive: true });
  const csv = path.join(dir, "batch-report.csv");
  const json = path.join(dir, "batch-report.json");
  fs.writeFileSync(csv, toCsv(summary.rows), "utf8");
  fs.writeFileSync(json, JSON.stringify({ generatedAt: new Date().toISOString(), ...summary }, null, 2) + "\n", "utf8");
  return { csv, json, summary };
}

/** "5 công cụ AI — data\output\...\final.mp4" lines for COPY DANH SÁCH VIDEO. */
export function videoListText(summary: BatchSummary): string {
  return summary.rows
    .map((r, i) => `${i + 1}. ${r.title} — ${r.status === "completed" ? r.output_path || "(chưa xuất)" : `chưa xong (${r.status})`}`)
    .join("\n");
}
