import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * Render a real project end to end, with ffmpeg only.
 *
 * The point is to prove the production renderer works on real data. Every
 * helper has its own tests and they all pass; what they cannot show is whether
 * `renderProject` actually reaches them when handed a project out of the
 * database rather than a fixture built for the test.
 *
 * NOTHING here calls a paid API. It attaches voice clips that already exist on
 * disk to the project's dialogue lines, then renders. See the warning printed
 * at the top of the run about what that does and does not prove.
 *
 * Usage:
 *   npx tsx scripts/project-render-test.ts --idiom "Spill the beans"
 */

const prisma = new PrismaClient();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : "?";
}

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "[DAT ]" : "[HONG]"} ${label.padEnd(34)} ${detail}`);
}

/** Which existing clip stands in for which character. */
const VOICE_FIXTURES: Record<string, string> = {
  Max: "max.wav",
  Leo: "leo.wav",
  Mia: "mia.wav",
};

async function main(): Promise<void> {
  const idiom = arg("idiom", "Spill the beans");
  const voiceDir = arg("voices", "data/voice-test-normalized");

  const { parseDialogueLines } = await import("../src/domain/dialogue-lines");
  const { sceneCharacters } = await import("../src/domain/scene-characters");
  const { renderProject, targetForAspect } = await import("../src/media/render");
  const { measureLoudness } = await import("../src/media/audio-normalize");
  const { DEFAULT_MIX } = await import("../src/media/mix-config");
  const { buildSceneTimeline, pauseFromMs } = await import("../src/domain/scene-timeline");
  const { ffmpeg, ffprobe, probeDuration, resolveFfmpeg } = await import("../src/media/ffmpeg");
  const { toAbsolute, toRelative, projectSubdir } = await import("../src/lib/paths");

  if (!resolveFfmpeg()) {
    console.log("Khong tim thay ffmpeg.");
    process.exitCode = 1;
    return;
  }

  console.log("\n========== NGHIEM THU RENDER PROJECT THAT ==========\n");
  console.log("  KHONG goi API tra phi nao. Chi FFmpeg cuc bo.\n");
  console.log("  LUU Y QUAN TRONG VE AM THANH:");
  console.log("  Project nay chua tung chay TTS, nen khong co giong dung loi thoai.");
  console.log("  Script gan 3 tep giong CO SAN (Max/Leo/Mia) vao cac cau thoai de");
  console.log("  kiem tra DUONG ONG. Noi dung noi KHONG khop chu tren man hinh.");
  console.log("  Day la phep thu ky thuat, khong phai ban video de dang len.\n");

  const absVoiceDir = path.isAbsolute(voiceDir)
    ? voiceDir
    : path.join(process.cwd(), voiceDir);

  const project = await prisma.project.findFirst({
    where: { idiom: { phrase: idiom } },
    include: { idiom: true, scenes: { orderBy: { sceneNumber: "asc" } } },
  });
  if (!project) {
    console.log(`  [DUNG] Khong tim thay du an "${idiom}".\n`);
    process.exitCode = 1;
    return;
  }

  // ---- 1. attach existing audio to the project's real dialogue lines -----
  console.log("--- 1. GAN GIONG CO SAN VAO CAC CAU THOAI ---\n");

  const characters = await prisma.character.findMany();
  const byName = new Map(characters.map((c) => [c.name, c]));
  let lineTotal = 0;

  for (const scene of project.scenes) {
    if (scene.skipped) continue;
    const speaking = sceneCharacters(scene).speaking;
    const parsed = parseDialogueLines(scene.dialogue, scene.narration, speaking);

    await prisma.dialogueLine.deleteMany({ where: { sceneId: scene.id } });

    for (const line of parsed) {
      const fixture = VOICE_FIXTURES[line.speaker];
      if (!fixture) continue;
      const source = path.join(absVoiceDir, fixture);
      if (!fs.existsSync(source)) {
        console.log(`  [DUNG] Thieu tep giong ${source}. Chay 'npm run voice:normalize' truoc.\n`);
        process.exitCode = 1;
        return;
      }

      // Copy into the project so the render reads from the project's own audio
      // folder, exactly as it would after a real TTS run.
      const destRel = path.join(
        projectSubdir(project.id, "audio"),
        `scene${scene.sceneNumber}-line${line.lineNumber}-${line.speaker.toLowerCase()}.wav`,
      );
      const destAbs = toAbsolute(destRel);
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.copyFileSync(source, destAbs);

      // MEASURED from the file that will play. Never estimated.
      const durationSec = await probeDuration(destAbs);

      await prisma.dialogueLine.create({
        data: {
          sceneId: scene.id,
          characterId: byName.get(line.speaker)?.id ?? null,
          lineNumber: line.lineNumber,
          text: line.text,
          provider: "fixture",
          model: "local-wav",
          voiceId: byName.get(line.speaker)?.voiceId ?? "",
          instructions: "",
          speed: 1,
          // Scene 4 is the multi-speaker case; give its first line a deliberate
          // beat so the override path is exercised on real data too.
          pauseAfterMs: scene.sceneNumber === 4 && line.lineNumber === 1 ? 400 : null,
          estimatedCost: 0,
          actualCost: 0,
          durationSec,
          outputPath: toRelative(destAbs),
          status: "completed",
        },
      });
      lineTotal += 1;
    }

    const lines = await prisma.dialogueLine.findMany({
      where: { sceneId: scene.id },
      orderBy: { lineNumber: "asc" },
    });
    console.log(
      `  canh ${scene.sceneNumber}: ${lines.length} cau - ` +
        lines.map((l) => `${l.lineNumber}:${fmt(l.durationSec)}s`).join(", "),
    );
  }
  check("Co cau thoai de render", lineTotal > 0, `${lineTotal} cau`);

  // ---- 2. local music + SFX fixtures -------------------------------------
  const fixtureDir = toAbsolute(projectSubdir(project.id, "temp"));
  fs.mkdirSync(fixtureDir, { recursive: true });
  const musicPath = path.join(fixtureDir, "music-bed.wav");
  const sfxPath = path.join(fixtureDir, "sfx-blip.wav");

  if (fs.existsSync(musicPath)) fs.rmSync(musicPath);
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=196:duration=40",
    "-f", "lavfi", "-i", "sine=frequency=294:duration=40",
    "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0,volume=0.4,aresample=24000[out]",
    "-map", "[out]", "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", musicPath,
  ]);
  if (fs.existsSync(sfxPath)) fs.rmSync(sfxPath);
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=1200:duration=0.35",
    "-af", "afade=t=out:st=0.05:d=0.3,volume=0.8,aresample=24000",
    "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", sfxPath,
  ]);

  // ---- 3. render through the PRODUCTION renderer -------------------------
  console.log("\n--- 2. RENDER QUA RENDERER THAT ---\n");

  const scenes = await prisma.scene.findMany({
    where: { projectId: project.id, skipped: false },
    orderBy: { sceneNumber: "asc" },
    include: {
      dialogueLines: {
        orderBy: { lineNumber: "asc" },
        include: { character: { select: { name: true } } },
      },
    },
  });

  const target = targetForAspect(project.aspectRatio);
  const started = Date.now();
  const result = await renderProject({
    projectId: project.id,
    target,
    burnSubtitles: true,
    highlightPhrase: project.idiom.phrase,
    musicPath,
    sfx: [{ path: sfxPath, atSec: 2.0 }],
    mixSettings: DEFAULT_MIX,
    scenes: scenes.map((s) => ({
      sceneNumber: s.sceneNumber,
      duration: s.duration,
      subtitle: s.subtitle,
      videoPath: s.videoPath ? toAbsolute(s.videoPath) : null,
      audioPath: s.audioPath ? toAbsolute(s.audioPath) : null,
      imagePath: s.imagePath ? toAbsolute(s.imagePath) : null,
      dialogueLines: s.dialogueLines.map((l) => ({
        lineNumber: l.lineNumber,
        speaker: l.character?.name ?? "",
        text: l.text,
        audioPath: toAbsolute(l.outputPath),
        durationSec: l.durationSec,
        pauseAfterMs: l.pauseAfterMs,
      })),
    })),
  });

  console.log(`  Xong sau ${fmt((Date.now() - started) / 1000, 1)}s`);
  console.log(`  Tep     : ${result.videoPath}`);
  console.log(`  Dung luong: ${fmt(result.bytes / 1024 / 1024)} MB`);
  check(
    "Dung DUONG ONG MOI",
    result.audioPipeline === "dialogue-timeline",
    result.audioPipeline,
  );
  check("Co so do am thanh", result.audioMetrics !== undefined, "");
  check(
    "Co track am thanh tung canh",
    result.sceneAudioPaths.length === scenes.length,
    `${result.sceneAudioPaths.length}/${scenes.length}`,
  );
  check("Phu de da burn", result.subtitlesBurned, "");

  if (result.audioWarnings.length > 0) {
    console.log("\n  Canh bao tu bo do:");
    for (const w of result.audioWarnings) {
      console.log(`    [${w.severity}] ${w.message}`);
      console.log(`      -> ${w.suggestion}`);
    }
  }

  // ---- 4. ffprobe the deliverable ----------------------------------------
  console.log("\n--- 3. KIEM TRA TEP MP4 BANG FFPROBE ---\n");
  const probe = await ffprobe([
    "-v", "error",
    "-show_entries",
    "stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels:format=duration,bit_rate",
    "-of", "default=noprint_wrappers=1",
    result.videoPath,
  ]);
  const info: Record<string, string> = {};
  for (const lineText of probe.stdout.trim().split(/\r?\n/)) {
    const [k, v] = lineText.split("=");
    if (k && v && !(k in info)) info[k] = v;
  }
  const allKeys = probe.stdout.trim().split(/\r?\n/);
  const hasVideo = allKeys.some((l) => l === "codec_type=video");
  const hasAudio = allKeys.some((l) => l === "codec_type=audio");
  const codecs = allKeys.filter((l) => l.startsWith("codec_name=")).map((l) => l.split("=")[1]);

  const width = Number(info.width ?? 0);
  const height = Number(info.height ?? 0);
  const fpsParts = (info.r_frame_rate ?? "0/1").split("/").map(Number);
  const fps = (fpsParts[0] ?? 0) / (fpsParts[1] ?? 1);
  const duration = Number(info.duration ?? 0);

  check("Co luong video", hasVideo, codecs.join(", "));
  check("Co luong am thanh", hasAudio, hasAudio ? "co" : "KHONG CO");
  check("Do phan giai 1080x1920", width === 1080 && height === 1920, `${width}x${height}`);
  check("Khung hinh 30fps", Math.abs(fps - 30) < 0.5, `${fmt(fps, 2)} fps`);
  check("Video codec H.264", codecs.includes("h264"), codecs.join(", "));
  check("Audio codec AAC", codecs.includes("aac"), codecs.join(", "));
  check("Thoi luong hop ly", duration > 5, `${fmt(duration)}s`);

  // A file that decodes to the end without error is not corrupted.
  let decodeClean = true;
  try {
    await ffmpeg(["-v", "error", "-i", result.videoPath, "-f", "null", "-"]);
  } catch {
    decodeClean = false;
  }
  check("Giai ma sach het tep", decodeClean, decodeClean ? "khong loi" : "CO LOI");

  // ---- 5. the timeline the audio was actually built from ------------------
  console.log("\n--- 4. TIMELINE VA PHU DE ---\n");
  let offset = 0;
  let overlapFound = false;
  let orderOk = true;
  const cueRows: { start: number; end: number; speaker: string; text: string }[] = [];

  for (const s of scenes) {
    const timeline = buildSceneTimeline(
      s.dialogueLines.map((l) => ({
        lineNumber: l.lineNumber,
        speaker: l.character?.name ?? "",
        text: l.text,
        audioPath: toAbsolute(l.outputPath),
        durationSec: l.durationSec,
        pauseAfterOverride: pauseFromMs(l.pauseAfterMs),
      })),
      s.duration,
    );
    for (let i = 0; i < timeline.entries.length; i += 1) {
      const e = timeline.entries[i];
      if (!e) continue;
      const prev = timeline.entries[i - 1];
      if (prev && e.startSec < prev.endSec) overlapFound = true;
      if (prev && e.lineNumber <= prev.lineNumber) orderOk = false;
      cueRows.push({
        start: offset + e.startSec,
        end: offset + e.endSec,
        speaker: e.speaker,
        text: e.text,
      });
    }
    console.log(
      `  canh ${s.sceneNumber}: bat dau ${fmt(offset)}s, dai ${fmt(timeline.sceneDurationSec)}s` +
        (timeline.extended ? "  (KEO DAI vi loi noi dai hon)" : ""),
    );
    for (const e of timeline.entries) {
      console.log(
        `      ${e.speaker.padEnd(4)} ${fmt(offset + e.startSec).padStart(6)}s -> ` +
          `${fmt(offset + e.endSec).padStart(6)}s  nghi ${fmt(e.pauseAfterSec)}s  "${e.text.slice(0, 40)}"`,
      );
    }
    offset += timeline.sceneDurationSec;
  }

  check("Khong chong tieng", !overlapFound, overlapFound ? "CO CHONG" : "khong");
  check("Dung thu tu cau", orderOk, "");
  check(
    "Tong timeline khop video",
    Math.abs(offset - duration) < 1.5,
    `timeline ${fmt(offset)}s vs video ${fmt(duration)}s`,
  );

  // Subtitles against the same timeline.
  const srt = fs.readFileSync(result.subtitlePathSrt, "utf8");
  const stamps = [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/g)].map(
    (m) => ({
      start: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000,
      end: Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000,
    }),
  );
  check("So phu de khop so cau", stamps.length === cueRows.length, `${stamps.length} vs ${cueRows.length}`);

  let earlyOrLate = 0;
  let evenlySpaced = true;
  const gaps: number[] = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const cue = cueRows[i];
    const st = stamps[i];
    if (!cue || !st) continue;
    // The caption must not appear before the line starts, nor vanish before it
    // is finished being said.
    if (st.start + 0.02 < cue.start || st.end + 0.12 < cue.end) earlyOrLate += 1;
    if (i > 0) gaps.push(st.start - (stamps[i - 1]?.start ?? 0));
  }
  // Evenly divided captions would all be the same length - the bug this
  // replaced. Real speech is not.
  const lengths = stamps.map((s) => s.end - s.start);
  const spread = Math.max(...lengths) - Math.min(...lengths);
  evenlySpaced = spread < 0.2;

  check("Phu de khong som/mat som", earlyOrLate === 0, `${earlyOrLate} cau lech`);
  check(
    "Khong chia deu gia tao",
    !evenlySpaced,
    `dai nhat - ngan nhat = ${fmt(spread)}s`,
  );

  // ---- 6. scene 4: the real Sora clip, in the right place ----------------
  console.log("\n--- 5. CANH 4 (VIDEO SORA THAT) ---\n");
  const scene4 = scenes.find((s) => s.sceneNumber === 4);
  let scene4Start = 0;
  for (const s of scenes) {
    if (s.sceneNumber === 4) break;
    const t = buildSceneTimeline(
      s.dialogueLines.map((l) => ({
        lineNumber: l.lineNumber,
        speaker: l.character?.name ?? "",
        text: l.text,
        audioPath: toAbsolute(l.outputPath),
        durationSec: l.durationSec,
        pauseAfterOverride: pauseFromMs(l.pauseAfterMs),
      })),
      s.duration,
    );
    scene4Start += t.sceneDurationSec;
  }
  check("Canh 4 co video that", Boolean(scene4?.videoPath), scene4?.videoPath ?? "khong");
  console.log(`  Canh 4 bat dau tai : ${fmt(scene4Start)}s tren video cuoi`);
  if (scene4?.videoPath) {
    const src = toAbsolute(scene4.videoPath);
    const sp = await ffprobe([
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "default=noprint_wrappers=1:nokey=1", src,
    ]);
    console.log(`  Do phan giai goc    : ${sp.stdout.trim().replace(/\r?\n/, "x")}  -> phong len ${width}x${height} bang FFmpeg`);
  }

  // ---- 7. loudness of the finished video ---------------------------------
  console.log("\n--- 6. DO AM LUONG VIDEO CUOI ---\n");
  const loud = await measureLoudness(result.videoPath);
  console.log(`  Integrated : ${fmt(loud.integratedLufs)} LUFS  (dat ~-16)`);
  console.log(`  True peak  : ${fmt(loud.truePeakDb)} dBTP`);
  console.log(`  LRA        : ${fmt(loud.lra)} LU`);
  check("Khong clipping", loud.truePeakDb <= 0, `${fmt(loud.truePeakDb)} dBTP`);
  check(
    "Do to gan muc tieu",
    Math.abs(loud.integratedLufs + 16) <= 3,
    `${fmt(loud.integratedLufs)} LUFS`,
  );

  // No scene silent because of a bad path: measure each scene's own window.
  console.log("\n  Muc am thanh tung canh (phat hien canh bi cam):");
  let silentScene = false;
  let cursor = 0;
  for (const s of scenes) {
    const t = buildSceneTimeline(
      s.dialogueLines.map((l) => ({
        lineNumber: l.lineNumber,
        speaker: l.character?.name ?? "",
        text: l.text,
        audioPath: toAbsolute(l.outputPath),
        durationSec: l.durationSec,
        pauseAfterOverride: pauseFromMs(l.pauseAfterMs),
      })),
      s.duration,
    );
    const from = cursor + 0.2;
    const to = Math.min(cursor + t.sceneDurationSec - 0.2, duration - 0.1);
    if (to > from) {
      const level = await windowRms(result.videoPath, from, to, ffmpeg);
      const quiet = level < 0.005;
      if (quiet) silentScene = true;
      console.log(
        `    canh ${s.sceneNumber}: RMS ${level.toExponential(2)}${quiet ? "  <-- GAN NHU IM LANG" : ""}`,
      );
    }
    cursor += t.sceneDurationSec;
  }
  check("Khong canh nao bi im lang", !silentScene, "");

  // ---- 7. ducking, on this project's own mix -----------------------------
  //
  // Compared against the dialogue track the renderer wrote beside it. Measuring
  // a gap in the finished video would not work here: this project speaks almost
  // continuously, so there is no long silence for the bed to return in.
  console.log("\n--- 7. KIEM CHUNG DUCKING TREN BAN MIX CUA PROJECT ---\n");
  const audioDir = toAbsolute(projectSubdir(project.id, "audio"));
  const dialogueTrack = path.join(audioDir, "project-dialogue.wav");
  const mixTrack = path.join(audioDir, "project-final-mix.wav");
  check("Co track thoai rieng", fs.existsSync(dialogueTrack), "project-dialogue.wav");
  check("Co ban mix rieng", fs.existsSync(mixTrack), "project-final-mix.wav");

  if (fs.existsSync(dialogueTrack) && fs.existsSync(mixTrack)) {
    const dl = await measureLoudness(dialogueTrack);
    const mx = await measureLoudness(mixTrack);
    const lift = mx.integratedLufs - dl.integratedLufs;
    console.log(`  Chi thoai   : ${fmt(dl.integratedLufs)} LUFS`);
    console.log(`  Sau khi mix : ${fmt(mx.integratedLufs)} LUFS`);
    console.log(`  Chenh lech  : ${lift >= 0 ? "+" : ""}${fmt(lift, 2)} LU`);
    // Music and effects add energy, so a small rise is healthy. A large one
    // means the bed is no longer underneath the voice.
    check(
      "Nhac KHONG lan loi",
      lift <= 2,
      `${lift >= 0 ? "+" : ""}${fmt(lift, 2)} LU (nguong +2 LU)`,
    );
  }

  console.log("\n---------- KET LUAN ----------");
  console.log(
    failures === 0
      ? `  NGHIEM THU DAT. Tep: ${result.videoPath}\n`
      : `  ${failures} muc KHONG DAT.\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

/** Mean square level of a window of a file's audio. */
async function windowRms(
  file: string,
  from: number,
  to: number,
  ffmpeg: (args: string[]) => Promise<unknown>,
): Promise<number> {
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "win-"));
  const raw = path.join(dir, "w.f32");
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", String(from), "-to", String(to),
    "-i", file, "-vn", "-ac", "1", "-f", "f32le", raw,
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

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
