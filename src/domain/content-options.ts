/**
 * Multi-content engine: the choices a person makes about WHO the video is for
 * and HOW it sounds - language, audience, tone, voice mode, duration, source.
 * Pure: no database, no provider.
 *
 * Language is kept apart from the content type on purpose. An English idiom
 * video can be explained in Vietnamese, a product review can be in English, and
 * adding 中文 / 日本語 / 한국어 later is one entry in LANGUAGES - nothing in the
 * pipeline names a language.
 */

// ------------------------------------------------------------- language ---

export interface LanguageOption {
  code: string;
  label: string;
  /** Spoken language for TTS ("vi-VN"). Null = decided per line (bilingual / auto). */
  ttsLocale: string | null;
  /** Shown in the simple creation form. A future language can ship hidden first. */
  enabled: boolean;
  /** Written into the script prompt so the writer uses the right language. */
  promptName: string;
  /** Characters per second a narrator reads comfortably; drives scene length. */
  charsPerSecond: number;
  /** Ends a subtitle sentence ("." / "。"). */
  sentenceEnd: string;
}

export const LANGUAGES: readonly LanguageOption[] = [
  { code: "vi", label: "Tiếng Việt", ttsLocale: "vi-VN", enabled: true, promptName: "Vietnamese", charsPerSecond: 15, sentenceEnd: "." },
  { code: "en", label: "English", ttsLocale: "en-US", enabled: true, promptName: "English", charsPerSecond: 15, sentenceEnd: "." },
  { code: "vi-en", label: "Việt + Anh", ttsLocale: null, enabled: true, promptName: "Vietnamese and English (bilingual)", charsPerSecond: 13, sentenceEnd: "." },
  { code: "auto", label: "Tự động theo nội dung", ttsLocale: null, enabled: true, promptName: "the same language as the source content", charsPerSecond: 15, sentenceEnd: "." },
  // Ready for later: the pipeline never branches on these codes.
  { code: "zh", label: "中文", ttsLocale: "zh-CN", enabled: false, promptName: "Simplified Chinese", charsPerSecond: 6, sentenceEnd: "。" },
  { code: "ja", label: "日本語", ttsLocale: "ja-JP", enabled: false, promptName: "Japanese", charsPerSecond: 7, sentenceEnd: "。" },
  { code: "ko", label: "한국어", ttsLocale: "ko-KR", enabled: false, promptName: "Korean", charsPerSecond: 8, sentenceEnd: "." },
];

export function languageOf(code: string | null | undefined): LanguageOption {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES.find((l) => l.code === "en")!;
}

/** Bilingual (vi + en) modes. Data first: not every mode renders differently yet. */
export const BILINGUAL_MODES = [
  { id: "EN_VOICE_VI_SUB", label: "Giọng tiếng Anh, phụ đề tiếng Việt" },
  { id: "VI_EXPLAIN_EN_EXAMPLE", label: "Giải thích tiếng Việt, ví dụ tiếng Anh" },
  { id: "ALTERNATING", label: "Xen kẽ Anh – Việt" },
  { id: "BILINGUAL_SUB", label: "Phụ đề song ngữ" },
] as const;
export type BilingualMode = (typeof BILINGUAL_MODES)[number]["id"];

// ------------------------------------------------------------- audience ---

export interface AudienceOption {
  id: string;
  label: string;
  /** Seconds a scene stays on screen on average - the scene planner's unit. */
  avgSceneSeconds: number;
  /** Longest sentence the writer should use. */
  maxSentenceWords: number;
  /** Narration speed relative to the language's comfortable rate. */
  speechRate: number;
  /** One instruction line for the writer. Never changes WHAT is true, only how it is said. */
  promptHint: string;
}

export const AUDIENCES: readonly AudienceOption[] = [
  { id: "TODDLER", label: "Trẻ nhỏ", avgSceneSeconds: 5.5, maxSentenceWords: 6, speechRate: 0.8, promptHint: "very young children: tiny sentences, very common words, one idea per scene, gentle and safe, big clear visuals" },
  { id: "KIDS", label: "Thiếu nhi", avgSceneSeconds: 5, maxSentenceWords: 9, speechRate: 0.9, promptHint: "children: short sentences, simple words, playful, explain every new word, bright uncluttered visuals" },
  { id: "STUDENTS", label: "Học sinh", avgSceneSeconds: 4.5, maxSentenceWords: 12, speechRate: 1, promptHint: "school students: clear, friendly, concrete examples, one key point per scene" },
  { id: "BEGINNER", label: "Người mới bắt đầu", avgSceneSeconds: 5, maxSentenceWords: 12, speechRate: 0.95, promptHint: "beginners: no jargon, define terms, step by step" },
  { id: "ADULTS", label: "Người lớn", avgSceneSeconds: 4.5, maxSentenceWords: 16, speechRate: 1, promptHint: "adults: natural, direct, respectful of their time" },
  { id: "EXPERT", label: "Chuyên môn", avgSceneSeconds: 4.5, maxSentenceWords: 20, speechRate: 1.05, promptHint: "professionals: precise terms allowed, denser information, no oversimplification" },
  { id: "GENERAL", label: "Chung", avgSceneSeconds: 4.5, maxSentenceWords: 14, speechRate: 1, promptHint: "a general audience: clear and engaging" },
];

export function audienceOf(id: string | null | undefined): AudienceOption {
  return AUDIENCES.find((a) => a.id === id) ?? AUDIENCES.find((a) => a.id === "GENERAL")!;
}

// ----------------------------------------------------------------- tone ---

export const TONES = [
  { id: "AUTO", label: "Tự động", promptHint: "" },
  { id: "NATURAL", label: "Tự nhiên", promptHint: "natural and conversational" },
  { id: "PROFESSIONAL", label: "Chuyên nghiệp", promptHint: "professional, trustworthy, calm" },
  // QĐ-127: Creative Style Engine tones. Ids of the first eight never change (stored on projects).
  { id: "FRIENDLY", label: "Thân thiện", promptHint: "friendly and warm, like talking to a friend" },
  { id: "EDUCATIONAL", label: "Giáo dục", promptHint: "educational, clear explanations" },
  { id: "PLAYFUL", label: "Tinh nghịch", promptHint: "playful, light, cheeky" },
  { id: "FUN", label: "Hài hước / vui vẻ", promptHint: "fun, light-hearted, a little humour" },
  { id: "DRAMATIC", label: "Kịch tính", promptHint: "dramatic, suspenseful, strong reveals" },
  { id: "EMOTIONAL", label: "Cảm xúc", promptHint: "emotional, heartfelt" },
  { id: "MYSTERIOUS", label: "Bí ẩn", promptHint: "mysterious, intriguing, slow reveal" },
  { id: "PREMIUM", label: "Sang trọng", promptHint: "premium, elegant, refined" },
  { id: "DOCUMENTARY", label: "Documentary", promptHint: "documentary narrator, observational and factual" },
  { id: "ENERGETIC", label: "Năng động", promptHint: "energetic, fast-paced, upbeat" },
  { id: "GENTLE", label: "Nhẹ nhàng / bình tĩnh", promptHint: "gentle, soft, soothing" },
] as const;
export type ToneId = (typeof TONES)[number]["id"];

export function toneOf(id: string | null | undefined) {
  return TONES.find((t) => t.id === id) ?? TONES[0];
}

// ------------------------------------------------------------ voice mode ---

export const VOICE_MODES = [
  { id: "NARRATION", label: "Người dẫn chuyện" },
  { id: "DIALOGUE", label: "Hội thoại nhân vật" },
  { id: "MIXED", label: "Kết hợp" },
  { id: "NO_VOICE", label: "Không lồng tiếng" },
] as const;
export type VoiceMode = (typeof VOICE_MODES)[number]["id"];

// -------------------------------------------------------------- sources ---

export const CONTENT_SOURCE_TYPES = [
  { id: "PROMPT", label: "Nhập ý tưởng", icon: "✍️", enabled: true },
  { id: "TEXT", label: "Dán nội dung", icon: "📋", enabled: true },
  { id: "ASSETS", label: "Tải ảnh / video", icon: "🖼️", enabled: true },
  // Architecture only: no web extraction service exists yet (feature gated).
  { id: "URL", label: "Dán URL", icon: "🔗", enabled: false },
  { id: "STORYBOARD", label: "Nhập storyboard", icon: "🗂️", enabled: true },
  { id: "IDIOM", label: "Thư viện thành ngữ", icon: "📚", enabled: true },
] as const;
export type ContentSourceType = (typeof CONTENT_SOURCE_TYPES)[number]["id"];

// ------------------------------------------------------------- duration ---

export const DURATION_CHOICES = [15, 30, 45, 60] as const;
export const MIN_DURATION_SECONDS = 10;
export const MAX_DURATION_SECONDS = 180;

export function clampDuration(seconds: number): number {
  if (!Number.isFinite(seconds)) return 30;
  return Math.round(Math.min(MAX_DURATION_SECONDS, Math.max(MIN_DURATION_SECONDS, seconds)));
}

// --------------------------------------------------------- fact provenance ---

/**
 * Where a fact came from. A review must never present an AI guess as a spec:
 * price, power, battery, size, warranty or a feature need a SOURCE_FACT or a
 * USER_PROVIDED origin to be stated as true.
 */
export const FACT_ORIGINS = ["SOURCE_FACT", "USER_PROVIDED", "AI_GENERATED"] as const;
export type FactOrigin = (typeof FACT_ORIGINS)[number];
