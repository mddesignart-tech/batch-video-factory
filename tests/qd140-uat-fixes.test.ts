import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { prisma } from "@/lib/prisma";
import { profileFromPlatform } from "@/domain/platform-profile";
import { shownSceneEstimate } from "@/domain/user-clip";
import { LOGO_INVISIBLE_MESSAGE, logoInvisible } from "@/domain/logo-overlay";
import { autoAssignReferencesAction, setSceneReferencesAction, updateReferenceAction } from "@/app/actions/references";
import { resumeWatchKey } from "@/app/batches/[id]/use-batch-progress";
import { approveContentScript, createContentProject } from "@/services/content-service";
import { createReference, sceneExcludedReferenceIds, sceneManualReferences, sceneReferenceIds } from "@/services/reference-assets";
import { planProjectScenes } from "@/services/scene-plan-service";
import { previewProjectCost, startMediaGeneration } from "@/services/project-service";
import { batchProgress, storedPlan } from "@/services/batch-runner";
import { batchStyleApplies } from "@/services/batch-sources";
import { uploadClipToScene } from "@/services/uploaded-clip";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { bareProject, ledgerSnapshot, makeMp4, makePng, seedMock } from "./phase5-helpers";

/**
 * QĐ-140: the UAT 2026-10-17 leftovers (P2/P3). Mock only, $0 - no Text /
 * Image / Video / Voice request is made by anything here.
 */

let tmp = "";
let capBefore = 0;

async function toyProject(idea: string) {
  const project = await createContentProject({
    contentType: "TOY_WORLD",
    sourceType: "PROMPT",
    idea,
    durationSeconds: 30,
    voiceMode: "NARRATION",
    outputProfile: profileFromPlatform("TIKTOK"),
  });
  const scenes = await prisma.scene.findMany({ where: { projectId: project.id }, orderBy: { sceneNumber: "asc" } });
  expect(scenes.length).toBeGreaterThanOrEqual(3);
  return { projectId: project.id, sceneIds: scenes.map((s) => s.id) };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qd140-"));
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
}, 120_000);

afterAll(async () => {
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("P2-1 REFERENCE_MANUAL_EXCLUDE", () => {
  let projectId = "";
  let sceneIds: string[] = [];
  let productId = "";
  const scene = (i: number) => prisma.scene.findUniqueOrThrow({ where: { id: sceneIds[i]! } });
  const lists = async () =>
    (await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } })).map((s) => sceneReferenceIds(s));

  beforeAll(async () => {
    ({ projectId, sceneIds } = await toyProject("Chai nước cam của Mia trên bàn"));
    for (const id of sceneIds) {
      await prisma.scene.update({
        where: { id },
        data: { referenceIdsJson: "[]", motionMode: "LOCAL_MOTION", motionSource: "LOCAL_MOTION", imageSource: "GENERATED", imagePath: null, videoPath: null },
      });
    }
    const png = fs.readFileSync(await makePng(tmp, "orange", "900x900"));
    productId = (
      await createReference({ projectId, type: "PRODUCT", name: "Chai nước cam", useThroughout: true, uploads: [{ bytes: png, filename: "bottle.png" }] })
    ).id;
    await autoAssignReferencesAction(projectId);
    for (const l of await lists()) expect(l).toContain(productId);
  }, 120_000);

  it("bỏ tay ở cảnh 2 → ghi EXCLUDE; gán tự động không ghi quyết định tay", async () => {
    expect(sceneManualReferences(await scene(0))).toEqual({});
    const r = await setSceneReferencesAction(projectId, sceneIds[1]!, []);
    expect(r.ok).toBe(true);
    expect(sceneReferenceIds(await scene(1))).toEqual([]);
    expect(sceneManualReferences(await scene(1))).toEqual({ [productId]: "EXCLUDE" });
    expect(sceneManualReferences(await scene(0))).toEqual({});
  });

  it("tắt rồi bật lại “Xuyên suốt video” → không gắn lại vào cảnh đã bỏ tay; cảnh khác vẫn có", async () => {
    expect((await updateReferenceAction(projectId, productId, { useThroughout: false })).ok).toBe(true);
    expect((await updateReferenceAction(projectId, productId, { useThroughout: true })).ok).toBe(true);
    const l = await lists();
    expect(l[1]).toEqual([]);
    for (const [i, list] of l.entries()) if (i !== 1) expect(list).toContain(productId);
  });

  it("TỰ GẮN (cảnh trống) cũng không gắn lại tham chiếu đã bỏ tay", async () => {
    const r = await autoAssignReferencesAction(projectId);
    expect(r.ok).toBe(true);
    expect((await lists())[1]).toEqual([]);
  });

  it("kế hoạch cảnh (scene plan) không coi tham chiếu xuyên suốt là có mặt ở cảnh đã bỏ tay", async () => {
    await planProjectScenes(projectId);
    const plan2 = (await scene(1)).scenePlanJson ?? "";
    const plan1 = (await scene(0)).scenePlanJson ?? "";
    expect(plan1).toContain(productId);
    expect(plan2).not.toContain(productId);
  });

  it("tích lại bằng tay → INCLUDE, thắng EXCLUDE trước đó", async () => {
    expect((await setSceneReferencesAction(projectId, sceneIds[1]!, [productId])).ok).toBe(true);
    const s = await scene(1);
    expect(sceneReferenceIds(s)).toEqual([productId]);
    expect(sceneManualReferences(s)).toEqual({ [productId]: "INCLUDE" });
    expect(sceneExcludedReferenceIds(s).size).toBe(0);
  });

  it("không âm thầm làm cũ ảnh GENERATED: bật xuyên suốt ở cảnh đã có ảnh + đã bỏ tay → ảnh giữ nguyên, không hỏi", async () => {
    expect((await setSceneReferencesAction(projectId, sceneIds[2]!, [])).ok).toBe(true);
    await prisma.scene.update({ where: { id: sceneIds[2]! }, data: { imagePath: "images/made.png", imageSource: "GENERATED" } });
    const money = await ledgerSnapshot();
    expect((await updateReferenceAction(projectId, productId, { useThroughout: false })).ok).toBe(true);
    const on = await updateReferenceAction(projectId, productId, { useThroughout: true });
    expect(on.ok).toBe(true);
    // Excluded by hand: not "held" (nothing to ask about), not added, picture kept.
    expect(on.message).not.toMatch(/Cảnh 3 đã có ảnh tạo sẵn/);
    const s = await scene(2);
    expect(sceneReferenceIds(s)).toEqual([]);
    expect(s.imagePath).toBe("images/made.png");
    expect(await ledgerSnapshot()).toEqual(money);
  });
});

describe("P3-1 STYLE_PANEL_CONTEXT + P2-2 BATCH_PROGRESS_REFRESH", () => {
  let projectId = "";
  let batchId = "";

  beforeAll(async () => {
    ({ projectId } = await toyProject("Robot gỗ đi dạo trong vườn"));
    await approveContentScript(projectId);
    const started = await startMediaGeneration(projectId);
    batchId = started.batchId!;
  }, 300_000);

  it("dự án đơn bọc thành lô 1 video: có kế hoạch nhưng KHÔNG hiện phong cách lô", async () => {
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(storedPlan(batch)).not.toBeNull(); // the condition that showed the idiom card
    expect(await batchStyleApplies(batchId)).toBe(false);
  });

  it("lô thành ngữ (dự án sinh từ danh sách thành ngữ của lô) vẫn hiện phong cách lô", async () => {
    const p = await bareProject("qd140 idiom batch");
    const batch = await prisma.batch.create({
      data: { name: "QĐ-140 idiom", amount: 1, qualityMode: "BALANCED", targetDuration: 20, maxBudget: 1, maxCostPerVideo: 1, status: "PLANNED", idiomIdsJson: JSON.stringify([p.idiomId]) },
    });
    await prisma.project.update({ where: { id: p.id }, data: { batchId: batch.id } });
    expect(await batchStyleApplies(batch.id)).toBe(true);
  });

  it("bảng tiếp tục riêng theo dõi tiến trình lô: khoá đổi khi DB đổi, đứng yên khi không", async () => {
    const a = resumeWatchKey((await batchProgress(batchId))!);
    expect(resumeWatchKey((await batchProgress(batchId))!)).toBe(a);
    const first = await prisma.scene.findFirstOrThrow({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
    await prisma.scene.update({ where: { id: first.id }, data: { imagePath: "images/x.png", status: "completed" } });
    const b = resumeWatchKey((await batchProgress(batchId))!);
    expect(b).not.toBe(a);
    await prisma.project.update({ where: { id: projectId }, data: { status: "generating_media" } });
    expect(resumeWatchKey((await batchProgress(batchId))!)).not.toBe(b);
  });

  it("trang lô truyền khoá + trạng thái chạy cho bảng tiếp tục riêng (không đứng yên khi lô chạy)", () => {
    const view = fs.readFileSync(path.join(process.cwd(), "src/app/batches/[id]/batch-progress-view.tsx"), "utf8");
    expect(view).toMatch(/<VideoResumePanel[^>]*watchKey=\{resumeWatchKey\(progress\)\}[^>]*batchRunning=/);
    const panel = fs.readFileSync(path.join(process.cwd(), "src/app/batches/[id]/video-resume-panel.tsx"), "utf8");
    expect(panel).toMatch(/\[load, watchKey\]/);
    expect(panel).toMatch(/\|\| batchRunning/);
  });
});

describe("P3-2 SCENE_COST_REFRESH", () => {
  it("cảnh chuyển từ Video AI sang Video của bạn: giá hiển thị là giá sống, không còn $0.22; DB/ledger không đổi", async () => {
    const { projectId, sceneIds } = await toyProject("Gấu bông nhảy trên giường");
    await prisma.scene.update({ where: { id: sceneIds[0]! }, data: { estimatedCost: 0.22, motionMode: "VIDEO_AI", motionSource: "VIDEO_AI" } });
    const money = await ledgerSnapshot();
    const clip = fs.readFileSync(await makeMp4(tmp, "blue", 2));
    await uploadClipToScene({ sceneId: sceneIds[0]!, bytes: clip, originalFilename: "my-clip.mp4" });

    const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneIds[0]! } });
    expect(scene.videoSource).toBe("UPLOADED");
    expect(scene.estimatedCost).toBe(0.22); // stored figure untouched - display only
    const preview = await previewProjectCost(projectId);
    const live = preview.current.scenes.find((p) => p.sceneNumber === scene.sceneNumber);
    expect(live).toBeDefined();
    expect(live!.video).toBeFalsy(); // no Video AI for a user clip
    const shown = shownSceneEstimate(scene, live!.estimatedCost);
    expect(shown).toBe(live!.estimatedCost);
    expect(shown).toBeLessThan(0.22);
    const after = await ledgerSnapshot();
    expect(after.costEntries).toEqual(money.costEntries);
    expect(after.providerJobs).toEqual(money.providerJobs);
  }, 120_000);

  it("cảnh không dùng clip giữ giá đã lưu; thiếu dự toán sống thì clip = $0", () => {
    expect(shownSceneEstimate({ videoSource: "GENERATED", estimatedCost: 0.22 }, 0.01)).toBe(0.22);
    expect(shownSceneEstimate({ videoSource: "UPLOADED", estimatedCost: 0.22 }, undefined)).toBe(0);
  });
});

describe("P3-3 LOGO_OPACITY_WARNING", () => {
  it("độ rõ 0% → cảnh báo; > 0% → không; vẫn lưu được (chỉ cảnh báo)", () => {
    expect(LOGO_INVISIBLE_MESSAGE).toBe("Logo đang hoàn toàn trong suốt và sẽ không nhìn thấy trong video.");
    expect(logoInvisible(0)).toBe(true);
    expect(logoInvisible(0.004)).toBe(true); // the slider shows 0%
    expect(logoInvisible(0.01)).toBe(false);
    expect(logoInvisible(0.88)).toBe(false);
    const section = fs.readFileSync(path.join(process.cwd(), "src/app/projects/[id]/logo-overlay-section.tsx"), "utf8");
    expect(section).toMatch(/logoInvisible\(logo\.opacity\) \? <Alert tone="warn" title=\{LOGO_INVISIBLE_MESSAGE\}/);
  });
});
