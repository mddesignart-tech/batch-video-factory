import fs from "node:fs";
import path from "node:path";
import { ffmpeg, FfmpegError } from "./ffmpeg";
import { measureLoudness } from "./audio-normalize";
import {
  duckVolumeExpression,
  LIMITER_CEILING,
  musicGainDb,
  type SpeechRegion,
} from "@/domain/audio-mixer";

/**
 * AUDIO MIXER render (QĐ-150). Builds the final audio from the SOURCE tracks -
 * dialogue, one music file, effects - never from a finished MP4.
 *
 *   voice : the joined dialogue, its level, centred in stereo (-3 dB a side,
 *           same loudness as the mono track).
 *   bed   : the music looped/trimmed to the video, brought to the reference
 *           loudness and the chosen %, faded in/out ONCE (start and end of the
 *           video only), plus the effects; then ducked by the timeline curve.
 *   mix   : voice + bed (no normalisation), a safety limiter at ~-1 dBFS.
 *
 * Output: 48 kHz stereo PCM - the old mix was mono 24 kHz, which folded the
 * music to mono and cut everything above 12 kHz.
 */

export const MIX_SAMPLE_RATE = 48000;

export interface MixerRenderSettings {
  /** 0..2. */
  musicPct: number;
  /** 0 = no duck. */
  duckDb: number;
  attackMs: number;
  releaseMs: number;
  fadeInSec: number;
  fadeOutSec: number;
  /** Effects, linear 0..1. */
  sfxGain: number;
  voice: { gain: number; normalize: boolean };
}

export interface MixerMixInput {
  dialoguePath: string;
  /** The video's length; every track is cut or padded to it. */
  totalSec: number;
  /** Where the lines are, on the video's clock. */
  regions: readonly SpeechRegion[];
  musicPath?: string | null;
  /** Measured loudness of the music file; null = not measured (no reference correction). */
  musicLufs?: number | null;
  sfx?: readonly { path: string; atSec: number }[];
  settings: MixerRenderSettings;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The filter graph and its inputs, in order. Input 0 is the dialogue, then the
 * music (opened with -stream_loop -1 by the caller), then each effect.
 * `window` cuts a preview out of the finished mix (the curve keeps the video's
 * clock, so a preview sounds exactly like that moment of the full render).
 */
export function buildMixerGraph(
  input: MixerMixInput,
  opts: { window?: { startSec: number; endSec: number } } = {},
): { graph: string; inputs: string[]; musicGainDb: number | null; duckExpression: string | null } {
  const s = input.settings;
  const total = r3(Math.max(0.01, input.totalSec));
  const files = [input.dialoguePath];
  const parts: string[] = [];

  const voiceFx = `${s.voice.gain !== 1 ? `,volume=${r3(s.voice.gain)}` : ""}${s.voice.normalize ? ",loudnorm=I=-16:TP=-1.5:LRA=11" : ""}`;
  parts.push(
    `[0:a]aformat=channel_layouts=mono${voiceFx},aresample=${MIX_SAMPLE_RATE},` +
      `pan=stereo|c0=0.7071*c0|c1=0.7071*c0,apad=whole_dur=${total},atrim=0:${total}[voice]`,
  );

  const bed: string[] = [];
  const gainDb = input.musicPath ? musicGainDb(input.musicLufs ?? null, s.musicPct) : null;
  if (input.musicPath && gainDb !== null) {
    files.push(input.musicPath);
    const fadeIn = s.fadeInSec > 0 ? `,afade=t=in:st=0:d=${r3(Math.min(s.fadeInSec, total / 2))}` : "";
    const fadeOut =
      s.fadeOutSec > 0
        ? `,afade=t=out:st=${r3(Math.max(0, total - Math.min(s.fadeOutSec, total / 2)))}:d=${r3(Math.min(s.fadeOutSec, total / 2))}`
        : "";
    parts.push(
      `[${files.length - 1}:a]atrim=0:${total},asetpts=PTS-STARTPTS,aresample=${MIX_SAMPLE_RATE},` +
        `aformat=channel_layouts=stereo,volume=${gainDb}dB${fadeIn}${fadeOut}[music]`,
    );
    bed.push("[music]");
  }
  for (const effect of input.sfx ?? []) {
    if (!(s.sfxGain > 0)) break;
    files.push(effect.path);
    const ms = Math.round(Math.max(0, effect.atSec) * 1000);
    const n = bed.length;
    parts.push(
      `[${files.length - 1}:a]aresample=${MIX_SAMPLE_RATE},aformat=channel_layouts=stereo,` +
        `volume=${r3(s.sfxGain)},adelay=${ms}:all=1[fx${n}]`,
    );
    bed.push(`[fx${n}]`);
  }

  const duck = duckVolumeExpression(input.regions, { duckDb: s.duckDb, attackMs: s.attackMs, releaseMs: s.releaseMs });
  const tail = `,alimiter=limit=${LIMITER_CEILING}:attack=5:release=50:level=0` +
    (opts.window ? `,atrim=${r3(opts.window.startSec)}:${r3(opts.window.endSec)},asetpts=PTS-STARTPTS` : "");

  if (bed.length === 0) {
    parts.push(`[voice]anull${tail}[a]`);
    return { graph: parts.join(";"), inputs: files, musicGainDb: gainDb, duckExpression: null };
  }

  // Everything under the voice is summed, padded to the video, then ducked
  // once by the curve. 256-sample frames keep each step of the curve tiny
  // (≤0.5 dB at the fastest ramp), so the duck is a slope, not a staircase.
  const summed = bed.length === 1 ? `${bed[0]}anull` : `${bed.join("")}amix=inputs=${bed.length}:duration=longest:normalize=0`;
  parts.push(
    `${summed},apad=whole_dur=${total},atrim=0:${total}` +
      (duck ? `,asetnsamples=n=256,volume='${duck}':eval=frame` : "") +
      "[bed]",
  );
  parts.push(`[voice][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0${tail}[a]`);
  return { graph: parts.join(";"), inputs: files, musicGainDb: gainDb, duckExpression: duck };
}

/**
 * Render the mix (WAV, or MP3 for a preview). Long graphs (one ramp per line)
 * go through -filter_complex_script so a long video never hits the Windows
 * command-line limit.
 */
export async function renderMixerMix(
  input: MixerMixInput,
  outputPath: string,
  opts: { window?: { startSec: number; endSec: number }; format?: "wav" | "mp3" } = {},
): Promise<{ outputPath: string; graph: string; musicGainDb: number | null }> {
  const { graph, inputs, musicGainDb: gain } = buildMixerGraph(input, opts);
  for (const file of inputs) {
    if (!fs.existsSync(file)) throw new FfmpegError(`Thiếu tệp âm thanh: ${file}`, "", []);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const file of inputs) {
    // A short song loops so the end of a long video is never silent.
    if (file === input.musicPath) args.push("-stream_loop", "-1");
    args.push("-i", file);
  }
  let script: string | null = null;
  if (graph.length > 3000) {
    script = `${outputPath}.filter.txt`;
    fs.writeFileSync(script, graph, "utf8");
    args.push("-filter_complex_script", script);
  } else {
    args.push("-filter_complex", graph);
  }
  args.push("-map", "[a]", "-ar", String(MIX_SAMPLE_RATE), "-ac", "2");
  if (opts.format === "mp3") args.push("-c:a", "libmp3lame", "-b:a", "192k");
  else args.push("-c:a", "pcm_s16le");
  args.push(outputPath);
  try {
    await ffmpeg(args);
  } finally {
    if (script) fs.rmSync(script, { force: true });
  }
  return { outputPath, graph, musicGainDb: gain };
}

/** Music loudness by file content stamp (path + size + mtime). One measurement per song. */
const loudnessCache = new Map<string, number | null>();

export async function measureMusicLufs(file: string): Promise<number | null> {
  const stat = fs.statSync(file);
  const key = `${path.resolve(file)}|${stat.size}|${stat.mtimeMs}`;
  if (loudnessCache.has(key)) return loudnessCache.get(key)!;
  let value: number | null = null;
  try {
    const m = await measureLoudness(file);
    value = Number.isFinite(m.integratedLufs) && m.integratedLufs > -70 ? m.integratedLufs : null;
  } catch {
    value = null;
  }
  loudnessCache.set(key, value);
  return value;
}

// -------------------------------------------------------------- source manifest ---

/**
 * What a final MP4's sound was made from, kept beside it so REMIX AUDIO can mix
 * again from the sources. A finished MP4 holds the tracks already summed; they
 * cannot be separated cleanly, so nothing here ever tries.
 */
export interface AudioSourceManifest {
  version: 1;
  /** File name of the final MP4 this describes. */
  finalName: string;
  createdAt: string;
  totalSec: number;
  /** data-relative path of the dialogue stem (before level / normalisation). */
  dialogue: string;
  /** Line regions on the video clock (unmerged). */
  regions: SpeechRegion[];
  /** Scene starts on the video clock (preview of a scene change). */
  sceneStartsSec: number[];
  /** Effects as placed by that render (data-relative). */
  sfx: { path: string; atSec: number }[];
  /** data-relative music file the render used, if any (remix uses the project's CURRENT music). */
  music: string | null;
  /** The mixer that produced it: "mixer" (QĐ-150) or "legacy" (old sidechain). */
  engine: "mixer" | "legacy";
  settings: unknown;
}

export const AUDIO_SOURCES_DIR = "renders";

export function manifestDirFor(audioDir: string, finalName: string): string {
  return path.join(audioDir, AUDIO_SOURCES_DIR, path.basename(finalName, path.extname(finalName)));
}

export function writeAudioManifest(dir: string, manifest: AudioSourceManifest): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "manifest.json");
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), "utf8");
  return file;
}

export function readAudioManifest(dir: string): AudioSourceManifest | null {
  const file = path.join(dir, "manifest.json");
  if (!fs.existsSync(file)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8")) as AudioSourceManifest;
    return m && m.version === 1 && typeof m.dialogue === "string" ? m : null;
  } catch {
    return null;
  }
}
