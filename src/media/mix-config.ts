/**
 * How the three audio layers sit against each other.
 *
 * Every number here is a knob an operator can turn, with a default that is safe
 * rather than impressive. The defaults were chosen so that a project rendered
 * without touching any of them still has intelligible speech, which is the only
 * property that matters in a video whose purpose is teaching a phrase.
 *
 * The ordering rule, which nothing below may override: dialogue is the signal.
 * Music and effects are context, and context that covers the words has stopped
 * being context.
 */

export interface AudioMixSettings {
  /** Music level when nobody is speaking, as a linear gain. */
  musicGain: number;
  /**
   * How far music drops under speech, in decibels.
   *
   * Expressed as a positive number of dB of reduction, because "duck by 12 dB"
   * is how a person describes it, and a ratio is not.
   */
  duckDb: number;
  /** Milliseconds for the duck to take hold. Fast enough to catch a word's start. */
  attackMs: number;
  /**
   * Milliseconds for music to return.
   *
   * Slow on purpose. A fast release makes the bed surge between syllables,
   * which is more distracting than music that never ducked at all.
   */
  releaseMs: number;
  /** Sound-effect level, as a linear gain. */
  sfxGain: number;
}

/**
 * Defaults, deliberately conservative.
 *
 * Music at 0.25 and a 12 dB duck leaves speech clearly on top even when a line
 * is quiet, at the cost of a bed that some would call too polite. That is the
 * right way round to be wrong.
 *
 * SFX sit below music because an effect is momentary and loud by nature; a
 * gain that sounds right in isolation lands on top of a word in context.
 */
export const DEFAULT_MIX: AudioMixSettings = {
  musicGain: 0.25,
  duckDb: 12,
  attackMs: 20,
  releaseMs: 350,
  sfxGain: 0.5,
};

const BOUNDS = {
  musicGain: [0, 1] as const,
  duckDb: [0, 30] as const,
  attackMs: [1, 500] as const,
  releaseMs: [20, 2000] as const,
  sfxGain: [0, 1] as const,
};

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Bring a partial, possibly nonsensical settings object into range.
 *
 * Clamping rather than rejecting: these arrive from a settings form, and a
 * typed-in 500 should produce a loud mix, not a failed render.
 */
export function resolveMix(partial: Partial<AudioMixSettings> = {}): AudioMixSettings {
  return {
    musicGain: clamp(
      partial.musicGain ?? DEFAULT_MIX.musicGain,
      ...BOUNDS.musicGain,
      DEFAULT_MIX.musicGain,
    ),
    duckDb: clamp(partial.duckDb ?? DEFAULT_MIX.duckDb, ...BOUNDS.duckDb, DEFAULT_MIX.duckDb),
    attackMs: clamp(
      partial.attackMs ?? DEFAULT_MIX.attackMs,
      ...BOUNDS.attackMs,
      DEFAULT_MIX.attackMs,
    ),
    releaseMs: clamp(
      partial.releaseMs ?? DEFAULT_MIX.releaseMs,
      ...BOUNDS.releaseMs,
      DEFAULT_MIX.releaseMs,
    ),
    sfxGain: clamp(
      partial.sfxGain ?? DEFAULT_MIX.sfxGain,
      ...BOUNDS.sfxGain,
      DEFAULT_MIX.sfxGain,
    ),
  };
}

/**
 * Compression ratio for the duck. Fixed, deliberately.
 *
 * Measurement showed ratio barely moves the depth: holding the threshold and
 * sweeping the ratio from 4 to 20 changed the reduction by about 1.5 dB. The
 * threshold is what actually decides how far the music drops, so that is the
 * parameter `duckDb` steers, and the ratio stays at a value that sounds like a
 * duck rather than a gate.
 */
export const DUCK_RATIO = 8;

/** Kept for callers and tests that ask for the ratio by name. */
export function ratioForDuck(duckDb: number): number {
  return duckDb <= 0 ? 1 : DUCK_RATIO;
}

/**
 * Sidechain threshold, as a linear amplitude, that actually produces `duckDb`.
 *
 * The first version of this knob was labelled in decibels and delivered about
 * half of what it promised: asking for 12 dB gave 6.3 dB. A control that lies
 * by a factor of two is worse than one with an arbitrary scale, because the
 * operator trusts the number.
 *
 * Calibrated by measuring real reductions on a speech-and-silence fixture at
 * ratio 8:
 *
 *   threshold 0.02  (-34 dBFS) ->  6.4 dB
 *   threshold 0.005 (-46 dBFS) -> 16.9 dB
 *   threshold 0.001 (-60 dBFS) -> 29.2 dB
 *
 * which is close to linear in the log domain at about 0.87 dB of reduction per
 * decibel of threshold. The fit is inverted here to go from a wanted reduction
 * to the threshold that produces it.
 */
export function thresholdForDuck(duckDb: number): number {
  if (duckDb <= 0) return 0.99; // effectively never engages
  const BASE_THRESHOLD_DB = -34;
  const BASE_REDUCTION_DB = 6.4;
  const SLOPE = 0.87;
  const thresholdDb =
    BASE_THRESHOLD_DB - (duckDb - BASE_REDUCTION_DB) / SLOPE;
  const linear = 10 ** (Math.max(-70, Math.min(-20, thresholdDb)) / 20);
  return Math.round(linear * 1e5) / 1e5;
}
