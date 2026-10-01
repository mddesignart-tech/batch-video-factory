import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { getSettings, saveSettings } from "@/lib/settings";
import { setSpendCap } from "@/services/spend-guard";
import { approveAndRun, extendApproval, runBatch } from "@/services/batch-executor";
import { approveAuthorization, closeAuthorization } from "@/services/batch-authorization";
import { buildWorkspace } from "@/services/daily-workspace";
import { rerenderVideo, runSelectedVideos, runZeroCostVideos, setBatchMode } from "@/services/daily-actions";
import { continueAllEligible, continueVideo } from "@/services/video-resume";
import { reconcileInterruptedRuns } from "@/services/restart-recovery";
import { writeExportReport } from "@/services/export-report";
import { batchHistory, dailyBoard, queueView } from "@/services/daily-history";
import { preflightImportedBatch } from "@/services/import-preflight";
import { OUTPUT_ROOT } from "@/services/output-layout";
import { MOCK_FAILURE_ENV } from "@/providers/mock/mock-visual-providers";
import { importBatch, makePng, moneyCounts, seedMock, writeBatchFolder } from "./phase6-helpers";

/**
 * V1.2 Phase 6 (QĐ-114): the daily workflow on one mixed batch, mock providers.
 *
 *   Z1, Z2  imported pictures, LOCAL_MOTION, silent       -> $0 (FREE / LOCAL)
 *   P1      no pictures (2 images to create)              -> paid images
 *   V1      one VIDEO_AI scene (clip to create)           -> paid Video AI
 *   B1      video max_cost far below its estimate         -> BLOCKED
 *
 * Covers: workspace view, preflight summary, STRICT vs PARTIAL, $0 first with a
 * $0 ceiling (no POST at all), DUYỆT THÊM for the rest, queue order, double
 * click, failure isolation, COMPLETED_WITH_ERRORS, cancel, restart recovery,
 * invalid voice, bulk resume summary, export report, history, dashboard.
 */

let tmp = "";
const images: Record<string, Buffer> = {};
let settingsBefore: Awaited<ReturnType<typeof getSettings>>;

beforeAll(async () => {
  await seedMock();
  settingsBefore = await getSettings();
  await setSpendCap(100);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p6-daily-"));
  const colours = ["red", "blue", "green", "yellow", "purple", "orange"];
  for (const c of colours) images[`${c}.png`] = fs.readFileSync(await makePng(path.join(tmp, "src"), c, "270x480"));
});

afterAll(async () => {
  delete process.env[MOCK_FAILURE_ENV];
  await saveSettings({
    maxConcurrentVideos: settingsBefore.maxConcurrentVideos,
    defaultBatchMode: settingsBefore.defaultBatchMode,
  });
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mixed(name: string) {
  return writeBatchFolder(
    path.join(tmp, name),
    [
      { id: "z1", title: "Video miễn phí 1", scenes: [{ image: "red.png", duration: 1 }, { image: "blue.png", duration: 1 }] },
      { id: "z2", title: "Video miễn phí 2", scenes: [{ image: "green.png", duration: 1 }] },
      { id: "p1", title: "Video trả phí ảnh", scenes: [{ duration: 1 }, { duration: 1 }] },
      { id: "v1", title: "Video có Video AI", scenes: [{ image: "yellow.png", motion: "VIDEO_AI", duration: 2 }, { image: "purple.png", duration: 1 }] },
      { id: "b1", title: "Video bị chặn", maxCost: 0.000001, scenes: [{ duration: 1 }] },
    ],
    images,
  );
}

describe("1. Workspace + preflight + STRICT/PARTIAL + $0 trước + duyệt thêm", () => {
  let batchId = "";
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    ({ batchId, ids } = await importBatch(mixed("mixed-1"), { name: "Lô hỗn hợp - 2026-09-28" }));
    await preflightImportedBatch(batchId);
  });

  it("workspace: trạng thái thân thiện, lớp chi phí, video $0, lý do bị chặn bằng tiếng Việt", async () => {
    const ws = (await buildWorkspace(batchId))!;
    const by = Object.fromEntries(ws.videos.map((v) => [v.projectId, v]));
    expect(by[ids.z1!]!.status).toBe("SẴN SÀNG");
    expect(by[ids.z1!]!.zeroCost).toBe(true);
    expect(by[ids.z2!]!.zeroCost).toBe(true);
    expect(by[ids.p1!]!.zeroCost).toBe(false);
    expect(by[ids.p1!]!.costClass).toBe("PAID_LIGHT");
    expect(by[ids.v1!]!.costClass).toBe("PAID_VIDEO");
    expect(by[ids.b1!]!.status).toBe("BỊ CHẶN");
    expect(by[ids.b1!]!.problem?.title).toBe("Vượt giới hạn chi phí video");
    expect(ws.summary!.zeroCostVideos).toBe(2);
    expect(ws.summary!.blocked).toBe(1);
    expect(ws.summary!.videoAi).toBe(1);
    expect(ws.summary!.imported).toBe(5);
    expect(ws.step).toBe("PREFLIGHT");
    expect(ws.batch.name).toBe("Lô hỗn hợp - 2026-09-28");
    // Thumbnail from the imported picture, before anything is rendered.
    expect(by[ids.z1!]!.thumbnail).toMatch(/^\/api\/media\//);
  });

  it("STRICT: có video bị chặn -> không bắt đầu lô, không đổi gì; PARTIAL chạy được", async () => {
    await setBatchMode(batchId, "STRICT");
    const before = await moneyCounts();
    await expect(approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: false, wait: true })).rejects.toThrow(/STRICT_MODE_BLOCKED/);
    expect(await moneyCounts()).toEqual(before);
    expect((await prisma.batchAuthorization.findUnique({ where: { batchId } }))!.status).toBe("DRAFT");
    await setBatchMode(batchId, "PARTIAL");
  });

  it("CHẠY VIDEO $0 TRƯỚC: trần $0, chỉ Z1/Z2 chạy, 0 ProviderJob, 0 CostEntry; video khác không bị đụng", async () => {
    const before = await moneyCounts();
    const r = await runZeroCostVideos(batchId, { wait: true });
    expect(r.path).toBe("APPROVED");
    expect([...r.videos].sort()).toEqual([ids.z1!, ids.z2!].sort());
    const after = await moneyCounts();
    expect(after.providerJobs).toBe(before.providerJobs);
    expect(after.costEntries).toBe(before.costEntries);
    expect(after.paidJobs).toBe(before.paidJobs);
    const auth = (await prisma.batchAuthorization.findUnique({ where: { batchId } }))!;
    expect(auth.authorizedMaxSpend).toBe(0);
    const rows = await prisma.project.findMany({ where: { batchId }, select: { id: true, status: true, outputDir: true } });
    const st = Object.fromEntries(rows.map((p) => [p.id, p.status]));
    expect(st[ids.z1!]).toBe("completed");
    expect(st[ids.z2!]).toBe("completed");
    expect(st[ids.p1!]).toBe("script_ready");
    expect(st[ids.v1!]).toBe("script_ready");
    expect(st[ids.b1!]).toBe("needs_review");
    const batch = (await prisma.batch.findUniqueOrThrow({ where: { id: batchId } }))!;
    expect(batch.status).toBe("NEEDS_REVIEW");
    // New layout: data/output/<batch-slug>/<video-slug>/
    const z1 = rows.find((p) => p.id === ids.z1)!;
    expect(z1.outputDir).toBe(`output/${batch.slug}/video-mien-phi-1`);
    expect(fs.existsSync(path.join(OUTPUT_ROOT, batch.slug!, "video-mien-phi-1", "final.mp4"))).toBe(true);
  });

  it("bấm đúp DUYỆT THÊM: lần hai bị từ chối ALREADY_RUNNING trước mọi việc", async () => {
    const results = await Promise.allSettled([
      extendApproval({ batchId, addMaxSpend: 3, onlyProjectIds: [ids.p1!, ids.v1!], lowAutoApproved: false, wait: true }),
      extendApproval({ batchId, addMaxSpend: 3, onlyProjectIds: [ids.p1!, ids.v1!], lowAutoApproved: false, wait: true }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    expect(refused.length).toBe(1);
    expect(String(refused[0]!.reason)).toMatch(/ALREADY_RUNNING/);
  });

  it("DUYỆT THÊM: P1 (ảnh) chạy trước V1 (Video AI); trần lô tăng đúng số đã nhập; B1 không có job", async () => {
    const auth = (await prisma.batchAuthorization.findUnique({ where: { batchId } }))!;
    expect(auth.authorizedMaxSpend).toBe(3);
    const rows = await prisma.project.findMany({ where: { batchId }, select: { id: true, status: true, queueOrder: true } });
    const by = Object.fromEntries(rows.map((p) => [p.id, p]));
    expect(by[ids.p1!]!.status).toBe("completed");
    expect(by[ids.v1!]!.status).toBe("completed");
    expect(by[ids.p1!]!.queueOrder!).toBeLessThan(by[ids.v1!]!.queueOrder!);
    expect(await prisma.providerJob.count({ where: { projectId: ids.b1! } })).toBe(0);
    expect(await prisma.providerJob.count({ where: { projectId: { in: [ids.z1!, ids.z2!] } } })).toBe(0);
    expect(await prisma.providerJob.count({ where: { projectId: ids.v1!, kind: "video" } })).toBe(1);
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("COMPLETED_WITH_ERRORS");
  });

  it("TIẾP TỤC TẤT CẢ: tổng kết 4 xong, 1 bị chặn; không có gì để chạy; 0 job mới", async () => {
    const before = await moneyCounts();
    const r = await continueAllEligible(batchId, { wait: true });
    expect(r.status).toBe("NOTHING_TO_DO");
    expect(r.summary.completed).toBe(4);
    expect(r.summary.blocked).toBe(1);
    expect(r.summary.zeroCost).toBe(0);
    expect(await moneyCounts()).toEqual(before);
  });

  it("xuất báo cáo CSV + JSON cạnh video; tổng kết lô", async () => {
    const r = await writeExportReport(batchId);
    expect(fs.existsSync(r.csv)).toBe(true);
    expect(fs.existsSync(r.json)).toBe(true);
    const csv = fs.readFileSync(r.csv, "utf8");
    expect(csv.split(/\r\n/)[0]).toContain("batch,video,title,status,duration,output_path,thumbnail,subtitle,cost,reuse_saved,image_posts,video_posts,voice_posts,retries,provider,model,error_reason");
    expect(r.summary.videos).toBe(5);
    expect(r.summary.completed).toBe(4);
    expect(r.summary.blocked).toBe(1);
    expect(r.summary.apiSpent).toBe(0); // mock is never production money
    const b1 = r.summary.rows.find((x) => x.title === "Video bị chặn")!;
    expect(b1.error_reason).toBe("Vượt giới hạn chi phí video");
    expect(r.summary.totalDurationSec).toBeGreaterThan(0);
  });

  it("lịch sử: tìm theo tên video không dấu, theo ngày, theo trạng thái; dashboard không tính mock", async () => {
    const byTitle = await batchHistory({ q: "video mien phi" });
    expect(byTitle.some((h) => h.id === batchId)).toBe(true);
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect((await batchHistory({ date: day })).some((h) => h.id === batchId)).toBe(true);
    expect((await batchHistory({ status: "COMPLETED_WITH_ERRORS" })).some((h) => h.id === batchId)).toBe(true);
    expect((await batchHistory({ status: "FAILED" })).some((h) => h.id === batchId)).toBe(false);
    const row = (await batchHistory({ q: "Lô hỗn hợp" })).find((h) => h.id === batchId)!;
    expect(row.completed).toBe(4);
    expect(row.cost).toBe(0);
    expect(row.outputFolder).toMatch(/^output\//);
    const board = await dailyBoard();
    expect(board.apiSpend).toBe(0);
    const q = await queueView();
    expect(q.filter((x) => x.batchId === batchId).every((x) => x.state === "HOÀN THÀNH" || x.state === "BỊ CHẶN")).toBe(true);
  });
});

describe("2. Cô lập lỗi, chọn video, song song, huỷ, khởi động lại, giọng hỏng", () => {
  it("lỗi của một video không chặn video khác -> COMPLETED_WITH_ERRORS (PARTIAL)", async () => {
    const { batchId, ids } = await importBatch(
      writeBatchFolder(
        path.join(tmp, "iso"),
        [
          { id: "ok1", title: "Chạy tốt 1", scenes: [{ image: "red.png", duration: 1 }] },
          { id: "bad", title: "Sẽ lỗi", scenes: [{ duration: 1 }] },
          { id: "ok2", title: "Chạy tốt 2", scenes: [{ image: "blue.png", duration: 1 }] },
        ],
        images,
      ),
    );
    await preflightImportedBatch(batchId);
    process.env[MOCK_FAILURE_ENV] = "1";
    try {
      await approveAndRun({ batchId, maxBatch: 2, lowAutoApproved: false, wait: true });
    } finally {
      delete process.env[MOCK_FAILURE_ENV];
    }
    const st = Object.fromEntries(
      (await prisma.project.findMany({ where: { batchId }, select: { id: true, status: true } })).map((p) => [p.id, p.status]),
    );
    expect(st[ids.ok1!]).toBe("completed");
    expect(st[ids.ok2!]).toBe("completed");
    expect(st[ids.bad!]).toBe("failed");
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("COMPLETED_WITH_ERRORS");
    const ws = (await buildWorkspace(batchId))!;
    expect(ws.videos.find((v) => v.projectId === ids.bad)!.status).toBe("CẦN XỬ LÝ");
  });

  it("CHẠY VIDEO ĐÃ CHỌN trên lô chưa duyệt: chỉ video chọn chạy, video khác giữ nguyên; song song 2 video", async () => {
    await saveSettings({ maxConcurrentVideos: 2 });
    try {
      const { batchId, ids } = await importBatch(
        writeBatchFolder(
          path.join(tmp, "sel"),
          [
            { id: "a", title: "Chọn A", scenes: [{ image: "red.png", duration: 1 }] },
            { id: "b", title: "Chọn B", scenes: [{ image: "green.png", duration: 1 }] },
            { id: "c", title: "Không chọn C", scenes: [{ image: "blue.png", duration: 1 }] },
          ],
          images,
        ),
      );
      await preflightImportedBatch(batchId);
      const r = await runSelectedVideos({ batchId, projectIds: [ids.a!, ids.b!], maxBatch: 1, wait: true });
      expect(r.path).toBe("APPROVED");
      const st = Object.fromEntries(
        (await prisma.project.findMany({ where: { batchId }, select: { id: true, status: true } })).map((p) => [p.id, p.status]),
      );
      expect(st[ids.a!]).toBe("completed");
      expect(st[ids.b!]).toBe("completed");
      expect(st[ids.c!]).toBe("script_ready");
      // Then the rest: approved batch, C not covered -> DUYỆT THÊM path.
      const more = await runSelectedVideos({ batchId, projectIds: [ids.c!], maxBatch: 0.5, wait: true });
      expect(more.path).toBe("EXTENDED");
      expect((await prisma.project.findUniqueOrThrow({ where: { id: ids.c! } })).status).toBe("completed");
      expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("COMPLETED");
    } finally {
      await saveSettings({ maxConcurrentVideos: 1 });
    }
  });

  it("DỪNG trước khi video bắt đầu: video chưa chạy giữ nguyên trạng thái, không job, không đánh dấu lỗi", async () => {
    const { batchId, ids } = await importBatch(
      writeBatchFolder(path.join(tmp, "cancel"), [
        { id: "x", title: "Huỷ X", scenes: [{ image: "red.png", duration: 1 }] },
        { id: "y", title: "Huỷ Y", scenes: [{ image: "blue.png", duration: 1 }] },
      ], images),
    );
    await preflightImportedBatch(batchId);
    await approveAuthorization({ batchId, authorizedMaxSpend: 1, note: JSON.stringify({ runnableProjectIds: [ids.x, ids.y] }) });
    await closeAuthorization(batchId, "CANCELLED", "test: người dùng bấm DỪNG");
    const before = await moneyCounts();
    const run = await runBatch(batchId, { resume: true });
    expect(run.outcomes.every((o) => o.stopped.startsWith("CANCELLED"))).toBe(true);
    expect(await moneyCounts()).toEqual(before);
    const st = await prisma.project.findMany({ where: { batchId }, select: { status: true, errorMessage: true } });
    expect(st.every((p) => p.status === "script_ready" && p.errorMessage === null)).toBe(true);
  });

  it("khởi động lại: video 'đang chạy' không ai giữ -> INTERRUPTED (CẦN XỬ LÝ), không gửi gì; TIẾP TỤC chạy xong $0", async () => {
    const { batchId, ids } = await importBatch(
      writeBatchFolder(path.join(tmp, "restart"), [{ id: "r", title: "Gián đoạn", scenes: [{ image: "orange.png", duration: 1 }] }], images),
    );
    await preflightImportedBatch(batchId);
    await approveAuthorization({ batchId, authorizedMaxSpend: 1, note: JSON.stringify({ runnableProjectIds: [ids.r] }) });
    await prisma.project.update({ where: { id: ids.r! }, data: { status: "media_generating", currentStep: "Ảnh · cảnh 1/1", runStartedAt: new Date() } });
    await prisma.batch.update({ where: { id: batchId }, data: { status: "RUNNING" } });
    const before = await moneyCounts();
    const rec = await reconcileInterruptedRuns();
    expect(rec.videos).toBeGreaterThanOrEqual(1);
    expect(await moneyCounts()).toEqual(before);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: ids.r! } });
    expect(p.status).toBe("failed");
    expect(p.errorMessage).toMatch(/^INTERRUPTED:/);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).not.toBe("RUNNING");
    const ws = (await buildWorkspace(batchId))!;
    expect(ws.videos[0]!.status).toBe("CẦN XỬ LÝ");
    expect(ws.videos[0]!.interrupted).toBe(true);
    expect(ws.videos[0]!.problem?.title).toMatch(/gián đoạn/i);
    const c = await continueVideo(ids.r!, { wait: true });
    expect(c.status).toBe("COMPLETED");
    expect((await prisma.project.findUniqueOrThrow({ where: { id: ids.r! } })).status).toBe("completed");
    expect(await moneyCounts()).toEqual(before);
  });

  it("file giọng hỏng (78 byte): CẦN XỬ LÝ, lý do 'cần tạo lại giọng — có thể phát sinh chi phí', không tự gọi TTS", async () => {
    const { batchId, ids } = await importBatch(
      writeBatchFolder(path.join(tmp, "voice"), [{ id: "w", title: "Giọng hỏng", scenes: [{ image: "red.png", duration: 1, line: "Hello there." }] }], images),
    );
    await preflightImportedBatch(batchId);
    await approveAndRun({ batchId, maxBatch: 1, lowAutoApproved: false, wait: true });
    const line = await prisma.dialogueLine.findFirstOrThrow({ where: { scene: { projectId: ids.w! }, status: "completed" } });
    fs.writeFileSync(toAbsolute(line.outputPath), Buffer.alloc(78));
    // Finished video: its MP4 stands, but it is NEEDS_ATTENTION and cannot be re-rendered silently.
    const done = (await buildWorkspace(batchId))!.videos[0]!;
    expect(done.status).toBe("CẦN XỬ LÝ");
    expect(done.output).not.toBeNull();
    await expect(rerenderVideo(ids.w!)).rejects.toThrow(/INVALID_VOICE_ASSET/);
    // The video needs work again (its final was lost): the broken voice is found before anything runs.
    await prisma.project.update({ where: { id: ids.w! }, data: { status: "failed", errorMessage: "render: final lost" } });
    const pre = await preflightImportedBatch(batchId);
    expect(pre.videos[0]!.lifecycle).toBe("BLOCKED");
    expect(pre.videos[0]!.blockedReason).toMatch(/INVALID_VOICE_ASSET/);
    const ws = (await buildWorkspace(batchId))!;
    expect(ws.videos[0]!.status).toBe("CẦN XỬ LÝ");
    expect(ws.videos[0]!.invalidVoice).toBe(true);
    expect(ws.videos[0]!.problem?.title).toBe("Cần tạo lại giọng — có thể phát sinh chi phí");
    const voiceJobs = await prisma.providerJob.count({ where: { projectId: ids.w!, kind: { in: ["voice", "audio"] } } });
    const c = await continueVideo(ids.w!, { confirmPaid: true, wait: true });
    expect(c.status).toBe("BLOCKED");
    const run = await runBatch(batchId, { resume: true, onlyProjectIds: [ids.w!] });
    expect(run.outcomes[0]!.stopped).toMatch(/INVALID_VOICE_ASSET/);
    expect(await prisma.providerJob.count({ where: { projectId: ids.w!, kind: { in: ["voice", "audio"] } } })).toBe(voiceJobs);
  });
});
