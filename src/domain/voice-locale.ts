/**
 * CHARACTER VOICE LANGUAGES (QĐ-158). Pure: no database, no provider.
 *
 * A character's voice is chosen PER LANGUAGE. Its main voice stays in the old
 * columns (voiceProvider / voiceModel / voiceId ...) with `voiceLanguage`
 * naming the language it speaks; voices for its other languages live in
 * `voiceProfilesJson`. A voice is never assumed to speak every language.
 *
 * A character saved before QĐ-158 has no language ("") and behaves exactly as
 * before: the line's language comes from the project and the text.
 */

import { speechLanguageOf, type SpeechLanguage } from "./speech-text";

/**
 * "en" is English without a stated accent: what an engine that only says
 * "English" (Supertonic) really offers. en-US / en-GB list only voices whose
 * accent a source states - never one guessed from a name or a gender.
 */
export type VoiceLocaleId = "vi-VN" | "en" | "en-US" | "en-GB";

export interface VoiceLocale {
  id: VoiceLocaleId;
  /** The language a TTS engine is told (and the speech-text rules use). */
  family: SpeechLanguage;
  label: string;
  /** Accent sent to a provider that takes one. Null = not an English accent. */
  accent: "US" | "UK" | null;
  /** The preview line: words only - never a speaker label. */
  sample: string;
}

export const VOICE_LOCALES: readonly VoiceLocale[] = [
  { id: "vi-VN", family: "vi", label: "Tiếng Việt (vi-VN)", accent: null, sample: "Xin chào, rất vui được gặp bạn tại cửa hàng của chúng tôi." },
  { id: "en", family: "en", label: "English — General (giọng vùng chưa xác minh)", accent: null, sample: "Hello! Welcome to our store. Let me show you today's products." },
  { id: "en-US", family: "en", label: "English — United States (en-US, chỉ giọng đã xác minh)", accent: "US", sample: "Hello! Welcome to our store. Let me show you today's products." },
  { id: "en-GB", family: "en", label: "English — United Kingdom (en-GB, chỉ giọng đã xác minh)", accent: "UK", sample: "Good morning! Welcome to our shop. How may I help you today?" },
];

export const isVoiceLocale = (v: unknown): v is VoiceLocaleId => VOICE_LOCALES.some((l) => l.id === v);

export function voiceLocaleOf(id: VoiceLocaleId): VoiceLocale {
  return VOICE_LOCALES.find((l) => l.id === id)!;
}

/** Who speaks a character in one language. */
export interface VoiceProfile {
  provider: string;
  model: string;
  voiceId: string;
  speed: number;
  instructions: string;
  gender: "male" | "female";
}

export type VoiceProfiles = Partial<Record<VoiceLocaleId, VoiceProfile>>;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The extra-language voices of a character. A broken value is no extra voices, never an error. */
export function parseVoiceProfiles(json: string | null | undefined): VoiceProfiles {
  let raw: unknown = null;
  try {
    raw = JSON.parse(json || "{}");
  } catch {
    return {};
  }
  const out: VoiceProfiles = {};
  for (const [locale, value] of Object.entries(rec(raw))) {
    if (!isVoiceLocale(locale)) continue;
    const p = rec(value);
    const provider = typeof p.provider === "string" ? p.provider.trim() : "";
    const model = typeof p.model === "string" ? p.model.trim() : "";
    const voiceId = typeof p.voiceId === "string" ? p.voiceId.trim() : "";
    if (!provider || !model || !voiceId) continue;
    out[locale] = {
      provider,
      model,
      voiceId,
      speed: typeof p.speed === "number" && Number.isFinite(p.speed) && p.speed > 0 ? p.speed : 1,
      instructions: typeof p.instructions === "string" ? p.instructions : "",
      gender: p.gender === "female" ? "female" : "male",
    };
  }
  return out;
}

/** The voice columns of a Character row. */
export interface CharacterVoiceRow {
  voiceProvider: string;
  voiceModel: string;
  voiceId: string;
  voiceSpeed: number;
  voiceInstructions: string;
  voiceGender: string;
  voiceAccent: string;
  voiceLanguage?: string | null;
  voiceProfilesJson?: string | null;
}

export interface LocatedProfile {
  locale: VoiceLocaleId;
  profile: VoiceProfile;
  primary: boolean;
}

export function primaryProfile(row: CharacterVoiceRow): VoiceProfile {
  return {
    provider: row.voiceProvider,
    model: row.voiceModel,
    voiceId: row.voiceId,
    speed: row.voiceSpeed,
    instructions: row.voiceInstructions,
    gender: row.voiceGender === "female" ? "female" : "male",
  };
}

/** Every voice a character has, main language first. Empty = chosen before QĐ-158 (no language). */
export function characterProfiles(row: CharacterVoiceRow): LocatedProfile[] {
  const main = isVoiceLocale(row.voiceLanguage) ? row.voiceLanguage : null;
  if (!main) return [];
  const out: LocatedProfile[] = [{ locale: main, profile: primaryProfile(row), primary: true }];
  const extra = parseVoiceProfiles(row.voiceProfilesJson);
  for (const l of VOICE_LOCALES) {
    const p = extra[l.id];
    if (p && l.id !== main) out.push({ locale: l.id, profile: p, primary: false });
  }
  return out;
}

/**
 * The language one line of this character is spoken in, or null for a
 * character without a language (then the old rule applies unchanged).
 *
 *   one language    -> that language, whatever the project's language is: an
 *                      American customer in a Vietnamese video speaks English
 *   several         -> the line's own words decide (Vietnamese diacritics = vi)
 */
export function characterLineLanguage(row: CharacterVoiceRow, text: string): SpeechLanguage | null {
  const families = [...new Set(characterProfiles(row).map((p) => voiceLocaleOf(p.locale).family))];
  if (families.length === 0) return null;
  if (families.length === 1) return families[0]!;
  const byText = speechLanguageOf("auto", text);
  return families.includes(byText) ? byText : families[0]!;
}

/** The voice for a line in `language`: the main voice when it speaks it, else the first other one that does. */
export function profileForLanguage(row: CharacterVoiceRow, language: SpeechLanguage): LocatedProfile | null {
  const all = characterProfiles(row);
  return all.find((p) => voiceLocaleOf(p.locale).family === language) ?? null;
}

/**
 * Save `profile` for `locale`. The main voice moves only when asked (or when
 * the character has none yet); the voice of another language is never touched.
 */
export function withProfile(
  row: CharacterVoiceRow,
  locale: VoiceLocaleId,
  profile: VoiceProfile,
  makeMain: boolean,
): {
  voiceLanguage: VoiceLocaleId;
  voiceProvider: string;
  voiceModel: string;
  voiceId: string;
  voiceSpeed: number;
  voiceInstructions: string;
  voiceGender: string;
  voiceAccent: string;
  voiceProfilesJson: string;
} {
  const main = isVoiceLocale(row.voiceLanguage) ? row.voiceLanguage : null;
  const extra = parseVoiceProfiles(row.voiceProfilesJson);
  let mainLocale: VoiceLocaleId;
  let mainProfile: VoiceProfile;
  let accent = row.voiceAccent === "UK" ? "UK" : "US";
  if (!main || main === locale || makeMain) {
    // The old main voice (when it had a language and is another one) is kept as that language's voice.
    if (main && main !== locale) extra[main] = primaryProfile(row);
    delete extra[locale];
    mainLocale = locale;
    mainProfile = profile;
    accent = voiceLocaleOf(locale).accent ?? accent;
  } else {
    extra[locale] = profile;
    mainLocale = main;
    mainProfile = primaryProfile(row);
  }
  return {
    voiceLanguage: mainLocale,
    voiceProvider: mainProfile.provider,
    voiceModel: mainProfile.model,
    voiceId: mainProfile.voiceId,
    voiceSpeed: mainProfile.speed,
    voiceInstructions: mainProfile.instructions,
    voiceGender: mainProfile.gender,
    voiceAccent: accent,
    voiceProfilesJson: JSON.stringify(extra),
  };
}

/** Remove a NON-main language voice. The main voice is changed, not removed. */
export function withoutProfile(row: CharacterVoiceRow, locale: VoiceLocaleId): { voiceProfilesJson: string } | null {
  if (row.voiceLanguage === locale) return null;
  const extra = parseVoiceProfiles(row.voiceProfilesJson);
  delete extra[locale];
  return { voiceProfilesJson: JSON.stringify(extra) };
}

/** The exact warning for a saved voice that no longer fits (QĐ-158 part H). */
export const VOICE_PROFILE_STALE =
  "Giọng đã lưu không còn phù hợp với nhà cung cấp hiện tại. Vui lòng chọn lại giọng.";
