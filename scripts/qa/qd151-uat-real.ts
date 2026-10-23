import fs from "node:fs";
import path from "node:path";

/**
 * QĐ-151 ACCEPTANCE in the REAL app (data/app.db): a clearly named batch
 * "QĐ-151 NGHIỆM THU" with three videos of the SAME 7 scenes, built only from
 * files already on this machine ($0 - no TTS, no Image AI, no Video AI):
 *
 *   A  9:16  Motion Quality LEGACY
 *   B  9:16  Motion Quality SMOOTH_V2
 *   C  16:9  Motion Quality SMOOTH_V2 (YouTube landscape)
 *
 * Scenes 1-6: the AIVietLab Thục Đoan lines + their six pictures; scene 7: the
 * LOCK&LOCK product shot on a transparent background (a PNG with alpha, made
 * here from the existing JPEG by keying out the white). Cameras: the app's own
 * Camera Director, then one move per scene chosen through setSceneCamera so
 * pan / zoom / tilt / dolly / track / handheld / gimbal are all present, with
 * cuts and crossfades. Music + Audio Mixer (Review AI), subtitles on. Rendering
 * is left to the app (batch page: TIẾP TỤC / RENDER LẠI).
 *
 *   UAT_REAL=1 npx tsx scripts/qa/qd151-uat-real.ts   (back up data/app.db first)
 */

const SRC = "aivietlab-test-2026-10-22";
const PRODUCT_JPG = "projects/236b0f85-d007-4e3e-a030-194126037c91/images/import-90dac9de-775d-4e7a-a0b7-177fa23405e2.jpg";
const P1 = "6b8a7dd7-e204-4b9f-9b19-7122411c6df7";
const P2 = "4c25708b-c4a9-4fb4-90ce-5661cbc17eeb";
const MOVES = [
  { move: "PAN_RIGHT", transitionIn: "CUT" },
  { move: "SLOW_ZOOM_IN", transitionIn: "CROSSFADE" },
  { move: "TILT_UP", transitionIn: "CUT" },
  { move: "DOLLY_IN", transitionIn: "CROSSFADE" },
  { move: "TRACK_LEFT", transitionIn: "CUT" },
  { move: "HANDHELD_SOFT", transitionIn: "CROSSFADE" },
  { move: "GIMBAL", transitionIn: "CROSSFADE" },
] as const;

async function main(): Promise<void> {
  if (process.env.UAT_REAL !== "1") throw new Error("Đặt UAT_REAL=1 để tạo lô nghiệm thu trong app thật.");
  const { prisma } = await import("../../src/lib/prisma");
  const { projectSubdir, toAbsolute, toRelative, ensureProjectDirs } = await import("../../src/lib/paths");
  const { ffmpeg, probeDuration } = await import("../../src/media/ffmpeg");
  const { setBackgroundMusic, saveProjectControls } = await import("../../src/services/output-controls");
  const { applyAudioPresetToProject } = await import("../../src/services/audio-mixer-service");
  const { planProjectScenes, setSceneCamera } = await import("../../src/services/scene-plan-service");
  const { profileFromPlatform } = await import("../../src/domain/platform-profile");

  const scriptSrc = fs.readFileSync(path.resolve("scripts", "qa", "aivietlab-real-test.ts"), "utf8");
  const six = [...scriptSrc.matchAll(/text: "([^"]+)",\s*image: IMG\((P1|P2), "([^"]+)"\)/g)].map((m) => ({
    text: m[1]!,
    image: path.join("projects", m[2] === "P1" ? P1 : P2, "images", m[3]!),
  }));
  if (six.length !== 6) throw new Error(`Đọc được ${six.length} cảnh, cần 6.`);
  const scenes = [
    ...six.map((s, i) => ({ text: s.text, image: s.image, line: path.join(projectSubdir(SRC, "audio"), `line-${i + 1}.wav`), alpha: false })),
    { text: "Và đây là chiếc bình LOCK&LOCK, giữ nhiệt suốt cả ngày.", image: PRODUCT_JPG, line: path.join(projectSubdir(SRC, "audio"), "line-6.wav"), alpha: true },
  ];
  for (const s of scenes) {
    if (!fs.existsSync(toAbsolute(s.image))) throw new Error(`Thiếu ảnh: ${s.image}`);
    if (!fs.existsSync(toAbsolute(s.line))) throw new Error(`Thiếu giọng: ${s.line}`);
  }
  const music = toAbsolute(path.join("music", "aivietlab-tech-bg.mp3"));

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const idiom = await prisma.idiom.create({
    data: { phrase: `QĐ-151 nghiệm thu ${stamp}`, slug: `qd151-uat-${stamp}`, meaning: "Lô nghiệm thu Motion Quality (QĐ-151) - dữ liệu thử, $0.", literalMeaning: "QĐ-151", exampleSentence: "AIVietLab review Clark.", category: "qa-qd151", status: "imported" },
  });
  const batch = await prisma.batch.create({ data: { name: `QĐ-151 NGHIỆM THU ${stamp}`, amount: 3, status: "COMPLETED" } });

  const variants = [
    { key: "A", quality: "LEGACY", landscape: false },
    { key: "B", quality: "SMOOTH_V2", landscape: false },
    { key: "C", quality: "SMOOTH_V2", landscape: true },
  ] as const;
  const made: { id: string; title: string }[] = [];
  for (const v of variants) {
    const title = `QĐ-151 NGHIỆM THU · Video ${v.key} · ${v.quality === "LEGACY" ? "Legacy" : "Smooth V2"} · ${v.landscape ? "16:9" : "9:16"}`;
    const profile = v.landscape ? profileFromPlatform("YOUTUBE_LANDSCAPE") : null;
    const project = await prisma.project.create({
      data: {
        idiomId: idiom.id,
        batchId: batch.id,
        title,
        status: "media_ready",
        language: "vi",
        aspectRatio: "9:16",
        maxBudget: 0,
        contentType: "PRODUCT_REVIEW",
        ...(profile ? { outputProfileJson: JSON.stringify(profile) } : {}),
      },
    });
    ensureProjectDirs(project.id);
    for (const [i, s] of scenes.entries()) {
      let image = path.join(toAbsolute(projectSubdir(project.id, "images")), `scene-${i + 1}.png`);
      if (s.alpha) {
        // White background -> transparent: a real PNG with alpha, as a cut-out would be.
        await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-i", toAbsolute(s.image), "-vf", "format=rgba,colorkey=0xFFFFFF:0.08:0.05", "-frames:v", "1", image]);
      } else {
        image = path.join(toAbsolute(projectSubdir(project.id, "images")), `scene-${i + 1}${path.extname(s.image)}`);
        fs.copyFileSync(toAbsolute(s.image), image);
      }
      const line = path.join(toAbsolute(projectSubdir(project.id, "audio")), `line-${i + 1}.wav`);
      fs.copyFileSync(toAbsolute(s.line), line);
      const durationSec = await probeDuration(line);
      await prisma.scene.create({
        data: {
          projectId: project.id,
          sceneNumber: i + 1,
          duration: Math.ceil(durationSec + 0.6),
          dialogue: `Narrator: ${s.text}`,
          subtitle: s.text,
          motionSource: "LOCAL_MOTION",
          imagePath: toRelative(image),
          status: "completed",
          dialogueLines: { create: { lineNumber: 1, text: s.text, provider: "mindvoice", model: "mind-v1", voiceId: "Thục Đoan", durationSec, outputPath: toRelative(line), status: "completed" } },
        },
      });
    }
    // The app's own Camera Director, then one chosen move per scene (USER plans).
    await planProjectScenes(project.id);
    const rows = await prisma.scene.findMany({ where: { projectId: project.id }, orderBy: { sceneNumber: "asc" } });
    for (const [i, row] of rows.entries()) {
      const m = MOVES[i % MOVES.length]!;
      await setSceneCamera(row.id, { cameraMovement: m.move, cameraSpeed: "SLOW", cameraEasing: "EASE_IN_OUT", transitionIn: i === 0 ? "CUT" : m.transitionIn });
    }
    await setBackgroundMusic(project.id, fs.readFileSync(music), "aivietlab-tech-bg.mp3");
    await applyAudioPresetToProject(project.id, "REVIEW_AI");
    await saveProjectControls(project.id, { motion: { quality: v.quality } });
    made.push({ id: project.id, title });
  }
  console.log(JSON.stringify({ batch: batch.id, projects: made }, null, 2));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
