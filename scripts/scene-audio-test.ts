import fs from "node:fs";
import path from "node:path";

/**
 * Build one three-speaker scene from clips that already exist.
 *
 * Everything here is local ffmpeg work on audio that was already paid for. No
 * TTS call, no network, no cost - the question being answered is whether the
 * timeline, the scene mix and the ducking behave, and none of that needs new
 * speech to test.
 *
 * Usage:
 *   npx tsx scripts/scene-audio-test.ts
 *   npx tsx scripts/scene-audio-test.ts --music path/to/bed.wav
 */

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : "?";
}

/** Mean square level of a window, read straight from the decoded samples. */
async function windowRms(file: string, fromSec: number, toSec: number): Promise<number> {
  const os = await import("node:os");
  const { ffmpeg } = await import("../src/media/ffmpeg");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "win-"));
  const raw = path.join(dir, "w.f32");
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", String(fromSec), "-to", String(toSec),
    "-i", file, "-ac", "1", "-f", "f32le", raw,
  ]);
  const buf = fs.readFileSync(raw);
  const samples = new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
  fs.rmSync(dir, { recursive: true, force: true });
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return samples.length === 0 ? 0 : Math.sqrt(sum / samples.length);
}

/**
 * The scene under test: Max sets up, Leo corrects, Mia lands the joke.
 *
 * Three speakers rather than two on purpose - two lines can be concatenated by
 * accident and look right, three exposes an ordering or offset mistake.
 */
const SCENE_LINES = [
  { speaker: "Max", file: "max.wav", text: "Wait, you want me to spill the beans?" },
  { speaker: "Leo", file: "leo.wav", text: "Spill the beans means to tell a secret." },
  { speaker: "Mia", file: "mia.wav", text: "Now the secret AND the beans are on the floor." },
];

/** A short music bed, synthesised locally, so ducking can be heard. */
async function makeMusicBed(outPath: string, seconds: number): Promise<void> {
  const { ffmpeg } = await import("../src/media/ffmpeg");
  await ffmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=196:duration=${seconds}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=294:duration=${seconds}`,
    "-filter_complex",
    "[0:a][1:a]amix=inputs=2:normalize=0,volume=0.4,aresample=24000[out]",
    "-map",
    "[out]",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
}

async function main(): Promise<void> {
  const srcDir = arg("dir", "data/voice-test-normalized");
  const outDir = arg("out", "data/scene-audio-test");
  const musicArg = arg("music", "");

  const { buildSceneTimeline, hasOverlap } = await import("../src/domain/scene-timeline");
  const { renderSceneDialogue, renderFinalMix, renderDuckedBedOnly } = await import(
    "../src/media/scene-audio"
  );
  const { cuesFromTimelines, buildSRT } = await import("../src/media/subtitles");
  const { probeDuration, resolveFfmpeg } = await import("../src/media/ffmpeg");
  const { DEFAULT_MIX } = await import("../src/media/mix-config");

  if (!resolveFfmpeg()) {
    console.log("Khong tim thay ffmpeg.");
    process.exitCode = 1;
    return;
  }

  const absSrc = path.isAbsolute(srcDir) ? srcDir : path.join(process.cwd(), srcDir);
  const absOut = path.isAbsolute(outDir) ? outDir : path.join(process.cwd(), outDir);
  fs.mkdirSync(absOut, { recursive: true });

  console.log("\n========== DUNG THU MOT CANH 3 NGUOI NOI ==========\n");
  console.log("  (Chi dung ffmpeg tren audio da co. Khong goi TTS, khong ton tien.)\n");

  // ---- gather the lines, measuring each one -----------------------------
  const lines = [];
  for (let i = 0; i < SCENE_LINES.length; i += 1) {
    const line = SCENE_LINES[i];
    if (!line) continue;
    const audioPath = path.join(absSrc, line.file);
    if (!fs.existsSync(audioPath)) {
      console.log(`  [DUNG] Thieu tep ${audioPath}.`);
      console.log("  Chay 'npm run voice:normalize' truoc.\n");
      process.exitCode = 1;
      return;
    }
    // Measured from the finished file, never estimated from the text.
    const durationSec = await probeDuration(audioPath);
    lines.push({
      lineNumber: i + 1,
      speaker: line.speaker,
      text: line.text,
      audioPath,
      durationSec,
    });
  }

  // ---- 1. the timeline ---------------------------------------------------
  const PLANNED = 6;
  const timeline = buildSceneTimeline(lines, PLANNED);

  console.log("--- 1. SCENE AUDIO TIMELINE ---\n");
  console.log("  #  Nhan vat  Bat dau   Dai     Ket thuc  Nghi sau  Doi nguoi");
  for (const e of timeline.entries) {
    console.log(
      `  ${String(e.lineNumber).padEnd(2)} ${e.speaker.padEnd(9)} ` +
        `${fmt(e.startSec).padStart(7)}s ${fmt(e.durationSec).padStart(6)}s ` +
        `${fmt(e.endSec).padStart(8)}s ${fmt(e.pauseAfterSec).padStart(8)}s  ` +
        `${e.speakerChanged ? "CO" : "khong"}`,
    );
  }
  console.log(`\n  Tong loi noi : ${fmt(timeline.speechDurationSec)}s`);
  console.log(`  Canh du kien : ${PLANNED}s`);
  console.log(`  Canh thuc te : ${fmt(timeline.sceneDurationSec)}s${timeline.extended ? "  (KEO DAI vi loi noi dai hon)" : ""}`);
  console.log(`  Chong tieng  : ${hasOverlap(timeline) ? "CO - LOI!" : "KHONG"}`);

  // ---- 2. the scene dialogue track ---------------------------------------
  const dialoguePath = path.join(absOut, "scene-dialogue.wav");
  if (fs.existsSync(dialoguePath)) fs.rmSync(dialoguePath);
  const scene = await renderSceneDialogue(timeline, dialoguePath);

  console.log("\n--- 2. SCENE DIALOGUE TRACK ---\n");
  console.log(`  Tep        : ${scene.outputPath}`);
  console.log(`  So cau     : ${scene.lineCount}`);
  console.log(`  Thoi luong : ${fmt(scene.durationSec)}s  (do tu tep, khong cong tay)`);
  console.log(`  Do to      : ${fmt(scene.loudness.integratedLufs)} LUFS, TP ${fmt(scene.loudness.truePeakDb)} dBTP`);
  console.log("  Cac tep goc tung cau van giu nguyen de sua lai tung cau.");

  // ---- 3. subtitles from the same timeline -------------------------------
  const cues = cuesFromTimelines([timeline]);
  const srtPath = path.join(absOut, "scene.srt");
  fs.writeFileSync(srtPath, buildSRT(cues), "utf8");

  console.log("\n--- 3. PHU DE TU CHINH TIMELINE ---\n");
  for (const c of cues) {
    console.log(`  ${fmt(c.startSeconds)}s -> ${fmt(c.endSeconds)}s  "${c.text}"`);
  }
  console.log(`  Tep: ${srtPath}`);

  // ---- 4. final mix ------------------------------------------------------
  const musicPath = musicArg
    ? path.isAbsolute(musicArg)
      ? musicArg
      : path.join(process.cwd(), musicArg)
    : path.join(absOut, "music-bed.wav");
  if (!musicArg) {
    if (fs.existsSync(musicPath)) fs.rmSync(musicPath);
    await makeMusicBed(musicPath, Math.ceil(scene.durationSec) + 2);
  }

  const mixPath = path.join(absOut, "scene-final-mix.wav");
  if (fs.existsSync(mixPath)) fs.rmSync(mixPath);
  const mix = await renderFinalMix({ dialoguePath, musicPath }, mixPath);

  console.log("\n--- 4. FINAL MIX (thoai + nhac, co ducking) ---\n");
  console.log(`  Tep        : ${mix.outputPath}`);
  console.log(`  Thoi luong : ${fmt(mix.durationSec)}s`);
  console.log(`  Integrated : ${fmt(mix.loudness.integratedLufs)} LUFS`);
  console.log(`  True peak  : ${fmt(mix.loudness.truePeakDb)} dBTP`);
  console.log(`  LRA        : ${fmt(mix.loudness.lra)} LU`);
  console.log(
    `\n  Cai dat mix: music ${mix.settings.musicGain}, duck ${mix.settings.duckDb} dB, ` +
      `attack ${mix.settings.attackMs}ms, release ${mix.settings.releaseMs}ms, sfx ${mix.settings.sfxGain}`,
  );
  console.log(`  Mac dinh   : ${JSON.stringify(DEFAULT_MIX) === JSON.stringify(mix.settings) ? "dung preset an toan" : "da doi"}`);

  // A dialogue-only render of the same length, so the two can be compared by
  // ear: if the mix is quieter than this, the music is fighting the voice.
  console.log("\n  So sanh    :");
  console.log(`    Chi thoai : ${fmt(scene.loudness.integratedLufs)} LUFS`);
  console.log(`    Sau khi mix: ${fmt(mix.loudness.integratedLufs)} LUFS`);
  const delta = mix.loudness.integratedLufs - scene.loudness.integratedLufs;
  console.log(
    `    Chenh lech : ${delta >= 0 ? "+" : ""}${fmt(delta, 1)} LU` +
      (delta < -1
        ? "  <-- CANH BAO: giong bi nho di sau khi them nhac"
        : "  -> giong khong bi nhac lan at"),
  );

  // ---- 5. prove the ducking, do not just claim it ------------------------
  const bedPath = path.join(absOut, "music-ducked-only.wav");
  if (fs.existsSync(bedPath)) fs.rmSync(bedPath);
  await renderDuckedBedOnly({ dialoguePath, musicPath }, bedPath);

  // Compared against the SAME bed with ducking switched off, measured while
  // someone is speaking.
  //
  // The obvious comparison - bed during speech versus bed in the gap between
  // two lines - gives a misleadingly small number here, and the first version
  // of this script fell for it: the inter-line gap is 0.28s while the release
  // is 350ms, so the music has barely begun to recover before the next line
  // starts. That is intended behaviour (a bed surging back for a quarter of a
  // second between every line would pump), but it makes the gap the wrong
  // window to measure in.
  const flatPath = path.join(absOut, "music-unducked.wav");
  if (fs.existsSync(flatPath)) fs.rmSync(flatPath);
  await renderDuckedBedOnly(
    { dialoguePath, musicPath, settings: { duckDb: 0 } },
    flatPath,
  );

  const ducked = await windowRms(bedPath, 1.0, 3.5);
  const flat = await windowRms(flatPath, 1.0, 3.5);
  const reduction = flat > 0 ? 20 * Math.log10(Math.max(ducked, 1e-9) / flat) : 0;

  console.log("\n--- 5. KIEM CHUNG DUCKING (do rieng lop nhac) ---\n");
  console.log(`  Nhac da duck    : ${bedPath}`);
  console.log(`  Nhac KHONG duck : ${flatPath}`);
  console.log(`  RMS khi co loi, khong duck : ${flat.toExponential(3)}`);
  console.log(`  RMS khi co loi, co duck    : ${ducked.toExponential(3)}`);
  console.log(
    `  Muc ha xuong    : ${fmt(reduction, 1)} dB (dat ${DEFAULT_MIX.duckDb} dB)` +
      (reduction < -8 ? "  -> nhac CO tranh duong cho loi" : "  -> KHONG duck du"),
  );
  console.log(
    "  Luu y: khe nghi giua hai cau chi 0.28s, ngan hon release 350ms, nen nhac\n" +
      "  giu nguyen muc thap suot doan thoai thay vi vot len tung khe - dung y do.",
  );

  console.log(`\n  Nghe thu o : ${absOut}\n`);
}

main().catch((err: unknown) => {
  console.error("That bai:", err);
  process.exitCode = 1;
});
