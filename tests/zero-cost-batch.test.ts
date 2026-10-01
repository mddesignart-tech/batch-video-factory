import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { setSpendCap } from "@/services/spend-guard";
import { approveAndRun } from "@/services/batch-executor";
import { runZeroCostVideos } from "@/services/daily-actions";
import { buildWorkspace } from "@/services/daily-workspace";
import { preflightImportedBatch } from "@/services/import-preflight";
import { reconcileInterruptedRuns } from "@/services/restart-recovery";
import { tryLockVideo, unlockVideo } from "@/services/run-registry";
import { importBatch, makePng, moneyCounts, seedMock, writeBatchFolder, type P6Video } from "./phase6-helpers";

/**
 * V1.2 Phase 6 (QĐ-114) §40 ZERO-COST TEST BATCH: 10 videos, 50 scenes, mock.
 *
 *   v01-v06  imported pictures, LOCAL_MOTION, silent
 *   v07      same storyboard as an earlier video: generated pictures + voices REUSED
 *   v08      same storyboard as an earlier video: Video AI clip + voices REUSED
 *   v09      BLOCKED (its own max_cost is far below its estimate)
 *   v10      INTERRUPTED (the app "restarted" while it ran)
 * and, on the second pass, v01's final MP4 missing -> local render only.
 *
 * Expected: not one ProviderJob (not even a mock one) for the whole batch;
 * every video except v09 finishes; v09 does not stop the others.
 */

let tmp = "";
let scopeBefore: string | undefined;
const images: Record<string, Buffer> = {};

const SEED_I: P6Video = {
  id: "seed-i",
  title: "Hạt giống ảnh",
  scenes: [0, 1, 2, 3, 4].map((i) => ({ duration: 1, line: `Seed image line ${i + 1}.` })),
};
const SEED_V: P6Video = {
  id: "seed-v",
  title: "Hạt giống Video AI",
  scenes: [
    { image: "c0.png", motion: "VIDEO_AI" as const, duration: 2, line: "Seed clip line." },
    ...[1, 2, 3, 4].map((i) => ({ image: `c${i}.png`, duration: 1, line: `Seed local line ${i}.` })),
  ],
};

beforeAll(async () => {
  scopeBefore = process.env.ASSET_REUSE_SCOPE;
  process.env.ASSET_REUSE_SCOPE = "GLOBAL";
  await seedMock();
  await setSpendCap(100);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p6-zero-"));
  const colours = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan", "gray", "white"];
  for (let i = 0; i < colours.length; i += 1) {
    images[`c${i}.png`] = fs.readFileSync(await makePng(path.join(tmp, "src"), colours[i]!, "270x480"));
  }
});

afterAll(() => {
  if (scopeBefore === undefined) delete process.env.ASSET_REUSE_SCOPE;
  else process.env.ASSET_REUSE_SCOPE = scopeBefore;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("§40 ZERO-COST TEST BATCH — 10 video / 50 cảnh", () => {
  let batchId = "";
  let ids: Record<string, string> = {};

  it("chuẩn bị: một lô trước đó đã mua (mock) ảnh, giọng, clip cho 2 storyboard", async () => {
    const seed = await importBatch(writeBatchFolder(path.join(tmp, "seed"), [SEED_I, SEED_V], images));
    await preflightImportedBatch(seed.batchId);
    await approveAndRun({ batchId: seed.batchId, maxBatch: 5, lowAutoApproved: false, wait: true });
    const st = await prisma.project.findMany({ where: { batchId: seed.batchId }, select: { status: true } });
    expect(st.every((p) => p.status === "completed")).toBe(true);
  });

  it("nhập lô 10 video / 50 cảnh; 8 video $0 được nhận ra trước khi chạy; v09 BỊ CHẶN", async () => {
    const videos: P6Video[] = [];
    for (let v = 1; v <= 6; v += 1) {
      videos.push({
        id: `v0${v}`,
        title: `Video nhập ${v}`,
        scenes: [0, 1, 2, 3, 4].map((s) => ({ image: `c${(v + s) % 10}.png`, duration: 1 })),
      });
    }
    videos.push({ ...SEED_I });
    videos.push({ ...SEED_V });
    videos.push({ id: "v09", title: "Video bị chặn", maxCost: 0.000001, scenes: [0, 1, 2, 3, 4].map(() => ({ duration: 1 })) });
    videos.push({ id: "v10", title: "Video gián đoạn", scenes: [0, 1, 2, 3, 4].map((s) => ({ image: `c${(s + 3) % 10}.png`, duration: 1 })) });
    ({ batchId, ids } = await importBatch(writeBatchFolder(path.join(tmp, "main"), videos, images)));
    const pre = await preflightImportedBatch(batchId);
    expect(pre.videos.length).toBe(10);
    expect(pre.totalScenes).toBe(50);
    const ws = (await buildWorkspace(batchId))!;
    const zero = ws.videos.filter((v) => v.zeroCost).map((v) => v.title).sort();
    expect(zero).toEqual(
      ["Video nhập 1", "Video nhập 2", "Video nhập 3", "Video nhập 4", "Video nhập 5", "Video nhập 6", "Video gián đoạn", SEED_I.title, SEED_V.title].sort(),
    );
    const seedV = ws.videos.find((v) => v.title === SEED_V.title)!;
    expect(seedV.counts.videoAi).toBe(1);
    expect(seedV.reuseSaving).toBeGreaterThan(0);
    expect(ws.videos.find((v) => v.title === "Video bị chặn")!.status).toBe("BỊ CHẶN");
  });

  it("lượt $0 đầu tiên (v10 'đang chạy ở tiến trình khác'): 0 ProviderJob; 8 video xong; v09 không chặn ai", async () => {
    const v10 = ids.v10!;
    expect(tryLockVideo(v10, "crashed-process")).toBe(true);
    const before = await moneyCounts();
    try {
      await runZeroCostVideos(batchId, { wait: true });
    } finally {
      // The process "dies": its lock vanishes, the row still says running.
      unlockVideo(v10, "crashed-process");
    }
    await prisma.project.update({ where: { id: v10 }, data: { status: "media_generating", currentStep: "Ảnh · cảnh 3/5" } });
    const after = await moneyCounts();
    expect(after.providerJobs).toBe(before.providerJobs);
    expect(after.costEntries).toBe(before.costEntries);
    const st = Object.fromEntries((await prisma.project.findMany({ where: { batchId }, select: { id: true, status: true } })).map((p) => [p.id, p.status]));
    for (const k of ["v01", "v02", "v03", "v04", "v05", "v06", "seed-i", "seed-v"]) expect(st[ids[k]!]).toBe("completed");
    expect(st[ids.v09!]).toBe("needs_review");
  });

  it("khởi động lại + lượt $0 thứ hai: v10 chạy tiếp, v01 mất final.mp4 chỉ render lại; vẫn 0 ProviderJob", async () => {
    const rec = await reconcileInterruptedRuns();
    expect(rec.videos).toBeGreaterThanOrEqual(1);
    const v01 = await prisma.project.findUniqueOrThrow({ where: { id: ids.v01! } });
    fs.rmSync(toAbsolute(v01.finalVideoPath!));
    const before = await moneyCounts();
    const r = await runZeroCostVideos(batchId, { wait: true });
    expect(r.path).toBe("CONTINUED");
    expect([...r.videos].sort()).toEqual([ids.v01!, ids.v10!].sort());
    const after = await moneyCounts();
    expect(after.providerJobs).toBe(before.providerJobs);
    expect(after.costEntries).toBe(before.costEntries);
    expect(after.paidJobs).toBe(before.paidJobs);
    const v01b = await prisma.project.findUniqueOrThrow({ where: { id: ids.v01! } });
    expect(v01b.status).toBe("completed");
    expect(fs.existsSync(toAbsolute(v01b.finalVideoPath!))).toBe(true);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: ids.v10! } })).status).toBe("completed");
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("COMPLETED_WITH_ERRORS");
    // Not one request of any kind for this batch, from start to end.
    expect(await prisma.providerJob.count({ where: { projectId: { in: Object.values(ids) } } })).toBe(0);
  });
});
