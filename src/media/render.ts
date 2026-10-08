import { splitByText, usesAuthorSubtitle } from "@/domain/scene-subtitles";
import { effectiveFit, type FitMode } from "@/domain/platform-profile";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  ffmpeg,
  ffmpegAvailable,
  FFMPEG_MISSING_MESSAGE,
  FfmpegError,
  probeDimensions,
  probeDuration,
  supportsSubtitleBurn,
} from "./ffmpeg";
import { buildASS, buildCues, buildSRT, cuesFromTimelines } from "./subtitles";
import type { SubtitleLayout } from "@/domain/output-controls";
import { renderSegmentCached } from "./segment-cache";
import { pngHasAlpha } from "./cutout";
import { buildLayeredSceneArgs, cameraZoompan, layerFiles, type LayerInputs, type LocalCameraSpec } from "./camera-motion";
import { blendTails, buildTransitionJoinArgs, hasBlend, planJoins } from "./transitions";
import type { Transition } from "@/domain/camera-grammar";
import { speakerBiasKeys, type ScreenSide } from "@/domain/speaker-focus";
import {
  DEFAULT_MIX,
  DUCK_RATIO,
  thresholdForDuck,
  type AudioMixSettings,
} from "./mix-config";
import {
  buildSceneTimeline,
  pauseFromMs,
  type SceneTimeline,
} from "@/domain/scene-timeline";
import {
  concatSceneDialogue,
  renderFinalMix,
  renderSceneDialogue,
} from "./scene-audio";
import type { LoudnessStats } from "./audio-normalize";
import {
  checkMix,
  toMetrics,
  type MixMetrics,
  type MixWarning,
} from "./audio-metrics";
import { DATA_ROOT, ensureProjectDirs, projectSubdir } from "@/lib/paths";
import {
  DEFAULT_TIMING,
  resolveSceneDuration,
  TimingBlockedError,
  type DurationMode,
  type SceneTiming,
  type TimingConfig,
} from "@/domain/scene-timing";

/**
 * Final assembly: many short scene clips -> one platform-ready MP4.
 *
 * The render is deliberately a three-pass pipeline rather than one giant
 * filter_complex. Normalising each scene to identical codec parameters first
 * means the join itself is a stream copy through the concat demuxer, which is
 * both far faster and far less likely to fail on a clip with odd dimensions or
 * a missing audio track.
 */

export interface RenderTarget {
  width: number;
  height: number;
  fps: number;
}

export const DEFAULT_TARGET: RenderTarget = {
  width: 1080,
  height: 1920,
  fps: 30,
};

export function targetForAspect(aspectRatio: string): RenderTarget {
  switch (aspectRatio) {
    case "1:1":
      return { width: 1080, height: 1080, fps: 30 };
    case "16:9":
      return { width: 1920, height: 1080, fps: 30 };
    case "4:5":
      return { width: 1080, height: 1350, fps: 30 };
    case "9:16":
    default:
      return DEFAULT_TARGET;
  }
}

/** One spoken line, as the renderer needs it. */
export interface RenderDialogueLine {
  lineNumber: number;
  speaker: string;
  text: string;
  /** Absolute path to the levelled clip. */
  audioPath: string;
  /** MEASURED duration of that clip. */
  durationSec: number;
  /** Script override in milliseconds; null means use the default. */
  pauseAfterMs?: number | null;
}

export interface RenderScene {
  sceneNumber: number;
  duration: number;
  subtitle: string;
  videoPath: string | null;
  /**
   * QĐ-128: the scene plan's camera, applied to a still. Absent = the V1 slow
   * push-in (every scene made before scene plans existed).
   */
  localCamera?: LocalCameraSpec;
  /** QĐ-128: separate layer files for a composited still scene (background / ambient / foreground). */
  layers?: LayerInputs | null;
  /**
   * The scene plan's transition INTO this scene. Absent / CUT / NONE = hard
   * cut (V1's stream-copy join). Never shifts a scene on the clock.
   */
  transitionIn?: Transition;
  /**
   * Characters on screen. Only consulted for a blend: an overlaying blend
   * between two scenes that share a character renders as a cut (no ghosting).
   */
  subjects?: string[];
  /**
   * G4: who stands on which side (-1 left, 1 right) and how much the camera
   * may lean towards the current speaker. Absent = no lean.
   */
  speakerFocus?: { sides: Record<string, ScreenSide>; amplitude: number };
  /**
   * Legacy single audio file.
   *
   * Only consulted when a scene has NO dialogue lines. Every project made since
   * voice moved to one file per line has lines, so this is the path for old
   * projects rather than an alternative worth choosing.
   */
  audioPath: string | null;
  imagePath: string | null;
  /** The real audio source. Present on every project made since per-line voice. */
  dialogueLines?: RenderDialogueLine[];
  /** Voice-aware timing (V1.2). Missing = AUTO, no bounds. */
  durationMode?: DurationMode | null;
  minDuration?: number | null;
  maxDuration?: number | null;
  /** How the scene was planned to move; decides the visual floor. */
  motionSource?: string | null;
  /**
   * The scene's spoken lines, in order - the SAME list its voice was made from
   * (QĐ-122). With two or more, every line captions itself; the single
   * `subtitle` field only stands in for a one-line scene.
   */
  spokenLines?: string[];
}

export interface RenderRequest {
  projectId: string;
  scenes: RenderScene[];
  target: RenderTarget;
  highlightPhrase?: string;
  burnSubtitles: boolean;
  musicPath?: string | null;
  /** Effects, positioned on the whole video's clock. */
  sfx?: { path: string; atSec: number }[];
  /** Mix knobs. Anything missing falls back to the safe preset. */
  mixSettings?: Partial<AudioMixSettings>;
  /** Voice-aware timing thresholds. Missing = DEFAULT_TIMING. */
  timingConfig?: TimingConfig;
  /**
   * Final-pass encoder settings from the output preset (V1.2 Phase 6). Missing =
   * V1's CRF 20 / AAC 192k, and then it is left out of the render recipe too.
   */
  encode?: FinalEncode;
  /**
   * How a picture/clip of another shape goes into the frame (QĐ-121). Never a
   * stretch. Missing = AUTO, which is V1's fill-and-crop whenever the shapes are
   * close - and then it is left out of the recipe too.
   */
  fit?: FitMode;
  /** Subtitle distance from the bottom, % of height. Missing/null = automatic. */
  subtitleBottomPct?: number | null;
  /** QĐ-125: subtitle size / place / style / auto-fit. Missing = the V1 layout. */
  subtitleLayout?: SubtitleLayout;
  /** QĐ-125: narration level, levelling and fades. Missing = the mix as before. */
  voiceMix?: { gain: number; normalize: boolean; fadeSec: number };
  /**
   * QĐ-125: one effect per scene, placed at that scene's start on the FINAL
   * clock (known only here, after voice-driven timing). Added to `sfx`.
   */
  sceneSfx?: { sceneNumber: number; path: string }[];
}

export interface FinalEncode {
  crf: number;
  audioBitrateKbps: number;
}

const DEFAULT_ENCODE: FinalEncode = { crf: 20, audioBitrateKbps: 192 };

export interface RenderResult {
  videoPath: string;
  subtitlePathAss: string;
  subtitlePathSrt: string;
  durationSeconds: number;
  bytes: number;
  subtitlesBurned: boolean;
  /** Which audio path produced this render. Never left to be inferred. */
  audioPipeline: "dialogue-timeline" | "legacy-scene-audio";
  /** Measured from the finished mix, when the new pipeline was used. */
  audioMetrics?: MixMetrics;
  audioWarnings: MixWarning[];
  /** Per-scene audio tracks, kept so one scene can be re-mixed alone. */
  sceneAudioPaths: string[];
  /** How long every scene ended up, and why - in scene order. */
  sceneTimings: SceneTiming[];
  /** Scene segments copied from the local segment cache (compute saved, $0 either way). */
  segmentsReused?: number;
  plannedTotal: number;
  finalTotal: number;
  /** Scene joins rendered as a blend rather than a cut. */
  transitionsApplied?: number;
}

// ------------------------------------------------------- pure arg builders ---
// Exported separately from the side-effecting render so they can be unit tested
// without FFmpeg present.

/** Soft warm white behind a transparent still: reads as a studio backdrop, not a hole. */
export const STILL_MATTE = "0xF1EEE8";

/**
 * The transparent still laid on STILL_MATTE, as an opaque PNG cached by the
 * picture's content (data/cache/matte). Local, $0; the scene chain is unchanged.
 */
export async function stillOnMatte(file: string): Promise<string> {
  const sha = createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 32);
  const dir = path.join(DATA_ROOT, "cache", "matte");
  const out = path.join(dir, `${sha}.png`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${sha}.${randomUUID()}.png`);
  await ffmpeg([
    "-v", "error", "-y", "-i", file,
    "-filter_complex", `[0:v]format=rgba,split=2[mb][mf];[mb]drawbox=c=${STILL_MATTE}@1:replace=1:t=fill[mc];[mc][mf]overlay=format=auto,format=rgb24`,
    "-frames:v", "1", tmp,
  ]);
  fs.renameSync(tmp, out);
  return out;
}

/**
 * Scale-and-crop to fill the frame, hold the last frame if the clip is short,
 * then hard-trim to the scene's scripted duration so audio and subtitles stay
 * in sync no matter what the provider returned.
 */
export function buildSceneNormalizeArgs(opts: {
  videoInput: string;
  audioInput: string | null;
  duration: number;
  target: RenderTarget;
  output: string;
  /** COVER (default, V1's exact chain) or CONTAIN (whole picture over a blurred fill). */
  fit?: "COVER" | "CONTAIN";
  /**
   * QĐ-128: the scene's camera plan, for a still. Absent = the V1 slow push-in,
   * argument for argument (legacy scenes and their segment cache are untouched).
   */
  camera?: LocalCameraSpec;
}): string[] {
  const { videoInput, audioInput, duration, target, output } = opts;
  const { width, height, fps } = target;
  const dur = Math.max(0.5, Number(duration.toFixed(3)));

  const args = ["-y", "-hide_banner", "-loglevel", "error"];

  // A still image becomes a slow push-in so the scene is never frozen.
  const isStill = /\.(png|jpe?g|webp)$/i.test(videoInput);
  // QĐ-128: with a camera plan the still goes in as ONE frame - zoompan then
  // makes exactly the scene's frames (a looped input would make d frames per
  // input frame: thousands, which is slow and can crash FFmpeg). V1's chain
  // (no plan) is unchanged.
  if (isStill && !opts.camera) args.push("-loop", "1", "-t", String(dur));
  args.push("-i", videoInput);

  if (audioInput) args.push("-i", audioInput);
  else args.push("-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo`);

  // The push spreads over the WHOLE scene: a fixed step reached 1.10 after
  // ~2.8s and then sat still, which a longer voice-timed scene would expose.
  const frames = Math.max(1, Math.round(dur * fps));
  const step = Math.min(0.0012, 0.1 / frames).toFixed(6);
  const zoom = !isStill
    ? ""
    : opts.camera
      ? cameraZoompan(opts.camera, { durationSec: dur, target: opts.target })
      : `,zoompan=z='min(zoom+${step},1.10)':d=${frames}:s=${width}x${height}:fps=${fps}`;

  // Never stretched. COVER fills and crops the centre (V1's chain, unchanged);
  // CONTAIN shows the whole source over a blurred, filled copy of itself.
  const videoChain =
    opts.fit === "CONTAIN"
      ? `[0:v]split=2[bgs][fgs];` +
        `[bgs]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=20:2[bg];` +
        `[fgs]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2${zoom},fps=${fps},` +
        `tpad=stop_mode=clone:stop_duration=10,setsar=1,format=yuv420p[v]`
      : `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height}${zoom},fps=${fps},` +
        `tpad=stop_mode=clone:stop_duration=10,setsar=1,format=yuv420p[v]`;
  // apad keeps the audio stream alive to the trim point when the voice clip is
  // shorter than the scene, which is the normal case.
  const audioChain = `[1:a]aresample=48000,apad[a]`;

  args.push(
    "-filter_complex",
    `${videoChain};${audioChain}`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-t",
    String(dur),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    output,
  );
  return args;
}

/** Join the normalised scenes. Relative names: cwd is the temp folder. */
export function buildConcatArgs(listFile: string, output: string): string[] {
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    output,
  ];
}

/**
 * Music level when nobody is speaking. Low enough to sit under dialogue, loud
 * enough to be heard in the gaps.
 */
const MUSIC_BED_GAIN = DEFAULT_MIX.musicGain;

/**
 * Duck the music under the voice, rather than just turning it down.
 *
 * The old filter was `volume=0.18` plus `amix`, which is a fixed attenuation -
 * the music sat at one level whether anyone was speaking or not. The comment
 * above it claimed ducking; it never did any.
 *
 * Two things were wrong and the second one mattered more:
 *
 *   1. No sidechain, so quiet dialogue still competed with the bed.
 *   2. `amix` normalises by default, dividing every input by the number of
 *      inputs. Adding music therefore dropped the VOICE by 6 dB - the opposite
 *      of the requirement that speech stay clearly above the music. That is
 *      what `normalize=0` fixes.
 *
 * The voice is split: one copy goes to the mix untouched, the other drives the
 * compressor's sidechain, so the voice controls the music without being
 * processed itself. Attack is fast enough to catch a word's start; release is
 * slow enough that the bed does not pump between syllables.
 */
export function buildDuckFilter(): string {
  return [
    `[0:a]asplit=2[voice][key]`,
    `[1:a]volume=${MUSIC_BED_GAIN}[bed]`,
    `[bed][key]sidechaincompress=threshold=${thresholdForDuck(DEFAULT_MIX.duckDb)}` +
      `:ratio=${DUCK_RATIO}:attack=${DEFAULT_MIX.attackMs}:release=${DEFAULT_MIX.releaseMs}:makeup=1[ducked]`,
    // normalize=0 keeps the voice at full level. Without it amix halves both.
    `[voice][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`,
  ].join(";");
}

/**
 * Burn subtitles and (optionally) duck background music under the voice.
 *
 * `subtitleFile` and `musicFile` are bare filenames resolved against the process
 * cwd: the ASS `subtitles=` filter uses `:` as its own separator, so a Windows
 * absolute path like `C:\...` would need double-escaping. Running from the
 * folder sidesteps that class of bug entirely.
 */
export function buildFinalArgs(opts: {
  input: string;
  subtitleFile: string | null;
  musicFile: string | null;
  target: RenderTarget;
  output: string;
  encode?: FinalEncode;
}): string[] {
  const { input, subtitleFile, musicFile, target, output } = opts;
  const encode = opts.encode ?? DEFAULT_ENCODE;

  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", input];
  if (musicFile) args.push("-stream_loop", "-1", "-i", musicFile);

  const videoFilter = subtitleFile ? `subtitles=${subtitleFile}` : null;
  const audioFilter = musicFile ? buildDuckFilter() : null;

  if (videoFilter && audioFilter) {
    args.push("-filter_complex", `[0:v]${videoFilter}[v];${audioFilter}`);
    args.push("-map", "[v]", "-map", "[a]");
  } else if (videoFilter) {
    args.push("-vf", videoFilter, "-map", "0:v", "-map", "0:a");
  } else if (audioFilter) {
    args.push("-filter_complex", audioFilter, "-map", "0:v", "-map", "[a]");
  } else {
    args.push("-map", "0:v", "-map", "0:a");
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    String(encode.crf),
    "-profile:v",
    "high",
    "-level",
    "4.0",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(target.fps),
    "-c:a",
    "aac",
    "-b:a",
    `${encode.audioBitrateKbps}k`,
    "-ar",
    "48000",
    "-ac",
    "2",
    // Puts the moov atom first so the file starts playing before it is fully
    // downloaded - what every short-form platform expects on upload.
    "-movflags",
    "+faststart",
    output,
  );
  return args;
}

/** concat demuxer list. Single quotes are escaped per the demuxer's grammar. */
/**
 * Burn subtitles and take the audio from a separately rendered mix.
 *
 * The joined video's own audio is discarded rather than mixed with: it is the
 * per-scene dialogue tracks, and those are already inside the mix. Mixing them
 * again would double every line.
 */
export function buildFinalWithMixArgs(opts: {
  videoInput: string;
  audioInput: string;
  subtitleFile: string | null;
  target: RenderTarget;
  output: string;
  encode?: FinalEncode;
}): string[] {
  const { videoInput, audioInput, subtitleFile, target, output } = opts;
  const encode = opts.encode ?? DEFAULT_ENCODE;
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    videoInput,
    "-i",
    audioInput,
  ];

  if (subtitleFile) {
    args.push("-vf", `subtitles=${subtitleFile}`);
  }
  // Map video from input 0 and audio from input 1 - never input 0's audio.
  args.push("-map", "0:v", "-map", "1:a");
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    String(encode.crf),
    "-profile:v",
    "high",
    "-level",
    "4.0",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(target.fps),
    "-c:a",
    "aac",
    "-b:a",
    `${encode.audioBitrateKbps}k`,
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    // The mix is as long as the speech; the picture is as long as the scenes.
    // Ending on the shorter avoids a tail of frozen frame or silent audio.
    "-shortest",
    output,
  );
  return args;
}

export function buildConcatList(files: string[]): string {
  return (
    files
      .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
      .join("\n") + "\n"
  );
}

// ------------------------------------------------------------- the render ---

/**
 * Build the audio for one scene from its dialogue lines.
 *
 * Returns null when the scene has no lines, which is the ONLY case that falls
 * back to the legacy single audio file. There is deliberately no setting that
 * chooses between the two pipelines: a project either has per-line dialogue or
 * predates it, and letting an operator pick would leave two behaviours to
 * reason about forever.
 */
function timelineInputs(scene: RenderScene) {
  return (scene.dialogueLines ?? [])
    .filter((l) => l.audioPath.length > 0 && fs.existsSync(l.audioPath))
    .map((l) => ({
      lineNumber: l.lineNumber,
      speaker: l.speaker,
      text: l.text,
      audioPath: l.audioPath,
      durationSec: l.durationSec,
      pauseAfterOverride: pauseFromMs(l.pauseAfterMs),
    }));
}

/**
 * The measured facts the timing engine needs for one scene: how long the
 * speech really is (from the clips' measured lengths, or ffprobe on a legacy
 * file - never a text estimate once audio exists) and how long a paid clip is.
 */
async function sceneTimingFor(scene: RenderScene, config: TimingConfig): Promise<SceneTiming> {
  const lines = timelineInputs(scene);
  let voice: number | null = null;
  if (lines.length > 0) {
    voice = buildSceneTimeline(lines, 0).speechDurationSec;
  } else if (scene.audioPath && fs.existsSync(scene.audioPath)) {
    voice = await probeDuration(scene.audioPath).catch(() => null);
  }
  const isClip = Boolean(scene.videoPath && /\.(mp4|mov|webm|mkv)$/i.test(scene.videoPath));
  const clipDuration = isClip && fs.existsSync(scene.videoPath!) ? await probeDuration(scene.videoPath!).catch(() => null) : null;
  return resolveSceneDuration(
    {
      sceneNumber: scene.sceneNumber,
      plannedDuration: scene.duration,
      durationMode: scene.durationMode ?? "AUTO",
      minDuration: scene.minDuration ?? null,
      maxDuration: scene.maxDuration ?? null,
      voiceDuration: voice,
      motion: isClip ? "VIDEO_AI" : scene.motionSource === "LOCAL_MOTION" || scene.imagePath ? "LOCAL_MOTION" : "STATIC",
      clipDuration,
    },
    config,
  );
}

async function buildSceneAudio(
  scene: RenderScene,
  timing: SceneTiming,
  tempDir: string,
): Promise<{
  timeline: SceneTimeline;
  audioPath: string;
  loudness: LoudnessStats;
} | null> {
  const lines = timelineInputs(scene);
  if (lines.length === 0) return null;

  // Laid out on the RESOLVED length, speech starting after the lead-in.
  const timeline = buildSceneTimeline(lines, timing.finalDuration, { leadInSec: timing.leadInSec });

  const audioPath = path.join(
    tempDir,
    `scene_${String(scene.sceneNumber).padStart(3, "0")}_dialogue.wav`,
  );
  if (fs.existsSync(audioPath)) fs.rmSync(audioPath);
  const rendered = await renderSceneDialogue(timeline, audioPath);
  return { timeline, audioPath, loudness: rendered.loudness };
}

/**
 * QĐ-125: each scene's effect lands just after that scene starts, on the final
 * clock (scene lengths follow the voice, so this is only known here).
 */
function placedSceneSfx(
  req: RenderRequest,
  usable: { sceneNumber: number }[],
  sceneDurations: (number | undefined)[],
): { path: string; atSec: number }[] {
  if (!req.sceneSfx?.length) return [];
  const out: { path: string; atSec: number }[] = [];
  let at = 0;
  usable.forEach((scene, i) => {
    const effect = req.sceneSfx!.find((e) => e.sceneNumber === scene.sceneNumber);
    if (effect) out.push({ path: effect.path, atSec: Math.round((at + 0.05) * 1000) / 1000 });
    at += sceneDurations[i] ?? 0;
  });
  return out;
}

export async function renderProject(req: RenderRequest): Promise<RenderResult> {
  if (!ffmpegAvailable()) throw new FfmpegError(FFMPEG_MISSING_MESSAGE, "", []);

  ensureProjectDirs(req.projectId);
  const tempDir = projectSubdir(req.projectId, "temp");
  const finalDir = projectSubdir(req.projectId, "final");
  const subsDir = projectSubdir(req.projectId, "subtitles");
  const audioDir = projectSubdir(req.projectId, "audio");

  const usable = req.scenes
    .filter((s) => s.videoPath || s.imagePath)
    .sort((a, b) => a.sceneNumber - b.sceneNumber);

  if (usable.length === 0) {
    throw new Error("Không có cảnh nào có media để render. Hãy tạo media trước.");
  }

  // ---- Pass 0 - the dialogue track, and the timeline everything else uses --
  //
  // This runs FIRST because it decides how long each scene is. A scene whose
  // speech outruns its planned visuals gets extended, and the video cut has to
  // follow that decision rather than the other way round.
  // Voice-aware timing (V1.2): every scene's length is resolved from MEASURED
  // speech and the paid clip's MEASURED length, before anything is cut. A scene
  // the purchased media cannot fit stops the render here - no file is touched
  // and nothing is bought (MEDIA_REGEN_REQUIRED).
  const timingConfig = req.timingConfig ?? DEFAULT_TIMING;
  const sceneTimings: SceneTiming[] = [];
  for (const scene of usable) sceneTimings.push(await sceneTimingFor(scene, timingConfig));
  const blockedTimings = sceneTimings.filter((t) => t.blocked);
  if (blockedTimings.length > 0) throw new TimingBlockedError(blockedTimings);

  const sceneAudio: ({
    timeline: SceneTimeline;
    audioPath: string;
    loudness: LoudnessStats;
  } | null)[] = [];
  for (let i = 0; i < usable.length; i += 1) {
    sceneAudio.push(await buildSceneAudio(usable[i]!, sceneTimings[i]!, tempDir));
  }
  const usingTimeline = sceneAudio.some((a) => a !== null);
  const audioWarnings: MixWarning[] = [];

  // Effective duration per scene: the resolved one. The timeline can only be
  // longer if speech outran it, which the engine already rules out.
  const sceneDurations = usable.map((_, i) => {
    const audio = sceneAudio[i];
    const resolved = sceneTimings[i]!.finalDuration;
    return audio ? Math.max(resolved, audio.timeline.sceneDurationSec) : resolved;
  });

  for (const timing of sceneTimings) {
    for (const message of timing.warnings) {
      audioWarnings.push({
        kind: "scene_timing",
        severity: "warning",
        message,
        suggestion: "Lời thoại KHÔNG bị cắt và không có request trả phí nào vì nhịp cảnh.",
      });
    }
  }

  // Joins are decided BEFORE the scenes are cut: a scene followed by a blend is
  // rendered a little longer (its tail), so its camera is still moving under
  // the blend instead of freezing on its last frame.
  const transitions = usable.map((s) => s.transitionIn);
  const subjects = usable.map((s) => s.subjects ?? []);
  const joinDurations = usable.map((s, i) => sceneDurations[i] ?? s.duration);
  const joins = planJoins(transitions, joinDurations, subjects);
  const tails = blendTails(joins, usable.length);

  // ---- Pass 1 - normalise every scene to identical codec parameters -------
  const normalised: string[] = [];
  let segmentsReused = 0;
  for (let i = 0; i < usable.length; i += 1) {
    const scene = usable[i];
    if (!scene) continue;
    const original = scene.videoPath ?? scene.imagePath;
    if (!original) continue;
    // A transparent picture (a cut-out used as the scene's own picture) would
    // render its empty area black: it goes on a light matte first (cached).
    const source = !scene.videoPath && pngHasAlpha(original) ? await stillOnMatte(original) : original;
    const audio = sceneAudio[i];
    const name = `norm_${String(scene.sceneNumber).padStart(3, "0")}.mp4`;
    // The scene's own dialogue track when it has one; the legacy single file
    // only when it has no lines at all.
    const audioInput = audio ? audio.audioPath : scene.audioPath;
    const output = path.join(tempDir, name);
    // AUTO decides per source: fill when the shapes are close, show-all when a
    // crop would cut most of it (QĐ-121). Probed locally, $0.
    const fit = effectiveFit(req.fit ?? "AUTO", req.fit === "COVER" || req.fit === "CONTAIN" ? null : await probeDimensions(source), req.target);
    // Identical segment work done before (same picture/clip, audio, length,
    // motion, codec) is copied from the local cache - compute saved, $0 either
    // way (QĐ-112).
    // QĐ-128: a still with separate layer files is composited in one graph;
    // a still with a camera plan moves as planned; anything else is V1's chain.
    const isStillSource = !scene.videoPath && Boolean(scene.imagePath);
    const layered = isStillSource && scene.layers ? scene.layers : null;
    // G4: lean towards the speaker, from the MEASURED dialogue timeline.
    const lean =
      isStillSource && scene.speakerFocus && audio
        ? speakerBiasKeys(audio.timeline.entries, (name) => scene.speakerFocus!.sides[name] ?? null)
        : [];
    const camera = (base: LocalCameraSpec | undefined): LocalCameraSpec | undefined =>
      lean.length && base ? { ...base, speakerBias: lean, speakerAmp: scene.speakerFocus!.amplitude } : base;
    const segment = await renderSegmentCached({
      args: layered
        ? buildLayeredSceneArgs({
            layers: layered,
            audioInput,
            duration: (sceneDurations[i] ?? scene.duration) + (tails[i] ?? 0),
            target: req.target,
            camera: camera(scene.localCamera ?? { move: "SLOW_ZOOM_IN", speed: "SLOW" })!,
            output,
          })
        : buildSceneNormalizeArgs({
            videoInput: source,
            audioInput,
            duration: (sceneDurations[i] ?? scene.duration) + (tails[i] ?? 0),
            target: req.target,
            output,
            fit,
            ...(isStillSource && scene.localCamera ? { camera: camera(scene.localCamera) } : {}),
          }),
      inputs: layered
        ? [...layerFiles(layered), ...(audioInput ? [audioInput] : [])]
        : [source, ...(audioInput ? [audioInput] : [])],
      output,
    });
    if (segment.reused) segmentsReused += 1;
    normalised.push(name);
  }

  // ---- Pass 2 - join ------------------------------------------------------
  const listName = "concat.txt";
  fs.writeFileSync(path.join(tempDir, listName), buildConcatList(normalised), "utf8");
  const joinedName = "joined.mp4";
  if (hasBlend(joins)) {
    // A blend needs a re-encode of the join; the clock is unchanged (each scene
    // starts at its own second; the outgoing one plays its tail under the blend).
    await ffmpeg(
      buildTransitionJoinArgs({ inputs: normalised, durations: joinDurations, transitions, subjects, tails, fps: req.target.fps, output: joinedName }),
      { cwd: tempDir, timeoutMs: 20 * 60 * 1000 },
    );
  } else {
    await ffmpeg(buildConcatArgs(listName, joinedName), { cwd: tempDir });
  }

  // ---- Subtitles, timed against the audio that will actually play ---------
  const cues = usingTimeline
    ? cuesFromTimelines(
        usable.map((scene, i) => {
          const audio = sceneAudio[i];
          if (audio) {
            // `scene.subtitle` is the author's READABLE version of the line -
            // shortened and wrapped for the screen - while the line's own text
            // is what is spoken. Prefer the readable one when a scene has a
            // single line, because it says the same thing better.
            //
            // With several lines there is only one `subtitle` field and two or
            // three speakers, so it cannot represent them; each line then
            // captions itself, which is also what a learner needs to read
            // along with.
            // Only for a ONE-line scene: with several lines and one of them
            // voiced so far, the author's subtitle belongs to another line.
            if (audio.timeline.entries.length === 1 && usesAuthorSubtitle(scene.spokenLines?.length ?? 1, scene.subtitle)) {
              const only = audio.timeline.entries[0];
              return {
                ...audio.timeline,
                entries: only
                  ? [{ ...only, text: scene.subtitle }]
                  : audio.timeline.entries,
              };
            }
            return audio.timeline;
          }
          // A legacy scene inside an otherwise modern project still needs its
          // slot on the clock, with its caption across the whole scene.
          const length = sceneDurations[i] ?? scene.duration;
          // Several speakers and no audio yet: each line in order, never only
          // the stored subtitle (which holds one of them).
          if ((scene.spokenLines?.length ?? 0) >= 2) {
            return { entries: splitByText(scene.spokenLines!, 0, length), sceneDurationSec: length };
          }
          return {
            entries: [{ startSec: 0, endSec: length, text: scene.subtitle }],
            sceneDurationSec: length,
          };
        }),
      )
    : buildCues(
        usable.flatMap((scene, i) => {
          const duration = sceneDurations[i] ?? scene.duration;
          // A multi-speaker scene is captioned line by line, in order, over
          // its own duration - the same slot on the clock as before.
          if ((scene.spokenLines?.length ?? 0) < 2) return [{ ...scene, duration }];
          return splitByText(scene.spokenLines!, 0, duration).map((e) => ({ duration: e.endSec - e.startSec, subtitle: e.text }));
        }),
      );

  const srt = buildSRT(cues, req.subtitleLayout);
  const ass = buildASS(cues, {
    width: req.target.width,
    height: req.target.height,
    highlightPhrase: req.highlightPhrase,
    bottomPct: req.subtitleBottomPct ?? null,
    layout: req.subtitleLayout,
  });
  const srtPath = path.join(subsDir, "subtitles.srt");
  const assPath = path.join(subsDir, "subtitles.ass");
  fs.writeFileSync(srtPath, srt, "utf8");
  fs.writeFileSync(assPath, ass, "utf8");

  // ---- Pass 3 - the final mix --------------------------------------------
  const wantBurn = req.burnSubtitles && cues.length > 0;
  const canBurn = wantBurn ? await supportsSubtitleBurn() : false;
  const assTempName = "subs.ass";
  if (canBurn) fs.copyFileSync(assPath, path.join(tempDir, assTempName));

  const outName = `final_${randomUUID().slice(0, 8)}.mp4`;
  let audioMetrics: MixMetrics | undefined;
  const sceneAudioPaths: string[] = [];

  if (usingTimeline) {
    // Join the scene tracks, then mix music and effects under the lot ONCE,
    // with the voice driving the sidechain. Mixing per scene and joining
    // afterwards would restart the compressor at every cut and pump at each
    // boundary.
    const dialogueParts: string[] = [];
    for (let i = 0; i < sceneAudio.length; i += 1) {
      const audio = sceneAudio[i];
      if (audio) {
        dialogueParts.push(audio.audioPath);
        continue;
      }
      // A legacy scene contributes silence of its own length rather than
      // nothing, so every later scene stays in step.
      const silence = path.join(tempDir, `scene_${String(i).padStart(3, "0")}_silent.wav`);
      if (fs.existsSync(silence)) fs.rmSync(silence);
      await ffmpeg([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `anullsrc=r=24000:cl=mono:d=${sceneDurations[i] ?? 1}`,
        "-c:a",
        "pcm_s16le",
        silence,
      ]);
      dialogueParts.push(silence);
    }
    sceneAudioPaths.push(...dialogueParts);

    const joinedDialogue = path.join(audioDir, "project-dialogue.wav");
    if (fs.existsSync(joinedDialogue)) fs.rmSync(joinedDialogue);
    const dialogue = await concatSceneDialogue(dialogueParts, joinedDialogue);

    const mixPath = path.join(audioDir, "project-final-mix.wav");
    if (fs.existsSync(mixPath)) fs.rmSync(mixPath);
    const mix = await renderFinalMix(
      {
        dialoguePath: joinedDialogue,
        musicPath: req.musicPath && fs.existsSync(req.musicPath) ? req.musicPath : null,
        sfx: [...(req.sfx ?? []), ...placedSceneSfx(req, usable, sceneDurations)].filter((s) => fs.existsSync(s.path)),
        settings: req.mixSettings,
        ...(req.voiceMix
          ? { voice: { ...req.voiceMix, totalSec: sceneDurations.reduce((n, d) => n + (d ?? 0), 0) } }
          : {}),
      },
      mixPath,
    );

    audioMetrics = toMetrics(mix.loudness, mix.durationSec);
    audioWarnings.push(
      ...checkMix({
        mix: mix.loudness,
        dialogue: dialogue.loudness,
        durationSec: mix.durationSec,
      }),
    );

    // Replace the joined video's audio wholesale. The per-scene tracks were
    // only ever there to keep the concat demuxer happy.
    await ffmpeg(
      buildFinalWithMixArgs({
        videoInput: joinedName,
        audioInput: mixPath,
        subtitleFile: canBurn ? assTempName : null,
        target: req.target,
        output: outName,
        encode: req.encode,
      }),
      { cwd: tempDir, timeoutMs: 20 * 60 * 1000 },
    );
  } else {
    // Legacy: no dialogue lines anywhere in this project.
    let musicTempName: string | null = null;
    if (req.musicPath && fs.existsSync(req.musicPath)) {
      musicTempName = `music${path.extname(req.musicPath).toLowerCase()}`;
      fs.copyFileSync(req.musicPath, path.join(tempDir, musicTempName));
    }
    await ffmpeg(
      buildFinalArgs({
        input: joinedName,
        subtitleFile: canBurn ? assTempName : null,
        musicFile: musicTempName,
        target: req.target,
        output: outName,
        encode: req.encode,
      }),
      { cwd: tempDir, timeoutMs: 20 * 60 * 1000 },
    );
  }

  const finalPath = path.join(finalDir, outName);
  fs.renameSync(path.join(tempDir, outName), finalPath);

  return {
    videoPath: finalPath,
    subtitlePathAss: assPath,
    subtitlePathSrt: srtPath,
    durationSeconds: await probeDuration(finalPath).catch(() => 0),
    bytes: fs.statSync(finalPath).size,
    subtitlesBurned: canBurn,
    audioPipeline: usingTimeline ? "dialogue-timeline" : "legacy-scene-audio",
    audioMetrics,
    audioWarnings,
    sceneAudioPaths,
    sceneTimings,
    segmentsReused,
    transitionsApplied: joins.filter((j) => j.spec !== null).length,
    plannedTotal: Math.round(sceneTimings.reduce((n, t) => n + t.plannedDuration, 0) * 1000) / 1000,
    finalTotal: Math.round(sceneDurations.reduce((n, d) => n + d, 0) * 1000) / 1000,
  };
}
