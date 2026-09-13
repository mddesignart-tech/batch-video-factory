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
import { buildASS, buildCues, buildSRT } from "./subtitles";
import { ensureProjectDirs, projectSubdir } from "@/lib/paths";

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

export interface RenderScene {
  sceneNumber: number;
  duration: number;
  subtitle: string;
  videoPath: string | null;
  audioPath: string | null;
  imagePath: string | null;
}

export interface RenderRequest {
  projectId: string;
  scenes: RenderScene[];
  target: RenderTarget;
  highlightPhrase?: string;
  burnSubtitles: boolean;
  musicPath?: string | null;
}

export interface RenderResult {
  videoPath: string;
  subtitlePathAss: string;
  subtitlePathSrt: string;
  durationSeconds: number;
  bytes: number;
  subtitlesBurned: boolean;
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

  const zoom = isStill
    ? `,zoompan=z='min(zoom+0.0012,1.10)':d=${Math.round(dur * fps)}:s=${width}x${height}:fps=${fps}`
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
  const audioFilter = musicFile
    ? `[1:a]volume=0.18[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]`
    : null;

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
export function buildConcatList(files: string[]): string {
  return (
    files
      .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
      .join("\n") + "\n"
  );
}

// ------------------------------------------------------------- the render ---

export async function renderProject(req: RenderRequest): Promise<RenderResult> {
  if (!ffmpegAvailable()) throw new FfmpegError(FFMPEG_MISSING_MESSAGE, "", []);

  ensureProjectDirs(req.projectId);
  const tempDir = projectSubdir(req.projectId, "temp");
  const finalDir = projectSubdir(req.projectId, "final");
  const subsDir = projectSubdir(req.projectId, "subtitles");

  const usable = req.scenes
    .filter((s) => s.videoPath || s.imagePath)
    .sort((a, b) => a.sceneNumber - b.sceneNumber);

  if (usable.length === 0) {
    throw new Error(
      "Không có cảnh nào có media để render. Hãy tạo media trước.",
    );
  }

  // Pass 1 - normalise every scene to identical codec parameters.
  const normalised: string[] = [];
  for (const scene of usable) {
    const source = scene.videoPath ?? scene.imagePath;
    if (!source) continue;
    const name = `norm_${String(scene.sceneNumber).padStart(3, "0")}.mp4`;
    const output = path.join(tempDir, name);
    await ffmpeg(
      buildSceneNormalizeArgs({
        videoInput: source,
        audioInput: scene.audioPath,
        duration: scene.duration,
        target: req.target,
        output,
      }),
    );
    normalised.push(name);
  }

  // Pass 2 - join. Run from tempDir so the list holds bare filenames.
  const listName = "concat.txt";
  fs.writeFileSync(
    path.join(tempDir, listName),
    buildConcatList(normalised),
    "utf8",
  );
  const joinedName = "joined.mp4";
  await ffmpeg(buildConcatArgs(listName, joinedName), { cwd: tempDir });

  // Subtitles are always written to disk, whether or not they get burned in.
  const cues = buildCues(usable);
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

  // Pass 3 - burn subtitles, mix music, produce the deliverable.
  const wantBurn = req.burnSubtitles && cues.length > 0;
  const canBurn = wantBurn ? await supportsSubtitleBurn() : false;
  const assTempName = "subs.ass";
  if (canBurn) fs.copyFileSync(assPath, path.join(tempDir, assTempName));

  let musicTempName: string | null = null;
  if (req.musicPath && fs.existsSync(req.musicPath)) {
    musicTempName = `music${path.extname(req.musicPath).toLowerCase()}`;
    fs.copyFileSync(req.musicPath, path.join(tempDir, musicTempName));
  }

  const outName = `final_${randomUUID().slice(0, 8)}.mp4`;
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

  const finalPath = path.join(finalDir, outName);
  fs.renameSync(path.join(tempDir, outName), finalPath);

  return {
    videoPath: finalPath,
    subtitlePathAss: assPath,
    subtitlePathSrt: srtPath,
    durationSeconds: await probeDuration(finalPath).catch(() => 0),
    bytes: fs.statSync(finalPath).size,
    subtitlesBurned: canBurn,
  };
}
