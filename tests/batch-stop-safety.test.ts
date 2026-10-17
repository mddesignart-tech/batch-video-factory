import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { setSpendCap } from "@/services/spend-guard";
import { approveAndRun, resumeRun, runBatch, isRunning } from "@/services/batch-executor";
import { batchProgress, cancelBatch } from "@/services/batch-runner";
import { rerenderVideo } from "@/services/daily-actions";
import { preflightImportedBatch } from "@/services/import-preflight";
import { buildBatchResumePlans } from "@/services/video-resume";
import { tryLockVideo, unlockVideo } from "@/services/run-registry";
import { nextDefaultBatchName } from "@/domain/batch-naming";
import { NO_VIDEOS_YET } from "@/domain/friendly-status";
import { importBatch, makePng, seedMock, writeBatchFolder, type P6Video } from "./phase6-helpers";

/**
 * QĐ-137 - DỪNG BATCH must really stop.
 *
 * The smoke run showed a stopped batch walking on through the scenes of the
 * video it was on (the stop was only read between videos) and staying RUNNING
 * in the database. Here a stop is pressed at chosen moments of a mock run - the
 * hook fires right AFTER a step returns, i.e. while that step was "in flight"
 * when the person pressed DỪNG - and nothing after that moment may start.
 * Mock providers only: no network, $0.
 */

const hook = vi.hoisted(() => ({
  after: null as null | ((kind: "image" | "video" | "voice", sceneId: string) => Promise<void>),
}));

vi.mock("@/services/generation", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/services/generation")>();
  const wrap =
    <A extends unknown[], R>(kind: "image" | "video" | "voice", fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      const r = await fn(...a);
      if (hook.after) await hook.after(kind, a[0] as string);
      return r;
    };
  return {
    ...orig,
    generateSceneImage: wrap("image", orig.generateSceneImage),
    generateSceneVideo: wrap("video", orig.generateSceneVideo),
    generateSceneVoice: wrap("voice", orig.generateSceneVoice),
  };
});

let tmp = "";
let images: Record<string, Buffer> = {};

const paidVideo = (id: string, scenes: number): P6Video => ({
  id,
  title: `Paid ${id}`,
  // No picture and a spoken line: every scene buys an image and a voice (mock).
  scenes: Array.from({ length: scenes }, (_, i) => ({ duration: 1, line: `Line ${i + 1} of ${id}.` })),
});
const localVideo = (id: string, scenes: number): P6Video => ({
  id,
  title: `Local ${id}`,
  // Imported picture, local motion, silent: $0, local work only.
  scenes: Array.from({ length: scenes }, () => ({ image: "a.png", duration: 1 })),
});

async function makeBatch(videos: P6Video[]) {
  const made = await importBatch(writeBatchFolder(fs.mkdtempSync(path.join(tmp, "b-")), videos, images));
  await preflightImportedBatch(made.batchId);
  return made;
}

/** Stop the batch the moment `kind` of the `n`-th scene of `projectId` returns. */
function stopAfter(batchId: string, projectId: string, n: number, kind: "image" | "video" | "voice") {
  hook.after = async (k, sceneId) => {
    if (k !== kind) return;
    const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
    if (scene.projectId === projectId && scene.sceneNumber === n) await cancelBatch(batchId, "test: DỪNG");
  };
}

const jobsOf = (projectId: string) => prisma.providerJob.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
const scenesOf = (projectId: string) => prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });

beforeAll(async () => {
  await seedMock();
  await setSpendCap(100);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qd137-stop-"));
  images = { "a.png": fs.readFileSync(await makePng(path.join(tmp, "src"), "red", "270x480")) };
});

afterAll(() => {
  hook.after = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("QĐ-137 DỪNG trước khi có job", () => {
  it("lô bị dừng trước khi run bắt đầu: không tạo job, không quay lại RUNNING", async () => {
    const { batchId, ids } = await makeBatch([paidVideo("s0", 2)]);
    // Approve while the video is held elsewhere: the approval exists, no step ran.
    expect(tryLockVideo(ids.s0!, "other")).toBe(true);
    try {
      await approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: false, wait: true });
    } finally {
      unlockVideo(ids.s0!, "other");
    }
    expect(await jobsOf(ids.s0!)).toHaveLength(0);

    await cancelBatch(batchId, "test: DỪNG");
    // A run that starts after the stop (a late start, a race) does nothing.
    const run = await runBatch(batchId, { resume: true });
    expect(run.settledStatus).toBe("CANCELLED");
    expect(await jobsOf(ids.s0!)).toHaveLength(0);
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("CANCELLED");
    const project = await prisma.project.findUniqueOrThrow({ where: { id: ids.s0! } });
    expect(project.status).not.toBe("failed");
  }, 300_000);
});

describe("QĐ-137 DỪNG giữa nhiều cảnh (sau cảnh 1, cảnh 2 chưa bắt đầu)", () => {
  let batchId = "";
  let ids: Record<string, string> = {};
  let jobsAtStop = 0;

  beforeAll(async () => {
    ({ batchId, ids } = await makeBatch([localVideo("loc", 1), paidVideo("pay", 3)]));
    stopAfter(batchId, ids.pay!, 1, "voice");
    await approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: false, wait: true });
    hook.after = null;
    jobsAtStop = (await jobsOf(ids.pay!)).length;
  }, 600_000);

  it("không tạo job / paid request nào sau lúc DỪNG", async () => {
    // Scene 1: its image and its voice (the voice was in flight when DỪNG came).
    expect(jobsAtStop).toBe(2);
    const scenes = await scenesOf(ids.pay!);
    expect(scenes[0]!.imagePath).toBeTruthy();
    expect(scenes[0]!.audioPath).toBeTruthy();
    for (const s of scenes.slice(1)) {
      expect(s.imagePath).toBeFalsy();
      expect(s.audioPath).toBeFalsy();
    }
    // Nothing was rendered for the stopped video.
    expect(await prisma.job.count({ where: { projectId: ids.pay!, type: "render_final" } })).toBe(0);
  });

  it("DB: lô CANCELLED (không RUNNING, không FAILED); video không bị đánh FAILED", async () => {
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("CANCELLED");
    const auth = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
    expect(auth.status).toBe("CANCELLED");
    const pay = await prisma.project.findUniqueOrThrow({ where: { id: ids.pay! } });
    expect(pay.status).not.toBe("failed");
    expect(pay.status).not.toBe("media_generating");
    expect(pay.errorMessage ?? "").not.toMatch(/CANCELLED/);
    // The $0 video that ran before the stop is finished and stays finished.
    expect((await prisma.project.findUniqueOrThrow({ where: { id: ids.loc! } })).status).toBe("completed");
  });

  it("reload: tiến trình đọc từ DB báo đã dừng, không còn run nào", async () => {
    expect(isRunning(batchId)).toBe(false);
    const progress = (await batchProgress(batchId))!;
    expect(progress.status).toBe("CANCELLED");
    expect(progress.running).toBe(false);
    expect(progress.authorization?.status).toBe("CANCELLED");
    expect(progress.counts.running).toBe(0);
  });

  it("DỪNG hai lần: không lỗi, giữ nguyên lần dừng đầu", async () => {
    const before = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
    const again = await cancelBatch(batchId);
    expect(again.alreadyStopped).toBe(true);
    const after = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
    expect(after.closedAt?.getTime()).toBe(before.closedAt?.getTime());
    expect(after.closedReason).toBe(before.closedReason);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("CANCELLED");
    expect(await jobsOf(ids.pay!)).toHaveLength(jobsAtStop);
  });

  it("DỪNG → render lại video đã xong: tại máy, $0, lô vẫn CANCELLED", async () => {
    const before = await prisma.providerJob.count();
    await rerenderVideo(ids.loc!);
    expect(await prisma.providerJob.count()).toBe(before);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("CANCELLED");
    expect(await jobsOf(ids.pay!)).toHaveLength(jobsAtStop);
  }, 300_000);

  it("DỪNG → TIẾP TỤC (người dùng bấm): chỉ làm phần thiếu, không lặp job/media", async () => {
    const scene1 = (await scenesOf(ids.pay!))[0]!;
    const jobsBefore = await jobsOf(ids.pay!);
    await resumeRun({ batchId, wait: true });
    const jobsAfter = await jobsOf(ids.pay!);
    // Scenes 2 and 3: one image and one voice each. Scene 1 is reused.
    expect(jobsAfter.length - jobsBefore.length).toBe(4);
    expect(new Set(jobsAfter.map((j) => j.idempotencyKey)).size).toBe(jobsAfter.length);
    const scene1After = (await scenesOf(ids.pay!))[0]!;
    expect(scene1After.imagePath).toBe(scene1.imagePath);
    expect(scene1After.audioPath).toBe(scene1.audioPath);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: ids.pay! } })).status).toBe("completed");
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("COMPLETED");
  }, 600_000);
});

describe("QĐ-137 DỪNG khi job trả phí (mock) đang bay", () => {
  it("request đã gửi được giữ kết quả; bước kế tiếp không bắt đầu", async () => {
    const { batchId, ids } = await makeBatch([paidVideo("fly", 3)]);
    // DỪNG pressed while scene 2's image was at the vendor.
    stopAfter(batchId, ids.fly!, 2, "image");
    await approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: false, wait: true });
    hook.after = null;
    const scenes = await scenesOf(ids.fly!);
    // Paid for, so kept - not thrown away and not pretended cancelled.
    expect(scenes[1]!.imagePath).toBeTruthy();
    // ...but its voice and all of scene 3 never started: PAID POST after stop = 0.
    expect(scenes[1]!.audioPath).toBeFalsy();
    expect(scenes[2]!.imagePath).toBeFalsy();
    expect(await jobsOf(ids.fly!)).toHaveLength(3);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("CANCELLED");
    expect((await prisma.project.findUniqueOrThrow({ where: { id: ids.fly! } })).status).not.toBe("failed");
  }, 600_000);
});

describe("QĐ-137 DỪNG khi đang làm việc tại máy (local job)", () => {
  it("không render, video không FAILED, lô CANCELLED", async () => {
    const { batchId, ids } = await makeBatch([localVideo("lj", 2)]);
    stopAfter(batchId, ids.lj!, 1, "image");
    await approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: false, wait: true });
    hook.after = null;
    expect(await prisma.job.count({ where: { projectId: ids.lj!, type: "render_final" } })).toBe(0);
    const project = await prisma.project.findUniqueOrThrow({ where: { id: ids.lj! } });
    expect(project.status).not.toBe("failed");
    expect(project.status).not.toBe("completed");
    expect(project.finalVideoPath).toBeFalsy();
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("CANCELLED");
    expect(await jobsOf(ids.lj!)).toHaveLength(0);
  }, 300_000);
});

describe("QĐ-137 tên lô mặc định", () => {
  it("tăng dần #001, #002, #003", () => {
    expect(nextDefaultBatchName([])).toBe("Batch Video Factory #001");
    expect(nextDefaultBatchName(["Batch Video Factory #001"])).toBe("Batch Video Factory #002");
    expect(nextDefaultBatchName(["Batch Video Factory #001", "Batch Video Factory #002"])).toBe("Batch Video Factory #003");
  });

  it("không trùng số khi lô cũ bị đổi tên / xoá; tên tự đặt vẫn được đếm", () => {
    // #002 was deleted: the next number is past the highest, not a reused one.
    expect(nextDefaultBatchName(["Batch Video Factory #001", "Batch Video Factory #003"])).toBe("Batch Video Factory #004");
    expect(nextDefaultBatchName(["Lô thử của tôi", "Khác"])).toBe("Batch Video Factory #003");
    expect(nextDefaultBatchName(["Batch Video Factory #012"])).toBe("Batch Video Factory #013");
  });
});

describe("QĐ-137 empty-state của lô thành ngữ chưa duyệt", () => {
  it("không trả lỗi của luồng nhập storyboard; trả danh sách rỗng", async () => {
    const batch = await prisma.batch.create({
      data: { name: "Batch Video Factory #900", amount: 3, status: "PLANNED", planJson: JSON.stringify({ videos: [] }) },
    });
    await expect(buildBatchResumePlans(batch.id)).resolves.toEqual([]);
    expect(NO_VIDEOS_YET).not.toMatch(/Lô nhập/);
    expect(NO_VIDEOS_YET).toMatch(/chưa được duyệt/);
  });
});
