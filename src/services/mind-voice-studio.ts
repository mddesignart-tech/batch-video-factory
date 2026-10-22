import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { toAbsolute, toRelative } from "@/lib/paths";
import { ffmpeg, probeDuration } from "@/media/ffmpeg";
import { splitSpeakerLabel } from "@/domain/dialogue-lines";
import { prepareSpeechText, type SpeechLanguage } from "@/domain/speech-text";
import { VOICE_EMOTIONS, VOICE_STYLES, type VoiceEmotionId, type VoiceStyleId } from "@/domain/voice-director";
import {
  clampMindSpeed,
  engineForLanguage,
  MIND_AUTO_VOICE,
  MIND_ENGINES,
  MIND_MODEL,
  MIND_PROVIDER,
  mindDirection,
  mindDirectionSummary,
  mindVoiceLabel,
  pickMindVoice,
  type MindEngineId,
} from "@/domain/mind-voice";
import { MindVoiceProvider } from "@/providers/mindvoice/mind-voice-provider";
import { voiceReuseKey } from "./asset-keys";
import { acquireAssetCreationLock } from "./asset-reuse";
import { refreshMindCatalog, variantOfMindEngine } from "./mind-voice-catalog";

/**
 * MIND VOICE STUDIO (QĐ-145): speak any text on this machine, outside a video.
 *
 * Every take is kept in data/mind-voice/ with an index keyed by the same voice
 * key the video pipeline uses, so the same words in the same voice and
 * settings are played again instead of being generated again. $0, no ledger.
 */

export const STUDIO_DIR = "mind-voice";
const INDEX = path.join(STUDIO_DIR, "library.json");
const MAX_TEXT = 3000;
const PREVIEW_CHARS = 160;
const KEEP = 300;

export type StudioPause = "natural" | "long";

export interface StudioRequest {
  text: string;
  language: SpeechLanguage;
  /** A voice id, or AUTO for the engine's default voice for the language. */
  voiceId: string;
  style: VoiceStyleId | null;
  emotion: VoiceEmotionId | null;
  speed: number;
  pause: StudioPause;
  /** Speak only the opening (first sentence or so) to hear the voice quickly. */
  preview: boolean;
  /** Emotion cues (QĐ-146). Absent = on; only cues the engine performs are sent. */
  cues?: boolean;
}

export interface StudioTake {
  id: string;
  key: string;
  file: string;
  mp3: string | null;
  text: string;
  spokenText: string;
  voiceId: string;
  voiceLabel: string;
  engine: MindEngineId;
  variant: string | null;
  language: SpeechLanguage;
  style: VoiceStyleId | null;
  emotion: VoiceEmotionId | null;
  speed: number;
  pause: StudioPause;
  preview: boolean;
  durationSec: number;
  saved: boolean;
  createdAt: string;
}

interface Library {
  takes: StudioTake[];
}

function readLibrary(): Library {
  try {
    const parsed = JSON.parse(fs.readFileSync(toAbsolute(INDEX), "utf8")) as Library;
    return Array.isArray(parsed.takes) ? parsed : { takes: [] };
  } catch {
    return { takes: [] };
  }
}

function writeLibrary(lib: Library): void {
  // Saved takes are kept; the rest is a rolling history (the files stay on disk).
  const dropped = new Set(lib.takes.filter((t) => !t.saved).slice(KEEP).map((t) => t.id));
  const takes = lib.takes.filter((t) => !dropped.has(t.id));
  fs.mkdirSync(path.dirname(toAbsolute(INDEX)), { recursive: true });
  fs.writeFileSync(toAbsolute(INDEX), JSON.stringify({ takes }, null, 2));
}

export function studioTakes(): StudioTake[] {
  return readLibrary().takes.filter((t) => fs.existsSync(toAbsolute(t.file)));
}

/** Each line's leading role label ("Narrator:", "Speaker A:", "Host:") is not read aloud. */
export function stripRoleLabels(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => splitSpeakerLabel(line, []).text)
    .join("\n")
    .trim();
}

function openingOf(text: string): string {
  const first = text.split(/(?<=[.!?…])\s+/)[0] ?? text;
  return (first.length <= PREVIEW_CHARS ? first : `${first.slice(0, PREVIEW_CHARS).replace(/\s+\S*$/, "")}…`).trim();
}

export type StudioResult = { ok: true; take: StudioTake; reused: boolean; notice?: string } | { ok: false; message: string };

/** Why typed cues were left out, in plain words (QĐ-146). */
export function cueNotice(dropped: { tag: string; reason: "off" | "unreliable" | "unsupported" }[], engineLabel: string): string | undefined {
  if (dropped.length === 0) return undefined;
  const tags = [...new Set(dropped.map((d) => d.tag))].join(", ");
  if (dropped.every((d) => d.reason === "off")) return `Đã tắt thẻ cảm xúc: bỏ ${tags}.`;
  return `Không gửi ${tags}: ${engineLabel} chưa thể hiện ổn định thẻ này (ra âm lạ hoặc mất), nên đã bỏ khỏi câu.`;
}

export async function speakInStudio(req: StudioRequest): Promise<StudioResult> {
  const cleaned = stripRoleLabels(req.text);
  if (!cleaned) return { ok: false, message: "Nhập nội dung cần đọc." };
  if (cleaned.length > MAX_TEXT) return { ok: false, message: `Tối đa ${MAX_TEXT} ký tự mỗi lần.` };
  if (req.style && !(req.style in VOICE_STYLES)) return { ok: false, message: "Phong cách không hợp lệ." };
  if (req.emotion && !VOICE_EMOTIONS.some((e) => e.id === req.emotion)) return { ok: false, message: "Cảm xúc không hợp lệ." };

  const catalog = await refreshMindCatalog();
  if (!catalog.online) return { ok: false, message: catalog.error ?? "Mind Voice chưa chạy." };

  let voice = catalog.voices.find((v) => v.id === req.voiceId) ?? null;
  if (!voice || req.voiceId === MIND_AUTO_VOICE) {
    const pick = pickMindVoice(catalog.voices, req.language);
    if (!pick.ok) return { ok: false, message: pick.message };
    voice = pick.voice;
  }
  if (!voice.installed) return { ok: false, message: `Chưa cài ${MIND_ENGINES[voice.engine].label}. Mở Quản lý model để cài.` };
  if (engineForLanguage(req.language) !== voice.engine && voice.engine === "supertonic") {
    return { ok: false, message: "Supertonic 3 trong Mind Voice hiện chỉ đọc tiếng Anh. Chọn giọng VieNeu cho tiếng Việt." };
  }

  const words = req.preview ? openingOf(cleaned) : cleaned;
  const emotion = req.emotion === "AUTO" ? null : req.emotion;
  const cues = req.cues ?? true;
  const direction = mindDirection({ text: prepareSpeechText(words, req.language), engine: voice.engine, style: req.style, role: null, emotion, cues });
  const directed = direction.text;
  const notice = cueNotice(direction.dropped, MIND_ENGINES[voice.engine].label);
  // "Dài hơn": VieNeu's own paragraph pause between sentences (it has no pause tag).
  const spokenText = req.pause === "long" && voice.engine === "vieneu" ? directed.replace(/(?<=[.!?…])[ \t]+(?=\S)/g, "\n") : directed;
  const speed = clampMindSpeed(req.speed);
  const variant = variantOfMindEngine(catalog, voice.engine);
  const instructions = `${mindDirectionSummary({ engine: voice.engine, variant, language: req.language, style: req.style, role: null, emotion, cues })}${req.pause === "long" ? " pause=long" : ""}`;
  const key = voiceReuseKey({ provider: MIND_PROVIDER, model: MIND_MODEL, text: words, voiceId: voice.id, instructions, speed, spokenText });

  const release = await acquireAssetCreationLock(`mind-studio:${key}`);
  try {
    const lib = readLibrary();
    const known = lib.takes.find((t) => t.key === key && fs.existsSync(toAbsolute(t.file)));
    if (known) return { ok: true, take: known, reused: true, notice };

    const outputPath = toAbsolute(path.join(STUDIO_DIR, `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}.wav`));
    const provider = new MindVoiceProvider({ baseUrl: catalog.baseUrl });
    const job = await provider.createVoice({
      projectId: "mind-voice-studio",
      sceneId: "mind-voice-studio",
      model: MIND_MODEL,
      text: spokenText,
      voiceId: voice.id,
      accent: "US",
      gender: voice.gender === "female" ? "female" : "male",
      speed,
      targetDuration: 0,
      outputPath,
      language: req.language,
    });
    await provider.downloadResult(job.externalId);
    const take: StudioTake = {
      id: randomUUID(),
      key,
      file: toRelative(outputPath),
      mp3: null,
      text: words,
      spokenText,
      voiceId: voice.id,
      voiceLabel: mindVoiceLabel(voice),
      engine: voice.engine,
      variant,
      language: req.language,
      style: req.style,
      emotion,
      speed,
      pause: req.pause,
      preview: req.preview,
      durationSec: Math.round((await probeDuration(outputPath)) * 100) / 100,
      saved: false,
      createdAt: new Date().toISOString(),
    };
    lib.takes.unshift(take);
    writeLibrary(lib);
    return { ok: true, take, reused: false, notice };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    release();
  }
}

export function setTakeSaved(id: string, saved: boolean): StudioTake | null {
  const lib = readLibrary();
  const take = lib.takes.find((t) => t.id === id);
  if (!take) return null;
  take.saved = saved;
  writeLibrary(lib);
  return take;
}

/** The take as MP3 (made once, next to the WAV). */
export async function takeAsMp3(id: string): Promise<StudioTake | null> {
  const lib = readLibrary();
  const take = lib.takes.find((t) => t.id === id);
  if (!take || !fs.existsSync(toAbsolute(take.file))) return null;
  if (take.mp3 && fs.existsSync(toAbsolute(take.mp3))) return take;
  const mp3 = take.file.replace(/\.wav$/i, ".mp3");
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-i", toAbsolute(take.file), "-codec:a", "libmp3lame", "-q:a", "2", toAbsolute(mp3)]);
  take.mp3 = mp3;
  writeLibrary(lib);
  return take;
}
