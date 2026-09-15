import fs from "node:fs";
import path from "node:path";
import { ffmpeg, ffprobe } from "../src/media/ffmpeg";

/**
 * Pull five stills out of a clip, for scoring by eye.
 *
 * Read-only and free: it touches no API. The five points - first frame, 25%,
 * middle, 75%, last frame - are chosen because that is where the failures this
 * project keeps hitting actually show up. Identity drift and clothing changes
 * appear between the first and last frame; camera reframing appears by the
 * middle; a character walking out of shot appears at 75%.
 *
 * Scoring the FIRST frame against the keyframe is the one that matters most: it
 * is the only direct measure of whether the model honoured the image it was
 * given, rather than redrawing the scene from the prompt.
 *
 *   npx tsx scripts/extract-frames.ts --video <path> --out <dir>
 */
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function probeDuration(file: string): Promise<number> {
  const { stdout } = await ffprobe([
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    file,
  ]);
  return Number(stdout.trim());
}

async function main(): Promise<void> {
  const video = arg("video", "");
  const outDir = arg("out", "");
  if (!video || !fs.existsSync(video)) {
    console.log("Thieu --video hoac khong tim thay tep.");
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });

  const duration = await probeDuration(video);
  console.log(`Clip dai ${duration.toFixed(2)}s`);

  const points: Array<[string, number]> = [
    ["01-dau", 0],
    ["02-25pct", duration * 0.25],
    ["03-giua", duration * 0.5],
    ["04-75pct", duration * 0.75],
  ];

  for (const [label, at] of points) {
    const target = path.join(outDir, `${label}.png`);
    await ffmpeg([
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(at),
      "-i", video,
      "-frames:v", "1",
      target,
    ]);
    const size = fs.existsSync(target) ? fs.statSync(target).size : 0;
    console.log(`${label.padEnd(10)} t=${at.toFixed(2)}s  ${target}  ${size} bytes`);
  }

  // The LAST frame needs `-sseof`, which seeks backwards from the end.
  // Computing `duration - epsilon` and seeking forward does not work: the
  // reported duration can sit past the final packet, so ffmpeg finds nothing to
  // decode and writes a 0-byte file - silently, with exit status 0. The final
  // frame is the one that shows identity drift and clothing changes most
  // clearly, so losing it is losing the most informative sample.
  const lastTarget = path.join(outDir, "05-cuoi.png");
  await ffmpeg([
    "-hide_banner", "-loglevel", "error", "-y",
    "-sseof", "-0.5",
    "-i", video,
    "-update", "1",
    "-frames:v", "1",
    lastTarget,
  ]);
  const lastSize = fs.existsSync(lastTarget) ? fs.statSync(lastTarget).size : 0;
  console.log(`05-cuoi    (sseof -0.5s)  ${lastTarget}  ${lastSize} bytes`);
  if (lastSize === 0) {
    console.log("  CANH BAO: khong trich duoc frame cuoi.");
    process.exitCode = 1;
  }
}

void main();
