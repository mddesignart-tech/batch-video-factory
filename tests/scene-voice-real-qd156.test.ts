import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { ffmpeg } from "@/media/ffmpeg";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import { MIND_CATALOG_SETTING, refreshMindCatalog } from "@/services/mind-voice-catalog";
import { ensureNarrator } from "@/services/content-service";
import { saveProjectControls } from "@/services/output-controls";
import { makeSceneVoice } from "@/services/scene-voice";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";

/**
 * QĐ-156 REAL LOCAL: "Tạo giọng" for ONE scene (makeSceneVoice - the button
 * NGHE THỬ GIỌNG) against the REAL Mind Voice on this machine. Throwaway test
 * database, $0, no paid API. Skipped unless asked for:
 *
 *   MIND_VOICE_REAL=1 npx vitest run tests/scene-voice-real-qd156.test.ts
 */

const REAL = process.env.MIND_VOICE_REAL === "1";
const URL = process.env.MIND_VOICE_URL ?? "http://127.0.0.1:8011";
const BAT = "Những lớp vật liệu tạo thành một chiếc bát nhỏ ấm áp.";
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

/** One imported scene read by the Narrator. */
async function oneScene(narration: string): Promise<{ projectId: string; sceneId: string }> {
  const dir = path.join(tmp, `sb-${randomUUID().slice(0, 6)}`, "v");
  fs.mkdirSync(dir, { recursive: true });
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x334455:s=1080x1920", "-frames:v", "1", path.join(dir, "k.png")]);
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({
      video_id: `qd156-${tag}-${randomUUID().slice(0, 4)}`,
      video_title: "QĐ-156 tạo lại giọng",
      characters: [{ character_id: "max", character_name: "Max" }],
      scenes: [{ scene_number: 1, duration: 5, visual_description: "A nest.", character_action: "None.", camera: "Static medium shot.", dialogue: `Max: "x"`, subtitle: "", image_file: "k.png", motion_mode: "LOCAL_MOTION", priority: "NORMAL", characters_present: ["Max"], speaking_characters: ["Max"] }],
    }),
  );
  const validated = await validateImport(scanImportSource(path.dirname(dir)));
  const created = await materialiseImport(validated, { batchName: `qd156-${tag}-${randomUUID().slice(0, 4)}`, maxCostPerVideo: 5, maxCostForBatch: 50 });
  const projectId = created.projects[0]!.projectId;
  await prisma.project.update({ where: { id: projectId }, data: { language: "vi" } });
  const scene = await prisma.scene.findFirstOrThrow({ where: { projectId } });
  await prisma.scene.update({ where: { id: scene.id }, data: { dialogue: "", narration, subtitle: "", speakingCharactersJson: JSON.stringify(["Narrator"]) } });
  await saveProjectControls(projectId, { voice: { provider: "mindvoice", model: "mind-local", voiceId: "Thục Đoan" } });
  return { projectId, sceneId: scene.id };
}

const mindJobs = (sceneId: string) => prisma.providerJob.findMany({ where: { sceneId, kind: "audio" }, orderBy: { createdAt: "asc" } });

/** "Tạo giọng": the button's two steps (a $0 plan may still ask once). */
async function press(sceneId: string) {
  const ask = await makeSceneVoice(sceneId);
  return ask.status === "NEEDS_CONFIRMATION" ? makeSceneVoice(sceneId, { confirmPaid: true, expectedCost: ask.plan!.incrementalCost }) : ask;
}

/** Longest silent run (>= 120 ms, -40 dB) inside the finished line. */
async function longestPauseMs(file: string): Promise<number> {
  const { stderr } = await ffmpeg(["-hide_banner", "-i", file, "-af", "silencedetect=n=-40dB:d=0.12", "-f", "null", "-"], { keepAllOutput: true });
  return Math.max(0, ...[...stderr.matchAll(/silence_duration: ([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000)));
}

describe.skipIf(!REAL)("QĐ-156 Tạo giọng một cảnh — Mind Voice thật, $0", () => {
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qd156-real-"));
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
    const catalog = await refreshMindCatalog();
    expect(catalog.error ?? "online").toBe("online");
  }, 120_000);

  afterAll(async () => {
    await prisma.modelRegistry.deleteMany({ where: { provider: "mindvoice" } });
    await prisma.providerConfig.deleteMany({ where: { name: "mindvoice" } });
    await prisma.setting.deleteMany({ where: { key: MIND_CATALOG_SETTING } });
    if (capBefore > 0) await setSpendCap(capBefore);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("xuống dòng giữa câu: gửi Mind Voice đúng một câu liền; bấm lại = dùng lại; sửa lời = đúng 1 lần tạo mới; không gọi nhà cung cấp trả phí", async () => {
    const spentBefore = (await spendStatus()).spent;
    const { projectId, sceneId } = await oneScene("Những lớp vật liệu tạo thành một chiếc bát nhỏ\nấm áp.");

    const first = await press(sceneId);
    expect(first.status).toBe("DONE");
    let jobs = await mindJobs(sceneId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.provider).toBe("mindvoice");
    const sent = JSON.parse(jobs[0]!.requestJson ?? "{}") as { text: string; voice: string; engine: string };
    // The line break is layout: one sentence, no full stop after "nhỏ".
    expect(sent).toMatchObject({ text: BAT, voice: "Thục Đoan", engine: "vieneu" });
    const line = await prisma.dialogueLine.findFirstOrThrow({ where: { sceneId } });
    expect(line.text).toContain("\n"); // the script itself is not rewritten
    expect(await longestPauseMs(toAbsolute(line.outputPath!))).toBeLessThan(600);

    // "Tạo giọng" again with nothing changed: the same audio, 0 requests.
    const again = await press(sceneId);
    expect(again.status).toBe("DONE");
    expect(await mindJobs(sceneId)).toHaveLength(1);

    // The words change: exactly one new local request.
    await prisma.scene.update({ where: { id: sceneId }, data: { narration: "Những lớp vật liệu tạo thành một chiếc bát nhỏ, ấm áp." } });
    const edited = await press(sceneId);
    expect(edited.status).toBe("DONE");
    jobs = await mindJobs(sceneId);
    expect(jobs).toHaveLength(2);
    expect(JSON.parse(jobs[1]!.requestJson ?? "{}").text).toBe("Những lớp vật liệu tạo thành một chiếc bát nhỏ, ấm áp.");

    // $0: only Mind Voice, nothing in the ledger, nothing against the cap.
    expect(await prisma.providerJob.count({ where: { projectId, provider: { not: "mindvoice" }, kind: "audio" } })).toBe(0);
    expect(await prisma.costEntry.count({ where: { projectId } })).toBe(0);
    expect((await spendStatus()).spent).toBeCloseTo(spentBefore, 9);
  }, 300_000);
});
