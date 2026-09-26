/**
 * Voice-aware scene timing - the ONE place a scene's length is decided.
 *
 * Before V1.2 a scene lasted max(planned, speech): a 5s scene with 2s of speech
 * played 3s of silence. Here the speech drives the length, inside rules that are
 * small enough to predict:
 *
 *   target = paddingBefore + voice + paddingAfter
 *
 *   AUTO     final = target (clamped to the scene bounds; a scene WITHOUT voice
 *            keeps its planned length, never below its visual minimum)
 *   MINIMUM  final = max(planned, target)
 *   LOCKED   final = planned - unless the voice does not fit, in which case the
 *            scene is RAISED to fit it (reason LOCKED_RAISED_FOR_VOICE). Speech
 *            is never cut to honour a number.
 *
 * Then the one thing timing can never buy its way out of: a VIDEO_AI clip that
 * was already paid for.
 *
 *   final <= clip                  trim locally (FFmpeg), no request
 *   final >  clip, voice fits clip with the smallest padding  -> fit locally
 *   overflow <= MAX_FREEZE_EXTENSION                          -> hold the last
 *                                                                frame locally
 *   overflow >  MAX_FREEZE_EXTENSION                          -> BLOCKED
 *
 * BLOCKED means MEDIA_REGEN_REQUIRED: only a new clip would fit the speech, and
 * a new clip is a purchase that needs a person's approval. Timing never makes
 * one, never re-buys a voice or an image, never changes provider, never slows a
 * clip down. Everything this module decides is RENDER_ONLY_CHANGE: local, $0.
 *
 * Nothing here reads a file or the database: every fact (measured voice
 * length, measured clip length) is handed in, so every rule is unit tested.
 */

export const DURATION_MODES = ["AUTO", "MINIMUM", "LOCKED"] as const;
export type DurationMode = (typeof DURATION_MODES)[number];

export interface TimingConfig {
  /** Silence before the first word, so a cut does not land on a syllable. */
  voicePaddingBefore: number;
  /** Silence after the last word, so a line can land before the next cut. */
  voicePaddingAfter: number;
  /** The least padding accepted when a paid clip is the limit. */
  minPaddingBefore: number;
  minPaddingAfter: number;
  minSceneDuration: number;
  maxSceneDuration: number;
  /** Visual floors for a scene with no voice. */
  minStaticDuration: number;
  minLocalMotionDuration: number;
  /** Longest last-frame hold allowed to fit speech onto a paid clip. */
  maxFreezeExtension: number;
  /** A LOCAL_MOTION scene longer than this is flagged: one slow push gets thin. */
  localMotionLongWarn: number;
}

export const DEFAULT_TIMING: TimingConfig = {
  voicePaddingBefore: 0.15,
  voicePaddingAfter: 0.35,
  minPaddingBefore: 0,
  minPaddingAfter: 0.1,
  minSceneDuration: 1.5,
  maxSceneDuration: 15,
  minStaticDuration: 2.0,
  minLocalMotionDuration: 2.5,
  maxFreezeExtension: 1.0,
  localMotionLongWarn: 8,
};

/** Why a scene ended up the length it did. Stable codes: tests and UI key on them. */
export const TIMING_REASONS = [
  "VOICE_PADDED", // AUTO: voice + padding
  "VOICE_PADDED_MIN_CLAMP", // AUTO: voice + padding was below the scene minimum
  "VOICE_EXCEEDS_MAX", // voice + padding is above max_duration: kept whole, not cut
  "MINIMUM_PLANNED", // MINIMUM: planned was longer than the voice needed
  "MINIMUM_VOICE", // MINIMUM: voice needed more than planned
  "LOCKED_PLANNED", // LOCKED: planned kept, voice fits
  "LOCKED_RAISED_FOR_VOICE", // LOCKED: raised so the voice is not cut
  "NO_VOICE_PLANNED", // no voice: planned kept
  "NO_VOICE_VISUAL_MIN", // no voice: raised to the visual minimum
  "CLIP_TRIMMED_LOCAL", // VIDEO_AI clip longer than needed: trimmed with FFmpeg
  "CLIP_FIT_REDUCED_PADDING", // voice fits the paid clip once padding is reduced
  "CLIP_FREEZE_EXTENDED", // last frame held (<= maxFreezeExtension)
  "CLIP_CAPPED_NO_VOICE", // no voice, planned longer than clip + hold: capped
  "CLIP_TOO_SHORT_FOR_VOICE", // BLOCKED: only a new clip would fit
] as const;
export type TimingReason = (typeof TIMING_REASONS)[number];

export type TimingChange = "RENDER_ONLY_CHANGE" | "MEDIA_REGEN_REQUIRED";

export interface SceneTimingInput {
  sceneNumber: number;
  /** What the storyboard / script asked for. Never overwritten. */
  plannedDuration: number;
  durationMode?: DurationMode | null;
  minDuration?: number | null;
  maxDuration?: number | null;
  /** Measured speech length (lines + pauses), 0 or null = no voice. */
  voiceDuration: number | null;
  /** True when voiceDuration came from a text estimate, not a measured file. */
  voiceEstimated?: boolean;
  /** How the picture moves. STATIC = a still with no motion at all. */
  motion: "VIDEO_AI" | "LOCAL_MOTION" | "STATIC";
  /** Measured length of the paid clip, when there is one on disk. */
  clipDuration?: number | null;
}

export interface SceneTiming {
  sceneNumber: number;
  plannedDuration: number;
  voiceDuration: number | null;
  voiceEstimated: boolean;
  visualMinimumDuration: number;
  finalDuration: number;
  /** Where speech starts inside the scene. */
  leadInSec: number;
  durationMode: DurationMode;
  timingReason: TimingReason;
  /** Seconds of last-frame hold after a paid clip ends. 0 when none. */
  freezeSec: number;
  /** Seconds cut off the end of a paid clip, locally. 0 when none. */
  trimmedSec: number;
  blocked: boolean;
  change: TimingChange;
  /** Human sentence, Vietnamese, for logs and the UI. */
  message: string;
  warnings: string[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function parseDurationMode(value: unknown): DurationMode {
  const v = String(value ?? "").trim().toUpperCase();
  return (DURATION_MODES as readonly string[]).includes(v) ? (v as DurationMode) : "AUTO";
}

/** Rough speaking time for PREFLIGHT only: ~2.6 words/second. Never used once audio exists. */
export function estimateVoiceDuration(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return r3(Math.max(0.6, words / 2.6));
}

export function resolveSceneDuration(
  input: SceneTimingInput,
  config: TimingConfig = DEFAULT_TIMING,
): SceneTiming {
  const mode = input.durationMode ?? "AUTO";
  const planned = Math.max(0, input.plannedDuration);
  const voice = input.voiceDuration && input.voiceDuration > 0 ? input.voiceDuration : null;
  const warnings: string[] = [];

  const floor = Math.max(config.minSceneDuration, input.minDuration ?? 0);
  const ceiling = Math.min(config.maxSceneDuration, input.maxDuration ?? Infinity);
  const visualMinimum =
    input.motion === "STATIC"
      ? config.minStaticDuration
      : input.motion === "LOCAL_MOTION"
        ? config.minLocalMotionDuration
        : config.minSceneDuration;

  let final: number;
  let reason: TimingReason;
  let leadIn = voice ? config.voicePaddingBefore : 0;

  if (voice) {
    const target = config.voicePaddingBefore + voice + config.voicePaddingAfter;
    if (mode === "MINIMUM") {
      final = Math.max(planned, target);
      reason = planned >= target ? "MINIMUM_PLANNED" : "MINIMUM_VOICE";
    } else if (mode === "LOCKED") {
      if (planned >= target) {
        final = planned;
        reason = "LOCKED_PLANNED";
      } else {
        final = target;
        reason = "LOCKED_RAISED_FOR_VOICE";
        warnings.push(
          `Cảnh ${input.sceneNumber} khoá ${planned.toFixed(2)}s nhưng lời thoại cần ${target.toFixed(2)}s — ` +
            `đã nâng cho đủ lời, không cắt lời.`,
        );
      }
    } else if (target < floor) {
      final = floor;
      reason = "VOICE_PADDED_MIN_CLAMP";
    } else {
      final = target;
      reason = "VOICE_PADDED";
    }
    if (final > ceiling) {
      if (target > ceiling) {
        // The bound is honoured only as far as it does not cut speech.
        final = Math.max(target, ceiling);
        reason = "VOICE_EXCEEDS_MAX";
        warnings.push(
          `Cảnh ${input.sceneNumber}: lời thoại cần ${target.toFixed(2)}s, vượt max ${ceiling.toFixed(2)}s — giữ đủ lời.`,
        );
      } else {
        final = ceiling;
      }
    }
  } else {
    // No voice: the storyboard's length stands, above the visual floor.
    const low = Math.max(visualMinimum, input.minDuration ?? 0);
    if (planned >= low) {
      final = Math.min(planned, Math.max(low, ceiling));
      reason = "NO_VOICE_PLANNED";
    } else {
      final = low;
      reason = "NO_VOICE_VISUAL_MIN";
    }
  }

  // ---- a paid clip is a fixed length: fit locally, or stop ----------------
  let freeze = 0;
  let trimmed = 0;
  let blocked = false;
  const clip = input.motion === "VIDEO_AI" && input.clipDuration && input.clipDuration > 0 ? input.clipDuration : null;
  if (clip !== null) {
    if (final <= clip) {
      trimmed = clip - final;
      if (trimmed > 0.05) reason = "CLIP_TRIMMED_LOCAL";
    } else if (voice) {
      const tight = config.minPaddingBefore + voice + config.minPaddingAfter;
      if (tight <= clip) {
        // Shorter padding, same words: the clip is enough.
        leadIn = Math.min(config.voicePaddingBefore, Math.max(config.minPaddingBefore, clip - voice - config.minPaddingAfter));
        final = clip;
        reason = "CLIP_FIT_REDUCED_PADDING";
      } else if (tight - clip <= config.maxFreezeExtension) {
        const room = clip + config.maxFreezeExtension;
        final = Math.min(Math.max(final, tight), room);
        leadIn = Math.min(config.voicePaddingBefore, Math.max(config.minPaddingBefore, final - voice - config.minPaddingAfter));
        freeze = final - clip;
        reason = "CLIP_FREEZE_EXTENDED";
      } else {
        blocked = true;
        reason = "CLIP_TOO_SHORT_FOR_VOICE";
        final = tight;
        freeze = final - clip;
      }
    } else {
      // No voice: a planned length the clip cannot fill is a wish, not speech.
      if (final - clip <= config.maxFreezeExtension) {
        freeze = final - clip;
        reason = "CLIP_FREEZE_EXTENDED";
      } else {
        final = clip + config.maxFreezeExtension;
        freeze = config.maxFreezeExtension;
        reason = "CLIP_CAPPED_NO_VOICE";
        warnings.push(
          `Cảnh ${input.sceneNumber}: dự kiến ${planned.toFixed(2)}s nhưng clip chỉ ${clip.toFixed(2)}s — ` +
            `giữ khung cuối ${config.maxFreezeExtension.toFixed(1)}s rồi dừng, không mua clip mới.`,
        );
      }
    }
  }

  if (input.motion === "LOCAL_MOTION" && final > config.localMotionLongWarn) {
    warnings.push(
      `Cảnh ${input.sceneNumber}: LOCAL_MOTION dài ${final.toFixed(1)}s — một cú đẩy chậm trên ảnh tĩnh có thể trông đơn điệu.`,
    );
  }

  const finalDuration = r3(final);
  const message = blocked
    ? `Cảnh ${input.sceneNumber}: lời thoại cần ${finalDuration.toFixed(2)}s nhưng clip đã mua chỉ ${clip!.toFixed(2)}s ` +
      `(giữ khung cuối tối đa ${config.maxFreezeExtension.toFixed(1)}s). MEDIA_REGEN_REQUIRED — cần clip mới, ` +
      `phải duyệt lại; hệ thống KHÔNG tự mua.`
    : `Cảnh ${input.sceneNumber}: ${planned.toFixed(2)}s → ${finalDuration.toFixed(2)}s (${reason}` +
      (voice ? `, lời ${voice.toFixed(2)}s${input.voiceEstimated ? " ước tính" : ""}` : ", không lời") +
      (freeze > 0.001 ? `, giữ khung ${freeze.toFixed(2)}s` : "") +
      (trimmed > 0.001 ? `, cắt clip ${trimmed.toFixed(2)}s tại máy` : "") +
      `)`;

  return {
    sceneNumber: input.sceneNumber,
    plannedDuration: r3(planned),
    voiceDuration: voice === null ? null : r3(voice),
    voiceEstimated: Boolean(input.voiceEstimated && voice),
    visualMinimumDuration: r3(visualMinimum),
    finalDuration,
    leadInSec: r3(leadIn),
    durationMode: mode,
    timingReason: reason,
    freezeSec: r3(Math.max(0, freeze)),
    trimmedSec: r3(Math.max(0, trimmed)),
    blocked,
    change: blocked ? "MEDIA_REGEN_REQUIRED" : "RENDER_ONLY_CHANGE",
    message,
    warnings,
  };
}

export interface VideoTiming {
  scenes: SceneTiming[];
  plannedTotal: number;
  finalTotal: number;
  blocked: SceneTiming[];
}

export function resolveVideoTiming(inputs: SceneTimingInput[], config: TimingConfig = DEFAULT_TIMING): VideoTiming {
  const scenes = inputs.map((i) => resolveSceneDuration(i, config));
  return {
    scenes,
    plannedTotal: r3(scenes.reduce((n, s) => n + s.plannedDuration, 0)),
    finalTotal: r3(scenes.reduce((n, s) => n + s.finalDuration, 0)),
    blocked: scenes.filter((s) => s.blocked),
  };
}

/** "Đã tối ưu nhịp: 26s → 21.8s" - or null when nothing moved enough to mention. */
export function pacingSummary(plannedTotal: number, finalTotal: number): string | null {
  if (Math.abs(plannedTotal - finalTotal) < 0.5) return null;
  const fmt = (n: number) => (Number.isInteger(Math.round(n * 10) / 10) ? n.toFixed(0) : n.toFixed(1));
  return `Đã tối ưu nhịp: ${fmt(plannedTotal)}s → ${fmt(finalTotal)}s`;
}

export class TimingBlockedError extends Error {
  /** Retrying cannot help: only a new clip (a purchase needing approval) would. */
  readonly retryable = false;
  constructor(readonly scenes: SceneTiming[]) {
    super(
      `TIMING BLOCKED (MEDIA_REGEN_REQUIRED): ` +
        scenes.map((s) => s.message).join(" ") +
        ` Không có request trả phí nào được gửi.`,
    );
    this.name = "TimingBlockedError";
  }
}
