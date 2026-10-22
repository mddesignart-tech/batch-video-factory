/**
 * MIND VOICE - the app's own LOCAL TTS service (QĐ-145). Pure: no network, no
 * database.
 *
 * Mind Voice is a small Python service shipped in `voice-engine/` that runs
 * the official open-source SDKs on this machine, localhost only:
 *   VieNeu-TTS v3 Turbo  Vietnamese (+ English inside Vietnamese)   Apache-2.0
 *   Supertonic 3         English (31 languages in the model)        OpenRAIL-M
 * Its API is ours (voice-engine/mind_voice/server.py), so the shapes below are
 * read strictly - unlike CIT, nothing is guessed.
 *
 * Local generation costs $0: no ledger line, no spend cap, and it is never a
 * fallback for - or replaced by - a paid provider.
 */

import type { SceneVoiceRole, VoiceEmotionId, VoiceStyleId } from "./voice-director";

export const MIND_PROVIDER = "mindvoice";
export const MIND_MODEL = "mind-local";
export const MIND_DEFAULT_BASE_URL = "http://127.0.0.1:8011";
/** Voice "Tự động": the engine's default voice for the line's language. */
export const MIND_AUTO_VOICE = "AUTO";
export const MIND_LABEL = "Mind Voice Local — $0";
/** Bump when a rule below changes: it is part of every Mind Voice voice key. */
export const MIND_ADAPTER_VERSION = "mind-v1";
export const MIND_MIN_SPEED = 0.75;
export const MIND_MAX_SPEED = 1.5;

export const MIND_OFFLINE_GUIDE =
  "Mind Voice chưa chạy. Chạy START_TOOL.bat (tự mở Mind Voice khi đã cài), hoặc voice-engine\\start_voice_engine.bat, " +
  "rồi bấm Kiểm tra lại. Không có giọng nào được tạo bằng nhà cung cấp trả phí thay thế.";

export type MindEngineId = "vieneu" | "supertonic";

export const MIND_ENGINES: Record<MindEngineId, { label: string; license: string; attribution: string; language: "vi" | "en" }> = {
  vieneu: {
    label: "VieNeu-TTS v3 Turbo",
    license: "Apache-2.0",
    attribution: "VieNeu-TTS © Phạm Nguyễn Ngọc Bảo (Apache-2.0)",
    language: "vi",
  },
  supertonic: {
    label: "Supertonic 3",
    license: "OpenRAIL-M",
    attribution: "Supertonic 3 © Supertone Inc. (OpenRAIL-M - phải tuân thủ các giới hạn sử dụng của giấy phép)",
    language: "en",
  },
};

export const isMindEngine = (v: unknown): v is MindEngineId => v === "vieneu" || v === "supertonic";

// ------------------------------------------------------------- discovery ---

export interface MindVoice {
  id: string;
  name: string;
  engine: MindEngineId;
  languages: string[];
  gender: "male" | "female" | null;
  /** Only what the SDK states - null when it says nothing. */
  region: "north" | "central" | "south" | null;
  style: string | null;
  description: string;
  featured: number | null;
  isDefault: boolean;
  /** The engine's model is installed (a voice of a missing model cannot speak). */
  installed: boolean;
}

export interface MindEngineState {
  id: MindEngineId;
  label: string;
  installed: boolean;
  variant: string | null;
  loaded: boolean;
  sampleRate: number;
  nativeSpeed: boolean;
  tags: string[];
  license: string;
}

export interface MindHealth {
  version: string;
  device: string;
  gpuNote: string | null;
  hardware: { cpu: string; threads: number | null; ramGb: number | null; gpu: string | null };
  engines: MindEngineState[];
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseMindHealth(json: unknown): MindHealth {
  const o = rec(json);
  if (o.service !== "mind-voice") throw new Error("Dịch vụ ở cổng này không phải Mind Voice.");
  const hw = rec(o.hardware);
  const gpu = rec(hw.gpu);
  const engines: MindEngineState[] = [];
  for (const e of Array.isArray(o.engines) ? o.engines : []) {
    const r = rec(e);
    if (!isMindEngine(r.id)) continue;
    engines.push({
      id: r.id,
      label: s(r.label) || MIND_ENGINES[r.id].label,
      installed: r.installed === true,
      variant: s(r.variant) || null,
      loaded: r.loaded === true,
      sampleRate: n(r.sample_rate) ?? 0,
      nativeSpeed: r.native_speed === true,
      tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      license: s(r.license) || MIND_ENGINES[r.id].license,
    });
  }
  return {
    version: s(o.version),
    device: s(hw.device) || "cpu",
    gpuNote: s(hw.gpu_note) || null,
    hardware: { cpu: s(hw.cpu), threads: n(hw.threads), ramGb: n(hw.ram_gb), gpu: s(gpu.name) || null },
    engines,
  };
}

export function parseMindVoices(json: unknown): MindVoice[] {
  const list = rec(json).voices;
  const out: MindVoice[] = [];
  for (const v of Array.isArray(list) ? list : []) {
    const r = rec(v);
    const id = s(r.id);
    if (!id || !isMindEngine(r.engine)) continue;
    const region = r.region === "north" || r.region === "central" || r.region === "south" ? r.region : null;
    out.push({
      id,
      name: s(r.name) || id,
      engine: r.engine,
      languages: Array.isArray(r.languages) ? r.languages.map(String) : [],
      gender: r.gender === "male" || r.gender === "female" ? r.gender : null,
      region,
      style: s(r.style) || null,
      description: s(r.description),
      featured: n(r.featured),
      isDefault: r.default === true,
      installed: r.installed === true,
    });
  }
  return out;
}

export const REGION_LABEL: Record<NonNullable<MindVoice["region"]>, string> = { north: "Bắc", central: "Trung", south: "Nam" };
export const STYLE_LABEL: Record<string, string> = { natural: "Tự nhiên", storytelling: "Kể chuyện", news: "Tin tức" };

/** "Hải Đăng · Nam · Bắc · Tự nhiên" - only the facts the engine reported. */
export function mindVoiceLabel(v: MindVoice): string {
  return [
    v.name,
    v.gender === "male" ? "Nam" : v.gender === "female" ? "Nữ" : null,
    v.region ? `Giọng ${REGION_LABEL[v.region]}` : null,
    v.style ? (STYLE_LABEL[v.style] ?? v.style) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// ------------------------------------------------------ language routing ---

/** Vietnamese -> VieNeu; English -> Supertonic 3. */
export function engineForLanguage(language: string): MindEngineId | null {
  if (language === "vi") return "vieneu";
  if (language === "en") return "supertonic";
  return null;
}

export type MindVoicePick =
  | { ok: true; voice: MindVoice }
  | { ok: false; code: "MODEL_MISSING" | "LANGUAGE_UNSUPPORTED" | "NO_VOICE"; message: string };

/**
 * "Tự động": the engine for the line's language, then its default voice (or its
 * first featured one). A model that is not installed is said so plainly -
 * never replaced by a paid provider, never by the other engine.
 */
export function pickMindVoice(voices: MindVoice[], language: string): MindVoicePick {
  const engine = engineForLanguage(language);
  if (!engine) {
    return { ok: false, code: "LANGUAGE_UNSUPPORTED", message: `Mind Voice chưa hỗ trợ ngôn ngữ "${language}" (hiện có: Tiếng Việt, English).` };
  }
  const own = voices.filter((v) => v.engine === engine);
  if (own.length > 0 && !own.some((v) => v.installed)) {
    return { ok: false, code: "MODEL_MISSING", message: `Chưa cài ${MIND_ENGINES[engine].label}. Mở Mind Voice Studio → Quản lý model để cài.` };
  }
  const pick =
    own.find((v) => v.isDefault) ??
    [...own].filter((v) => v.featured !== null).sort((a, b) => (a.featured ?? 0) - (b.featured ?? 0))[0] ??
    own[0];
  return pick
    ? { ok: true, voice: pick }
    : { ok: false, code: engine === "supertonic" ? "MODEL_MISSING" : "NO_VOICE", message: `Mind Voice chưa có giọng ${MIND_ENGINES[engine].label}. Mở Mind Voice Studio → Quản lý model.` };
}

// -------------------------------------------------- voice director adapter ---

export interface MindDirectionInput {
  /** The speakable text (prepareSpeechText: speaker label already gone). */
  text: string;
  engine: MindEngineId;
  /** Null = Voice Director off: the words go as they are. */
  style: VoiceStyleId | null;
  role: SceneVoiceRole | null;
  emotion: VoiceEmotionId | null;
}

/** Inline cues each engine really understands (checked in the SDK, 2026-10-22). */
export const MIND_TAGS: Record<MindEngineId, { laugh: string; sigh: string; clearThroat?: string; breath?: string }> = {
  // vieneu_utils.phonemize_text: [cười] [thở dài] [hắng giọng]; any other [..] is READ AS TEXT.
  vieneu: { laugh: "[cười]", sigh: "[thở dài]", clearThroat: "[hắng giọng]" },
  supertonic: { laugh: "<laugh>", sigh: "<sigh>", breath: "<breath>" },
};

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+(?=\S)/).filter((x) => x.trim().length > 0);
}

/**
 * A longer beat between the first sentences. VieNeu has no pause tag (an
 * unknown "[nghỉ 500ms]" would be spoken aloud): a line break is its own
 * paragraph pause. Supertonic gets the sentences as they are.
 */
function beat(parts: string[], engine: MindEngineId, max: number): string {
  if (engine !== "vieneu") return parts.join(" ");
  return parts.reduce((out, x, i) => (i === 0 ? x : `${out}${i <= max ? "\n" : " "}${x}`), "");
}

const PAUSED_STYLES = new Set<VoiceStyleId>(["DOCUMENTARY", "DRAMATIC", "STORYTELLING"]);

/**
 * What the Voice Director's intent becomes for a local engine. OpenAI
 * `instructions` are never sent; at most ONE emotion cue per line, and only a
 * cue the engine documents:
 *  - Documentary / Dramatic / Storytelling: a beat between the first sentences;
 *  - a punchline: a beat before its last sentence; Comedy adds one laugh after it;
 *  - a touching moment: one sigh in front.
 */
export function mindDirection(input: MindDirectionInput): { text: string; tags: string[] } {
  const text = input.text.trim();
  if (!input.style || text.length === 0) return { text, tags: [] };
  const tags = MIND_TAGS[input.engine];
  const parts = sentences(text);
  const used: string[] = [];
  let out = text;

  if (input.emotion === "TOUCHING" || input.role === "EMOTIONAL") {
    out = beat(parts, input.engine, 2);
    if (input.emotion === "TOUCHING") {
      out = `${tags.sigh} ${out}`;
      used.push(tags.sigh);
    }
  } else if (input.role === "PUNCHLINE" && parts.length > 1) {
    out = beat([parts.slice(0, -1).join(" "), parts[parts.length - 1]!], input.engine, 1);
  } else if (PAUSED_STYLES.has(input.style) && parts.length > 1) {
    out = beat(parts, input.engine, 2);
  }

  const laughs = input.style === "COMEDY" && (input.role === "PUNCHLINE" || input.emotion === "HUMOROUS");
  if (laughs && !used.includes(tags.sigh)) {
    out = `${out} ${tags.laugh}`;
    used.push(tags.laugh);
  }
  return { text: out, tags: used };
}

/**
 * The Mind Voice direction as stored on the line and folded into its voice key:
 * adapter version, engine, model variant, language and director settings. A
 * change of any of them is a different line; the same settings are the same
 * line, reused.
 */
export function mindDirectionSummary(opts: {
  engine: MindEngineId;
  variant: string | null;
  language: string;
  style: VoiceStyleId | null;
  role: SceneVoiceRole | null;
  emotion: VoiceEmotionId | null;
}): string {
  return [
    `MIND ${MIND_ADAPTER_VERSION}`,
    `engine=${opts.engine}/${opts.variant ?? "default"}`,
    `lang=${opts.language}`,
    opts.style ? `style=${opts.style} role=${opts.role ?? "-"} emotion=${opts.emotion ?? "-"}` : "director=off",
  ].join(" ");
}

export function clampMindSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 1;
  return Math.round(Math.min(MIND_MAX_SPEED, Math.max(MIND_MIN_SPEED, speed)) * 100) / 100;
}

/** ffmpeg atempo chain for an engine without native speed (atempo takes 0.5..2). */
export function atempoFilter(speed: number): string | null {
  const v = clampMindSpeed(speed);
  return Math.abs(v - 1) < 0.005 ? null : `atempo=${v.toFixed(2)}`;
}

// ---------------------------------------------------------- model manager ---

export interface MindModelVariant {
  id: string;
  label: string;
  note: string;
  installed: boolean;
  diskBytes: number;
  downloadBytes: number | null;
  installedAt: string | null;
  sources: { repo: string; revision: string }[];
}

export interface MindModelStatus {
  id: MindEngineId;
  label: string;
  languages: string[];
  license: string;
  licenseUrl: string;
  attribution: string;
  sampleRate: number;
  tags: string[];
  nativeSpeed: boolean;
  notes: string[];
  installed: boolean;
  activeVariant: string | null;
  variants: MindModelVariant[];
  job: { state: "running" | "done" | "failed"; variant: string; totalBytes: number; doneBytes: number; current: string; error: string | null } | null;
}

/** GET /models, read strictly (the service is ours). */
export function parseMindModels(json: unknown): MindModelStatus[] {
  const out: MindModelStatus[] = [];
  for (const e of Array.isArray(rec(json).engines) ? (rec(json).engines as unknown[]) : []) {
    const r = rec(e);
    if (!isMindEngine(r.id)) continue;
    const job = rec(r.install_job);
    out.push({
      id: r.id,
      label: s(r.label),
      languages: Array.isArray(r.languages) ? r.languages.map(String) : [],
      license: s(r.license),
      licenseUrl: s(r.license_url),
      attribution: s(r.attribution),
      sampleRate: n(r.sample_rate) ?? 0,
      tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      nativeSpeed: r.native_speed === true,
      notes: Array.isArray(r.notes) ? r.notes.map(String) : [],
      installed: r.installed === true,
      activeVariant: s(r.active_variant) || null,
      variants: (Array.isArray(r.variants) ? r.variants : []).map((v) => {
        const x = rec(v);
        return {
          id: s(x.id),
          label: s(x.label),
          note: s(x.note),
          installed: x.installed === true,
          diskBytes: n(x.disk_bytes) ?? 0,
          downloadBytes: n(x.download_bytes),
          installedAt: s(x.installed_at) || null,
          sources: (Array.isArray(x.sources) ? x.sources : []).map((src) => ({ repo: s(rec(src).repo), revision: s(rec(src).revision) })),
        };
      }),
      job:
        job.state === "running" || job.state === "done" || job.state === "failed"
          ? { state: job.state, variant: s(job.variant), totalBytes: n(job.total_bytes) ?? 0, doneBytes: n(job.done_bytes) ?? 0, current: s(job.current), error: s(job.error) || null }
          : null,
    });
  }
  return out;
}
