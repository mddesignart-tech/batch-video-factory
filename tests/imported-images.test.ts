import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { ffmpeg, ffprobe } from "@/media/ffmpeg";
import {
  SEED_CHARACTERS,
  SEED_MODELS,
  SEED_PROVIDERS,
  SEED_STYLE_PRESETS,
} from "@/data/seed-config";
import { setSpendCap } from "@/services/spend-guard";
import { approveAuthorization } from "@/services/batch-authorization";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { preflightImportedBatch } from "@/services/import-preflight";
import {
  generateSceneImage,
  generateSceneVideo,
  generateSceneVoice,
  videoKeyVariant,
} from "@/services/generation";
import {
  framingFor,
  importSceneImage,
  inspectImageBytes,
  ImportImageError,
  removeSceneImage,
  useExistingImportedAsset,
} from "@/services/imported-image";
import { planSceneImageMapping } from "@/domain/scene-image-mapping";
import { stageUpload, StagingError } from "@/services/import-staging";
import { completeJob, failJob } from "@/jobs/queue";
import { runJob } from "@/jobs/handlers";

/**
 * IMPORT STORYBOARD / BATCH FROM SCENES - the rule, tested end to end:
 *
 *   IMPORTED IMAGE = REUSE = $0 IMAGE API COST
 *
 * Every scenario the operator named (A-I, the cost test, resume after a failed
 * render) runs on the real import path with real PNGs made by FFmpeg, mock
 * providers and a throwaway database. "Image API POST" is measured the only
 * way that cannot lie: by counting image ProviderJob rows before and after.
 */

let tmp = "";
let PORTRAIT: Buffer;
let LANDSCAPE: Buffer;

async function png(width: number, height: number, colour: string): Promise<Buffer> {
  const file = path.join(tmp, `${colour}-${width}x${height}.png`);
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=${width}x${height}`, "-frames:v", "1", file]);
  return fs.readFileSync(file);
}

async function dims(relative: string): Promise<string> {
  const { stdout } = await ffprobe([
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x", toAbsolute(relative),
  ]);
  return stdout.trim();
}

const imageJobs = () => prisma.providerJob.count({ where: { kind: "image" } });
const videoJobs = () => prisma.providerJob.count({ where: { kind: "video" } });
const voiceJobs = () => prisma.providerJob.count({ where: { kind: "audio" } });

interface SceneSpec {
  image?: Buffer | string | null;
  motion?: "LOCAL_MOTION" | "VIDEO_AI";
  fit?: string;
}

let counter = 0;
async function importVideo(scenes: SceneSpec[]) {
  counter += 1;
  const root = path.join(tmp, `batch-${counter}`);
  const dir = path.join(root, `video-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  const rows = scenes.map((spec, i) => {
    const n = i + 1;
    let imageFile: string | undefined;
    if (Buffer.isBuffer(spec.image)) {
      imageFile = `scene-0${n}.png`;
      fs.writeFileSync(path.join(dir, imageFile), spec.image);
    } else if (typeof spec.image === "string") {
      imageFile = spec.image;
    }
    return {
      scene_number: n,
      duration: 4,
      visual_description: `Max stands against a plain wall, shot ${n}.`,
      character_action: "Max blinks once and holds still.",
      camera: "Locked static medium shot, no camera movement.",
      dialogue: `Max: "Line ${n}."`,
      subtitle: `Line ${n}.`,
      motion_mode: spec.motion ?? "LOCAL_MOTION",
      priority: spec.motion === "VIDEO_AI" ? "HIGH" : "LOW",
      ...(imageFile ? { image_file: imageFile } : {}),
      ...(spec.fit ? { image_fit: spec.fit } : {}),
    };
  });
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({
      video_id: `v${counter}`,
      video_title: `Imported ${counter}`,
      characters: [{ character_id: "max", character_name: "Max" }],
      scenes: rows,
    }),
  );
  const validated = await validateImport(scanImportSource(root));
  const created = await materialiseImport(validated, {
    batchName: `imported-${counter}`,
    maxCostPerVideo: 5,
    maxCostForBatch: 10,
  });
  const pre = await preflightImportedBatch(created.batchId);
  const projectId = created.projects[0]!.projectId;
  const sceneRows = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
  return { batchId: created.batchId, projectId, pre, scenes: sceneRows, validated };
}

async function generateAll(projectId: string): Promise<void> {
  const scenes = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
  for (const s of scenes) {
    await generateSceneImage(s.id);
    await generateSceneVideo(s.id);
    await generateSceneVoice(s.id);
  }
}

async function renderOnce(projectId: string): Promise<void> {
  const job = await prisma.job.create({
    data: { type: "render_final", projectId, status: "processing", attempts: 1, maxAttempts: 1, payloadJson: "{}" },
  });
  for (let i = 0; i < 20; i += 1) {
    const fresh = (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })) as Job;
    try {
      const outcome = await runJob(fresh);
      if (!outcome.deferred) {
        await completeJob(job.id, outcome.result);
        return;
      }
    } catch (err) {
      await failJob(job.id, err);
      throw err;
    }
  }
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imported-images-"));
  PORTRAIT = await png(1080, 1920, "blue");
  LANDSCAPE = await png(1920, 1080, "red");
  await setSpendCap(50);
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
    await prisma.stylePreset.upsert({
      where: { slug: preset.slug },
      create: { ...preset, aspectRatio: "9:16" },
      update: {},
    });
  }
  for (const character of SEED_CHARACTERS) {
    await prisma.character.upsert({
      where: { name: character.name },
      create: { ...character, voiceProvider: "mock", enabled: true },
      update: {},
    });
  }
}, 120_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("A/B — preflight đếm đúng số POST ảnh", () => {
  it("A: 5 cảnh, 5 ảnh nhập -> Image API POST = 0, tiền ảnh $0, 5 IMPORTED", async () => {
    const { pre } = await importVideo(Array.from({ length: 5 }, () => ({ image: PORTRAIT })));
    expect(pre.counts.imagePosts).toBe(0);
    expect(pre.counts.imageBuy).toBe(0);
    expect(pre.counts.imageImported).toBe(5);
    expect(pre.counts.imageReuse).toBe(5);
    expect(pre.videos[0]!.breakdown.image).toBe(0);
    expect(pre.videos[0]!.scenes.map((s) => s.imageSource)).toEqual(Array(5).fill("IMPORTED"));
  });

  it("B: 3 nhập + 2 thiếu -> Image API POST = 2, không phải 5", async () => {
    const { pre } = await importVideo([
      { image: PORTRAIT },
      { image: null },
      { image: PORTRAIT },
      { image: null },
      { image: PORTRAIT },
    ]);
    expect(pre.counts.imagePosts).toBe(2);
    expect(pre.counts.imageImported).toBe(3);
    expect(pre.videos[0]!.scenes.map((s) => s.imageSource)).toEqual([
      "IMPORTED",
      "WILL_CREATE",
      "IMPORTED",
      "WILL_CREATE",
      "IMPORTED",
    ]);
    expect(pre.videos[0]!.breakdown.image).toBeGreaterThan(0);
  });
});

describe("chi phí — nhập 5 ảnh, 4 LOCAL_MOTION + 1 VIDEO_AI", () => {
  it("chỉ tính giọng + 1 clip + dự phòng, KHÔNG cộng tiền ảnh", async () => {
    const { pre } = await importVideo([
      { image: PORTRAIT },
      { image: PORTRAIT },
      { image: PORTRAIT, motion: "VIDEO_AI" },
      { image: PORTRAIT },
      { image: PORTRAIT },
    ]);
    const b = pre.videos[0]!.breakdown;
    expect(b.image).toBe(0);
    expect(pre.counts.imagePosts).toBe(0);
    expect(pre.counts.videoPosts).toBe(1);
    expect(pre.counts.voicePosts).toBe(5);
    expect(pre.totalLocalMotion).toBe(4);
    expect(pre.totalVideoAi).toBe(1);
    // Every dollar is accounted for by something that is not an image.
    const nonImage = b.text + b.video + b.voice + b.render + b.quality + b.retries;
    expect(Math.abs(pre.videos[0]!.estimatedCost - nonImage)).toBeLessThan(1e-6);
  });
});

describe("C/D — sinh media với ảnh nhập", () => {
  it("C: ảnh nhập + LOCAL_MOTION -> 0 job ảnh, 0 job video", async () => {
    const { projectId, batchId } = await importVideo(
      Array.from({ length: 3 }, () => ({ image: PORTRAIT, motion: "LOCAL_MOTION" as const })),
    );
    await approveAuthorization({ batchId, authorizedMaxSpend: 5 });
    const [i0, v0] = [await imageJobs(), await videoJobs()];
    await generateAll(projectId);
    expect(await imageJobs()).toBe(i0);
    expect(await videoJobs()).toBe(v0);
  });

  it("D: ảnh nhập + VIDEO_AI -> 0 job ảnh, đúng 1 job video, clip dựng TỪ ảnh nhập", async () => {
    const { projectId, batchId, scenes } = await importVideo([
      { image: PORTRAIT, motion: "VIDEO_AI" },
      { image: PORTRAIT },
    ]);
    await approveAuthorization({ batchId, authorizedMaxSpend: 5 });
    const [i0, v0] = [await imageJobs(), await videoJobs()];
    await generateAll(projectId);
    expect(await imageJobs()).toBe(i0);
    expect(await videoJobs()).toBe(v0 + 1);
    const after = await prisma.scene.findUniqueOrThrow({ where: { id: scenes[0]!.id } });
    expect(after.imagePath).toBe(scenes[0]!.imagePath);
    expect(after.imageSource).toBe("IMPORTED");
    expect(after.videoPath).toBeTruthy();
  });
});

describe("VIDEO_AI chỉ chạy khi keyframe tồn tại", () => {
  it("ảnh nhập của cảnh VIDEO_AI bị xoá khỏi đĩa -> DỪNG, 0 job ảnh, 0 job video", async () => {
    const { batchId, scenes } = await importVideo([{ image: PORTRAIT, motion: "VIDEO_AI" }]);
    await approveAuthorization({ batchId, authorizedMaxSpend: 5 });
    fs.rmSync(toAbsolute(scenes[0]!.imagePath!), { force: true });
    const [i0, v0] = [await imageJobs(), await videoJobs()];
    // The image step refuses to buy a stand-in for a supplied picture...
    await expect(generateSceneImage(scenes[0]!.id)).rejects.toThrow();
    // ...and the clip step, reached anyway, sends nothing without a keyframe.
    await expect(generateSceneVideo(scenes[0]!.id)).rejects.toThrow();
    expect(await imageJobs()).toBe(i0);
    expect(await videoJobs()).toBe(v0);
    const pre = await preflightImportedBatch(batchId);
    expect(pre.videos[0]!.scenes[0]!.imageSource).toBe("MISSING");
    expect(pre.counts.imagePosts).toBe(0);
  });
});

describe("E — resume sau khi render hỏng", () => {
  it("ảnh nhập giữ nguyên, delta POST ảnh/video/giọng = 0, rồi render ra MP4", async () => {
    const { projectId, batchId } = await importVideo([
      { image: PORTRAIT },
      { image: PORTRAIT, motion: "VIDEO_AI" },
      { image: LANDSCAPE },
    ]);
    await approveAuthorization({ batchId, authorizedMaxSpend: 5 });
    await generateAll(projectId);
    const before = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });

    // The render "fails": the project and a scene are marked failed, exactly
    // what a crashed FFmpeg step leaves behind. Media on disk is untouched.
    await prisma.project.update({ where: { id: projectId }, data: { status: "failed", errorMessage: "render failed (simulated)" } });
    await prisma.scene.update({ where: { id: before[1]!.id }, data: { status: "failed" } });

    const [i0, v0, a0, c0] = [await imageJobs(), await videoJobs(), await voiceJobs(), await prisma.costEntry.count()];
    const spent0 = (await prisma.costEntry.aggregate({ where: { projectId }, _sum: { amount: true } }))._sum.amount ?? 0;
    await generateAll(projectId);
    await renderOnce(projectId);

    expect(await imageJobs()).toBe(i0);
    expect(await videoJobs()).toBe(v0);
    expect(await voiceJobs()).toBe(a0);
    expect(await prisma.costEntry.count()).toBe(c0);
    const spent1 = (await prisma.costEntry.aggregate({ where: { projectId }, _sum: { amount: true } }))._sum.amount ?? 0;
    expect(spent1).toBe(spent0);

    const after = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
    for (const [i, s] of after.entries()) {
      // A resume is not a retry: bumping retryCount would change every key and
      // buy the clip again.
      expect(s.retryCount).toBe(before[i]!.retryCount);
      expect(s.imageAssetId).toBe(before[i]!.imageAssetId);
      expect(s.imagePath).toBe(before[i]!.imagePath);
      expect(s.imageSource).toBe("IMPORTED");
    }
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.finalVideoPath).toBeTruthy();
    expect(fs.existsSync(toAbsolute(project.finalVideoPath!))).toBe(true);
  }, 300_000);
});

describe("F — thay ảnh", () => {
  it("ảnh nhập mới thành ảnh đang dùng; ảnh cũ còn; clip cũ bị bỏ và khoá clip đổi", async () => {
    const { projectId, batchId, scenes } = await importVideo([{ image: PORTRAIT, motion: "VIDEO_AI" }]);
    await approveAuthorization({ batchId, authorizedMaxSpend: 5 });
    await generateAll(projectId);
    const scene = await prisma.scene.findUniqueOrThrow({ where: { id: scenes[0]!.id } });
    expect(scene.videoPath).toBeTruthy();
    const oldKey = videoKeyVariant(scene);

    const replaced = await importSceneImage({
      sceneId: scene.id,
      bytes: await png(1080, 1920, "green"),
      originalFilename: "scene-01-v2.png",
    });
    expect(replaced.clipDropped).toBe(true);
    const after = await prisma.scene.findUniqueOrThrow({ where: { id: scene.id } });
    expect(after.imageAssetId).toBe(replaced.stored.asset.id);
    expect(after.imageAssetId).not.toBe(scene.imageAssetId);
    expect(after.imageSource).toBe("IMPORTED");
    expect(after.videoPath).toBeNull();
    expect(videoKeyVariant(after)).not.toBe(oldKey);
    // The earlier picture is history, not garbage.
    expect(await prisma.asset.count({ where: { id: scene.imageAssetId! } })).toBe(1);

    // And it can be brought back.
    const back = await useExistingImportedAsset(scene.id, scene.imageAssetId!);
    expect(back.scene.imageAssetId).toBe(scene.imageAssetId);
  });

  it("bỏ ảnh nhập -> lần sau preflight nói WILL_CREATE", async () => {
    const { batchId, scenes } = await importVideo([{ image: PORTRAIT }, { image: PORTRAIT }]);
    await removeSceneImage(scenes[0]!.id);
    const pre = await preflightImportedBatch(batchId);
    expect(pre.videos[0]!.scenes[0]!.imageSource).toBe("WILL_CREATE");
    expect(pre.counts.imagePosts).toBe(1);
  });
});

describe("G — file không hợp lệ bị từ chối an toàn", () => {
  it("đuôi .exe, PNG giả chứa HTML, PNG bị cắt cụt, file rỗng", async () => {
    const reject = async (bytes: Buffer, name: string, code: string) => {
      await expect(inspectImageBytes(bytes, name)).rejects.toMatchObject({ code });
      await expect(inspectImageBytes(bytes, name)).rejects.toBeInstanceOf(ImportImageError);
    };
    await reject(Buffer.from("MZ"), "virus.exe", "image_extension_not_allowed");
    await reject(Buffer.from("<html><script>alert(1)</script></html>".padEnd(64)), "scene-01.png", "image_not_an_image");
    await reject(PORTRAIT.subarray(0, 64), "scene-01.png", "image_undecodable");
    await reject(Buffer.alloc(0), "scene-01.png", "image_empty");
  });

  it("storyboard trỏ tới PNG giả -> lỗi đích danh cảnh, không tạo gì", async () => {
    const root = path.join(tmp, "fake");
    const dir = path.join(root, "v");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "scene-01.png"), "<?php echo 1; ?>".padEnd(64));
    fs.writeFileSync(
      path.join(dir, "storyboard.json"),
      JSON.stringify({
        video_id: "fake",
        video_title: "fake",
        scenes: [{ scene_number: 1, duration: 4, visual_description: "x", dialogue: "", image_file: "scene-01.png", motion_mode: "LOCAL_MOTION" }],
      }),
    );
    const validated = await validateImport(scanImportSource(root));
    const issue = validated.issues.find((i) => i.code === "image_not_an_image");
    expect(issue?.level).toBe("error");
    expect(issue?.sceneNumber).toBe(1);
  });

  it("staging từ trình duyệt: từ chối ../ và file không phải storyboard", () => {
    expect(() => stageUpload([{ relativePath: "../../evil.png", bytes: PORTRAIT }])).toThrow(StagingError);
    expect(() => stageUpload([{ relativePath: "run.exe", bytes: Buffer.from("MZ") }])).toThrow(StagingError);
    const ok = stageUpload([{ relativePath: "batch/v1/scene-01.png", bytes: PORTRAIT }]);
    expect(fs.existsSync(path.join(ok.source, "batch", "v1", "scene-01.png"))).toBe(true);
    fs.rmSync(ok.source, { recursive: true, force: true });
  });
});

describe("H — mapping sai được báo rõ", () => {
  it("storyboard trỏ tới ảnh không có -> image_missing ở đúng cảnh", async () => {
    const root = path.join(tmp, "missing");
    const dir = path.join(root, "v");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "storyboard.json"),
      JSON.stringify({
        video_id: "m",
        video_title: "m",
        scenes: [{ scene_number: 2, duration: 4, visual_description: "x", image_file: "khong-co.png", motion_mode: "LOCAL_MOTION" }],
      }),
    );
    const v = await validateImport(scanImportSource(root));
    const issue = v.issues.find((i) => i.code === "image_missing");
    expect(issue?.level).toBe("error");
    expect(issue?.sceneNumber).toBe(2);
  });

  it("nhập nhiều file: trùng cảnh -> CONFLICT, cảnh không tồn tại -> NO_SUCH_SCENE, tên vô nghĩa -> UNMAPPED", () => {
    const plan = planSceneImageMapping(
      ["scene-01.png", "scene-02.png", "02-copy.png", "scene-09.png", "holiday.png", "notes.txt"],
      [1, 2, 3],
    );
    const by = Object.fromEntries(plan.files.map((f) => [f.fileName, f.status]));
    expect(by).toEqual({
      "scene-01.png": "MAPPED",
      "scene-02.png": "CONFLICT",
      "02-copy.png": "CONFLICT",
      "scene-09.png": "NO_SUCH_SCENE",
      "holiday.png": "UNMAPPED",
      "notes.txt": "NOT_AN_IMAGE",
    });
    expect(plan.scenesWithoutFile).toEqual([2, 3]);
    expect(plan.complete).toBe(false);
  });
});

describe("I — nhập nhiều lần ổn định", () => {
  it("cùng bộ file, thứ tự khác -> cùng một mapping", () => {
    const names = ["scene-03.png", "scene-01.png", "scene-02.png"];
    const a = planSceneImageMapping(names, [1, 2, 3]);
    const b = planSceneImageMapping([...names].reverse(), [1, 2, 3]);
    expect([...a.bySceneNumber]).toEqual([...b.bySceneNumber]);
    expect([...a.bySceneNumber.keys()]).toEqual([1, 2, 3]);
    expect(a.complete).toBe(true);
  });

  it("cùng một ảnh nhập hai lần vào một dự án -> một file vật lý, hai Asset", async () => {
    const { scenes } = await importVideo([{ image: PORTRAIT }, { image: PORTRAIT }]);
    const assets = await prisma.asset.findMany({
      where: { id: { in: scenes.map((s) => s.imageAssetId!) } },
    });
    expect(assets).toHaveLength(2);
    expect(new Set(assets.map((a) => a.sha256)).size).toBe(1);
    expect(new Set(assets.map((a) => a.filePath)).size).toBe(1);
  });
});

describe("khung hình — không kéo méo, không cắt mất nhân vật", () => {
  it("ảnh ngang 16:9 -> bản làm việc 1080x1920 nền mờ, bản gốc giữ nguyên", async () => {
    const { scenes } = await importVideo([{ image: LANDSCAPE }]);
    const scene = scenes[0]!;
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: scene.imageAssetId! } });
    expect(asset.source).toBe("IMPORTED");
    expect([asset.width, asset.height]).toEqual([1920, 1080]);
    expect(asset.mimeType).toBe("image/png");
    expect(asset.actualCost).toBe(0);
    expect(fs.readFileSync(toAbsolute(asset.filePath))).toEqual(LANDSCAPE);
    expect(scene.imagePath).not.toBe(asset.filePath);
    expect(await dims(scene.imagePath!)).toBe("1080x1920");
  });

  it("ảnh gần 9:16 dùng nguyên; image_fit=cover ép cắt; contain ép giữ nguyên", () => {
    const target = { width: 1080, height: 1920 };
    expect(framingFor(1080, 1920, target)).toBe("as_is");
    expect(framingFor(1024, 1792, target)).toBe("as_is");
    expect(framingFor(1920, 1080, target)).toBe("contain_blur");
    expect(framingFor(1024, 1024, target)).toBe("contain_blur");
    expect(framingFor(1920, 1080, target, "cover")).toBe("cover");
    expect(framingFor(1080, 1920, target, "contain")).toBe("contain_blur");
  });
});

describe("V1 không đổi", () => {
  it("cảnh không có ảnh nhập giữ đúng khoá clip cũ -> không mua lại clip V1", () => {
    expect(videoKeyVariant({ duration: 5 })).toBe("5s");
    expect(videoKeyVariant({ duration: 5, imageAssetId: null })).toBe("5s");
    expect(videoKeyVariant({ duration: 5, imageAssetId: "abc" })).toBe("5s|img:abc");
  });
});
