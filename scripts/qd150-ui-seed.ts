import fs from "node:fs";
import path from "node:path";

/**
 * QĐ-150 UI check seed - ONLY for an isolated DB + DATA_DIR (never the real
 * data/app.db). Makes one batch with two synthetic videos ($0, local FFmpeg):
 *   A: rendered with the Audio Mixer (Review AI) + music, sources kept;
 *   B: an "old" video with no mixer and no kept sources.
 *
 *   DATA_DIR=<dir> DATABASE_URL=file:<db> npx tsx scripts/qd150-ui-seed.ts
 */

async function main(): Promise<void> {
  if (!process.env.DATA_DIR || !process.env.DATABASE_URL || /data[\\/]app\.db/.test(process.env.DATABASE_URL)) {
    throw new Error("Chỉ chạy với DATA_DIR và DATABASE_URL riêng cho kiểm thử.");
  }
  const { prisma } = await import("../src/lib/prisma");
  const { projectSubdir, toAbsolute, toRelative, ensureProjectDirs } = await import("../src/lib/paths");
  const { ffmpeg } = await import("../src/media/ffmpeg");
  const { renderProject, DEFAULT_TARGET } = await import("../src/media/render");
  const { applyOutputControls, setBackgroundMusic } = await import("../src/services/output-controls");
  const { applyAudioPresetToProject } = await import("../src/services/audio-mixer-service");

  const run = (args: string[]) => ffmpeg(["-y", "-hide_banner", "-loglevel", "error", ...args]);
  const idiom = await prisma.idiom.create({
    data: { phrase: "QĐ-150 UI", slug: `qd150-ui-${Date.now()}`, meaning: "m", literalMeaning: "l", exampleSentence: "e", category: "qa" },
  });
  const batch = await prisma.batch.create({ data: { name: "QĐ-150 UI lô thử" } });
  const a = await prisma.project.create({ data: { idiomId: idiom.id, batchId: batch.id, title: "QĐ-150 UI · Video A (Audio Mixer)" } });
  const b = await prisma.project.create({ data: { idiomId: idiom.id, batchId: batch.id, title: "QĐ-150 UI · Video B (cũ)" } });

  const music = path.join(toAbsolute(projectSubdir(a.id, "temp")), "music-src.wav");
  ensureProjectDirs(a.id);
  ensureProjectDirs(b.id);
  await run(["-f", "lavfi", "-i", "sine=frequency=330:duration=40:sample_rate=44100", "-f", "lavfi", "-i", "sine=frequency=495:duration=40:sample_rate=44100", "-filter_complex", "[0][1]amerge=inputs=2,volume=0.8", "-c:a", "pcm_s16le", music]);
  await setBackgroundMusic(a.id, fs.readFileSync(music), "nhac-thu.wav");

  const scenes = [];
  for (let i = 1; i <= 4; i += 1) {
    const video = toAbsolute(path.join(projectSubdir(a.id, "videos"), `s${i}.mp4`));
    const line = toAbsolute(path.join(projectSubdir(a.id, "audio"), `line-${i}.wav`));
    await run(["-f", "lavfi", "-i", `color=c=${["navy", "teal", "maroon", "olive"][i - 1]}:s=720x1280:d=4:r=30`, "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
    await run(["-f", "lavfi", "-i", `sine=frequency=${200 + i * 30}:duration=2.4`, "-af", "volume=0.35,aresample=24000", "-ac", "1", "-c:a", "pcm_s16le", line]);
    scenes.push({
      sceneNumber: i,
      duration: 4,
      subtitle: `Câu thử ${i}`,
      videoPath: video,
      imagePath: null,
      audioPath: null,
      dialogueLines: [{ lineNumber: 1, speaker: "Narrator", text: `Câu thử ${i}`, audioPath: line, durationSec: 2.4, pauseAfterMs: 600 }],
    });
  }
  await applyAudioPresetToProject(a.id, "REVIEW_AI");
  const projectA = await prisma.project.findUniqueOrThrow({ where: { id: a.id } });
  const req = { projectId: a.id, scenes, target: DEFAULT_TARGET, burnSubtitles: true } as Parameters<typeof renderProject>[0];
  await applyOutputControls(projectA, [], req);
  const r = await renderProject(req);
  await prisma.project.update({ where: { id: a.id }, data: { finalVideoPath: toRelative(r.videoPath), status: "completed" } });

  const old = toAbsolute(path.join(projectSubdir(b.id, "final"), "final_old0001.mp4"));
  await run(["-f", "lavfi", "-i", "color=c=gray:s=720x1280:d=6:r=30", "-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", old]);
  await prisma.project.update({ where: { id: b.id }, data: { finalVideoPath: toRelative(old), status: "completed" } });

  console.log(JSON.stringify({ batch: batch.id, a: a.id, b: b.id, engine: r.audioEngine, manifest: r.audioManifestPath }, null, 2));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
