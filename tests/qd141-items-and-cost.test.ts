import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { prisma } from "@/lib/prisma";
import { profileFromPlatform } from "@/domain/platform-profile";
import { formatOf, templateOf } from "@/domain/content-templates";
import { planScenes } from "@/domain/scene-planner";
import { checkItemCoverage, itemCoverageMessage, requestedItemsOf } from "@/domain/requested-items";
import { MockTextProvider } from "@/providers/mock/mock-text-provider";
import { MockImageProvider, MockVoiceProvider } from "@/providers/mock/mock-visual-providers";
import { writeMockContentScript } from "@/providers/mock/mock-content-writer";
import type { ContentScriptRequest } from "@/providers/types";
import { approveContentScript, createContentProject } from "@/services/content-service";
import { startMediaGeneration } from "@/services/project-service";
import { approveAndRun, renderProjectNow } from "@/services/batch-executor";
import { buildBatchResumePlans, continueVideo } from "@/services/video-resume";
import { recordCost, sceneActualCosts, syncProjectActualCost, syncSceneActualCost } from "@/services/cost-tracker";
import { release, reserve } from "@/services/cost-reservation";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { seedMock } from "./phase5-helpers";

/**
 * QĐ-141: the two leftovers of the first real-API smoke test (2026-10-19).
 *  1. "3 mẹo" got hook + ONE tip + recap: a counted request must get N items.
 *  2. Scene.actualCost stayed 0 and Project.estimatedCost read 0 after the run.
 * Mock only. Media "prices" below are set on the MOCK result to give the
 * ledger non-zero rows; no request leaves the machine.
 */

let capBefore = 0;
const IMAGE_PRICE = 0.04116;
const VOICE_PRICE = 0.00003;

const PLATFORM = profileFromPlatform("TIKTOK");
const make = (contentType: string, formatId: string, idea: string, durationSeconds: number, language = "vi") =>
  createContentProject({ contentType, formatId, sourceType: "PROMPT", idea, durationSeconds, language, voiceMode: "NARRATION", outputProfile: PLATFORM });
const scenesOf = (projectId: string) => prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
const roles = async (projectId: string) => {
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  return (JSON.parse(p.scriptJson ?? "{}").scenes ?? []).map((s: { sceneRole?: string }) => s.sceneRole);
};
const textJobs = (projectId: string) => prisma.providerJob.count({ where: { projectId, kind: "text" } });
const mediaJobs = (projectId: string) => prisma.providerJob.count({ where: { projectId, kind: { not: "text" } } });
const ledgerSum = async (where: object) =>
  Math.round(((await prisma.costEntry.aggregate({ where: { estimated: false, ...where }, _sum: { amount: true } }))._sum.amount ?? 0) * 1e6) / 1e6;
const usage = { inputTokens: null, outputTokens: null, durationMs: 0, actualCost: 0, model: "mock-text-1" };

/** What the real writer did on 2026-10-19: item 1 written out, the rest only named. */
function shortChanged(req: ContentScriptRequest) {
  const doc = writeMockContentScript(req);
  let seen = 0;
  return {
    ...doc,
    scenes: doc.scenes.map((s, i) => {
      if (req.beats[i]?.role !== "tip") return s;
      seen++;
      return seen === 1 ? s : { ...s, narration: "Mẹo.", subtitle: "Mẹo." };
    }),
  };
}

beforeAll(async () => {
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (capBefore > 0) await setSpendCap(capBefore);
});

describe("QĐ-141 — số mục yêu cầu (N items)", () => {
  it("đọc N từ yêu cầu (VI + EN), không ép N khi không có số", () => {
    expect(requestedItemsOf("3 mẹo nhỏ giúp làm việc hiệu quả hơn với AI")).toEqual({ count: 3, noun: "mẹo" });
    expect(requestedItemsOf("5 bước nấu phở")).toEqual({ count: 5, noun: "bước" });
    expect(requestedItemsOf("Top 7 loài vật thông minh")).toEqual({ count: 7, noun: "" });
    expect(requestedItemsOf("4 lợi ích của việc ngủ sớm")).toEqual({ count: 4, noun: "lợi ích" });
    expect(requestedItemsOf("6 sai lầm khi học tiếng Anh")).toEqual({ count: 6, noun: "sai lầm" });
    expect(requestedItemsOf("5 simple steps to sleep better")).toEqual({ count: 5, noun: "steps" });
    expect(requestedItemsOf("three tips for focus")).toEqual({ count: 3, noun: "tips" });
    expect(requestedItemsOf("ba mẹo nhỏ")).toEqual({ count: 3, noun: "mẹo" });
    // No count, or a measure rather than a list.
    for (const text of ["Mẹo ngủ ngon", "Vì sao bầu trời màu xanh?", "Video 30 giây về 5 năm làm việc", "ba mẹ có cách dạy con", "Review iPhone 15 Pro", "1 mẹo duy nhất", ""]) {
      expect(requestedItemsOf(text), text).toBeNull();
    }
  });

  it("planner: N cảnh mục bất kể thời lượng; không có N thì như cũ", () => {
    const tips = formatOf(templateOf("KNOWLEDGE"), "tips");
    const three = planScenes({ format: tips, durationSeconds: 12, itemCount: 3 });
    expect(three.filter((b) => b.role === "tip").map((b) => b.displayLabel)).toEqual(["Mẹo 1", "Mẹo 2", "Mẹo 3"]);
    // Before QĐ-141 this was the plan for "3 mẹo" in 12 s: one tip.
    expect(planScenes({ format: tips, durationSeconds: 12 }).filter((b) => b.role === "tip")).toHaveLength(1);
    // Too short for every scene at 2 s: the optional recap goes, no item does.
    const seven = planScenes({ format: tips, durationSeconds: 15, itemCount: 7 });
    expect(seven.filter((b) => b.role === "tip")).toHaveLength(7);
    expect(seven.some((b) => b.role === "recap")).toBe(false);
  });

  it("kiểm tra độ phủ: phát hiện đúng kịch bản 2026-10-19 (chỉ Mẹo 1, còn lại nhắc tên)", () => {
    const smoke = [
      { sceneNumber: 1, sceneRole: "hook", narration: "Bạn có biết AI có thể giúp công việc nhanh gấp đôi?" },
      { sceneNumber: 2, sceneRole: "tip", narration: "Mẹo 1: Đặt câu hỏi ngắn gọn, AI hiểu nhanh hơn." },
      { sceneNumber: 3, sceneRole: "recap", narration: "Ba mẹo: ngắn gọn, ưu tiên, tự động hoá." },
    ];
    const c = checkItemCoverage(smoke, 3, "tip");
    expect(c).toMatchObject({ requested: 3, covered: 1, missing: [2, 3], ok: false });
    expect(itemCoverageMessage(c, { count: 3, noun: "mẹo" })).toMatch(/3 mẹo.*chỉ triển khai rõ 1.*thiếu mẹo số 2, 3/);
    // A name alone, or the same line twice, is not an item.
    const thin = checkItemCoverage(
      [...smoke, { sceneNumber: 4, sceneRole: "tip", narration: "Mẹo 2." }, { sceneNumber: 5, sceneRole: "tip", narration: "Mẹo 1: Đặt câu hỏi ngắn gọn, AI hiểu nhanh hơn." }],
      3,
      "tip",
    );
    expect(thin).toMatchObject({ covered: 1, thin: [4, 5], ok: false });
  });

  it("“3 mẹo” 12 s → đủ 3 mẹo, mỗi mẹo một cảnh; duyệt được", async () => {
    const p = await make("KNOWLEDGE", "tips", "3 mẹo nhỏ giúp làm việc hiệu quả hơn với AI", 12);
    expect((await roles(p.id)).filter((r: string) => r === "tip")).toHaveLength(3);
    expect(p.errorMessage).toBeNull();
    expect(await textJobs(p.id)).toBe(1);
    await expect(approveContentScript(p.id)).resolves.toBeTruthy();
    expect(await mediaJobs(p.id)).toBe(0);
  });

  it("“5 bước” → đủ 5; “Top 7” → đủ 7; English “5 steps” → đủ 5", async () => {
    const five = await make("KNOWLEDGE", "explain", "5 bước học lập trình cho người mới", 30);
    expect((await roles(five.id)).filter((r: string) => r === "explain")).toHaveLength(5);
    const top = await make("ANIMAL_FACT", "top5", "Top 7 loài vật thông minh nhất", 30);
    expect((await roles(top.id)).filter((r: string) => r === "item")).toHaveLength(7);
    const en = await make("KNOWLEDGE", "tips", "5 simple steps to sleep better", 20, "en");
    expect((await roles(en.id)).filter((r: string) => r === "tip")).toHaveLength(5);
    for (const p of [five, top, en]) expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).errorMessage).toBeNull();
  });

  it("không yêu cầu số lượng → không ép N (giữ cách chia theo thời lượng)", async () => {
    const p = await make("KNOWLEDGE", "tips", "Mẹo ngủ ngon", 12);
    expect((await roles(p.id)).filter((r: string) => r === "tip")).toHaveLength(1);
    await expect(approveContentScript(p.id)).resolves.toBeTruthy();
  });

  it("writer thiếu mục → viết lại MỘT lần ở bước Text; sửa được thì không báo lỗi", async () => {
    const spy = vi.spyOn(MockTextProvider.prototype, "generateContentScript");
    spy.mockImplementationOnce(async (req) => ({ script: shortChanged(req), usage }));
    const p = await make("KNOWLEDGE", "tips", "3 mẹo nhỏ giúp làm việc hiệu quả hơn với AI", 12);
    spy.mockRestore();
    expect(await textJobs(p.id)).toBe(2);
    expect(p.errorMessage).toBeNull();
    const narr = (await scenesOf(p.id)).map((s) => s.narration);
    expect(narr.filter((n) => n === "Mẹo.")).toHaveLength(0);
    expect(await mediaJobs(p.id)).toBe(0);
  });

  it("vẫn thiếu sau khi viết lại → báo rõ mục thiếu, DUYỆT KỊCH BẢN bị chặn; sửa Storyboard thì duyệt được", async () => {
    const spy = vi.spyOn(MockTextProvider.prototype, "generateContentScript").mockImplementation(async (req) => ({ script: shortChanged(req), usage }));
    const p = await make("KNOWLEDGE", "tips", "3 mẹo nhỏ giúp làm việc hiệu quả hơn với AI", 12);
    spy.mockRestore();
    expect(await textJobs(p.id)).toBe(2); // first draft + exactly one rewrite
    expect(p.errorMessage).toMatch(/Yêu cầu có 3 mẹo.*chỉ triển khai rõ 1.*thiếu mẹo số 2, 3/);
    await expect(approveContentScript(p.id)).rejects.toMatchObject({ code: "ITEMS_MISSING" });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).scriptApprovedAt).toBeNull();

    // The person writes tips 2 and 3 out in the storyboard: no new text call, no media.
    const thin = (await scenesOf(p.id)).filter((s) => s.narration === "Mẹo.");
    const lines = ["Mẹo 2: Nói rõ việc nào cần làm trước để AI sắp xếp ưu tiên.", "Mẹo 3: Giao các việc lặp lại cho AI tự động hoá hằng ngày."];
    for (const [i, s] of thin.entries()) await prisma.scene.update({ where: { id: s.id }, data: { narration: lines[i]!, subtitle: lines[i]! } });
    await expect(approveContentScript(p.id)).resolves.toBeTruthy();
    const after = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.errorMessage).toBeNull();
    expect(after.scriptApprovedAt).not.toBeNull();
    expect(await textJobs(p.id)).toBe(2);
    expect(await mediaJobs(p.id)).toBe(0);
  });
});

describe("QĐ-141 — chi phí cảnh / dự án khớp sổ chi", () => {
  let projectId = "";
  let batchId = "";
  let approvedEstimate = 0;

  beforeAll(async () => {
    // Give the mock result a price so the ledger rows are non-zero.
    const img = MockImageProvider.prototype.downloadResult;
    vi.spyOn(MockImageProvider.prototype, "downloadResult").mockImplementation(async function (this: MockImageProvider, id: string) {
      return { ...(await img.call(this, id)), actualCost: IMAGE_PRICE };
    });
    const voice = MockVoiceProvider.prototype.downloadResult;
    vi.spyOn(MockVoiceProvider.prototype, "downloadResult").mockImplementation(async function (this: MockVoiceProvider, id: string) {
      return { ...(await voice.call(this, id)), actualCost: VOICE_PRICE };
    });

    const p = await make("KNOWLEDGE", "tips", "2 mẹo kiểm tra chi phí cảnh", 12);
    projectId = p.id;
    for (const s of await scenesOf(projectId)) {
      await prisma.scene.update({ where: { id: s.id }, data: { motionMode: "LOCAL_MOTION", motionSource: "LOCAL_MOTION" } });
    }
    await approveContentScript(projectId);
    const started = await startMediaGeneration(projectId);
    batchId = started.batchId!;
    approvedEstimate = (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).estimatedCost;
    await approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe("completed");
  }, 600_000);

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("Scene.actualCost = tổng sổ chi của cảnh (ảnh + giọng), khớp sceneActualCosts", async () => {
    const paid = await sceneActualCosts(projectId);
    const scenes = await scenesOf(projectId);
    expect(scenes.length).toBeGreaterThanOrEqual(3);
    for (const s of scenes) {
      const expected = await ledgerSum({ sceneId: s.id });
      expect(expected).toBeCloseTo(IMAGE_PRICE + VOICE_PRICE, 6);
      expect(s.actualCost).toBeCloseTo(expected, 6);
      expect(paid.get(s.id)).toBeCloseTo(expected, 6);
    }
  });

  it("Project.actualCost = tổng sổ chi; Project.estimatedCost giữ dự toán đã duyệt (không về 0)", async () => {
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(p.actualCost).toBeCloseTo(await ledgerSum({ projectId }), 6);
    const sceneTotal = (await scenesOf(projectId)).reduce((n, s) => n + s.actualCost, 0);
    expect(p.actualCost).toBeCloseTo(sceneTotal + (await ledgerSum({ projectId, sceneId: null })), 6);
    expect(approvedEstimate).toBeGreaterThan(0);
    expect(p.estimatedCost).toBe(approvedEstimate);
    // The batch page's per-video resume panel runs a preflight on every poll:
    // after the run it prices $0 still to buy, which used to overwrite both.
    const batchEstimate = (await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).estimatedCost;
    await buildBatchResumePlans(batchId);
    await buildBatchResumePlans(batchId);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).estimatedCost).toBe(approvedEstimate);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).estimatedCost).toBe(batchEstimate);
    const auth = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
    expect(auth.estimatedCost).toBeGreaterThan(0);
  });

  it("TIẾP TỤC và RENDER LẠI không cộng thêm đồng nào", async () => {
    const before = { rows: await prisma.costEntry.count({ where: { projectId } }), project: await ledgerSum({ projectId }), scenes: (await scenesOf(projectId)).map((s) => s.actualCost) };
    await continueVideo(projectId, { wait: true });
    await renderProjectNow(projectId);
    expect(await prisma.costEntry.count({ where: { projectId } })).toBe(before.rows);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(p.actualCost).toBeCloseTo(before.project, 6);
    expect((await scenesOf(projectId)).map((s) => s.actualCost)).toEqual(before.scenes);
  }, 300_000);

  it("đồng bộ lại nhiều lần không nhân đôi; dòng dự toán (estimated) không tính", async () => {
    const [s] = await scenesOf(projectId);
    const once = s!.actualCost;
    expect(await syncSceneActualCost(s!.id)).toBeCloseTo(once, 6);
    expect(await syncSceneActualCost(s!.id)).toBeCloseTo(once, 6);
    const projectBefore = await syncProjectActualCost(projectId);
    await recordCost({ projectId, sceneId: s!.id, category: "image", provider: "mock", model: "mock-image-fast", amount: 9, estimated: true });
    expect((await prisma.scene.findUniqueOrThrow({ where: { id: s!.id } })).actualCost).toBeCloseTo(once, 6);
    expect(await syncProjectActualCost(projectId)).toBeCloseTo(projectBefore, 6);
  });

  it("tiền giữ chỗ / huỷ / thất bại không chảy vào tổng cảnh hay dự án", async () => {
    const [s] = await scenesOf(projectId);
    const before = { scene: s!.actualCost, project: (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).actualCost };
    const base = { batchId, projectId, sceneId: s!.id, kind: "image", provider: "mock", model: "mock-image-fast", estimatedCost: 0.05 };
    await reserve({ ...base, idempotencyKey: `qd141-released-${s!.id}` }, 100);
    await reserve({ ...base, idempotencyKey: `qd141-billed-${s!.id}` }, 100);
    await syncSceneActualCost(s!.id);
    expect((await prisma.scene.findUniqueOrThrow({ where: { id: s!.id } })).actualCost).toBeCloseTo(before.scene, 6); // RESERVED
    await release(`qd141-released-${s!.id}`, { billed: false }); // cancelled: nothing billed
    await release(`qd141-billed-${s!.id}`, { billed: true, actualCost: 0.05 }); // failed but billed: the batch hold
    await syncSceneActualCost(s!.id);
    await syncProjectActualCost(projectId);
    expect((await prisma.scene.findUniqueOrThrow({ where: { id: s!.id } })).actualCost).toBeCloseTo(before.scene, 6);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).actualCost).toBeCloseTo(before.project, 6);
    // A billed attempt recorded in the ledger (a retry) is real money: it counts, once.
    await recordCost({ projectId, sceneId: s!.id, category: "image", provider: "mock", model: "mock-image-fast", amount: 0.01, isRetry: true });
    expect((await prisma.scene.findUniqueOrThrow({ where: { id: s!.id } })).actualCost).toBeCloseTo(before.scene + 0.01, 6);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).actualCost).toBeCloseTo(before.project + 0.01, 6);
  });

  it("dùng lại asset (GLOBAL) → video thứ hai không thêm chi phí media; cảnh = $0", async () => {
    const scope = process.env.ASSET_REUSE_SCOPE;
    process.env.ASSET_REUSE_SCOPE = "GLOBAL";
    try {
      const b = await make("KNOWLEDGE", "tips", "2 mẹo kiểm tra chi phí cảnh", 12);
      for (const s of await scenesOf(b.id)) {
        await prisma.scene.update({ where: { id: s.id }, data: { motionMode: "LOCAL_MOTION", motionSource: "LOCAL_MOTION" } });
      }
      await approveContentScript(b.id);
      const started = await startMediaGeneration(b.id);
      await approveAndRun({ batchId: started.batchId!, maxBatch: 5, lowAutoApproved: true, wait: true });
      expect((await prisma.project.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("completed");
      const reused = await prisma.asset.count({ where: { projectId: b.id, source: "REUSED" } });
      expect(reused).toBeGreaterThan(0);
      expect(await ledgerSum({ projectId: b.id, category: { in: ["image", "voice", "video"] } })).toBe(0);
      for (const s of await scenesOf(b.id)) expect(s.actualCost).toBe(0);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: b.id } })).actualCost).toBeCloseTo(await ledgerSum({ projectId: b.id }), 6);
    } finally {
      process.env.ASSET_REUSE_SCOPE = scope;
    }
  }, 600_000);
});
