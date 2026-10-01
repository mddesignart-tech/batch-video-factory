import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { setSpendCap } from "@/services/spend-guard";
import { approveAndRun, executeSceneAsset } from "@/services/batch-executor";
import { preflightImportedBatch } from "@/services/import-preflight";
import { reconcileInterruptedRuns } from "@/services/restart-recovery";
import { buildBatchResumePlans, continueAllEligible } from "@/services/video-resume";
import { tryLockVideo, unlockVideo } from "@/services/run-registry";
import { importBatch, makePng, seedMock, writeBatchFolder, type P6Video } from "./phase6-helpers";

/**
 * V1.2 Phase 6 (QĐ-114) §42 RESUME TEST: a 10-video batch where the process
 * "dies" with video 3 at an image, video 5 at its Video AI clip, video 7 at a
 * voice and video 9 before its render. After the restart, TIẾP TỤC TẤT CẢ must
 * finish exactly the missing work: completed videos untouched, no duplicate
 * request, no duplicate reservation, retryCount unchanged, and the money that
 * moved equal to the incremental plan. Mock providers only.
 */

let tmp = "";
let batchId = "";
let ids: Record<string, string> = {};
const STOP = ["v3", "v5", "v7", "v9"];

function video(n: number): P6Video {
  const id = `v${n}`;
  // The six videos that simply finish are cheap ($0: imported, local, silent) so
  // the fixture stays fast; the four crash points carry the paid steps.
  if (![3, 5, 7, 9].includes(n)) return { id, title: `Video ${n}`, scenes: [{ image: "b.png", duration: 1 }] };
  // Two scenes; video 5 has a VIDEO_AI scene; videos 3 and 7 buy images and voices.
  if (n === 5) {
    return { id, title: `Video ${n}`, scenes: [{ image: "a.png", motion: "VIDEO_AI", duration: 2, line: "Clip line five." }, { image: "b.png", duration: 1, line: "Second line five." }] };
  }
  return { id, title: `Video ${n}`, scenes: [{ duration: 1, line: `First line ${n}.` }, { duration: 1, line: `Second line ${n}.` }] };
}

beforeAll(async () => {
  await seedMock();
  await setSpendCap(100);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p6-resume10-"));
  const images = {
    "a.png": fs.readFileSync(await makePng(path.join(tmp, "src"), "red", "270x480")),
    "b.png": fs.readFileSync(await makePng(path.join(tmp, "src"), "blue", "270x480")),
  };
  ({ batchId, ids } = await importBatch(writeBatchFolder(path.join(tmp, "b"), Array.from({ length: 10 }, (_, i) => video(i + 1)), images)));
  await preflightImportedBatch(batchId);
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function sceneOf(videoKey: string, n: number) {
  return prisma.scene.findFirstOrThrow({ where: { projectId: ids[videoKey]!, sceneNumber: n } });
}

describe("§42 resume 10 video", () => {
  it("chạy lô; 4 video 'đang ở tiến trình khác' bị bỏ qua, 6 video xong", async () => {
    for (const k of STOP) expect(tryLockVideo(ids[k]!, "other-process")).toBe(true);
    try {
      await approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: false, wait: true });
    } finally {
      // Build each crash state while still "holding" the video, then let go.
      // v3: stopped at scene 2's image (scene 1 fully done).
      for (const k of ["image", "video", "voice"] as const) await executeSceneAsset((await sceneOf("v3", 1)).id, k);
      // v5: image of the VIDEO_AI scene done, its clip never started.
      await executeSceneAsset((await sceneOf("v5", 1)).id, "image");
      // v7: every picture done, scene 2's voice not.
      for (const k of ["image", "video", "voice"] as const) await executeSceneAsset((await sceneOf("v7", 1)).id, k);
      for (const k of ["image", "video"] as const) await executeSceneAsset((await sceneOf("v7", 2)).id, k);
      // v9: all media done, render never ran.
      for (const n of [1, 2]) for (const k of ["image", "video", "voice"] as const) await executeSceneAsset((await sceneOf("v9", n)).id, k);
      for (const k of STOP) {
        await prisma.project.update({ where: { id: ids[k]! }, data: { status: "media_generating", currentStep: "đang chạy" } });
        unlockVideo(ids[k]!, "other-process");
      }
    }
    const st = await prisma.project.findMany({ where: { batchId }, select: { id: true, status: true } });
    expect(st.filter((p) => p.status === "completed").length).toBe(6);
  }, 900_000);

  it("khởi động lại: 4 video INTERRUPTED; kế hoạch chỉ gồm phần còn thiếu; TIẾP TỤC TẤT CẢ hoàn tất đúng phần đó", async () => {
    const rec = await reconcileInterruptedRuns();
    expect(rec.videos).toBeGreaterThanOrEqual(4);
    const plans = await buildBatchResumePlans(batchId);
    const planOf = (k: string) => plans.find((p) => p.videoId === ids[k])!;
    expect(planOf("v1").nextStep).toBe("NONE");
    expect(planOf("v3").paidRequestsRequired).toMatchObject({ image: 1, video: 0 });
    expect(planOf("v5").paidRequestsRequired).toMatchObject({ image: 0, video: 1 });
    expect(planOf("v7").paidRequestsRequired).toMatchObject({ image: 0, video: 0, voice: 1 });
    expect(planOf("v9").nextStep).toBe("RENDER_ONLY");
    expect(planOf("v9").paidRequestsRequired.total).toBe(0);
    const expectedPosts = STOP.reduce((n, k) => n + planOf(k).paidRequestsRequired.total, 0);
    const expectedCost = STOP.reduce((n, k) => n + (planOf(k).estimatedIncrementalCost ?? 0), 0);

    const jobsBefore = await prisma.providerJob.findMany({ select: { id: true, idempotencyKey: true, projectId: true } });
    const costBefore = await prisma.costEntry.aggregate({ where: { projectId: { in: Object.values(ids) }, estimated: false }, _sum: { amount: true } });
    const doneBefore = await prisma.project.findMany({ where: { batchId, status: "completed" }, select: { id: true, finalVideoPath: true } });
    const retryBefore = await prisma.scene.aggregate({ where: { project: { batchId } }, _sum: { retryCount: true } });

    const preview = await continueAllEligible(batchId);
    expect(preview.status).toBe("NEEDS_CONFIRMATION");
    expect(preview.summary.completed).toBe(6);
    expect(preview.summary.zeroCost).toBe(1); // v9: render only
    expect(preview.summary.paid).toBe(3);
    const run = await continueAllEligible(batchId, { confirmPaid: true, expectedFingerprint: preview.fingerprint, wait: true });
    expect(run.status).toBe("COMPLETED");

    const jobsAfter = await prisma.providerJob.findMany({ select: { id: true, idempotencyKey: true, projectId: true } });
    const newJobs = jobsAfter.filter((j) => !jobsBefore.some((b) => b.id === j.id));
    expect(newJobs.length).toBe(expectedPosts);
    expect(newJobs.every((j) => STOP.map((k) => ids[k]).includes(j.projectId!))).toBe(true);
    expect(new Set(jobsAfter.map((j) => j.idempotencyKey)).size).toBe(jobsAfter.length);
    // No request key holds two reservations.
    const res = await prisma.costReservation.groupBy({ by: ["idempotencyKey"], _count: { _all: true } });
    expect(res.every((r) => r._count._all === 1)).toBe(true);
    const retryAfter = await prisma.scene.aggregate({ where: { project: { batchId } }, _sum: { retryCount: true } });
    expect(retryAfter._sum.retryCount).toBe(retryBefore._sum.retryCount);
    // Mock providers bill $0, so no real money moves; what the gate HELD for the
    // new requests is what must match the incremental plan.
    const costAfter = await prisma.costEntry.aggregate({ where: { projectId: { in: Object.values(ids) }, estimated: false }, _sum: { amount: true } });
    expect((costAfter._sum.amount ?? 0) - (costBefore._sum.amount ?? 0)).toBeCloseTo(0, 6);
    const held = await prisma.costReservation.aggregate({
      where: { idempotencyKey: { in: newJobs.map((j) => j.idempotencyKey).filter((k): k is string => !!k) } },
      _sum: { estimatedCost: true },
    });
    // The plan prices voices from a word-count estimate; at send time the router
    // prices the real line, so the hold may come in a little under - never over.
    expect(held._sum.estimatedCost ?? 0).toBeGreaterThan(expectedCost * 0.9);
    expect(held._sum.estimatedCost ?? 0).toBeLessThanOrEqual(expectedCost + 1e-6);
    // Finished videos were not rendered again.
    for (const d of doneBefore) {
      expect((await prisma.project.findUniqueOrThrow({ where: { id: d.id } })).finalVideoPath).toBe(d.finalVideoPath);
    }
    const st = await prisma.project.findMany({ where: { batchId }, select: { status: true } });
    expect(st.every((p) => p.status === "completed")).toBe(true);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("COMPLETED");
  }, 900_000);
});
