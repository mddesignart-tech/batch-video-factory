import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpeg, ffprobe, FfmpegError } from "./ffmpeg";

/**
 * Levelling and trimming a voice clip after TTS.
 *
 * The measured test set showed why this cannot be left to the vendor: across
 * three lines from the same model, integrated loudness spanned more than ten
 * decibels.
 *
 *   Max  RMS -16.5 dBFS, peak -2.25 dBFS
 *   Mia  RMS -25.3 dBFS, peak -8.06 dBFS
 *   Leo  RMS -27.0 dBFS, peak -9.18 dBFS
 *
 * Ten decibels is not a subtlety. In a video where Max and Leo trade lines, a
 * viewer sets the volume for Leo and then gets shouted at by Max. Hand-tuning a
 * gain per character would fix these three files and break the next three, so
 * the fix has to be measurement-driven and automatic.
 */

/**
 * EBU R128 targets for dialogue.
 *
 * -16 LUFS rather than the -14 the streaming platforms use: this is speech that
 * will sit above a music bed, and leaving headroom for the mix is better than
 * printing a loud voice track and having to pull it down later.
 *
 * -1.5 dBTP rather than -1.0 because the final render re-encodes to AAC, and
 * lossy encoding can push true peak slightly above where it was measured. The
 * extra half-decibel is what stops that becoming a clip.
 */
export const VOICE_TARGET_LUFS = -16;
export const VOICE_TARGET_TRUE_PEAK = -1.5;
export const VOICE_TARGET_LRA = 7;

/** Silence quieter than this, at the very start or end, is padding not pause. */
const TRIM_THRESHOLD_DB = -45;
/** Left in place so a line never starts or ends abruptly. */
const TRIM_PAD_SECONDS = 0.08;

export interface LoudnessStats {
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
  threshold: number;
  /** Gain loudnorm would apply, from its own first-pass analysis. */
  targetOffset: number;
}

export interface NormalizeResult {
  outputPath: string;
  before: LoudnessStats;
  after: LoudnessStats;
  /** Seconds removed from the head and tail. */
  trimmedSeconds: number;
  /** MEASURED after everything, never predicted. */
  durationSec: number;
}

function parseLoudnormJson(text: string): LoudnessStats | null {
  // loudnorm prints its JSON to stderr after the progress output, so the last
  // balanced brace block is the one to read.
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, string>;
    const num = (key: string): number => {
      const v = Number.parseFloat(raw[key] ?? "");
      return Number.isFinite(v) ? v : 0;
    };
    return {
      integratedLufs: num("input_i"),
      truePeakDb: num("input_tp"),
      lra: num("input_lra"),
      threshold: num("input_thresh"),
      targetOffset: num("target_offset"),
    };
  } catch {
    return null;
  }
}

/**
 * Measure a file without changing it.
 *
 * Exported so a test, a script or a report can state real numbers rather than
 * claiming a file "sounds right".
 */
export async function measureLoudness(file: string): Promise<LoudnessStats> {
  const result = await ffmpeg([
    "-hide_banner",
    "-nostats",
    "-i",
    file,
    "-af",
    `loudnorm=I=${VOICE_TARGET_LUFS}:TP=${VOICE_TARGET_TRUE_PEAK}:LRA=${VOICE_TARGET_LRA}:print_format=json`,
    "-f",
    "null",
    "-",
  ]);
  const stats = parseLoudnormJson(`${result.stdout}${result.stderr}`);
  if (!stats) {
    throw new FfmpegError("Không đọc được kết quả đo loudness.", result.stderr, []);
  }
  return stats;
}

async function durationOf(file: string): Promise<number> {
  const { stdout } = await ffprobe([
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const value = Number.parseFloat(stdout.trim());
  return Number.isFinite(value) ? value : 0;
}

/**
 * Trim dead air from the head and tail, then level to the dialogue target.
 *
 * Two passes, not one. Single-pass loudnorm works from a running estimate and
 * drifts on short clips - exactly what these are. The first pass measures the
 * whole file, the second applies the correction with those measurements handed
 * to it, which is the difference between "roughly -16" and -16.
 *
 * Trimming happens FIRST. Leading silence drags the measured window without
 * contributing loudness, and removing it afterwards would invalidate the
 * measurement the levelling was based on.
 *
 * Interior pauses are never touched. Max's timing is part of the comedy, and a
 * filter that cannot tell a comic beat from dead air must not be allowed to
 * guess.
 *
 * IN-PLACE IS SAFE: `outputPath` may equal `inputPath`. The source is measured
 * and copied into a temporary file before anything is written back, so the
 * original is never read after it has been overwritten.
 */
export async function normalizeVoiceClip(
  inputPath: string,
  outputPath: string,
): Promise<NormalizeResult> {
  if (!fs.existsSync(inputPath)) {
    throw new FfmpegError(`Không tìm thấy tệp âm thanh ${inputPath}.`, "", []);
  }

  const before = await measureLoudness(inputPath);
  const originalDuration = await durationOf(inputPath);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "voicenorm-"));
  const trimmed = path.join(work, "trimmed.wav");

  try {
    // `areverse` twice is the standard way to reach the tail: silenceremove
    // only works on the head, so the file is flipped, trimmed, and flipped back.
    const trimFilter = [
      `silenceremove=start_periods=1:start_silence=${TRIM_PAD_SECONDS}:start_threshold=${TRIM_THRESHOLD_DB}dB:detection=peak`,
      "areverse",
      `silenceremove=start_periods=1:start_silence=${TRIM_PAD_SECONDS}:start_threshold=${TRIM_THRESHOLD_DB}dB:detection=peak`,
      "areverse",
    ].join(",");

    await ffmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-af",
      trimFilter,
      "-c:a",
      "pcm_s16le",
      trimmed,
    ]);

    const trimmedDuration = await durationOf(trimmed);
    const measured = await measureLoudness(trimmed);

    // Second pass, handed the first pass's numbers. `linear=true` asks for a
    // single gain change rather than dynamic compression, which keeps the
    // performance intact - the whole reason for choosing a model that acts.
    const applyFilter =
      `loudnorm=I=${VOICE_TARGET_LUFS}:TP=${VOICE_TARGET_TRUE_PEAK}:LRA=${VOICE_TARGET_LRA}` +
      `:measured_I=${measured.integratedLufs}` +
      `:measured_TP=${measured.truePeakDb}` +
      `:measured_LRA=${measured.lra}` +
      `:measured_thresh=${measured.threshold}` +
      `:offset=${measured.targetOffset}` +
      `:linear=true:print_format=summary`;

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await ffmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      trimmed,
      "-af",
      applyFilter,
      // loudnorm resamples to 192 kHz internally; bring it back to something
      // the rest of the pipeline and every player handle without resampling.
      "-ar",
      "24000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      outputPath,
    ]);

    let after = await measureLoudness(outputPath);

    // True-peak guard.
    //
    // loudnorm's linear mode limits its gain using the FIRST pass's true-peak
    // estimate, but it resamples internally and the printed result can land a
    // few tenths of a decibel above the ceiling - Leo came out at -1.26 dBTP
    // against a -1.5 target on the first real run. That margin exists to
    // survive the AAC encode in the final render, so overshooting it defeats
    // the point of having it.
    //
    // The correction is one exact gain change, computed from the measurement:
    // no limiter, no compression, nothing that would alter the performance.
    if (after.truePeakDb > VOICE_TARGET_TRUE_PEAK) {
      const trimDb = VOICE_TARGET_TRUE_PEAK - after.truePeakDb;
      const corrected = path.join(work, "peak-corrected.wav");
      await ffmpeg([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        outputPath,
        "-af",
        `volume=${trimDb.toFixed(3)}dB`,
        "-ar",
        "24000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        corrected,
      ]);
      fs.copyFileSync(corrected, outputPath);
      after = await measureLoudness(outputPath);
    }

    // Peak-bound recovery.
    //
    // Some lines hit the true-peak ceiling before their loudness reaches the
    // target, and a single linear gain cannot take them further. Leo's scene-2
    // line landed at -19.29 LUFS against a -16 target - about 6 dB quieter than
    // its neighbours in the finished video, which is plainly audible.
    //
    // The fix is a gain lift with a lookahead limiter catching the few peaks
    // that would otherwise clip. It is deliberately SMALL: at most 3 dB of
    // makeup, so the limiter only ever touches transients. Past that a voice
    // starts to sound squashed, and the whole reason for choosing a model that
    // acts is to keep the acting.
    //
    // Accepting -17 is fine. Chasing the last decibel is what ruins a take.
    if (after.integratedLufs < PEAK_BOUND_FLOOR_LUFS) {
      const recovered = await recoverPeakBound(outputPath, after, work);
      if (recovered) after = recovered;
    }
    // Duration is measured on the FINISHED file, after trim, normalisation and
    // encode. A figure taken any earlier would drift from what the subtitles
    // have to line up against.
    const durationSec = await durationOf(outputPath);

    return {
      outputPath,
      before,
      after,
      trimmedSeconds: Math.max(0, originalDuration - trimmedDuration),
      durationSec,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Loudness below which a peak-bound clip is worth rescuing.
 *
 * -17 is the quietest a line may be and still sit comfortably beside one at
 * -16: about a decibel, which is near the threshold most listeners notice.
 */
export const PEAK_BOUND_FLOOR_LUFS = -17;

/**
 * Largest makeup gain the recovery will apply.
 *
 * Three decibels is where a limiter stops catching occasional transients and
 * starts flattening the delivery. A clip that needs more than this has a
 * problem gain cannot fix.
 */
export const MAX_MAKEUP_DB = 3;

/**
 * Lift a peak-bound clip towards the target with a gentle limiter.
 *
 * Returns the new measurement, or null when nothing was changed - which happens
 * when the shortfall is too large for the makeup ceiling to help, and leaving
 * the clip quiet is better than squashing it.
 */
async function recoverPeakBound(
  outputPath: string,
  current: LoudnessStats,
  work: string,
): Promise<LoudnessStats | null> {
  const shortfall = VOICE_TARGET_LUFS - current.integratedLufs;
  if (shortfall <= 0) return null;

  const makeup = Math.min(MAX_MAKEUP_DB, shortfall);

  // The limiter works on SAMPLE peak; the target is TRUE peak, which can sit
  // a few tenths higher after reconstruction. Aiming 0.5 dB below the ceiling
  // absorbs that difference instead of discovering it in the measurement.
  const limitDb = VOICE_TARGET_TRUE_PEAK - 0.5;
  const limitLinear = 10 ** (limitDb / 20);

  const lifted = path.join(work, "peak-recovered.wav");
  await ffmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    outputPath,
    "-af",
    // Gain first, then catch only what pokes above the ceiling. 5ms attack is
    // fast enough for speech transients; 50ms release lets it recover between
    // syllables rather than pumping across a word.
    `volume=${makeup.toFixed(3)}dB,` +
      `alimiter=limit=${limitLinear.toFixed(5)}:attack=5:release=50:level=false`,
    "-ar",
    "24000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    lifted,
  ]);

  let after = await measureLoudness(lifted);
  let candidate = lifted;

  // The limiter holds SAMPLE peak; the ceiling is TRUE peak, and the gap
  // between them is larger than intuition suggests. Limiting to -2.0 dBFS on
  // this clip produced -1.22 dBTP: inter-sample peaks 0.78 dB above the samples
  // the limiter could see. So the result is measured and trimmed by exactly the
  // overshoot rather than guessed at with a wider margin, which would give away
  // loudness on every clip to cover the worst one.
  if (after.truePeakDb > VOICE_TARGET_TRUE_PEAK) {
    const trimDb = VOICE_TARGET_TRUE_PEAK - after.truePeakDb;
    const trimmed = path.join(work, "peak-recovered-trimmed.wav");
    await ffmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      lifted,
      "-af",
      `volume=${trimDb.toFixed(3)}dB`,
      "-ar",
      "24000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      trimmed,
    ]);
    after = await measureLoudness(trimmed);
    candidate = trimmed;
  }

  // Only keep it if it actually helped AND stayed under the ceiling. A
  // "recovery" that clips is worse than the quiet original, and one that gains
  // nothing is limiting for no reason.
  if (
    after.integratedLufs > current.integratedLufs + 0.5 &&
    after.truePeakDb <= VOICE_TARGET_TRUE_PEAK + 0.05
  ) {
    fs.copyFileSync(candidate, outputPath);
    return after;
  }
  return null;
}

/** Is this clip already inside the tolerances the mix expects? */
export function withinVoiceTargets(
  stats: LoudnessStats,
  toleranceLu = 1,
): boolean {
  return (
    Math.abs(stats.integratedLufs - VOICE_TARGET_LUFS) <= toleranceLu &&
    stats.truePeakDb <= VOICE_TARGET_TRUE_PEAK + 0.2
  );
}
