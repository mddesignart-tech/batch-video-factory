import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { ffmpeg } from "@/media/ffmpeg";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import { voiceRowMatches } from "@/domain/voice-line-match";
import { voiceReuseKey } from "@/services/asset-keys";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { approveAndRun, resumeRun } from "@/services/batch-executor";
import { preflightImportedBatch } from "@/services/import-preflight";
import { generateSceneVoice, planSceneVoice } from "@/services/generation";
import { makeSceneVoice } from "@/services/scene-voice";
import { continueVideo } from "@/services/video-resume";

/**
 * Voice preview / voice reuse (QĐ-117). Mock providers only: $0, no paid POST.
 * Every "TTS POST" below is counted from ProviderJob rows of kind audio - what
 * was really sent - never from what a plan says.
 */

let tmp = "";
let capBefore = 0;
let seq = 0;
// Unique words per run, so no other test file's audio is reusable here.
const tag = randomUUID().slice(0, 8);

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

/** A storyboard of imported pictures + LOCAL_MOTION: the only paid API is TTS. */
async function importVideo(lines: string[]): Promise<{ batchId: string; projectId: string }> {
  seq += 1;
  const dir = path.join(tmp, `sb-${seq}`, "v");
  fs.mkdirSync(dir, { recursive: true });
  const picture = await png(["red", "blue", "green", "yellow"][seq % 4]!);
  const rows = lines.map((line, i) => {
    fs.writeFileSync(path.join(dir, `s${i + 1}.png`), picture);
    return {
      scene_number: i + 1,
      duration: 3,
      visual_description: `Max stands against a plain wall, shot ${i + 1}.`,
      character_action: "Max holds still.",
      camera: "Locked static medium shot, no camera movement.",
      dialogue: `Max: "${line}"`,
      subtitle: line,
      image_file: `s${i + 1}.png`,
      motion_mode: "LOCAL_MOTION",
      priority: "NORMAL",
    };
  });
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({ video_id: `voice-${tag}-${seq}`, video_title: `voice-${seq}`, characters: [{ character_id: "max", character_name: "Max" }], scenes: rows }),
  );
  const validated = await validateImport(scanImportSource(path.join(tmp, `sb-${seq}`)));
  expect(validated.issues.filter((i) => i.level === "error")).toEqual([]);
  const created = await materialiseImport(validated, { batchName: `voice-${tag}-${seq}`, maxCostPerVideo: 5, maxCostForBatch: 50 });
  return { batchId: created.batchId, projectId: created.projects[0]!.projectId };
}

const ttsPosts = (projectId: string) => prisma.providerJob.count({ where: { projectId, kind: "audio" } });
/**
 * Purchases of voice in a project: one ledger line per TTS create. (A re-buy
 * under the same idempotency key updates its ProviderJob row in place, so rows
 * alone cannot see it.)
 */
const voicePurchases = (projectId: string) => prisma.costEntry.count({ where: { projectId, category: "voice" } });
const allTtsPosts = () => prisma.costEntry.count({ where: { category: "voice" } }); // one ledger line per TTS create
const scene = (projectId: string, n: number) => prisma.scene.findFirstOrThrow({ where: { projectId, sceneNumber: n } });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voice-reuse-"));
  await seedMock();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
}, 120_000);

afterAll(async () => {
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("QĐ-117 — khoá giọng (thuần)", () => {
  const settings = { voiceId: "alloy", instructions: "calm", speed: 1, provider: "openai", model: "gpt-4o-mini-tts" };
  const row = { status: "completed", text: "Hello!", outputPath: "a.wav", ...settings };

  it("chỉ lời, giọng, hướng dẫn, tốc độ, model làm đổi giọng", () => {
    expect(voiceRowMatches(row, "Hello!", settings)).toBe(true);
    expect(voiceRowMatches(row, "Hello?", settings)).toBe(false);
    expect(voiceRowMatches(row, "Hello!", { ...settings, voiceId: "echo" })).toBe(false);
    expect(voiceRowMatches(row, "Hello!", { ...settings, model: "tts-2" })).toBe(false);
    expect(voiceRowMatches(row, "Hello!", { ...settings, speed: 1.1 })).toBe(false);
    expect(voiceRowMatches(row, "Hello!", { ...settings, instructions: "angry" })).toBe(false);
    // Router-chosen (no pin): the model the row was made with stands.
    expect(voiceRowMatches(row, "Hello!", { ...settings, provider: null, model: null })).toBe(true);
  });

  it("khoá không chứa scene/project/thời gian; model khác → khoá khác", () => {
    const base = { provider: "openai", model: "gpt-4o-mini-tts", text: "Hi.", voiceId: "alloy", instructions: "", speed: 1 };
    expect(voiceReuseKey({ ...base, targetDuration: 3 })).toBe(voiceReuseKey({ ...base, targetDuration: 9 }));
    expect(voiceReuseKey(base)).not.toBe(voiceReuseKey({ ...base, model: "tts-2" }));
    expect(voiceReuseKey(base)).not.toBe(voiceReuseKey({ ...base, voiceId: "echo" }));
  });
});

describe("QĐ-117 — NGHE THỬ → DUYỆT → RENDER → TIẾP TỤC → RENDER LẠI dùng cùng một giọng", () => {
  let video = { batchId: "", projectId: "" };
  const lines = [`First line ${tag}.`, `Second line ${tag}.`];

  beforeAll(async () => {
    video = await importVideo(lines);
  }, 120_000);

  it("nghe thử: hỏi giá trước, xác nhận → đúng 1 TTS POST, lưu thành Asset; bấm lại → 0 POST", async () => {
    const s1 = await scene(video.projectId, 1);
    const ask = await makeSceneVoice(s1.id);
    expect(ask.status).toBe("NEEDS_CONFIRMATION");
    expect(ask.plan!.expectedPosts).toBe(1);
    expect(await ttsPosts(video.projectId)).toBe(0);

    const made = await makeSceneVoice(s1.id, { confirmPaid: true, expectedCost: ask.plan!.incrementalCost });
    expect(made.status).toBe("DONE");
    expect(made.postsMade).toBe(1);
    expect(made.plan!.lines[0]!.state).toBe("DONE");
    expect(made.plan!.lines[0]!.audioPath).toBeTruthy();
    const asset = await prisma.asset.findFirstOrThrow({ where: { sceneId: s1.id, kind: "audio" } });
    expect(asset.reuseKey).toBeTruthy();

    const again = await makeSceneVoice(s1.id);
    expect(again.status).toBe("DONE");
    expect(again.postsMade).toBe(0);
    expect(await ttsPosts(video.projectId)).toBe(1);
  });

  it("preflight: giọng đã nghe thử = REUSE $0, chỉ cảnh chưa có giọng được tính", async () => {
    const pre = await preflightImportedBatch(video.batchId);
    expect(pre.counts.voicePosts).toBe(1);
    const sc = pre.videos[0]!.scenes;
    expect(sc.find((s) => s.sceneNumber === 1)!.plan.voice).not.toBe("BUY");
    expect(sc.find((s) => s.sceneNumber === 1)!.costs.voice).toBe(0);
    expect(sc.find((s) => s.sceneNumber === 2)!.plan.voice).toBe("BUY");
  });

  it("nghe thử → DUYỆT & CHẠY: tổng cộng 2 TTS POST cho 2 câu (cảnh 1 không gọi lại)", async () => {
    await approveAndRun({ batchId: video.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    const p = await prisma.project.findUniqueOrThrow({ where: { id: video.projectId } });
    expect(p.status).toBe("completed");
    expect(fs.existsSync(toAbsolute(p.finalVideoPath!))).toBe(true);
    expect(await ttsPosts(video.projectId)).toBe(2);
  }, 300_000);

  it("chạy → TIẾP TỤC sau lỗi render / khởi động lại: 0 TTS POST mới", async () => {
    await prisma.project.update({ where: { id: video.projectId }, data: { status: "failed" } });
    const before = await allTtsPosts();
    const r = await continueVideo(video.projectId, { wait: true });
    expect(["COMPLETED", "NOOP"]).toContain(r.status);
    expect(await allTtsPosts()).toBe(before);
  }, 300_000);

  it("render lại (MP4 bị xoá): 0 TTS POST", async () => {
    const p = await prisma.project.findUniqueOrThrow({ where: { id: video.projectId } });
    fs.rmSync(toAbsolute(p.finalVideoPath!));
    const before = await allTtsPosts();
    expect((await continueVideo(video.projectId, { wait: true })).status).toBe("COMPLETED");
    expect(await allTtsPosts()).toBe(before);
  }, 300_000);

  it("5 lần chạy lại cả project (giọng đủ): VOICE POST = 0, preflight $0 giọng", async () => {
    const pre = await preflightImportedBatch(video.batchId);
    expect(pre.counts.voicePosts).toBe(0);
    const before = await allTtsPosts();
    for (const n of [1, 2]) await generateSceneVoice((await scene(video.projectId, n)).id);
    await resumeRun({ batchId: video.batchId, onlyProjectIds: [video.projectId], wait: true });
    expect(await allTtsPosts()).toBe(before);
  }, 300_000);

  it("đổi ảnh / video prompt / camera / phụ đề: 0 TTS POST", async () => {
    const s1 = await scene(video.projectId, 1);
    await prisma.scene.update({
      where: { id: s1.id },
      data: {
        subtitle: "A different caption.",
        videoPrompt: `${s1.videoPrompt} Max blinks once.`,
        camera: "Slow push-in.",
        visualDescription: "Max stands against a brick wall.",
      },
    });
    expect((await planSceneVoice(s1.id)).expectedPosts).toBe(0);
    expect((await preflightImportedBatch(video.batchId)).counts.voicePosts).toBe(0);
    const before = await allTtsPosts();
    await generateSceneVoice(s1.id);
    expect(await allTtsPosts()).toBe(before);
  });

  it("sửa MỘT từ trong lời thoại: chỉ cảnh đó, đúng 1 TTS POST (preflight cũng thấy)", async () => {
    const s1 = await scene(video.projectId, 1);
    await prisma.scene.update({ where: { id: s1.id }, data: { dialogue: `Max: "First line ${tag}, again."` } });
    const plan = await planSceneVoice(s1.id);
    expect(plan.expectedPosts).toBe(1);
    expect(plan.lines[0]!.state).toBe("WILL_CREATE");
    // Before QĐ-117 the estimate saw "completed + file on disk" and priced this at $0.
    expect((await preflightImportedBatch(video.batchId)).counts.voicePosts).toBe(1);
    const before = await allTtsPosts();
    await generateSceneVoice(s1.id);
    await generateSceneVoice((await scene(video.projectId, 2)).id);
    expect((await allTtsPosts()) - before).toBe(1);
  });

  it("đổi giọng của nhân vật: đúng 1 TTS POST cho mỗi cảnh có câu của nhân vật đó", async () => {
    const max = await prisma.character.findUniqueOrThrow({ where: { name: "Max" } });
    await prisma.character.update({ where: { id: max.id }, data: { voiceId: `mock-voice-${tag}` } });
    try {
      expect((await preflightImportedBatch(video.batchId)).counts.voicePosts).toBe(2);
      const before = await allTtsPosts();
      for (const n of [1, 2]) await generateSceneVoice((await scene(video.projectId, n)).id);
      expect((await allTtsPosts()) - before).toBe(2);
      // And again with nothing changed: nothing.
      for (const n of [1, 2]) await generateSceneVoice((await scene(video.projectId, n)).id);
      expect((await allTtsPosts()) - before).toBe(2);
    } finally {
      await prisma.character.update({ where: { id: max.id }, data: { voiceId: max.voiceId } });
    }
  });
});

describe("QĐ-117 — trùng lặp và file mất", () => {
  it("double-click NGHE THỬ: một lần ALREADY_RUNNING, đúng 1 paid request", async () => {
    const v = await importVideo([`Double click ${tag}.`]);
    const s1 = await scene(v.projectId, 1);
    const cost = (await planSceneVoice(s1.id)).incrementalCost;
    const results = await Promise.all([
      makeSceneVoice(s1.id, { confirmPaid: true, expectedCost: cost }),
      makeSceneVoice(s1.id, { confirmPaid: true, expectedCost: cost }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["ALREADY_RUNNING", "DONE"]);
    expect(await ttsPosts(v.projectId)).toBe(1);
  });

  it("hai worker cùng một câu, cùng giọng: đúng 1 ProviderJob, nơi kia REUSE", async () => {
    // Cross-scene reuse is the production default (GLOBAL); the suite defaults to SCENE.
    const scopeBefore = process.env.ASSET_REUSE_SCOPE;
    process.env.ASSET_REUSE_SCOPE = "GLOBAL";
    try {
      const line = `Same line ${tag}.`;
      const v = await importVideo([line, line]);
      const [a, b] = [await scene(v.projectId, 1), await scene(v.projectId, 2)];
      await Promise.all([generateSceneVoice(a.id), generateSceneVoice(b.id)]);
      expect(await ttsPosts(v.projectId)).toBe(1);
      expect(await voicePurchases(v.projectId)).toBe(1);
      expect(await prisma.asset.count({ where: { projectId: v.projectId, kind: "audio", source: "REUSED" } })).toBe(1);
    } finally {
      process.env.ASSET_REUSE_SCOPE = scopeBefore;
    }
  });

  it("file giọng mất: KHÔNG tự mua lại; báo MISSING kèm giá; chỉ mua khi xác nhận", async () => {
    const v = await importVideo([`Lost file ${tag}.`]);
    await approveAndRun({ batchId: v.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    expect(await voicePurchases(v.projectId)).toBe(1);
    const s1 = await scene(v.projectId, 1);
    const row = await prisma.dialogueLine.findFirstOrThrow({ where: { sceneId: s1.id } });
    // Every copy of the bytes: the reuse engine must find none.
    for (const a of await prisma.asset.findMany({ where: { sceneId: s1.id, kind: "audio" } })) {
      fs.rmSync(toAbsolute(a.filePath), { force: true });
    }
    fs.rmSync(toAbsolute(row.outputPath), { force: true });
    await prisma.project.update({ where: { id: v.projectId }, data: { status: "failed" } });

    // Silent paths stop: the queue / regenerate path and the batch page's "Chạy tiếp".
    await expect(generateSceneVoice(s1.id)).rejects.toThrow(/VOICE_MISSING_LOCAL_FILE/);
    await resumeRun({ batchId: v.batchId, onlyProjectIds: [v.projectId], wait: true });
    expect(await voicePurchases(v.projectId)).toBe(1);

    const plan = await planSceneVoice(s1.id);
    expect(plan.lines[0]!.state).toBe("MISSING_LOCAL_FILE");
    expect(plan.expectedPosts).toBe(1);
    expect((await preflightImportedBatch(v.batchId)).counts.voicePosts).toBe(1);

    // TIẾP TỤC asks first, then buys exactly once on confirmation.
    const ask = await continueVideo(v.projectId);
    expect(ask.status).toBe("NEEDS_CONFIRMATION");
    expect(ask.plan!.paidRequestsRequired.voice).toBe(1);
    expect(await voicePurchases(v.projectId)).toBe(1);
    const done = await continueVideo(v.projectId, { confirmPaid: true, wait: true });
    expect(done.status).toBe("COMPLETED");
    expect(await voicePurchases(v.projectId)).toBe(2);
  }, 600_000);
});

describe("QĐ-117 — model TTS bị tắt / ngừng dùng", () => {
  it("giọng đã có vẫn dùng lại và render được khi MỌI model giọng bị tắt; câu MỚI thì báo MODEL_UNAVAILABLE", async () => {
    const v = await importVideo([`Deprecated model ${tag}.`]);
    await approveAndRun({ batchId: v.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    expect(await ttsPosts(v.projectId)).toBe(1);
    const voices = await prisma.modelRegistry.findMany({ where: { type: "voice", enabled: true } });
    await prisma.modelRegistry.updateMany({ where: { id: { in: voices.map((m) => m.id) } }, data: { enabled: false } });
    try {
      const s1 = await scene(v.projectId, 1);
      const before = await allTtsPosts();
      await generateSceneVoice(s1.id); // no routing error, no purchase
      expect((await planSceneVoice(s1.id)).lines[0]!.state).toBe("DONE");
      const p = await prisma.project.findUniqueOrThrow({ where: { id: v.projectId } });
      fs.rmSync(toAbsolute(p.finalVideoPath!));
      expect((await continueVideo(v.projectId, { wait: true })).status).toBe("COMPLETED");
      expect(await allTtsPosts()).toBe(before);

      await prisma.scene.update({ where: { id: s1.id }, data: { dialogue: `Max: "A new line ${tag}."` } });
      const plan = await planSceneVoice(s1.id);
      expect(plan.lines[0]!.state).toBe("BLOCKED");
      expect(plan.lines[0]!.message).toMatch(/MODEL_UNAVAILABLE/);
      expect((await makeSceneVoice(s1.id, { confirmPaid: true })).status).toBe("BLOCKED");
      expect(await allTtsPosts()).toBe(before);
    } finally {
      await prisma.modelRegistry.updateMany({ where: { id: { in: voices.map((m) => m.id) } }, data: { enabled: true } });
    }
  }, 600_000);
});

describe("QĐ-118 — trần lô của bản DRAFT không phải hạn mức $0", () => {
  it("project cũ trong lô DRAFT đã có chi phí: NGHE THỬ GIỌNG chạy được; trần đã duyệt / ngân sách video vẫn chặn", async () => {
    const v = await importVideo([`Draft ceiling ${tag}.`]);
    const auth = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId: v.batchId } });
    expect(auth.status).toBe("DRAFT");
    expect(auth.authorizedMaxSpend).toBe(0);
    // Spend from before the batch existed (the legacy project's script and images).
    await prisma.costEntry.create({
      data: { projectId: v.projectId, batchId: v.batchId, category: "image", provider: "mock", model: "legacy", amount: 0.334007, estimated: false },
    });
    const s1 = await scene(v.projectId, 1);
    const cost = (await planSceneVoice(s1.id)).incrementalCost;

    // A set ceiling still binds: an APPROVED $0.10 batch already overrun stops it...
    await prisma.batchAuthorization.update({ where: { id: auth.id }, data: { status: "APPROVED", authorizedMaxSpend: 0.1 } });
    const blocked = await makeSceneVoice(s1.id, { confirmPaid: true, expectedCost: cost });
    expect(blocked.status).toBe("NEEDS_BUDGET");
    expect(blocked.budget!.scope).toBe("BATCH");
    expect(blocked.budget!.remaining).toBe(0);
    // The guard itself, unchanged underneath the friendly pre-check:
    const { executeSceneAsset } = await import("@/services/batch-executor");
    await expect(executeSceneAsset(s1.id, "voice", { allowRebuyMissingVoice: true })).rejects.toThrow(/lô đã chi \$0\.334007 > trần \$0\.100000/);
    // ...and so does the video's own budget when there is no approval.
    await prisma.batchAuthorization.update({ where: { id: auth.id }, data: { status: "DRAFT", authorizedMaxSpend: 0 } });
    const p = await prisma.project.findUniqueOrThrow({ where: { id: v.projectId } });
    await prisma.project.update({ where: { id: v.projectId }, data: { maxBudget: 0.1 } });
    const overVideo = await makeSceneVoice(s1.id, { confirmPaid: true, expectedCost: cost });
    expect(overVideo.status).toBe("NEEDS_BUDGET");
    expect(overVideo.budget!.scope).toBe("VIDEO");
    await expect(executeSceneAsset(s1.id, "voice", { allowRebuyMissingVoice: true })).rejects.toThrow(/video đã chi/);
    expect(await voicePurchases(v.projectId)).toBe(0);

    // DRAFT ($0 = nothing approved yet) + a valid video budget: runs.
    await prisma.project.update({ where: { id: v.projectId }, data: { maxBudget: p.maxBudget } });
    const ok = await makeSceneVoice(s1.id, { confirmPaid: true, expectedCost: cost });
    expect(ok.message).not.toMatch(/trần \$0\.000000/);
    expect(ok.status).toBe("DONE");
    expect(await voicePurchases(v.projectId)).toBe(1);
  });
});

describe("QĐ-119 — chi phí dễ hiểu: một ngân sách video, lỗi thân thiện, tóm tắt trước khi chạy", () => {
  it("nhận ra mọi câu chặn vì ngân sách và tách số (thuần)", async () => {
    const { budgetProblem, suggestedBudget } = await import("@/domain/budget-message");
    const { friendlyError } = await import("@/domain/user-errors");
    const lot = budgetProblem("cảnh 1: lô đã chi $0.334007 > trần $0.000000. DỪNG.")!;
    expect(lot).toMatchObject({ scope: "BATCH", used: 0.334007, limit: 0, remaining: 0 });
    expect(budgetProblem("cảnh 2: video đã chi $1.2 > trần $1. DỪNG.")).toMatchObject({ scope: "VIDEO", used: 1.2, limit: 1, remaining: 0 });
    expect(budgetProblem("Mô hình đã chọn tốn $0.05 nhưng ngân sách còn lại chỉ $0.01.")).toMatchObject({ scope: "VIDEO", needed: 0.05, remaining: 0.01 });
    expect(
      budgetProblem("Đã chi $8.5900 cho API thật. Yêu cầu này ước tính thêm $0.0500, tổng $8.6400 sẽ vượt hạn mức $8.60. Yêu cầu bị chặn."),
    ).toMatchObject({ scope: "GLOBAL", used: 8.59, needed: 0.05, limit: 8.6 });
    expect(budgetProblem("render: ffmpeg exited 1")).toBeNull();
    expect(friendlyError("cảnh 1: video đã chi $0.33 > trần $0.10. DỪNG.")!.code).toBe("VIDEO_LIMIT_EXCEEDED");
    expect(friendlyError("cảnh 1: lô đã chi $0.33 > trần $0.10. DỪNG.")!.code).toBe("BATCH_LIMIT_EXCEEDED");
    expect(suggestedBudget(0.33, 0.05, 0.1)).toBe(0.5);
    expect(suggestedBudget(4.9, 0.3, 5)).toBe(6);
  });

  it("NGÂN SÁCH VIDEO: Đã dùng / Giới hạn / Còn lại; đổi ngân sách > $0; lô một video chưa duyệt đi theo; lô đã duyệt không bị nâng", async () => {
    const { videoBudget, setVideoBudget } = await import("@/services/video-budget");
    const v = await importVideo([`Budget card ${tag}.`]);
    await prisma.costEntry.create({ data: { projectId: v.projectId, batchId: v.batchId, category: "image", provider: "mock", model: "x", amount: 0.3, estimated: false } });
    const b = await videoBudget(v.projectId);
    expect(b.used).toBeCloseTo(0.3, 6);
    expect(b.source).toBe("VIDEO");
    expect(b.remaining).toBeCloseTo((b.limit ?? 0) - 0.3, 6);

    await expect(setVideoBudget(v.projectId, 0)).rejects.toThrow(/lớn hơn \$0/);
    const after = await setVideoBudget(v.projectId, 2);
    expect(after).toMatchObject({ videoLimit: 2, limit: 2 });
    expect(after.remaining).toBeCloseTo(1.7, 6);
    // A batch of one nobody approved follows, so its preflight prices against $2.
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: v.batchId } })).maxCostPerVideo).toBe(2);
    expect((await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId: v.batchId } })).maxCostPerVideo).toBe(2);

    // An approval that was GIVEN binds and is never raised from the project page.
    await prisma.batchAuthorization.update({ where: { batchId: v.batchId }, data: { status: "APPROVED", authorizedMaxSpend: 1, maxCostPerVideo: 0.5 } });
    try {
      const approved = await setVideoBudget(v.projectId, 3);
      expect(approved.source).toBe("APPROVED_BATCH");
      expect(approved.limit).toBe(0.5);
      expect((await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId: v.batchId } })).maxCostPerVideo).toBe(0.5);
    } finally {
      await prisma.batchAuthorization.update({ where: { batchId: v.batchId }, data: { status: "DRAFT", authorizedMaxSpend: 0 } });
    }
  });

  it("dự án cũ ngân sách $0: không khoá âm thầm 'trần $0' — báo CHƯA ĐẶT; đặt ngân sách xong thì NGHE THỬ GIỌNG chạy", async () => {
    const { setVideoBudget } = await import("@/services/video-budget");
    const v = await importVideo([`Zero budget ${tag}.`]);
    await prisma.project.update({ where: { id: v.projectId }, data: { maxBudget: 0 } });
    const s1 = await scene(v.projectId, 1);
    const r = await makeSceneVoice(s1.id, { confirmPaid: true });
    expect(r.status).toBe("NEEDS_BUDGET");
    expect(r.budget).toMatchObject({ scope: "VIDEO", limit: null });
    expect(r.message).toMatch(/VIDEO_BUDGET_UNSET/);
    expect(await voicePurchases(v.projectId)).toBe(0);

    await setVideoBudget(v.projectId, 1);
    const cost = (await planSceneVoice(s1.id)).incrementalCost;
    const ok = await makeSceneVoice(s1.id, { confirmPaid: true, expectedCost: cost });
    expect(ok.status).toBe("DONE");
    expect(await voicePurchases(v.projectId)).toBe(1);
  });

  it("thiếu ngân sách video: báo Đã dùng / Còn lại / Cần thêm, 0 POST; tăng ngân sách rồi chạy được", async () => {
    const { setVideoBudget } = await import("@/services/video-budget");
    const v = await importVideo([`Short budget ${tag}.`]);
    const s1 = await scene(v.projectId, 1);
    const cost = (await planSceneVoice(s1.id)).incrementalCost;
    expect(cost).toBeGreaterThan(0);
    await prisma.costEntry.create({ data: { projectId: v.projectId, category: "image", provider: "mock", model: "x", amount: 0.33, estimated: false } });
    await setVideoBudget(v.projectId, 0.33);
    const r = await makeSceneVoice(s1.id, { confirmPaid: true, expectedCost: cost });
    expect(r.status).toBe("NEEDS_BUDGET");
    expect(r.budget).toMatchObject({ scope: "VIDEO", remaining: 0, needed: cost });
    expect(r.budget!.used).toBeCloseTo(0.33, 6);
    expect(await voicePurchases(v.projectId)).toBe(0);
    await setVideoBudget(v.projectId, 1);
    expect((await makeSceneVoice(s1.id, { confirmPaid: true, expectedCost: cost })).status).toBe("DONE");
  });

  it("PREFLIGHT: tóm tắt Ảnh / Giọng / Video AI / Reuse, ngân sách video + toàn hệ thống còn lại; thiếu thì không đủ", async () => {
    const { preflightForApproval } = await import("@/services/batch-executor");
    const { setVideoBudget } = await import("@/services/video-budget");
    const v = await importVideo([`Summary one ${tag}.`, `Summary two ${tag}.`]);
    const pre = await preflightForApproval(v.batchId, { maxBatch: 5 });
    const sum = pre.costSummary!;
    expect(sum.total).toBeCloseTo(pre.estimatedTotal, 6);
    expect(sum.voice).toBeGreaterThan(0);
    expect(sum.image).toBe(0); // imported pictures
    expect(sum.video).toBe(0); // LOCAL_MOTION
    expect(sum.videos).toHaveLength(1);
    expect(sum.videos[0]!.remaining).toBeGreaterThan(0);
    expect(sum.globalRemaining).toBe(pre.globalRemaining);
    expect(sum.enough).toBe(true);

    await setVideoBudget(v.projectId, 1);
    await prisma.costEntry.create({ data: { projectId: v.projectId, category: "image", provider: "mock", model: "x", amount: 1, estimated: false } });
    const short = (await preflightForApproval(v.batchId, { maxBatch: 5 })).costSummary!;
    expect(short.videos[0]!.remaining).toBe(0);
    expect(short.videos[0]!.enough).toBe(false);
    expect(short.enough).toBe(false);
  });
});
