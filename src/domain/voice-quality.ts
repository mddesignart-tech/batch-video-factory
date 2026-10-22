/**
 * VOICE QUALITY (QĐ-146): what a person heard, and the voice suggestions it
 * supports. Pure: no network, no database.
 *
 * The ratings are a HUMAN's scores from listening to the Mind Voice samples on
 * 2026-10-22 (data/voice-ab/cham-diem-mind-voice.html). They are kept exactly
 * as given - never recomputed, never edited by code - and each points at the
 * file that was heard.
 *
 * Suggestions are only suggestions: shown next to the voice picker, applied by
 * a click. They never change a voice by themselves, nor "Tự động", nor any
 * existing project.
 */

import { engineForLanguage, type MindEngineId } from "./mind-voice";
import type { VoiceStyleId } from "./voice-director";

export interface VoiceScores {
  /** Tự nhiên, 1-5. */
  natural: number;
  /** Phát âm, 1-5. */
  pronunciation: number;
  /** Cảm xúc, 1-5. */
  emotion: number;
  /** Phù hợp nội dung, 1-5. */
  fit: number;
}

export interface VoiceRating {
  /** Sample id on the rating page: 01-12 (WAV) or V1-V3 (video). */
  id: string;
  /** Project-relative path of what was heard. */
  file: string;
  engine: MindEngineId;
  /** The voice(s) heard, by Mind Voice voice id. */
  voices: string[];
  language: "vi" | "en";
  text: string;
  scores: VoiceScores;
  /** What the listener said about it, in their words. */
  note?: string;
}

const W = "data/voice-ab/mind-voice-2026-10-22";
const V = "data/voice-ab/mind-voice-real-2026-10-22T01-19-10";
const VI = "Bạn có biết, chỉ cần uống một ly nước ngay sau khi thức dậy, cơ thể sẽ tỉnh táo hơn hẳn?";
const EN = "Did you know that a single glass of water right after you wake up can make you feel more alert? It costs nothing, and it takes no extra time.";

function freeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) freeze(v);
    Object.freeze(o);
  }
  return o;
}

const s = (natural: number, pronunciation: number, emotion: number, fit: number): VoiceScores => ({ natural, pronunciation, emotion, fit });

export const VOICE_RATINGS = freeze({
  ratedAt: "2026-10-22",
  ratedBy: "Người dùng - nghe thủ công (không phải điểm AI)",
  page: "data/voice-ab/cham-diem-mind-voice.html",
  items: [
    { id: "01", file: `${W}/01-vi-bac-tu-nhien-hai-dang.wav`, engine: "vieneu", voices: ["Hải Đăng"], language: "vi", text: `${VI} (3 câu)`, scores: s(4, 5, 4, 5) },
    { id: "02", file: `${W}/02-vi-nam-ke-chuyen-thuc-doan.wav`, engine: "vieneu", voices: ["Thục Đoan"], language: "vi", text: `${VI} (3 câu)`, scores: s(5, 5, 5, 5) },
    { id: "03", file: `${W}/03-vi-bac-ke-chuyen-thien-minh.wav`, engine: "vieneu", voices: ["Thiện Minh"], language: "vi", text: "Ngày xưa, ở một ngôi làng nhỏ ven sông, có một cậu bé rất thích hỏi. (2 đoạn)", scores: s(4, 5, 4, 5) },
    { id: "04", file: `${W}/04-vi-nam-tu-nhien-adam.wav`, engine: "vieneu", voices: ["Adam"], language: "vi", text: VI, scores: s(4, 5, 4, 4) },
    { id: "05", file: `${W}/05-tag-cuoi-adam-bua.wav`, engine: "vieneu", voices: ["Adam bựa"], language: "vi", text: "Tôi tưởng mình giỏi lắm. [cười] Hóa ra lại quên mang chìa khóa.", scores: s(5, 5, 5, 4) },
    {
      id: "06",
      file: `${W}/06-tag-tho-dai-ngoc-huyen.wav`,
      engine: "vieneu",
      voices: ["Ngọc Huyền"],
      language: "vi",
      text: "[thở dài] Một ngày dài cuối cùng cũng kết thúc.",
      scores: s(3, 3, 3, 3),
      note: "Đoạn thở dài thể hiện không đúng, nghe như đọc ra từ hoặc âm thanh không tự nhiên.",
    },
    { id: "07", file: `${W}/07-tag-hang-giong-thien-minh.wav`, engine: "vieneu", voices: ["Thiện Minh"], language: "vi", text: "[hắng giọng] Xin chào các bạn, hôm nay chúng ta nói về thói quen buổi sáng.", scores: s(4, 4, 4, 4) },
    {
      id: "08",
      file: `${W}/08-vi-xen-en-truc-ly.wav`,
      engine: "vieneu",
      voices: ["Trúc Ly"],
      language: "vi",
      text: "Hôm nay mình review chiếc smartphone mới, pin dùng được cả ngày, camera thì rất sharp, và giá chỉ khoảng năm trăm đô.",
      scores: s(5, 5, 4, 5),
    },
    { id: "09", file: `${W}/09-en-supertonic-m1.wav`, engine: "supertonic", voices: ["M1"], language: "en", text: EN, scores: s(5, 4, 4, 5) },
    { id: "10", file: `${W}/10-en-supertonic-f1.wav`, engine: "supertonic", voices: ["F1"], language: "en", text: EN, scores: s(5, 5, 5, 5) },
    { id: "11", file: `${W}/11-en-tag-laugh-m2.wav`, engine: "supertonic", voices: ["M2"], language: "en", text: "I thought I had it all figured out. <laugh> Turns out, I forgot my keys again.", scores: s(4, 4, 4, 3) },
    { id: "12", file: `${W}/12-en-tag-sigh-f2.wav`, engine: "supertonic", voices: ["F2"], language: "en", text: "<sigh> What a long day. Finally, it is over.", scores: s(5, 4, 4, 3) },
    { id: "V1", file: `${V}/01-vi-3-canh-hai-dang.mp4`, engine: "vieneu", voices: ["Hải Đăng"], language: "vi", text: "Video 3 cảnh, giọng Tự động", scores: s(4, 5, 5, 5) },
    {
      id: "V2",
      file: `${V}/02-vi-hoi-thoai-thien-minh-ngoc-huyen.mp4`,
      engine: "vieneu",
      voices: ["Thiện Minh", "Ngọc Huyền"],
      language: "vi",
      text: "Hội thoại 2 người: Bạn ăn sáng chưa? / Mình ăn rồi, cảm ơn nhé. Hôm nay trời đẹp quá! / Vậy mình đi dạo một vòng đi.",
      scores: s(4, 4, 3, 4),
    },
    { id: "V3", file: `${V}/03-en-supertonic-m1.mp4`, engine: "supertonic", voices: ["M1"], language: "en", text: "Video tiếng Anh 2 cảnh, Voice Director Comedy", scores: s(4, 4, 4, 4) },
  ] satisfies VoiceRating[],
});

/** Out of 20. */
export function totalScore(scores: VoiceScores): number {
  return scores.natural + scores.pronunciation + scores.emotion + scores.fit;
}

export function ratingOf(id: string): VoiceRating | undefined {
  return VOICE_RATINGS.items.find((r) => r.id === id);
}

// ------------------------------------------------------- recommendations ---

export type MindUseCase = "REVIEW_AI" | "REVIEW_PRODUCT" | "STORYTELLING" | "COMEDY" | "ENGLISH";

export interface VoiceSuggestion {
  voiceId: string;
  engine: MindEngineId;
  /** Shown next to the name, e.g. "Nữ". */
  label?: string;
  /** Still to be tried more before trusting it. */
  candidate?: boolean;
  /** Rated samples that back it (VOICE_RATINGS ids). */
  evidence: string[];
}

/** From what the listener chose on 2026-10-22, best first. */
export const MIND_VOICE_SUGGESTIONS: Record<MindUseCase, { label: string; voices: VoiceSuggestion[] }> = freeze({
  REVIEW_AI: {
    label: "Review AI / công nghệ",
    voices: [
      { voiceId: "Hải Đăng", engine: "vieneu", evidence: ["01", "V1"] },
      { voiceId: "Trúc Ly", engine: "vieneu", evidence: ["08"] },
    ],
  },
  REVIEW_PRODUCT: {
    label: "Review sản phẩm",
    voices: [
      { voiceId: "Trúc Ly", engine: "vieneu", evidence: ["08"] },
      { voiceId: "Thục Đoan", engine: "vieneu", evidence: ["02"] },
    ],
  },
  STORYTELLING: {
    label: "Kể chuyện",
    voices: [
      { voiceId: "Thục Đoan", engine: "vieneu", evidence: ["02"] },
      { voiceId: "Thiện Minh", engine: "vieneu", evidence: ["03"] },
    ],
  },
  COMEDY: {
    label: "Hài / TikTok Comedy",
    voices: [{ voiceId: "Adam bựa", engine: "vieneu", candidate: true, evidence: ["05"] }],
  },
  ENGLISH: {
    label: "Video tiếng Anh",
    voices: [
      { voiceId: "F1", engine: "supertonic", label: "Nữ", evidence: ["10"] },
      { voiceId: "M1", engine: "supertonic", label: "Nam", evidence: ["09", "V3"] },
    ],
  },
});

const AI_TYPES = new Set(["AI_REVIEW"]);
const PRODUCT_TYPES = new Set(["PRODUCT_REVIEW", "ADVERTISEMENT"]);
const STORY_TYPES = new Set(["STORY", "TOY_WORLD"]);

/**
 * Which suggestion list fits a project: by its language first (English →
 * Supertonic), then its voice style and content type. Null = no listened-to
 * suggestion yet for this kind of video.
 */
export function mindUseCaseFor(input: { language: string; contentType: string | null; styleId: VoiceStyleId | null }): MindUseCase | null {
  if (engineForLanguage(input.language) === "supertonic") return "ENGLISH";
  if (input.styleId === "COMEDY") return "COMEDY";
  if (input.contentType && AI_TYPES.has(input.contentType)) return "REVIEW_AI";
  if ((input.contentType && PRODUCT_TYPES.has(input.contentType)) || input.styleId === "PRODUCT_REVIEW") return "REVIEW_PRODUCT";
  if ((input.contentType && STORY_TYPES.has(input.contentType)) || input.styleId === "STORYTELLING") return "STORYTELLING";
  return null;
}

export interface ResolvedSuggestion extends VoiceSuggestion {
  /** Best rated sample total, out of 20. */
  bestScore: number;
  /** e.g. "mẫu 02: 20/20". */
  basis: string;
}

/** The suggestions for a use case, with the scores that back them. */
export function suggestMindVoices(useCase: MindUseCase): ResolvedSuggestion[] {
  return MIND_VOICE_SUGGESTIONS[useCase].voices.map((v) => {
    const rated = v.evidence.map((id) => ratingOf(id)).filter((r): r is VoiceRating => Boolean(r));
    const best = rated.reduce((m, r) => Math.max(m, totalScore(r.scores)), 0);
    return { ...v, bestScore: best, basis: rated.map((r) => `mẫu ${r.id}: ${totalScore(r.scores)}/20`).join(", ") };
  });
}
