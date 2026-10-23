import fs from "node:fs";
import path from "node:path";

/**
 * QĐ-150 preset listening check: short MP3 previews of every system Audio
 * Preset over the SAME AIVietLab voice (Thục Đoan) and music, plus the stems
 * needed to measure each preset's music level and duck. Audio only - no video,
 * no TTS, no image: local FFmpeg over files already on disk, $0.
 *
 * "Video không lời" is previewed WITHOUT the voice (that is what such a video
 * is); its ducking is off by design.
 *
 *   npx tsx scripts/qa/qd150-preset-previews.ts [startSec] [endSec]
 * Output: data/projects/aivietlab-test-2026-10-22/audio-previews/ (KEEP_STEMS=1 keeps the WAV stems)
 */

const ID = "aivietlab-test-2026-10-22";

async function main(): Promise<void> {
  const { toAbsolute, projectSubdir } = await import("../../src/lib/paths");
  const { ffmpeg, probeDuration } = await import("../../src/media/ffmpeg");
  const { renderMixerMix, measureMusicLufs } = await import("../../src/media/audio-mixer-render");
  const { SYSTEM_AUDIO_PRESETS } = await import("../../src/domain/audio-mixer");
  const { measureLoudness } = await import("../../src/media/audio-normalize");

  const start = Number(process.argv[2] ?? "0");
  const end = Number(process.argv[3] ?? "16");
  const video = path.join(toAbsolute(projectSubdir(ID, "final")), "final_27c46866.mp4");
  const dialogue = path.join(toAbsolute(projectSubdir(ID, "audio")), "project-dialogue.wav");
  const music = toAbsolute(path.join("music", "aivietlab-tech-bg.mp3"));
  const outDir = path.join(path.dirname(toAbsolute(projectSubdir(ID, "final"))), "audio-previews");
  const work = path.join(outDir, "_stems");
  fs.mkdirSync(work, { recursive: true });
  const totalSec = Math.round((await probeDuration(video)) * 1000) / 1000;

  // Line regions read off the dialogue track (this test project has no app timeline).
  const det = await ffmpeg(["-hide_banner", "-nostats", "-i", dialogue, "-af", "silencedetect=noise=-45dB:d=0.15", "-f", "null", "-"]);
  const log = `${det.stdout}${det.stderr}`;
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const regions: { startSec: number; endSec: number }[] = [];
  let cursor = 0;
  starts.forEach((s, i) => {
    if (s > cursor) regions.push({ startSec: cursor, endSec: s });
    cursor = ends[i] ?? totalSec;
  });
  if (cursor < totalSec - 0.05) regions.push({ startSec: cursor, endSec: totalSec });

  const musicLufs = await measureMusicLufs(music);
  const rows: Record<string, unknown>[] = [];
  for (const p of SYSTEM_AUDIO_PRESETS) {
    const v = p.values;
    const noVoice = p.id === "NO_VOICE";
    const settings = (voiceGain: number, duckDb: number) => ({
      musicPct: v.musicPct,
      duckDb,
      attackMs: v.attackMs,
      releaseMs: v.releaseMs,
      fadeInSec: v.fadeInSec,
      fadeOutSec: v.fadeOutSec,
      sfxGain: v.sfxPct,
      voice: { gain: voiceGain, normalize: false },
    });
    const duck = v.duck ? v.duckDb : 0;
    const base = { dialoguePath: dialogue, totalSec, regions: noVoice ? [] : regions, musicPath: music, musicLufs };
    const slug = p.id.toLowerCase();
    const mp3 = path.join(outDir, `qd150-${slug}.mp3`);
    const r = await renderMixerMix({ ...base, settings: settings(noVoice ? 0 : v.voicePct, duck) }, mp3, { window: { startSec: start, endSec: end }, format: "mp3" });
    const mix = path.join(work, `${slug}-mix.wav`);
    const bed = path.join(work, `${slug}-bed.wav`);
    const flat = path.join(work, `${slug}-bed-noduck.wav`);
    await renderMixerMix({ ...base, settings: settings(noVoice ? 0 : v.voicePct, duck) }, mix);
    await renderMixerMix({ ...base, settings: settings(0, duck) }, bed);
    await renderMixerMix({ ...base, settings: settings(0, 0) }, flat);
    const [mixL, bedL, flatL] = await Promise.all([measureLoudness(mix), measureLoudness(bed), measureLoudness(flat)]);
    rows.push({
      preset: p.name,
      musicPct: v.musicPct,
      musicGainDb: r.musicGainDb,
      duck: v.duck ? `-${v.duckDb} dB, attack ${v.attackMs} ms, release ${v.releaseMs} ms` : "tắt",
      fades: `${v.fadeInSec}s / ${v.fadeOutSec}s`,
      mixLufs: mixL.integratedLufs,
      mixTruePeak: mixL.truePeakDb,
      bedLufs: bedL.integratedLufs,
      bedNoDuckLufs: flatL.integratedLufs,
      preview: mp3,
    });
  }
  fs.writeFileSync(path.join(outDir, "measurements.json"), JSON.stringify({ window: [start, end], musicLufs, regions: regions.length, rows }, null, 2));
  // The full-length stems were only needed for the numbers above (~130 MB).
  if (process.env.KEEP_STEMS !== "1") fs.rmSync(work, { recursive: true, force: true });
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
