import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ffmpeg,
  ffmpegAvailable,
  FFMPEG_MISSING_MESSAGE,
  FfmpegError,
  probeDuration,
  supportsSubtitleBurn,
} from "./ffmpeg";
import { buildASS, buildCues, buildSRT, cuesFromTimelines } from "./subtitles";
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
import { ensureProjectDirs, projectSubdir } from "@/lib/paths";
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
}

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
  plannedTotal: number;
  finalTotal: number;
}

// ------------------------------------------------------- pure arg builders ---
// Exported separately from the side-effecting render so they can be unit tested
// without FFmpeg present.

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
}): string[] {
  const { videoInput, audioInput, duration, target, output } = opts;
  const { width, height, fps } = target;
  const dur = Math.max(0.5, Number(duration.toFixed(3)));

  const args = ["-y", "-hide_banner", "-loglevel", "error"];

  // A still image becomes a slow push-in so the scene is never frozen.
  const isStill = /\.(png|jpe?g|webp)$/i.test(videoInput);
  if (isStill) args.push("-loop", "1", "-t", String(dur));
  args.push("-i", videoInput);

  if (audioInput) args.push("-i", audioInput);
  else args.push("-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo`);

  // The push spreads over the WHOLE scene: a fixed step reached 1.10 after
  // ~2.8s and then sat still, which a longer voice-timed scene would expose.
  const frames = Math.max(1, Math.round(dur * fps));
  const step = Math.min(0.0012, 0.1 / frames).toFixed(6);
  const zoom = isStill
    ? `,zoompan=z='min(zoom+${step},1.10)':d=${frames}:s=${width}x${height}:fps=${fps}`
    : "";

  const videoChain =
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
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
}): string[] {
  const { input, subtitleFile, musicFile, target, output } = opts;

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
    "20",
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
    "192k",
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
}): string[] {
  const { videoInput, audioInput, subtitleFile, target, output } = opts;
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
    "20",
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
    "192k",
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

  // ---- Pass 1 - normalise every scene to identical codec parameters -------
  const normalised: string[] = [];
  for (let i = 0; i < usable.length; i += 1) {
    const scene = usable[i];
    if (!scene) continue;
    const source = scene.videoPath ?? scene.imagePath;
    if (!source) continue;
    const audio = sceneAudio[i];
    const name = `norm_${String(scene.sceneNumber).padStart(3, "0")}.mp4`;
    await ffmpeg(
      buildSceneNormalizeArgs({
        videoInput: source,
        // The scene's own dialogue track when it has one; the legacy single
        // file only when it has no lines at all.
        audioInput: audio ? audio.audioPath : scene.audioPath,
        duration: sceneDurations[i] ?? scene.duration,
        target: req.target,
        output: path.join(tempDir, name),
      }),
    );
    normalised.push(name);
  }

  // ---- Pass 2 - join ------------------------------------------------------
  const listName = "concat.txt";
  fs.writeFileSync(path.join(tempDir, listName), buildConcatList(normalised), "utf8");
  const joinedName = "joined.mp4";
  await ffmpeg(buildConcatArgs(listName, joinedName), { cwd: tempDir });

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
            if (audio.timeline.entries.length === 1 && scene.subtitle.trim().length > 0) {
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
          return {
            entries: [{ startSec: 0, endSec: length, text: scene.subtitle }],
            sceneDurationSec: length,
          };
        }),
      )
    : buildCues(usable.map((scene, i) => ({ ...scene, duration: sceneDurations[i] ?? scene.duration })));

  const srt = buildSRT(cues);
  const ass = buildASS(cues, {
    width: req.target.width,
    height: req.target.height,
    highlightPhrase: req.highlightPhrase,
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
        sfx: (req.sfx ?? []).filter((s) => fs.existsSync(s.path)),
        settings: req.mixSettings,
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
    plannedTotal: Math.round(sceneTimings.reduce((n, t) => n + t.plannedDuration, 0) * 1000) / 1000,
    finalTotal: Math.round(sceneDurations.reduce((n, d) => n + d, 0) * 1000) / 1000,
  };
}
