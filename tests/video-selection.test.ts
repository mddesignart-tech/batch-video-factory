import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma } from "@/lib/prisma";
import { ffmpeg } from "@/media/ffmpeg";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { preflightImportedBatch } from "@/services/import-preflight";
import { generateSceneVideo, videoModelChoices } from "@/services/generation";
import { chooseVideoModel, makeSceneVideo, skipVideoAi, useLocalMotion } from "@/services/scene-video";
import { isNeedsSelection, NEEDS_SELECTION_STATUS, splitNeedsSelection } from "@/domain/video-selection";
import { FriendlyReason } from "@/components/friendly-reason";

/**
 * VIDEO MODEL NEEDS_SELECTION (QĐ-120). Mock providers only: $0, no paid POST.
 * "No AUTO model" is produced the way production meets it - the registry
 * labels (PIN_ONLY, DEPRECATED) - never by weakening the router.
 */

let tmp = "";
let capBefore = 0;
let seq = 0;
const tag = randomUUID().slice(0, 8);
let lifecyclesBefore: { id: string; lifecycle: string; enabled: boolean }[] = [];

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
      update: { enabled: true, reliability: "OK", price: model.price },
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

/** One VIDEO_AI scene on an imported keyframe, made HIGH complexity. */
async function importHighScene(): Promise<{ batchId: string; projectId: string; sceneId: string }> {
  seq += 1;
  const dir = path.join(tmp, `sb-${seq}`, "v");
  fs.mkdirSync(dir, { recursive: true });
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${["red", "blue", "green"][seq % 3]}:s=1080x1920`, "-frames:v", "1", path.join(dir, "k.png")]);
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({
      video_id: `sel-${tag}-${seq}`,
      video_title: `sel-${seq}`,
      characters: [{ character_id: "max", character_name: "Max" }],
      scenes: [
        {
          scene_number: 1,
          duration: 3,
          visual_description: `Max runs and jumps across rooftops, shot ${tag}-${seq}.`,
          character_action: "Max leaps.",
          camera: "Tracking shot.",
          dialogue: `Max: "Jump ${tag} ${seq}."`,
          subtitle: "Jump.",
          image_file: "k.png",
          motion_mode: "VIDEO_AI",
          priority: "HIGH",
        },
      ],
    }),
  );
  const validated = await validateImport(scanImportSource(path.join(tmp, `sb-${seq}`)));
  expect(validated.issues.filter((i) => i.level === "error")).toEqual([]);
  const created = await materialiseImport(validated, { batchName: `sel-${tag}-${seq}`, maxCostPerVideo: 5, maxCostForBatch: 50 });
  const projectId = created.projects[0]!.projectId;
  const scene = await prisma.scene.findFirstOrThrow({ where: { projectId, sceneNumber: 1 } });
  await prisma.scene.update({ where: { id: scene.id }, data: { complexity: "HIGH" } });
  return { batchId: created.batchId, projectId, sceneId: scene.id };
}

const videoJobs = (sceneId: string) => prisma.providerJob.count({ where: { sceneId, kind: "video" } });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "video-selection-"));
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
  // Production's situation, in the registry: nothing is cleared for AUTO.
  // Every video model, whatever other test files left in the registry: only
  // the three mock ones stay on, and none of them is cleared for AUTO.
  const all = await prisma.modelRegistry.findMany({ where: { type: "video" } });
  lifecyclesBefore = all.map((m) => ({ id: m.id, lifecycle: m.lifecycle, enabled: m.enabled }));
  const kept = ["mock-video-lite", "mock-video-std", "mock-video-pro"];
  for (const m of all) {
    if (!(m.provider === "mock" && kept.includes(m.modelId))) await prisma.modelRegistry.update({ where: { id: m.id }, data: { enabled: false } });
  }
  await prisma.modelRegistry.update({ where: { provider_modelId: { provider: "mock", modelId: "mock-video-lite" } }, data: { lifecycle: "DEPRECATED" } });
  await prisma.modelRegistry.updateMany({ where: { provider: "mock", type: "video", modelId: { in: ["mock-video-std", "mock-video-pro"] } }, data: { lifecycle: "PIN_ONLY" } });
}, 120_000);

afterAll(async () => {
  for (const m of lifecyclesBefore) await prisma.modelRegistry.update({ where: { id: m.id }, data: { lifecycle: m.lifecycle, enabled: m.enabled } });
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("QĐ-120 — không có model AUTO: cần chọn, không phải lỗi", () => {
  it("không model AUTO → NEEDS_SELECTION (không FAILED), PIN_ONLY không tự gọi, 0 POST; chẩn đoán vẫn còn", async () => {
    const { sceneId } = await importHighScene();
    await expect(generateSceneVideo(sceneId)).rejects.toThrow(/VIDEO_MODEL_NEEDS_SELECTION/);
    const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
    expect(scene.status).toBe(NEEDS_SELECTION_STATUS);
    expect(scene.status).not.toBe("failed");
    expect(await videoJobs(sceneId)).toBe(0);
    // Technical diagnostics kept (collapsed in the UI, never thrown away).
    const { summary, detail } = splitNeedsSelection(scene.errorMessage!);
    expect(summary).toMatch(/không có model Video AI nào hiện đủ điều kiện chạy tự động/);
    expect(summary).toMatch(/HIGH/);
    expect(summary).not.toMatch(/PIN_ONLY|DEPRECATED/);
    expect(detail).toMatch(/mock\/mock-video-std \(PIN_ONLY\)/);
    expect(detail).toMatch(/mock\/mock-video-lite \(DEPRECATED\)/);
  });

  it("preflight: video chặn bằng một câu NEEDS_SELECTION; UI mặc định không hiện khối lý do từ chối của router", async () => {
    const { batchId } = await importHighScene();
    const pre = await preflightImportedBatch(batchId);
    const reason = pre.videos[0]!.blockedReason!;
    expect(isNeedsSelection(reason)).toBe(true);
    const html = renderToStaticMarkup(createElement(FriendlyReason, { reason, tone: "danger" }));
    const [visible, collapsed] = html.split("<details");
    expect(visible).toMatch(/Có cảnh cần chọn model Video AI/);
    expect(visible).not.toMatch(/PIN_ONLY|mock-video-std/);
    expect(collapsed).toMatch(/Xem chi tiết kỹ thuật/);
    expect(collapsed).toMatch(/mock-video-std/);
  });

  it("danh sách chọn tay: PIN_ONLY chọn được (giá, thời gian chờ, lý do không AUTO); DEPRECATED không phải lựa chọn", async () => {
    const { sceneId } = await importHighScene();
    const { choices } = await videoModelChoices(sceneId);
    const std = choices.find((c) => c.model === "mock-video-std")!;
    expect(std.selectable).toBe(true);
    expect(std.estimatedCost).toBeGreaterThan(0);
    expect(std.expectedWait).toBeTruthy();
    expect(std.notAutoReason).toMatch(/chọn tay/);
    const lite = choices.find((c) => c.model === "mock-video-lite")!;
    expect(lite.selectable).toBe(false);
    expect(lite.unavailableReason).toBeTruthy();
    await expect(chooseVideoModel(sceneId, "mock", "mock-video-lite")).rejects.toThrow(/Không chọn được/);
    expect(await videoJobs(sceneId)).toBe(0);
  });

  it("chọn PIN_ONLY → hỏi giá; huỷ / giá đổi → 0 POST; xác nhận + double-click → đúng 1 paid job", async () => {
    const { sceneId } = await importHighScene();
    await generateSceneVideo(sceneId).catch(() => undefined);
    const choice = await chooseVideoModel(sceneId, "mock", "mock-video-std");
    const pinned = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
    expect(pinned).toMatchObject({ videoModelPinned: true, videoProvider: "mock", videoModel: "mock-video-std", errorMessage: null });
    expect(pinned.status).not.toBe(NEEDS_SELECTION_STATUS);

    const ask = await makeSceneVideo(sceneId);
    expect(ask.status).toBe("NEEDS_CONFIRMATION");
    expect(ask.choice!.estimatedCost).toBe(choice.estimatedCost);
    // "Huỷ" = never confirming: nothing sent.
    expect(await videoJobs(sceneId)).toBe(0);
    const stale = await makeSceneVideo(sceneId, { confirmPaid: true, expectedCost: (choice.estimatedCost ?? 0) + 1 });
    expect(stale.status).toBe("BLOCKED");
    expect(stale.message).toMatch(/PLAN_CHANGED/);
    expect(await videoJobs(sceneId)).toBe(0);

    const both = await Promise.all([
      makeSceneVideo(sceneId, { confirmPaid: true, expectedCost: choice.estimatedCost! }),
      makeSceneVideo(sceneId, { confirmPaid: true, expectedCost: choice.estimatedCost! }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual(["ALREADY_RUNNING", "DONE"]);
    expect(await videoJobs(sceneId)).toBe(1);
    expect((await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } })).videoPath).toBeTruthy();
    // Again: the clip exists - no second POST.
    await makeSceneVideo(sceneId, { confirmPaid: true, expectedCost: choice.estimatedCost! });
    expect(await videoJobs(sceneId)).toBe(1);
  });

  it("LOCAL MOTION / BỎ QUA VIDEO AI → 0 video API POST", async () => {
    for (const pick of [useLocalMotion, skipVideoAi]) {
      const { sceneId } = await importHighScene();
      await generateSceneVideo(sceneId).catch(() => undefined);
      await pick(sceneId);
      const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
      expect(scene.motionMode).toBe("LOCAL_MOTION");
      expect(scene.status).not.toBe(NEEDS_SELECTION_STATUS);
      expect(await generateSceneVideo(sceneId)).toBeNull();
      expect(await videoJobs(sceneId)).toBe(0);
      expect((await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } })).status).toBe("video_ready");
    }
  });

  it("dự án cũ ghim model đã bị tắt: 'Model cũ không còn khả dụng', không tự đổi model, 0 POST", async () => {
    const { sceneId } = await importHighScene();
    await chooseVideoModel(sceneId, "mock", "mock-video-pro");
    await prisma.modelRegistry.update({ where: { provider_modelId: { provider: "mock", modelId: "mock-video-pro" } }, data: { lifecycle: "DISABLED" } });
    try {
      await expect(generateSceneVideo(sceneId)).rejects.toThrow(/model cũ mock\/mock-video-pro không còn khả dụng/);
      const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
      expect(scene.status).toBe(NEEDS_SELECTION_STATUS);
      expect(scene.videoModel).toBe("mock-video-pro"); // nothing swapped in
      const r = await makeSceneVideo(sceneId, { confirmPaid: true, expectedCost: 1 });
      expect(r.status).toBe("NEEDS_SELECTION");
      expect(await videoJobs(sceneId)).toBe(0);
    } finally {
      await prisma.modelRegistry.update({ where: { provider_modelId: { provider: "mock", modelId: "mock-video-pro" } }, data: { lifecycle: "PIN_ONLY" } });
    }
  });
});
