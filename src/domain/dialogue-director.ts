/**
 * DIALOGUE VOICE DIRECTOR (QĐ-147) - how each CHARACTER says their lines in a
 * multi-speaker scene, on a local Mind Voice engine. Pure: no database, no
 * network.
 *
 * Before it, a dialogue line got at most the scene's one emotion, the same for
 * every speaker, and nothing at all with the Voice Director off. VieNeu also
 * ends every chunk under 5 words with "." (its SDK's sea-g2p punc_norm), so a
 * short question such as "Bạn ăn sáng chưa?" was read as a statement.
 *
 * Each speaker gets their own emotion, independent of the others. Neither
 * engine has an emotion control (VieNeu's style comes from the reference voice,
 * Supertonic's from its voice style), so an emotion becomes ONLY what the
 * engine really does:
 *   - the line's own final ? / ! is kept (VieNeu: `keep_punct`, Supertonic: as written);
 *   - a final "." may become "!" (surprise, annoyance);
 *   - a small tempo change (time-stretch, pitch kept - the voice stays the same);
 *   - a laugh cue, only where the engine reliably performs one (MIND_CUES).
 * Nothing else is claimed: no anger, no sarcasm in the timbre. The voice of a
 * character is never changed here.
 *
 * Off by default: a project without it sends exactly what it sent before.
 */

import { adaptMindCues, mindCueUsable, MIND_CUES, type MindEngineId } from "./mind-voice";

export const DIALOGUE_EMOTIONS = [
  { id: "AUTO", label: "Tự động (theo dấu câu)" },
  { id: "CALM", label: "Bình tĩnh" },
  { id: "SURPRISED", label: "Ngạc nhiên" },
  { id: "HAPPY", label: "Vui vẻ" },
  { id: "TEASING", label: "Cà khịa" },
  { id: "ANNOYED", label: "Bực mình" },
] as const;
export type DialogueEmotionId = (typeof DIALOGUE_EMOTIONS)[number]["id"];
export const DIALOGUE_EMOTION_IDS = DIALOGUE_EMOTIONS.map((e) => e.id) as [DialogueEmotionId, ...DialogueEmotionId[]];

export interface DialogueEmotionCapability {
  /** Tempo factor on top of the line's own speed (time-stretched, pitch kept). */
  tempo: number;
  /** A final "." becomes "!". */
  exclaim: boolean;
  /** A laugh cue after the line, when the engine performs one and cues are on. */
  laugh: boolean;
  /** What the listener can expect - never more than the engine does. */
  expect: string;
  /** What this emotion would need that no local engine has. */
  missing: string | null;
}

/**
 * The same for both engines: the levers (final mark, tempo, laugh cue) are
 * ones each engine has; the laugh itself is checked per engine (MIND_CUES).
 */
export const DIALOGUE_CAPABILITIES: Record<DialogueEmotionId, DialogueEmotionCapability> = {
  AUTO: { tempo: 1, exclaim: false, laugh: false, expect: "Giữ ngữ điệu hỏi / cảm thán theo dấu câu của câu.", missing: null },
  CALM: { tempo: 0.96, exclaim: false, laugh: false, expect: "Chậm hơn một chút, giữ dấu câu.", missing: "Không có điều khiển 'giọng trầm tĩnh' - chỉ đổi nhịp." },
  SURPRISED: { tempo: 1.05, exclaim: true, laugh: false, expect: "Nhanh hơn một chút, câu kết bằng dấu chấm thành dấu chấm than.", missing: "Không có điều khiển cao độ - mức ngạc nhiên do model tự quyết theo dấu câu." },
  HAPPY: { tempo: 1.03, exclaim: false, laugh: false, expect: "Nhanh hơn một chút, giữ dấu câu.", missing: "Không có điều khiển 'giọng cười' - độ vui chủ yếu nhờ giọng gốc." },
  TEASING: { tempo: 1, exclaim: false, laugh: true, expect: "Một tiếng cười sau câu (chỉ engine thể hiện ổn định, khi bật thẻ cảm xúc).", missing: "Không có điều khiển 'giọng mỉa' - chỉ thêm tiếng cười." },
  ANNOYED: { tempo: 1.04, exclaim: true, laugh: false, expect: "Nhanh hơn một chút, câu kết bằng dấu chấm thành dấu chấm than.", missing: "Không có điều khiển 'giọng gắt' - không giả lập được sự bực bội trong chất giọng." },
};

export function isDialogueEmotion(v: unknown): v is DialogueEmotionId {
  return typeof v === "string" && (DIALOGUE_EMOTION_IDS as readonly string[]).includes(v);
}

/** Speaker emotions as stored: scene id (or "*" = every scene) → speaker name → emotion. */
export type SpeakerEmotions = Record<string, Record<string, DialogueEmotionId>>;

/** A speaker's emotion in a scene: the scene's own choice, then the video-wide one, then AUTO. */
export function speakerEmotionOf(emotions: SpeakerEmotions, sceneId: string | null, speaker: string): DialogueEmotionId {
  const name = speaker.trim();
  return (sceneId ? emotions[sceneId]?.[name] : undefined) ?? emotions["*"]?.[name] ?? "AUTO";
}

export interface DialogueDirection {
  /** What is sent to the engine. */
  text: string;
  /** Multiply the line's speed by this. */
  tempo: number;
  /** Ask VieNeu to keep the final ? / ! of a short line (Supertonic keeps it anyway). */
  keepPunct: boolean;
  /** What was done, for the line row and the report. */
  applied: string[];
  /** Part of the voice key: a change is a different line. */
  summary: string;
}

/** One dialogue line, directed for its speaker's emotion on `engine`. */
export function dialogueDirection(input: { text: string; engine: MindEngineId; emotion: DialogueEmotionId; cues?: boolean }): DialogueDirection {
  const cap = DIALOGUE_CAPABILITIES[input.emotion];
  const cues = input.cues ?? true;
  const applied: string[] = [];
  let text = input.text.trim();

  if (cap.exclaim && /\.$/.test(text) && !/\.\.$/.test(text)) {
    text = `${text.slice(0, -1)}!`;
    applied.push(". → !");
  }
  const laugh = MIND_CUES[input.engine].laugh;
  if (cap.laugh && laugh && mindCueUsable(input.engine, "laugh", cues) && !text.includes(laugh.tag)) {
    text = `${text} ${laugh.tag}`;
    applied.push(laugh.tag);
  }
  if (Math.abs(cap.tempo - 1) > 1e-9) applied.push(`nhịp ×${cap.tempo}`);
  const ending = /[?!]$/.test(text.replace(/\s*(\[[^\]]+\]|<\w+>)$/, ""));
  const keepPunct = input.engine === "vieneu" && ending;
  if (keepPunct) applied.push("giữ ?/! cuối câu");

  return {
    text: adaptMindCues(text, input.engine, cues).text,
    tempo: cap.tempo,
    keepPunct,
    applied,
    summary: `dlg=${input.emotion}${keepPunct ? " punct=keep" : ""}`,
  };
}

/** Whether a line's stored Mind Voice direction asks the engine to keep its final ? / !. */
export function mindKeepsPunct(instructions: string | null | undefined): boolean {
  return /(?:^|\s)punct=keep(?:\s|$)/.test(instructions ?? "");
}
