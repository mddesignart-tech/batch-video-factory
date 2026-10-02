import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { ffmpeg, probeDimensions } from "@/media/ffmpeg";
import { buildSceneNormalizeArgs } from "@/media/render";
import { buildASS } from "@/media/subtitles";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import {
  effectiveFit,
  generationAspectFor,
  PLATFORM_PRESETS,
  profileFromPlatform,
  resolveProfile,
  subtitleSafeArea,
  validateProfile,
} from "@/domain/platform-profile";
import { renderSettingsFrom } from "@/services/output-layout";
import { createProjectForIdiom } from "@/services/project-service";
import { projectFormat, setOutputProfile, adoptShapeForNewAssets } from "@/services/output-profile";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { approveAndRun } from "@/services/batch-executor";
import { preflightImportedBatch } from "@/services/import-preflight";
import { continueVideo } from "@/services/video-resume";
import { generateSceneVideo } from "@/services/generation";
import { isNeedsSelection, splitNeedsSelection } from "@/domain/video-selection";

/**
 * "Bạn muốn đăng video ở đâu?" - platform presets and the project output
 * profile (QĐ-121). Mock providers + local FFmpeg only: $0, no paid POST.
 * A paid request is counted from the ledger (one line per create) and from
 * ProviderJob rows - what was really sent.
 */

let tmp = "";
let capBefore = 0;
let seq = 0;
const tag = randomUUID().slice(0, 8);

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
    await prisma.character.upsert({ where: { name: character.name }, create: { ...character, voiceProvider: "mock", enabled: true }, update: {} });
  }
}

async function png(colour: string, w: number, h: number): Promise<Buffer> {
  const file = path.join(tmp, `${colour}-${randomUUID()}.png`);
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=${w}x${h}`, "-frames:v", "1", file]);
  return fs.readFileSync(file);
}

/** Imported pictures + LOCAL_MOTION + a spoken line: only voice is a paid API, and it is mock. */
async function importVideo(scenes: number): Promise<{ batchId: string; projectId: string }> {
  seq += 1;
  const dir = path.join(tmp, `sb-${seq}`, "v");
  fs.mkdirSync(dir, { recursive: true });
  const picture = await png(["red", "blue", "green"][seq % 3]!, 1080, 1920);
  const rows = Array.from({ length: scenes }, (_, i) => {
    fs.writeFileSync(path.join(dir, `s${i + 1}.png`), picture);
    return {
      scene_number: i + 1,
      duration: 2,
      visual_description: `Max stands against a plain wall, shot ${i + 1}.`,
      character_action: "Max holds still.",
      camera: "Locked static medium shot.",
      dialogue: `Max: "Frame ${tag} ${seq} ${i + 1}."`,
      subtitle: `Frame ${i + 1}.`,
      image_file: `s${i + 1}.png`,
      motion_mode: "LOCAL_MOTION",
      priority: "NORMAL",
    };
  });
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({ video_id: `pp-${tag}-${seq}`, video_title: `pp-${seq}`, characters: [{ character_id: "max", character_name: "Max" }], scenes: rows }),
  );
  const validated = await validateImport(scanImportSource(path.join(tmp, `sb-${seq}`)));
  expect(validated.issues.filter((i) => i.level === "error")).toEqual([]);
  const created = await materialiseImport(validated, { batchName: `pp-${tag}-${seq}`, maxCostPerVideo: 5, maxCostForBatch: 50 });
  return { batchId: created.batchId, projectId: created.projects[0]!.projectId };
}

const paid = async () => ({
  jobs: await prisma.providerJob.count(),
  ledger: await prisma.costEntry.count({ where: { category: { in: ["image", "video", "voice"] } } }),
});

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "platform-profile-"));
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
}, 120_000);

afterAll(async () => {
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ----------------------------------------------------------------- pure ---

describe("QĐ-121 — nền tảng → khung (thuần)", () => {
  it("A–F: TikTok / Shorts / Reels / FB Reels = 1080x1920 9:16 30fps; YouTube 1920x1080; vuông 1080x1080; Feed 1080x1350", () => {
    const want: Record<string, [number, number]> = {
      TIKTOK: [1080, 1920],
      YOUTUBE_SHORTS: [1080, 1920],
      INSTAGRAM_REELS: [1080, 1920],
      FACEBOOK_REELS: [1080, 1920],
      YOUTUBE_LANDSCAPE: [1920, 1080],
      SQUARE: [1080, 1080],
      INSTAGRAM_FEED: [1080, 1350],
    };
    for (const [id, [w, h]] of Object.entries(want)) {
      const p = profileFromPlatform(id as never);
      expect([p.width, p.height, p.fps, p.fit]).toEqual([w, h, 30, "AUTO"]);
    }
    // One engine behind the four vertical platforms.
    const vertical = PLATFORM_PRESETS.filter((p) => p.shape === "VERTICAL_SHORT_9_16").map((p) => p.id);
    expect(vertical.sort()).toEqual(["FACEBOOK_REELS", "INSTAGRAM_REELS", "TIKTOK", "YOUTUBE_SHORTS"]);
    expect(generationAspectFor(1080, 1920)).toBe("9:16");
    expect(generationAspectFor(1920, 1080)).toBe("16:9");
    expect(generationAspectFor(1080, 1350)).toBe("4:5");
    expect(generationAspectFor(1000, 1000)).toBe("1:1");
  });

  it("Tùy chỉnh: nhận kích thước chẵn hợp lệ, từ chối số lẻ / ngoài phạm vi bằng câu dễ hiểu", () => {
    expect(validateProfile(profileFromPlatform("CUSTOM", { width: 1280, height: 720, fps: 25 }))).toMatchObject({ ok: true, profile: { width: 1280, height: 720, fps: 25 } });
    expect(validateProfile({ ...profileFromPlatform("CUSTOM"), width: 1081 })).toMatchObject({ ok: false, message: expect.stringMatching(/số chẵn/) });
    expect(validateProfile({ ...profileFromPlatform("CUSTOM"), height: 9000 })).toMatchObject({ ok: false });
  });

  it("không kéo méo: Lấp đầy = chuỗi lệnh cũ y hệt; Hiện toàn bộ = ảnh nguyên trên nền mờ; Tự động chọn theo độ lệch khung", () => {
    const common = { videoInput: "a.png", audioInput: null, duration: 2, target: { width: 1080, height: 1920, fps: 30 }, output: "o.mp4" };
    const cover = buildSceneNormalizeArgs(common).join(" ");
    expect(buildSceneNormalizeArgs({ ...common, fit: "COVER" }).join(" ")).toBe(cover);
    // V1's chain, byte for byte - segment cache and render recipes stay valid.
    expect(cover).toContain("[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=");
    const contain = buildSceneNormalizeArgs({ ...common, fit: "CONTAIN" }).join(" ");
    expect(contain).toContain("force_original_aspect_ratio=decrease");
    expect(contain).toContain("overlay=(W-w)/2:(H-h)/2");
    // Every scale keeps the aspect ratio (no bare scale=W:H that would stretch).
    for (const args of [cover, contain]) expect(args).not.toMatch(/scale=\d+:\d+(?!:force_original_aspect_ratio)[,;\]]/);
    const vertical = { width: 1080, height: 1920 };
    expect(effectiveFit("AUTO", { width: 1024, height: 1536 }, vertical)).toBe("COVER"); // 2:3 in 9:16, V1 behaviour
    expect(effectiveFit("AUTO", { width: 1920, height: 1080 }, vertical)).toBe("CONTAIN"); // would cut 2/3
    expect(effectiveFit("COVER", { width: 1920, height: 1080 }, vertical)).toBe("COVER");
  });

  it("J: phụ đề trong vùng an toàn theo khung; 9:16 giữ đúng số của V1; chỉnh tay ở Nâng cao", () => {
    expect(subtitleSafeArea(1080, 1920)).toEqual({ marginV: 384, marginL: 81, marginR: 81 });
    expect(subtitleSafeArea(1920, 1080).marginV).toBe(86);
    expect(subtitleSafeArea(1080, 1080).marginV).toBe(108);
    expect(subtitleSafeArea(1080, 1920, 30).marginV).toBe(576);
    const cue = [{ startSeconds: 0, endSeconds: 1, text: "Hi" }];
    const vertical = buildASS(cue, { width: 1080, height: 1920 });
    expect(vertical).toContain(",2,81,81,384,1");
    const wide = buildASS(cue, { width: 1920, height: 1080 });
    expect(wide).toContain("PlayResX: 1920");
    expect(wide).toContain(",2,144,144,86,1");
  });

  it("L: dự án cũ (chưa có profile) suy ra từ tỷ lệ / preset lô, không ghi gì vào DB", () => {
    expect(resolveProfile({ stored: null, aspectRatio: "9:16" })).toMatchObject({ platform: "TIKTOK", width: 1080, height: 1920, inferred: true });
    expect(resolveProfile({ stored: null, aspectRatio: "16:9" })).toMatchObject({ platform: "YOUTUBE_LANDSCAPE", width: 1920, height: 1080 });
    expect(resolveProfile({ stored: null, aspectRatio: "1:1" })).toMatchObject({ platform: "SQUARE" });
    expect(resolveProfile({ stored: null, aspectRatio: "4:5" })).toMatchObject({ platform: "INSTAGRAM_FEED" });
    expect(resolveProfile({ stored: null, aspectRatio: "9:16", batchPresetSize: { width: 1280, height: 720, fps: 30 } })).toMatchObject({ platform: "CUSTOM" });
    // The render of a project without a profile is exactly what it was.
    const settings = { defaultOutputPresetId: "youtube-shorts", customPresets: [], burnSubtitles: true };
    const legacy = renderSettingsFrom({ aspectRatio: "9:16" }, null, settings);
    expect(legacy.render).toEqual({ target: { width: 1080, height: 1920, fps: 30 }, burnSubtitles: true });
    const landscape = renderSettingsFrom({ aspectRatio: "9:16", outputProfileJson: JSON.stringify(profileFromPlatform("YOUTUBE_LANDSCAPE")) }, null, settings);
    expect(landscape.render.target).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(landscape.aspectNote).toMatch(/không tạo lại ảnh\/clip, \$0/);
  });
});

// ------------------------------------------------------------- database ---

describe("QĐ-121 — tạo dự án theo nền tảng; đổi định dạng không mua lại", () => {
  it("tạo dự án TikTok / YouTube ngang: khung tạo ảnh/clip và khung xuất đi theo nền tảng", async () => {
    const idiom = await prisma.idiom.create({
      data: { phrase: `Piece ${tag}`, slug: `piece-${tag}`, meaning: "easy", literalMeaning: "cake", exampleSentence: "It was a piece of cake.", category: "test" },
    });
    for (const [platform, w, h, aspect] of [["TIKTOK", 1080, 1920, "9:16"], ["YOUTUBE_LANDSCAPE", 1920, 1080, "16:9"], ["INSTAGRAM_FEED", 1080, 1350, "4:5"]] as const) {
      const project = await createProjectForIdiom({ idiomId: idiom.id, qualityMode: "ECONOMY", outputProfile: profileFromPlatform(platform), autoGenerateScript: false });
      expect(project.aspectRatio).toBe(aspect);
      const format = await projectFormat(project.id);
      expect(format.profile).toMatchObject({ platform, width: w, height: h, fps: 30, inferred: false });
      expect(format.outputAspect).toBe(aspect);
    }
  });

  it("G + H + I + M + N + O: 9:16 → 16:9 → đổi kiểu khớp khung: giữ asset, 0 request trả phí, render đúng kích thước, TIẾP TỤC/render lại không mua gì", async () => {
    const v = await importVideo(2);
    await approveAndRun({ batchId: v.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    const done = await prisma.project.findUniqueOrThrow({ where: { id: v.projectId } });
    expect(done.status).toBe("completed");
    expect(await probeDimensions(toAbsolute(done.finalVideoPath!))).toEqual({ width: 1080, height: 1920 });
    const before = await paid();

    // G: 9:16 -> 16:9 with assets: they are kept and fitted, nothing re-bought.
    const change = await setOutputProfile(v.projectId, profileFromPlatform("YOUTUBE_LANDSCAPE"));
    expect(change.assetShapeChanged).toBe(false);
    expect(change.message).toMatch(/Không phát sinh phí API/);
    const after = await prisma.project.findUniqueOrThrow({ where: { id: v.projectId } });
    expect(after.aspectRatio).toBe("9:16"); // the shape assets are MADE in is unchanged
    expect(after.status).toBe("media_ready"); // re-render locally on the next TIẾP TỤC
    // M: every image / clip / voice still reuses - the preflight would buy nothing.
    const pre = await preflightImportedBatch(v.batchId);
    expect(pre.counts.imagePosts + pre.counts.videoPosts + pre.counts.voicePosts).toBe(0);

    // N + I: TIẾP TỤC renders the new frame locally.
    expect((await continueVideo(v.projectId, { wait: true })).status).toBe("COMPLETED");
    const wide = await prisma.project.findUniqueOrThrow({ where: { id: v.projectId } });
    expect(await probeDimensions(toAbsolute(wide.finalVideoPath!))).toEqual({ width: 1920, height: 1080 });

    // H: change the fit mode only: a different recipe, rendered again, still $0.
    await setOutputProfile(v.projectId, { ...profileFromPlatform("YOUTUBE_LANDSCAPE"), fit: "COVER" });
    expect((await continueVideo(v.projectId, { wait: true })).status).toBe("COMPLETED");
    const covered = await prisma.project.findUniqueOrThrow({ where: { id: v.projectId } });
    expect(covered.renderRecipe).not.toBe(wide.renderRecipe);

    // O: render again with nothing changed: SAME_RENDER_INPUT, no request.
    expect((await continueVideo(v.projectId, { wait: true })).status).toBe("NOOP");
    expect(await paid()).toEqual(before);
  }, 600_000);

  it("chủ động 'Tạo lại asset theo tỷ lệ mới': chỉ đổi khung tạo cho lần chạy sau — CHƯA gửi request nào", async () => {
    const v = await importVideo(1);
    await approveAndRun({ batchId: v.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    await setOutputProfile(v.projectId, profileFromPlatform("SQUARE"));
    const before = await paid();
    const r = await adoptShapeForNewAssets(v.projectId);
    expect(r.aspectRatio).toBe("1:1");
    expect(r.message).toMatch(/CHƯA gửi request/);
    expect(await paid()).toEqual(before);
  }, 300_000);

  it("dự án chưa có ảnh/clip: đổi nền tảng thì ảnh/clip sau này được tạo theo khung mới", async () => {
    const idiom = await prisma.idiom.create({
      data: { phrase: `Fresh ${tag}`, slug: `fresh-${tag}`, meaning: "new", literalMeaning: "new", exampleSentence: "Fresh.", category: "test" },
    });
    const project = await createProjectForIdiom({ idiomId: idiom.id, qualityMode: "ECONOMY", outputProfile: profileFromPlatform("TIKTOK"), autoGenerateScript: false });
    const r = await setOutputProfile(project.id, profileFromPlatform("YOUTUBE_LANDSCAPE"));
    expect(r.assetShapeChanged).toBe(true);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).aspectRatio).toBe("16:9");
  });
});

describe("QĐ-121 — model video không hỗ trợ khung hiện tại (K)", () => {
  it("video ngang chỉ có model dọc → câu dễ hiểu, cần chọn, không crash, 0 request", async () => {
    const all = await prisma.modelRegistry.findMany({ where: { type: "video" } });
    const std = await prisma.modelRegistry.findUniqueOrThrow({ where: { provider_modelId: { provider: "mock", modelId: "mock-video-std" } } });
    const { id: _id, createdAt: _c, updatedAt: _u, ...fields } = std as typeof std & { createdAt?: Date; updatedAt?: Date };
    const portrait = await prisma.modelRegistry.create({ data: { ...fields, modelId: "mock-video-portrait:720x1280", displayName: "Mock portrait 720x1280" } });
    for (const m of all) await prisma.modelRegistry.update({ where: { id: m.id }, data: { enabled: false } });
    try {
      seq += 1;
      const dir = path.join(tmp, `sb-k-${seq}`, "v");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "k.png"), await png("blue", 1920, 1080));
      fs.writeFileSync(
        path.join(dir, "storyboard.json"),
        JSON.stringify({
          video_id: `pp-k-${tag}`,
          video_title: "pp-k",
          characters: [{ character_id: "max", character_name: "Max" }],
          scenes: [{ scene_number: 1, duration: 2, visual_description: `Wide shot ${tag}.`, character_action: "Max waves.", camera: "Static.", dialogue: `Max: "Wide ${tag}."`, subtitle: "Wide.", image_file: "k.png", motion_mode: "VIDEO_AI", priority: "NORMAL" }],
        }),
      );
      const validated = await validateImport(scanImportSource(path.join(tmp, `sb-k-${seq}`)));
      const created = await materialiseImport(validated, { batchName: `pp-k-${tag}`, maxCostPerVideo: 5, maxCostForBatch: 50 });
      const projectId = created.projects[0]!.projectId;
      await prisma.project.update({ where: { id: projectId }, data: { aspectRatio: "16:9", outputProfileJson: JSON.stringify(profileFromPlatform("YOUTUBE_LANDSCAPE")) } });
      const scene = await prisma.scene.findFirstOrThrow({ where: { projectId } });
      const before = await paid();

      // Unpinned: no model can make a landscape clip -> a selection, not a crash.
      await expect(generateSceneVideo(scene.id)).rejects.toThrow(/VIDEO_MODEL_NEEDS_SELECTION/);
      const stopped = await prisma.scene.findUniqueOrThrow({ where: { id: scene.id } });
      expect(isNeedsSelection(stopped.errorMessage)).toBe(true);
      expect(splitNeedsSelection(stopped.errorMessage!).detail).toMatch(/Model video này chưa hỗ trợ video ngang 16:9/);

      // Pinned to the portrait model: says exactly that, in words.
      await prisma.scene.update({ where: { id: scene.id }, data: { videoProvider: "mock", videoModel: portrait.modelId, videoModelPinned: true } });
      await expect(generateSceneVideo(scene.id)).rejects.toThrow(/Model video này chưa hỗ trợ video ngang 16:9/);
      const pinned = await prisma.scene.findUniqueOrThrow({ where: { id: scene.id } });
      expect(splitNeedsSelection(pinned.errorMessage!).summary).toMatch(/^cảnh 1 — Model video này chưa hỗ trợ video ngang 16:9\./);
      expect(await paid()).toEqual(before);
    } finally {
      for (const m of all) await prisma.modelRegistry.update({ where: { id: m.id }, data: { enabled: m.enabled } });
      await prisma.modelRegistry.delete({ where: { id: portrait.id } });
    }
  }, 300_000);
});
