import fs from "node:fs";
import path from "node:path";

/**
 * QĐ-150 check: mix the AIVietLab test video again with the NEW Audio Mixer
 * (Review AI preset) from its source tracks, so its levels can be compared with
 * the render the person approved (final_27c46866_qd149_music_plus2db.mp4).
 * Picture stream-copied, local FFmpeg only, $0.
 *
 * The test project was made by a script, not the app, so it has no source
 * manifest: the line regions are read off the dialogue track (silencedetect),
 * which for this one check stands in for the timeline the app records.
 *
 *   npx tsx scripts/qd150-mixer-validate.ts [presetId]
 *   BED_ONLY=<wav> ... writes the ducked music alone (voice at 0) for level checks.
 */

const ID = "aivietlab-test-2026-10-22";

async function main(): Promise<void> {
  const { toAbsolute, projectSubdir } = await import("../src/lib/paths");
  const { ffmpeg, probeDuration } = await import("../src/media/ffmpeg");
  const { renderMixerMix, measureMusicLufs } = await import("../src/media/audio-mixer-render");
  const { systemPreset } = await import("../src/domain/audio-mixer");

  const preset = systemPreset(process.argv[2] ?? "REVIEW_AI");
  if (!preset) throw new Error("Không có preset này");
  const finalDir = toAbsolute(projectSubdir(ID, "final"));
  const video = path.join(finalDir, "final_27c46866.mp4");
  const dialogue = path.join(toAbsolute(projectSubdir(ID, "audio")), "project-dialogue.wav");
  const music = toAbsolute(path.join("music", "aivietlab-tech-bg.mp3"));
  const totalSec = Math.round((await probeDuration(video)) * 1000) / 1000;

  const det = await ffmpeg(["-hide_banner", "-nostats", "-i", dialogue, "-af", "silencedetect=noise=-45dB:d=0.15", "-f", "null", "-"]);
  const log = `${det.stdout}${det.stderr}`;
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  // Speech = the complement of the silences.
  const regions: { startSec: number; endSec: number }[] = [];
  let cursor = 0;
  starts.forEach((s, i) => {
    if (s > cursor) regions.push({ startSec: cursor, endSec: s });
    cursor = ends[i] ?? totalSec;
  });
  if (cursor < totalSec - 0.05) regions.push({ startSec: cursor, endSec: totalSec });

  const v = preset.values;
  const suffix = `_qd150_mixer_${preset.id.toLowerCase()}`;
  const mix = path.join(finalDir, `mix${suffix}.wav`);
  const out = path.join(finalDir, `final_27c46866${suffix}.mp4`);
  if (!process.env.BED_ONLY && fs.existsSync(out)) throw new Error(`Đã có ${out} - không ghi đè`);
  const musicLufs = await measureMusicLufs(music);
  const r = await renderMixerMix(
    {
      dialoguePath: dialogue,
      totalSec,
      regions,
      musicPath: music,
      musicLufs,
      settings: {
        musicPct: v.musicPct,
        duckDb: process.env.DUCK_DB !== undefined ? Number(process.env.DUCK_DB) : v.duck ? v.duckDb : 0,
        attackMs: v.attackMs,
        releaseMs: v.releaseMs,
        fadeInSec: v.fadeInSec,
        fadeOutSec: v.fadeOutSec,
        sfxGain: v.sfxPct,
        voice: { gain: process.env.BED_ONLY ? 0 : v.voicePct, normalize: false },
      },
    },
    process.env.BED_ONLY ?? mix,
  );
  if (process.env.BED_ONLY) {
    console.log(`Bed only: ${process.env.BED_ONLY} (gain ${r.musicGainDb} dB)`);
    return;
  }
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", video, "-i", mix,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-t", String(totalSec), "-movflags", "+faststart", out,
  ]);
  if (process.env.KEEP_MIX !== "1") fs.rmSync(mix);
  console.log(JSON.stringify({ preset: preset.id, musicLufs, musicGainDb: r.musicGainDb, regions: regions.length, out }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
