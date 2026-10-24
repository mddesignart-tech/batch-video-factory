/**
 * Splitting a scene's dialogue into one line per speaker.
 *
 * Voice used to be one file per scene, spoken by whoever happened to be first
 * in the speaking list. Scene 4 of "Spill the beans" is the counter-example
 * that matters:
 *
 *   Max: "I think I spilled too many beans!" Leo: "Now we know the secret."
 *
 * One file meant Max's voice read Leo's line too, or Leo was simply dropped.
 * Both are wrong, and neither is visible in a cost ledger or a status field.
 *
 * The attribution rule, which is the same rule the image side already follows:
 * speech follows the SPEAKING list, never the PRESENT list. A character
 * standing silently in frame must be drawn and must not be given a line.
 */

export interface ParsedLine {
  /** Character name as written in the script. */
  speaker: string;
  /** The words to synthesise, with the label and quotes removed. */
  text: string;
  /** Position within the scene, starting at 1. */
  lineNumber: number;
}

/**
 * `Max: "..."` or `Max: ...` at the start of a segment. Any script's letters
 * (QĐ-158): "Chị Hoa:" or "Người bán 2:" is a speaker as much as "Max:" - it
 * is still taken only when it names one of the scene's speakers.
 */
const SPEAKER_LABEL = /(\p{Lu}[\p{L}\p{M}\p{N} '-]{0,29}):\s*/gu;

/**
 * SPEAKER LABEL IS NOT SPOKEN TEXT (QĐ-143). A text model sometimes writes
 * "Narrator: ..." into the narration field, and the voice read "Narrator" aloud.
 *
 * Labels that name a voice ROLE rather than a person. Only these, and the
 * scene's own speakers, are ever stripped: "Lưu ý: ..." or "Chim cánh cụt: ..."
 * are words to read, so nothing before a ":" is dropped on shape alone.
 */
const ROLE_LABELS = new Set(["narrator", "người dẫn chuyện", "người dẫn", "host", "voice over", "voice-over", "voiceover", "vo"]);
const NUMBERED_SPEAKER = /^speaker [a-z0-9]$/;

/** A leading `Label:` (optionally quoted or bold) - a CANDIDATE only. */
const LEADING_LABEL = /^\s*[*"“]*\s*([\p{L}\p{N}][\p{L}\p{N} .'’-]{0,29}?)\s*[*"”]*\s*:\s*\**\s*/u;

/** Is `name` a speaker label for a scene whose speakers are `known`? */
export function isSpeakerLabel(name: string, known: readonly string[]): boolean {
  const n = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (n.length === 0) return false;
  return ROLE_LABELS.has(n) || NUMBERED_SPEAKER.test(n) || known.some((k) => k.trim().toLowerCase() === n);
}

/**
 * Split a legacy "Speaker: words" line into its speaker and the words to say.
 * Only a label that is a speaker of this scene or a voice role is taken off;
 * any other "X:" stays part of the text. Applied per line of a multi-line text.
 */
export function splitSpeakerLabel(text: string, known: readonly string[]): { speaker: string | null; text: string } {
  let speaker: string | null = null;
  const lines = text.split("\n").map((line) => {
    const m = LEADING_LABEL.exec(line);
    if (!m || !isSpeakerLabel(m[1] ?? "", known)) return line;
    speaker ??= (m[1] ?? "").trim();
    return line.slice(m[0].length);
  });
  return { speaker, text: lines.join("\n") };
}

function clean(text: string): string {
  return text
    .trim()
    .replace(/^["""']+/, "")
    .replace(/["""']+$/, "")
    .trim();
}

/**
 * Split dialogue into per-speaker lines.
 *
 * `speaking` is the authority on who may be given a line. A label naming
 * someone absent from it is kept as TEXT rather than treated as a speaker
 * change, because the alternative - silently synthesising a voice for a
 * character the script did not say was speaking - is the failure being fixed.
 */
export function parseDialogueLines(
  dialogue: string,
  narration: string,
  speaking: string[],
): ParsedLine[] {
  const allowed = new Set(speaking.map((s) => s.toLowerCase()));
  const source = dialogue.trim();

  if (source.length === 0) {
    // Narration has no speaker. It belongs to the scene, and the first speaking
    // character reads it only because someone has to.
    // A legacy "Narrator: ..." keeps its speaker in the speaking list and its
    // words here - the label is never handed to the voice.
    const text = clean(splitSpeakerLabel(narration.trim(), speaking).text);
    if (text.length === 0) return [];
    const speaker = speaking[0] ?? "";
    return speaker ? [{ speaker, text, lineNumber: 1 }] : [];
  }

  // Find every label that names someone the script says is speaking.
  const marks: { name: string; start: number; textFrom: number }[] = [];
  SPEAKER_LABEL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPEAKER_LABEL.exec(source)) !== null) {
    const name = (m[1] ?? "").trim();
    if (allowed.has(name.toLowerCase())) {
      marks.push({ name, start: m.index, textFrom: m.index + m[0].length });
    }
  }

  if (marks.length === 0) {
    // Unlabelled dialogue, or labels naming nobody who is speaking. Give the
    // whole thing to the first speaker rather than inventing an attribution.
    // A role label ("Speaker A:", "VO:") is still not read aloud.
    const text = clean(splitSpeakerLabel(source, speaking).text);
    const speaker = speaking[0] ?? "";
    if (text.length === 0 || !speaker) return [];
    return [{ speaker, text, lineNumber: 1 }];
  }

  const lines: ParsedLine[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i];
    if (!mark) continue;
    const end = marks[i + 1]?.start ?? source.length;
    const text = clean(source.slice(mark.textFrom, end));
    if (text.length === 0) continue;
    lines.push({ speaker: mark.name, text, lineNumber: lines.length + 1 });
  }
  return lines;
}

/** Total characters to be billed for a scene, for a pre-flight estimate. */
export function billableChars(lines: ParsedLine[]): number {
  return lines.reduce((sum, l) => sum + l.text.length, 0);
}
