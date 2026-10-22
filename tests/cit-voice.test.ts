import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { ffmpeg } from "@/media/ffmpeg";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import {
  CIT_AUTO_VOICE,
  citDirection,
  isWav,
  parseCitHealth,
  parseCitOpenApi,
  parseCitVoices,
  pickCitVoice,
} from "@/domain/cit";
import { parseDialogueLines } from "@/domain/dialogue-lines";
import { sceneCharacters } from "@/domain/scene-characters";
import { citGenerateBody } from "@/providers/cit/cit-client";
import { CIT_CATALOG_SETTING, refreshCitCatalog } from "@/services/cit-catalog";
import { voiceReuseKey } from "@/services/asset-keys";
import { ensureNarrator } from "@/services/content-service";
import { generateSceneVoice, voiceSettingsFor } from "@/services/generation";
import { saveProjectControls } from "@/services/output-controls";
import { makeSceneVoice } from "@/services/scene-voice";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { approveAndRun } from "@/services/batch-executor";
import { continueVideo } from "@/services/video-resume";
import { voiceDirectorFor } from "@/services/voice-direction";

/**
 * QĐ-144 CIT Voice Studio as a LOCAL TTS provider, against a MOCK CIT server
 * (a real HTTP server on a random port speaking the documented API). Mock
 * Mode, $0, no paid request.
 */

// ------------------------------------------------------------ mock CIT ---

const VIENEU = Array.from({ length: 25 }, (_, i) => ({ voice_id: `VN ${i + 1}`, name: `Giọng Việt ${i + 1}`, gender: i % 2 ? "Nữ" : "Nam", language: "vi", model: "VieNeu-TTS v3 Turbo" }));
const SUPERTONIC = Array.from({ length: 10 }, (_, i) => ({ voice_id: `ST ${i + 1}`, name: `Supertonic ${i + 1}`, gender: i % 2 ? "female" : "male", languages: ["en", "ja", "fr"], model: "Supertonic 3" }));

const OPENAPI = {
  openapi: "3.1.0",
  paths: {
    "/health": { get: {} },
    "/voices": { get: {} },
    "/api/tts/generate": { post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/TTSRequest" } } } } } },
    "/api/tts/conversation": { post: {} },
    "/api/pronunciation-dict": { get: {} },
  },
  components: {
    schemas: {
      TTSRequest: {
        type: "object",
        required: ["text", "voice_id"],
        properties: {
          text: { type: "string" },
          voice_id: { type: "string" },
          speed: { anyOf: [{ type: "number", minimum: 0.75, maximum: 1.5 }, { type: "null" }] },
          language: { anyOf: [{ type: "string" }, { type: "null" }] },
          format: { type: "string", enum: ["wav", "mp3"] },
        },
      },
    },
  },
};

/** One second of a 220 Hz tone, 24 kHz mono 16-bit: audible, so levelling works. */
function toneWav(seconds = 1): Buffer {
  const rate = 24000;
  const n = Math.round(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 9000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const requests: Record<string, unknown>[] = [];
let supertonicInstalled = true;
/** Answer like the REAL CIT seen 2026-10-22: one engine string, voices without an engine. */
let realShape = false;
const REAL_VOICES = ["Hải Đăng", "Thiện Minh", "Trúc Ly"].map((name, i) => ({ id: name, isCloned: false, featured: true, name, gender: i === 2 ? "female" : "male", region: "North", description: "Phong cách tự nhiên · 48 kHz" }));
let server: http.Server | null = null;
let baseUrl = "";

async function startCit(): Promise<void> {
  server = http.createServer((req, res) => {
    const json = (body: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health" && realShape) return json({ status: "ok", message: "Sẵn sàng", sample_rate: 48000, engine: "VieNeu-TTS-v3-Turbo (int8)", backend: "onnx", languages: [], supports_cloning: true });
    if (req.url === "/voices" && realShape) return json(REAL_VOICES);
    if (req.url === "/health") return json({ status: "ok", version: "1.0.3", languages: ["vi", "en", "ja", "fr"], models: [{ name: "VieNeu-TTS v3 Turbo", installed: true }, { name: "Supertonic 3", installed: supertonicInstalled }] });
    if (req.url === "/voices") return json({ voices: [...VIENEU, ...SUPERTONIC] });
    if (req.url === "/openapi.json") return json(OPENAPI);
    if (req.url === "/api/tts/generate" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        requests.push(body);
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(toneWav(1));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function stopCit(): Promise<void> {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
}

// ------------------------------------------------------------- fixtures ---

let tmp = "";
let capBefore = 0;
const tag = randomUUID().slice(0, 6);

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

/** A storyboard video of narrated scenes (narrator = Narrator), ready to voice. */
async function narratedVideo(lines: string[], language: string): Promise<{ batchId: string; projectId: string; sceneIds: string[] }> {
  const dir = path.join(tmp, `sb-${randomUUID().slice(0, 6)}`, "v");
  fs.mkdirSync(dir, { recursive: true });
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=1080x1920", "-frames:v", "1", path.join(dir, "k.png")]);
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({
      video_id: `cit-${tag}-${randomUUID().slice(0, 4)}`,
      video_title: `cit-${tag}`,
      characters: [{ character_id: "max", character_name: "Max" }],
      scenes: lines.map((_, i) => ({
        scene_number: i + 1,
        duration: 3,
        visual_description: `Shot ${i + 1}.`,
        character_action: "Waves.",
        camera: "Static medium shot.",
        dialogue: `Max: "x ${i}"`,
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
  expect(validated.issues.filter((i) => i.level === "error")).toEqual([]);
  const created = await materialiseImport(validated, { batchName: `cit-${tag}-${randomUUID().slice(0, 4)}`, maxCostPerVideo: 5, maxCostForBatch: 50 });
  const projectId = created.projects[0]!.projectId;
  await prisma.project.update({ where: { id: projectId }, data: { language } });
  const scenes = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
  for (const [i, s] of scenes.entries()) {
    await prisma.scene.update({
      where: { id: s.id },
      data: { dialogue: "", narration: lines[i]!, subtitle: "", speakingCharactersJson: JSON.stringify(["Narrator"]) },
    });
  }
  return { batchId: created.batchId, projectId, sceneIds: scenes.map((s) => s.id) };
}

const citLines = (projectId: string) =>
  prisma.dialogueLine.findMany({ where: { scene: { projectId } }, orderBy: [{ scene: { sceneNumber: "asc" } }, { lineNumber: "asc" }] });
const citLedger = () => prisma.costEntry.count({ where: { provider: "cit" } });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cit-voice-"));
  await seedMock();
  await ensureNarrator();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
  await startCit();
  await prisma.providerConfig.upsert({
    where: { name: "cit" },
    create: { name: "cit", displayName: "CIT", types: JSON.stringify(["voice"]), enabled: true, baseUrl, status: "connected" },
    update: { enabled: true, baseUrl },
  });
}, 120_000);

afterAll(async () => {
  await stopCit();
  // Leave the shared test database as other files expect it: no CIT.
  await prisma.modelRegistry.deleteMany({ where: { provider: "cit" } });
  await prisma.providerConfig.deleteMany({ where: { name: "cit" } });
  await prisma.setting.deleteMany({ where: { key: CIT_CATALOG_SETTING } });
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- pure ---

describe("QĐ-144 CIT - discovery + adapter (thuần)", () => {
  it("health / voices / OpenAPI: đọc theo dữ liệu CIT trả về, không danh sách cố định", () => {
    const h = parseCitHealth({ status: "ok", version: "1.0.3", languages: ["vi", "en"], models: [{ name: "Supertonic 3", installed: false }] });
    expect(h).toMatchObject({ version: "1.0.3", languages: ["vi", "en"] });
    expect(h.engines[0]).toMatchObject({ engine: "SUPERTONIC", installed: false });
    expect(parseCitHealth({ status: "ok", engines: { "VieNeu-TTS": true } }).engines[0]).toMatchObject({ engine: "VIENEU", installed: true });
    // The real CIT (2026-10-22): one active engine as a string.
    expect(parseCitHealth({ status: "ok", engine: "VieNeu-TTS-v3-Turbo (int8)", languages: [], supports_cloning: true }).engines).toEqual([
      { engine: "VIENEU", name: "VieNeu-TTS-v3-Turbo (int8)", installed: null },
    ]);
    expect(parseCitVoices(["Minh Đức", "Ngọc Huyền"])).toHaveLength(2);
    expect(parseCitVoices({ voices: [...VIENEU, ...SUPERTONIC] })).toHaveLength(35);
    expect(parseCitVoices({ data: [{ id: "A", engine: "supertonic" }] })[0]).toMatchObject({ id: "A", engine: "SUPERTONIC" });
    expect(parseCitVoices({ "Minh Đức": { gender: "Nam" } })[0]).toMatchObject({ id: "Minh Đức", gender: "Nam" });
    const spec = parseCitOpenApi(OPENAPI);
    expect(spec.generate).toMatchObject({ fields: ["text", "voice_id", "speed", "language", "format"], bodyType: "json", speed: { min: 0.75, max: 1.5 }, formats: ["wav", "mp3"] });
    expect(spec.conversation).toBe(true);
    expect(spec.pronunciationPaths).toEqual(["/api/pronunciation-dict"]);
  });

  it("request: chỉ gửi field CIT khai báo; không có OpenAPI → chỉ text + voice_id; tốc độ kẹp theo spec", () => {
    const req = { text: "Xin chào", voiceId: "VN 1", speed: 2, language: "vi" };
    expect(citGenerateBody(null, req)).toEqual({ text: "Xin chào", voice_id: "VN 1" });
    expect(citGenerateBody(parseCitOpenApi(OPENAPI).generate, req)).toEqual({ text: "Xin chào", voice_id: "VN 1", speed: 1.5, language: "vi", format: "wav" });
    expect(citGenerateBody(parseCitOpenApi(OPENAPI).generate, { ...req, speed: 0.5 }).speed).toBe(0.75);
  });

  it("định tuyến ngôn ngữ: vi → VieNeu, en → Supertonic; Supertonic chưa tải / ngôn ngữ không hỗ trợ → báo rõ", () => {
    const voices = parseCitVoices({ voices: [...VIENEU, ...SUPERTONIC] });
    const health = parseCitHealth({ languages: ["vi", "en", "ja"], models: [{ name: "Supertonic 3", installed: true }] });
    expect(pickCitVoice(voices, health, "vi")).toMatchObject({ ok: true, voice: { engine: "VIENEU" } });
    expect(pickCitVoice(voices, health, "en")).toMatchObject({ ok: true, voice: { engine: "SUPERTONIC" } });
    expect(pickCitVoice(voices, health, "ja")).toMatchObject({ ok: true, voice: { engine: "SUPERTONIC" } });
    const missing = parseCitHealth({ languages: ["vi", "en"], models: [{ name: "Supertonic 3", installed: false }] });
    const r = pickCitVoice(voices, missing, "en");
    expect(r).toMatchObject({ ok: false, code: "SUPERTONIC_NOT_READY" });
    expect(!r.ok && r.message).toMatch(/Cài đặt → Mô hình/);
    expect(pickCitVoice(voices, health, "ko")).toMatchObject({ ok: false, code: "LANGUAGE_UNSUPPORTED" });
  });

  it("Voice Director adapter: Professional không tag; Documentary nghỉ; Comedy punchline 1 tiếng cười đúng cú pháp engine; cảm động thở dài", () => {
    const two = "Câu một rất hay. Câu hai còn hay hơn!";
    expect(citDirection({ text: two, engine: "VIENEU", style: "PROFESSIONAL", role: "EXPLAIN", emotion: "NEUTRAL" }).text).toBe(two);
    expect(citDirection({ text: two, engine: "VIENEU", style: "PRODUCT_REVIEW", role: "EXPLAIN", emotion: "EXCITED" }).text).toBe(two);
    expect(citDirection({ text: two, engine: "VIENEU", style: "DOCUMENTARY", role: "EXPLAIN", emotion: "SERIOUS" }).text).toBe("Câu một rất hay.\nCâu hai còn hay hơn!");
    const vn = citDirection({ text: two, engine: "VIENEU", style: "COMEDY", role: "PUNCHLINE", emotion: "HUMOROUS" });
    expect(vn.text).toBe("Câu một rất hay.\nCâu hai còn hay hơn! [cười]");
    expect(citDirection({ text: two, engine: "SUPERTONIC", style: "COMEDY", role: "PUNCHLINE", emotion: "HUMOROUS" }).text).toMatch(/<laugh>$/);
    expect(citDirection({ text: two, engine: "VIENEU", style: "STORYTELLING", role: "EMOTIONAL", emotion: "TOUCHING" }).text).toBe("[thở dài] Câu một rất hay.\nCâu hai còn hay hơn!");
    // No pause TAG ever: VieNeu reads an unknown [..] aloud (real CIT, 2026-10-22).
    for (const style of ["DOCUMENTARY", "DRAMATIC", "STORYTELLING", "COMEDY"] as const) {
      for (const engine of ["VIENEU", "SUPERTONIC", "UNKNOWN"] as const) {
        expect(citDirection({ text: two, engine, style, role: "PUNCHLINE", emotion: "TOUCHING" }).text).not.toMatch(/\[nghỉ/);
      }
    }
    // Unknown engine: pauses only; director off: the words only.
    expect(citDirection({ text: two, engine: "UNKNOWN", style: "COMEDY", role: "PUNCHLINE", emotion: "HUMOROUS" }).text).not.toMatch(/cười|laugh/);
    expect(citDirection({ text: two, engine: "VIENEU", style: null, role: null, emotion: null }).text).toBe(two);
    // Never more than one emotion tag.
    const tags = (s: string) => (s.match(/\[(cười|thở dài|hắng giọng)\]|<(laugh|sigh|breath)>/g) ?? []).length;
    for (const style of ["COMEDY", "DOCUMENTARY", "STORYTELLING", "PROFESSIONAL"] as const) {
      for (const role of ["PUNCHLINE", "EMOTIONAL", "HOOK"] as const) {
        expect(tags(citDirection({ text: two, engine: "VIENEU", style, role, emotion: "TOUCHING" }).text)).toBeLessThanOrEqual(1);
      }
    }
    expect(isWav(toneWav(0.1))).toBe(true);
  });
});

// ---------------------------------------------------------- end-to-end ---

describe("QĐ-144 CIT - mock CIT server, Mock Mode, $0", () => {
  it("health online → 35 giọng (25 VieNeu + 10 Supertonic) từ /voices; offline → báo Offline, không lỗi, giữ danh sách", async () => {
    const online = await refreshCitCatalog();
    expect(online.online).toBe(true);
    expect(online.voices).toHaveLength(35);
    expect(online.voices.filter((v) => v.engine === "VIENEU")).toHaveLength(25);
    expect(online.spec?.generate?.fields).toContain("language");
    await stopCit();
    const offline = await refreshCitCatalog();
    expect(offline.online).toBe(false);
    expect(offline.error).toMatch(/Mở ứng dụng CIT Voice Studio/);
    expect(offline.voices).toHaveLength(35);
    await startCit();
    await prisma.providerConfig.update({ where: { name: "cit" }, data: { baseUrl } });
    expect((await refreshCitCatalog()).online).toBe(true);
  });

  it("dạng dữ liệu CIT thật: engine từ /health gán cho mọi giọng → 'Tự động' tiếng Việt chọn được giọng VieNeu", async () => {
    realShape = true;
    try {
      const c = await refreshCitCatalog();
      expect(c.voices.map((v) => [v.id, v.engine])).toEqual(REAL_VOICES.map((v) => [v.id, "VIENEU"]));
      expect(pickCitVoice(c.voices, c.health, "vi")).toMatchObject({ ok: true, voice: { id: "Hải Đăng", engine: "VIENEU" } });
    } finally {
      realShape = false;
      await refreshCitCatalog();
    }
  });

  it("tiếng Việt nhiều cảnh: Narrator không bị đọc, cùng một giọng, language=vi, $0 không ghi sổ; preview → run → render lại = 0 request", async () => {
    const v = await narratedVideo([`Narrator: Xin chào mọi người ${tag}.`, `Hôm nay mình review iPhone 15 Pro ${tag}. Rất đáng tiền!`, `Speaker A: Lưu ý: nhớ lưu video ${tag} nhé.`], "vi");
    await saveProjectControls(v.projectId, { voice: { provider: "cit", model: "cit-local", voiceId: null } });
    const ledgerBefore = await citLedger();
    const spentBefore = (await spendStatus()).spent;
    const before = requests.length;

    // ▶ NGHE THỬ the first scene, then the whole run.
    const ask = await makeSceneVoice(v.sceneIds[0]!);
    const made = ask.status === "NEEDS_CONFIRMATION" ? await makeSceneVoice(v.sceneIds[0]!, { confirmPaid: true, expectedCost: ask.plan!.incrementalCost }) : ask;
    expect(made.status).toBe("DONE");
    expect(ask.plan?.incrementalCost ?? 0).toBe(0);
    expect(requests.length - before).toBe(1);
    await approveAndRun({ batchId: v.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    const project = await prisma.project.findUniqueOrThrow({ where: { id: v.projectId } });
    expect(project.status).toBe("completed");
    const sent = requests.slice(before);
    expect(sent).toHaveLength(3);
    for (const body of sent) {
      expect(String(body.text)).not.toMatch(/Narrator:|Speaker A:|Speaker B:|Host:|Voice Over:|VO:/);
      expect(body.language).toBe("vi");
      expect(body.format).toBe("wav");
      expect(body).not.toHaveProperty("instructions");
    }
    expect(sent[0]!.text).toBe(`Xin chào mọi người ${tag}.`);
    expect(sent[1]!.text).toBe(`Hôm nay mình review iPhone 15 Pro ${tag}. Rất đáng tiền!`);
    expect(sent[2]!.text).toBe(`Lưu ý: nhớ lưu video ${tag} nhé.`);
    // Same narrator voice everywhere: the AUTO pick for Vietnamese (VieNeu).
    expect(new Set(sent.map((b) => b.voice_id))).toEqual(new Set(["VN 1"]));
    const lines = await citLines(v.projectId);
    expect(lines.map((l) => [l.provider, l.model, l.voiceId])).toEqual(lines.map(() => ["cit", "cit-local", "VN 1"]));
    expect(lines[0]!.instructions).toMatch(/^CIT cit-v2 engine=VIENEU lang=vi/);
    // $0: no ledger line, nothing against the cap.
    expect(await citLedger()).toBe(ledgerBefore);
    expect((await spendStatus()).spent).toBeCloseTo(spentBefore, 9);
    const assets = await prisma.asset.findMany({ where: { projectId: v.projectId, kind: "audio", provider: "cit" } });
    expect(assets.length).toBe(3);
    expect(assets.every((a) => a.actualCost === 0)).toBe(true);

    // Render again, camera and subtitle edits: 0 requests.
    const posts = requests.length;
    fs.rmSync(toAbsolute(project.finalVideoPath!));
    await prisma.scene.update({ where: { id: v.sceneIds[1]! }, data: { camera: "slow push-in", subtitle: "Phụ đề mới" } });
    expect((await continueVideo(v.projectId, { wait: true })).status).toBe("COMPLETED");
    for (const id of v.sceneIds) await generateSceneVoice(id);
    expect(requests.length).toBe(posts);

    // Speed and voice changes invalidate exactly the voice they touch.
    await saveProjectControls(v.projectId, { voice: { speed: 1.2 } });
    await generateSceneVoice(v.sceneIds[0]!);
    expect(requests.length).toBe(posts + 1);
    expect(requests[requests.length - 1]!.speed).toBe(1.2);
    // Back to the old speed: the old audio is still there and is reused, 0 requests.
    await saveProjectControls(v.projectId, { voice: { speed: null } });
    for (const id of v.sceneIds) await generateSceneVoice(id);
    expect(requests.length).toBe(posts + 1);
  }, 900_000);

  it("Voice Director bật: tag CIT trong text, không gửi instructions; English → Supertonic, Supertonic chưa tải → báo rõ, không gọi nhà cung cấp khác", async () => {
    const v = await narratedVideo([`Welcome back ${tag}. Today we test three gadgets.`], "en");
    await saveProjectControls(v.projectId, { voice: { provider: "cit", model: "cit-local", voiceId: null, director: true, emotion: "TOUCHING" } });
    const before = requests.length;
    await generateSceneVoice(v.sceneIds[0]!);
    const body = requests[before]!;
    expect(body.language).toBe("en");
    expect(String(body.voice_id)).toMatch(/^ST /);
    expect(body.text).toBe(`<sigh> Welcome back ${tag}. Today we test three gadgets.`);
    expect(body).not.toHaveProperty("instructions");
    const line = (await citLines(v.projectId))[0]!;
    expect(line.text).toBe(`Welcome back ${tag}. Today we test three gadgets.`);

    // Supertonic not downloaded: a clear message, no other provider tried.
    supertonicInstalled = false;
    await refreshCitCatalog();
    await prisma.scene.update({ where: { id: v.sceneIds[0]! }, data: { narration: `A brand new line ${tag}.` } });
    const jobsBefore = await prisma.providerJob.count({ where: { sceneId: v.sceneIds[0]! } });
    await expect(generateSceneVoice(v.sceneIds[0]!)).rejects.toThrow(/Supertonic 3|chưa sẵn sàng/);
    const jobs = await prisma.providerJob.findMany({ where: { sceneId: v.sceneIds[0]! } });
    expect(jobs.length - jobsBefore).toBeLessThanOrEqual(1);
    expect(jobs.every((j) => j.provider === "cit")).toBe(true);
    supertonicInstalled = true;
    await refreshCitCatalog();
  }, 600_000);

  it("CIT offline: dừng với hướng dẫn mở CIT, KHÔNG gọi OpenAI / mock, $0; mở lại → chạy tiếp", async () => {
    const v = await narratedVideo([`Narrator: Câu này cần CIT ${tag}.`], "vi");
    await saveProjectControls(v.projectId, { voice: { provider: "cit", model: "cit-local", voiceId: "VN 3" } });
    const ledger = await prisma.costEntry.count();
    await stopCit();
    await expect(generateSceneVoice(v.sceneIds[0]!)).rejects.toThrow(/CIT_OFFLINE|Mở ứng dụng CIT Voice Studio/);
    const jobs = await prisma.providerJob.findMany({ where: { sceneId: v.sceneIds[0]! } });
    expect(jobs.every((j) => j.provider === "cit")).toBe(true);
    expect(await prisma.dialogueLine.count({ where: { sceneId: v.sceneIds[0]!, status: "completed" } })).toBe(0);
    expect(await prisma.costEntry.count()).toBe(ledger);
    await startCit();
    await prisma.providerConfig.update({ where: { name: "cit" }, data: { baseUrl } });
    const before = requests.length;
    await generateSceneVoice(v.sceneIds[0]!);
    expect(requests.length - before).toBe(1);
    expect(requests[before]).toMatchObject({ voice_id: "VN 3", text: `Câu này cần CIT ${tag}.` });
  }, 600_000);

  it("hội thoại nhiều người: mỗi nhân vật đúng giọng CIT của mình, mỗi câu một request, nhãn tên không bị đọc", async () => {
    const original = await prisma.character.findMany({ where: { name: { in: ["Max", "Leo"] } } });
    try {
      await prisma.character.update({ where: { name: "Max" }, data: { voiceProvider: "cit", voiceModel: "cit-local", voiceId: "VN 2" } });
      await prisma.character.update({ where: { name: "Leo" }, data: { voiceProvider: "cit", voiceModel: "cit-local", voiceId: "VN 5" } });
      const v = await narratedVideo([""], "vi");
      await prisma.scene.update({
        where: { id: v.sceneIds[0]! },
        data: {
          dialogue: `Max: Bạn ăn sáng chưa ${tag}?\nLeo: Mình ăn rồi, cảm ơn nhé.\nMax: Vậy đi thôi!`,
          narration: "",
          speakingCharactersJson: JSON.stringify(["Max", "Leo"]),
          charactersPresentJson: JSON.stringify(["Max", "Leo"]),
        },
      });
      const before = requests.length;
      await generateSceneVoice(v.sceneIds[0]!);
      expect(requests.slice(before).map((b) => [b.voice_id, b.text])).toEqual([
        ["VN 2", `Bạn ăn sáng chưa ${tag}?`],
        ["VN 5", "Mình ăn rồi, cảm ơn nhé."],
        ["VN 2", "Vậy đi thôi!"],
      ]);
    } finally {
      for (const c of original) await prisma.character.update({ where: { id: c.id }, data: { voiceProvider: c.voiceProvider, voiceModel: c.voiceModel, voiceId: c.voiceId } });
    }
  }, 600_000);

  it("dự án OpenAI cũ không đổi: cùng settings, cùng khoá giọng, không có tag / language CIT", async () => {
    const v = await narratedVideo([`Narrator: Dự án cũ ${tag}.`], "vi");
    const scene = await prisma.scene.findUniqueOrThrow({ where: { id: v.sceneIds[0]! } });
    const line = parseDialogueLines(scene.dialogue, scene.narration, sceneCharacters(scene).speaking)[0]!;
    const base = await voiceSettingsFor(line.speaker, v.projectId);
    expect(base.provider).not.toBe("cit");
    const off = (await voiceDirectorFor(scene))(line, base);
    expect(off).toEqual(base);
    await saveProjectControls(v.projectId, { voice: { director: true } });
    const on = (await voiceDirectorFor(await prisma.scene.findUniqueOrThrow({ where: { id: v.sceneIds[0]! } })))(line, base);
    expect(on.instructions).not.toMatch(/^CIT /);
    expect(on.language).toBeUndefined();
    expect(on.spokenText).not.toMatch(/\[nghỉ|\[cười|<laugh>/);
    const key = (s: typeof on) => voiceReuseKey({ provider: "openai", model: "gpt-4o-mini-tts", text: line.text, voiceId: s.voiceId, instructions: s.instructions, speed: s.speed, accent: "US", targetDuration: 3, spokenText: s.spokenText });
    expect(key(on)).toBe(key({ ...on }));
    expect(CIT_AUTO_VOICE).toBe("AUTO");
  });
});
