/**
 * Subtitle generation (SRT + ASS).
 *
 * Shorts are watched muted on a phone, so the subtitle track is the main
 * carrier of the joke. The ASS style below is tuned for that: very large bold
 * text, heavy outline for contrast over any background, and a bottom margin that
 * keeps the words clear of both the characters' faces and the platform UI
 * overlay at the bottom of the screen.
 */

export interface SubtitleCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface SubtitleOptions {
  width: number;
  height: number;
  /** Highlighted in a contrasting colour wherever it appears. */
  highlightPhrase?: string;
}

const MAX_CHARS_PER_LINE = 26;
const MAX_LINES = 3;

export function buildCues(
  scenes: { duration: number; subtitle: string }[],
): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let cursor = 0;
  for (const scene of scenes) {
    const duration = Math.max(0.5, scene.duration);
    const text = scene.subtitle.trim();
    if (text.length > 0) {
      cues.push({
        startSeconds: cursor,
        // A 60ms gap stops consecutive cues from flickering into each other.
        endSeconds: cursor + duration - 0.06,
        text,
      });
    }
    cursor += duration;
  }
  return cues;
}

export function wrapSubtitle(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > MAX_CHARS_PER_LINE && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  if (lines.length <= MAX_LINES) return lines;
  // Too long to show comfortably: keep the first lines and fold the rest in.
  const head = lines.slice(0, MAX_LINES - 1);
  head.push(lines.slice(MAX_LINES - 1).join(" "));
  return head;
}

// -------------------------------------------------------------------- SRT ---

function srtTimestamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(rest, 3)}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function buildSRT(cues: SubtitleCue[]): string {
  return (
    cues
      .map((cue, index) => {
        const body = wrapSubtitle(cue.text).join("\n");
        return `${index + 1}\n${srtTimestamp(cue.startSeconds)} --> ${srtTimestamp(
          cue.endSeconds,
        )}\n${body}\n`;
      })
      .join("\n") + "\n"
  );
}

// -------------------------------------------------------------------- ASS ---

function assTimestamp(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6_000);
  const s = Math.floor((cs % 6_000) / 100);
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs % 100, 2)}`;
}

/**
 * ASS colours are &HAABBGGRR - note the reversed byte order.
 *
 * Two spellings are needed: the `Style:` line takes a bare value, while an
 * inline `\c` override is terminated with a trailing `&`.
 */
const WHITE = "&H00FFFFFF";
const BLACK = "&H00000000";
const WHITE_OVERRIDE = `${WHITE}&`;
const HIGHLIGHT_OVERRIDE = "&H0024D7FF&"; // warm amber, reads on any background

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, "\\N");
}

function applyHighlight(text: string, phrase: string | undefined): string {
  if (!phrase || phrase.trim().length === 0) return text;
  const escaped = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(${escaped})`, "gi");
  return text.replace(
    pattern,
    (match) => `{\\c${HIGHLIGHT_OVERRIDE}}${match}{\\c${WHITE_OVERRIDE}}`,
  );
}

export function buildASS(
  cues: SubtitleCue[],
  options: SubtitleOptions,
): string {
  const { width, height, highlightPhrase } = options;
  // Scale the type to the frame so a 1080x1920 export and a preview render look
  // the same. ~7.8% of frame height reads well on a phone.
  const fontSize = Math.round(height * 0.078);
  const outline = Math.max(3, Math.round(fontSize * 0.09));
  const shadow = Math.max(2, Math.round(fontSize * 0.05));
  const marginV = Math.round(height * 0.2);
  const marginH = Math.round(width * 0.075);

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Alignment 2 = bottom centre. Arial is guaranteed present on Windows.
    `Style: Default,Arial,${fontSize},${WHITE},${WHITE},${BLACK},${BLACK},-1,0,0,0,100,100,0,0,1,${outline},${shadow},2,${marginH},${marginH},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events = cues.map((cue) => {
    const wrapped = wrapSubtitle(cue.text).join("\n");
    const text = applyHighlight(escapeAssText(wrapped), highlightPhrase);
    return `Dialogue: 0,${assTimestamp(cue.startSeconds)},${assTimestamp(
      cue.endSeconds,
    )},Default,,0,0,0,,${text}`;
  });

  return `${header}\n${events.join("\n")}\n`;
}
