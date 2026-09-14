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

/** `Max: "..."` or `Max: ...` at the start of a segment. */
const SPEAKER_LABEL = /([A-Z][A-Za-z '-]{0,19}):\s*/g;

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
    const text = clean(narration);
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
    const text = clean(source);
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
