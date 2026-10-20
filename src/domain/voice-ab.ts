/**
 * VOICE A/B (QĐ-142): the same Vietnamese script, spoken the way every project
 * was before (A) and the way the Voice Director speaks it (B). Builds the TTS
 * REQUESTS only - nothing is sent. A real listening test buys 2 × the lines and
 * is run only after the person has seen that price.
 */

import { autoPresetFor, directVoice, voicePresetOf, voiceStyleFor } from "./voice-director";
import { prepareSpeechText } from "./speech-text";

/** The narrator direction every project used before QĐ-142 (ensureNarrator). */
export const LEGACY_NARRATOR_INSTRUCTIONS = "Warm, clear narrator. Speak naturally in the language of the text.";

export const AB_SAMPLE_SCRIPT: { role: string; text: string; duration: number }[] = [
  { role: "hook", text: "Bạn có biết uống nước sai cách còn mệt hơn không uống?", duration: 3.5 },
  { role: "tip", text: "Mẹo 1 - uống một ly nước ngay khi thức dậy, khoảng 250ml.", duration: 4 },
  { role: "tip", text: "Mẹo 2: đừng đợi khát mới uống... lúc đó cơ thể đã thiếu nước rồi!!", duration: 4 },
  { role: "punchline", text: "Mẹo 3: uống từ từ. Không phải thi uống nhanh đâu nha!", duration: 4 },
  { role: "cta", text: "Lưu lại video và thử ngay hôm nay nhé!", duration: 3 },
];

export interface AbRequest {
  text: string;
  voiceId: string;
  instructions: string;
  speed: number;
}

export function buildVoiceAB(opts: { legacyVoiceId: string; style: Parameters<typeof voiceStyleFor>[0] & Parameters<typeof directVoice>[0]["style"]; contentType: string; presetId?: string }): {
  role: string;
  A: AbRequest;
  B: AbRequest;
  warnings: string[];
}[] {
  const styleId = voiceStyleFor(opts.style, opts.contentType);
  const preset = voicePresetOf(opts.presetId) ?? autoPresetFor(styleId, "female");
  const totalChars = (t: string) => prepareSpeechText(t, "vi").length;
  return AB_SAMPLE_SCRIPT.map((s, i) => {
    const d = directVoice({
      identity: { voiceId: preset.voiceId, base: preset.base, speed: null, presetSpeed: preset.defaultSpeed, presetLabel: preset.label },
      style: opts.style,
      contentType: opts.contentType,
      sceneRole: s.role,
      sceneIndex: i,
      sceneCount: AB_SAMPLE_SCRIPT.length,
      sceneDuration: s.duration,
      sceneSpeechChars: totalChars(s.text),
      language: "vi",
      emotion: "AUTO",
      speedMode: "AUTO",
      custom: null,
      narrator: true,
      charsPerSecond: 15,
    });
    return {
      role: s.role,
      A: { text: s.text, voiceId: opts.legacyVoiceId, instructions: LEGACY_NARRATOR_INSTRUCTIONS, speed: 1 },
      B: { text: prepareSpeechText(s.text, "vi"), voiceId: preset.voiceId, instructions: d.instructions, speed: d.speed },
      warnings: d.warnings,
    };
  });
}
