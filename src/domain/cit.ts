/**
 * CIT VOICE STUDIO - a LOCAL, multilingual TTS provider (QĐ-144). Pure: no
 * network, no database.
 *
 * CIT runs on this machine and serves a documented public API (README of
 * github.com/Cuongyd196/cit-voice-studio): GET /health, GET /voices,
 * POST /api/tts/generate ({ text, voice_id } -> audio bytes), and its own
 * OpenAPI at /openapi.json. Everything beyond `text` and `voice_id` - speed,
 * language, output format - is sent ONLY when the running CIT's OpenAPI
 * declares the field; nothing here guesses a request schema.
 *
 * Two engines behind one provider, chosen by the voice:
 *   VieNeu-TTS v3 Turbo  Vietnamese first (+ English mixed in)   Apache-2.0
 *   Supertonic 3         31 languages, English included           OpenRAIL-M
 * Supertonic is downloaded inside CIT on demand, so it may be missing.
 *
 * Local generation costs $0: no ledger line, no spend cap, and it is never a
 * fallback for - or replaced by - a paid provider.
 */

import type { SceneVoiceRole, VoiceEmotionId, VoiceStyleId } from "./voice-director";

export const CIT_PROVIDER = "cit";
export const CIT_MODEL = "cit-local";
export const CIT_DEFAULT_BASE_URL = "http://127.0.0.1:8001";
/** Voice "Tự động": the first voice of the engine that fits the line's language. */
export const CIT_AUTO_VOICE = "AUTO";
export const CIT_LABEL = "CIT Voice Studio — Local / $0";
/** Bump when a rule below changes: it is part of every CIT voice key. */
export const CIT_ADAPTER_VERSION = "cit-v2";
/** The speed range CIT's own UI offers (0.75x-1.50x); the OpenAPI may narrow it. */
export const CIT_MIN_SPEED = 0.75;
export const CIT_MAX_SPEED = 1.5;

export const CIT_OFFLINE_GUIDE =
  "CIT Voice Studio chưa chạy. Mở ứng dụng CIT Voice Studio trên máy này (API mặc định http://127.0.0.1:8001), " +
  "đợi trạng thái sẵn sàng rồi bấm Kiểm tra lại. Không có giọng nào được tạo bằng nhà cung cấp trả phí thay thế.";

export type CitEngineId = "VIENEU" | "SUPERTONIC" | "UNKNOWN";

export const CIT_ENGINES: Record<Exclude<CitEngineId, "UNKNOWN">, {
  label: string;
  license: string;
  attribution: string;
  /** Emotion tags the engine documents. */
  tags: { laugh: string; sigh: string; clearThroat?: string; breath?: string };
}> = {
  VIENEU: {
    label: "VieNeu-TTS v3 Turbo",
    license: "Apache-2.0",
    attribution: "VieNeu-TTS © Phạm Nguyễn Ngọc Bảo (Apache-2.0)",
    tags: { laugh: "[cười]", sigh: "[thở dài]", clearThroat: "[hắng giọng]" },
  },
  SUPERTONIC: {
    label: "Supertonic 3",
    license: "OpenRAIL-M",
    attribution: "Supertonic 3 © Supertone Inc. (OpenRAIL-M - phải tuân thủ các giới hạn sử dụng của giấy phép)",
    tags: { laugh: "<laugh>", sigh: "<sigh>", breath: "<breath>" },
  },
};

export function engineLabel(engine: CitEngineId): string {
  return engine === "UNKNOWN" ? "Không rõ" : CIT_ENGINES[engine].label;
}

/** A model / engine name as CIT reports it, to one of ours. */
export function engineOf(raw: unknown): CitEngineId {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("vieneu")) return "VIENEU";
  if (s.includes("supertonic")) return "SUPERTONIC";
  return "UNKNOWN";
}

// ------------------------------------------------------------- discovery ---

export interface CitVoice {
  id: string;
  label: string;
  gender: string | null;
  /** Language codes the voice reports; empty = not reported. */
  languages: string[];
  engine: CitEngineId;
}

export interface CitEngineState {
  engine: CitEngineId;
  name: string;
  /** False = known to CIT but not downloaded; null = not reported. */
  installed: boolean | null;
}

export interface CitHealth {
  version: string | null;
  /** Languages CIT reports it can speak; empty = not reported. */
  languages: string[];
  engines: CitEngineState[];
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

function languageList(v: unknown): string[] {
  if (typeof v === "string") return v.split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === "string" ? x : str((x as Record<string, unknown>)?.code) ?? str((x as Record<string, unknown>)?.id)))
      .filter((x): x is string => Boolean(x))
      .map((x) => x.toLowerCase());
  }
  if (v && typeof v === "object") return Object.keys(v).map((k) => k.toLowerCase());
  return [];
}

/**
 * /health, read without assuming a shape: the README documents only that it
 * reports server status. Languages and engines are taken when present.
 */
export function parseCitHealth(json: unknown): CitHealth {
  const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const caps = (o.capabilities && typeof o.capabilities === "object" ? o.capabilities : {}) as Record<string, unknown>;
  const languages = languageList(o.languages ?? o.supported_languages ?? caps.languages);
  // The real CIT (2026-10-22) reports ONE active engine as a string: "engine": "VieNeu-TTS-v3-Turbo (int8)".
  const rawEngines = o.engines ?? o.models ?? caps.engines ?? caps.models ?? (typeof o.engine === "string" ? [o.engine] : undefined);
  const engines: CitEngineState[] = [];
  if (Array.isArray(rawEngines)) {
    for (const e of rawEngines) {
      if (typeof e === "string") engines.push({ engine: engineOf(e), name: e, installed: null });
      else if (e && typeof e === "object") {
        const r = e as Record<string, unknown>;
        const name = str(r.name) ?? str(r.id) ?? str(r.model) ?? "?";
        const installed = typeof r.installed === "boolean" ? r.installed : typeof r.available === "boolean" ? r.available : typeof r.loaded === "boolean" ? r.loaded : null;
        engines.push({ engine: engineOf(`${name} ${str(r.engine) ?? ""}`), name, installed });
      }
    }
  } else if (rawEngines && typeof rawEngines === "object") {
    for (const [name, v] of Object.entries(rawEngines)) {
      const installed = typeof v === "boolean" ? v : v && typeof v === "object" && typeof (v as Record<string, unknown>).installed === "boolean" ? ((v as Record<string, unknown>).installed as boolean) : null;
      engines.push({ engine: engineOf(name), name, installed });
    }
  }
  return { version: str(o.version) ?? str(o.app_version), languages, engines };
}

/** /voices: an array, `{ voices: [...] }` / `{ data: [...] }`, or a name -> info map. */
export function parseCitVoices(json: unknown): CitVoice[] {
  const o = json as Record<string, unknown> | unknown[] | null;
  let items: unknown[] = [];
  if (Array.isArray(o)) items = o;
  else if (o && typeof o === "object") {
    if (Array.isArray(o.voices)) items = o.voices;
    else if (Array.isArray(o.data)) items = o.data;
    else items = Object.entries(o).map(([name, v]) => (v && typeof v === "object" ? { name, ...(v as object) } : name));
  }
  const out: CitVoice[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      out.push({ id: item, label: item, gender: null, languages: [], engine: "UNKNOWN" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = str(r.voice_id) ?? str(r.id) ?? str(r.name);
    if (!id) continue;
    out.push({
      id,
      label: str(r.name) ?? str(r.display_name) ?? str(r.label) ?? id,
      gender: str(r.gender),
      languages: languageList(r.languages ?? r.language ?? r.lang),
      engine: engineOf(`${str(r.engine) ?? ""} ${str(r.model) ?? ""} ${str(r.backend) ?? ""}`),
    });
  }
  return out;
}

export interface CitGenerateSchema {
  /** Body fields the running CIT declares for POST /api/tts/generate. */
  fields: string[];
  required: string[];
  bodyType: "json" | "form";
  speed: { min: number; max: number } | null;
  /** Allowed values of `language`, when the spec enumerates them. */
  languages: string[];
  formats: string[];
}

export interface CitApiSpec {
  generate: CitGenerateSchema | null;
  /** Paths that look like the pronunciation dictionary (read-only in Phase 1). */
  pronunciationPaths: string[];
  conversation: boolean;
  generateWithSubtitles: boolean;
}

/** The documented minimum, used when /openapi.json cannot be read. */
export const CIT_DOCUMENTED_GENERATE: CitGenerateSchema = {
  fields: ["text", "voice_id"],
  required: ["text", "voice_id"],
  bodyType: "json",
  speed: null,
  languages: [],
  formats: [],
};

function deref(spec: Record<string, unknown>, node: unknown): Record<string, unknown> {
  let n = (node ?? {}) as Record<string, unknown>;
  for (let i = 0; i < 5 && typeof n.$ref === "string"; i++) {
    const parts = (n.$ref as string).replace(/^#\//, "").split("/");
    let cur: unknown = spec;
    for (const p of parts) cur = (cur as Record<string, unknown> | undefined)?.[p];
    n = (cur ?? {}) as Record<string, unknown>;
  }
  // FastAPI wraps optional fields in anyOf [{type}, {type: null}] and bodies in allOf [ {$ref} ].
  const all = asArray(n.allOf);
  if (all.length === 1) return deref(spec, all[0]);
  return n;
}

function enumOf(spec: Record<string, unknown>, prop: Record<string, unknown>): string[] {
  const p = deref(spec, prop);
  if (Array.isArray(p.enum)) return p.enum.map(String);
  for (const alt of asArray(p.anyOf)) {
    const a = deref(spec, alt);
    if (Array.isArray(a.enum)) return a.enum.map(String);
  }
  return [];
}

function rangeOf(spec: Record<string, unknown>, prop: Record<string, unknown>): { min: number; max: number } | null {
  const p = deref(spec, prop);
  const pick = (o: Record<string, unknown>) => {
    const min = typeof o.minimum === "number" ? o.minimum : typeof o.exclusiveMinimum === "number" ? o.exclusiveMinimum : null;
    const max = typeof o.maximum === "number" ? o.maximum : typeof o.exclusiveMaximum === "number" ? o.exclusiveMaximum : null;
    return min !== null || max !== null ? { min: min ?? CIT_MIN_SPEED, max: max ?? CIT_MAX_SPEED } : null;
  };
  return pick(p) ?? asArray(p.anyOf).map((a) => pick(deref(spec, a))).find(Boolean) ?? null;
}

/** Read what the running CIT documents about itself. */
export function parseCitOpenApi(json: unknown): CitApiSpec {
  const spec = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const paths = (spec.paths && typeof spec.paths === "object" ? spec.paths : {}) as Record<string, Record<string, unknown>>;
  const names = Object.keys(paths);
  let generate: CitGenerateSchema | null = null;
  const post = paths["/api/tts/generate"]?.post as Record<string, unknown> | undefined;
  if (post) {
    const content = ((post.requestBody as Record<string, unknown> | undefined)?.content ?? {}) as Record<string, { schema?: unknown }>;
    const type = Object.keys(content).find((k) => k.includes("json")) ?? Object.keys(content).find((k) => k.includes("form")) ?? null;
    const schema = type ? deref(spec, content[type]?.schema) : {};
    const props = (schema.properties && typeof schema.properties === "object" ? schema.properties : {}) as Record<string, Record<string, unknown>>;
    const fields = Object.keys(props);
    // FastAPI may take simple fields as query parameters instead of a body.
    const query = asArray(post.parameters)
      .map((p) => p as Record<string, unknown>)
      .filter((p) => p.in === "query" && typeof p.name === "string");
    if (fields.length > 0 || query.length > 0) {
      const all = { ...props, ...Object.fromEntries(query.map((q) => [q.name as string, (q.schema ?? {}) as Record<string, unknown>])) };
      const formatKey = ["format", "output_format", "response_format"].find((k) => k in all);
      generate = {
        fields: Object.keys(all),
        required: [...asArray(schema.required).map(String), ...query.filter((q) => q.required === true).map((q) => q.name as string)],
        bodyType: type && type.includes("form") ? "form" : "json",
        speed: all.speed ? rangeOf(spec, all.speed) : null,
        languages: all.language ? enumOf(spec, all.language) : [],
        formats: formatKey ? enumOf(spec, all[formatKey]!) : [],
      };
    }
  }
  return {
    generate,
    pronunciationPaths: names.filter((p) => /pronunc|dictionary|\bdict\b|tu-dien|tudien/i.test(p)),
    conversation: names.includes("/api/tts/conversation"),
    generateWithSubtitles: names.includes("/api/tts/generate-with-subtitles"),
  };
}

// ------------------------------------------------------- language routing ---

/** The code CIT is asked for: vi / en from the line, or the project's own language. */
export function citLanguageFor(projectLanguage: string | null | undefined, lineLanguage: "vi" | "en"): string {
  if (!projectLanguage || ["vi", "en", "vi-en", "auto"].includes(projectLanguage)) return lineLanguage;
  return projectLanguage;
}

export type CitVoicePick = { ok: true; voice: CitVoice } | { ok: false; code: "SUPERTONIC_NOT_READY" | "LANGUAGE_UNSUPPORTED" | "NO_VOICE"; message: string };

const SUPERTONIC_GUIDE = "Mở CIT Voice Studio → Cài đặt → Mô hình để tải Supertonic 3, rồi bấm Kiểm tra lại.";

function speaks(voice: CitVoice, language: string): boolean {
  return voice.languages.length === 0 || voice.languages.some((l) => l === language || l.startsWith(`${language}-`));
}

/**
 * "Tự động": Vietnamese -> VieNeu, English -> Supertonic 3 (when downloaded),
 * any other language -> a voice CIT says speaks it, and only if CIT lists the
 * language. Never a paid provider.
 */
export function pickCitVoice(voices: CitVoice[], health: CitHealth | null, language: string): CitVoicePick {
  if (health && health.languages.length > 0 && !health.languages.some((l) => l === language || l.startsWith(`${language}-`))) {
    return { ok: false, code: "LANGUAGE_UNSUPPORTED", message: `CIT Voice Studio không báo hỗ trợ ngôn ngữ "${language}" (CIT hỗ trợ: ${health.languages.join(", ")}).` };
  }
  const supertonicMissing = health?.engines.some((e) => e.engine === "SUPERTONIC" && e.installed === false) ?? false;
  if (language === "vi") {
    const v = voices.find((x) => x.engine === "VIENEU" && speaks(x, "vi")) ?? voices.find((x) => x.engine === "UNKNOWN" && x.languages.includes("vi"));
    return v ? { ok: true, voice: v } : { ok: false, code: "NO_VOICE", message: "CIT Voice Studio không có giọng VieNeu tiếng Việt nào." };
  }
  const supertonic = voices.filter((x) => x.engine === "SUPERTONIC" && speaks(x, language));
  if (supertonic.length > 0 && !supertonicMissing) return { ok: true, voice: supertonic[0]! };
  if (language === "en") {
    return { ok: false, code: "SUPERTONIC_NOT_READY", message: `Giọng tiếng Anh cần Supertonic 3, mô hình này chưa sẵn sàng trong CIT. ${SUPERTONIC_GUIDE}` };
  }
  const other = voices.find((x) => x.languages.some((l) => l === language || l.startsWith(`${language}-`)));
  return other
    ? { ok: true, voice: other }
    : { ok: false, code: "LANGUAGE_UNSUPPORTED", message: `CIT Voice Studio không có giọng cho ngôn ngữ "${language}". ${SUPERTONIC_GUIDE}` };
}

// -------------------------------------------------- voice director adapter ---

export interface CitDirectionInput {
  /** The speakable text (prepareSpeechText, speaker label already gone). */
  text: string;
  engine: CitEngineId;
  /** Null = Voice Director off: the words go as they are. */
  style: VoiceStyleId | null;
  role: SceneVoiceRole | null;
  emotion: VoiceEmotionId | null;
}

/** Sentences of one line, punctuation kept. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+(?=\S)/).filter((s) => s.trim().length > 0);
}

/**
 * A longer beat between the first sentences. CIT speaks with VieNeu, which has
 * NO pause tag: an unknown "[nghỉ 500ms]" is read aloud as words (checked in
 * the VieNeu SDK and on the real CIT, 2026-10-22). A line break is VieNeu's
 * own paragraph pause; other engines get the sentences as they are.
 */
function pauseBetween(parts: string[], engine: CitEngineId, max: number): string {
  if (engine !== "VIENEU") return parts.join(" ");
  return parts.reduce((out, s, i) => (i === 0 ? s : `${out}${i <= max ? "\n" : " "}${s}`), "");
}

const PAUSED_STYLES = new Set<VoiceStyleId>(["DOCUMENTARY", "DRAMATIC", "STORYTELLING"]);

/**
 * What the OpenAI-style direction becomes for CIT. OpenAI `instructions` are
 * never sent (CIT does not take them); the director's intent is carried by the
 * few inline tags CIT documents, used sparingly:
 *  - Professional / Educational / Natural / Product Review / Cute / Energetic:
 *    the words only;
 *  - Documentary / Dramatic / Storytelling: a beat between the first sentences;
 *  - a punchline: a beat before its last sentence; TikTok Comedy adds ONE laugh
 *    after it (the engine's own tag);
 *  - a touching moment: one sigh in front, a beat between sentences.
 * A beat is a line break for VieNeu and nothing for other engines (no engine
 * CIT runs has a pause tag). At most one emotion tag per line; an engine that
 * is not known gets no tag.
 */
export function citDirection(input: CitDirectionInput): { text: string; tags: string[] } {
  const text = input.text.trim();
  if (!input.style || text.length === 0) return { text, tags: [] };
  const tags = input.engine === "UNKNOWN" ? null : CIT_ENGINES[input.engine].tags;
  const parts = sentences(text);
  const used: string[] = [];
  let out = text;

  if (input.emotion === "TOUCHING" || input.role === "EMOTIONAL") {
    out = pauseBetween(parts, input.engine, 2);
    if (input.emotion === "TOUCHING" && tags) {
      out = `${tags.sigh} ${out}`;
      used.push(tags.sigh);
    }
  } else if (input.role === "PUNCHLINE" && parts.length > 1) {
    out = pauseBetween([parts.slice(0, -1).join(" "), parts[parts.length - 1]!], input.engine, 1);
  } else if (PAUSED_STYLES.has(input.style) && parts.length > 1) {
    out = pauseBetween(parts, input.engine, 2);
  }

  const laughs = input.style === "COMEDY" && (input.role === "PUNCHLINE" || input.emotion === "HUMOROUS");
  if (laughs && tags && !used.includes(tags.sigh)) {
    out = `${out} ${tags.laugh}`;
    used.push(tags.laugh);
  }
  return { text: out, tags: used };
}

/**
 * The CIT direction as stored on the line and folded into its voice key. It is
 * NOT sent to CIT: it records what made this audio, so a change of engine,
 * language or direction is a different line - and the same settings are the
 * same line, reused.
 */
export function citDirectionSummary(opts: { engine: CitEngineId; language: string; style: VoiceStyleId | null; role: SceneVoiceRole | null; emotion: VoiceEmotionId | null }): string {
  return [
    `CIT ${CIT_ADAPTER_VERSION}`,
    `engine=${opts.engine}`,
    `lang=${opts.language}`,
    opts.style ? `style=${opts.style} role=${opts.role ?? "-"} emotion=${opts.emotion ?? "-"}` : "director=off",
  ].join(" ");
}

export function clampCitSpeed(speed: number, range: { min: number; max: number } | null = null): number {
  const min = range?.min ?? CIT_MIN_SPEED;
  const max = range?.max ?? CIT_MAX_SPEED;
  if (!Number.isFinite(speed) || speed <= 0) return 1;
  return Math.round(Math.min(max, Math.max(min, speed)) * 100) / 100;
}

/** RIFF....WAVE */
export function isWav(bytes: Uint8Array): boolean {
  return bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
}
