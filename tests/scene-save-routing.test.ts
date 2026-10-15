import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { prisma } from "@/lib/prisma";
import { profileFromPlatform } from "@/domain/platform-profile";
import { updateScene } from "@/app/actions/projects";
import { reanalyseBatch } from "@/app/actions/batches";
import { approveContentScript, createContentProject } from "@/services/content-service";
import { previewProjectCost, startMediaGeneration } from "@/services/project-service";
import { deriveSceneVideoFacts } from "@/services/low-auto-facts";
import { pricedFromRows } from "@/services/batch-sources";
import { storedPlan } from "@/services/batch-runner";
import { approveAndRun } from "@/services/batch-executor";
import { continueVideo } from "@/services/video-resume";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { seedMock } from "./phase5-helpers";

/**
 * QĐ-135: "Lưu cảnh" persists only what a person chose, and DỰ TOÁN LẠI on a
 * batch made of existing rows prices those rows.
 *
 * Bug 1: the storyboard form showed the model TẠO MEDIA had frozen onto the
 * scene as if it were a pin, so saving the form pinned it; and it never wrote
 * `motionSource`, so a scene set to LOCAL_MOTION was still priced (and would
 * have been routed) as a paid clip.
 *
 * Bug 2: a project wrapped into a batch lists no idioms, the idiom planner read
 * that as "pick any unused idiom", and DỰ TOÁN LẠI froze that stranger's
 * reference-profile price - script included - onto the batch.
 *
 * Mock only, throwaway database, no network, $0.
 */

let capBefore = 0;
let projectId = "";
let batchId = "";
let scene1 = "";

type SceneRow = Awaited<ReturnType<typeof prisma.scene.findUniqueOrThrow>>;
const row = (id = scene1) => prisma.scene.findUniqueOrThrow({ where: { id } });

/**
 * What the storyboard form submits for a scene left as it is, with `changes`
 * applied - the same defaults `storyboard.tsx` renders: the model fields show a
 * PIN only, never the plan or the record in the same columns.
 */
function formFor(scene: SceneRow, changes: Record<string, string> = {}): FormData {
  const pinned = scene.videoModelPinned && scene.videoProvider && scene.videoModel;
  const fields: Record<string, string> = {
    dialogue: scene.dialogue,
    narration: scene.narration,
    subtitle: scene.subtitle,
    visualDescription: scene.visualDescription,
    imagePrompt: scene.imagePrompt,
    videoPrompt: scene.videoPrompt,
    duration: String(scene.duration),
    complexity: scene.complexity,
    camera: scene.camera,
    motionMode: scene.motionMode,
    soundEffect: scene.soundEffect,
    routingMode: scene.routingMode,
    videoModel: pinned ? scene.videoModel! : "",
    videoProvider: pinned ? scene.videoProvider! : "",
    ...changes,
  };
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v ?? "");
  return form;
}

const save = async (changes: Record<string, string> = {}) => {
  const r = await updateScene(scene1, formFor(await row(), changes));
  expect(r.ok, r.message).toBe(true);
  return row();
};

const motionOf = (scene: SceneRow) => deriveSceneVideoFacts(scene, { qualityMode: "BALANCED", stage: "VIDEO", keyframeExists: () => true }).motion.source;
const scene1Plan = async () => (await previewProjectCost(projectId)).current.scenes.find((s) => s.sceneNumber === 1)!;
const jobs = (where: Record<string, unknown> = {}) => prisma.providerJob.count({ where: { projectId, ...where } });
const paidJobs = () => prisma.providerJob.count({ where: { projectId, provider: { not: "mock" } } });

beforeAll(async () => {
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
  // An idiom the old planner would have picked for an empty list.
  await prisma.idiom.upsert({
    where: { slug: "qd135-stranger" },
    create: {
      phrase: "QĐ-135 stranger",
      slug: "qd135-stranger",
      meaning: "Not this batch",
      literalMeaning: "Not this batch",
      exampleSentence: "Not this batch.",
      category: "Funny Expressions",
      status: "unused",
      timesUsed: -1,
    },
    update: { status: "unused", timesUsed: -1 },
  });

  const project = await createContentProject({
    contentType: "TOY_WORLD",
    sourceType: "PROMPT",
    idea: "Xe tải vàng chạy qua bãi cát",
    durationSeconds: 30,
    voiceMode: "NARRATION",
    outputProfile: profileFromPlatform("TIKTOK"),
  });
  projectId = project.id;
  const scenes = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
  expect(scenes.length).toBeGreaterThanOrEqual(2);
  scene1 = scenes[0]!.id;
  for (const [i, sc] of scenes.entries()) {
    const text = i === 0 ? "Chiếc xe tải vàng lao nhanh qua cồn cát, bụi tung mù mịt" : "Bầu trời xanh trong";
    await prisma.scene.update({
      where: { id: sc.id },
      data: {
        visualDescription: text,
        narration: text,
        subtitle: text,
        imagePrompt: text,
        referenceIdsJson: "[]",
        // Scene 1 is the one the router sends to Video AI; the rest are local.
        ...(i === 0
          ? { motionMode: "AUTO", motionSource: "AI_VIDEO", complexity: "HIGH", spendPriority: "HIGH", characterAction: "lao nhanh qua cồn cát" }
          : { motionMode: "LOCAL_MOTION", motionSource: "LOCAL_MOTION" }),
      },
    });
  }
  await approveContentScript(projectId);
  const started = await startMediaGeneration(projectId);
  expect(started.errors).toEqual([]);
  batchId = started.batchId!;
}, 120_000);

afterAll(async () => {
  if (capBefore > 0) await setSpendCap(capBefore);
});

describe("QĐ-135 BUG 1 — Lưu cảnh", () => {
  it("tiền đề: TẠO MEDIA ghi model video dự kiến vào cảnh như một BẢN GHI, không phải ghim", async () => {
    const s = await row();
    expect(s.videoModel).toBeTruthy();
    expect(s.videoModelPinned).toBe(false);
    expect(motionOf(s)).toBe("AI_VIDEO");
  });

  it("A. AUTO → Lưu cảnh → vẫn AUTO, không biến bản ghi thành ghim, kế hoạch giữ nguyên", async () => {
    const before = await row();
    const after = await save();
    expect(after.motionMode).toBe("AUTO");
    expect(after.videoModelPinned).toBe(false);
    expect(after.motionSource).toBe(before.motionSource);
    expect([after.videoProvider, after.videoModel]).toEqual([before.videoProvider, before.videoModel]);
  });

  it("B. LOCAL_MOTION → Lưu cảnh → motionSource LOCAL_MOTION, không còn model trả phí, dự toán không có clip", async () => {
    const after = await save({ motionMode: "LOCAL_MOTION" });
    expect(after.motionMode).toBe("LOCAL_MOTION");
    expect(after.motionSource).toBe("LOCAL_MOTION");
    expect(after.videoModelPinned).toBe(false);
    expect([after.videoProvider, after.videoModel]).toEqual([null, null]);
    expect(motionOf(after)).toBe("LOCAL_MOTION");
    const plan = await scene1Plan();
    expect(plan.motionSource).toBe("LOCAL_MOTION");
    expect(plan.video).toBeNull();
  });

  it("C. chọn tay model Video AI → Lưu → ghim được giữ, kể cả lưu lại lần nữa", async () => {
    const pinned = await save({ motionMode: "VIDEO_AI", videoProvider: "mock", videoModel: "mock-video-std" });
    expect(pinned.videoModelPinned).toBe(true);
    expect([pinned.videoProvider, pinned.videoModel]).toEqual(["mock", "mock-video-std"]);
    expect(pinned.motionSource).toBe("AI_VIDEO");
    expect(motionOf(pinned)).toBe("AI_VIDEO");
    // Saving again, the form shows the pin, so it is submitted and kept.
    const again = await save({ narration: "Xe tải vàng về đích" });
    expect(again.videoModelPinned).toBe(true);
    expect(again.videoModel).toBe("mock-video-std");
    expect((await scene1Plan()).video?.modelId).toBe("mock-video-std");
  });

  it("D. đang ghim tay → đổi sang LOCAL_MOTION (select vẫn hiện model) → Lưu → ghim cũ không điều khiển định tuyến", async () => {
    const before = await row();
    expect(formFor(before).get("videoModel")).toBe("mock-video-std");
    const after = await save({ motionMode: "LOCAL_MOTION" });
    expect(after.videoModelPinned).toBe(false);
    expect([after.videoProvider, after.videoModel]).toEqual([null, null]);
    expect(after.motionSource).toBe("LOCAL_MOTION");
    expect(motionOf(after)).toBe("LOCAL_MOTION");
    expect((await scene1Plan()).video).toBeNull();
  });

  it("D2. hàng cũ đã bị form cũ làm hỏng (LOCAL_MOTION + AI_VIDEO + ghim) → định tuyến và dự toán LOCAL, $0", async () => {
    await prisma.scene.update({
      where: { id: scene1 },
      data: { motionMode: "LOCAL_MOTION", motionSource: "AI_VIDEO", videoProvider: "mock", videoModel: "mock-video-std", videoModelPinned: true },
    });
    expect(motionOf(await row())).toBe("LOCAL_MOTION");
    const plan = await scene1Plan();
    expect(plan.motionSource).toBe("LOCAL_MOTION");
    expect(plan.video).toBeNull();
    // Saving it once through the form repairs the row itself.
    const repaired = await save();
    expect([repaired.motionSource, repaired.videoModelPinned, repaired.videoModel]).toEqual(["LOCAL_MOTION", false, null]);
  });

  it("AUTO lại → bỏ quyết định LOCAL đã đóng băng, router quyết lại; bỏ ghim bằng tay thì rút ghim", async () => {
    const auto = await save({ motionMode: "AUTO" });
    expect(auto.motionMode).toBe("AUTO");
    expect(auto.motionSource).toBe("AI_VIDEO");
    expect(auto.videoModelPinned).toBe(false);
    // HIGH priority: the planner's own verdict is a clip - a forecast, not a purchase.
    expect(motionOf(auto)).toBe("AI_VIDEO");

    const pinned = await save({ videoProvider: "mock", videoModel: "mock-video-lite" });
    expect([pinned.motionMode, pinned.videoModelPinned, pinned.videoModel]).toEqual(["AUTO", true, "mock-video-lite"]);
    const cleared = await save({ videoProvider: "", videoModel: "" });
    expect([cleared.videoModelPinned, cleared.videoProvider, cleared.videoModel]).toEqual([false, null, null]);
  });

  it("E. tải lại trang → form dựng từ hàng đã lưu hiện đúng trạng thái (không hiện bản ghi như ghim)", async () => {
    // A record, as TẠO MEDIA / a run writes it.
    await prisma.scene.update({ where: { id: scene1 }, data: { videoProvider: "mock", videoModel: "mock-video-std", videoModelPinned: false } });
    const reloaded = await row();
    expect(formFor(reloaded).get("videoModel")).toBe("");
    expect(formFor(reloaded).get("motionMode")).toBe("AUTO");
    const saved = await save();
    expect(saved.videoModelPinned).toBe(false);
    expect(saved.videoModel).toBe("mock-video-std");
  });
});

describe("QĐ-135 BUG 2 — DỰ TOÁN LẠI lô dự án", () => {
  it("lô bọc một dự án được nhận ra là lô từ hàng có sẵn; lô thành ngữ V1 thì không", async () => {
    expect(await pricedFromRows(batchId)).toBe(true);
    const stranger = await prisma.idiom.findUniqueOrThrow({ where: { slug: "qd135-stranger" } });
    const v1 = await prisma.batch.create({
      data: { name: "QĐ-135 V1", amount: 1, qualityMode: "BALANCED", targetDuration: 25, status: "PLANNED", maxBudget: 1, maxCostPerVideo: 1, idiomIdsJson: JSON.stringify([stranger.id]) },
    });
    expect(await pricedFromRows(v1.id)).toBe(false); // planned, no project yet
    await prisma.project.create({ data: { idiomId: stranger.id, batchId: v1.id, title: "v1", status: "draft", qualityMode: "BALANCED" } });
    expect(await pricedFromRows(v1.id)).toBe(false); // its project comes from its own list
    await prisma.project.deleteMany({ where: { batchId: v1.id } });
    await prisma.batch.delete({ where: { id: v1.id } });
  });

  it("DỰ TOÁN LẠI định giá đúng dự án của lô — không thành ngữ lạ, không kịch bản mẫu, không job, không reservation", async () => {
    const stranger = await prisma.idiom.findUniqueOrThrow({ where: { slug: "qd135-stranger" } });
    const jobsBefore = await prisma.providerJob.count();
    const reservationsBefore = await prisma.costReservation.count();
    const capBeforeRun = (await spendStatus()).cap;

    const r = await reanalyseBatch(batchId);
    expect(r.ok, r.message).toBe(true);

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    const plan = storedPlan(batch)!;
    expect(plan.videos.map((v) => v.projectId)).toEqual([projectId]);
    expect(plan.videos.some((v) => v.idiomId === stranger.id)).toBe(false);
    expect(plan.videos.some((v) => v.basis === "reference-profile")).toBe(false);
    expect(batch.idiomIdsJson).toBe("[]");
    const auth = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
    expect(auth.status).toBe("DRAFT");
    expect(auth.authorizedMaxSpend).toBe(0);
    expect(auth.estimatedCost).toBeCloseTo(batch.estimatedCost, 6);
    expect(r.message).toContain(`$${batch.estimatedCost.toFixed(4)}`);

    expect(await prisma.providerJob.count()).toBe(jobsBefore);
    expect(await prisma.costReservation.count()).toBe(reservationsBefore);
    expect((await spendStatus()).cap).toBe(capBeforeRun);
  });

  it("lô cũ đã bị kẹt (idiomIdsJson trỏ thành ngữ lạ, kế hoạch mẫu) → DỰ TOÁN LẠI gỡ kẹt", async () => {
    const stranger = await prisma.idiom.findUniqueOrThrow({ where: { slug: "qd135-stranger" } });
    await prisma.batch.update({
      where: { id: batchId },
      data: {
        idiomIdsJson: JSON.stringify([stranger.id]),
        estimatedCost: 1.6859,
        planJson: JSON.stringify({ videos: [{ idiomId: stranger.id, phrase: stranger.phrase, projectId: null, basis: "reference-profile", estimatedCost: 1.6859, status: "OK", scenes: [] }], estimatedTotal: 1.6859, runnableCount: 1 }),
      },
    });
    await prisma.batchAuthorization.update({ where: { batchId }, data: { estimatedCost: 1.6859 } });

    expect((await reanalyseBatch(batchId)).ok).toBe(true);
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(storedPlan(batch)!.videos.map((v) => v.projectId)).toEqual([projectId]);
    expect(batch.estimatedCost).toBeLessThan(1.6859);
    expect((await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } })).estimatedCost).toBeCloseTo(batch.estimatedCost, 6);
  });

  it("đổi cảnh rồi DỰ TOÁN LẠI → dự toán đi theo cảnh (LOCAL rẻ hơn ghim Video AI)", async () => {
    await save({ motionMode: "VIDEO_AI", videoProvider: "mock", videoModel: "mock-video-pro" });
    await reanalyseBatch(batchId);
    const paid = (await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).estimatedCost;
    await save({ motionMode: "LOCAL_MOTION" });
    await reanalyseBatch(batchId);
    const local = (await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).estimatedCost;
    expect(local).toBeLessThan(paid);
    const sceneRow = storedPlan(await prisma.batch.findUniqueOrThrow({ where: { id: batchId } }))!.videos[0]!.scenes.find((s) => s.sceneNumber === 1);
    expect(sceneRow?.motionSource).toBe("LOCAL_MOTION");
  });
});

describe("QĐ-135 — chạy, lưu, chạy lại", () => {
  it("F + G. chạy (mock) → Lưu cảnh không làm mất media → chạy tiếp không mua trùng; 0 POST trả phí", async () => {
    await save({ motionMode: "AUTO" });
    await reanalyseBatch(batchId);
    await approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe("completed");
    const media = async () => (await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } })).map((s) => [s.imagePath, s.videoPath, s.audioPath]);
    const shots = await media();
    const allJobs = await jobs();
    const videoJobs = await jobs({ kind: "video" });

    // Saving the scene as it is changes no media.
    const saved = await save();
    expect(saved.videoModelPinned).toBe(false);
    expect(await media()).toEqual(shots);
    const again = await continueVideo(projectId, { wait: true });
    expect(again.status).toBe("NOOP");
    expect(await jobs()).toBe(allJobs);

    // Switching the clip scene to LOCAL afterwards buys nothing either.
    await save({ motionMode: "LOCAL_MOTION" });
    await continueVideo(projectId, { wait: true });
    expect(await jobs({ kind: "video" })).toBe(videoJobs);

    expect(await paidJobs()).toBe(0);
    expect(await prisma.costEntry.count({ where: { projectId, provider: { not: "mock" } } })).toBe(0);
  });
});
