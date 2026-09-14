import fs from "node:fs";
import path from "node:path";

/**
 * Level and trim voice clips that already exist, with ffmpeg only.
 *
 * Re-synthesising to fix loudness would be paying a vendor to solve a problem
 * that is entirely local. The clips are already on disk and already paid for;
 * this is a filter chain, not a purchase. No network, no cost.
 *
 * Usage:
 *   npx tsx scripts/voice-normalize.ts --dir data/voice-test
 *   npx tsx scripts/voice-normalize.ts --dir data/voice-test --out data/voice-test-norm
 */

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "?";
}

async function main(): Promise<void> {
  const dir = arg("dir", "data/voice-test");
  const outDir = arg("out", "data/voice-test-normalized");

  const {
    normalizeVoiceClip,
    withinVoiceTargets,
    VOICE_TARGET_LUFS,
    VOICE_TARGET_TRUE_PEAK,
    VOICE_TARGET_LRA,
  } = await import("../src/media/audio-normalize");
  const { resolveFfmpeg } = await import("../src/media/ffmpeg");

  if (!resolveFfmpeg()) {
    console.log("Khong tim thay ffmpeg.");
    process.exitCode = 1;
    return;
  }

  const absIn = path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
  const absOut = path.isAbsolute(outDir) ? outDir : path.join(process.cwd(), outDir);
  if (!fs.existsSync(absIn)) {
    console.log(`Khong co thu muc ${absIn}`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(absOut, { recursive: true });

  const files = fs
    .readdirSync(absIn)
    .filter((f) => /\.(wav|mp3|flac|opus|aac)$/i.test(f))
    .sort();

  console.log("\n========== CHUAN HOA AM LUONG (ffmpeg, khong ton tien) ==========\n");
  console.log(`  Muc tieu: I=${VOICE_TARGET_LUFS} LUFS, TP=${VOICE_TARGET_TRUE_PEAK} dBTP, LRA=${VOICE_TARGET_LRA} LU`);
  console.log(`  Nguon   : ${absIn}`);
  console.log(`  Dich    : ${absOut}\n`);

  const rows: { name: string; beforeI: number; afterI: number; beforeTp: number; afterTp: number; dur: number; trimmed: number }[] = [];

  for (const file of files) {
    const name = file.replace(/-\d+\.\w+$/, "").replace(/\.\w+$/, "");
    const out = path.join(absOut, `${name}.wav`);
    // A previous run's output would make ffmpeg prompt or fail; this script is
    // idempotent by design so it can be re-run while tuning targets.
    if (fs.existsSync(out)) fs.rmSync(out);

    process.stdout.write(`  ${name.padEnd(6)} ... `);
    try {
      const r = await normalizeVoiceClip(path.join(absIn, file), out);
      console.log("xong");
      console.log(`    Truoc : I ${fmt(r.before.integratedLufs)} LUFS, TP ${fmt(r.before.truePeakDb)} dBTP, LRA ${fmt(r.before.lra)} LU`);
      console.log(`    Sau   : I ${fmt(r.after.integratedLufs)} LUFS, TP ${fmt(r.after.truePeakDb)} dBTP, LRA ${fmt(r.after.lra)} LU`);
      console.log(`    Cat im: ${fmt(r.trimmedSeconds)}s  |  Thoi luong CUOI: ${fmt(r.durationSec)}s`);
      console.log(`    Dat muc tieu: ${withinVoiceTargets(r.after) ? "CO" : "CHUA"}`);
      console.log(`    Tep   : ${out}\n`);
      rows.push({
        name,
        beforeI: r.before.integratedLufs,
        afterI: r.after.integratedLufs,
        beforeTp: r.before.truePeakDb,
        afterTp: r.after.truePeakDb,
        dur: r.durationSec,
        trimmed: r.trimmedSeconds,
      });
    } catch (err) {
      console.log(`LOI: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  }

  if (rows.length >= 2) {
    const spreadBefore =
      Math.max(...rows.map((r) => r.beforeI)) - Math.min(...rows.map((r) => r.beforeI));
    const spreadAfter =
      Math.max(...rows.map((r) => r.afterI)) - Math.min(...rows.map((r) => r.afterI));
    console.log("  ---- CHENH LECH GIUA CAC NHAN VAT ----");
    console.log(`    Truoc khi chuan hoa: ${fmt(spreadBefore, 1)} LU`);
    console.log(`    Sau khi chuan hoa  : ${fmt(spreadAfter, 1)} LU`);

    // A clip whose peaks bind before its loudness does cannot reach the target
    // with one linear gain - the choice is a slightly quieter clip or a
    // squashed performance, and quieter is the right one. Naming which clips
    // are in that position is more useful than a pass/fail on the spread.
    const peakBound = rows.filter(
      (r) =>
        r.afterI < VOICE_TARGET_LUFS - 0.5 &&
        r.afterTp >= VOICE_TARGET_TRUE_PEAK - 0.1,
    );
    if (peakBound.length > 0) {
      console.log(
        `    Bi gioi han boi dinh: ${peakBound
          .map((r) => `${r.name} (${fmt(r.afterI, 1)} LUFS)`)
          .join(", ")}`,
      );
      console.log(
        "    Nhung tep nay cham tran true peak truoc khi du to. Ep to them thi\n" +
          "    phai nen dong, lam mat cach dien - nen chap nhan nho hon mot chut.",
      );
    }

    console.log(
      spreadAfter <= 1.5
        ? "    -> Du deu. Nguoi xem chinh am luong mot lan la nghe duoc ca ba.\n"
        : "    -> VAN CON LECH dang ke, can xem lai.\n",
    );
  }
}

main().catch((err: unknown) => {
  console.error("That bai:", err);
  process.exitCode = 1;
});
