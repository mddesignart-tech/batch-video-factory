import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { ffmpeg } from "@/media/ffmpeg";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import { buildAssetReuseKey, normalizeText, reuseKeyKind, REUSE_KEY_VERSION } from "@/domain/asset-reuse-key";
import { fileSha256 } from "@/services/asset-content";
import { attachReusedAsset, findReusableAsset } from "@/services/asset-reuse";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { approveAndRun, runBatch } from "@/services/batch-executor";
import { approveAuthorization } from "@/services/batch-authorization";
import { preflightImportedBatch, type ImportPreflight } from "@/services/import-preflight";
import { generateSceneVideo, generateSceneVoice } from "@/services/generation";
import { buildVideoResumePlan, continueVideo } from "@/services/video-resume";
import { SEGMENT_CACHE_DIR } from "@/media/segment-cache";

/**
 * V1.2 Phase 4 - asset reuse (QĐ-112). Mock providers only: $0, no paid POST.
 * Every "0 POST" below is counted from ProviderJob rows - what was really sent -
 * not from what a plan says.
 */

let tmp = "";
let RED: Buffer;
let BLUE: Buffer;
let GREEN: Buffer;
let capBefore = 0;
let seq = 0;
let scopeBefore: string | undefined;

async function png(colour: string): Promise<Buffer> {
  const file = path.join(tmp, `${colour}-${randomUUID()}.png`);
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=1080x1920`, "-frames:v", "1", file]);
  return fs.readFileSync(file);
}

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

interface SceneSpec {
  image?: { file: string; bytes: Buffer };
  motion: "LOCAL_MOTION" | "VIDEO_AI";
  line: string;
  prompt?: string;
}

/** Write a one-video storyboard folder. The same arguments always produce the same storyboard. */
function writeStoryboard(folder: string, videoId: string, scenes: SceneSpec[]): string {
  const dir = path.join(tmp, folder, "v");
  fs.mkdirSync(dir, { recursive: true });
  const rows = scenes.map((s, i) => {
    if (s.image) fs.writeFileSync(path.join(dir, s.image.file), s.image.bytes);
    return {
      scene_number: i + 1,
      duration: 3,
      visual_description: s.prompt ?? `Max stands against a plain wall, shot ${i + 1}.`,
      character_action: "Max holds still.",
      camera: "Locked static medium shot, no camera movement.",
      dialogue: `Max: "${s.line}"`,
      subtitle: s.line,
      ...(s.image ? { image_file: s.image.file } : {}),
      motion_mode: s.motion,
      priority: "NORMAL",
    };
  });
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({ video_id: videoId, video_title: videoId, characters: [{ character_id: "max", character_name: "Max" }], scenes: rows }),
  );
  return path.join(tmp, folder);
}

async function importFolder(root: string): Promise<{ batchId: string; projectId: string }> {
  seq += 1;
  const validated = await validateImport(scanImportSource(root));
  expect(validated.issues.filter((i) => i.level === "error")).toEqual([]);
  const created = await materialiseImport(validated, { batchName: `reuse-${seq}`, maxCostPerVideo: 5, maxCostForBatch: 50 });
  return { batchId: created.batchId, projectId: created.projects[0]!.projectId };
}

async function jobs(projectId: string) {
  const all = await prisma.providerJob.findMany({ where: { projectId } });
  return {
    image: all.filter((j) => j.kind === "image").length,
    video: all.filter((j) => j.kind === "video").length,
    audio: all.filter((j) => j.kind === "audio").length,
  };
}

const scene = (projectId: string, n: number) => prisma.scene.findFirstOrThrow({ where: { projectId, sceneNumber: n } });
const lineOf = (pre: ImportPreflight, n: number) => pre.videos[0]!.scenes.find((s) => s.sceneNumber === n)!;

beforeAll(async () => {
  // This suite is ABOUT cross-project reuse: the production default (GLOBAL).
  scopeBefore = process.env.ASSET_REUSE_SCOPE;
  process.env.ASSET_REUSE_SCOPE = "GLOBAL";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asset-reuse-"));
  RED = await png("red");
  BLUE = await png("blue");
  GREEN = await png("green");
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
}, 120_000);

afterAll(async () => {
  process.env.ASSET_REUSE_SCOPE = scopeBefore;
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------ keys ---

describe("QĐ-112 — khoá tái sử dụng (thuần, không DB)", () => {
  const base = {
    kind: "video" as const,
    provider: "mock",
    model: "mock-video-std",
    prompt: "Locked shot of Max.",
    durationSeconds: 3,
    width: 1080,
    height: 1920,
    fps: 30,
    keyframeHash: "a".repeat(64),
  };

  it("có phiên bản, xác định, không phụ thuộc thứ tự trường", () => {
    const k = buildAssetReuseKey(base);
    expect(k).toMatch(new RegExp(`^reuse:${REUSE_KEY_VERSION}:video:[0-9a-f]{64}$`));
    expect(buildAssetReuseKey({ ...base })).toBe(k);
    const shuffled = Object.fromEntries(Object.entries(base).reverse()) as typeof base;
    expect(buildAssetReuseKey(shuffled)).toBe(k);
    expect(reuseKeyKind(k)).toBe("video");
    expect(reuseKeyKind("reuse:v1:video:zz")).toBeNull();
  });

  it("A–D (âm): keyframe / prompt / model / thời lượng khác → khoá khác", () => {
    const k = buildAssetReuseKey(base);
    expect(buildAssetReuseKey({ ...base, keyframeHash: "b".repeat(64) })).not.toBe(k);
    expect(buildAssetReuseKey({ ...base, prompt: "Slow push-in on Max." })).not.toBe(k);
    expect(buildAssetReuseKey({ ...base, model: "mock-video-pro" })).not.toBe(k);
    expect(buildAssetReuseKey({ ...base, durationSeconds: 4 })).not.toBe(k);
    expect(buildAssetReuseKey({ ...base, keyframeHash: null })).not.toBe(k);
  });

  it("chuẩn hoá NHẸ: khoảng trắng thì bỏ, dấu câu thì giữ ('Hello!' ≠ 'Hello?')", () => {
    expect(normalizeText("  Hello   world!\r\n")).toBe("Hello world!");
    const voice = { kind: "audio" as const, provider: "mock", model: "mock-voice-std", voiceId: "v", text: "Hello!" };
    expect(buildAssetReuseKey({ ...voice, text: " Hello! " })).toBe(buildAssetReuseKey(voice));
    expect(buildAssetReuseKey({ ...voice, text: "Hello?" })).not.toBe(buildAssetReuseKey(voice));
    expect(buildAssetReuseKey({ ...voice, text: "hello!" })).not.toBe(buildAssetReuseKey(voice));
    expect(buildAssetReuseKey({ ...voice, speed: 1.2 })).not.toBe(buildAssetReuseKey(voice));
  });

  it("M: phiên bản nhân vật khác → khoá ảnh khác", () => {
    const img = { kind: "image" as const, provider: "mock", model: "mock-image-fast", prompt: "Max", width: 1, height: 1, referenceHashes: [] };
    expect(buildAssetReuseKey({ ...img, characterVersions: ["Max@1"] })).not.toBe(
      buildAssetReuseKey({ ...img, characterVersions: ["Max@2"] }),
    );
  });

  it("Q/R: danh tính là NỘI DUNG — cùng tên khác byte ≠, khác tên cùng byte =", () => {
    const a = path.join(tmp, "same-name-1", "x.png");
    const b = path.join(tmp, "same-name-2", "x.png");
    const c = path.join(tmp, "other-name.png");
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.writeFileSync(a, RED);
    fs.writeFileSync(b, BLUE);
    fs.writeFileSync(c, RED);
    expect(fileSha256(a)).not.toBe(fileSha256(b));
    expect(fileSha256(a)).toBe(fileSha256(c));
  });
});

// ------------------------------------------------- import the same twice ---

describe("QĐ-112 — nhập cùng storyboard lần hai (S · A · C · H · U · V · W · Y)", () => {
  // s1 imported + LOCAL · s2 imported + VIDEO_AI · s3 GENERATED picture + VIDEO_AI
  let root = "";
  let first = { batchId: "", projectId: "" };
  let second = { batchId: "", projectId: "" };

  beforeAll(async () => {
    root = writeStoryboard("sb-twice", "reuse-twice", [
      { image: { file: "a.png", bytes: RED }, motion: "LOCAL_MOTION", line: "One." },
      { image: { file: "b.png", bytes: BLUE }, motion: "VIDEO_AI", line: "Two." },
      { motion: "VIDEO_AI", line: "Three.", prompt: "Max waves at a plain green wall." },
    ]);
    first = await importFolder(root);
    await approveAndRun({ batchId: first.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: first.projectId } })).status).toBe("completed");
    expect(await jobs(first.projectId)).toEqual({ image: 1, video: 2, audio: 3 });
  }, 600_000);

  it("S + W: preflight lần hai — 0 POST ảnh/clip/giọng, tăng thêm $0, tiết kiệm > 0, kể cả khi trần video cực thấp", async () => {
    second = await importFolder(root);
    await prisma.project.update({ where: { id: second.projectId }, data: { maxBudget: 0.0001 } });
    const pre = await preflightImportedBatch(second.batchId);
    expect(pre.counts.imagePosts).toBe(0);
    expect(pre.counts.videoPosts).toBe(0);
    expect(pre.counts.voicePosts).toBe(0);
    expect(pre.estimatedTotal).toBe(0);
    expect(pre.videos[0]!.lifecycle).toBe("READY");
    expect(pre.savings.video).toBeGreaterThan(0);
    expect(pre.savings.image).toBeGreaterThan(0);
    expect(pre.savings.voice).toBeGreaterThan(0);
    expect(pre.ifCreatedNew).toBeCloseTo(pre.estimatedTotal + pre.savings.total, 6);
    expect(lineOf(pre, 1).reuseFrom.image).toBe("IMPORTED");
    expect(lineOf(pre, 2).reuseFrom.video).toBe("CACHE");
    expect(lineOf(pre, 3).reuseFrom.image).toBe("CACHE");
    expect(lineOf(pre, 3).reuseFrom.video).toBe("CACHE");
    expect(lineOf(pre, 1).plan.video).toBe("NONE"); // LOCAL: not a saving
  });

  it("S + V + A + C + H: chạy lần hai — 0 ProviderJob, 0 CostEntry/reservation mới, sổ lần một không đổi, ảnh nhập được hardlink", async () => {
    const ledgerFirst = await prisma.costEntry.findMany({ where: { projectId: first.projectId }, orderBy: { id: "asc" } });
    const jobsBefore = await prisma.providerJob.count();
    await approveAndRun({ batchId: second.batchId, maxBatch: 0.01, lowAutoApproved: true, wait: true });
    const p2 = await prisma.project.findUniqueOrThrow({ where: { id: second.projectId } });
    expect(p2.status).toBe("completed");
    expect(fs.existsSync(toAbsolute(p2.finalVideoPath!))).toBe(true);
    expect(await prisma.providerJob.count()).toBe(jobsBefore);
    expect(await jobs(second.projectId)).toEqual({ image: 0, video: 0, audio: 0 });
    expect(await prisma.costEntry.count({ where: { projectId: second.projectId } })).toBe(0);
    expect(await prisma.costReservation.count({ where: { projectId: second.projectId } })).toBe(0);
    // V: the first run's ledger is byte-for-byte what it was.
    expect(await prisma.costEntry.findMany({ where: { projectId: first.projectId }, orderBy: { id: "asc" } })).toEqual(ledgerFirst);

    const reused = await prisma.asset.findMany({ where: { projectId: second.projectId, source: "REUSED" } });
    expect(reused.filter((a) => a.kind === "image")).toHaveLength(1);
    expect(reused.filter((a) => a.kind === "video")).toHaveLength(2);
    expect(reused.filter((a) => a.kind === "audio")).toHaveLength(3);
    for (const a of reused) {
      expect(a.actualCost).toBe(0);
      expect(a.reusedFromAssetId).toBeTruthy();
      // Its own file (a link), inside ITS project: deleting project 1 cannot take it.
      expect(a.filePath).toContain(second.projectId);
      expect(fileSha256(toAbsolute(a.filePath))).toBe(a.sha256);
    }
    // A: the same imported picture is one content, linked - not a third copy of the bytes.
    const imported = await prisma.asset.findMany({ where: { projectId: second.projectId, source: "IMPORTED" } });
    expect(imported).toHaveLength(2);
    for (const a of imported) {
      const twin = await prisma.asset.findFirstOrThrow({ where: { projectId: first.projectId, source: "IMPORTED", sha256: a.sha256 } });
      expect(a.filePath).not.toBe(twin.filePath);
      expect(fs.statSync(toAbsolute(a.filePath)).ino).toBe(fs.statSync(toAbsolute(twin.filePath)).ino);
    }
  }, 600_000);

  it("Phạm vi có kiểm soát: GLOBAL dùng asset dự án khác; PROJECT / SCENE thì không", async () => {
    const clip = await prisma.asset.findFirstOrThrow({ where: { projectId: first.projectId, kind: "video", source: "GENERATED" } });
    const elsewhere = { reuseKey: clip.reuseKey!, sceneId: "other-scene", projectId: "other-project" };
    expect((await findReusableAsset(elsewhere)).status).toBe("REUSE");
    try {
      process.env.ASSET_REUSE_SCOPE = "PROJECT";
      expect((await findReusableAsset(elsewhere)).status).toBe("NONE");
      expect((await findReusableAsset({ ...elsewhere, projectId: first.projectId })).status).toBe("REUSE");
      process.env.ASSET_REUSE_SCOPE = "SCENE";
      expect((await findReusableAsset({ ...elsewhere, projectId: first.projectId })).status).toBe("NONE");
      expect((await findReusableAsset({ ...elsewhere, sceneId: clip.sceneId })).status).toBe("REUSE");
    } finally {
      process.env.ASSET_REUSE_SCOPE = "GLOBAL";
    }
  });

  it("Y: gắn lại cùng asset hai lần → vẫn MỘT mapping", async () => {
    const s2 = await scene(second.projectId, 2);
    const row = await prisma.asset.findFirstOrThrow({ where: { sceneId: s2.id, kind: "video", source: "REUSED" } });
    const source = await prisma.asset.findUniqueOrThrow({ where: { id: row.reusedFromAssetId! } });
    const again = await attachReusedAsset({ source, projectId: second.projectId, sceneId: s2.id, scope: "GLOBAL" });
    expect(again.created).toBe(false);
    expect(await prisma.asset.count({ where: { sceneId: s2.id, kind: "video", source: "REUSED" } })).toBe(1);
  });

  it("T: resume dùng cùng engine — clip mất khỏi DB nhưng asset + file còn → gắn lại, 0 POST", async () => {
    const s2 = await scene(first.projectId, 2);
    const keys = (await prisma.providerJob.findMany({ where: { sceneId: s2.id, kind: "video" } })).map((j) => j.idempotencyKey);
    await prisma.costReservation.deleteMany({ where: { idempotencyKey: { in: keys } } });
    await prisma.providerJob.deleteMany({ where: { sceneId: s2.id, kind: "video" } });
    await prisma.scene.update({ where: { id: s2.id }, data: { videoPath: null, status: "image_ready" } });
    await prisma.project.update({ where: { id: first.projectId }, data: { status: "failed" } });
    const before = await prisma.providerJob.count();
    const plan = await buildVideoResumePlan(first.projectId);
    expect(plan.paidRequestsRequired.video).toBe(0);
    expect(plan.estimatedIncrementalCost).toBe(0);
    const r = await continueVideo(first.projectId, { wait: true });
    expect(r.status).toBe("COMPLETED");
    expect(await prisma.providerJob.count()).toBe(before);
    expect((await scene(first.projectId, 2)).videoPath).toBeTruthy();
  }, 300_000);

  // ---- dependency invalidation, on a THIRD import of the same storyboard ----
  // (unapproved, so nothing is frozen and the preflight shows plain WILL_CREATE)

  it("J: chỉ đổi phụ đề → ảnh / clip / giọng vẫn REUSE", async () => {
    const third = await importFolder(root);
    const s1 = await scene(third.projectId, 1);
    await prisma.scene.update({ where: { id: s1.id }, data: { subtitle: "A different caption." } });
    const pre = await preflightImportedBatch(third.batchId);
    expect(pre.counts.imagePosts + pre.counts.videoPosts + pre.counts.voicePosts).toBe(0);
    expect(pre.estimatedTotal).toBe(0);
  });

  it("L + E: đổi video prompt → CHỈ clip là WILL_CREATE; ảnh và giọng vẫn REUSE", async () => {
    const third = await importFolder(root);
    const s2 = await scene(third.projectId, 2);
    await prisma.scene.update({ where: { id: s2.id }, data: { videoPrompt: `${s2.videoPrompt} Max blinks once.` } });
    const pre = await preflightImportedBatch(third.batchId);
    expect(lineOf(pre, 2).plan.video).toBe("BUY");
    expect(lineOf(pre, 2).plan.voice).toBe("REUSE");
    expect(lineOf(pre, 3).plan.video).toBe("REUSE");
    expect(pre.counts.videoPosts).toBe(1);
    expect(pre.counts.imagePosts).toBe(0);
    expect(pre.counts.voicePosts).toBe(0);
  });

  it("K: đổi mô tả ảnh → ảnh VÀ clip dựa trên ảnh đó WILL_CREATE; cảnh khác không bị chạm", async () => {
    // The image request is built from visual_description + character_action
    // (image_prompt only when both are empty) - that is the image's prompt.
    const third = await importFolder(root);
    const s3 = await scene(third.projectId, 3);
    await prisma.scene.update({ where: { id: s3.id }, data: { characterAction: "Max raises one hand and smiles." } });
    const pre = await preflightImportedBatch(third.batchId);
    expect(lineOf(pre, 3).plan.image).toBe("BUY");
    expect(lineOf(pre, 3).plan.video).toBe("BUY");
    expect(lineOf(pre, 3).plan.voice).toBe("REUSE");
    expect(lineOf(pre, 2).plan.video).toBe("REUSE");
  });

  it("I: đổi lời thoại → CHỈ giọng của cảnh đó WILL_CREATE", async () => {
    const third = await importFolder(root);
    const s1 = await scene(third.projectId, 1);
    await prisma.scene.update({ where: { id: s1.id }, data: { dialogue: 'Max: "One, again."' } });
    const pre = await preflightImportedBatch(third.batchId);
    expect(lineOf(pre, 1).plan.voice).toBe("BUY");
    expect(pre.counts.voicePosts).toBe(1);
    expect(pre.counts.imagePosts + pre.counts.videoPosts).toBe(0);
  });

  it("F + G: model khác / thời lượng khác → clip WILL_CREATE", async () => {
    const third = await importFolder(root);
    const routed = lineOf(await preflightImportedBatch(third.batchId), 2).videoModel!;
    const other = SEED_MODELS.find((m) => m.provider === "mock" && m.type === "video" && `mock/${m.modelId}` !== routed)!;
    const s2 = await scene(third.projectId, 2);
    await prisma.scene.update({ where: { id: s2.id }, data: { videoProvider: "mock", videoModel: other.modelId, videoModelPinned: true } });
    expect(lineOf(await preflightImportedBatch(third.batchId), 2).plan.video).toBe("BUY");
    await prisma.scene.update({ where: { id: s2.id }, data: { videoProvider: null, videoModel: null, videoModelPinned: false, duration: 4 } });
    expect(lineOf(await preflightImportedBatch(third.batchId), 2).plan.video).toBe("BUY");
  });

  it("M: đổi phiên bản nhân vật → ảnh sinh ra (và clip của nó) WILL_CREATE; ảnh nhập + clip của ảnh nhập vẫn REUSE", async () => {
    const third = await importFolder(root);
    const max = await prisma.character.findUniqueOrThrow({ where: { name: "Max" } });
    await prisma.character.update({ where: { id: max.id }, data: { version: max.version + 1 } });
    try {
      const pre = await preflightImportedBatch(third.batchId);
      expect(lineOf(pre, 3).plan.image).toBe("BUY");
      expect(lineOf(pre, 3).plan.video).toBe("BUY");
      expect(lineOf(pre, 2).plan.video).toBe("REUSE");
      expect(lineOf(pre, 1).reuseFrom.image).toBe("IMPORTED");
    } finally {
      await prisma.character.update({ where: { id: max.id }, data: { version: max.version } });
    }
  });

  it("D + Q + R: ảnh keyframe cùng tên khác nội dung → clip WILL_CREATE; khác tên cùng nội dung → REUSE", async () => {
    const q = await importFolder(
      writeStoryboard("sb-q", "reuse-q", [
        { image: { file: "a.png", bytes: RED }, motion: "LOCAL_MOTION", line: "One." },
        { image: { file: "b.png", bytes: GREEN }, motion: "VIDEO_AI", line: "Two." },
      ]),
    );
    expect(lineOf(await preflightImportedBatch(q.batchId), 2).plan.video).toBe("BUY");
    const r = await importFolder(
      writeStoryboard("sb-r", "reuse-r", [
        { image: { file: "a.png", bytes: RED }, motion: "LOCAL_MOTION", line: "One." },
        { image: { file: "renamed.png", bytes: BLUE }, motion: "VIDEO_AI", line: "Two." },
      ]),
    );
    expect(lineOf(await preflightImportedBatch(r.batchId), 2).plan.video).toBe("REUSE");
  });

  it("N + O: đoạn LOCAL_MOTION giống hệt lấy từ cache ($0, tiết kiệm tính toán); mất cache thì render lại tại máy ($0)", async () => {
    const p = await prisma.project.findUniqueOrThrow({ where: { id: second.projectId } });
    fs.rmSync(toAbsolute(p.finalVideoPath!));
    const before = await prisma.providerJob.count();
    expect((await continueVideo(second.projectId, { wait: true })).status).toBe("COMPLETED");
    const job = await prisma.job.findFirstOrThrow({ where: { projectId: second.projectId, type: "render_final" }, orderBy: { createdAt: "desc" } });
    expect(JSON.parse(job.resultJson ?? "{}").segmentsReused).toBe(3);

    fs.rmSync(SEGMENT_CACHE_DIR, { recursive: true, force: true });
    const again = await prisma.project.findUniqueOrThrow({ where: { id: second.projectId } });
    fs.rmSync(toAbsolute(again.finalVideoPath!));
    expect((await continueVideo(second.projectId, { wait: true })).status).toBe("COMPLETED");
    const job2 = await prisma.job.findFirstOrThrow({ where: { projectId: second.projectId, type: "render_final" }, orderBy: { createdAt: "desc" } });
    expect(JSON.parse(job2.resultJson ?? "{}").segmentsReused).toBe(0);
    expect(await prisma.providerJob.count()).toBe(before);
  }, 300_000);
});

// -------------------------------------------- missing / corrupt files ---

describe("QĐ-112 — không REUSE mù (P · file hỏng)", () => {
  it("P: asset nói là có nhưng file mất → không REUSE giả; lúc chạy đánh MISSING_LOCAL_FILE rồi mới tạo", async () => {
    const root = writeStoryboard("sb-p", "reuse-p", [
      { image: { file: "p.png", bytes: GREEN }, motion: "VIDEO_AI", line: "Missing file test." },
    ]);
    const a = await importFolder(root);
    await approveAndRun({ batchId: a.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    const clip = await prisma.asset.findFirstOrThrow({ where: { projectId: a.projectId, kind: "video", source: "GENERATED" } });
    fs.rmSync(toAbsolute(clip.filePath));

    const b = await importFolder(root);
    const pre = await preflightImportedBatch(b.batchId);
    expect(lineOf(pre, 1).plan.video).toBe("BUY");
    await approveAndRun({ batchId: b.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    expect((await jobs(b.projectId)).video).toBe(1);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: clip.id } })).validity).toBe("MISSING_LOCAL_FILE");

    // Corrupt: bytes replaced in place -> INVALID, never reused.
    const clipB = await prisma.asset.findFirstOrThrow({ where: { projectId: b.projectId, kind: "video", source: "GENERATED" } });
    fs.writeFileSync(toAbsolute(clipB.filePath), Buffer.from("not a video"));
    const c = await importFolder(root);
    expect(lineOf(await preflightImportedBatch(c.batchId), 1).plan.video).toBe("BUY");
    const found = await findReusableAsset({ reuseKey: clipB.reuseKey!, mark: true });
    expect(found.status).toBe("NONE");
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: clipB.id } })).validity).toBe("INVALID");
  }, 600_000);
});

// ------------------------------------------------------- concurrency ---

describe("QĐ-112 — hai nơi cùng cần một asset mới (Z · NEEDS_RECOVERY dùng chung)", () => {
  it("Z: hai cảnh giống hệt chạy ĐỒNG THỜI → đúng MỘT clip và MỘT giọng được tạo, cảnh kia dùng lại", async () => {
    const twin = { image: { file: "t.png", bytes: GREEN }, motion: "VIDEO_AI" as const, line: "Twin line.", prompt: "Max twin shot." };
    const { batchId, projectId } = await importFolder(writeStoryboard("sb-z", "reuse-z", [twin, twin]));
    await approveAuthorization({ batchId, authorizedMaxSpend: 5, lowAutoApproved: true });
    const [s1, s2] = await Promise.all([scene(projectId, 1), scene(projectId, 2)]);
    await Promise.all([generateSceneVideo(s1.id), generateSceneVideo(s2.id)]);
    await Promise.all([generateSceneVoice(s1.id), generateSceneVoice(s2.id)]);
    expect(await jobs(projectId)).toEqual({ image: 0, video: 1, audio: 1 });
    expect(await prisma.costReservation.count({ where: { projectId } })).toBe(2);
    const reused = await prisma.asset.findMany({ where: { projectId, source: "REUSED" } });
    expect(reused.map((a) => a.kind).sort()).toEqual(["audio", "video"]);
    expect((await scene(projectId, 1)).videoPath).toBeTruthy();
    expect((await scene(projectId, 2)).videoPath).toBeTruthy();
  }, 300_000);

  it("24: request tạo cùng asset có kết quả không rõ → mọi nơi khác bị chặn (NEEDS_RECOVERY), không POST lần hai", async () => {
    const spec = { image: { file: "n.png", bytes: RED }, motion: "VIDEO_AI" as const, line: "Recovery line.", prompt: "Max recovery shot." };
    const x = await importFolder(writeStoryboard("sb-n1", "reuse-n1", [spec]));
    await approveAuthorization({ batchId: x.batchId, authorizedMaxSpend: 5, lowAutoApproved: true });
    const sx = await scene(x.projectId, 1);
    await generateSceneVideo(sx.id);
    const job = await prisma.providerJob.findFirstOrThrow({ where: { sceneId: sx.id, kind: "video" } });
    expect(job.reuseKey).toBeTruthy();
    // Make it an unsettled PAID request (data only - mock mode cannot reach any vendor):
    // no usable asset exists, and the request may have been billed.
    await prisma.asset.deleteMany({ where: { reuseKey: job.reuseKey } });
    await prisma.providerJob.update({ where: { id: job.id }, data: { provider: "runway", status: "failed", externalId: "task-unknown", billedUnits: null } });
    await prisma.costReservation.update({ where: { idempotencyKey: job.idempotencyKey }, data: { status: "COMMITTED", actualCost: 0.4 } });

    const y = await importFolder(writeStoryboard("sb-n2", "reuse-n2", [spec]));
    await approveAuthorization({ batchId: y.batchId, authorizedMaxSpend: 5, lowAutoApproved: true });
    const sy = await scene(y.projectId, 1);
    const before = await prisma.providerJob.count();
    await expect(generateSceneVideo(sy.id)).rejects.toThrow(/PAID_ASSET_NEEDS_RECOVERY/);
    expect(await prisma.providerJob.count()).toBe(before);
    // Settle the synthetic row so no other file sees money "in flight".
    await prisma.costReservation.update({ where: { idempotencyKey: job.idempotencyKey }, data: { status: "RELEASED", actualCost: 0 } });
  }, 300_000);

  it("X: dùng lại không đi qua cổng chi — không có reservation; mua mới vẫn qua cổng (runBatch)", async () => {
    // The reuse path of the import-twice case created no reservation (asserted
    // there). A fresh purchase still reserves under its own key:
    const { batchId, projectId } = await importFolder(
      writeStoryboard("sb-x", "reuse-x", [{ image: { file: "x.png", bytes: BLUE }, motion: "VIDEO_AI", line: "Gate line.", prompt: "Max gate shot." }]),
    );
    await approveAndRun({ batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    expect(await prisma.costReservation.count({ where: { projectId, kind: "video" } })).toBe(1);
    await runBatch(batchId, { resume: true, onlyProjectIds: [projectId] });
    expect(await prisma.costReservation.count({ where: { projectId, kind: "video" } })).toBe(1);
  }, 300_000);
});
