import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { ffmpeg } from "@/media/ffmpeg";
import { saveSettings } from "@/lib/settings";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { assertBatchAuthorized, BatchAuthorizationError } from "@/services/batch-authorization";
import { approveAndRun, preflightForApproval, resumeRun } from "@/services/batch-executor";

/**
 * The money gate in front of every paid POST, on the real ledger (V1.2 Phase 2,
 * QĐ-108). $0: the gate only reads and writes reservations - no provider is
 * contacted, and amounts here are synthetic figures handed straight to it.
 *
 * Cases B, C, F, K, L, M, N at the gate; E, G, I, J, O, P, Q and the 4-video QA
 * through preflight + DUYỆT & CHẠY on mock providers.
 */

let tmp = "";
let PNG: Buffer;

async function seedMock(): Promise<void> {
  for (const provider of SEED_PROVIDERS.filter((p) => p.name === "mock")) {
    await prisma.providerConfig.upsert({
      where: { name: provider.name },
      create: { ...provider, types: JSON.stringify(provider.types), status: "connected" },
      update: { enabled: true, status: "connected" },
    });
  }
  for (const model of SEED_MODELS.filter((m) => m.provider === "mock")) {
    await prisma.modelRegistry.upsert({
      where: { provider_modelId: { provider: model.provider, modelId: model.modelId } },
      create: model,
      update: { enabled: true },
    });
  }
  for (const preset of SEED_STYLE_PRESETS) {
    await prisma.stylePreset.upsert({ where: { slug: preset.slug }, create: { ...preset, aspectRatio: "9:16" }, update: {} });
  }
  for (const character of SEED_CHARACTERS) {
    await prisma.character.upsert({
      where: { name: character.name },
      create: { ...character, voiceProvider: "mock", enabled: true },
      update: {},
    });
  }
}

interface VideoSpec {
  id: string;
  title: string;
  scenes: { spoken: boolean; maxCost?: number; motion?: string }[];
  maxCost?: number;
}

/** One folder, several storyboards, one batch - the way an operator imports. */
async function importBatch(name: string, videos: VideoSpec[], perVideo = 5): Promise<{ batchId: string; ids: Record<string, string> }> {
  const root = path.join(tmp, name);
  for (const v of videos) {
    const dir = path.join(root, v.id);
    fs.mkdirSync(dir, { recursive: true });
    const scenes = v.scenes.map((s, i) => {
      fs.writeFileSync(path.join(dir, `s${i + 1}.png`), PNG);
      return {
        scene_number: i + 1,
        duration: 3,
        visual_description: `Max against a plain wall, shot ${i + 1}.`,
        character_action: "Max holds still.",
        camera: "Locked static medium shot, no camera movement.",
        dialogue: s.spoken ? `Max: "Line ${i + 1} of ${v.id}."` : "",
        subtitle: s.spoken ? `Line ${i + 1}.` : "",
        image_file: `s${i + 1}.png`,
        motion_mode: s.motion ?? "LOCAL_MOTION",
        priority: "LOW",
        ...(s.maxCost !== undefined ? { max_cost: s.maxCost } : {}),
      };
    });
    fs.writeFileSync(
      path.join(dir, "storyboard.json"),
      JSON.stringify({
        video_id: `${name}-${v.id}`,
        video_title: v.title,
        ...(v.maxCost !== undefined ? { max_cost: v.maxCost } : {}),
        characters: [{ character_id: "max", character_name: "Max" }],
        scenes,
      }),
    );
  }
  const validated = await validateImport(scanImportSource(root));
  expect(validated.issues.filter((i) => i.level === "error")).toEqual([]);
  const created = await materialiseImport(validated, { batchName: name, maxCostPerVideo: perVideo, maxCostForBatch: 50 });
  const ids: Record<string, string> = {};
  for (const p of created.projects) ids[p.title] = p.projectId;
  return { batchId: created.batchId, ids };
}

/**
 * Headroom of exactly `remaining` above what is spent AND held: the gate counts
 * money reserved for requests in flight against the global cap too.
 */
async function setRemaining(remaining: number): Promise<void> {
  const held = (await prisma.costReservation.aggregate({ where: { status: "RESERVED" }, _sum: { estimatedCost: true } }))._sum.estimatedCost ?? 0;
  await setSpendCap(Math.round(((await spendStatus()).spent + held + remaining) * 1e6) / 1e6);
}

async function approveRaw(batchId: string, max: number, perVideo = 5): Promise<void> {
  await prisma.batchAuthorization.update({
    where: { batchId },
    data: { status: "APPROVED", authorizedMaxSpend: max, maxCostPerVideo: perVideo, providerScopeJson: "[]", approvedAt: new Date() },
  });
}

async function firstScene(projectId: string, n = 1) {
  return prisma.scene.findFirstOrThrow({ where: { projectId, sceneNumber: n } });
}

function gate(batchId: string, projectId: string, sceneId: string, cost: number) {
  return assertBatchAuthorized({
    batchId,
    projectId,
    sceneId,
    kind: "video",
    provider: "mock",
    model: "mock-video",
    estimatedCost: cost,
    idempotencyKey: `test-${randomUUID()}`,
  });
}

const reservations = (batchId: string) => prisma.costReservation.count({ where: { batchId } });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spend-limits-"));
  const file = path.join(tmp, "k.png");
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=1080x1920", "-frames:v", "1", file]);
  PNG = fs.readFileSync(file);
  await setSpendCap(50);
  await seedMock();
}, 120_000);

afterAll(async () => {
  // The synthetic holds made straight at the gate never had a request behind
  // them; release them so no other test file sees money "in flight".
  await prisma.costReservation.updateMany({ where: { idempotencyKey: { startsWith: "test-" }, status: "RESERVED" }, data: { status: "RELEASED" } });
  await saveSettings({ defaultMaxCostVideoAiScene: null });
  await setSpendCap(50);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("cổng trước mỗi POST trả phí — bốn tầng, trong khoá reservation", () => {
  it("B. trần cảnh $0.30 (storyboard max_cost), clip $0.40 -> SCENE_LIMIT_EXCEEDED, không giữ chỗ", async () => {
    const { batchId, ids } = await importBatch("gate-b", [
      { id: "a", title: "B-A", scenes: [{ spoken: false, maxCost: 0.3, motion: "VIDEO_AI" }] },
    ]);
    await setRemaining(5);
    await approveRaw(batchId, 2);
    const scene = await firstScene(ids["B-A"]!);
    expect(scene.maxCost).toBe(0.3);
    const err = await gate(batchId, ids["B-A"]!, scene.id, 0.4).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BatchAuthorizationError);
    expect((err as BatchAuthorizationError).code).toBe("over_scene_budget");
    expect((err as BatchAuthorizationError).verdict?.reasonCode).toBe("SCENE_LIMIT_EXCEEDED");
    expect((err as BatchAuthorizationError).verdict?.overBy).toBeCloseTo(0.1, 6);
    expect(await reservations(batchId)).toBe(0);
  });

  it("B'. không có max_cost cảnh -> dùng mặc định Settings cho cảnh VIDEO_AI; cảnh LOCAL_MOTION không bị áp", async () => {
    const { batchId, ids } = await importBatch("gate-b2", [
      { id: "a", title: "B2-A", scenes: [{ spoken: false, motion: "VIDEO_AI" }, { spoken: false }] },
    ]);
    await setRemaining(5);
    await approveRaw(batchId, 2);
    await saveSettings({ defaultMaxCostVideoAiScene: 0.3 });
    try {
      const ai = await firstScene(ids["B2-A"]!, 1);
      const local = await firstScene(ids["B2-A"]!, 2);
      await expect(gate(batchId, ids["B2-A"]!, ai.id, 0.4)).rejects.toMatchObject({ code: "over_scene_budget" });
      await expect(gate(batchId, ids["B2-A"]!, local.id, 0.4)).resolves.toMatchObject({ reused: false });
    } finally {
      await saveSettings({ defaultMaxCostVideoAiScene: null });
    }
  });

  it("C. trần riêng video $0.60 (storyboard max_cost), tổng $0.70 -> VIDEO_LIMIT_EXCEEDED ở request thứ hai", async () => {
    const { batchId, ids } = await importBatch("gate-c", [
      { id: "a", title: "C-A", maxCost: 0.6, scenes: [{ spoken: false }, { spoken: false }] },
    ]);
    await setRemaining(5);
    await approveRaw(batchId, 2, 5);
    const p = ids["C-A"]!;
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p } })).maxBudget).toBe(0.6);
    await gate(batchId, p, (await firstScene(p, 1)).id, 0.4);
    const err = await gate(batchId, p, (await firstScene(p, 2)).id, 0.3).catch((e: unknown) => e);
    expect((err as BatchAuthorizationError).verdict?.reasonCode).toBe("VIDEO_LIMIT_EXCEEDED");
    expect((err as BatchAuthorizationError).verdict?.message).toContain("vượt giới hạn video $0.10");
    expect(await reservations(batchId)).toBe(1);
  });

  it("F. toàn cục còn $0.30, clip $0.40 -> GLOBAL_LIMIT_EXCEEDED, không giữ chỗ", async () => {
    const { batchId, ids } = await importBatch("gate-f", [{ id: "a", title: "F-A", scenes: [{ spoken: false }] }]);
    await setRemaining(5);
    await approveRaw(batchId, 2);
    await setRemaining(0.3);
    const err = await gate(batchId, ids["F-A"]!, (await firstScene(ids["F-A"]!)).id, 0.4).catch((e: unknown) => e);
    expect((err as BatchAuthorizationError).verdict?.reasonCode).toBe("GLOBAL_LIMIT_EXCEEDED");
    expect(await reservations(batchId)).toBe(0);
  });

  it("L. TOCTOU: duyệt xong, hạn mức bị hạ trước khi gửi -> cổng đọc lại và chặn trước POST", async () => {
    const { batchId, ids } = await importBatch("gate-l", [{ id: "a", title: "L-A", scenes: [{ spoken: false }] }]);
    await setRemaining(5);
    await approveRaw(batchId, 1);
    // ... then, between approval and execution, the global limit changes.
    await setRemaining(0.1);
    await expect(gate(batchId, ids["L-A"]!, (await firstScene(ids["L-A"]!)).id, 0.4)).rejects.toMatchObject({
      code: "global_cap",
    });
    expect(await reservations(batchId)).toBe(0);
  });

  it("K. hai worker tranh $0.50 của lô, mỗi request $0.40 -> đúng MỘT giữ chỗ, không bao giờ $0.80", async () => {
    const { batchId, ids } = await importBatch("gate-k", [
      { id: "a", title: "K-A", scenes: [{ spoken: false }] },
      { id: "b", title: "K-B", scenes: [{ spoken: false }] },
    ]);
    await setRemaining(5);
    await approveRaw(batchId, 0.5);
    const [a, b] = await Promise.allSettled([
      gate(batchId, ids["K-A"]!, (await firstScene(ids["K-A"]!)).id, 0.4),
      gate(batchId, ids["K-B"]!, (await firstScene(ids["K-B"]!)).id, 0.4),
    ]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const held = await prisma.costReservation.aggregate({ where: { batchId, status: "RESERVED" }, _sum: { estimatedCost: true } });
    expect(held._sum.estimatedCost).toBeCloseTo(0.4, 6);
  });

  it("K'. hai worker CÙNG một video (trần $0.50), mỗi request $0.40 -> đúng một (trước đây kiểm ngoài khoá)", async () => {
    const { batchId, ids } = await importBatch("gate-k2", [
      { id: "a", title: "K2-A", maxCost: 0.5, scenes: [{ spoken: false }, { spoken: false }] },
    ]);
    await setRemaining(5);
    await approveRaw(batchId, 5);
    const p = ids["K2-A"]!;
    const results = await Promise.allSettled([
      gate(batchId, p, (await firstScene(p, 1)).id, 0.4),
      gate(batchId, p, (await firstScene(p, 2)).id, 0.4),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as BatchAuthorizationError).verdict?.reasonCode).toBe("VIDEO_LIMIT_EXCEEDED");
  });

  it("K''. hai LÔ tranh $0.50 cuối của hạn mức toàn cục -> đúng một (tiền đang giữ chỗ được tính)", async () => {
    const one = await importBatch("gate-k3a", [{ id: "a", title: "K3-A", scenes: [{ spoken: false }] }]);
    const two = await importBatch("gate-k3b", [{ id: "a", title: "K3-B", scenes: [{ spoken: false }] }]);
    await setRemaining(5);
    await approveRaw(one.batchId, 2);
    await approveRaw(two.batchId, 2);
    await setRemaining(0.5);
    const results = await Promise.allSettled([
      gate(one.batchId, one.ids["K3-A"]!, (await firstScene(one.ids["K3-A"]!)).id, 0.4),
      gate(two.batchId, two.ids["K3-B"]!, (await firstScene(two.ids["K3-B"]!)).id, 0.4),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as BatchAuthorizationError).verdict?.reasonCode).toBe("GLOBAL_LIMIT_EXCEEDED");
    // Settle the synthetic hold so it does not linger in the shared test ledger.
    await prisma.costReservation.updateMany({ where: { batchId: { in: [one.batchId, two.batchId] }, status: "RESERVED" }, data: { status: "RELEASED" } });
    await setRemaining(5);
  });
});

describe("chạy một phần lô — mock, không POST thật", () => {
  it("17 + E + G + M + N + O: A PASS, B vượt trần video, C PASS, D toàn REUSE $0; trần lô cắt đúng thứ tự", async () => {
    await setRemaining(5);
    // D has no voice and no paid asset: every picture is imported, LOCAL_MOTION.
    const { batchId, ids } = await importBatch("qa4", [
      { id: "a", title: "Video A", scenes: [{ spoken: true }, { spoken: true }] },
      { id: "b", title: "Video B", scenes: [{ spoken: true }, { spoken: true }, { spoken: true }] },
      { id: "c", title: "Video C", scenes: [{ spoken: true }] },
      { id: "d", title: "Video D", scenes: [{ spoken: false }, { spoken: false }] },
    ]);
    const free = await preflightForApproval(batchId);
    const cost = Object.fromEntries(free.spendPlan!.videos.map((v) => [v.title, v.incrementalCost]));
    expect(cost["Video A"]).toBeGreaterThan(0);
    expect(cost["Video D"]).toBe(0);

    // B's own limit below its estimate; D's own limit tiny - it needs nothing.
    await prisma.project.update({ where: { id: ids["Video B"]! }, data: { maxBudget: cost["Video B"]! / 2 } });
    await prisma.project.update({ where: { id: ids["Video D"]! }, data: { maxBudget: 0.1 } });
    const batchLimit = Math.round((cost["Video A"]! + cost["Video C"]! + 1e-6) * 1e6) / 1e6;

    const pre = await preflightForApproval(batchId, { maxBatch: batchLimit });
    const plan = pre.spendPlan!;
    expect(plan.runnable.map((v) => v.title)).toEqual(["Video A", "Video C", "Video D"]);
    expect(plan.blocked.map((v) => [v.title, v.verdict.reasonCode])).toEqual([["Video B", "VIDEO_LIMIT_EXCEEDED"]]);
    expect(plan.blocked[0]!.verdict.message).toMatch(/Video B vượt giới hạn video \$[\d.]+ — dự toán \$[\d.]+, giới hạn \$[\d.]+\./);
    expect(pre.estimatedTotal).toBeCloseTo(cost["Video A"]! + cost["Video C"]!, 6);
    expect(pre.runnableVideos).toBe(3);
    expect(pre.blockedVideos).toBe(1);
    expect(pre.ready).toBe(true);

    await approveAndRun({ batchId, maxBatch: batchLimit, lowAutoApproved: false, wait: true });
    const status = async (t: string) => (await prisma.project.findUniqueOrThrow({ where: { id: ids[t]! } })).status;
    expect(await status("Video A")).toBe("completed");
    expect(await status("Video C")).toBe("completed");
    expect(await status("Video D")).toBe("completed");
    expect(await status("Video B")).not.toBe("completed");
    // M / N: the blocked video made no ProviderJob and holds no reservation.
    expect(await prisma.providerJob.count({ where: { projectId: ids["Video B"]! } })).toBe(0);
    expect(await prisma.costReservation.count({ where: { projectId: ids["Video B"]! } })).toBe(0);
    // Hard invariant: actual <= authorised.
    const spent = await prisma.costReservation.aggregate({ where: { batchId, status: { not: "RELEASED" } }, _sum: { actualCost: true, estimatedCost: true } });
    expect(spent._sum.actualCost ?? 0).toBeLessThanOrEqual(batchLimit + 1e-9);
    expect(await prisma.costReservation.count({ where: { batchId, status: "RESERVED" } })).toBe(0);
  });

  it("E. trần lô vừa MỘT video: video đầu hàng đợi chạy, video sau BATCH_LIMIT_EXCEEDED và không chạy", async () => {
    await setRemaining(5);
    const { batchId, ids } = await importBatch("e-cut", [
      { id: "a", title: "E-A", scenes: [{ spoken: true }] },
      { id: "b", title: "E-B", scenes: [{ spoken: true }] },
    ]);
    const free = await preflightForApproval(batchId);
    const one = free.spendPlan!.videos.find((v) => v.title === "E-A")!.incrementalCost;
    // 1.5x A: room for the small gap between the preflight estimate and the
    // live reservation (the UI proposes +10%), still less than A + B.
    const cap = Math.round(one * 1.5 * 1e6) / 1e6;
    const pre = await preflightForApproval(batchId, { maxBatch: cap });
    expect(pre.spendPlan!.runnable.map((v) => v.title)).toEqual(["E-A"]);
    expect(pre.spendPlan!.blocked[0]!.verdict.reasonCode).toBe("BATCH_LIMIT_EXCEEDED");
    await approveAndRun({ batchId, maxBatch: cap, lowAutoApproved: false, wait: true });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: ids["E-A"]! } })).status).toBe("completed");
    expect(await prisma.providerJob.count({ where: { projectId: ids["E-B"]! } })).toBe(0);
    // Resume on the same approval still does not start the video it did not cover.
    await resumeRun({ batchId, wait: true });
    expect(await prisma.providerJob.count({ where: { projectId: ids["E-B"]! } })).toBe(0);
  });

  it("I + J. resume chỉ tính phần còn thiếu: thiếu 1 giọng -> đúng giá 1 giọng; đã đủ -> $0", async () => {
    await setRemaining(5);
    const { batchId, ids } = await importBatch("resume-i", [{ id: "a", title: "I-A", scenes: [{ spoken: true }, { spoken: true }] }]);
    await approveAndRun({ batchId, maxBatch: 1, lowAutoApproved: false, wait: true });
    const p = ids["I-A"]!;
    const whole = (await prisma.costReservation.aggregate({ where: { projectId: p, status: "COMMITTED" }, _sum: { estimatedCost: true } }))._sum.estimatedCost ?? 0;
    expect(whole).toBeGreaterThan(0);

    // J. Completed: nothing is missing, so the resume needs $0.
    const done = await preflightForApproval(batchId, { resume: true });
    expect(done.estimatedTotal).toBe(0);

    // I. One voice missing (as if its file was never produced): only that voice is priced.
    const line = await prisma.dialogueLine.findFirstOrThrow({ where: { scene: { projectId: p } }, orderBy: { lineNumber: "asc" } });
    await prisma.dialogueLine.update({ where: { id: line.id }, data: { status: "pending", outputPath: "" } });
    await prisma.scene.update({ where: { id: line.sceneId }, data: { audioPath: null, status: "image_ready" } });
    await prisma.project.update({ where: { id: p }, data: { status: "media_generating" } });
    const partial = await preflightForApproval(batchId, { resume: true });
    expect(partial.estimatedTotal).toBeGreaterThan(0);
    expect(partial.estimatedTotal).toBeLessThan(whole);
    expect(partial.voicePosts).toBe(1);
    expect(partial.imagePosts).toBe(0);
    expect(partial.videoPosts).toBe(0);
  });

  it("P + Q. không có max_cost -> trần/video của form (mặc định Settings); storyboard V1.1 cũ vẫn nhập được", async () => {
    const { ids } = await importBatch("p-default", [{ id: "a", title: "P-A", scenes: [{ spoken: false }] }], 1.5);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: ids["P-A"]! } });
    expect(p.maxBudget).toBe(1.5);
    expect((await firstScene(p.id)).maxCost).toBeNull();

    const old = await validateImport(scanImportSource(path.join(process.cwd(), "examples", "storyboard-import-5")));
    expect(old.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(old.videos[0]!.maxCost).toBeNull();
    expect(old.videos[0]!.scenes.every((s) => s.scene.maxCost === null)).toBe(true);
  });
});
