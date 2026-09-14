/**
 * Where every spoken line sits inside a scene.
 *
 * A scene is not one voice clip. Scene 4 of "Spill the beans" is two people
 * trading lines, and the pipeline used to collapse that into a single file -
 * one speaker read both parts, or the second was dropped. Neither shows up in a
 * status field, which is why placement needs to be a computed, inspectable
 * thing rather than an implicit consequence of concatenation.
 *
 * Two rules hold throughout:
 *
 *   - Durations are MEASURED from the rendered audio, after trim, levelling
 *     and encode. Nothing here estimates a length from text.
 *   - Two characters never speak at once by default. Overlap in a teaching
 *     video is not a style choice, it is a comprehension failure.
 */

/** Gap between consecutive lines by the SAME speaker - a breath, not a beat. */
export const DEFAULT_PAUSE_SAME_SPEAKER = 0.15;

/**
 * Gap at a change of speaker.
 *
 * Longer than a same-speaker pause because the listener has to register that
 * someone else is talking, and shorter than instinct suggests because this is a
 * Short: a held silence that feels natural in conversation reads as dead air.
 */
export const DEFAULT_PAUSE_SPEAKER_CHANGE = 0.28;

/**
 * Bounds for the pause the system CHOOSES.
 *
 * Below 150ms two speakers run together; above 300ms a Short starts to drag.
 * These bound the default only - a script that states a length is making a
 * deliberate choice and gets a wider range.
 */
export const MIN_PAUSE = 0.15;
export const MAX_PAUSE = 0.3;

/**
 * Bounds for a pause the SCRIPT asked for.
 *
 * Zero is allowed, because "say this immediately after" is a real instruction -
 * an interruption, a character finishing another's sentence. Long is allowed
 * too, because a held beat before a punchline is the oldest joke mechanic
 * there is.
 *
 * The ceiling exists because an override is as likely to be a typo as an
 * intention: 12 where 1.2 was meant would stall the video for twelve seconds,
 * and no comic pause in a sixty-second Short is worth more than this.
 */
export const MIN_OVERRIDE_PAUSE = 0;
export const MAX_OVERRIDE_PAUSE = 1.5;

export interface TimelineInput {
  /** Position within the scene, 1-based. */
  lineNumber: number;
  speaker: string;
  text: string;
  /** Path to the levelled clip. */
  audioPath: string;
  /** MEASURED seconds of that clip. Never estimated from the text. */
  durationSec: number;
  /**
   * Script override for the gap AFTER this line, in seconds.
   *
   * Honoured across a wider range than the automatic default, because a stated
   * length is a decision: 0 for a line that must land on top of the previous
   * one, longer for a deliberate comic beat. Still bounded, since an override
   * is as likely to be a typo as an intention.
   */
  pauseAfterOverride?: number;
}

export interface TimelineEntry {
  lineNumber: number;
  speaker: string;
  text: string;
  audioPath: string;
  /** Seconds from the start of the SCENE. */
  startSec: number;
  durationSec: number;
  endSec: number;
  /** Silence inserted after this line before the next one begins. */
  pauseAfterSec: number;
  /** True when this line follows a different speaker. */
  speakerChanged: boolean;
}

export interface SceneTimeline {
  entries: TimelineEntry[];
  /** Total speech plus pauses. Trailing pause is not counted. */
  speechDurationSec: number;
  /** What the scene actually lasts: the longer of visuals and speech. */
  sceneDurationSec: number;
  /** True when speech outran the planned visual duration. */
  extended: boolean;
}

/** Bound a pause the system chose for itself. */
export function clampPause(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_PAUSE_SAME_SPEAKER;
  return Math.min(MAX_PAUSE, Math.max(MIN_PAUSE, seconds));
}

/** Bound a pause the script asked for. Wider, because it was a decision. */
export function clampOverridePause(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_PAUSE_SAME_SPEAKER;
  return Math.min(MAX_OVERRIDE_PAUSE, Math.max(MIN_OVERRIDE_PAUSE, seconds));
}

/** Milliseconds from the database into the seconds the timeline works in. */
export function pauseFromMs(ms: number | null | undefined): number | undefined {
  if (ms === null || ms === undefined) return undefined;
  if (!Number.isFinite(ms)) return undefined;
  return ms / 1000;
}

/**
 * Lay the lines out in order, with a pause between each.
 *
 * `plannedDuration` is what the script asked the visuals to run for. When the
 * speech is longer the scene is extended, never the other way round: cutting
 * the picture while someone is still talking is the one outcome neither figure
 * should be allowed to cause.
 */
export function buildSceneTimeline(
  lines: TimelineInput[],
  plannedDuration: number,
): SceneTimeline {
  const ordered = [...lines].sort((a, b) => a.lineNumber - b.lineNumber);
  const entries: TimelineEntry[] = [];

  let cursor = 0;
  let previousSpeaker: string | null = null;

  for (let i = 0; i < ordered.length; i += 1) {
    const line = ordered[i];
    if (!line) continue;

    const speakerChanged = previousSpeaker !== null && line.speaker !== previousSpeaker;
    const duration = Math.max(0, line.durationSec);

    // The pause belongs AFTER a line, and is decided by what follows it: a
    // change of speaker needs more room than the same person continuing.
    const next = ordered[i + 1];
    const isLast = next === undefined;
    const naturalPause =
      next && next.speaker !== line.speaker
        ? DEFAULT_PAUSE_SPEAKER_CHANGE
        : DEFAULT_PAUSE_SAME_SPEAKER;
    const pauseAfterSec = isLast
      ? 0
      : line.pauseAfterOverride === undefined
        ? clampPause(naturalPause)
        : clampOverridePause(line.pauseAfterOverride);

    entries.push({
      lineNumber: line.lineNumber,
      speaker: line.speaker,
      text: line.text,
      audioPath: line.audioPath,
      startSec: round(cursor),
      durationSec: round(duration),
      endSec: round(cursor + duration),
      pauseAfterSec: round(pauseAfterSec),
      speakerChanged,
    });

    cursor += duration + pauseAfterSec;
    previousSpeaker = line.speaker;
  }

  const speechDurationSec = round(cursor);
  const sceneDurationSec = round(Math.max(plannedDuration, speechDurationSec));

  return {
    entries,
    speechDurationSec,
    sceneDurationSec,
    extended: speechDurationSec > plannedDuration,
  };
}

/** True when any two lines would be heard at once. Should never happen. */
export function hasOverlap(timeline: SceneTimeline): boolean {
  for (let i = 1; i < timeline.entries.length; i += 1) {
    const previous = timeline.entries[i - 1];
    const current = timeline.entries[i];
    if (!previous || !current) continue;
    if (current.startSec < previous.endSec) return true;
  }
  return false;
}

/** Where each scene starts on the finished video's clock. */
export function projectOffsets(timelines: SceneTimeline[]): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const timeline of timelines) {
    offsets.push(round(cursor));
    cursor += timeline.sceneDurationSec;
  }
  return offsets;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
