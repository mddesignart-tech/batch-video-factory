import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { profileFromPlatform } from "@/domain/platform-profile";
import { cameraPromptPhrase } from "@/domain/camera-grammar";
import { reducedCamera } from "@/domain/camera-capability";
import { parseScenePlan } from "@/domain/scene-plan";
import { buildSceneNormalizeArgs } from "@/media/render";
import { ffmpeg } from "@/media/ffmpeg";
import { approveContentScript, createContentProject } from "@/services/content-service";
import { createProjectForIdiom, startMediaGeneration } from "@/services/project-service";
import { approveAndRun } from "@/services/batch-executor";
import { continueVideo } from "@/services/video-resume";
import { saveCreativeStyle } from "@/services/creative-style";
import { storeImportedImage } from "@/services/imported-image";
import { createReference, setSceneReferences } from "@/services/reference-assets";
import { compositeOption, enableComposite, planProjectScenes, renderInputsFor, resetSceneCameraAuto, setSceneCamera, useLocalCamera } from "@/services/scene-plan-service";
import { sceneCameraViews } from "@/services/scene-camera-view";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { makePng, seedMock } from "./phase5-helpers";

/**
 * QĐ-128 PHASES F-I in the real pipeline (mock providers, local FFmpeg):
 * plans written for new scripts, a person's camera kept, legacy untouched,
 * all-local = 0 video jobs, one AI scene = exactly one, resume buys nothing
 * twice, unsupported camera falls back, layers composite at $0.
 */

let tmp = "";
let capBefore = 0;
const jobs = async () => ({
  image: await prisma.providerJob.count({ where: { kind: "image" } }),
  video: await prisma.providerJob.count({ where: { kind: "video" } }),
  voice: await prisma.providerJob.count({ where: { kind: "voice" } }),
});
const scenesOf = (projectId: string) => prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scene-motion-"));
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
}, 300_000);
afterAll(async () => {
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function story(idea: string, durationSeconds = 15) {
  return createContentProject({ contentType: "STORY", sourceType: "PROMPT", idea, durationSeconds, outputProfile: profileFromPlatform("TIKTOK") });
}

describe("SCENE PLANS (DB, mock)", () => {
  it("kịch bản mới: mỗi cảnh có plan AUTO; câu camera chuẩn vào cảnh; prompt có chiều sâu cảnh; không mua gì", async () => {
    const before = await jobs();
    const p = await story("Leo and Max chat on a busy city street while cars pass");
    const scenes = await scenesOf(p.id);
    expect(scenes.length).toBeGreaterThan(2);
    for (const s of scenes) {
      const plan = parseScenePlan(s.scenePlanJson);
      expect(plan?.source).toBe("AUTO");
      expect(s.camera).toBe(cameraPromptPhrase(plan!.camera));
      expect(plan!.camera.reason.length).toBeGreaterThan(0);
      expect(s.videoPrompt).not.toContain(plan!.camera.reason);
    }
    expect(scenes.some((s) => /Scene depth: .*city street/.test(s.imagePrompt))).toBe(true);
    expect(await jobs()).toEqual(before);
  }, 300_000);

  it("người dùng đổi camera → AI không ghi đè (kể cả khi lập lại / đổi phong cách); Đặt lại tự động thì AI quản lại", async () => {
    const p = await story("A rabbit learns to share in a green park");
    const [first] = await scenesOf(p.id);
    await setSceneCamera(first!.id, { shotSize: "WIDE", cameraMovement: "PAN_LEFT" });
    await planProjectScenes(p.id);
    await saveCreativeStyle(p.id, { preset: "TIKTOK_FUNNY" });
    let plan = parseScenePlan((await prisma.scene.findUniqueOrThrow({ where: { id: first!.id } })).scenePlanJson)!;
    expect(plan).toMatchObject({ source: "USER", camera: { shotSize: "WIDE", cameraMovement: "PAN_LEFT" } });
    await resetSceneCameraAuto(first!.id);
    plan = parseScenePlan((await prisma.scene.findUniqueOrThrow({ where: { id: first!.id } })).scenePlanJson)!;
    expect(plan.source).toBe("AUTO");
  }, 300_000);

  it("project cũ (cảnh không có plan): render y hệt trước; đổi phong cách không thêm plan", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const idiom = await prisma.idiom.create({ data: { phrase: `Break a leg ${tag}`, slug: `bal-${tag}`, meaning: "good luck", literalMeaning: "leg", exampleSentence: "Break a leg tonight!", category: "test" } });
    const legacy = await createProjectForIdiom({ idiomId: idiom.id, qualityMode: "ECONOMY", autoGenerateScript: true });
    await prisma.scene.updateMany({ where: { projectId: legacy.id }, data: { scenePlanJson: null } });
    await saveCreativeStyle(legacy.id, { preset: "DOCUMENTARY" });
    for (const s of await scenesOf(legacy.id)) {
      expect(s.scenePlanJson).toBeNull();
      expect(renderInputsFor(s)).toEqual({});
    }
    const target = { width: 360, height: 640, fps: 24 };
    const plain = buildSceneNormalizeArgs({ videoInput: "a.png", audioInput: null, duration: 4, target, output: "o.mp4" });
    const viaPlan = buildSceneNormalizeArgs({ videoInput: "a.png", audioInput: null, duration: 4, target, output: "o.mp4", ...{} });
    expect(viaPlan).toEqual(plain);
  }, 300_000);
});

describe("ROUTING · COST · RESUME (DB, mock pipeline)", () => {
  it("K/Q/P. tất cả local → 0 Video job; render thật có camera; render lại / resume không mua lại gì", async () => {
    const p = await story("Leo and Max talk in a cozy cafe", 12);
    await prisma.scene.updateMany({ where: { projectId: p.id }, data: { motionMode: "LOCAL_MOTION", motionSource: "LOCAL_MOTION" } });
    await approveContentScript(p.id);
    const before = await jobs();
    const started = await startMediaGeneration(p.id);
    await approveAndRun({ batchId: started.batchId!, maxBatch: 5, lowAutoApproved: true, wait: true });
    const done = await prisma.project.findUniqueOrThrow({ where: { id: p.id }, include: { scenes: { select: { sceneNumber: true, status: true, errorMessage: true } } } });
    expect({ status: done.status, error: done.errorMessage, scenes: done.scenes.filter((x) => x.errorMessage) }).toMatchObject({ status: "completed" });
    const afterFirst = await jobs();
    expect(afterFirst.video - before.video).toBe(0);
    // Change one scene's camera: a local re-render, nothing bought.
    const [s1] = await scenesOf(p.id);
    await setSceneCamera(s1!.id, { cameraMovement: "PAN_RIGHT" });
    await prisma.project.update({ where: { id: p.id }, data: { status: "media_ready" } });
    expect((await continueVideo(p.id, { wait: true })).status).toBe("COMPLETED");
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("completed");
    expect(await jobs()).toEqual(afterFirst);
    // Resume again on a finished video: nothing to do, nothing bought.
    expect((await continueVideo(p.id, { wait: true })).status).toBe("NOOP");
    expect(await jobs()).toEqual(afterFirst);
  }, 900_000);

  it("L/P. một cảnh cần Video AI → đúng 1 job video; resume không tạo job trùng", async () => {
    const p = await story("A kitten runs and jumps across the garden", 12);
    const scenes = await scenesOf(p.id);
    await prisma.scene.updateMany({ where: { projectId: p.id }, data: { motionMode: "LOCAL_MOTION", motionSource: "LOCAL_MOTION" } });
    await prisma.scene.update({ where: { id: scenes[1]!.id }, data: { motionMode: "VIDEO_AI", motionSource: "AI_VIDEO" } });
    await approveContentScript(p.id);
    const before = await jobs();
    const started = await startMediaGeneration(p.id);
    await approveAndRun({ batchId: started.batchId!, maxBatch: 5, lowAutoApproved: true, wait: true });
    const after = await jobs();
    expect(after.video - before.video).toBe(1);
    await continueVideo(p.id, { wait: true });
    expect((await jobs()).video - before.video).toBe(1);
    // Cost by part: only the subject's movement of that one scene carries a price.
    const views = await sceneCameraViews(p.id, new Map([[scenes[1]!.sceneNumber, 0.4]]));
    for (const v of Object.values(views)) {
      expect(v.cost.filter((c) => c.cost > 0).length).toBeLessThanOrEqual(1);
      expect(v.cost.find((c) => c.label === "Camera")!.cost).toBe(0);
    }
  }, 900_000);

  it("M. camera model không hỗ trợ → cảnh báo + phương án; GIẢM CHUYỂN ĐỘNG / DÙNG CAMERA LOCAL không làm hỏng project", async () => {
    const p = await story("Two friends meet at a market", 12);
    const [s1] = await scenesOf(p.id);
    await prisma.scene.update({ where: { id: s1!.id }, data: { motionSource: "AI_VIDEO", motionMode: "VIDEO_AI" } });
    await setSceneCamera(s1!.id, { cameraMovement: "ORBIT_LEFT" });
    let view = (await sceneCameraViews(p.id, new Map()))[s1!.id]!;
    expect(view.warning).toMatch(/Xoay quanh trái/);
    const plan = parseScenePlan((await prisma.scene.findUniqueOrThrow({ where: { id: s1!.id } })).scenePlanJson)!;
    await setSceneCamera(s1!.id, reducedCamera(plan.camera));
    view = (await sceneCameraViews(p.id, new Map()))[s1!.id]!;
    expect(view.warning).toBeNull();
    await useLocalCamera(s1!.id);
    expect((await prisma.scene.findUniqueOrThrow({ where: { id: s1!.id } })).motionSource).toBe("LOCAL_MOTION");
  }, 300_000);

  it("ghép lớp tại máy: ảnh bối cảnh + chủ thể PNG trong suốt → COMPOSITE, ảnh cảnh nhập ($0), không job ảnh", async () => {
    const p = await createContentProject({ contentType: "PRODUCT_REVIEW", sourceType: "PROMPT", idea: "Bình giữ nhiệt Mind trong gian bếp", subjectName: "Bình Mind", durationSeconds: 12, outputProfile: profileFromPlatform("TIKTOK") });
    const bg = await makePng(tmp, "beige", "720x1280");
    const cut = path.join(tmp, "cut.png");
    await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red@0.0:s=300x500,format=rgba,drawbox=x=80:y=60:w=140:h=380:color=silver@1:t=fill", "-frames:v", "1", cut]);
    const env = await storeImportedImage({ projectId: p.id, sceneId: null, bytes: fs.readFileSync(bg), originalFilename: "kitchen.png" });
    const prod = await storeImportedImage({ projectId: p.id, sceneId: null, bytes: fs.readFileSync(cut), originalFilename: "bottle.png" });
    const envRef = await createReference({ projectId: p.id, type: "ENVIRONMENT", name: "Bếp nhà Lan", isPrimary: false, useThroughout: false, assetIds: [env.asset.id] });
    const prodRef = await createReference({ projectId: p.id, type: "PRODUCT", name: "Bình Mind", isPrimary: true, useThroughout: false, assetIds: [prod.asset.id] });
    const [s1] = await scenesOf(p.id);
    await setSceneReferences(s1!.id, [envRef.id, prodRef.id]);
    const before = await jobs();
    expect((await compositeOption(s1!.id)).available).toBe(true);
    await enableComposite(s1!.id);
    const scene = await prisma.scene.findUniqueOrThrow({ where: { id: s1!.id } });
    expect(scene).toMatchObject({ imageSource: "IMPORTED", motionSource: "LOCAL_MOTION" });
    expect(parseScenePlan(scene.scenePlanJson)).toMatchObject({ route: "COMPOSITE", source: "USER" });
    const inputs = renderInputsFor(scene);
    expect(inputs.layers?.foregrounds?.length).toBe(1);
    expect(inputs.localCamera).toBeTruthy();
    expect(await jobs()).toEqual(before);
  }, 300_000);
});
