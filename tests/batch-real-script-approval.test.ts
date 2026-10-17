import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/utils";
import type { StoredCreativeStyle } from "@/domain/creative-style";
import { approveAuthorization, createAuthorization } from "@/services/batch-authorization";
import { planBatch } from "@/services/batch-planner";
import { savePlan } from "@/services/batch-runner";
import { writeIdiomScripts } from "@/services/batch-sources";
import { approveAndRun, needsReapproval, preflightForApproval, runBatch } from "@/services/batch-executor";
import { frozenFromNote } from "@/services/frozen-video";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { seedMock } from "./phase5-helpers";

/**
 * QĐ-139 - an idiom batch is approved against its REAL scripts, never a sample.
 *
 * UAT 2026-10-17: a Professional batch was approved on the reference profile
 * (1 AI scene, one model); the real scripts routed 3 AI scenes and a hook on
 * another model, so every video stopped at scene 1 (APPROVED_MODEL_MISSING) and
 * the estimate was ~6x low. Now: plan → real scripts (Text AI only) → the
 * preflight prices each real scene through the router → approve → the run buys
 * exactly what was approved. Mock only: no paid request of any kind.
 */

const TIKTOK: Partial<StoredCreativeStyle> = { preset: "TIKTOK_FUNNY", comedyLevel: 4, pacingStyle: "FAST", punchlineMode: "REQUIRED" };
const PRO: Partial<StoredCreativeStyle> = { preset: "PROFESSIONAL", comedyLevel: 0, pacingStyle: "MEDIUM", punchlineMode: "NONE" };

const tag = Math.random().toString(36).slice(2, 7);
let capBefore = 0;

async function idioms(phrases: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const phrase of phrases) {
    const idiom = await prisma.idiom.create({
      data: {
        phrase: `${phrase} ${tag}`,
        slug: slugify(`${phrase}-qd139-${tag}`),
        meaning: `the meaning of ${phrase}`,
        literalMeaning: `${phrase}, taken word for word`,
        exampleSentence: `I said "${phrase}" today.`,
        category: "test-qd139",
      },
    });
    ids.push(idiom.id);
  }
  return ids;
}

async function plannedBatch(name: string, style: Partial<StoredCreativeStyle>, phrases: string[]): Promise<string> {
  const ids = await idioms(phrases);
  const creativeStyle = { version: "creative-v1", preset: "AUTO", ...style } as StoredCreativeStyle;
  const batch = await prisma.batch.create({
    data: { name, amount: ids.length, qualityMode: "BALANCED", targetDuration: 25, maxCostPerVideo: 5, maxBudget: 0, status: "PLANNED" },
  });
  const plan = await planBatch(
    { idiomIds: ids, amount: ids.length, qualityMode: "BALANCED", targetDuration: 25, maxCostPerVideo: 5, creativeStyle },
    batch.id,
  );
  await savePlan(batch.id, plan);
  await createAuthorization({
    batchId: batch.id,
    estimatedCost: plan.estimatedTotal,
    maxCostPerVideo: 5,
    providerScope: plan.providerScope,
    videoCount: plan.runnableCount,
    qualityMode: "BALANCED",
  });
  return batch.id;
}

const projectIds = async (batchId: string) =>
  (await prisma.project.findMany({ where: { batchId }, select: { id: true } })).map((p) => p.id);
const mediaJobs = async (batchId: string) =>
  prisma.providerJob.count({ where: { projectId: { in: await projectIds(batchId) }, kind: { in: ["image", "video", "voice"] } } });

/** Scripts first, then the preflight on the real rows, then approve and run. */
async function scriptsThenRun(batchId: string) {
  const sample = await preflightForApproval(batchId);
  expect(sample.ready).toBe(false);
  expect(sample.checks.find((c) => !c.ok && c.blocking)?.detail).toMatch(/SCRIPTS_REQUIRED/);
  await expect(approveAndRun({ batchId, maxBatch: 10, lowAutoApproved: true })).rejects.toThrow(/SCRIPTS_REQUIRED/);
  expect(await prisma.project.count({ where: { batchId } })).toBe(0);

  const written = await writeIdiomScripts(batchId);
  expect(written.failed).toEqual([]);
  expect(await mediaJobs(batchId)).toBe(0);
  expect((await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } })).status).toBe("DRAFT");

  const pre = await preflightForApproval(batchId);
  expect(pre.ready).toBe(true);
  expect(pre.preflight?.videos).toHaveLength(written.written);
  // The models approved are exactly the models the real scenes route to.
  const buying = pre.preflight!.videos.flatMap((v) => v.scenes.filter((sc) => sc.plan.video === "BUY"));
  const routed = [...new Set(buying.map((sc) => `${sc.videoRoute!.provider}/${sc.videoRoute!.model}`))].sort();
  expect([...pre.plannedVideoModels].sort()).toEqual(
    [...new Set(buying.map((sc) => sc.videoModel).filter(Boolean) as string[])].sort(),
  );

  const { run } = await approveAndRun({
    batchId,
    maxBatch: Math.max(0.01, pre.estimatedTotal * 1.5),
    lowAutoApproved: true,
    expectedVideoModels: pre.plannedVideoModels,
    wait: true,
  });
  return { pre, run: run!, buying, routed, written };
}

beforeAll(async () => {
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
}, 120_000);

afterAll(async () => {
  await setSpendCap(capBefore);
});

describe("QĐ-139 — duyệt chi theo kịch bản thật", () => {
  it("lô Chuyên nghiệp: viết kịch bản thật → preflight từng cảnh → duyệt → chạy xong, không APPROVED_MODEL_MISSING", async () => {
    const batchId = await plannedBatch(`QĐ-139 pro ${tag}`, PRO, ["Hit the books", "Under the weather", "Hold your horses"]);
    const { pre, run, buying, routed, written } = await scriptsThenRun(batchId);
    expect(written.written).toBe(3);

    // Every clip the approval covers is frozen with the route it was priced on.
    const auth = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
    const frozen = frozenFromNote(auth.note)!;
    for (const sc of buying) expect(frozen[sc.sceneId!]).toMatchObject({ provider: sc.videoRoute!.provider, model: sc.videoRoute!.model });

    expect(run.outcomes).toHaveLength(3);
    for (const o of run.outcomes) {
      expect(o.stopped).toBe("");
      expect(fs.existsSync(path.join(o.outputDir!, "final.mp4"))).toBe(true);
    }
    expect(run.settledStatus).toBe("COMPLETED");
    // The clips bought are exactly the approved routes - none other, none extra.
    const clips = await prisma.providerJob.findMany({
      where: { projectId: { in: await projectIds(batchId) }, kind: "video", status: "completed" },
      select: { provider: true, model: true },
    });
    expect(clips).toHaveLength(buying.length);
    for (const c of clips) expect(routed).toContain(`${c.provider}/${c.model}`);
    // One number: the batch shows what the approval priced.
    expect(pre.estimatedTotal).toBeGreaterThan(0);
  }, 900_000);

  it("viết kịch bản lần hai: giữ kịch bản cũ, không gọi Text AI lại", async () => {
    const batchId = await plannedBatch(`QĐ-139 again ${tag}`, PRO, ["Break the ice"]);
    await writeIdiomScripts(batchId);
    const text = await prisma.providerJob.count({ where: { projectId: { in: await projectIds(batchId) }, kind: "text" } });
    const again = await writeIdiomScripts(batchId);
    expect(again).toMatchObject({ written: 0, kept: 1, failed: [] });
    expect(await prisma.project.count({ where: { batchId } })).toBe(1);
    expect(await prisma.providerJob.count({ where: { projectId: { in: await projectIds(batchId) }, kind: "text" } })).toBe(text);
  }, 300_000);

  it("không viết kịch bản khi quyền chi đã duyệt", async () => {
    const batchId = await plannedBatch(`QĐ-139 approved ${tag}`, PRO, ["Call it a day"]);
    await approveAuthorization({ batchId, authorizedMaxSpend: 1 });
    await expect(writeIdiomScripts(batchId)).rejects.toThrow(/DRAFT/);
  });

  it("lô TikTok (hồi quy): cùng luồng, 8 cảnh/video, chạy xong", async () => {
    const batchId = await plannedBatch(`QĐ-139 tiktok ${tag}`, TIKTOK, ["Piece of cake", "Spill the beans"]);
    const { run } = await scriptsThenRun(batchId);
    expect(run.outcomes.map((o) => o.stopped)).toEqual(["", ""]);
    const scenes = await prisma.scene.groupBy({ by: ["projectId"], where: { projectId: { in: await projectIds(batchId) } }, _count: true });
    for (const g of scenes) expect(g._count).toBe(8);
  }, 900_000);

  it("chạy muốn model chưa duyệt → dừng trước POST, video chờ duyệt lại (không FAILED cả lô)", async () => {
    const batchId = await plannedBatch(`QĐ-139 reapprove ${tag}`, PRO, ["Once in a blue moon"]);
    await writeIdiomScripts(batchId);
    const pre = await preflightForApproval(batchId);
    const buys = pre.preflight!.videos.flatMap((v) => v.scenes.filter((sc) => sc.plan.video === "BUY"));
    expect(buys.length).toBeGreaterThan(0);
    // An approval that froze NO clip: whatever the run wants is unapproved.
    await approveAuthorization({
      batchId,
      authorizedMaxSpend: 10,
      lowAutoApproved: true,
      note: JSON.stringify({ plannedVideoModels: [], runnableProjectIds: null, frozenVideo: {} }),
    });
    const run = await runBatch(batchId, { resume: false });
    expect(run.outcomes[0]!.stopped).toMatch(/APPROVED_MODEL_MISSING/);
    expect(needsReapproval(run.outcomes[0]!.stopped)).toBe(true);
    const project = await prisma.project.findUniqueOrThrow({ where: { id: run.outcomes[0]!.projectId } });
    expect(project.status).toBe("needs_review");
    expect(run.settledStatus).not.toBe("FAILED");
    expect(await prisma.providerJob.count({ where: { projectId: project.id, kind: "video" } })).toBe(0);
  }, 600_000);
});
