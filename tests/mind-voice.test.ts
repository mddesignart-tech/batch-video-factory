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
import { toAbsolute } from "@/lib/paths";
import { ffmpeg, probeDuration } from "@/media/ffmpeg";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import {
  atempoFilter,
  MIND_AUTO_VOICE,
  mindDirection,
  mindDirectionSummary,
  mindVoiceLabel,
  parseMindHealth,
  parseMindVoices,
  pickMindVoice,
} from "@/domain/mind-voice";
import { parseDialogueLines } from "@/domain/dialogue-lines";
import { sceneCharacters } from "@/domain/scene-characters";
import { MindVoiceProvider } from "@/providers/mindvoice/mind-voice-provider";
import { getVoiceProvider } from "@/providers/registry";
import { MIND_CATALOG_SETTING, refreshMindCatalog } from "@/services/mind-voice-catalog";
import { voiceReuseKey } from "@/services/asset-keys";
import { ensureNarrator } from "@/services/content-service";
import { generateSceneVoice, voiceSettingsFor } from "@/services/generation";
import { saveProjectControls } from "@/services/output-controls";
import { makeSceneVoice } from "@/services/scene-voice";
import { speakInStudio } from "@/services/mind-voice-studio";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { approveAndRun } from "@/services/batch-executor";
import { continueVideo } from "@/services/video-resume";
import { voiceDirectorFor } from "@/services/voice-direction";

/**
 * QĐ-145 MIND VOICE - the app's own local TTS service, against a MOCK Mind
 * Voice server (a real HTTP server on a random port speaking
 * voice-engine/mind_voice/server.py's API). Mock Mode, $0, no paid request.
 */

// ------------------------------------------------------- mock Mind Voice ---

const REGIONS = ["Bắc", "Nam", "Trung", null] as const;
const VIENEU = Array.from({ length: 25 }, (_, i) => ({
  id: `Giọng ${i + 1}`,
  name: `Giọng ${i + 1}`,
  engine: "vieneu",
  languages: ["vi"],
  gender: i % 2 ? "female" : "male",
  region: ({ Bắc: "north", Nam: "south", Trung: "central" } as Record<string, string>)[REGIONS[i % 4] ?? ""] ?? null,
  style: i % 3 ? "natural" : "storytelling",
  description: `Mô tả ${i + 1}`,
  featured: i < 10 ? i + 1 : null,
  aliases: [],
  default: i === 4,
}));
const SUPERTONIC = Array.from({ length: 10 }, (_, i) => ({
  id: `${i < 5 ? "M" : "F"}${(i % 5) + 1}`,
  name: `${i < 5 ? "M" : "F"}${(i % 5) + 1}`,
  engine: "supertonic",
  languages: ["en"],
  gender: i < 5 ? "male" : "female",
  region: null,
  style: null,
  description: "Supertonic 3",
  featured: null,
  aliases: [],
  default: i === 0,
}));

/** One second of a 220 Hz tone, 48 kHz mono 16-bit: audible, so levelling works. */
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
let supertonicInstalled = true;
let server: http.Server | null = null;
let baseUrl = "";

function health() {
  return {
    status: "ok",
    service: "mind-voice",
    version: "0.1.0",
    hardware: { cpu: "Test CPU", threads: 6, ram_gb: 32, gpu: null, cuda_ready: false, device: "cpu", gpu_note: null },
    engines: [
      { id: "vieneu", label: "VieNeu-TTS v3 Turbo", languages: ["vi"], installed: true, variant: "fp32", loaded: false, sample_rate: 48000, native_speed: false, tags: ["[cười]", "[thở dài]", "[hắng giọng]"], license: "Apache-2.0" },
      { id: "supertonic", label: "Supertonic 3", languages: ["en"], installed: supertonicInstalled, variant: supertonicInstalled ? "cpu" : null, loaded: false, sample_rate: 44100, native_speed: true, tags: ["<laugh>", "<breath>", "<sigh>"], license: "OpenRAIL-M" },
    ],
  };
}

async function startMind(): Promise<void> {
  server = http.createServer((req, res) => {
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return json(health());
    if (req.url?.startsWith("/voices")) {
      return json({ voices: [...VIENEU.map((v) => ({ ...v, installed: true })), ...(supertonicInstalled ? SUPERTONIC.map((v) => ({ ...v, installed: true })) : [])] });
    }
    if (req.url === "/tts" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        requests.push(body);
        if (body.engine === "supertonic" && !supertonicInstalled) {
          return json({ error: { code: "MODEL_MISSING", message: "Chưa cài model Supertonic 3. Mở Mind Voice Studio → Quản lý model để cài." } }, 409);
        }
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
}

async function stopMind(): Promise<void> {
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
      video_id: `mind-${tag}-${randomUUID().slice(0, 4)}`,
      video_title: `mind-${tag}`,
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
  const created = await materialiseImport(validated, { batchName: `mind-${tag}-${randomUUID().slice(0, 4)}`, maxCostPerVideo: 5, maxCostForBatch: 50 });
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

const mindLines = (projectId: string) =>
  prisma.dialogueLine.findMany({ where: { scene: { projectId } }, orderBy: [{ scene: { sceneNumber: "asc" } }, { lineNumber: "asc" }] });
const mindLedger = () => prisma.costEntry.count({ where: { provider: "mindvoice" } });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mind-voice-"));
  await seedMock();
  await ensureNarrator();
  const s = await spendStatus();
  capBefore = s.cap;
  await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
  await startMind();
  await prisma.providerConfig.upsert({
    where: { name: "mindvoice" },
    create: { name: "mindvoice", displayName: "Mind Voice", types: JSON.stringify(["voice"]), enabled: true, baseUrl, status: "connected" },
    update: { enabled: true, baseUrl },
  });
}, 120_000);

afterAll(async () => {
  await stopMind();
  // Leave the shared test database as other files expect it: no Mind Voice.
  await prisma.modelRegistry.deleteMany({ where: { provider: "mindvoice" } });
  await prisma.providerConfig.deleteMany({ where: { name: "mindvoice" } });
  await prisma.setting.deleteMany({ where: { key: MIND_CATALOG_SETTING } });
  if (capBefore > 0) await setSpendCap(capBefore);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- pure ---

describe("QĐ-145 Mind Voice - discovery + adapter (thuần)", () => {
  it("health / voices: đọc đúng API của Mind Voice; dịch vụ khác ở cổng đó bị từ chối; vùng miền chỉ hiện khi SDK có", () => {
    const h = parseMindHealth(health());
    expect(h.engines.map((e) => [e.id, e.installed, e.variant, e.nativeSpeed])).toEqual([
      ["vieneu", true, "fp32", false],
      ["supertonic", true, "cpu", true],
    ]);
    expect(() => parseMindHealth({ status: "ok", engine: "VieNeu" })).toThrow(/không phải Mind Voice/);
    const voices = parseMindVoices({ voices: [...VIENEU, ...SUPERTONIC].map((v) => ({ ...v, installed: true })) });
    expect(voices).toHaveLength(35);
    expect(voices.filter((v) => v.engine === "vieneu")).toHaveLength(25);
    expect(mindVoiceLabel(voices[0]!)).toBe("Giọng 1 · Nam · Giọng Bắc · Kể chuyện");
    const noRegion = voices.find((v) => v.engine === "vieneu" && v.region === null)!;
    expect(mindVoiceLabel(noRegion)).not.toMatch(/Giọng (Bắc|Nam|Trung)/);
    expect(mindVoiceLabel(voices.find((v) => v.id === "F1")!)).toBe("F1 · Nữ");
  });

  it("chọn giọng tự động: vi → VieNeu (giọng mặc định của SDK), en → Supertonic; model chưa cài / ngôn ngữ chưa hỗ trợ → báo rõ", () => {
    const voices = parseMindVoices({ voices: [...VIENEU, ...SUPERTONIC].map((v) => ({ ...v, installed: true })) });
    expect(pickMindVoice(voices, "vi")).toMatchObject({ ok: true, voice: { id: "Giọng 5", engine: "vieneu" } });
    expect(pickMindVoice(voices, "en")).toMatchObject({ ok: true, voice: { id: "M1", engine: "supertonic" } });
    const onlyVi = parseMindVoices({ voices: VIENEU.map((v) => ({ ...v, installed: true })) });
    const r = pickMindVoice(onlyVi, "en");
    expect(r).toMatchObject({ ok: false, code: "MODEL_MISSING" });
    expect(!r.ok && r.message).toMatch(/Quản lý model/);
    expect(pickMindVoice(voices, "ko")).toMatchObject({ ok: false, code: "LANGUAGE_UNSUPPORTED" });
  });

  it("Voice Director adapter: không bao giờ có thẻ [nghỉ]; VieNeu ngắt bằng xuống dòng; tag đúng cú pháp engine, tối đa 1", () => {
    const two = "Câu một rất hay. Câu hai còn hay hơn!";
    expect(mindDirection({ text: two, engine: "vieneu", style: null, role: null, emotion: null }).text).toBe(two);
    expect(mindDirection({ text: two, engine: "vieneu", style: "PROFESSIONAL", role: "EXPLAIN", emotion: "NEUTRAL" }).text).toBe(two);
    expect(mindDirection({ text: two, engine: "vieneu", style: "DOCUMENTARY", role: "EXPLAIN", emotion: "SERIOUS" }).text).toBe("Câu một rất hay.\nCâu hai còn hay hơn!");
    expect(mindDirection({ text: two, engine: "vieneu", style: "COMEDY", role: "PUNCHLINE", emotion: "HUMOROUS" }).text).toBe("Câu một rất hay.\nCâu hai còn hay hơn! [cười]");
    expect(mindDirection({ text: two, engine: "supertonic", style: "COMEDY", role: "PUNCHLINE", emotion: "HUMOROUS" }).text).toBe(`${two} <laugh>`);
    // QĐ-146: no engine performs a sigh reliably - a touching line gets its beat, never a <sigh>/[thở dài].
    expect(mindDirection({ text: two, engine: "supertonic", style: "STORYTELLING", role: "EMOTIONAL", emotion: "TOUCHING" }).text).toBe(two);
    expect(mindDirection({ text: two, engine: "vieneu", style: "STORYTELLING", role: "EMOTIONAL", emotion: "TOUCHING" }).text).toBe("Câu một rất hay.\nCâu hai còn hay hơn!");
    const tags = (s: string) => (s.match(/\[(cười|thở dài|hắng giọng)\]|<(laugh|sigh|breath)>/g) ?? []).length;
    for (const engine of ["vieneu", "supertonic"] as const) {
      for (const style of ["COMEDY", "DOCUMENTARY", "STORYTELLING", "DRAMATIC", "PROFESSIONAL"] as const) {
        for (const role of ["PUNCHLINE", "EMOTIONAL", "HOOK"] as const) {
          const out = mindDirection({ text: two, engine, style, role, emotion: "TOUCHING" }).text;
          expect(out).not.toMatch(/\[nghỉ|\[pause/i);
          expect(tags(out)).toBeLessThanOrEqual(1);
          if (engine === "supertonic") expect(out).not.toMatch(/\[/);
          if (engine === "vieneu") expect(out).not.toMatch(/</);
        }
      }
    }
    expect(mindDirectionSummary({ engine: "vieneu", variant: "fp32", language: "vi", style: null, role: null, emotion: null })).toBe("MIND mind-v1 engine=vieneu/fp32 lang=vi director=off");
    expect(atempoFilter(1)).toBeNull();
    expect(atempoFilter(1.2)).toBe("atempo=1.20");
    expect(atempoFilter(9)).toBe("atempo=1.50");
  });
});

// ---------------------------------------------------------- end-to-end ---

describe("QĐ-145 Mind Voice - mock server, Mock Mode, $0", () => {
  it("online → 35 giọng từ /voices; offline → báo Offline, giữ danh sách", async () => {
    const online = await refreshMindCatalog();
    expect(online.online).toBe(true);
    expect(online.voices).toHaveLength(35);
    expect(online.health?.engines.find((e) => e.id === "vieneu")?.variant).toBe("fp32");
    const provider = await getVoiceProvider("mindvoice", "mind-local");
    expect(await provider.listVoices()).toHaveLength(35);
    await stopMind();
    const offline = await refreshMindCatalog();
    expect(offline.online).toBe(false);
    expect(offline.error).toMatch(/Mind Voice chưa chạy/);
    expect(offline.voices).toHaveLength(35);
    await startMind();
    await prisma.providerConfig.update({ where: { name: "mindvoice" }, data: { baseUrl } });
    expect((await refreshMindCatalog()).online).toBe(true);
  });

  it("provider: VieNeu không có tốc độ gốc → atempo một lần; Supertonic tự đọc nhanh; $0", async () => {
    const p = new MindVoiceProvider({ baseUrl });
    const out = (name: string) => path.join(tmp, `${name}-${randomUUID().slice(0, 4)}.wav`);
    const vi = out("vi");
    const job = await p.createVoice({ projectId: "t", sceneId: "t", model: "mind-local", text: "Xin chào", voiceId: "Giọng 2", accent: "US", gender: "female", speed: 1.25, targetDuration: 1, outputPath: vi, language: "vi" });
    expect(job.estimatedCost).toBe(0);
    const asset = await p.downloadResult(job.externalId);
    expect(asset.actualCost).toBe(0);
    expect(asset.meta).toMatchObject({ engine: "vieneu", speed: "atempo", variant: "fp32" });
    expect(await probeDuration(vi)).toBeCloseTo(0.8, 1);
    const en = out("en");
    const job2 = await p.createVoice({ projectId: "t", sceneId: "t", model: "mind-local", text: "Hello", voiceId: MIND_AUTO_VOICE, accent: "US", gender: "male", speed: 1.25, targetDuration: 1, outputPath: en, language: "en" });
    expect((await p.downloadResult(job2.externalId)).meta).toMatchObject({ engine: "supertonic", voiceId: "M1", speed: "native" });
    expect(requests[requests.length - 1]).toMatchObject({ engine: "supertonic", voice: "M1", speed: 1.25, language: "en" });
    expect(await probeDuration(en)).toBeCloseTo(1, 1);
    await expect(p.createVoice({ projectId: "t", sceneId: "t", model: "mind-local", text: "x", voiceId: "Không Có", accent: "US", gender: "male", speed: 1, targetDuration: 1, outputPath: out("x"), language: "vi" })).rejects.toThrow(/không có giọng/);
  });

  it("tiếng Việt nhiều cảnh: nhãn không bị đọc, cùng một giọng, language=vi, $0 không ghi sổ; preview → run → render lại = 0 request", async () => {
    const v = await narratedVideo([`Narrator: Xin chào mọi người ${tag}.`, `Hôm nay mình review iPhone 15 Pro ${tag}. Rất đáng tiền!`, `Speaker A: Lưu ý: nhớ lưu video ${tag} nhé.`], "vi");
    await saveProjectControls(v.projectId, { voice: { provider: "mindvoice", model: "mind-local", voiceId: null } });
    const ledgerBefore = await mindLedger();
    const spentBefore = (await spendStatus()).spent;
    const before = requests.length;

    // ▶ NGHE THỬ the first scene, then the whole run: the preview is reused.
    const ask = await makeSceneVoice(v.sceneIds[0]!);
    const made = ask.status === "NEEDS_CONFIRMATION" ? await makeSceneVoice(v.sceneIds[0]!, { confirmPaid: true, expectedCost: ask.plan!.incrementalCost }) : ask;
    expect(made.status).toBe("DONE");
    expect(ask.plan?.incrementalCost ?? 0).toBe(0);
    expect(requests.length - before).toBe(1);
    await approveAndRun({ batchId: v.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
    const project = await prisma.project.findUniqueOrThrow({ where: { id: v.projectId } });
    expect(project.status).toBe("completed");
    expect(project.finalVideoPath).toBeTruthy();
    const sent = requests.slice(before);
    expect(sent).toHaveLength(3);
    for (const body of sent) {
      expect(String(body.text)).not.toMatch(/Narrator:|Speaker A:|Speaker B:|Host:/);
      expect(body).toMatchObject({ engine: "vieneu", language: "vi", voice: "Giọng 5" });
      expect(body).not.toHaveProperty("instructions");
    }
    expect(sent[0]!.text).toBe(`Xin chào mọi người ${tag}.`);
    expect(sent[2]!.text).toBe(`Lưu ý: nhớ lưu video ${tag} nhé.`);
    const lines = await mindLines(v.projectId);
    expect(lines.map((l) => [l.provider, l.model, l.voiceId])).toEqual(lines.map(() => ["mindvoice", "mind-local", "Giọng 5"]));
    expect(lines[0]!.instructions).toBe("MIND mind-v1 engine=vieneu/fp32 lang=vi director=off");
    // Subtitles keep the words as written (label gone, nothing added).
    expect(lines[2]!.text).toBe(`Lưu ý: nhớ lưu video ${tag} nhé.`);
    // $0: no ledger line, nothing against the cap.
    expect(await mindLedger()).toBe(ledgerBefore);
    expect((await spendStatus()).spent).toBeCloseTo(spentBefore, 9);
    const assets = await prisma.asset.findMany({ where: { projectId: v.projectId, kind: "audio", provider: "mindvoice" } });
    expect(assets.length).toBe(3);
    expect(assets.every((a) => a.actualCost === 0)).toBe(true);

    // Render again, camera and subtitle edits: 0 requests.
    const posts = requests.length;
    fs.rmSync(toAbsolute(project.finalVideoPath!));
    await prisma.scene.update({ where: { id: v.sceneIds[1]! }, data: { camera: "slow push-in", subtitle: "Phụ đề mới" } });
    expect((await continueVideo(v.projectId, { wait: true })).status).toBe("COMPLETED");
    for (const id of v.sceneIds) await generateSceneVoice(id);
    expect(requests.length).toBe(posts);

    // Mind Voice stopped: finished audio is still reused - keys come from the kept catalog.
    await stopMind();
    for (const id of v.sceneIds) await generateSceneVoice(id);
    await startMind();
    await prisma.providerConfig.update({ where: { name: "mindvoice" }, data: { baseUrl } });
    expect(requests.length).toBe(posts);

    // Speed and voice changes invalidate exactly the voice they touch.
    await saveProjectControls(v.projectId, { voice: { speed: 1.2 } });
    await generateSceneVoice(v.sceneIds[0]!);
    expect(requests.length).toBe(posts + 1);
    expect(requests[requests.length - 1]!.speed).toBe(1.2);
    await saveProjectControls(v.projectId, { voice: { speed: null } });
    for (const id of v.sceneIds) await generateSceneVoice(id);
    expect(requests.length).toBe(posts + 1);
    await saveProjectControls(v.projectId, { voice: { voiceId: "Giọng 9" } });
    await generateSceneVoice(v.sceneIds[0]!);
    expect(requests[requests.length - 1]).toMatchObject({ voice: "Giọng 9" });
  }, 900_000);

  it("Voice Director bật + tiếng Anh → Supertonic: không gửi <sigh> (QĐ-146), không gửi instructions; Supertonic chưa cài → báo rõ, không gọi nhà cung cấp khác", async () => {
    const v = await narratedVideo([`Welcome back ${tag}. Today we test three gadgets.`], "en");
    await saveProjectControls(v.projectId, { voice: { provider: "mindvoice", model: "mind-local", voiceId: null, director: true, emotion: "TOUCHING" } });
    const before = requests.length;
    await generateSceneVoice(v.sceneIds[0]!);
    const body = requests[before]!;
    expect(body).toMatchObject({ engine: "supertonic", language: "en", voice: "M1" });
    expect(body.text).toBe(`Welcome back ${tag}. Today we test three gadgets.`);
    expect(body).not.toHaveProperty("instructions");
    const line = (await mindLines(v.projectId))[0]!;
    expect(line.text).toBe(`Welcome back ${tag}. Today we test three gadgets.`);
    expect(line.instructions).toMatch(/^MIND mind-v1 engine=supertonic\/cpu lang=en style=/);

    supertonicInstalled = false;
    await refreshMindCatalog();
    await prisma.scene.update({ where: { id: v.sceneIds[0]! }, data: { narration: `A brand new line ${tag}.` } });
    await expect(generateSceneVoice(v.sceneIds[0]!)).rejects.toThrow(/Supertonic 3|Quản lý model/);
    const jobs = await prisma.providerJob.findMany({ where: { sceneId: v.sceneIds[0]! } });
    expect(jobs.every((j) => j.provider === "mindvoice")).toBe(true);
    supertonicInstalled = true;
    await refreshMindCatalog();
  }, 600_000);

  it("Mind Voice offline: dừng với hướng dẫn, KHÔNG gọi OpenAI / mock / CIT, $0; mở lại → chạy tiếp", async () => {
    const v = await narratedVideo([`Narrator: Câu này cần Mind Voice ${tag}.`], "vi");
    await saveProjectControls(v.projectId, { voice: { provider: "mindvoice", model: "mind-local", voiceId: "Giọng 3" } });
    const ledger = await prisma.costEntry.count();
    await stopMind();
    await expect(generateSceneVoice(v.sceneIds[0]!)).rejects.toThrow(/MIND_OFFLINE|Mind Voice chưa chạy/);
    const jobs = await prisma.providerJob.findMany({ where: { sceneId: v.sceneIds[0]! } });
    expect(jobs.every((j) => j.provider === "mindvoice")).toBe(true);
    expect(await prisma.dialogueLine.count({ where: { sceneId: v.sceneIds[0]!, status: "completed" } })).toBe(0);
    expect(await prisma.costEntry.count()).toBe(ledger);
    await startMind();
    await prisma.providerConfig.update({ where: { name: "mindvoice" }, data: { baseUrl } });
    const before = requests.length;
    await generateSceneVoice(v.sceneIds[0]!);
    expect(requests.length - before).toBe(1);
    expect(requests[before]).toMatchObject({ voice: "Giọng 3", text: `Câu này cần Mind Voice ${tag}.` });
  }, 600_000);

  it("hội thoại nhiều người: mỗi nhân vật đúng giọng Mind Voice của mình, nhãn tên không bị đọc", async () => {
    const original = await prisma.character.findMany({ where: { name: { in: ["Max", "Leo"] } } });
    try {
      await prisma.character.update({ where: { name: "Max" }, data: { voiceProvider: "mindvoice", voiceModel: "mind-local", voiceId: "Giọng 2" } });
      await prisma.character.update({ where: { name: "Leo" }, data: { voiceProvider: "mindvoice", voiceModel: "mind-local", voiceId: "Giọng 7" } });
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
      expect(requests.slice(before).map((b) => [b.voice, b.text])).toEqual([
        ["Giọng 2", `Bạn ăn sáng chưa ${tag}?`],
        ["Giọng 7", "Mình ăn rồi, cảm ơn nhé."],
        ["Giọng 2", "Vậy đi thôi!"],
      ]);
    } finally {
      for (const c of original) await prisma.character.update({ where: { id: c.id }, data: { voiceProvider: c.voiceProvider, voiceModel: c.voiceModel, voiceId: c.voiceId } });
    }
  }, 600_000);

  it("QĐ-147 Dialogue Director: mỗi nhân vật cảm xúc riêng, giữ giọng; câu hỏi ngắn giữ dấu ?; tắt → gửi y như cũ", async () => {
    const original = await prisma.character.findMany({ where: { name: { in: ["Max", "Leo"] } } });
    try {
      await prisma.character.update({ where: { name: "Max" }, data: { voiceProvider: "mindvoice", voiceModel: "mind-local", voiceId: "Giọng 2" } });
      await prisma.character.update({ where: { name: "Leo" }, data: { voiceProvider: "mindvoice", voiceModel: "mind-local", voiceId: "Giọng 7" } });
      const v = await narratedVideo([""], "vi");
      const sceneId = v.sceneIds[0]!;
      await prisma.scene.update({
        where: { id: sceneId },
        data: {
          dialogue: `Max: Ăn sáng chưa ${tag}?\nLeo: Mình ăn rồi, cảm ơn nhé.\nMax: Vậy đi dạo một vòng đi.`,
          narration: "",
          speakingCharactersJson: JSON.stringify(["Max", "Leo"]),
          charactersPresentJson: JSON.stringify(["Max", "Leo"]),
        },
      });
      await saveProjectControls(v.projectId, {
        voice: { dialogueDirector: true, speakerEmotions: { [sceneId]: { Max: "CALM", Leo: "SURPRISED" } } },
      });
      const before = requests.length;
      await generateSceneVoice(sceneId);
      const sent = requests.slice(before);
      expect(sent.map((b) => [b.voice, b.text, b.speed, b.keep_punct ?? null])).toEqual([
        ["Giọng 2", `Ăn sáng chưa ${tag}?`, 0.96, true],
        ["Giọng 7", "Mình ăn rồi, cảm ơn nhé!", 1.05, true],
        ["Giọng 2", "Vậy đi dạo một vòng đi.", 0.96, null],
      ]);
      const lines = await mindLines(v.projectId);
      expect(lines.map((l) => l.voiceId)).toEqual(["Giọng 2", "Giọng 7", "Giọng 2"]);
      expect(lines.map((l) => l.text)).toEqual([`Ăn sáng chưa ${tag}?`, "Mình ăn rồi, cảm ơn nhé.", "Vậy đi dạo một vòng đi."]);
      expect(lines.map((l) => / dlg=(\w+)/.exec(l.instructions)?.[1])).toEqual(["CALM", "SURPRISED", "CALM"]);
      for (const b of sent) expect(String(b.text)).not.toMatch(/Max|Leo|\[thở dài\]|<sigh>|dlg=/);

      // Off again: exactly the request a project without it sends (no keep_punct, speed 1).
      await saveProjectControls(v.projectId, { voice: { dialogueDirector: false } });
      const off = requests.length;
      await generateSceneVoice(sceneId);
      expect(requests.slice(off).map((b) => [b.text, b.speed, "keep_punct" in b])).toEqual([
        [`Ăn sáng chưa ${tag}?`, 1, false],
        ["Mình ăn rồi, cảm ơn nhé.", 1, false],
        ["Vậy đi dạo một vòng đi.", 1, false],
      ]);
    } finally {
      for (const c of original) await prisma.character.update({ where: { id: c.id }, data: { voiceProvider: c.voiceProvider, voiceModel: c.voiceModel, voiceId: c.voiceId } });
    }
  }, 600_000);

  it("nghe thử giọng nhân vật ngoài Mock Mode: Mind Voice không qua cổng chi tiêu, không ghi sổ, lần 2 dùng lại", async () => {
    const leo = await prisma.character.findUniqueOrThrow({ where: { name: "Leo" } });
    const prev = process.env.AI_MOCK_MODE;
    try {
      await prisma.character.update({ where: { id: leo.id }, data: { voiceProvider: "mindvoice", voiceModel: "mind-local", voiceId: "Giọng 4" } });
      process.env.AI_MOCK_MODE = "false";
      resetEnvCache();
      const { previewVoice } = await import("@/app/actions/characters");
      const ledger = await prisma.costEntry.count();
      const before = requests.length;
      const first = await previewVoice(leo.id, `Nghe thử ${tag}.`);
      expect(first).toMatchObject({ ok: true, cost: 0 });
      expect(requests.length - before).toBe(1);
      const again = await previewVoice(leo.id, `Nghe thử ${tag}.`);
      expect(again.message).toMatch(/Dùng lại/);
      expect(requests.length - before).toBe(1);
      expect(await prisma.costEntry.count()).toBe(ledger);
    } finally {
      process.env.AI_MOCK_MODE = prev;
      resetEnvCache();
      await prisma.character.update({ where: { id: leo.id }, data: { voiceProvider: leo.voiceProvider, voiceModel: leo.voiceModel, voiceId: leo.voiceId } });
    }
  });

  it("QĐ-146 Studio: [thở dài] không được gửi (báo lý do), [cười] vẫn gửi; tắt thẻ cảm xúc → không gửi thẻ nào; chữ khác giữ nguyên", async () => {
    const studio = (text: string, cues?: boolean) =>
      speakInStudio({ text, language: "vi", voiceId: "Giọng 5", style: null, emotion: "AUTO", speed: 1, pause: "natural", preview: false, cues });
    const before = requests.length;
    const sigh = await studio(`[thở dài] Một ngày dài ${tag} cuối cùng cũng kết thúc.`);
    expect(sigh.ok).toBe(true);
    expect(requests[before]).toMatchObject({ engine: "vieneu", text: `Một ngày dài ${tag} cuối cùng cũng kết thúc.` });
    expect(sigh.ok && sigh.notice).toMatch(/Không gửi \[thở dài\]/);

    const laugh = await studio(`Tôi tưởng mình giỏi lắm ${tag}. [cười] Hóa ra lại quên chìa khóa.`);
    expect(requests[before + 1]!.text).toBe(`Tôi tưởng mình giỏi lắm ${tag}. [cười] Hóa ra lại quên chìa khóa.`);
    expect(laugh.ok && laugh.notice).toBeUndefined();

    const off = await studio(`Tôi tưởng mình giỏi lắm ${tag}. [cười] Hóa ra lại quên chìa khóa.`, false);
    expect(requests[before + 2]!.text).toBe(`Tôi tưởng mình giỏi lắm ${tag}. Hóa ra lại quên chìa khóa.`);
    expect(off.ok && off.notice).toMatch(/Đã tắt thẻ cảm xúc/);
    expect(off.ok && off.take.key).not.toBe(laugh.ok && laugh.take.key);
    expect(requests.length - before).toBe(3);
  }, 120_000);

  it("dự án OpenAI cũ không đổi: không có tag / language / chỉ dẫn Mind Voice", async () => {
    const v = await narratedVideo([`Narrator: Dự án cũ ${tag}.`], "vi");
    const scene = await prisma.scene.findUniqueOrThrow({ where: { id: v.sceneIds[0]! } });
    const line = parseDialogueLines(scene.dialogue, scene.narration, sceneCharacters(scene).speaking)[0]!;
    const base = await voiceSettingsFor(line.speaker, v.projectId);
    expect(base.provider).not.toBe("mindvoice");
    expect((await voiceDirectorFor(scene))(line, base)).toEqual(base);
    await saveProjectControls(v.projectId, { voice: { director: true } });
    const on = (await voiceDirectorFor(await prisma.scene.findUniqueOrThrow({ where: { id: v.sceneIds[0]! } })))(line, base);
    expect(on.instructions).not.toMatch(/^MIND /);
    expect(on.language).toBeUndefined();
    const key = (s: typeof on) => voiceReuseKey({ provider: "openai", model: "gpt-4o-mini-tts", text: line.text, voiceId: s.voiceId, instructions: s.instructions, speed: s.speed, accent: "US", targetDuration: 3, spokenText: s.spokenText });
    expect(key(on)).toBe(key({ ...on }));
  });
});
