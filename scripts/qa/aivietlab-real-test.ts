import fs from "node:fs";
import path from "node:path";

/**
 * AIVIETLAB PRODUCTION TEST (2026-10-22) - one 45-60 s review video, made only
 * from what is already on this machine:
 *   - voice: Mind Voice local, Thục Đoan, the locked preset (VieNeu v3 Turbo
 *     fp32, speed 1, director off, no tag, no keep_punct) through the real
 *     MindVoiceProvider, then the pipeline's own per-line levelling;
 *   - pictures: six images already bought for earlier AI projects (reuse, $0);
 *   - render: the production renderer (stills + local camera, crossfades,
 *     burned Vietnamese subtitles, music ducked under the voice);
 *   - music: Digital Clouds (Mixkit) from data/music, cut to the video, faded
 *     in 1 s / out 1.5 s, ducked under the voice by the renderer.
 * No Image AI, no Video AI, no OpenAI, no database row. $0.
 *
 *   npx tsx scripts/qa/aivietlab-real-test.ts
 */

const ID = "aivietlab-test-2026-10-22";
const BASE_URL = "http://127.0.0.1:8011";
const MUSIC_GAIN = Number(process.env.MUSIC_GAIN ?? "1");
const DUCK_DB = Number(process.env.DUCK_DB ?? "6");

const IMG = (project: string, file: string) => path.join("projects", project, "images", file);
const P1 = "6b8a7dd7-e204-4b9f-9b19-7122411c6df7";
const P2 = "4c25708b-c4a9-4fb4-90ce-5661cbc17eeb";

// Script from AIVietLab Pilot 01/05 (Clark). Claims kept to that write-up.
const SCENES: { text: string; image: string; move: string; transition: string }[] = [
  {
    text: "Bạn đã bao giờ ước có một trợ lý AI tự làm hết việc, còn mình thì chỉ cần đóng tab và đi pha cà phê chưa?",
    image: IMG(P1, "5d8685bb-9474-4f31-89cb-063562ead828.png"),
    move: "SLOW_ZOOM_IN",
    transition: "CUT",
  },
  {
    text: "Hôm nay AIVietLab review Clark, một AI coworker được cấp hẳn một máy tính đám mây riêng, có trình duyệt, terminal và môi trường code.",
    image: IMG(P2, "9217589a-d4e8-438a-802e-f050480ae50e.png"),
    move: "PAN_RIGHT",
    transition: "CROSSFADE",
  },
  {
    text: "Bạn có thể giao cho Clark những việc dài như nghiên cứu có nguồn, làm bảng tính, làm slide, hay sửa một lỗi trong code rồi tự chạy test.",
    image: IMG(P1, "818df7f8-1cd0-4baf-a6ea-b4cc9463c44e.png"),
    move: "SLOW_ZOOM_OUT",
    transition: "CROSSFADE",
  },
  {
    text: "Điểm mình thích nhất là Clark trả lại cả sản phẩm lẫn bằng chứng, nên bạn dễ dàng kiểm tra lại kết quả.",
    image: IMG(P1, "011810f5-3289-4041-ac10-35fd5f3565ab.png"),
    move: "PUSH_IN",
    transition: "CROSSFADE",
  },
  {
    text: "Tuy vậy, chi phí tính theo credits nên khá khó ước lượng, và bạn nên thật cẩn thận trước khi cho nó quyền vào dữ liệu hay tài khoản thật.",
    image: IMG(P1, "import-a50500e7-651d-482e-a5c4-1a2dc2fd2c9b.png"),
    move: "PAN_LEFT",
    transition: "CROSSFADE",
  },
  {
    text: "AIVietLab tạm chấm Clark tám phẩy ba trên mười. Còn bạn, bạn sẽ giao việc gì đầu tiên cho một AI có máy tính riêng?",
    image: IMG(P1, "import-bfe97a6a-6209-48e6-987c-2a7252cf616a.png"),
    move: "SLOW_ZOOM_IN",
    transition: "CROSSFADE",
  },
];

async function main(): Promise<void> {
  const { toAbsolute, projectSubdir } = await import("../../src/lib/paths");
  const { MindVoiceProvider } = await import("../../src/providers/mindvoice/mind-voice-provider");
  const { THUC_DOAN_PRESET } = await import("../../src/domain/voice-quality");
  const { mindDirectionSummary } = await import("../../src/domain/mind-voice");
  const { normalizeVoiceClip } = await import("../../src/media/audio-normalize");
  const { ffmpeg } = await import("../../src/media/ffmpeg");
  const { renderProject, DEFAULT_TARGET } = await import("../../src/media/render");
  const { controlsOf, subtitleLayout } = await import("../../src/domain/output-controls");

  for (const s of SCENES) if (!fs.existsSync(toAbsolute(s.image))) throw new Error(`Thiếu ảnh: ${s.image}`);

  // ---- 1. voice: the locked Thục Đoan preset, one line per scene ----------
  const audioDir = toAbsolute(projectSubdir(ID, "audio"));
  fs.mkdirSync(audioDir, { recursive: true });
  const provider = new MindVoiceProvider({ baseUrl: BASE_URL });
  const missing = SCENES.some((_, i) => !fs.existsSync(path.join(audioDir, `line-${i + 1}.raw.wav`)));
  if (missing && (await provider.checkStatus()) !== "connected") throw new Error("Mind Voice local chưa chạy (127.0.0.1:8011).");
  const instructions = mindDirectionSummary({ engine: "vieneu", variant: THUC_DOAN_PRESET.variant, language: "vi", style: null, role: null, emotion: null });

  const lines: { raw: string; levelled: string; durationSec: number; sent: unknown }[] = [];
  for (const [i, s] of SCENES.entries()) {
    const raw = path.join(audioDir, `line-${i + 1}.raw.wav`);
    const levelled = path.join(audioDir, `line-${i + 1}.wav`);
    let sent: unknown = "(dùng lại tệp đã tạo)";
    if (!fs.existsSync(raw)) {
      const job = await provider.createVoice({
        projectId: ID,
        sceneId: `s${i + 1}`,
        model: "mind-v1",
        text: s.text,
        voiceId: THUC_DOAN_PRESET.voiceId,
        instructions,
        accent: "US",
        gender: "female",
        speed: THUC_DOAN_PRESET.speed,
        targetDuration: 0,
        outputPath: raw,
        language: THUC_DOAN_PRESET.language,
      });
      sent = job.sentRequest;
      await provider.downloadResult(job.externalId);
    }
    if (fs.existsSync(levelled)) fs.rmSync(levelled);
    const n = await normalizeVoiceClip(raw, levelled);
    lines.push({ raw, levelled, durationSec: n.durationSec, sent });
    console.log(`  câu ${i + 1}: ${n.durationSec.toFixed(2)}s  gửi=${JSON.stringify(sent)}`);
  }

  // ---- 2. music: Digital Clouds (Mixkit), cut to the video, faded ---------
  // The renderer loops the bed and ducks it under the voice; the fades and the
  // cut are made here so the track ends with the video instead of mid-phrase.
  // Every scene is its line + 0.5 s (VOICE_PADDED), so the length is known.
  const voiceTotal = lines.reduce((t, l) => t + l.durationSec, 0);
  const videoLen = Math.round((voiceTotal + SCENES.length * 0.5) * 1000) / 1000;
  const source = toAbsolute(path.join("music", "aivietlab-tech-bg.mp3"));
  if (!fs.existsSync(source)) throw new Error(`Thiếu nhạc nền: ${source}`);
  const musicPath = path.join(toAbsolute(projectSubdir(ID, "temp")), "music-digital-clouds.wav");
  fs.mkdirSync(path.dirname(musicPath), { recursive: true });
  if (fs.existsSync(musicPath)) fs.rmSync(musicPath);
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", source,
    "-af",
    // Level first (one reference for any track), then fade in 1 s / out 1.5 s,
    // then 1 s of silence so the renderer's loop never restarts the track.
    `atrim=0:${videoLen},acompressor=threshold=0.03:ratio=8:attack=30:release=400:makeup=1,loudnorm=I=-11:TP=-1.5:LRA=3,afade=t=in:d=1,afade=t=out:st=${(videoLen - 1.5).toFixed(3)}:d=1.5,apad=pad_dur=1`,
    "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", musicPath,
  ]);

  // ---- 3. render through the PRODUCTION renderer -------------------------
  const controls = controlsOf({ contentType: null });
  const target = DEFAULT_TARGET;
  const result = await renderProject({
    projectId: ID,
    target,
    burnSubtitles: controls.subtitles.enabled,
    subtitleLayout: subtitleLayout(controls.subtitles, target.width, target.height, null),
    // The app default (0.15, 12 dB duck) left the bed ~26 dB under the voice -
    // the listener heard no music. Levelled bed, full gain, 6 dB duck: ~13 dB
    // under the voice on average while speaking.
    mixSettings: { musicGain: MUSIC_GAIN, duckDb: controls.audio.duckMusic ? DUCK_DB : 0 },
    musicPath,
    scenes: SCENES.map((s, i) => ({
      sceneNumber: i + 1,
      duration: Math.ceil(lines[i]!.durationSec + 1),
      subtitle: s.text,
      videoPath: null,
      audioPath: null,
      imagePath: toAbsolute(s.image),
      dialogueLines: [
        { lineNumber: 1, speaker: "Narrator", text: s.text, audioPath: lines[i]!.levelled, durationSec: lines[i]!.durationSec },
      ],
      spokenLines: [s.text],
      localCamera: { move: s.move as never, speed: "SLOW", easing: "EASE_IN_OUT" },
      transitionIn: s.transition as never,
      subjects: [],
    })),
  });

  console.log("\n--- KẾT QUẢ ---");
  console.log(JSON.stringify({ ...result, sceneAudioPaths: undefined }, null, 2));
  console.log(`Nhạc nền: ${musicPath} (cắt ${videoLen}s; video ${result.durationSeconds}s)`);
  if (Math.abs(result.durationSeconds - videoLen) > 0.1) console.log("CẢNH BÁO: độ dài video khác độ dài nhạc đã cắt.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
