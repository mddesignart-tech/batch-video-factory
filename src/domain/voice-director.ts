/**
 * VOICE DIRECTOR (QĐ-142) - turns "read this text" into "say this line, in this
 * scene, for this kind of video".
 *
 * Before it, every narrated line of every project went out with one fixed
 * direction ("Warm, clear narrator...") at speed 1: a comedy Short and a
 * documentary sounded the same, and a hook sounded like a recap.
 *
 * Two layers, never mixed up:
 *
 *   VOICE IDENTITY - who speaks: the OpenAI voice and its base direction
 *   (a Voice Preset, or a character's own voice). The same for every scene a
 *   speaker has in one video. Never changed per scene.
 *
 *   SCENE DIRECTION - how this line is said: the video's style (from the
 *   Creative Style), the scene's role (hook, explanation, punchline, CTA...),
 *   its emotion and its pace. Changes from scene to scene.
 *
 * Everything here is deterministic: the same project, scene and line always
 * give the same instructions and speed, which is what lets a preview's audio be
 * reused by the run and by every render after it. Pure: no database, no provider.
 */

import { z } from "zod";
import type { EffectiveCreativeStyle } from "./creative-style";
import { wantsPunchline } from "./creative-style";
import { DIALOGUE_EMOTION_IDS } from "./dialogue-director";
import type { SpeechLanguage } from "./speech-text";

export const VOICE_DIRECTOR_VERSION = "voice-director-v1";

// ----------------------------------------------------------------- voices ---

/**
 * The 13 built-in voices of gpt-4o-mini-tts. `timbre` is how the voice is
 * usually HEARD, for grouping in the UI only - nothing branches on a gender.
 * Marin and Cedar are OpenAI's newest, most natural voices.
 */
export const VOICE_CATALOG = [
  { id: "marin", label: "Marin", timbre: "female", note: "tự nhiên, ấm - mới, khuyên dùng" },
  { id: "cedar", label: "Cedar", timbre: "male", note: "tự nhiên, chắc - mới, khuyên dùng" },
  { id: "coral", label: "Coral", timbre: "female", note: "sáng, vui" },
  { id: "nova", label: "Nova", timbre: "female", note: "trẻ trung" },
  { id: "sage", label: "Sage", timbre: "female", note: "điềm tĩnh, rõ" },
  { id: "shimmer", label: "Shimmer", timbre: "female", note: "nhẹ, dịu" },
  { id: "verse", label: "Verse", timbre: "male", note: "biểu cảm, linh hoạt" },
  { id: "ash", label: "Ash", timbre: "male", note: "chắc, năng động" },
  { id: "ballad", label: "Ballad", timbre: "male", note: "trầm ấm, mềm" },
  { id: "echo", label: "Echo", timbre: "male", note: "rõ, gọn" },
  { id: "onyx", label: "Onyx", timbre: "male", note: "trầm, nặng" },
  { id: "fable", label: "Fable", timbre: "neutral", note: "kể chuyện, giọng Anh" },
  { id: "alloy", label: "Alloy", timbre: "neutral", note: "trung tính" },
] as const;
export type VoiceTimbre = "male" | "female" | "neutral";

// ---------------------------------------------------------------- presets ---

export interface VoicePreset {
  id: string;
  label: string;
  /** UI group. A heard timbre, not a rule. */
  group: "NAM" | "NỮ";
  voiceId: string;
  /** The identity: who this narrator is, in every scene. */
  base: string;
  defaultSpeed: number;
  /** 1 (very calm) .. 5 (very lively). */
  energy: number;
  emotionalRange: "low" | "medium" | "high";
}

export const VOICE_PRESETS: readonly VoicePreset[] = [
  { id: "MALE_WARM", label: "Nam Ấm Áp", group: "NAM", voiceId: "cedar", base: "A warm, friendly male narrator in his thirties. Relaxed and sincere, like talking to a friend.", defaultSpeed: 1, energy: 3, emotionalRange: "medium" },
  { id: "MALE_DOCUMENTARY", label: "Nam Trầm / Documentary", group: "NAM", voiceId: "onyx", base: "A deep, grounded male documentary narrator. Calm authority, every word placed with weight.", defaultSpeed: 0.95, energy: 2, emotionalRange: "low" },
  { id: "MALE_ENERGETIC", label: "Nam Năng Động", group: "NAM", voiceId: "ash", base: "An upbeat young male host. Bright, quick and positive, with a natural smile in the voice.", defaultSpeed: 1.05, energy: 4, emotionalRange: "high" },
  { id: "MALE_FUNNY", label: "Nam Hài Hước", group: "NAM", voiceId: "verse", base: "A playful male storyteller with good comic timing. Cheeky and warm, never mean, never shouting.", defaultSpeed: 1.03, energy: 4, emotionalRange: "high" },
  { id: "MALE_TECH", label: "Nam Review Công Nghệ", group: "NAM", voiceId: "echo", base: "A clear, confident male tech reviewer. A friendly expert who explains things simply.", defaultSpeed: 1.02, energy: 3, emotionalRange: "medium" },
  { id: "MALE_STORY", label: "Nam Kể Chuyện", group: "NAM", voiceId: "ballad", base: "An expressive male storyteller. Soft warmth, varies his pace and colour with the story.", defaultSpeed: 0.98, energy: 3, emotionalRange: "high" },
  { id: "FEMALE_NATURAL", label: "Nữ Tự Nhiên", group: "NỮ", voiceId: "marin", base: "A natural, warm female narrator. Conversational and clear, like a friend sharing something useful.", defaultSpeed: 1, energy: 3, emotionalRange: "medium" },
  { id: "FEMALE_YOUNG", label: "Nữ Trẻ Trung", group: "NỮ", voiceId: "nova", base: "A bright, youthful female voice. Light, cheerful and quick, with genuine curiosity.", defaultSpeed: 1.04, energy: 4, emotionalRange: "high" },
  { id: "FEMALE_ENERGETIC", label: "Nữ Năng Động", group: "NỮ", voiceId: "coral", base: "An energetic, cheerful female host. Lively and engaging without being loud.", defaultSpeed: 1.05, energy: 4, emotionalRange: "high" },
  { id: "FEMALE_GENTLE", label: "Nữ Dịu Dàng", group: "NỮ", voiceId: "shimmer", base: "A soft, gentle female voice. Soothing and kind, unhurried.", defaultSpeed: 0.96, energy: 2, emotionalRange: "medium" },
  { id: "FEMALE_REVIEW", label: "Nữ Review", group: "NỮ", voiceId: "sage", base: "A clear, trustworthy female reviewer. Honest, friendly and to the point.", defaultSpeed: 1.02, energy: 3, emotionalRange: "medium" },
  { id: "FEMALE_STORY", label: "Nữ Kể Chuyện", group: "NỮ", voiceId: "marin", base: "An expressive female storyteller. Warm, draws the listener in, lets moments breathe.", defaultSpeed: 0.98, energy: 3, emotionalRange: "high" },
];

export function voicePresetOf(id: string | null | undefined): VoicePreset | null {
  return VOICE_PRESETS.find((p) => p.id === id) ?? null;
}

// ----------------------------------------------------------------- styles ---

/** How a kind of video is spoken. Chosen from the Creative Style + content type. */
export const VOICE_STYLES = {
  COMEDY: { label: "Hài TikTok", direction: "Lively and playful with clear comic timing. Slightly quicker than normal, expressive but never shouting.", speed: 1.05 },
  PROFESSIONAL: { label: "Chuyên nghiệp", direction: "Clear, natural and composed. Measured pace, little exaggeration, confident without sounding like an announcement.", speed: 1 },
  DOCUMENTARY: { label: "Documentary", direction: "Low, calm and weighty. Slightly slow, lean on the key words, let facts land.", speed: 0.95 },
  PRODUCT_REVIEW: { label: "Review sản phẩm", direction: "Friendly and naturally persuasive, like recommending something to a friend. Never a hard-sell TV advert.", speed: 1.02 },
  STORYTELLING: { label: "Kể chuyện", direction: "Vary the pace and colour with the story. Follow each scene's feeling, with natural pauses between moments.", speed: 0.98 },
  CUTE: { label: "Dễ thương", direction: "Cheerful, light and expressive, with a smile in the voice. Gentle and family-friendly.", speed: 1.02 },
  ENERGETIC: { label: "Năng động", direction: "Upbeat and energetic, quick but always clear.", speed: 1.05 },
  EDUCATIONAL: { label: "Giáo dục", direction: "Clear and friendly, like a good teacher. Steady pace, stress the word being taught.", speed: 1 },
  DRAMATIC: { label: "Kịch tính", direction: "Controlled tension. Lower and slower before a reveal, then let it land.", speed: 0.98 },
  NATURAL: { label: "Tự nhiên", direction: "Natural and conversational, like talking to one person.", speed: 1 },
} as const;
export type VoiceStyleId = keyof typeof VOICE_STYLES;

const PRODUCT_TYPES = new Set(["PRODUCT_REVIEW", "AI_REVIEW", "ADVERTISEMENT"]);
const STORY_TYPES = new Set(["STORY", "ENGLISH_MINI_STORY", "TOY_WORLD"]);

/** The voice style a project's Creative Style and content type call for. */
export function voiceStyleFor(style: Pick<EffectiveCreativeStyle, "preset" | "tone" | "comedyLevel" | "emotionStyle">, contentType: string | null): VoiceStyleId {
  if (style.preset === "TIKTOK_FUNNY" || style.preset === "VIRAL_FAST" || style.comedyLevel >= 3) return "COMEDY";
  if (style.preset === "DOCUMENTARY" || style.tone === "DOCUMENTARY") return "DOCUMENTARY";
  if (style.preset === "PROFESSIONAL" || style.preset === "PREMIUM" || style.tone === "PROFESSIONAL" || style.tone === "PREMIUM") return "PROFESSIONAL";
  if (contentType && PRODUCT_TYPES.has(contentType)) return "PRODUCT_REVIEW";
  if (style.preset === "CUTE" || style.tone === "PLAYFUL" || contentType === "ANIMAL_FACT") return "CUTE";
  if (style.preset === "EMOTIONAL" || (contentType && STORY_TYPES.has(contentType))) return "STORYTELLING";
  if (style.preset === "DRAMATIC" || style.preset === "MYSTERY" || style.tone === "DRAMATIC" || style.tone === "MYSTERIOUS") return "DRAMATIC";
  if (style.preset === "ENERGETIC" || style.tone === "ENERGETIC") return "ENERGETIC";
  if (style.preset === "EDUCATIONAL" || style.tone === "EDUCATIONAL" || (contentType ?? "").startsWith("ENGLISH_") || contentType === "KNOWLEDGE") return "EDUCATIONAL";
  return "NATURAL";
}

/** AUTO preset: the style's natural narrator, keeping the narrator's heard timbre. */
const AUTO_PRESET: Record<VoiceStyleId, { male: string; female: string }> = {
  COMEDY: { male: "MALE_FUNNY", female: "FEMALE_ENERGETIC" },
  PROFESSIONAL: { male: "MALE_WARM", female: "FEMALE_NATURAL" },
  DOCUMENTARY: { male: "MALE_DOCUMENTARY", female: "FEMALE_NATURAL" },
  PRODUCT_REVIEW: { male: "MALE_TECH", female: "FEMALE_REVIEW" },
  STORYTELLING: { male: "MALE_STORY", female: "FEMALE_STORY" },
  CUTE: { male: "MALE_ENERGETIC", female: "FEMALE_YOUNG" },
  ENERGETIC: { male: "MALE_ENERGETIC", female: "FEMALE_ENERGETIC" },
  EDUCATIONAL: { male: "MALE_WARM", female: "FEMALE_NATURAL" },
  DRAMATIC: { male: "MALE_DOCUMENTARY", female: "FEMALE_STORY" },
  NATURAL: { male: "MALE_WARM", female: "FEMALE_NATURAL" },
};

export function autoPresetFor(style: VoiceStyleId, timbre: VoiceTimbre): VoicePreset {
  return voicePresetOf(AUTO_PRESET[style][timbre === "male" ? "male" : "female"])!;
}

// --------------------------------------------------------------- emotions ---

export const VOICE_EMOTIONS = [
  { id: "AUTO", label: "Tự động", direction: "" },
  { id: "NEUTRAL", label: "Bình thường", direction: "Even and natural, no particular colour." },
  { id: "JOYFUL", label: "Vui", direction: "Happy and light, a smile in the voice." },
  { id: "EXCITED", label: "Hào hứng", direction: "Excited and enthusiastic, but controlled." },
  { id: "WARM", label: "Ấm áp", direction: "Warm and kind, close to the listener." },
  { id: "SERIOUS", label: "Nghiêm túc", direction: "Serious and focused, no jokiness." },
  { id: "MYSTERIOUS", label: "Bí ẩn", direction: "Hushed and intriguing, a little slower, building curiosity." },
  { id: "TOUCHING", label: "Cảm động", direction: "Tender and moved, softer and slower, sincere." },
  { id: "HUMOROUS", label: "Hài hước", direction: "Amused and playful, with comic timing." },
  { id: "DRAMATIC", label: "Kịch tính", direction: "Tense and dramatic, controlled, building to the key line." },
] as const;
export type VoiceEmotionId = (typeof VOICE_EMOTIONS)[number]["id"];
const EMOTION_IDS = VOICE_EMOTIONS.map((e) => e.id) as [VoiceEmotionId, ...VoiceEmotionId[]];

/** AUTO emotion follows the Creative Style's emotion. */
const FROM_CREATIVE: Record<string, VoiceEmotionId> = {
  JOYFUL: "JOYFUL",
  CURIOUS: "NEUTRAL",
  EXCITED: "EXCITED",
  WARM: "WARM",
  TOUCHING: "TOUCHING",
  SUSPENSE: "MYSTERIOUS",
  SURPRISE: "HUMOROUS",
  CALM: "NEUTRAL",
  TRUST: "NEUTRAL",
};

const EMOTION_SPEED: Partial<Record<VoiceEmotionId, number>> = { TOUCHING: 0.94, MYSTERIOUS: 0.96, SERIOUS: 0.98, EXCITED: 1.03 };

// ------------------------------------------------------------ scene roles ---

export type SceneVoiceRole = "HOOK" | "EXPLAIN" | "BUILD" | "PUNCHLINE" | "EMOTIONAL" | "CLOSING" | "CTA";

const ROLE_GROUPS: [SceneVoiceRole, readonly string[]][] = [
  ["HOOK", ["hook", "question", "intro"]],
  ["CTA", ["cta", "contact", "offer"]],
  ["CLOSING", ["recap", "ending", "conclusion", "closing", "verdict", "lesson"]],
  ["PUNCHLINE", ["punchline", "twist", "reveal", "result", "cliffhanger", "payoff"]],
  ["EMOTIONAL", ["moment", "climax", "struggle", "emotional", "journey"]],
  ["BUILD", ["escalation", "challenge", "problem", "mistake", "literal", "setup", "clue", "reaction"]],
];

/** The scene's spoken role; a scene without a stored role is judged by position. */
export function sceneVoiceRole(sceneRole: string | null | undefined, index: number, count: number): SceneVoiceRole {
  const role = (sceneRole ?? "").toLowerCase();
  for (const [group, roles] of ROLE_GROUPS) if (roles.includes(role)) return group;
  if (!role) {
    if (index === 0 && count > 1) return "HOOK";
    if (index === count - 1 && count > 2) return "CLOSING";
  }
  return "EXPLAIN";
}

const ROLE_DIRECTION: Record<SceneVoiceRole, { label: string; direction: string; speed: number }> = {
  HOOK: { label: "mở đầu", direction: "This is the opening hook: curious and inviting, a touch quicker, make the listener want the next line.", speed: 1.03 },
  EXPLAIN: { label: "giải thích", direction: "Explain clearly and steadily, stress the key word of each sentence.", speed: 1 },
  BUILD: { label: "dẫn dắt", direction: "Build the situation up, a little more energy with each sentence.", speed: 1.02 },
  PUNCHLINE: { label: "punchline", direction: "This line carries the payoff: take a short natural pause just before the final phrase, then land it cleanly. Do not explain the joke.", speed: 0.98 },
  EMOTIONAL: { label: "cảm xúc", direction: "An emotional moment: slower, softer, let it breathe.", speed: 0.95 },
  CLOSING: { label: "kết", direction: "Wrap up warmly and clearly, a satisfying close.", speed: 0.99 },
  CTA: { label: "kêu gọi", direction: "A short, natural call to action, positive and friendly, never pushy.", speed: 1 },
};

export const SCENE_ROLE_LABELS: Record<SceneVoiceRole, string> = Object.fromEntries(
  Object.entries(ROLE_DIRECTION).map(([k, v]) => [k, v.label]),
) as Record<SceneVoiceRole, string>;

// ------------------------------------------------------------------ speed ---

export const SPEED_MODES = [
  { id: "AUTO", label: "Tự động", factor: 1 },
  { id: "SLOW", label: "Chậm", factor: 0.92 },
  { id: "MEDIUM", label: "Vừa", factor: 1 },
  { id: "FAST", label: "Nhanh", factor: 1.08 },
] as const;
export type SpeedModeId = (typeof SPEED_MODES)[number]["id"];

/** Faster than this and gpt-4o-mini-tts starts to sound like a machine. */
export const NATURAL_MAX_SPEED = 1.15;
export const NATURAL_MIN_SPEED = 0.88;

const PACING_SPEED: Record<string, number> = { SLOW: 0.95, MEDIUM: 1, FAST: 1.04, VERY_FAST: 1.07 };

/** Speeds are kept on a 0.05 grid so a small timing change does not make new audio. */
function onGrid(speed: number): number {
  return Math.round(speed * 20) / 20;
}

// ---------------------------------------------------------- stored config ---

/** The Voice Director part of a project's voice settings (in outputControlsJson.voice). */
export const VoiceDirectionSchema = z.object({
  /** Off for every project made before QĐ-142, so its existing audio stays valid. */
  director: z.boolean().default(false),
  /** A VOICE_PRESETS id, or AUTO (chosen from the style). */
  preset: z.string().max(40).default("AUTO"),
  emotion: z.enum(EMOTION_IDS).default("AUTO"),
  speedMode: z.enum(SPEED_MODES.map((s) => s.id) as [SpeedModeId, ...SpeedModeId[]]).default("AUTO"),
  /** Per-scene emotion, by scene id. A scene left out follows the project. */
  sceneEmotions: z.record(z.string(), z.enum(EMOTION_IDS)).default({}),
  /**
   * QĐ-146: emotion cues ([cười], <laugh>...) for a local engine (Mind Voice).
   * On by default; only cues the engine reliably performs are ever sent.
   */
  emotionCues: z.boolean().default(true),
  /**
   * QĐ-147: the Dialogue Voice Director - each character's own emotion in a
   * Mind Voice dialogue (dialogue-director.ts). Off by default, so a project
   * without it sends exactly what it sent before; independent of `director`.
   */
  dialogueDirector: z.boolean().default(false),
  /** Scene id (or "*" = every scene) → speaker name → emotion. A speaker left out is AUTO. */
  speakerEmotions: z.record(z.string(), z.record(z.string(), z.enum(DIALOGUE_EMOTION_IDS))).default({}),
});
export type VoiceDirection = z.infer<typeof VoiceDirectionSchema>;

// --------------------------------------------------------------- director ---

export interface VoiceIdentity {
  voiceId: string;
  /** The speaker's base direction: a preset's, or a character's own. */
  base: string;
  /** Speed a person set (character or exact speed). Null = the director decides. */
  speed: number | null;
  presetSpeed: number;
  presetLabel: string | null;
}

export interface DirectInput {
  identity: VoiceIdentity;
  style: Pick<EffectiveCreativeStyle, "preset" | "tone" | "comedyLevel" | "emotionStyle" | "pacingStyle" | "punchlineMode">;
  contentType: string | null;
  sceneRole: string | null;
  sceneIndex: number;
  sceneCount: number;
  /** The scene's planned length, seconds. */
  sceneDuration: number;
  /** Characters of THIS speaker's speech in the scene (for the fit check). */
  sceneSpeechChars: number;
  language: SpeechLanguage;
  emotion: VoiceEmotionId;
  speedMode: SpeedModeId;
  /** Free text from Nâng cao, appended last. */
  custom: string | null;
  /** True for a narrator (one voice for the whole video); false for a character. */
  narrator: boolean;
  /** Comfortable characters per second at speed 1, from the language. */
  charsPerSecond: number;
}

export interface DirectedVoice {
  instructions: string;
  speed: number;
  styleId: VoiceStyleId;
  role: SceneVoiceRole;
  emotion: VoiceEmotionId;
  /** Shown before anything is bought. */
  warnings: string[];
}

const LANGUAGE_DIRECTION: Record<SpeechLanguage, string> = {
  vi: "Speak natural, fluent Vietnamese with correct tones, like a native speaker. Say English words, brand and model names the way English speakers say them, without changing voice.",
  en: "Speak natural, fluent English.",
};

const AVOID = "Avoid: robotic monotone, reading-aloud cadence, shouting, over-acting, long artificial pauses.";

export function directVoice(input: DirectInput): DirectedVoice {
  const styleId = voiceStyleFor(input.style, input.contentType);
  const style = VOICE_STYLES[styleId];
  const role = sceneVoiceRole(input.sceneRole, input.sceneIndex, input.sceneCount);
  const roleDir = ROLE_DIRECTION[role];
  const emotion: VoiceEmotionId = input.emotion !== "AUTO" ? input.emotion : (FROM_CREATIVE[input.style.emotionStyle] ?? "NEUTRAL");
  const emotionDir = VOICE_EMOTIONS.find((e) => e.id === emotion)!.direction;
  const punchline = role === "PUNCHLINE" && !wantsPunchline(input.style) ? null : roleDir.direction;
  const comedy =
    input.style.comedyLevel >= 3
      ? "Comic timing matters: a beat before the funny word, then move on."
      : input.style.comedyLevel === 0
        ? "No jokey tone."
        : "";

  const instructions = [
    `Voice identity: ${input.identity.base}${input.narrator ? " Keep exactly this voice and character in every scene of the video." : ""}`,
    `Language: ${LANGUAGE_DIRECTION[input.language]}`,
    `Style: ${style.direction}`,
    punchline ? `Scene: ${punchline}` : `Scene: ${ROLE_DIRECTION.EXPLAIN.direction}`,
    emotionDir ? `Emotion: ${emotionDir}` : "",
    comedy,
    AVOID,
    input.custom?.trim() ? `Extra direction: ${input.custom.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const warnings: string[] = [];
  let speed: number;
  if (input.identity.speed !== null) {
    speed = input.identity.speed;
  } else if (input.speedMode !== "AUTO") {
    speed = onGrid(input.identity.presetSpeed * SPEED_MODES.find((s) => s.id === input.speedMode)!.factor);
  } else {
    // A preset already carries its pace; a character's own voice takes the style's.
    const base = input.identity.presetLabel ? input.identity.presetSpeed : style.speed;
    speed = base * (PACING_SPEED[input.style.pacingStyle] ?? 1) * roleDir.speed * (EMOTION_SPEED[emotion] ?? 1);
    const fit = fitSpeed(input.sceneSpeechChars, input.sceneDuration, input.charsPerSecond);
    if (fit !== null && fit > speed) speed = Math.min(NATURAL_MAX_SPEED, fit);
    speed = onGrid(clamp(speed, NATURAL_MIN_SPEED, NATURAL_MAX_SPEED));
  }

  const spokenSeconds = speechSeconds(input.sceneSpeechChars, input.charsPerSecond, speed);
  if (input.sceneDuration > 0 && spokenSeconds > input.sceneDuration * 1.15) {
    warnings.push(
      `NARRATION_TOO_LONG: lời đọc ~${spokenSeconds.toFixed(1)} s ở tốc độ ${speed.toFixed(2)}x, cảnh đặt ${input.sceneDuration.toFixed(1)} s. ` +
        `Giọng không bị ép nhanh hơn ${NATURAL_MAX_SPEED}x để khỏi thành giọng máy - cảnh sẽ dài theo lời đọc, hoặc rút gọn lời đọc.`,
    );
  }
  return { instructions, speed, styleId, role, emotion, warnings };
}

/** Speed at which this much text fits the scene; null when no scene length is known. */
export function fitSpeed(chars: number, sceneDuration: number, charsPerSecond: number): number | null {
  if (sceneDuration <= 0 || chars <= 0) return null;
  return chars / (charsPerSecond * sceneDuration);
}

export function speechSeconds(chars: number, charsPerSecond: number, speed: number): number {
  return chars / (charsPerSecond * Math.max(0.25, speed));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
