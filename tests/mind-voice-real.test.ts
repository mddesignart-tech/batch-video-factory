import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { ffmpeg, ffprobe, probeDuration } from "@/media/ffmpeg";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import { MIND_CATALOG_SETTING, refreshMindCatalog } from "@/services/mind-voice-catalog";
import { ensureNarrator } from "@/services/content-service";
import { generateSceneVoice } from "@/services/generation";
import { saveProjectControls } from "@/services/output-controls";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { approveAndRun } from "@/services/batch-executor";
import { continueVideo } from "@/services/video-resume";

/**
 * QĐ-145 REAL LOCAL test: the whole video pipeline against the REAL Mind Voice
 * running on this machine (VieNeu-TTS + Supertonic 3 installed). Throwaway test
 * database, $0, no paid API. Skipped unless asked for:
 *
 *   MIND_VOICE_REAL=1 npx vitest run tests/mind-voice-real.test.ts
 *
 * The finished videos are copied to data/voice-ab/mind-voice-real-<time>/ to listen to.
 */

const REAL = process.env.MIND_VOICE_REAL === "1";
const URL = process.env.MIND_VOICE_URL ?? "http://127.0.0.1:8011";
const OUT = path.resolve(__dirname, "..", "data", "voice-ab", `mind-voice-real-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
const tag = randomUUID().slice(0, 4);
let tmp = "";
let capBefore = 0;

async function seed(): Promise<void> {
  for (const provider of SEED_PROVIDERS.filter((p) => p.name === "mock")) {
    await prisma.providerConfig.upsert({ where: { name: provider.name }, create: { ...provider, types: JSON.stringify(provider.types), status: "connected" }, update: { enabled: true, status: "connected" } });
  }
  for (const model of SEED_MODELS.filter((m) => m.provider === "mock")) {
    await prisma.modelRegistry.upsert({ where: { provider_modelId: { provider: model.provider, modelId: model.modelId } }, create: model, update: { enabled: true, reliability: "OK", price: model.price } });
  }
  for (const preset of SEED_STYLE_PRESETS) {
    await prisma.stylePreset.upsert({ where: { slug: preset.slug }, create: { ...preset, aspectRatio: "9:16" }, update: {} });
  }
  for (const character of SEED_CHARACTERS) {
    await prisma.character.upsert({ where: { name: character.name }, create: { ...character, voiceProvider: "mock", enabled: true }, update: {} });
  }
}

/** Storyboard scenes: `narration` lines for the Narrator, or `dialogue` for Max/Leo. */
async function video(scenes: { narration?: string; dialogue?: string }[], language: string): Promise<{ batchId: string; projectId: string; sceneIds: string[] }> {
  const dir = path.join(tmp, `sb-${randomUUID().slice(0, 6)}`, "v");
  fs.mkdirSync(dir, { recursive: true });
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x334455:s=1080x1920", "-frames:v", "1", path.join(dir, "k.png")]);
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({
      video_id: `mind-real-${tag}-${randomUUID().slice(0, 4)}`,
      video_title: `Mind Voice ${language}`,
      characters: [{ character_id: "max", character_name: "Max" }],
      scenes: scenes.map((_, i) => ({
        scene_number: i + 1,
        duration: 4,
        visual_description: `Shot ${i + 1}.`,
        character_action: "Talks.",
        camera: "Static medium shot.",
        dialogue: `Max: "x"`,
        subtitle: "",
        image_file: "k.png",
        motion_mode: "LOCAL_MOTION",
        priority: "NORMAL",
        characters_present: ["Max"],
        speaking_characters: ["Max"],
      })),
    }),
  );
  const validated = await validateImport(scanImportSource(path.dirname(dir)));
  const created = await materialiseImport(validated, { batchName: `mind-real-${tag}-${randomUUID().slice(0, 4)}`, maxCostPerVideo: 5, maxCostForBatch: 50 });
  const projectId = created.projects[0]!.projectId;
  await prisma.project.update({ where: { id: projectId }, data: { language } });
  const rows = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
  for (const [i, s] of rows.entries()) {
    const sc = scenes[i]!;
    await prisma.scene.update({
      where: { id: s.id },
      data: sc.dialogue
        ? { dialogue: sc.dialogue, narration: "", subtitle: "", speakingCharactersJson: JSON.stringify(["Max", "Leo"]), charactersPresentJson: JSON.stringify(["Max", "Leo"]) }
        : { dialogue: "", narration: sc.narration!, subtitle: "", speakingCharactersJson: JSON.stringify(["Narrator"]) },
    });
  }
  return { batchId: created.batchId, projectId, sceneIds: rows.map((s) => s.id) };
}

const audioAssets = (projectId: string) => prisma.asset.count({ where: { projectId, kind: "audio", provider: "mindvoice" } });

async function keep(projectId: string, name: string): Promise<string> {
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const dest = path.join(OUT, `${name}.mp4`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(toAbsolute(p.finalVideoPath!), dest);
  const lines = await prisma.dialogueLine.findMany({ where: { scene: { projectId } }, orderBy: [{ scene: { sceneNumber: "asc" } }, { lineNumber: "asc" }] });
  for (const [i, l] of lines.entries()) fs.copyFileSync(toAbsolute(l.outputPath!), path.join(OUT, `${name}-line${i + 1}-${l.voiceId.replace(/[^\p{L}\p{N}]+/gu, "_")}.wav`));
  return dest;
}

describe.skipIf(!REAL)("QĐ-145 Mind Voice REAL LOCAL (VieNeu + Supertonic thật, $0)", () => {
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mind-real-"));
    await seed();
    await ensureNarrator();
    const s = await spendStatus();
    capBefore = s.cap;
    await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
    await prisma.providerConfig.upsert({
      where: { name: "mindvoice" },
      create: { name: "mindvoice", displayName: "Mind Voice", types: JSON.stringify(["voice"]), enabled: true, baseUrl: URL, status: "connected" },
      update: { enabled: true, baseUrl: URL },
    });
  }, 120_000);

  afterAll(async () => {
    await prisma.modelRegistry.deleteMany({ where: { provider: "mindvoice" } });
    await prisma.providerConfig.deleteMany({ where: { name: "mindvoice" } });
    await prisma.setting.deleteMany({ where: { key: MIND_CATALOG_SETTING } });
    if (capBefore > 0) await setSpendCap(capBefore);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("Mind Voice thật: online, 25 giọng VieNeu + 10 Supertonic, cả hai model đã cài", async () => {
    const c = await refreshMindCatalog();
    expect(c.online).toBe(true);
    expect(c.voices.filter((v) => v.engine === "vieneu" && v.installed)).toHaveLength(25);
    expect(c.voices.filter((v) => v.engine === "supertonic" && v.installed)).toHaveLength(10);
  });

  it("video tiếng Việt 3 cảnh (giọng Tự động): nhãn không bị đọc, render xong, $0; render lại / sửa phụ đề = 0 TTS", async () => {
    const v = await video(
      [
        { narration: "Narrator: Bạn có biết, chỉ cần uống một ly nước ngay sau khi thức dậy, cơ thể sẽ tỉnh táo hơn hẳn?" },
        { narration: "Thói quen nhỏ này không tốn tiền, cũng chẳng mất thêm thời gian." },
        { narration: "Speaker A: Sáng mai thử ngay, rồi kể cho mình nghe cảm giác nhé!" },
      ],
      "vi",
    );
    await saveProjectControls(v.projectId, { voice: { provider: "mindvoice", model: "mind-local", voiceId: null } });
    const ledger = await prisma.costEntry.count();
    await approveAndRun({ batchId: v.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    const project = await prisma.project.findUniqueOrThrow({ where: { id: v.projectId } });
    expect(project.status).toBe("completed");
    const lines = await prisma.dialogueLine.findMany({ where: { scene: { projectId: v.projectId } }, orderBy: [{ scene: { sceneNumber: "asc" } }] });
    expect(lines.map((l) => [l.provider, l.voiceId])).toEqual(lines.map(() => ["mindvoice", "Hải Đăng"]));
    expect(lines.map((l) => l.text).join(" ")).not.toMatch(/Narrator|Speaker A/);
    for (const l of lines) expect(await probeDuration(toAbsolute(l.outputPath!))).toBeGreaterThan(1.5);
    const final = toAbsolute(project.finalVideoPath!);
    const streams = (await ffprobe(["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", final])).stdout;
    expect(streams).toMatch(/audio/);
    expect(await prisma.costEntry.count()).toBe(ledger);
    await keep(v.projectId, "01-vi-3-canh-hai-dang");

    const assets = await audioAssets(v.projectId);
    fs.rmSync(final);
    await prisma.scene.update({ where: { id: v.sceneIds[1]! }, data: { subtitle: "Phụ đề sửa tay", camera: "slow push-in" } });
    expect((await continueVideo(v.projectId, { wait: true })).status).toBe("COMPLETED");
    for (const id of v.sceneIds) await generateSceneVoice(id);
    expect(await audioAssets(v.projectId)).toBe(assets);
  }, 1_800_000);

  it("hội thoại 2 người tiếng Việt: Max = Thiện Minh, Leo = Ngọc Huyền, mỗi người đúng giọng", async () => {
    const original = await prisma.character.findMany({ where: { name: { in: ["Max", "Leo"] } } });
    try {
      await prisma.character.update({ where: { name: "Max" }, data: { voiceProvider: "mindvoice", voiceModel: "mind-local", voiceId: "Thiện Minh" } });
      await prisma.character.update({ where: { name: "Leo" }, data: { voiceProvider: "mindvoice", voiceModel: "mind-local", voiceId: "Ngọc Huyền" } });
      const v = await video([{ dialogue: "Max: Bạn ăn sáng chưa?\nLeo: Mình ăn rồi, cảm ơn nhé. Hôm nay trời đẹp quá!\nMax: Vậy mình đi dạo một vòng đi." }], "vi");
      await approveAndRun({ batchId: v.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
      expect((await prisma.project.findUniqueOrThrow({ where: { id: v.projectId } })).status).toBe("completed");
      const lines = await prisma.dialogueLine.findMany({ where: { sceneId: v.sceneIds[0]! }, orderBy: { lineNumber: "asc" } });
      expect(lines.map((l) => l.voiceId)).toEqual(["Thiện Minh", "Ngọc Huyền", "Thiện Minh"]);
      await keep(v.projectId, "02-vi-hoi-thoai-thien-minh-ngoc-huyen");
    } finally {
      for (const c of original) await prisma.character.update({ where: { id: c.id }, data: { voiceProvider: c.voiceProvider, voiceModel: c.voiceModel, voiceId: c.voiceId } });
    }
  }, 1_800_000);

  it("video tiếng Anh: Supertonic 3 (Tự động → M1), Voice Director Comedy, render xong, $0", async () => {
    const v = await video(
      [
        { narration: "Narrator: Did you know a single glass of water right after you wake up can make you feel more alert?" },
        { narration: "I tried it for a week. Turns out, I mostly just needed the bathroom more." },
      ],
      "en",
    );
    await saveProjectControls(v.projectId, { voice: { provider: "mindvoice", model: "mind-local", voiceId: null, director: true } });
    const ledger = await prisma.costEntry.count();
    await approveAndRun({ batchId: v.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: v.projectId } })).status).toBe("completed");
    const lines = await prisma.dialogueLine.findMany({ where: { scene: { projectId: v.projectId } } });
    expect(lines.every((l) => l.provider === "mindvoice" && l.voiceId === "M1")).toBe(true);
    expect(lines.every((l) => /engine=supertonic\/cpu lang=en/.test(l.instructions))).toBe(true);
    expect(await prisma.costEntry.count()).toBe(ledger);
    await keep(v.projectId, "03-en-supertonic-m1");
  }, 1_800_000);
});
