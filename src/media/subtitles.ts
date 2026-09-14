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

/** Smallest audible pause between two speakers. Below this they read as one. */
export const SPEAKER_GAP_SECONDS = 0.12;

export interface SpokenLine {
  /** MEASURED length of the rendered audio. Never a prediction. */
  durationSec: number;
  text: string;
  /** Who says it, so a change of speaker can be spaced. */
  speaker?: string;
}

/**
 * Cues timed against the audio that will actually play.
 *
 * `buildCues` above lays cues out on the SCENE's planned duration, which is a
 * figure chosen while writing the script. Speech does not obey it: a levelled,
 * trimmed clip is whatever length it turned out to be, and timing subtitles
 * against the plan puts the words progressively out of step with the voice.
 *
 * So this takes the measured length of each line instead. When a scene's audio
 * runs shorter than its planned duration, the remainder is silence at the end
 * rather than stretched captions.
 *
 * Two speakers never share a moment: a gap is inserted at every change of
 * speaker so one line has visibly ended before the next begins.
 */
export function buildCuesFromAudio(
  scenes: { plannedDuration: number; lines: SpokenLine[] }[],
): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let cursor = 0;

  for (const scene of scenes) {
    let withinScene = 0;
    let previousSpeaker: string | undefined;

    for (const line of scene.lines) {
      const text = line.text.trim();
      const duration = Math.max(0.3, line.durationSec);

      // A change of speaker gets a real pause. Without it the two lines abut
      // and the captions read as one person talking over themselves.
      if (previousSpeaker !== undefined && line.speaker !== previousSpeaker) {
        withinScene += SPEAKER_GAP_SECONDS;
      }

      if (text.length > 0) {
        cues.push({
          startSeconds: cursor + withinScene,
          endSeconds: cursor + withinScene + duration - 0.06,
          text,
        });
      }
      withinScene += duration;
      previousSpeaker = line.speaker;
    }

    // The scene lasts as long as its visuals OR its speech, whichever is
    // longer. Cutting the picture while a line is still being spoken is the
    // one outcome neither figure should be allowed to cause.
    cursor += Math.max(scene.plannedDuration, withinScene);
  }

  return cues;
}

/** Total runtime implied by measured audio, for checking against the video. */
export function timelineLength(
  scenes: { plannedDuration: number; lines: SpokenLine[] }[],
): number {
  return scenes.reduce((total, scene) => {
    let withinScene = 0;
    let previousSpeaker: string | undefined;
    for (const line of scene.lines) {
      if (previousSpeaker !== undefined && line.speaker !== previousSpeaker) {
        withinScene += SPEAKER_GAP_SECONDS;
      }
      withinScene += Math.max(0.3, line.durationSec);
      previousSpeaker = line.speaker;
    }
    return total + Math.max(scene.plannedDuration, withinScene);
  }, 0);
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
