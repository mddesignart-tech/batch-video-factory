import fs from "node:fs";
import path from "node:path";

/**
 * QĐ-150 ACCEPTANCE in the REAL app (data/app.db): one clearly named batch,
 * "QĐ-150 NGHIỆM THU", with two videos built ONLY from files already on this
 * machine - the AIVietLab Thục Đoan lines (already made, levelled), the six
 * reused pictures and the Digital Clouds track. No TTS, no Image AI, no Video
 * AI, no text model: $0. Rendering is left to the app itself (RENDER LẠI).
 *
 *   A: Audio Mixer on (Review AI)       B: no mixer (the old mix)
 *
 *   UAT_REAL=1 npx tsx scripts/qa/qd150-uat-real.ts
 */

const SRC = "aivietlab-test-2026-10-22";
const P1 = "6b8a7dd7-e204-4b9f-9b19-7122411c6df7";
const P2 = "4c25708b-c4a9-4fb4-90ce-5661cbc17eeb";

async function main(): Promise<void> {
  if (process.env.UAT_REAL !== "1") throw new Error("Đặt UAT_REAL=1 để tạo lô nghiệm thu trong app thật.");
  const { prisma } = await import("../../src/lib/prisma");
  const { projectSubdir, toAbsolute, toRelative, ensureProjectDirs } = await import("../../src/lib/paths");
  const { probeDuration } = await import("../../src/media/ffmpeg");
  const { setBackgroundMusic } = await import("../../src/services/output-controls");
  const { applyAudioPresetToProject } = await import("../../src/services/audio-mixer-service");

  // The six scenes of the AIVietLab test, read from its script (text + picture).
  const scriptSrc = fs.readFileSync(path.resolve("scripts", "qa", "aivietlab-real-test.ts"), "utf8");
  const scenes = [...scriptSrc.matchAll(/text: "([^"]+)",\s*image: IMG\((P1|P2), "([^"]+)"\)/g)].map((m) => ({
    text: m[1]!,
    image: path.join("projects", m[2] === "P1" ? P1 : P2, "images", m[3]!),
  }));
  if (scenes.length !== 6) throw new Error(`Đọc được ${scenes.length} cảnh, cần 6.`);
  for (const [i, s] of scenes.entries()) {
    if (!fs.existsSync(toAbsolute(s.image))) throw new Error(`Thiếu ảnh: ${s.image}`);
    if (!fs.existsSync(toAbsolute(path.join(projectSubdir(SRC, "audio"), `line-${i + 1}.wav`)))) throw new Error(`Thiếu giọng câu ${i + 1}`);
  }
  const music = toAbsolute(path.join("music", "aivietlab-tech-bg.mp3"));

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const idiom = await prisma.idiom.create({
    data: {
      phrase: `QĐ-150 nghiệm thu ${stamp}`,
      slug: `qd150-uat-${stamp}`,
      meaning: "Lô nghiệm thu Audio Mixer (QĐ-150) - dữ liệu thử, $0.",
      literalMeaning: "QĐ-150",
      exampleSentence: "AIVietLab review Clark.",
      category: "qa-qd150",
      status: "imported",
    },
  });
  const batch = await prisma.batch.create({ data: { name: `QĐ-150 NGHIỆM THU ${stamp}`, amount: 2, status: "COMPLETED" } });

  const made: { id: string; title: string }[] = [];
  for (const [key, mixer] of [["A", true], ["B", false]] as const) {
    const title = `QĐ-150 NGHIỆM THU · Video ${key} · ${mixer ? "Audio Mixer (Review AI)" : "bộ trộn cũ"}`;
    const project = await prisma.project.create({
      data: { idiomId: idiom.id, batchId: batch.id, title, status: "media_ready", language: "vi", aspectRatio: "9:16", maxBudget: 0 },
    });
    ensureProjectDirs(project.id);
    for (const [i, s] of scenes.entries()) {
      const image = path.join(toAbsolute(projectSubdir(project.id, "images")), `scene-${i + 1}${path.extname(s.image)}`);
      fs.copyFileSync(toAbsolute(s.image), image);
      const line = path.join(toAbsolute(projectSubdir(project.id, "audio")), `line-${i + 1}.wav`);
      fs.copyFileSync(toAbsolute(path.join(projectSubdir(SRC, "audio"), `line-${i + 1}.wav`)), line);
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
          dialogueLines: {
            create: {
              lineNumber: 1,
              text: s.text,
              provider: "mindvoice",
              model: "mind-v1",
              voiceId: "Thục Đoan",
              durationSec,
              outputPath: toRelative(line),
              status: "completed",
            },
          },
        },
      });
    }
    await setBackgroundMusic(project.id, fs.readFileSync(music), "aivietlab-tech-bg.mp3");
    if (mixer) await applyAudioPresetToProject(project.id, "REVIEW_AI");
    made.push({ id: project.id, title });
  }
  console.log(JSON.stringify({ batch: batch.id, projects: made }, null, 2));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
