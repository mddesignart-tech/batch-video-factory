import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { prisma } from "@/lib/prisma";
import { profileFromPlatform } from "@/domain/platform-profile";
import { autoAssignReferencesAction, setSceneReferencesAction, updateReferenceAction } from "@/app/actions/references";
import { approveContentScript, createContentProject } from "@/services/content-service";
import { changeReference, createReference, projectReferenceAssets, referenceProblems, sceneReferenceIds } from "@/services/reference-assets";
import { startMediaGeneration } from "@/services/project-service";
import { approveAndRun } from "@/services/batch-executor";
import { continueVideo } from "@/services/video-resume";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { makePng, seedMock } from "./phase5-helpers";

/**
 * Reference assignment safety: a hand-made assignment is never cut or replaced
 * by an automatic pass or a toggle, and a picture that was already made is
 * never made stale without the person saying yes first. Mock only, $0.
 */

let tmp = "";
let capBefore = 0;
const pics: Buffer[] = [];
let projectId = "";
let truckId = "";
let ballId = "";
let sceneIds: string[] = [];

const lists = async () =>
  (await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } })).map((s) => sceneReferenceIds(s));
const pictures = async () =>
  (await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } })).map((s) => [s.imagePath, s.videoPath]);
const jobs = () => prisma.providerJob.count({ where: { projectId } });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ref-safety-"));
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
  for (const c of ["red", "green", "blue"]) pics.push(fs.readFileSync(await makePng(tmp, c, "900x900")));

  const project = await createContentProject({
    contentType: "TOY_WORLD",
    sourceType: "PROMPT",
    idea: "Xe tải vàng của Ben và quả bóng đỏ",
    durationSeconds: 30,
    voiceMode: "NARRATION",
    outputProfile: profileFromPlatform("TIKTOK"),
  });
  projectId = project.id;
  const scenes = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
  expect(scenes.length).toBeGreaterThanOrEqual(3);
  sceneIds = scenes.map((s) => s.id);
  // Known words per scene: 1 names nothing, 2 the truck, 3 truck + ball.
  const words = ["Con mèo ngủ trên ghế", "Chiếc xe tải chạy qua cát", "Xe tải và quả bóng trên sân"];
  for (const [i, s] of scenes.entries()) {
    const text = words[i] ?? "Bầu trời xanh trong";
    await prisma.scene.update({
      where: { id: s.id },
      data: { visualDescription: text, narration: text, dialogue: "", subtitle: text, imagePrompt: text, referenceIdsJson: "[]", motionMode: "LOCAL_MOTION", motionSource: "LOCAL_MOTION" },
    });
  }
  truckId = (await createReference({ projectId, type: "TOY", name: "Xe tải vàng của Ben", aliases: ["xe tải"], uploads: [{ bytes: pics[0]!, filename: "truck.png" }] })).id;
  ballId = (await createReference({ projectId, type: "OBJECT", name: "Quả bóng đỏ", aliases: ["quả bóng"], uploads: [{ bytes: pics[1]!, filename: "ball.png" }] })).id;
}, 120_000);

afterAll(async () => {
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("REFERENCE ASSIGNMENT SAFETY", () => {
  it("A. cảnh chưa có tham chiếu → tự gắn theo nội dung", async () => {
    const r = await autoAssignReferencesAction(projectId);
    expect(r.ok).toBe(true);
    const l = await lists();
    expect(l[0]).toEqual([]);
    expect(l[1]).toEqual([truckId]);
    expect(l[2]!.sort()).toEqual([truckId, ballId].sort());
  });

  it("B. cảnh đã gắn tay → tự gắn lại không ghi đè", async () => {
    // By hand: scene 3 shows only the ball, scene 1 shows the ball.
    expect((await setSceneReferencesAction(projectId, sceneIds[2]!, [ballId])).ok).toBe(true);
    expect((await setSceneReferencesAction(projectId, sceneIds[0]!, [ballId])).ok).toBe(true);
    const before = await lists();
    const r = await autoAssignReferencesAction(projectId);
    expect(r.message).toMatch(/gắn tay giữ nguyên/);
    expect(await lists()).toEqual(before);
    expect((await lists())[2]).toEqual([ballId]);
  });

  it("C. bật “Xuyên suốt video” → thêm vào cảnh còn thiếu, các gán tay khác vẫn giữ", async () => {
    const before = await lists();
    expect((await updateReferenceAction(projectId, truckId, { useThroughout: true })).ok).toBe(true);
    const after = await lists();
    for (const [i, l] of after.entries()) {
      // Scene 3 had the truck removed by hand in B: that decision wins (QĐ-140).
      if (i === 2) expect(l).not.toContain(truckId);
      else expect(l).toContain(truckId);
      for (const id of before[i]!) expect(l).toContain(id); // nothing removed
    }
    expect(after[0]).toContain(ballId);
    expect(after[2]).toContain(ballId);
  });

  it("D. tắt “Xuyên suốt video” / tắt rồi bật “Đang dùng” → không xoá gán tay; tham chiếu tắt không chặn video", async () => {
    const before = await lists();
    expect((await updateReferenceAction(projectId, truckId, { useThroughout: false })).ok).toBe(true);
    expect(await lists()).toEqual(before);
    expect((await updateReferenceAction(projectId, ballId, { enabled: false })).ok).toBe(true);
    expect(await lists()).toEqual(before);
    expect(await referenceProblems(projectId)).toEqual([]);
    expect((await updateReferenceAction(projectId, ballId, { enabled: true })).ok).toBe(true);
    expect(await lists()).toEqual(before); // back on: the hand-made assignment is still there
  });

  it("E + G. đã có ảnh GENERATED → bật/tắt không làm mất ảnh; chạy lại không mua trùng", async () => {
    await approveContentScript(projectId);
    const started = await startMediaGeneration(projectId);
    await approveAndRun({ batchId: started.batchId!, maxBatch: 5, lowAutoApproved: true, wait: true });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe("completed");
    const shots = await pictures();
    expect(shots.every(([img]) => Boolean(img))).toBe(true);
    const listsBefore = await lists();
    const jobsBefore = await jobs();

    // Ball "throughout" would add it to scenes whose picture was made without it: held, reported.
    const on = await updateReferenceAction(projectId, ballId, { useThroughout: true });
    expect(on.ok).toBe(true);
    const missingBall = listsBefore.map((l, i) => (l.includes(ballId) ? null : i + 1)).filter((n): n is number => n !== null);
    expect(missingBall.length).toBeGreaterThan(0);
    expect(on.message).toMatch(new RegExp(`Cảnh ${missingBall.join(", ")} đã có ảnh tạo sẵn nên giữ nguyên`));
    expect(await lists()).toEqual(listsBefore);
    expect(await pictures()).toEqual(shots);
    expect((await updateReferenceAction(projectId, ballId, { useThroughout: false })).ok).toBe(true);
    expect((await updateReferenceAction(projectId, truckId, { enabled: false })).ok).toBe(true);
    expect((await updateReferenceAction(projectId, truckId, { enabled: true })).ok).toBe(true);
    expect(await autoAssignReferencesAction(projectId)).toMatchObject({ ok: true });
    expect(await lists()).toEqual(listsBefore);
    expect(await pictures()).toEqual(shots);

    // Ticking a reference on a scene with a made picture asks first; nothing is saved.
    const ask = await setSceneReferencesAction(projectId, sceneIds[1]!, [truckId, ballId]);
    expect(ask).toMatchObject({ ok: false, confirm: true });
    expect(ask.message).toMatch(/Cảnh 2 đã có ảnh tạo sẵn.*Chưa lưu gì/);
    expect(await lists()).toEqual(listsBefore);
    expect(await pictures()).toEqual(shots);

    // G: resume / render again buys nothing.
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe("completed");
    await continueVideo(projectId, { wait: true });
    expect(await jobs()).toBe(jobsBefore);
    expect(await pictures()).toEqual(shots);
  }, 600_000);

  it("F. đổi ảnh chính của tham chiếu → báo trước cảnh nào cần ảnh mới; chỉ đổi khi xác nhận; mua đúng số đó, không trùng", async () => {
    await changeReference(truckId, { uploads: [{ bytes: pics[2]!, filename: "truck-v2.png" }] });
    const ref = (await projectReferenceAssets(projectId)).find((r) => r.id === truckId)!;
    const v2 = ref.images.find((i) => i.filename === "truck-v2.png")!;
    const shots = await pictures();
    const showing = (await lists()).map((l, i) => (l.includes(truckId) ? i + 1 : null)).filter((n): n is number => n !== null);

    const ask = await updateReferenceAction(projectId, truckId, { primaryAssetId: v2.assetId });
    expect(ask).toMatchObject({ ok: false, confirm: true });
    expect(ask.message).toMatch(new RegExp(`Cảnh ${showing.join(", ")} đã có ảnh tạo sẵn.*Chưa lưu gì`));
    expect(await pictures()).toEqual(shots);
    const still = (await projectReferenceAssets(projectId)).find((r) => r.id === truckId)!;
    expect(still.version).toBe(ref.version);
    expect(still.images.find((i) => i.primary)?.assetId).not.toBe(v2.assetId);

    const yes = await updateReferenceAction(projectId, truckId, { primaryAssetId: v2.assetId }, { confirm: true });
    expect(yes.ok).toBe(true);
    expect(yes.message).toMatch(new RegExp(`Chỉ cảnh ${showing.join(", ")} cần ảnh mới`));
    const after = await pictures();
    for (const [i, [img]] of after.entries()) {
      if (showing.includes(i + 1)) expect(img).toBeNull();
      else expect(img).toBe(shots[i]![0]);
    }

    const jobsBefore = await jobs();
    expect((await continueVideo(projectId, { wait: true, confirmPaid: true })).status).toBe("COMPLETED");
    // Exactly one new picture per stale scene - nothing else is bought.
    expect((await jobs()) - jobsBefore).toBe(showing.length);
    const once = await jobs();
    await continueVideo(projectId, { wait: true });
    expect(await jobs()).toBe(once);
  }, 600_000);
});
