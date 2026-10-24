import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { hasApiKey } from "@/providers/provider-credentials";
import { OPENAI_VOICES } from "@/providers/openai/openai-voice-client";
import { MIND_AUTO_VOICE, MIND_ENGINES, MIND_LABEL, MIND_MAX_SPEED, MIND_MIN_SPEED, MIND_MODEL, MIND_OFFLINE_GUIDE, MIND_PROVIDER } from "@/domain/mind-voice";
import { MIN_SPEED, MAX_SPEED } from "@/providers/voice-config";
import {
  characterProfiles,
  primaryProfile,
  voiceLocaleOf,
  type CharacterVoiceRow,
  type VoiceLocaleId,
  type VoiceProfile,
} from "@/domain/voice-locale";
import { cachedMindCatalog, refreshMindCatalog, type MindCatalog } from "./mind-voice-catalog";

/**
 * VOICE CATALOG (QĐ-158): which voices really exist, per language, for the
 * character voice picker and for checking a saved voice.
 *
 * Only what a source states is shown as fact:
 *   Mind Voice  the running service's /voices (kept in a Setting row, so the
 *               list survives Mind Voice being stopped): language, gender and
 *               Vietnamese region come from the SDK. Supertonic says "en" and
 *               nothing about US or UK - so its accent is "chưa xác minh".
 *   OpenAI      its fixed list (OpenAI has no listing endpoint). OpenAI states
 *               neither a gender nor an accent per voice, and the app has not
 *               measured Vietnamese - those are marked unverified.
 *   Mock        only in Mock Mode, labelled as fake.
 * CIT Voice Studio is legacy (replaced by Mind Voice) and not offered for a new
 * choice; a character already on it keeps working.
 *
 * Reading the catalog is free: no paid request, ever. "Kiểm tra lại" only asks
 * the local Mind Voice service.
 */

export type CatalogStatus = "ONLINE" | "OFFLINE" | "NOT_INSTALLED" | "NO_KEY" | "DISABLED" | "MOCK";

export interface CatalogVoice {
  id: string;
  label: string;
  gender: "male" | "female" | null;
  genderVerified: boolean;
  /** Vietnamese region, only when the engine states it. */
  region: "north" | "central" | "south" | null;
  style: string | null;
  /** The language itself is stated by the engine / vendor for this voice. */
  languageVerified: boolean;
  /** The English accent (US / UK) is stated by the source. */
  accentVerified: boolean;
  note: string;
}

export interface CatalogModel {
  provider: string;
  providerLabel: string;
  model: string;
  modelLabel: string;
  local: boolean;
  /** Dollars per 1000 characters (0 for a local engine). */
  pricePer1kChars: number;
  status: CatalogStatus;
  /** What the person can do about the status, in Vietnamese. */
  statusMessage: string;
  /** Can be chosen and saved right now. An offline Mind Voice still can (its voices are known). */
  selectable: boolean;
  speed: { min: number; max: number };
  /** Takes a free-text delivery direction (OpenAI gpt-4o-mini-tts). */
  supportsInstructions: boolean;
  /** How emotion is reachable: free text, the engine's own tags, or not at all. */
  emotion: "INSTRUCTIONS" | "TAGS" | "NONE";
  voices: CatalogVoice[];
}

export interface VoiceCatalog {
  locale: VoiceLocaleId;
  checkedAt: string | null;
  models: CatalogModel[];
}

const REGION_LABEL = { north: "miền Bắc", central: "miền Trung", south: "miền Nam" } as const;
const STYLE_LABEL: Record<string, string> = { natural: "tự nhiên", storytelling: "kể chuyện", news: "tin tức" };

export function voiceOptionLabel(v: CatalogVoice): string {
  const bits = [
    v.gender ? (v.gender === "female" ? "Nữ" : "Nam") + (v.genderVerified ? "" : " (chưa xác minh)") : null,
    v.region ? REGION_LABEL[v.region] : null,
    v.style ? (STYLE_LABEL[v.style] ?? v.style) : null,
  ].filter(Boolean);
  return bits.length ? `${v.label} · ${bits.join(" · ")}` : v.label;
}

function mindModel(catalog: MindCatalog | null, locale: VoiceLocaleId): CatalogModel {
  const { family, accent } = voiceLocaleOf(locale);
  const engines = catalog?.health?.engines ?? [];
  const forLanguage = (Object.keys(MIND_ENGINES) as (keyof typeof MIND_ENGINES)[]).filter((e) => MIND_ENGINES[e].language === family);
  const installed = forLanguage.some((e) => engines.find((x) => x.id === e)?.installed);
  const voices: CatalogVoice[] = (catalog?.voices ?? [])
    // The engines say "en", never which English: no Mind Voice voice is a verified en-US / en-GB voice.
    .filter((v) => v.installed && v.languages.includes(family) && !accent)
    .map((v) => ({
      id: v.id,
      label: v.name,
      gender: v.gender,
      genderVerified: v.gender !== null,
      region: v.region,
      style: v.style,
      languageVerified: true,
      // The engine says "en", never which English.
      accentVerified: family !== "en",
      note: `${MIND_ENGINES[v.engine].label}${family === "en" ? " · giọng vùng chưa xác minh" : ""}`,
    }));
  let status: CatalogStatus;
  let statusMessage: string;
  if (!catalog) {
    status = "OFFLINE";
    statusMessage = `Chưa từng đọc được danh sách giọng. ${MIND_OFFLINE_GUIDE}`;
  } else if (catalog.health && !installed) {
    status = "NOT_INSTALLED";
    const names = forLanguage.map((e) => MIND_ENGINES[e].label).join(", ");
    statusMessage = `Chưa cài model ${names} cho ngôn ngữ này. Mở Mind Voice Studio → Quản lý model để cài (app không tự tải model lớn).`;
  } else if (accent) {
    status = catalog.online ? "ONLINE" : "OFFLINE";
    statusMessage = `Không có giọng Mind Voice nào được xác minh là giọng ${accent === "US" ? "Mỹ" : "Anh"}: Supertonic 3 chỉ ghi "English". Chọn ngôn ngữ "English — General" để dùng 10 giọng Supertonic.`;
  } else if (!catalog.online) {
    status = "OFFLINE";
    statusMessage = `Mind Voice đang Offline - danh sách giọng là của lần kiểm tra ${new Date(catalog.checkedAt).toLocaleString("vi-VN")}. Lưu được, nhưng nghe thử và tạo giọng cần Mind Voice chạy. ${MIND_OFFLINE_GUIDE}`;
  } else {
    status = "ONLINE";
    statusMessage = "Mind Voice đang chạy tại máy - $0 API.";
  }
  return {
    provider: MIND_PROVIDER,
    providerLabel: MIND_LABEL,
    model: MIND_MODEL,
    modelLabel: forLanguage.map((e) => MIND_ENGINES[e].label).join(" / ") + " — Local",
    local: true,
    pricePer1kChars: 0,
    status,
    statusMessage,
    selectable: voices.length > 0,
    speed: { min: MIND_MIN_SPEED, max: MIND_MAX_SPEED },
    supportsInstructions: false,
    emotion: "TAGS",
    voices,
  };
}

async function openaiModels(locale: VoiceLocaleId): Promise<CatalogModel[]> {
  const rows = await prisma.modelRegistry.findMany({ where: { provider: "openai", type: "voice" }, orderBy: { modelId: "asc" } });
  if (rows.length === 0) return [];
  const keyed = await hasApiKey("openai");
  const family = voiceLocaleOf(locale).family;
  return rows.map((m) => {
    const classic = /^tts-1/.test(m.modelId);
    const accent = voiceLocaleOf(locale).accent;
    // OpenAI states no accent per voice: none is a verified en-US / en-GB voice.
    const voices: CatalogVoice[] = (accent ? [] : OPENAI_VOICES.filter((v) => !classic || !["verse", "marin", "cedar"].includes(v.id))).map((v) => ({
      id: v.id,
      label: v.label.split(" - ")[0]!,
      // OpenAI publishes no gender per voice: this is how the voice is usually heard.
      gender: v.gender,
      genderVerified: false,
      region: null,
      style: null,
      // OpenAI's voices are made for English; Vietnamese has not been measured in this app.
      languageVerified: family === "en",
      accentVerified: false,
      note:
        family === "en"
          ? m.supportsVoiceInstructions
            ? "Giọng vùng chưa xác minh - có thể yêu cầu qua Hướng dẫn diễn"
            : "Giọng vùng chưa xác minh"
          : "Tiếng Việt chưa xác minh trong app (giọng tối ưu cho tiếng Anh)",
    }));
    let status: CatalogStatus = "ONLINE";
    let statusMessage = `API trả phí: ~$${m.price.toFixed(4)} / 1000 ký tự. Nghe thử và tạo giọng phải xác nhận chi phí trước.`;
    if (isMockMode()) {
      status = "MOCK";
      statusMessage = "Mock Mode: nghe thử là âm thanh giả lập, $0 - không gọi OpenAI.";
    } else if (!m.enabled) {
      status = "DISABLED";
      statusMessage = "Model đang tắt trong trang Mô hình AI.";
    } else if (!keyed) {
      status = "NO_KEY";
      statusMessage = "Chưa có API key OpenAI (trang Nhà cung cấp AI).";
    }
    return {
      provider: "openai",
      providerLabel: "OpenAI TTS — trả phí",
      model: m.modelId,
      modelLabel: m.displayName || m.modelId,
      local: false,
      pricePer1kChars: m.price,
      status,
      statusMessage,
      selectable: m.enabled || isMockMode(),
      speed: { min: MIN_SPEED, max: MAX_SPEED },
      supportsInstructions: m.supportsVoiceInstructions,
      emotion: m.supportsVoiceInstructions ? "INSTRUCTIONS" : "NONE",
      voices,
    };
  });
}

const MOCK_VOICES = [
  { id: "mock-male-us", label: "Mock nam (US)", gender: "male", accent: "US" },
  { id: "mock-female-us", label: "Mock nữ (US)", gender: "female", accent: "US" },
  { id: "mock-male-uk", label: "Mock nam (UK)", gender: "male", accent: "UK" },
  { id: "mock-female-uk", label: "Mock nữ (UK)", gender: "female", accent: "UK" },
] as const;

function mockModel(locale: VoiceLocaleId): CatalogModel {
  const accent = voiceLocaleOf(locale).accent;
  return {
    provider: "mock",
    providerLabel: "Giả lập (Mock Mode)",
    model: "mock-voice-std",
    modelLabel: "Mock voice — âm thanh giả",
    local: true,
    pricePer1kChars: 0,
    status: "MOCK",
    statusMessage: "Giọng giả lập để thử luồng - không phải giọng thật.",
    selectable: true,
    speed: { min: MIN_SPEED, max: MAX_SPEED },
    supportsInstructions: false,
    emotion: "NONE",
    voices: MOCK_VOICES.filter((v) => !accent || v.accent === accent).map((v) => ({
      id: v.id,
      label: v.label,
      gender: v.gender,
      genderVerified: true,
      region: null,
      style: null,
      languageVerified: false,
      accentVerified: false,
      note: "giả lập",
    })),
  };
}

/** The voices a character can be given in `locale`. `refresh` asks the local Mind Voice service again ($0). */
export async function voiceCatalogFor(locale: VoiceLocaleId, opts: { refresh?: boolean } = {}): Promise<VoiceCatalog> {
  const mind = opts.refresh ? await refreshMindCatalog() : await cachedMindCatalog();
  const models = [mindModel(mind, locale), ...(await openaiModels(locale))];
  if (isMockMode()) models.push(mockModel(locale));
  return { locale, checkedAt: mind?.checkedAt ?? null, models };
}

export type VoiceChoiceCheck =
  | { ok: true; model: CatalogModel; voice: CatalogVoice }
  | { ok: false; message: string };

/** Is this voice one that model really has, for this language? Never a network call. */
export function checkVoiceChoice(catalog: VoiceCatalog, provider: string, model: string, voiceId: string): VoiceChoiceCheck {
  const label = voiceLocaleOf(catalog.locale).label;
  const m = catalog.models.find((x) => x.provider === provider && x.model === model);
  if (!m) return { ok: false, message: `Nhà cung cấp / model "${provider}/${model}" không có cho ${label}.` };
  if (!m.selectable) return { ok: false, message: `${m.providerLabel}: ${m.statusMessage}` };
  const v = m.voices.find((x) => x.id === voiceId);
  if (!v) return { ok: false, message: `Model ${m.modelLabel} không có giọng "${voiceId}" cho ${label}. Hãy chọn giọng trong danh sách.` };
  return { ok: true, model: m, voice: v };
}

// ------------------------------------------------------- saved voices ---

/**
 * Why a saved voice does not fit what is installed now, or null when it does.
 * Read from the KEPT Mind Voice list (no network), so an offline Mind Voice
 * never makes a good voice look stale. A list never read says nothing.
 */
export function savedVoiceProblem(profile: Pick<VoiceProfile, "provider" | "model" | "voiceId">, mind: MindCatalog | null, locale: VoiceLocaleId | null): string | null {
  if (profile.provider === MIND_PROVIDER) {
    if (profile.model !== MIND_MODEL) return `Mind Voice không có model "${profile.model}".`;
    if (profile.voiceId === MIND_AUTO_VOICE || !mind?.voices.length) return null;
    const v = mind.voices.find((x) => x.id === profile.voiceId);
    if (!v) return `Mind Voice không có giọng "${profile.voiceId}".`;
    if (locale && !v.languages.includes(voiceLocaleOf(locale).family)) return `Giọng "${v.id}" của Mind Voice không nói ${voiceLocaleOf(locale).label}.`;
    return null;
  }
  if (profile.provider === "openai") {
    return OPENAI_VOICES.some((v) => v.id === profile.voiceId) ? null : `OpenAI không có giọng "${profile.voiceId}".`;
  }
  // The mock voice speaks any id; CIT (legacy) decides at generation time, as before.
  if (profile.provider === "mock" || profile.provider === "cit") return null;
  return `Nhà cung cấp giọng "${profile.provider}" chưa được tích hợp.`;
}

export interface CharacterVoiceIssue {
  locale: VoiceLocaleId | null;
  detail: string;
}

/** Every saved voice of a character that no longer fits. Read-only, $0. */
export async function characterVoiceIssues(row: CharacterVoiceRow, mind?: MindCatalog | null): Promise<CharacterVoiceIssue[]> {
  const catalog = mind === undefined ? await cachedMindCatalog() : mind;
  const located = characterProfiles(row);
  const list = located.length ? located : [{ locale: null, profile: primaryProfile(row), primary: true }];
  const out: CharacterVoiceIssue[] = [];
  const models = await prisma.modelRegistry.findMany({ where: { type: "voice" }, select: { provider: true, modelId: true } });
  for (const { locale, profile } of list) {
    const known = profile.provider === MIND_PROVIDER || profile.provider === "mock" || models.some((m) => m.provider === profile.provider && m.modelId === profile.model);
    const problem = known ? savedVoiceProblem(profile, catalog, locale) : `Không có model ${profile.provider}/${profile.model} trong bảng Mô hình AI.`;
    if (problem) out.push({ locale, detail: problem });
  }
  return out;
}

