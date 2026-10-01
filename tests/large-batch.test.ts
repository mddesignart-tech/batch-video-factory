import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { setSpendCap } from "@/services/spend-guard";
import { preflightImportedBatch } from "@/services/import-preflight";
import { buildWorkspace } from "@/services/daily-workspace";
import { batchHistory, queueView } from "@/services/daily-history";
import { preflightForApproval } from "@/services/batch-executor";
import { importBatch, makePng, seedMock, writeBatchFolder, type P6Video } from "./phase6-helpers";

/**
 * V1.2 Phase 6 (QĐ-114) §41/§56 LARGE BATCH: 100 videos, 500 scenes, mock, no
 * media made. The screens must stay usable: preflight, the workspace builder,
 * the queue and the history are timed, and building the workspace repeatedly
 * must not grow memory without bound. Bounds are generous on purpose - this
 * guards against an N+1 catastrophe, not a micro-benchmark.
 */

let tmp = "";
let batchId = "";
const timings: Record<string, number> = {};

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  timings[label] = Math.round(performance.now() - t0);
  return r;
}

beforeAll(async () => {
  // Measured (QĐ-114): importing writes each scene's rows one fsync at a time;
  // with SQLite's default rollback journal a 50-scene import took 70-100 s on
  // this machine, with WAL 6 s. Switching the PRODUCTION file to WAL is an
  // operator decision (backups must then copy -wal too), so only THIS test's
  // throwaway database uses it, and it is put back afterwards.
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
  await seedMock();
  await setSpendCap(100);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p6-large-"));
  const images: Record<string, Buffer> = {};
  const colours = ["red", "blue", "green", "yellow", "purple"];
  for (let i = 0; i < colours.length; i += 1) images[`c${i}.png`] = fs.readFileSync(await makePng(path.join(tmp, "src"), colours[i]!, "270x480"));
  const videos: P6Video[] = Array.from({ length: 100 }, (_, v) => ({
    id: `v${String(v + 1).padStart(3, "0")}`,
    title: `Video lớn số ${v + 1}`,
    scenes: [0, 1, 2, 3, 4].map((s) => ({ image: `c${(v + s) % 5}.png`, duration: 1 })),
  }));
  ({ batchId } = await timed("import", () => importBatch(writeBatchFolder(path.join(tmp, "big"), videos, images), { maxCostForBatch: 500 })));
}, 900_000);

afterAll(async () => {
  // Printed for the phase report (§56).
  console.log(`[large-batch] timings ms: ${JSON.stringify(timings)}`);
  // Leaving WAL needs the only open connection; Prisma's pool holds several,
  // so close them all first - the next query opens a single fresh one.
  await prisma.$disconnect();
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=DELETE;");
  const rows = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode;");
  expect(rows[0]?.journal_mode.toLowerCase()).toBe("delete");
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("§41 100 video / 500 cảnh", () => {
  it("preflight 500 cảnh trong thời gian dùng được", async () => {
    const pre = await timed("preflight", () => preflightImportedBatch(batchId));
    expect(pre.videos.length).toBe(100);
    expect(pre.totalScenes).toBe(500);
    expect(pre.totalSuppliedImages).toBe(500);
    expect(pre.counts.imageBuy).toBe(0);
    expect(timings.preflight!).toBeLessThan(180_000);
  }, 600_000);

  it("kiểm tra duyệt (preflight với số tiền) cho 100 video", async () => {
    const check = await timed("approval-check", () => preflightForApproval(batchId, { maxBatch: 1 }));
    expect(check.runnableVideos).toBe(100);
    expect(check.imagePosts).toBe(0);
  }, 600_000);

  it("trang làm việc: 100 thẻ dữ liệu, trạng thái đúng, không treo; bộ nhớ không tăng mãi", async () => {
    const ws = (await timed("workspace", () => buildWorkspace(batchId)))!;
    expect(ws.videos.length).toBe(100);
    expect(ws.videos.every((v) => v.status === "SẴN SÀNG" && v.zeroCost)).toBe(true);
    expect(ws.summary!.zeroCostVideos).toBe(100);
    expect(ws.summary!.totalVideos).toBe(100);
    expect(timings.workspace!).toBeLessThan(240_000);
    if (global.gc) global.gc();
    const heap0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 2; i += 1) await buildWorkspace(batchId);
    if (global.gc) global.gc();
    const grown = (process.memoryUsage().heapUsed - heap0) / 1024 / 1024;
    timings.heapGrowthMb = Math.round(grown);
    expect(grown).toBeLessThan(300);
    // JSON sent to the page stays a reasonable size (paginated on the client).
    const bytes = JSON.stringify(ws).length;
    timings.workspaceJsonKb = Math.round(bytes / 1024);
    expect(bytes).toBeLessThan(5 * 1024 * 1024);
  }, 900_000);

  it("hàng đợi và lịch sử nhanh (không N+1)", async () => {
    const q = await timed("queue", () => queueView());
    expect(Array.isArray(q)).toBe(true);
    expect(timings.queue!).toBeLessThan(10_000);
    const h = await timed("history", () => batchHistory({ q: "video lon so 57" }));
    expect(h.some((x) => x.id === batchId && x.matchedVideos.includes("Video lớn số 57"))).toBe(true);
    expect(timings.history!).toBeLessThan(10_000);
  }, 120_000);
});
