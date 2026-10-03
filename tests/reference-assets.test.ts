import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelRegistry } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { profileFromPlatform } from "@/domain/platform-profile";
import { autoAssign, planReferenceSend, type SendCandidate } from "@/domain/reference";
import { referenceLimitFor } from "@/domain/video-model-profile";
import { isCapable, explainIncapable, routeScene, type RouteContext } from "@/services/ai-router";
import { approveContentScript, createContentProject } from "@/services/content-service";
import {
  autoAssignReferences,
  changeReference,
  confirmSceneWithoutReferences,
  createReference,
  listProjectReferences,
  projectReferenceAssets,
  referenceProblems,
  sceneReferenceIds,
  setSceneReferences,
} from "@/services/reference-assets";
import { buildSceneImageRequest, generateSceneImage } from "@/services/generation";
import { previewProjectCost, startMediaGeneration } from "@/services/project-service";
import { approveAndRun } from "@/services/batch-executor";
import { continueVideo } from "@/services/video-resume";
import { preflightImportedBatch } from "@/services/import-preflight";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { mockRequestLog } from "@/providers/mock/mock-visual-providers";
import { makePng, seedMock } from "./phase5-helpers";

/**
 * UNIVERSAL REFERENCE ASSET SYSTEM (QĐ-124): one product / toy / animal / logo
 * kept identical across scenes, for every content type - mock only, $0.
 */

let tmp = "";
let capBefore = 0;
const pics: Buffer[] = [];

const money = async () => ({
  jobs: await prisma.providerJob.count(),
  paid: await prisma.costEntry.count({ where: { category: { in: ["image", "video", "voice", "text"] } } }),
});

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refs-"));
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
  for (const c of ["red", "green", "blue", "white"]) pics.push(fs.readFileSync(await makePng(tmp, c, "900x900")));
});

afterAll(async () => {
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("PRODUCT REFERENCE", () => {
  it("3 ảnh cùng sản phẩm → MỘT tham chiếu sản phẩm, dùng xuyên suốt, $0", async () => {
    const before = await money();
    const project = await createContentProject({
      contentType: "PRODUCT_REVIEW",
      sourceType: "ASSETS",
      subjectName: "Máy xay mini ABC",
      facts: [{ text: "Công suất 300W" }],
      uploads: pics.slice(0, 3).map((bytes, i) => ({ bytes, filename: `abc-${i + 1}.png` })),
      durationSeconds: 30,
      outputProfile: profileFromPlatform("TIKTOK"),
    });
    const refs = await projectReferenceAssets(project.id);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: "PRODUCT", name: "Máy xay mini ABC", priority: "CRITICAL", isPrimary: true, useThroughout: true });
    expect(refs[0]!.images).toHaveLength(3);
    expect(refs[0]!.images.filter((i) => i.primary)).toHaveLength(1);
    // Scene assignment: every scene shows the product (throughout), deterministically.
    const scenes = await prisma.scene.findMany({ where: { projectId: project.id } });
    for (const s of scenes) expect(sceneReferenceIds(s)).toEqual([refs[0]!.id]);
    // Product fidelity: CRITICAL product on AUTO scenes → Local Motion.
    expect(scenes.every((s) => s.motionMode === "LOCAL_MOTION")).toBe(true);
    // Upload + assign = no provider call beyond the (mock) script text.
    const after = await money();
    expect(after.jobs - before.jobs).toBe(1);
    expect(await prisma.providerJob.count({ where: { projectId: project.id, kind: { not: "text" } } })).toBe(0);
    await approveContentScript(project.id);
    const preview = await previewProjectCost(project.id);
    for (const plan of preview.current.scenes) {
      expect(plan.motionSource).toBe("LOCAL_MOTION");
      expect(plan.video).toBeFalsy();
    }
  });
});

describe("SCENE ASSIGNMENT + IMAGE / VIDEO REFERENCE + CHANGE", () => {
  let projectId = "";
  let truckId = "";
  let logoId = "";

  it("tự gắn theo tên (đồ vật), thêm/bỏ thủ công; logo không gửi làm ảnh", async () => {
    const project = await createContentProject({
      contentType: "TOY_WORLD",
      sourceType: "PROMPT",
      idea: "Xe tải vàng của Ben khám phá công trường",
      durationSeconds: 30,
      voiceMode: "NARRATION",
      outputProfile: profileFromPlatform("TIKTOK"),
    });
    projectId = project.id;
    const truck = await createReference({
      projectId,
      type: "TOY",
      name: "Xe tải vàng của Ben",
      aliases: ["xe tải"],
      uploads: [{ bytes: pics[0]!, filename: "truck.png" }],
    });
    truckId = truck.id;
    expect(truck.priority).toBe("CRITICAL"); // a toy in a toy video
    const logo = await createReference({ projectId, type: "LOGO", name: "Mind Toys", uploads: [{ bytes: pics[1]!, filename: "logo.png" }] });
    logoId = logo.id;
    // Deterministic: same words, same answer.
    expect(autoAssign("Chiếc xe tải chạy qua cát", [{ id: "t", name: "Xe tải vàng", type: "TOY", enabled: true, useThroughout: false, aliases: ["xe tải"] }])).toEqual(["t"]);
    expect(autoAssign("Con mèo ngủ", [{ id: "t", name: "Xe tải vàng", type: "TOY", enabled: true, useThroughout: false, aliases: ["xe tải"] }])).toEqual([]);

    const scenes = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
    // Manual: the truck in scenes 2 and 3 only, the logo in scene 3.
    for (const s of scenes) await setSceneReferences(s.id, []);
    await setSceneReferences(scenes[1]!.id, [truckId]);
    await setSceneReferences(scenes[2]!.id, [truckId, logoId]);
    const s3 = await prisma.scene.findUniqueOrThrow({ where: { id: scenes[2]!.id } });
    const shot = await buildSceneImageRequest(s3, project.stylePresetId);
    const truckRef = (await projectReferenceAssets(projectId)).find((r) => r.id === truckId)!;
    expect(shot.referenceImages).toContain(toAbsolute(truckRef.images[0]!.path));
    expect(shot.referenceImages).toHaveLength(1); // the logo is never sent to the generative model
    expect(shot.prompt).toMatch(/Keep exactly the same shape/);
    expect(shot.prompt).toMatch(/Do not draw any logo/);
    expect(shot.references?.map((r) => [r.name, r.sent])).toEqual([
      ["Xe tải vàng của Ben", true],
      ["Mind Toys", false],
    ]);
    // A scene without references builds exactly the legacy request.
    const s1 = await prisma.scene.findUniqueOrThrow({ where: { id: scenes[0]!.id } });
    const plain = await buildSceneImageRequest(s1, project.stylePresetId);
    expect(plain.references).toBeUndefined();
    expect(plain.prompt).not.toMatch(/Keep exactly the same shape/);
  });

  it("chạy mock: ảnh cảnh có xe tải mang ảnh tham chiếu; video image-to-video dùng đúng keyframe", async () => {
    // Video AI for the truck scenes, so the clip path is exercised.
    const scenes = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
    for (const s of scenes) await prisma.scene.update({ where: { id: s.id }, data: s.sceneNumber === 2 ? { motionMode: "VIDEO_AI", motionSource: "AI_VIDEO" } : { motionMode: "LOCAL_MOTION", motionSource: "LOCAL_MOTION" } });
    await approveContentScript(projectId);
    mockRequestLog.image.length = 0;
    mockRequestLog.video.length = 0;
    const started = await startMediaGeneration(projectId);
    await approveAndRun({ batchId: started.batchId!, maxBatch: 5, lowAutoApproved: true, wait: true });
    const done = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(done.status).toBe("completed");

    const truckRef = (await projectReferenceAssets(projectId)).find((r) => r.id === truckId)!;
    const truckPath = toAbsolute(truckRef.images[0]!.path);
    const s2 = scenes[1]!;
    const imgReq = mockRequestLog.image.filter((r) => r.sceneId === s2.id);
    expect(imgReq.length).toBe(1);
    expect(imgReq[0]!.referenceImages).toContain(truckPath);
    const s1Req = mockRequestLog.image.filter((r) => r.sceneId === scenes[0]!.id);
    expect(s1Req.every((r) => !r.referenceImages.includes(truckPath))).toBe(true);
    // Image-to-video: the clip is made FROM the scene's keyframe.
    const vid = mockRequestLog.video.filter((r) => r.sceneId === s2.id);
    expect(vid.length).toBe(1);
    const s2After = await prisma.scene.findUniqueOrThrow({ where: { id: s2.id } });
    expect(vid[0]!.referenceImagePath).toBe(toAbsolute(s2After.imagePath!));
    expect(vid[0]!.referenceImages).toBeUndefined(); // no adapter declares direct references
  });

  it("đổi ảnh xe tải → CHỈ cảnh có xe tải cần ảnh mới; giọng/phụ đề giữ; preflight trước khi mua; không mua trùng", async () => {
    const scenes = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" }, include: { dialogueLines: true } });
    const before = new Map(scenes.map((s) => [s.id, s]));
    const voiceJobs = await prisma.providerJob.count({ where: { projectId, kind: "voice" } });

    const change = await changeReference(truckId, { uploads: [{ bytes: pics[3]!, filename: "truck-v2.png" }], primaryAssetId: undefined });
    // The new photo becomes the main one only when asked; here, make it so.
    const refNow = (await projectReferenceAssets(projectId)).find((r) => r.id === truckId)!;
    const newAsset = refNow.images.find((i) => i.filename === "truck-v2.png")!;
    const swap = await changeReference(truckId, { primaryAssetId: newAsset.assetId });
    expect(change.invalidatedScenes).toEqual([]); // adding a picture alone changes nothing
    expect(swap.version).toBe(2);
    expect(swap.invalidatedScenes.sort()).toEqual([2, 3]);

    const after = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" }, include: { dialogueLines: true } });
    for (const s of after) {
      const was = before.get(s.id)!;
      if (s.sceneNumber === 2 || s.sceneNumber === 3) {
        expect(s.imagePath).toBeNull();
      } else {
        expect(s.imagePath).toBe(was.imagePath);
        expect(s.videoPath).toBe(was.videoPath);
      }
      // Voice and subtitles never depend on a picture.
      expect(s.subtitle).toBe(was.subtitle);
      expect(s.dialogueLines.map((l) => [l.text, l.outputPath, l.status])).toEqual(was.dialogueLines.map((l) => [l.text, l.outputPath, l.status]));
    }
    // Preflight shows exactly two images to buy (and their clip), nothing else.
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const pre = await preflightImportedBatch(project.batchId!);
    expect(pre.counts.imagePosts).toBe(2);
    expect(pre.counts.voicePosts).toBe(0);

    mockRequestLog.image.length = 0;
    expect((await continueVideo(projectId, { wait: true, confirmPaid: true })).status).toBe("COMPLETED");
    expect(mockRequestLog.image.map((r) => r.referenceImages.includes(toAbsolute(newAsset.path)))).toEqual([true, true]);
    expect(await prisma.providerJob.count({ where: { projectId, kind: "voice" } })).toBe(voiceJobs);
    // Run again: nothing new is bought.
    const jobs = await prisma.providerJob.count({ where: { projectId } });
    await continueVideo(projectId, { wait: true });
    expect(await prisma.providerJob.count({ where: { projectId } })).toBe(jobs);
  });

  it("file tham chiếu mất → REFERENCE_MISSING_LOCAL_FILE, không tự tạo lại", async () => {
    const ref = (await projectReferenceAssets(projectId)).find((r) => r.id === truckId)!;
    const main = ref.images.find((i) => i.primary)!;
    const abs = toAbsolute(main.path);
    const keep = fs.readFileSync(abs);
    fs.rmSync(abs);
    const status = (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status;
    // A video with something left to make (a finished one needs nothing).
    await prisma.project.update({ where: { id: projectId }, data: { status: "script_ready" } });
    try {
      const problems = await referenceProblems(projectId);
      expect(problems.map((p) => p.code)).toContain("REFERENCE_MISSING_LOCAL_FILE");
      const jobs = await prisma.providerJob.count();
      const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      const pre = await preflightImportedBatch(project.batchId!);
      expect(pre.videos.find((v) => v.projectId === projectId)?.blockedReason).toMatch(/REFERENCE_MISSING_LOCAL_FILE/);
      expect(await prisma.providerJob.count()).toBe(jobs);
    } finally {
      fs.writeFileSync(abs, keep);
      await prisma.project.update({ where: { id: projectId }, data: { status } });
    }
  });

  it("panel hiện cả nhân vật (Character Bible, chỉ đọc) và tham chiếu của dự án", async () => {
    const all = await listProjectReferences(projectId);
    expect(all.some((r) => r.id === truckId && r.source === "REFERENCE")).toBe(true);
    expect(all.filter((r) => r.source === "CHARACTER_BIBLE").every((r) => r.type === "CHARACTER" && r.id.startsWith("character:"))).toBe(true);
  });
});

describe("MULTI-REFERENCE · UNSUPPORTED MODEL · MANUAL MODEL", () => {
  const c = (name: string, type: SendCandidate["type"], priority: SendCandidate["priority"], order: number, isPrimary = false): SendCandidate => ({
    key: name,
    name,
    type,
    priority,
    isPrimary,
    imagePath: `/x/${name}.png`,
    order,
  });

  it("tôn trọng giới hạn và thứ tự: sản phẩm chính → nhân vật → đồ vật → logo/style", () => {
    const plan = planReferenceSend(
      [c("Max", "CHARACTER", "IMPORTANT", 0, true), c("Leo", "CHARACTER", "IMPORTANT", 1), c("ABC", "PRODUCT", "CRITICAL", 100, true), c("Hộp", "OBJECT", "IMPORTANT", 101), c("Logo", "LOGO", "OPTIONAL", 102)],
      2,
    );
    expect(plan.sent.map((x) => x.name)).toEqual(["ABC", "Max"]);
    expect(plan.droppedByLimit.map((x) => x.name)).toEqual(["Leo", "Hộp"]); // logo never sent at all
    expect(plan.criticalDropped).toEqual([]);
    const tight = planReferenceSend([c("A", "PRODUCT", "CRITICAL", 0), c("B", "TOY", "CRITICAL", 1)], 1);
    expect(tight.criticalDropped.map((x) => x.name)).toEqual(["B"]);
  });

  it("model không hỗ trợ tham chiếu: không tự chọn cho cảnh có tham chiếu BẮT BUỘC; chọn tay thì báo rõ; 0 POST", async () => {
    const noRef = { modelId: "flat", provider: "mock", type: "image", enabled: true, supportsReferenceImage: false, supportsCharacterReference: false, capabilityProfileJson: null } as unknown as ModelRegistry;
    expect(referenceLimitFor(noRef)).toBe(0);
    const ctx = { type: "image", requiredReferenceImages: 1, availableProviders: ["mock"], consistencyRequired: false } as unknown as RouteContext;
    expect(isCapable(noRef, ctx)).toBe(false);
    expect(explainIncapable(noRef, ctx)).toMatch(/không hỗ trợ ảnh tham chiếu trực tiếp/);

    // A real scene with TWO critical things, pinned to a model that takes ONE picture.
    const project = await createContentProject({
      contentType: "PRODUCT_REVIEW",
      sourceType: "ASSETS",
      subjectName: "Ấm siêu tốc Z",
      uploads: [{ bytes: pics[2]!, filename: "z.png" }],
      durationSeconds: 15,
      outputProfile: profileFromPlatform("TIKTOK"),
    });
    const lid = await createReference({ projectId: project.id, type: "PRODUCT", name: "Nắp ấm Z", uploads: [{ bytes: pics[1]!, filename: "lid.png" }] });
    const oneId = `mock-image-one-${Date.now()}`;
    await prisma.modelRegistry.create({
      data: {
        provider: "mock",
        modelId: oneId,
        displayName: "One ref",
        type: "image",
        enabled: true,
        priceUnit: "per_image",
        price: 0.004,
        supportsReferenceImage: true,
        capabilityProfileJson: JSON.stringify({ maxReferenceImages: 1 }),
      },
    });
    const scene = (await prisma.scene.findMany({ where: { projectId: project.id }, orderBy: { sceneNumber: "asc" } })).find((s) => s.imageSource !== "IMPORTED")!;
    const kettle = (await projectReferenceAssets(project.id)).find((r) => r.name === "Ấm siêu tốc Z")!;
    await setSceneReferences(scene.id, [kettle.id, lid.id]);
    await prisma.scene.update({ where: { id: scene.id }, data: { imageProvider: "mock", imageModel: oneId } });
    const before = await prisma.providerJob.count({ where: { projectId: project.id, kind: "image" } });
    await expect(generateSceneImage(scene.id)).rejects.toThrow(/chỉ hỗ trợ 1 ảnh tham chiếu/);
    expect(await prisma.providerJob.count({ where: { projectId: project.id, kind: "image" } })).toBe(before);
    // Only a person's confirmation lifts it: then ONE picture is sent, and it is said.
    await confirmSceneWithoutReferences(scene.id, true);
    mockRequestLog.image.length = 0;
    await expect(generateSceneImage(scene.id)).resolves.toBeTruthy();
    expect(mockRequestLog.image.at(-1)!.referenceImages).toHaveLength(1);
    await prisma.modelRegistry.deleteMany({ where: { modelId: oneId } });
  });

  it("model chưa benchmark vẫn chọn tay được (MANUAL_OK); benchmark chỉ là điều kiện tự định tuyến", () => {
    const fresh = {
      id: "fresh",
      provider: "mock",
      modelId: "fresh-video",
      displayName: "Fresh",
      type: "video",
      enabled: true,
      priceUnit: "per_second",
      price: 0.05,
      supportsTextToVideo: true,
      supportsImageToVideo: true,
      supportsReferenceImage: true,
      supportsCharacterReference: true,
      supports1080p: true,
      maxDuration: 10,
      qualityRating: 6,
      speedRating: 6,
      consistencyRating: 6,
      historicalSuccessRate: 1,
      lifecycle: "PIN_ONLY",
      verification: "UNVERIFIED",
      reliability: "OK",
      shutdownDate: null,
      capabilityProfileJson: null,
    } as unknown as ModelRegistry;
    const ctx = {
      type: "video",
      qualityMode: "BALANCED",
      strategy: "AUTO",
      complexity: "LOW",
      spendPriority: "NORMAL",
      durationSeconds: 4,
      characterCount: 1,
      consistencyRequired: true,
      needs1080p: false,
      needsReferenceImage: true,
      budgetRemaining: 10,
      usage: { seconds: 4, jobs: 1 },
      availableProviders: ["mock"],
    } as RouteContext;
    expect(() => routeScene([fresh], ctx)).toThrow();
    expect(routeScene([fresh], { ...ctx, manualProvider: "mock", manualModel: "fresh-video" }).modelId).toBe("fresh-video");
  });
});

describe("LEGACY", () => {
  it("cảnh/dự án cũ không có tham chiếu: không vấn đề, không yêu cầu ảnh bắt buộc", async () => {
    const legacy = await prisma.project.findFirst({ where: { contentType: null }, include: { scenes: true } });
    if (!legacy) return;
    expect(await referenceProblems(legacy.id)).toEqual([]);
    for (const s of legacy.scenes) expect(sceneReferenceIds(s)).toEqual([]);
    await expect(previewProjectCost(legacy.id)).resolves.toBeTruthy();
    expect(await autoAssignReferences(legacy.id)).toEqual({});
  });
});
