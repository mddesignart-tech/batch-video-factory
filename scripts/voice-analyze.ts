import fs from "node:fs";
import path from "node:path";

/**
 * Measure what can be measured about a set of voice clips.
 *
 * This exists because the obvious question - "does Max sound funny?" - cannot
 * be answered by a program, and pretending otherwise would be worse than
 * useless. What a program CAN answer is whether the three voices are
 * physically distinct, whether the pace suits a Short, and whether the audio is
 * technically sound. Those are the parts where a human ear is unreliable and a
 * measurement is not.
 *
 * Everything here is local ffmpeg work. No network, no cost.
 *
 * Usage:
 *   npx tsx scripts/voice-analyze.ts --dir data/voice-test
 */

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

/**
 * Fundamental frequency by autocorrelation, averaged over voiced frames.
 *
 * Pitch is the single most reliable way to tell speakers apart mechanically:
 * adult male speech typically sits near 85-155 Hz and adult female near
 * 165-255 Hz, so it answers "is Mia actually distinct from the two men" with a
 * number instead of an impression.
 */
function estimatePitchHz(samples: Float32Array, sampleRate: number): {
  medianHz: number;
  rawMedianHz: number;
  corrections: number;
  voicedFrames: number;
} {
  const frameSize = Math.floor(sampleRate * 0.04); // 40 ms
  const hop = Math.floor(frameSize / 2);
  const minHz = 60;
  const maxHz = 400;
  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.floor(sampleRate / minHz);

  const pitches: number[] = [];
  const rawPitches: number[] = [];
  let corrections = 0;

  for (let start = 0; start + frameSize < samples.length; start += hop) {
    // Skip silence: autocorrelation on near-silence returns noise, and folding
    // that into an average would drag every speaker towards the same number.
    let energy = 0;
    for (let i = 0; i < frameSize; i += 1) {
      const s = samples[start + i] ?? 0;
      energy += s * s;
    }
    const rms = Math.sqrt(energy / frameSize);
    if (rms < 0.02) continue;

    let bestLag = 0;
    let bestCorr = 0;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let corr = 0;
      for (let i = 0; i < frameSize - lag; i += 1) {
        corr += (samples[start + i] ?? 0) * (samples[start + i + lag] ?? 0);
      }
      corr /= frameSize - lag;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }
    // Octave correction.
    //
    // Plain autocorrelation habitually locks onto the FIRST HARMONIC and
    // reports double the true pitch - which is exactly what happened on the
    // first run here, placing two male voices in the female range. If a
    // near-as-strong peak exists at 2x or 3x the lag, that longer period is
    // the real fundamental and the short one was its harmonic.
    let lag = bestLag;
    for (const mult of [2, 3]) {
      const candidate = bestLag * mult;
      if (candidate > maxLag) continue;
      let corr = 0;
      for (let i = 0; i < frameSize - candidate; i += 1) {
        corr += (samples[start + i] ?? 0) * (samples[start + i + candidate] ?? 0);
      }
      corr /= frameSize - candidate;
      // 0.85 rather than 1.0: the true fundamental's peak is usually slightly
      // weaker than its harmonic's, so requiring it to win outright would
      // never correct anything.
      // 0.9 rather than 1.0: the true fundamental's peak is usually slightly
      // weaker than its harmonic's, so requiring it to win outright would never
      // correct anything. Too permissive and it corrects voices that were
      // already right - which is why the raw figure is reported alongside.
      if (corr > bestCorr * 0.9) {
        lag = candidate;
        corrections += 1;
        break;
      }
    }

    // A weak peak means the frame was unvoiced (a consonant, breath). Those
    // have no pitch, so counting them would be inventing data.
    if (lag > 0 && bestCorr > 0.3 * (energy / frameSize)) {
      pitches.push(sampleRate / lag);
      rawPitches.push(sampleRate / bestLag);
    }
  }

  if (pitches.length === 0) {
    return { medianHz: 0, rawMedianHz: 0, corrections: 0, voicedFrames: 0 };
  }
  return {
    medianHz: median(pitches),
    rawMedianHz: median(rawPitches),
    corrections,
    voicedFrames: pitches.length,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/** Perceptual distance. 1 semitone is the smallest interval most ears name. */
function semitonesBetween(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  return Math.abs(12 * Math.log2(a / b));
}

/** Fraction of the clip that is effectively silence, as a pacing signal. */
function silenceRatio(samples: Float32Array, sampleRate: number): number {
  const win = Math.floor(sampleRate * 0.02);
  let quiet = 0;
  let total = 0;
  for (let start = 0; start + win < samples.length; start += win) {
    let energy = 0;
    for (let i = 0; i < win; i += 1) {
      const s = samples[start + i] ?? 0;
      energy += s * s;
    }
    if (Math.sqrt(energy / win) < 0.01) quiet += 1;
    total += 1;
  }
  return total === 0 ? 0 : quiet / total;
}

async function main(): Promise<void> {
  const dir = arg("dir", "data/voice-test");
  const { ffprobe, ffmpeg, resolveFfmpeg } = await import("../src/media/ffmpeg");
  const os = await import("node:os");

  if (!resolveFfmpeg()) {
    console.log("Khong tim thay ffmpeg.");
    process.exitCode = 1;
    return;
  }

  const abs = path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
  if (!fs.existsSync(abs)) {
    console.log(`Khong co thu muc ${abs}`);
    process.exitCode = 1;
    return;
  }
  const files = fs
    .readdirSync(abs)
    .filter((f) => /\.(wav|mp3|flac|opus|aac)$/i.test(f))
    .sort();

  console.log("\n========== DO KHACH QUAN CAC TEP GIONG ==========\n");
  console.log("  (Khong the cham 'co hai khong' bang may - phan do la phan do duoc.)\n");

  const results: {
    name: string;
    hz: number;
    rawHz: number;
    seconds: number;
    silence: number;
    peakDb: number;
    rmsDb: number;
  }[] = [];

  for (const file of files) {
    const full = path.join(abs, file);

    const probe = await ffprobe([
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=sample_rate,channels,codec_name:format=duration",
      "-of", "default=noprint_wrappers=1",
      full,
    ]);
    const info: Record<string, string> = {};
    for (const line of probe.stdout.trim().split(/\r?\n/)) {
      const [k, v] = line.split("=");
      if (k && v) info[k] = v;
    }
    const sampleRate = Number(info.sample_rate ?? 24000);
    const seconds = Number(info.duration ?? 0);

    // Loudness, from ffmpeg's own measurement rather than ours.
    const stats = await ffmpeg([
      "-v", "error",
      "-i", full,
      "-af", "astats=measure_perchannel=Peak_level+RMS_level",
      "-f", "null", "-",
    ]).catch(() => null);
    const statText = stats ? `${stats.stdout}${stats.stderr}` : "";
    // astats writes to stderr with a filter prefix, and prints one block per
    // channel plus an "Overall" block; the last match is the overall figure.
    const peaks = [...statText.matchAll(/Peak level dB:\s*(-?[\d.]+|-inf)/g)];
    const rmss = [...statText.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/g)];
    const peakDb = Number(peaks[peaks.length - 1]?.[1] ?? NaN);
    const rmsDb = Number(rmss[rmss.length - 1]?.[1] ?? NaN);

    // Decode to mono float PCM for the pitch work.
    const raw = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "va-")), "mono.f32");
    await ffmpeg([
      "-v", "error",
      "-i", full,
      "-ac", "1",
      "-f", "f32le",
      "-y", raw,
    ]);
    const buf = fs.readFileSync(raw);
    const samples = new Float32Array(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    );
    fs.rmSync(path.dirname(raw), { recursive: true, force: true });

    const { medianHz, rawMedianHz, corrections, voicedFrames } = estimatePitchHz(
      samples,
      sampleRate,
    );
    const quiet = silenceRatio(samples, sampleRate);

    const name = file.replace(/-\d+\.\w+$/, "");
    console.log(`  ---- ${file} ----`);
    console.log(`    Codec / rate    : ${info.codec_name ?? "?"} ${sampleRate} Hz, ${info.channels ?? "?"} kenh`);
    console.log(`    Thoi luong      : ${seconds.toFixed(2)}s`);
    console.log(
      `    Cao do trung vi : ${medianHz.toFixed(1)} Hz da sua quang tam, ` +
        `${rawMedianHz.toFixed(1)} Hz truoc khi sua (${voicedFrames} khung co thanh, ` +
        `${corrections} lan sua)`,
    );
    console.log(`    Ty le im lang   : ${(quiet * 100).toFixed(1)}%`);
    console.log(`    Peak / RMS      : ${Number.isFinite(peakDb) ? peakDb.toFixed(1) : "?"} dB / ${Number.isFinite(rmsDb) ? rmsDb.toFixed(1) : "?"} dB`);
    console.log("");

    results.push({
      name,
      hz: medianHz,
      rawHz: rawMedianHz,
      seconds,
      silence: quiet,
      peakDb,
      rmsDb,
    });
  }

  // ---- are the voices actually different? --------------------------------
  if (results.length >= 2) {
    console.log("  ---- KHAC BIET GIUA CAC GIONG ----");
    const sorted = [...results].sort((a, b) => a.hz - b.hz);
    for (const r of sorted) {
      const band =
        r.hz === 0
          ? "khong do duoc"
          : r.hz < 165
            ? "vung nam dien hinh (85-155 Hz)"
            : r.hz < 265
              ? "vung nu dien hinh (165-255 Hz)"
              : "cao hon vung noi thuong";
      console.log(`    ${r.name.padEnd(6)} ${r.hz.toFixed(1).padStart(6)} Hz   ${band}`);
    }
    // Semitones, not Hz. Pitch is heard on a ratio scale, so 14 Hz between two
    // low voices is a far bigger difference than 14 Hz between two high ones,
    // and a gap in Hz answers the wrong question. It is also octave-robust: a
    // consistent octave error shifts every voice by the same 12 semitones and
    // leaves the SPACING between them unchanged - which is why the spacing is
    // the figure to trust here and the absolute Hz is not.
    let minSemi = Infinity;
    let pair = "";
    for (let i = 1; i < sorted.length; i += 1) {
      const a = sorted[i - 1];
      const b = sorted[i];
      if (!a || !b) continue;
      const semi = semitonesBetween(a.hz, b.hz);
      if (semi < minSemi) {
        minSemi = semi;
        pair = `${a.name} vs ${b.name}`;
      }
    }
    console.log(
      `\n    Cach nhau it nhat: ${minSemi.toFixed(1)} ban cung (${pair})` +
        (minSemi >= 3
          ? "  -> du de nghe ra hai nguoi khac nhau"
          : minSemi >= 1.5
            ? "  -> phan biet duoc nhung chua ro rang"
            : "  -> QUA GAN, nguoi nghe co the nham"),
    );
    // The same spacing computed on the UNCORRECTED figures. When the two agree
    // the result can be trusted; when they disagree, say so rather than picking
    // whichever one reads better.
    const rawSorted = [...results].sort((a, b) => a.rawHz - b.rawHz);
    let rawMinSemi = Infinity;
    let rawPair = "";
    for (let i = 1; i < rawSorted.length; i += 1) {
      const a = rawSorted[i - 1];
      const b = rawSorted[i];
      if (!a || !b) continue;
      const semi = semitonesBetween(a.rawHz, b.rawHz);
      if (semi < rawMinSemi) {
        rawMinSemi = semi;
        rawPair = `${a.name} vs ${b.name}`;
      }
    }
    console.log(
      `    Tinh tren so CHUA sua: ${rawMinSemi.toFixed(1)} ban cung (${rawPair})`,
    );
    console.log(
      "\n    Luu y: so Hz tuyet doi co the lech mot quang tam (x2 hoac /2)." +
        "\n    Phep sua quang tam chay so lan khac nhau tren tung tep nen KHONG tu" +
        "\n    triet tieu giua cac giong. Cap nao ca hai con so deu nho thi ket luan" +
        "\n    chac; cap nao hai con so lech nhau thi phai nghe bang tai moi biet.",
    );
  }
  console.log("");
}

main().catch((err: unknown) => {
  console.error("That bai:", err);
  process.exitCode = 1;
});
