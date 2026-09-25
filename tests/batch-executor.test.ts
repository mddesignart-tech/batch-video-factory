import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { ffmpeg } from "@/media/ffmpeg";
import {
  SEED_CHARACTERS,
  SEED_MODELS,
  SEED_PROVIDERS,
  SEED_STYLE_PRESETS,
} from "@/data/seed-config";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import {
  approveAndRun,
  ExecutorError,
  isRunning,
  preflightForApproval,
  resumeRun,
  startRun,
} from "@/services/batch-executor";
import { batchProgress } from "@/services/batch-runner";
import { existingOutputFor, type OutputMetadata } from "@/services/output-export";
import { videoLifecycle } from "@/domain/video-lifecycle";
import { recentBatches, todayDashboard } from "@/services/dashboard";

/**
 * The production executor behind DUYỆT & CHẠY / TIẾP TỤC - the same code the
 * CLI runs - exercised end to end on mock providers, $0:
 *
 *   A  3 scenes, 3 imported images, LOCAL_MOTION      -> 0 image POST
 *   B  1 imported + 1 missing image + 1 VIDEO_AI      -> exactly 1 image POST
 *   C  3 VIDEO_AI scenes over the per-video ceiling   -> BLOCKED, never run,
 *                                                        and never stops A or B
 */

let tmp = "";
let PNG: Buffer;
let batchId = "";
const ids: Record<string, string> = {};

const count = (kind?: string) => prisma.providerJob.count({ where: kind ? { kind } : {} });

function scene(n: number, over: Record<string, unknown>) {
  return {
    scene_number: n,
    duration: 4,
    visual_description: `Max against a plain wall, shot ${n}.`,
    character_action: "Max blinks once and holds still.",
    camera: "Locked static medium shot, no camera movement.",
    dialogue: `Max: "Line ${n}."`,
    subtitle: `Line ${n}.`,
    motion_mode: "LOCAL_MOTION",
    priority: "LOW",
    ...over,
  };
}

function writeVideo(root: string, id: string, title: string, scenes: Record<string, unknown>[]) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const s of scenes) if (s.image_file) fs.writeFileSync(path.join(dir, String(s.image_file)), PNG);
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({ video_id: id, video_title: title, characters: [{ character_id: "max", character_name: "Max" }], scenes }),
  );
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "executor-"));
  const file = path.join(tmp, "k.png");
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=1080x1920", "-frames:v", "1", file]);
  PNG = fs.readFileSync(file);
  await setSpendCap(20);
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

  // Three storyboards in ONE upload/folder - "chọn nhiều storyboard một lần".
  const root = path.join(tmp, "three");
  writeVideo(root, "a", "Video A", [
    scene(1, { image_file: "a1.png" }),
    scene(2, { image_file: "a2.png" }),
    scene(3, { image_file: "a3.png" }),
  ]);
  writeVideo(root, "b", "Video B", [
    scene(1, { image_file: "b1.png" }),
    scene(2, {}), // no picture -> WILL_CREATE, one image POST
    scene(3, { image_file: "b3.png", motion_mode: "VIDEO_AI", priority: "HIGH" }),
  ]);
  writeVideo(root, "c", "Video C", [
    scene(1, { image_file: "c1.png", motion_mode: "VIDEO_AI", priority: "HIGH", duration: 10 }),
    scene(2, { image_file: "c2.png", motion_mode: "VIDEO_AI", priority: "HIGH", duration: 10 }),
    scene(3, { image_file: "c3.png", motion_mode: "VIDEO_AI", priority: "HIGH", duration: 10 }),
  ]);
  const validated = await validateImport(scanImportSource(root));
  expect(validated.videos).toHaveLength(3);
  const created = await materialiseImport(validated, { batchName: "executor", maxCostPerVideo: 0.25, maxCostForBatch: 5 });
  batchId = created.batchId;
  for (const p of created.projects) ids[p.title] = p.projectId;
}, 180_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("PREFLIGHT (không chi gì)", () => {
  it("nhiều storyboard: ảnh nhập = REUSE, thiếu ảnh = WILL_CREATE, video vượt trần = BLOCKED nhưng không chặn lô", async () => {
    const jobs0 = await count();
    const pre = await preflightForApproval(batchId);
    expect(await count()).toBe(jobs0);
    const byTitle = Object.fromEntries(pre.preflight.videos.map((v) => [v.title, v]));
    expect(byTitle["Video A"]!.lifecycle).toBe("READY");
    expect(byTitle["Video B"]!.lifecycle).toBe("READY");
    expect(byTitle["Video C"]!.lifecycle).toBe("BLOCKED");
    expect(byTitle["Video A"]!.counts.imagePosts).toBe(0);
    expect(byTitle["Video A"]!.breakdown.image).toBe(0);
    expect(byTitle["Video B"]!.scenes.map((s) => s.imageSource)).toEqual(["IMPORTED", "WILL_CREATE", "IMPORTED"]);
    expect(pre.runnableVideos).toBe(2);
    expect(pre.blockedVideos).toBe(1);
    expect(pre.imagePosts).toBe(1);
    // BLOCKED is reported, and is NOT a reason to refuse the batch.
    expect(pre.checks.find((c) => c.label.startsWith("Video C"))?.blocking).toBe(false);
    expect(pre.ready).toBe(true);
  });
});

describe("APPROVAL — người dùng nhập trần, không bao giờ tự nâng", () => {
  it("từ chối trần lô vượt ngân sách toàn cục còn lại, và KHÔNG đổi hạn mức", async () => {
    const before = await spendStatus();
    await expect(approveAndRun({ batchId, maxBatch: before.remaining + 1, lowAutoApproved: false })).rejects.toBeInstanceOf(ExecutorError);
    expect((await spendStatus()).cap).toBe(before.cap);
  });

  it("từ chối trần lô thấp hơn dự toán", async () => {
    const pre = await preflightForApproval(batchId);
    await expect(
      approveAndRun({ batchId, maxBatch: Math.max(0.000001, pre.estimatedTotal / 2), lowAutoApproved: false }),
    ).rejects.toThrow(/Dự toán ≤ trần lô/);
  });

  it("từ chối trần/video thấp hơn dự toán của một video chạy được", async () => {
    await expect(approveAndRun({ batchId, maxBatch: 5, maxPerVideo: 0.000001, lowAutoApproved: false })).rejects.toThrow(/trần\/video/);
  });

  it("từ chối trần 0 và số không hợp lệ", async () => {
    await expect(approveAndRun({ batchId, maxBatch: 0, lowAutoApproved: false })).rejects.toBeInstanceOf(ExecutorError);
    await expect(approveAndRun({ batchId, maxBatch: Number.NaN, lowAutoApproved: false })).rejects.toBeInstanceOf(ExecutorError);
    const auth = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
    expect(auth.status).toBe("DRAFT");
  });
});

describe("DUYỆT & CHẠY — đúng pipeline production", () => {
  let imageBefore = 0;
  let videoBefore = 0;

  it("A và B xong, C bị chặn và không chặn ai; ảnh nhập 0 POST; B đúng 1 POST ảnh", async () => {
    imageBefore = await count("image");
    videoBefore = await count("video");
    const { run } = await approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: false, wait: true });
    expect(run).toBeDefined();
    const by = Object.fromEntries(run!.outcomes.map((o) => [o.title, o]));
    expect(by["Video A"]!.stopped).toBe("");
    expect(by["Video B"]!.stopped).toBe("");
    expect(by["Video C"]!.skipped).toBe(true);

    expect(await count("image")).toBe(imageBefore + 1); // only B's missing picture
    expect(await count("video")).toBe(videoBefore + 1); // only B's VIDEO_AI scene
    expect(await prisma.providerJob.count({ where: { projectId: ids["Video A"] } })).toBeGreaterThan(0); // voice only
    expect(await prisma.providerJob.count({ where: { projectId: ids["Video A"], kind: { in: ["image", "video"] } } })).toBe(0);
    expect(await prisma.providerJob.count({ where: { projectId: ids["Video C"] } })).toBe(0);

    const a = await prisma.project.findUniqueOrThrow({ where: { id: ids["Video A"]! } });
    const c = await prisma.project.findUniqueOrThrow({ where: { id: ids["Video C"]! } });
    expect(a.status).toBe("completed");
    expect(fs.existsSync(toAbsolute(a.finalVideoPath!))).toBe(true);
    expect(c.status).toBe("needs_review");
    expect(await prisma.costReservation.count({ where: { batchId, status: "RESERVED" } })).toBe(0);
  }, 600_000);

  it("output: final.mp4 + thumbnail.jpg + subtitles.srt + metadata.json đủ trường", async () => {
    const a = await prisma.project.findUniqueOrThrow({ where: { id: ids["Video A"]! } });
    const out = existingOutputFor(a);
    expect(out).not.toBeNull();
    for (const f of ["final.mp4", "thumbnail.jpg", "subtitles.srt", "metadata.json"]) {
      expect(fs.existsSync(path.join(out!.dir, f))).toBe(true);
    }
    const meta = JSON.parse(fs.readFileSync(path.join(out!.dir, "metadata.json"), "utf8")) as OutputMetadata;
    expect(meta.title).toBe("Video A");
    expect(meta.duration).toBeGreaterThan(0);
    expect(meta.aspectRatio).toBe("9:16");
    expect([meta.width, meta.height]).toEqual([1080, 1920]);
    expect(meta.sceneCount).toBe(3);
    expect(typeof meta.totalActualCost).toBe("number");
    expect(meta.providers).toContain("import/user-supplied-images");
    expect(meta.providers).toContain("ffmpeg/local-motion");
    expect(meta.description.length).toBeGreaterThan(0);
    expect(meta.createdAt).toMatch(/^\d{4}-/);
  });

  it("không ProviderJob trùng, không CostEntry trùng", async () => {
    const jobs = await prisma.providerJob.findMany({
      where: { projectId: { in: Object.values(ids) } },
      select: { idempotencyKey: true, id: true },
    });
    expect(new Set(jobs.map((j) => j.idempotencyKey)).size).toBe(jobs.length);
    const entries = await prisma.costEntry.findMany({
      where: { projectId: { in: Object.values(ids) } },
      select: { sceneId: true, category: true, provider: true, model: true },
    });
    const keys = entries.map((e) => `${e.sceneId}|${e.category}|${e.provider}|${e.model}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("hàng đợi đọc lifecycle đúng: A/B COMPLETED, C BLOCKED", async () => {
    const progress = await batchProgress(batchId);
    const by = Object.fromEntries(progress!.videos.map((v) => [v.title, v]));
    expect(by["Video A"]!.lifecycle).toBe("COMPLETED");
    expect(by["Video B"]!.lifecycle).toBe("COMPLETED");
    expect(by["Video C"]!.lifecycle).toBe("BLOCKED");
    expect(by["Video A"]!.importedImages).toBe(3);
    expect(by["Video A"]!.output?.resolution).toBe("1080x1920");
    expect(progress!.importBatch).toBe(true);
    expect(progress!.running).toBe(false);
  });
});

describe("TIẾP TỤC — resume không mua lại gì", () => {
  it("chạy lại lô đã xong: 0 ProviderJob, 0 CostEntry, retryCount không đổi", async () => {
    const [jobs0, costs0] = [await count(), await prisma.costEntry.count()];
    const retry0 = await prisma.scene.findMany({ where: { projectId: { in: Object.values(ids) } }, select: { id: true, retryCount: true } });
    await resumeRun({ batchId, wait: true });
    expect(await count()).toBe(jobs0);
    expect(await prisma.costEntry.count()).toBe(costs0);
    const retry1 = await prisma.scene.findMany({ where: { id: { in: retry0.map((r) => r.id) } }, select: { id: true, retryCount: true } });
    for (const r of retry1) expect(r.retryCount).toBe(retry0.find((x) => x.id === r.id)!.retryCount);
  }, 300_000);

  it("chỉ render hỏng: resume render lại từ asset có sẵn, không gọi provider", async () => {
    const b = ids["Video B"]!;
    await prisma.project.update({ where: { id: b }, data: { status: "failed", errorMessage: "render: simulated", finalVideoPath: null } });
    const jobs0 = await count();
    const costs0 = await prisma.costEntry.count();
    await resumeRun({ batchId, onlyProjectIds: [b], wait: true });
    expect(await count()).toBe(jobs0);
    expect(await prisma.costEntry.count()).toBe(costs0);
    const after = await prisma.project.findUniqueOrThrow({ where: { id: b } });
    expect(after.status).toBe("completed");
    expect(fs.existsSync(toAbsolute(after.finalVideoPath!))).toBe(true);
  }, 300_000);

  it("không thể chạy đôi một lô", async () => {
    const run = startRun(batchId, { resume: true });
    expect(isRunning(batchId)).toBe(true);
    expect(startRun(batchId, { resume: true })).toBe(run);
    await expect(resumeRun({ batchId })).rejects.toThrow(/đang chạy/);
    await run;
    expect(isRunning(batchId)).toBe(false);
  }, 300_000);

  it("resume lô chưa duyệt bị từ chối", async () => {
    const root = path.join(tmp, "draft");
    writeVideo(root, "d", "Video D", [scene(1, { image_file: "d1.png" })]);
    const created = await materialiseImport(await validateImport(scanImportSource(root)), {
      batchName: "draft",
      maxCostPerVideo: 1,
      maxCostForBatch: 1,
    });
    await expect(resumeRun({ batchId: created.batchId })).rejects.toThrow(/chưa được duyệt/);
  });
});

describe("lifecycle + dashboard", () => {
  it("lifecycle suy ra từ trạng thái, không lưu", () => {
    expect(videoLifecycle({ projectStatus: "script_ready", authorizationStatus: null, planStatus: null })).toBe("DRAFT");
    expect(videoLifecycle({ projectStatus: "script_ready", authorizationStatus: "DRAFT", planStatus: null })).toBe("PREFLIGHT");
    expect(videoLifecycle({ projectStatus: "script_ready", authorizationStatus: "DRAFT", planStatus: "OK" })).toBe("READY");
    expect(videoLifecycle({ projectStatus: "script_ready", authorizationStatus: "APPROVED", planStatus: "OK" })).toBe("APPROVED");
    expect(videoLifecycle({ projectStatus: "script_ready", authorizationStatus: "DRAFT", planStatus: "OVER_VIDEO_BUDGET" })).toBe("BLOCKED");
    expect(videoLifecycle({ projectStatus: "media_generating", authorizationStatus: "APPROVED", planStatus: "OK" })).toBe("RUNNING");
    expect(videoLifecycle({ projectStatus: "rendering", authorizationStatus: "APPROVED", planStatus: "OK" })).toBe("RENDERING");
    expect(videoLifecycle({ projectStatus: "completed", authorizationStatus: "COMPLETED", planStatus: "OK" })).toBe("COMPLETED");
    expect(videoLifecycle({ projectStatus: "failed", authorizationStatus: "APPROVED", planStatus: "OK" })).toBe("FAILED");
  });

  it("dashboard hôm nay đếm video xong và lô gần đây", async () => {
    const day = await todayDashboard();
    expect(day.videosCompleted).toBeGreaterThanOrEqual(2);
    expect(day.globalCap).toBe((await spendStatus()).cap);
    const rows = await recentBatches(20);
    const row = rows.find((r) => r.id === batchId)!;
    expect(row.videos).toBe(3);
    expect(row.completed).toBe(2);
    expect(row.blocked).toBe(1);
  });
});
