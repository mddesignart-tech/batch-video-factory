import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
import { prisma } from "@/lib/prisma";
import { resetEnvCache } from "@/lib/env";
import { ffmpeg } from "@/media/ffmpeg";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import {
  characterLineLanguage,
  characterProfiles,
  parseVoiceProfiles,
  profileForLanguage,
  VOICE_LOCALES,
  VOICE_PROFILE_STALE,
  withoutProfile,
  withProfile,
  type CharacterVoiceRow,
} from "@/domain/voice-locale";
import { MIND_CATALOG_SETTING, refreshMindCatalog } from "@/services/mind-voice-catalog";
import { characterVoiceIssues, checkVoiceChoice, savedVoiceProblem, voiceCatalogFor } from "@/services/voice-catalog";
import { ensureNarrator } from "@/services/content-service";
import { generateSceneVoice, planSceneVoice } from "@/services/generation";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { previewVoiceChoice, removeCharacterVoiceProfile, saveCharacterVoice } from "@/app/actions/characters";
import { deleteCharacter, saveCharacter } from "@/app/actions/config";
import { saveProjectControls } from "@/services/output-controls";
import { duplicateProject, duplicateScene } from "@/services/trash-service";

/**
 * QĐ-158 CHARACTER VOICE MANAGER - a voice per language, chosen from the voices
 * the engine really has, kept for the character in every scene. Against a MOCK
 * Mind Voice server (a real HTTP server on a random port speaking
 * voice-engine/mind_voice/server.py's API). Mock Mode, $0, no paid request.
 */

// ------------------------------------------------------- mock Mind Voice ---

const VIENEU = [
  ["Thục Đoan", "female", "south"],
  ["Ngọc Huyền", "female", "north"],
  ["Quang Sơn", "male", "central"],
  ["Hải Đăng", "male", "north"],
  ["Mặc định", "female", "north"],
].map(([id, gender, region], i) => ({
  id,
  name: id,
  engine: "vieneu",
  languages: ["vi"],
  gender,
  region,
  style: "natural",
  description: "",
  featured: i + 1,
  aliases: [],
  default: id === "Mặc định",
  installed: true,
}));
const SUPERTONIC = ["F1", "F2", "M1", "M2", "M3"].map((id) => ({
  id,
  name: id,
  engine: "supertonic",
  languages: ["en"],
  gender: id.startsWith("F") ? "female" : "male",
  region: null,
  style: null,
  description: "Supertonic 3",
  featured: null,
  aliases: [],
  default: id === "M1",
  installed: true,
}));

function toneWav(seconds = 1, rate = 48000): Buffer {
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
let server: http.Server | null = null;
let baseUrl = "";

const health = () => ({
  status: "ok",
  service: "mind-voice",
  version: "0.1.0",
  hardware: { cpu: "Test CPU", threads: 6, ram_gb: 32, gpu: null, cuda_ready: false, device: "cpu", gpu_note: null },
  engines: [
    { id: "vieneu", label: "VieNeu-TTS v3 Turbo", languages: ["vi"], installed: true, variant: "fp32", loaded: false, sample_rate: 48000, native_speed: false, tags: [], license: "Apache-2.0" },
    { id: "supertonic", label: "Supertonic 3", languages: ["en"], installed: true, variant: "cpu", loaded: false, sample_rate: 44100, native_speed: true, tags: [], license: "OpenRAIL-M" },
  ],
});

async function startMind(): Promise<void> {
  server = http.createServer((req, res) => {
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return json(health());
    if (req.url?.startsWith("/voices")) return json({ voices: [...VIENEU, ...SUPERTONIC] });
    if (req.url === "/tts" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        requests.push(body);
        const st = body.engine === "supertonic";
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "X-Engine": String(body.engine),
          "X-Engine-Variant": st ? "cpu" : "fp32",
          "X-Sample-Rate": st ? "44100" : "48000",
          "X-Duration": "1.000",
          "X-Speed-Applied": st ? "1" : "0",
        });
        res.end(toneWav(1, st ? 44100 : 48000));
      });
      return;
    }
    json({ error: { code: "NOT_FOUND", message: "nope" } }, 404);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  await prisma.providerConfig.upsert({
    where: { name: "mindvoice" },
    create: { name: "mindvoice", displayName: "Mind Voice", types: JSON.stringify(["voice"]), enabled: true, baseUrl, status: "connected" },
    update: { enabled: true, baseUrl },
  });
}

async function stopMind(): Promise<void> {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
}

// ------------------------------------------------------------- fixtures ---

let tmp = "";
const tag = randomUUID().slice(0, 6);
const created: string[] = [];

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

async function newCharacter(name: string): Promise<string> {
  const c = await prisma.character.create({
    data: { name, description: "QA", personality: "", visualPrompt: "A person in a shop, QA fixture.", voiceProvider: "mock", voiceModel: "mock-voice-std", voiceId: "mock-male-us" },
  });
  created.push(c.id);
  return c.id;
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const save = (id: string, locale: string, voiceId: string, extra: Record<string, string> = {}) =>
  saveCharacterVoice(id, form({ locale, voiceProvider: "mindvoice", voiceModel: "mind-local", voiceId, voiceSpeed: "1", voiceInstructions: "Warm, clear narrator.", ...extra }));

/** A one-scene storyboard video; the scene is then given `dialogue` spoken by `speaking`. */
async function sceneWith(dialogue: string, speaking: string[], language = "vi"): Promise<{ projectId: string; sceneId: string }> {
  const dir = path.join(tmp, `sb-${randomUUID().slice(0, 6)}`, "v");
  fs.mkdirSync(dir, { recursive: true });
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=1080x1920", "-frames:v", "1", path.join(dir, "k.png")]);
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({
      video_id: `cvm-${tag}-${randomUUID().slice(0, 4)}`,
      video_title: `cvm-${tag}`,
      characters: [{ character_id: "max", character_name: "Max" }],
      scenes: [
        {
          scene_number: 1,
          duration: 4,
          visual_description: "Shop counter.",
          character_action: "Talks.",
          camera: "Static medium shot.",
          dialogue: 'Max: "x"',
          subtitle: "",
          image_file: "k.png",
          motion_mode: "LOCAL_MOTION",
          priority: "NORMAL",
          characters_present: ["Max"],
          speaking_characters: ["Max"],
        },
      ],
    }),
  );
  const validated = await validateImport(scanImportSource(path.dirname(dir)));
  expect(validated.issues.filter((i) => i.level === "error")).toEqual([]);
  const made = await materialiseImport(validated, { batchName: `cvm-${tag}-${randomUUID().slice(0, 4)}`, maxCostPerVideo: 5, maxCostForBatch: 50 });
  const projectId = made.projects[0]!.projectId;
  await prisma.project.update({ where: { id: projectId }, data: { language } });
  const scene = await prisma.scene.findFirstOrThrow({ where: { projectId } });
  await prisma.scene.update({
    where: { id: scene.id },
    data: { dialogue, narration: "", subtitle: "", speakingCharactersJson: JSON.stringify(speaking), charactersPresentJson: JSON.stringify(speaking) },
  });
  return { projectId, sceneId: scene.id };
}

const sentSince = (n: number) => requests.slice(n).map((b) => ({ voice: b.voice, engine: b.engine, language: b.language, text: b.text }));

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cvm-"));
  await seedMock();
  await ensureNarrator();
  await startMind();
  expect((await refreshMindCatalog()).voices).toHaveLength(10);
}, 120_000);

afterAll(async () => {
  await stopMind();
  await prisma.character.deleteMany({ where: { id: { in: created } } });
  // Leave the shared test database as other files expect it: no Mind Voice.
  await prisma.modelRegistry.deleteMany({ where: { provider: "mindvoice" } });
  await prisma.providerConfig.deleteMany({ where: { name: "mindvoice" } });
  await prisma.setting.deleteMany({ where: { key: MIND_CATALOG_SETTING } });
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- pure ---

const row = (over: Partial<CharacterVoiceRow> = {}): CharacterVoiceRow => ({
  voiceProvider: "mindvoice",
  voiceModel: "mind-local",
  voiceId: "Thục Đoan",
  voiceSpeed: 1,
  voiceInstructions: "",
  voiceGender: "female",
  voiceAccent: "US",
  voiceLanguage: "",
  voiceProfilesJson: "{}",
  ...over,
});

describe("QĐ-158 ngôn ngữ giọng (thuần)", () => {
  it("3 ngôn ngữ, câu thử đúng ngôn ngữ và không có nhãn người nói", () => {
    expect(VOICE_LOCALES.map((l) => l.id)).toEqual(["vi-VN", "en", "en-US", "en-GB"]);
    for (const l of VOICE_LOCALES) expect(l.sample).not.toMatch(/^\s*\w+\s*:/);
    expect(VOICE_LOCALES.find((l) => l.id === "vi-VN")!.sample).toBe("Xin chào, rất vui được gặp bạn tại cửa hàng của chúng tôi.");
  });

  it("nhân vật cũ (chưa có ngôn ngữ) giữ nguyên hành vi; 1 ngôn ngữ = luôn ngôn ngữ đó; nhiều ngôn ngữ = theo chữ của câu", () => {
    expect(characterProfiles(row())).toEqual([]);
    expect(characterLineLanguage(row(), "Hello there")).toBeNull();
    const us = row({ voiceLanguage: "en-US", voiceId: "M1", voiceGender: "male" });
    expect(characterLineLanguage(us, "Xin chào")).toBe("en");
    const both = withProfile(row({ voiceLanguage: "vi-VN" }), "en-US", { provider: "mindvoice", model: "mind-local", voiceId: "F2", speed: 1.1, instructions: "", gender: "female" }, false);
    expect(both.voiceId).toBe("Thục Đoan");
    expect(characterLineLanguage(both, "Xin chào bạn")).toBe("vi");
    expect(characterLineLanguage(both, "Hello, nice to meet you")).toBe("en");
    expect(profileForLanguage(both, "en")).toMatchObject({ locale: "en-US", primary: false, profile: { voiceId: "F2", speed: 1.1 } });
    expect(profileForLanguage(both, "vi")).toMatchObject({ locale: "vi-VN", primary: true, profile: { voiceId: "Thục Đoan" } });
  });

  it("đổi ngôn ngữ chính không mất giọng cũ; bỏ được giọng phụ, không bỏ được giọng chính; JSON hỏng = không có giọng phụ", () => {
    const both = withProfile(row({ voiceLanguage: "vi-VN" }), "en-GB", { provider: "mindvoice", model: "mind-local", voiceId: "F1", speed: 1, instructions: "", gender: "female" }, false);
    const swapped = withProfile({ ...row(), ...both }, "en-GB", parseVoiceProfiles(both.voiceProfilesJson)["en-GB"]!, true);
    expect(swapped).toMatchObject({ voiceLanguage: "en-GB", voiceId: "F1", voiceAccent: "UK" });
    expect(parseVoiceProfiles(swapped.voiceProfilesJson)["vi-VN"]).toMatchObject({ voiceId: "Thục Đoan" });
    expect(withoutProfile({ ...row(), ...swapped }, "en-GB")).toBeNull();
    expect(JSON.parse(withoutProfile({ ...row(), ...swapped }, "vi-VN")!.voiceProfilesJson)).toEqual({});
    expect(parseVoiceProfiles("{oops")).toEqual({});
  });
});

// -------------------------------------------------------------- catalog ---

describe("QĐ-158 Voice Catalog + lưu giọng (Mind Voice giả, Mock Mode, $0)", () => {
  it("lọc theo ngôn ngữ: vi-VN = giọng VieNeu (giới tính + vùng miền), English General = 10 giọng Supertonic; en-US / en-GB = 0 giọng (không ai xác minh giọng vùng)", async () => {
    const vi = await voiceCatalogFor("vi-VN");
    const mind = vi.models.find((m) => m.provider === "mindvoice")!;
    expect(mind).toMatchObject({ status: "ONLINE", local: true, pricePer1kChars: 0, supportsInstructions: false, emotion: "TAGS" });
    expect(mind.voices.map((v) => v.id)).toEqual(VIENEU.map((v) => v.id));
    expect(mind.voices.find((v) => v.id === "Thục Đoan")).toMatchObject({ gender: "female", region: "south", languageVerified: true, accentVerified: true });
    const en = (await voiceCatalogFor("en")).models.find((m) => m.provider === "mindvoice")!;
    expect(en.voices.map((v) => v.id)).toEqual(SUPERTONIC.map((v) => v.id));
    expect(en.voices.every((v) => v.languageVerified && !v.accentVerified)).toBe(true);
    // Never an OpenAI voice on Mind Voice.
    expect(en.voices.some((v) => ["sage", "coral", "ballad", "echo"].includes(v.id))).toBe(false);
    for (const locale of ["en-US", "en-GB"] as const) {
      const cat = await voiceCatalogFor(locale);
      const mind = cat.models.find((m) => m.provider === "mindvoice")!;
      expect(mind.voices).toEqual([]);
      expect(mind.statusMessage).toMatch(/English — General/);
      expect(cat.models.filter((m) => m.provider === "openai").every((m) => m.voices.length === 0)).toBe(true);
    }
    // Mock Mode lists the fake voices, labelled as fake, by accent.
    expect((await voiceCatalogFor("en-GB")).models.find((m) => m.provider === "mock")!.voices.map((v) => v.id)).toEqual(["mock-male-uk", "mock-female-uk"]);
  });

  it('chặn giọng không tồn tại: "sage" trên Mind Voice, giọng Việt cho en-US, giọng Anh cho vi-VN', async () => {
    const vi = await voiceCatalogFor("vi-VN");
    expect(checkVoiceChoice(vi, "mindvoice", "mind-local", "sage")).toMatchObject({ ok: false });
    expect(checkVoiceChoice(vi, "mindvoice", "mind-local", "M1")).toMatchObject({ ok: false });
    expect(checkVoiceChoice(vi, "mindvoice", "mind-local", "Thục Đoan")).toMatchObject({ ok: true });
    const en = await voiceCatalogFor("en");
    expect(checkVoiceChoice(en, "mindvoice", "mind-local", "Thục Đoan")).toMatchObject({ ok: false });
    expect(checkVoiceChoice(en, "mindvoice", "mind-local", "M2")).toMatchObject({ ok: true });
    // Not labelled American from its name or gender.
    expect(checkVoiceChoice(await voiceCatalogFor("en-US"), "mindvoice", "mind-local", "M2")).toMatchObject({ ok: false });

    const id = await newCharacter(`Sage${tag}`);
    const refused = await save(id, "vi-VN", "sage");
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/không có giọng "sage"/);
    expect((await prisma.character.findUniqueOrThrow({ where: { id } })).voiceId).toBe("mock-male-us");
  });

  it("lưu → mở lại: giọng chính tiếng Việt + giọng phụ tiếng Anh; giới tính lấy từ engine; bỏ giọng phụ", async () => {
    const id = await newCharacter(`Lan${tag}`);
    expect((await save(id, "vi-VN", "Thục Đoan", { voiceGender: "male" })).ok).toBe(true);
    expect((await save(id, "en", "F2", { voiceSpeed: "1.2" })).ok).toBe(true);
    const c = await prisma.character.findUniqueOrThrow({ where: { id } });
    expect(c).toMatchObject({ voiceLanguage: "vi-VN", voiceProvider: "mindvoice", voiceModel: "mind-local", voiceId: "Thục Đoan", voiceGender: "female" });
    expect(characterProfiles(c).map((p) => [p.locale, p.profile.voiceId, p.profile.speed, p.primary])).toEqual([
      ["vi-VN", "Thục Đoan", 1, true],
      ["en", "F2", 1.2, false],
    ]);
    // Speed is clamped to what Mind Voice can do, never sent out of range.
    expect((await save(id, "en", "F1", { voiceSpeed: "3" })).message).toMatch(/Tốc độ đưa về 1.5/);
    expect(characterProfiles(await prisma.character.findUniqueOrThrow({ where: { id } }))[1]!.profile).toMatchObject({ voiceId: "F1", speed: 1.5 });
    expect((await removeCharacterVoiceProfile(id, "en")).ok).toBe(true);
    expect((await removeCharacterVoiceProfile(id, "vi-VN")).ok).toBe(false);
    expect(characterProfiles(await prisma.character.findUniqueOrThrow({ where: { id } })).map((p) => p.locale)).toEqual(["vi-VN"]);
  });

  it("giọng giả lập (mock) ngoài Mock Mode = chưa có giọng thật: cảnh báo; trong Mock Mode thì bình thường", () => {
    const mock = { provider: "mock", model: "mock-voice-std", voiceId: "mock-male-us" };
    expect(savedVoiceProblem(mock, null, null)).toBeNull();
    const prev = process.env.AI_MOCK_MODE;
    try {
      process.env.AI_MOCK_MODE = "false";
      resetEnvCache();
      expect(savedVoiceProblem(mock, null, null)).toMatch(/chưa có giọng thật/);
    } finally {
      process.env.AI_MOCK_MODE = prev;
      resetEnvCache();
    }
  });

  it("sửa thông tin nhân vật không làm mất giọng; không đổi tên nhân vật đang có trong Storyboard", async () => {
    const id = await newCharacter(`Minh${tag}`);
    await save(id, "vi-VN", "Quang Sơn");
    const ok = await saveCharacter(id, form({ name: `Minh${tag}`, description: "đổi mô tả", visualPrompt: "A shop assistant, QA fixture." }));
    expect(ok.ok).toBe(true);
    expect((await prisma.character.findUniqueOrThrow({ where: { id } })).voiceId).toBe("Quang Sơn");
    await sceneWith(`Minh${tag}: Chào anh.`, [`Minh${tag}`]);
    const renamed = await saveCharacter(id, form({ name: `Minh2${tag}`, description: "", visualPrompt: "A shop assistant, QA fixture." }));
    expect(renamed.ok).toBe(false);
    expect(renamed.message).toMatch(/đang có trong 1 cảnh/);
  });
});

// ----------------------------------------------------- preview + render ---

describe("QĐ-158 nghe thử, nhiều nhân vật, nhiều ngôn ngữ (Mind Voice giả, $0)", () => {
  it("nghe thử giọng ĐANG CHỌN (chưa lưu): đúng giọng + ngôn ngữ, chỉ lời nói; lần 2 dùng lại; giọng sai bị chặn trước request", async () => {
    const id = await newCharacter(`Nghe${tag}`);
    const ledger = await prisma.costEntry.count();
    const before = requests.length;
    const text = `Hello! Welcome to our store ${tag}.`;
    const first = await previewVoiceChoice(id, { locale: "en", provider: "mindvoice", model: "mind-local", voiceId: "M3", speed: 1, instructions: "Speak warmly.", text });
    expect(first).toMatchObject({ ok: true, cost: 0 });
    expect(sentSince(before)).toEqual([{ voice: "M3", engine: "supertonic", language: "en", text }]);
    expect(JSON.stringify(requests[before])).not.toMatch(/Speak warmly/);
    const again = await previewVoiceChoice(id, { locale: "en", provider: "mindvoice", model: "mind-local", voiceId: "M3", speed: 1, instructions: "", text });
    expect(again.message).toMatch(/Dùng lại/);
    const bad = await previewVoiceChoice(id, { locale: "vi-VN", provider: "mindvoice", model: "mind-local", voiceId: "sage", speed: 1, instructions: "", text: "Xin chào" });
    expect(bad.ok).toBe(false);
    expect(requests.length - before).toBe(1);
    expect(await prisma.costEntry.count()).toBe(ledger);
  });

  it("OpenAI ngoài Mock Mode: báo giá và CHỜ xác nhận, 0 request; Mind Voice Offline: hướng dẫn, không chuyển nhà cung cấp, vẫn lưu được", async () => {
    const id = await newCharacter(`Paid${tag}`);
    const hadModel = await prisma.modelRegistry.findUnique({ where: { provider_modelId: { provider: "openai", modelId: "gpt-4o-mini-tts" } } });
    const seed = SEED_MODELS.find((m) => m.provider === "openai" && m.modelId === "gpt-4o-mini-tts")!;
    if (!hadModel) await prisma.modelRegistry.create({ data: { ...seed, lastVerifiedAt: null, enabled: true } });
    const prevMock = process.env.AI_MOCK_MODE;
    const prevKey = process.env.OPENAI_API_KEY;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      process.env.AI_MOCK_MODE = "false";
      process.env.OPENAI_API_KEY = "sk-test-not-used";
      resetEnvCache();
      if (!hadModel?.enabled) await prisma.modelRegistry.update({ where: { provider_modelId: { provider: "openai", modelId: "gpt-4o-mini-tts" } }, data: { enabled: true } });
      const ask = await previewVoiceChoice(id, { locale: "en", provider: "openai", model: "gpt-4o-mini-tts", voiceId: "fable", speed: 1, instructions: "British accent.", text: `Good morning ${tag}.` });
      expect(ask).toMatchObject({ ok: false, needsConfirmation: true });
      expect(ask.cost).toBeGreaterThan(0);
      expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes("openai.com"))).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
      process.env.AI_MOCK_MODE = prevMock;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
      resetEnvCache();
      if (!hadModel) await prisma.modelRegistry.delete({ where: { provider_modelId: { provider: "openai", modelId: "gpt-4o-mini-tts" } } });
      else await prisma.modelRegistry.update({ where: { id: hadModel.id }, data: { enabled: hadModel.enabled } });
    }

    await stopMind();
    try {
      await refreshMindCatalog();
      const before = requests.length;
      const off = await previewVoiceChoice(id, { locale: "vi-VN", provider: "mindvoice", model: "mind-local", voiceId: "Hải Đăng", speed: 1, instructions: "", text: `Xin chào ${tag}.` });
      expect(off.ok).toBe(false);
      expect(off.message).toMatch(/Mind Voice chưa chạy/);
      expect(requests.length).toBe(before);
      const cat = (await voiceCatalogFor("vi-VN")).models.find((m) => m.provider === "mindvoice")!;
      expect(cat.status).toBe("OFFLINE");
      expect(cat.voices).toHaveLength(VIENEU.length);
      expect((await save(id, "vi-VN", "Hải Đăng")).ok).toBe(true);
    } finally {
      await startMind();
      await refreshMindCatalog();
    }
  });

  it("3 nhân vật, 2 cảnh: người bán (vi) + khách Mỹ (en) + dẫn chuyện (vi) - mỗi câu đúng giọng/engine/ngôn ngữ, không đọc tên, giữ giọng qua các cảnh, chạy lại = 0 request", async () => {
    const seller = `Chị Hoa ${tag}`;
    const customer = `John${tag}`;
    const narrator = `Dan${tag}`;
    await save(await newCharacter(seller), "vi-VN", "Thục Đoan");
    await save(await newCharacter(customer), "en", "M2");
    await save(await newCharacter(narrator), "vi-VN", "Quang Sơn");
    const s1 = await sceneWith(
      `${narrator}: Một buổi sáng ở cửa hàng ${tag}.\n${customer}: Hi! How much is this bag?\n${seller}: Dạ, cái túi này ba trăm nghìn ạ.`,
      [narrator, customer, seller],
      "vi",
    );
    const s2 = await sceneWith(`${seller}: Anh cần thêm gì không ạ ${tag}?\n${customer}: No, thank you. Have a nice day!`, [seller, customer], "vi");
    const before = requests.length;
    await generateSceneVoice(s1.sceneId);
    await generateSceneVoice(s2.sceneId);
    expect(sentSince(before)).toEqual([
      { voice: "Quang Sơn", engine: "vieneu", language: "vi", text: `Một buổi sáng ở cửa hàng ${tag}.` },
      { voice: "M2", engine: "supertonic", language: "en", text: "Hi! How much is this bag?" },
      { voice: "Thục Đoan", engine: "vieneu", language: "vi", text: "Dạ, cái túi này ba trăm nghìn ạ." },
      { voice: "Thục Đoan", engine: "vieneu", language: "vi", text: `Anh cần thêm gì không ạ ${tag}?` },
      { voice: "M2", engine: "supertonic", language: "en", text: "No, thank you. Have a nice day!" },
    ]);
    const lines = await prisma.dialogueLine.findMany({ where: { sceneId: { in: [s1.sceneId, s2.sceneId] } } });
    expect(lines.every((l) => l.provider === "mindvoice" && l.status === "completed")).toBe(true);
    // Run again / reopen: nothing is bought or spoken again.
    const again = requests.length;
    await generateSceneVoice(s1.sceneId);
    expect((await planSceneVoice(s2.sceneId)).lines.map((l) => l.state)).toEqual(["DONE", "DONE"]);
    expect(requests.length).toBe(again);
  }, 600_000);

  it("một nhân vật nói 2 ngôn ngữ: câu tiếng Việt = giọng Việt, câu tiếng Anh = giọng Anh đã lưu", async () => {
    const name = `Mai${tag}`;
    const id = await newCharacter(name);
    await save(id, "vi-VN", "Ngọc Huyền");
    await save(id, "en", "F1");
    const s = await sceneWith(`${name}: Chào chị, em là Mai ${tag}.\n${name}: And this is our best seller.`, [name], "vi");
    const before = requests.length;
    await generateSceneVoice(s.sceneId);
    expect(sentSince(before).map((r) => [r.voice, r.language])).toEqual([
      ["Ngọc Huyền", "vi"],
      ["F1", "en"],
    ]);
  }, 600_000);

  it('giọng cũ không còn hợp lệ ("sage"): cảnh báo, KHÔNG đổi giọng, câu đã có vẫn dùng ($0), câu mới bị chặn trước request', async () => {
    const name = `Old${tag}`;
    const id = await newCharacter(name);
    // Audio made back when the voice was valid (the engine's default voice).
    await prisma.character.update({ where: { id }, data: { voiceProvider: "mindvoice", voiceModel: "mind-local", voiceId: "Mặc định" } });
    const s = await sceneWith(`${name}: Câu cũ đã có giọng ${tag}.`, [name], "vi");
    await generateSceneVoice(s.sceneId);
    // Then the saved voice became one Mind Voice does not have.
    await prisma.character.update({ where: { id }, data: { voiceId: "sage" } });
    const c = await prisma.character.findUniqueOrThrow({ where: { id } });
    expect(await characterVoiceIssues(c)).toEqual([{ locale: null, detail: 'Mind Voice không có giọng "sage".' }]);
    expect(VOICE_PROFILE_STALE).toBe("Giọng đã lưu không còn phù hợp với nhà cung cấp hiện tại. Vui lòng chọn lại giọng.");

    const before = requests.length;
    expect((await planSceneVoice(s.sceneId)).lines.map((l) => l.state)).toEqual(["DONE"]);
    await generateSceneVoice(s.sceneId);
    expect(requests.length).toBe(before);

    await prisma.scene.update({ where: { id: s.sceneId }, data: { dialogue: `${name}: Câu cũ đã có giọng ${tag}.\n${name}: Câu mới cần giọng.` } });
    const plan = await planSceneVoice(s.sceneId);
    expect(plan.lines.map((l) => l.state)).toEqual(["DONE", "BLOCKED"]);
    expect(plan.lines[1]!.message).toMatch(/VOICE_PROFILE_INVALID.*Vui lòng chọn lại giọng/);
    await expect(generateSceneVoice(s.sceneId)).rejects.toThrow(/VOICE_PROFILE_INVALID/);
    expect(requests.length).toBe(before);
    expect((await prisma.character.findUniqueOrThrow({ where: { id } })).voiceId).toBe("sage");

    // Chosen again → this scene's voice changed, so both of its lines are spoken
    // in the new voice (one voice per character); no other scene is touched.
    await save(id, "vi-VN", "Hải Đăng");
    await generateSceneVoice(s.sceneId);
    expect(sentSince(before).map((r) => r.voice)).toEqual(["Hải Đăng", "Hải Đăng"]);
  }, 600_000);
});

// ------------------------------------------------------ voice lock rules ---

describe("QĐ-158 khoá giọng: Voice Director, nhân bản, xoá / đổi tên (Mind Voice giả, $0)", () => {
  it("Narrator đã khoá giọng: Voice Director bật vẫn dùng giọng đã khoá; dự án chỉ đổi tốc độ vẫn giữ; dự án CHỌN giọng thì dùng giọng đó", async () => {
    const narrator = await prisma.character.findUniqueOrThrow({ where: { name: "Narrator" } });
    try {
      await save(narrator.id, "vi-VN", "Ngọc Huyền");
      const s = await sceneWith(`Narrator: Chào mừng các bạn đến với cửa hàng ${tag}.`, ["Narrator"], "vi");
      await saveProjectControls(s.projectId, { voice: { director: true } });
      let before = requests.length;
      await generateSceneVoice(s.sceneId);
      expect(sentSince(before).map((r) => r.voice)).toEqual(["Ngọc Huyền"]);

      // A project speed is not a voice choice: the line stays the locked voice
      // (whether the director's speed rule needs new audio or not).
      await saveProjectControls(s.projectId, { voice: { speed: 1.1 } });
      expect((await planSceneVoice(s.sceneId)).lines.map((l) => l.voiceId)).toEqual(["Ngọc Huyền"]);
      before = requests.length;
      await generateSceneVoice(s.sceneId);
      expect(sentSince(before).every((r) => r.voice === "Ngọc Huyền")).toBe(true);

      await saveProjectControls(s.projectId, { voice: { provider: "mindvoice", model: "mind-local", voiceId: "Hải Đăng" } });
      before = requests.length;
      await generateSceneVoice(s.sceneId);
      expect(sentSince(before).map((r) => r.voice)).toEqual(["Hải Đăng"]);
    } finally {
      const { id: _id, createdAt: _c, updatedAt: _u, ...fields } = narrator;
      await prisma.character.update({ where: { id: narrator.id }, data: fields });
    }
  }, 600_000);

  it("nhân vật thường + Voice Director bật: giữ đúng giọng đã khoá ở mọi cảnh", async () => {
    const name = `Khoa${tag}`;
    await save(await newCharacter(name), "vi-VN", "Quang Sơn");
    const a = await sceneWith(`${name}: Cảnh một của tôi ${tag}.`, [name], "vi");
    await saveProjectControls(a.projectId, { voice: { director: true } });
    const before = requests.length;
    await generateSceneVoice(a.sceneId);
    expect(sentSince(before).map((r) => r.voice)).toEqual(["Quang Sơn"]);
  }, 600_000);

  it("nhân bản cảnh và nhân bản dự án: giữ nguyên giọng, không tạo lại giọng", async () => {
    const seller = `Nhan${tag}`;
    const customer = `Ben${tag}`;
    await save(await newCharacter(seller), "vi-VN", "Thục Đoan");
    await save(await newCharacter(customer), "en", "M1");
    const s = await sceneWith(`${seller}: Chào anh, em có thể giúp gì ạ ${tag}?
${customer}: Just looking, thanks.`, [seller, customer], "vi");
    await generateSceneVoice(s.sceneId);
    const before = requests.length;

    const copy = await duplicateScene(s.sceneId);
    const planCopy = await planSceneVoice(copy.sceneId);
    expect(planCopy.lines.map((l) => [l.voiceId, l.state])).toEqual([
      ["Thục Đoan", "DONE"],
      ["M1", "DONE"],
    ]);
    await generateSceneVoice(copy.sceneId);

    const dup = await duplicateProject(s.projectId);
    const scenes = await prisma.scene.findMany({ where: { projectId: dup.id, deletedAt: null } });
    for (const sc of scenes) {
      const plan = await planSceneVoice(sc.id);
      expect(plan.lines.map((l) => l.voiceId)).toEqual(["Thục Đoan", "M1"]);
      expect(plan.lines.every((l) => l.state === "DONE" || l.state === "REUSE")).toBe(true);
      await generateSceneVoice(sc.id);
    }
    expect(requests.length).toBe(before);
  }, 600_000);

  it("không xoá / không đổi tên nhân vật đang có trong cảnh, kể cả cảnh trong Thùng rác; nhân vật chưa dùng thì xoá được", async () => {
    const name = `Xoa${tag}`;
    const id = await newCharacter(name);
    const s = await sceneWith(`${name}: Xin chào ${tag}.`, [name]);
    await prisma.scene.update({ where: { id: s.sceneId }, data: { deletedAt: new Date() } });
    const del = await deleteCharacter(id);
    expect(del.ok).toBe(false);
    expect(del.message).toMatch(/kể cả Thùng rác/);
    expect(await prisma.character.count({ where: { id } })).toBe(1);
    const renamed = await saveCharacter(id, form({ name: `${name}X`, description: "", visualPrompt: "A shop assistant, QA fixture." }));
    expect(renamed.ok).toBe(false);
    const free = await newCharacter(`Free${tag}`);
    expect((await deleteCharacter(free)).ok).toBe(true);
  });
});
