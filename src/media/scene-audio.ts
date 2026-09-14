import fs from "node:fs";
import path from "node:path";
import { ffmpeg, FfmpegError } from "./ffmpeg";
import { measureLoudness, type LoudnessStats } from "./audio-normalize";
import {
  resolveMix,
  ratioForDuck,
  thresholdForDuck,
  type AudioMixSettings,
} from "./mix-config";
import type { SceneTimeline } from "@/domain/scene-timeline";

/**
 * Turning a scene's timeline into one audio file, and then into a mix.
 *
 * The per-line clips are never discarded. A line is the unit that gets
 * regenerated when a delivery is wrong, and rebuilding the whole scene to fix
 * one word would mean paying for every other line again.
 *
 * Every output here is PCM until the final encode. Stacking lossy generations -
 * decode, mix, re-encode, mix again - audibly degrades speech, and the only
 * reason to accept that is file size, which is irrelevant to an intermediate.
 */

/** Working format. Matches what TTS returns, so nothing resamples needlessly. */
export const WORK_SAMPLE_RATE = 24000;

export interface SceneAudioResult {
  outputPath: string;
  /** MEASURED, not the sum of the parts. */
  durationSec: number;
  loudness: LoudnessStats;
  lineCount: number;
}

/**
 * Render one scene's dialogue into a single track.
 *
 * Each line is delayed to its own start time and the lot are summed, rather
 * than concatenated with silence spliced between. Summing means a line's
 * position comes from the timeline - one place, already tested - instead of
 * from the order in which files happened to be listed.
 *
 * `normalize=0` on the mix is essential: amix divides by its input count by
 * default, so a three-line scene would come out 9.5 dB quieter than a one-line
 * scene. The clips are already levelled individually; summing them must not
 * undo that.
 */
export async function renderSceneDialogue(
  timeline: SceneTimeline,
  outputPath: string,
): Promise<SceneAudioResult> {
  const entries = timeline.entries.filter((e) => e.audioPath.length > 0);
  if (entries.length === 0) {
    throw new FfmpegError("Cảnh này không có câu thoại nào để ghép.", "", []);
  }
  for (const entry of entries) {
    if (!fs.existsSync(entry.audioPath)) {
      throw new FfmpegError(
        `Thiếu tệp âm thanh cho câu ${entry.lineNumber}: ${entry.audioPath}`,
        "",
        [],
      );
    }
  }

  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const entry of entries) args.push("-i", entry.audioPath);

  // adelay wants milliseconds, and an integer: a fractional value is silently
  // truncated, which would drift a long scene out of step with its captions.
  const parts = entries.map((entry, index) => {
    const delayMs = Math.round(entry.startSec * 1000);
    return `[${index}:a]aresample=${WORK_SAMPLE_RATE},adelay=${delayMs}:all=1[d${index}]`;
  });
  const inputs = entries.map((_, index) => `[d${index}]`).join("");
  parts.push(
    `${inputs}amix=inputs=${entries.length}:duration=longest:normalize=0[mixed]`,
  );
  // Pad to the scene's full length so a scene whose visuals outlast its speech
  // still produces a track of the right duration to line up against.
  parts.push(`[mixed]apad=whole_dur=${timeline.sceneDurationSec}[out]`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  args.push(
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[out]",
    "-ar",
    String(WORK_SAMPLE_RATE),
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outputPath,
  );

  await ffmpeg(args);

  return {
    outputPath,
    durationSec: await durationOf(outputPath),
    loudness: await measureLoudness(outputPath),
    lineCount: entries.length,
  };
}

/** Join several scene tracks end to end, in order. */
export async function concatSceneDialogue(
  scenePaths: string[],
  outputPath: string,
): Promise<SceneAudioResult> {
  if (scenePaths.length === 0) {
    throw new FfmpegError("Không có cảnh nào để nối.", "", []);
  }
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const p of scenePaths) args.push("-i", p);

  const inputs = scenePaths.map((_, i) => `[${i}:a]`).join("");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  args.push(
    "-filter_complex",
    `${inputs}concat=n=${scenePaths.length}:v=0:a=1[out]`,
    "-map",
    "[out]",
    "-ar",
    String(WORK_SAMPLE_RATE),
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outputPath,
  );
  await ffmpeg(args);

  return {
    outputPath,
    durationSec: await durationOf(outputPath),
    loudness: await measureLoudness(outputPath),
    lineCount: scenePaths.length,
  };
}

/**
 * Render ONLY the ducked bed, with the dialogue driving it but not mixed in.
 *
 * Exported so ducking can be proved rather than asserted: with the voice out of
 * the way, the bed's level during speech and during a pause can be measured and
 * compared. "It has a sidechaincompress in the graph" is not evidence that the
 * music gets out of the way.
 */
export async function renderDuckedBedOnly(
  input: FinalMixInput,
  outputPath: string,
): Promise<{ outputPath: string; durationSec: number }> {
  // Built as its own graph rather than cut out of the final one. String
  // surgery on a filter graph left `[voice]` dangling as an unconnected output
  // pad, which ffmpeg rejects outright - the first version of this failed for
  // exactly that reason.
  const { graph, inputs } = buildFinalMixGraph(input, { bedOnly: true });

  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const file of inputs) {
    if (file === input.musicPath) args.push("-stream_loop", "-1");
    args.push("-i", file);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  args.push(
    "-filter_complex",
    graph,
    "-map",
    "[a]",
    "-t",
    String(await durationOf(input.dialoguePath)),
    "-ar",
    String(WORK_SAMPLE_RATE),
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outputPath,
  );
  await ffmpeg(args);
  return { outputPath, durationSec: await durationOf(outputPath) };
}

export interface FinalMixInput {
  dialoguePath: string;
  musicPath?: string | null;
  /** Effects, each with the second it lands on. */
  sfx?: { path: string; atSec: number }[];
  settings?: Partial<AudioMixSettings>;
}

export interface FinalMixResult {
  outputPath: string;
  durationSec: number;
  loudness: LoudnessStats;
  settings: AudioMixSettings;
  /** The filter graph, so a surprising mix can be explained rather than guessed at. */
  filterGraph: string;
}

/**
 * Build the filter graph for dialogue + music + effects.
 *
 * Exported separately from the render so it can be asserted in a test without
 * running ffmpeg, and so an operator can be shown exactly what produced a mix.
 *
 * Structure, and why:
 *
 *   - Dialogue is split. One copy is mixed untouched; the other only drives the
 *     sidechain, so the voice controls the music without being processed by the
 *     compressor itself.
 *   - Effects are ducked by the same sidechain as music. An effect that talks
 *     over a line is worse than music doing it, because it is louder and
 *     shorter, and the ear cannot look past it.
 *   - `normalize=0` everywhere. amix's default divides by input count, so
 *     adding a music bed would quietly drop the dialogue by 6 dB and adding one
 *     effect would drop it again.
 */
export function buildFinalMixGraph(
  input: FinalMixInput,
  opts: { bedOnly?: boolean } = {},
): {
  graph: string;
  inputs: string[];
  settings: AudioMixSettings;
} {
  const settings = resolveMix(input.settings);
  const sfx = input.sfx ?? [];
  const hasMusic = Boolean(input.musicPath);

  const files: string[] = [input.dialoguePath];
  if (input.musicPath) files.push(input.musicPath);
  for (const effect of sfx) files.push(effect.path);

  const parts: string[] = [];
  const toMix: string[] = [];

  if (!hasMusic && sfx.length === 0) {
    // Nothing to mix. Pass the dialogue through rather than building a graph
    // that sums one input, which some ffmpeg builds treat as an error.
    return {
      graph: `[0:a]aresample=${WORK_SAMPLE_RATE}[a]`,
      inputs: files,
      settings,
    };
  }

  // One copy of the voice for the mix, one to drive the sidechain.
  //
  // In bedOnly mode the voice is NOT mixed in, so it must not be split either:
  // an unconnected output pad makes ffmpeg refuse the whole graph.
  if (opts.bedOnly) {
    parts.push(`[0:a]aresample=${WORK_SAMPLE_RATE}[key]`);
  } else {
    parts.push(`[0:a]aresample=${WORK_SAMPLE_RATE},asplit=2[voice][key]`);
    toMix.push("[voice]");
  }

  // Everything that must duck is summed first, then ducked once. Ducking each
  // layer separately would apply the reduction repeatedly and leave the bed
  // inaudible whenever an effect happened to coincide with a word.
  const bedParts: string[] = [];
  let index = 1;
  if (input.musicPath) {
    parts.push(
      `[${index}:a]aresample=${WORK_SAMPLE_RATE},volume=${settings.musicGain}[music]`,
    );
    bedParts.push("[music]");
    index += 1;
  }
  sfx.forEach((effect, n) => {
    const delayMs = Math.round(Math.max(0, effect.atSec) * 1000);
    parts.push(
      `[${index + n}:a]aresample=${WORK_SAMPLE_RATE},volume=${settings.sfxGain},adelay=${delayMs}:all=1[sfx${n}]`,
    );
    bedParts.push(`[sfx${n}]`);
  });

  if (bedParts.length === 1) {
    parts.push(`${bedParts[0]}anull[bed]`);
  } else {
    parts.push(
      `${bedParts.join("")}amix=inputs=${bedParts.length}:duration=longest:normalize=0[bed]`,
    );
  }

  parts.push(
    `[bed][key]sidechaincompress=threshold=${thresholdForDuck(settings.duckDb)}` +
      `:ratio=${ratioForDuck(settings.duckDb)}` +
      `:attack=${settings.attackMs}:release=${settings.releaseMs}:makeup=1` +
      (opts.bedOnly ? "[a]" : "[ducked]"),
  );

  if (opts.bedOnly) {
    return { graph: parts.join(";"), inputs: files, settings };
  }

  toMix.push("[ducked]");
  parts.push(
    `${toMix.join("")}amix=inputs=${toMix.length}:duration=first:dropout_transition=0:normalize=0[a]`,
  );

  return { graph: parts.join(";"), inputs: files, settings };
}

/**
 * Render the final mix and measure it.
 *
 * The layers are NOT normalised individually before summing. Levelling music
 * and effects to the same target as speech would destroy the relationship the
 * mix is built on - a whisper of a bed and a shout of an effect are supposed to
 * be different sizes. Only the finished mix is measured.
 */
export async function renderFinalMix(
  input: FinalMixInput,
  outputPath: string,
): Promise<FinalMixResult> {
  const { graph, inputs, settings } = buildFinalMixGraph(input);
  for (const file of inputs) {
    if (!fs.existsSync(file)) {
      throw new FfmpegError(`Thiếu tệp âm thanh: ${file}`, "", []);
    }
  }

  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const file of inputs) {
    // Music is looped so a short bed does not leave the tail of a video silent.
    if (file === input.musicPath) args.push("-stream_loop", "-1");
    args.push("-i", file);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  args.push(
    "-filter_complex",
    graph,
    "-map",
    "[a]",
    "-ar",
    String(WORK_SAMPLE_RATE),
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outputPath,
  );
  await ffmpeg(args);

  return {
    outputPath,
    durationSec: await durationOf(outputPath),
    loudness: await measureLoudness(outputPath),
    settings,
    filterGraph: graph,
  };
}

async function durationOf(file: string): Promise<number> {
  const { ffprobe } = await import("./ffmpeg");
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
