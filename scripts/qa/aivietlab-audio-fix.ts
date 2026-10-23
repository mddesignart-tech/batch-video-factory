import fs from "node:fs";
import path from "node:path";

/**
 * QĐ-149 AUDIO FIX for the AIVietLab test video - the picture of an existing
 * render is kept bit for bit (stream copy); only the sound is mixed again.
 *
 * Why: the production mix ducks the bed with a fast release (20 ms / 350 ms)
 * and a sidechain that cuts ~20 dB under this voice. Every scene ends with
 * ~0.6 s without speech, so the bed swelled ~20 dB at each scene change and
 * was slammed down when the next line began - heard as the music "jumping"
 * at every transition. The mix was also mono at 24 kHz (music folded to mono,
 * nothing above 12 kHz).
 *
 * Here: ONE continuous music track from 0 s (no per-scene cut, restart or
 * fade), a static level, a gentle slow duck (ratio 2, attack 150 ms, release
 * 1500 ms: 2-7 dB, so a scene gap does not let it swell), fade in 1 s at the
 * start and out 1.5 s at the end only. Voice: the same levelled lines (the
 * render's dialogue track), not re-generated, not re-timed, placed in the
 * centre of a stereo field at -3 dB per side (same loudness). AAC stereo
 * 48 kHz 192 kbps. Local FFmpeg only, $0.
 *
 *   npx tsx scripts/qa/aivietlab-audio-fix.ts <old final mp4>
 *
 * MUSIC_DB moves the bed only (the voice chain is untouched); OUT_SUFFIX names
 * the new file so an approved render is never overwritten; STEMS_DIR also
 * writes the ducked bed alone as WAV, for level checks.
 */

const ID = "aivietlab-test-2026-10-22";
const MUSIC_DB = Number(process.env.MUSIC_DB ?? "-8.2");
const OUT_SUFFIX = process.env.OUT_SUFFIX ?? "_qd149-audio-fix";
const STEMS_DIR = process.env.STEMS_DIR;

async function main(): Promise<void> {
  const { toAbsolute, projectSubdir } = await import("../../src/lib/paths");
  const { ffmpeg, probeDuration } = await import("../../src/media/ffmpeg");

  if (!process.argv[2] || !/\.mp4$/i.test(process.argv[2])) throw new Error("Cần đường dẫn video cũ (.mp4): npx tsx scripts/qa/aivietlab-audio-fix.ts <old final mp4>");
  const oldVideo = path.resolve(process.argv[2]);
  if (!fs.statSync(oldVideo, { throwIfNoEntry: false })?.isFile()) throw new Error(`Không tìm thấy video cũ: ${oldVideo}`);
  const dialogue = path.join(toAbsolute(projectSubdir(ID, "audio")), "project-dialogue.wav");
  const music = toAbsolute(path.join("music", "aivietlab-tech-bg.mp3"));
  for (const f of [dialogue, music]) if (!fs.existsSync(f)) throw new Error(`Thiếu tệp: ${f}`);

  const len = Math.round((await probeDuration(oldVideo)) * 1000) / 1000;
  const fadeOut = (len - 1.5).toFixed(3);

  const graph = [
    "[1:a]aresample=48000,pan=stereo|c0=0.7071*c0|c1=0.7071*c0,asplit=2[voice][key]",
    `[2:a]atrim=0:${len},asetpts=PTS-STARTPTS,aresample=48000,volume=${MUSIC_DB}dB,` +
      `afade=t=in:d=1,afade=t=out:st=${fadeOut}:d=1.5[music]`,
    "[music][key]sidechaincompress=threshold=0.05:ratio=2:attack=150:release=1500:knee=6:detection=rms:makeup=1,asplit=2[bed][bedStem]",
    "[voice][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]",
  ].join(";");

  const out = oldVideo.replace(/\.mp4$/i, `${OUT_SUFFIX}.mp4`);
  if (path.resolve(out) === oldVideo) throw new Error("OUT_SUFFIX rỗng sẽ ghi đè video gốc");
  if (fs.existsSync(out)) throw new Error(`Đã có ${out} - đổi OUT_SUFFIX, không ghi đè`);
  const stem = STEMS_DIR ? path.join(path.resolve(STEMS_DIR), `bed${OUT_SUFFIX}.wav`) : null;
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", oldVideo,
    "-i", dialogue,
    "-t", String(len), "-i", music,
    "-filter_complex", graph,
    "-map", "0:v", "-map", "[a]",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-t", String(len),
    "-movflags", "+faststart",
    out,
    ...(stem ? ["-map", "[bedStem]", "-c:a", "pcm_s16le", stem] : []),
  ]);
  if (stem) console.log(`Bed stem : ${stem}`);
  console.log(`Video cũ : ${oldVideo}`);
  console.log(`Video mới: ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
