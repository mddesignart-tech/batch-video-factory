import { parseDialogueLines, type ParsedLine } from "./dialogue-lines";
import { sceneCharacters, type SceneCharacterColumns } from "./scene-characters";

/**
 * A scene's subtitles come from the SAME ordered lines its voice is made from
 * (QĐ-122) - `parseDialogueLines` over the dialogue, narration and speaking
 * list, exactly as `generateSceneVoice` calls it. Never a second parse, never
 * the "focus" character, never the last speaker.
 *
 * The stored `subtitle` field is an author's readable version of ONE line. It
 * stands in for the caption only when the scene has exactly one spoken line;
 * with two or more it cannot represent them (a script once stored
 * "Leo: No, Max, it's an idiom." for Max + Leo and Max's line vanished from the
 * screen), so each line captions itself.
 */
export type SceneSpeech = Pick<{ dialogue: string; narration: string }, "dialogue" | "narration"> & SceneCharacterColumns;

/** The ordered spoken lines - the voice's own list. */
export function spokenLines(scene: SceneSpeech): ParsedLine[] {
  return parseDialogueLines(scene.dialogue, scene.narration, sceneCharacters(scene).speaking);
}

/** Should the author's single `subtitle` stand in for the caption? */
export function usesAuthorSubtitle(lineCount: number, subtitle: string): boolean {
  return lineCount <= 1 && subtitle.trim().length > 0;
}

/**
 * The scene's subtitle as text (metadata, the storyboard view): the author's
 * line for a one-line scene, every line "Speaker: text" in order otherwise.
 */
export function sceneSubtitleText(scene: SceneSpeech & { subtitle: string }): string {
  const lines = spokenLines(scene);
  if (usesAuthorSubtitle(lines.length, scene.subtitle)) return scene.subtitle.trim();
  return lines.map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join("\n");
}

/**
 * Split a span among several lines in order, by length of text (longer lines
 * stay up longer). For a scene whose lines have no measured audio yet.
 */
export function splitByText(texts: string[], start: number, end: number): { startSec: number; endSec: number; text: string }[] {
  const weights = texts.map((t) => Math.max(1, t.trim().length));
  const total = weights.reduce((n, w) => n + w, 0);
  const span = Math.max(0, end - start);
  let cursor = start;
  return texts.map((text, i) => {
    const length = (span * weights[i]!) / total;
    const out = { startSec: cursor, endSec: cursor + length, text };
    cursor += length;
    return out;
  });
}
