import fs from "node:fs";
import path from "node:path";

/**
 * QĐ-152 UI check seed - ONLY for an isolated DB + DATA_DIR (refuses data/app.db).
 * Two projects built from files already on this machine (copied in, $0):
 *   "QĐ-152 UI · Review AI" - 6 AIVietLab scenes + 1 off-topic product scene,
 *       rendered once (real renderer, local), so outputs / storage / trash can be tried;
 *   "QĐ-152 UI · Dự án phụ" - 2 scenes, for multi-select delete.
 *
 *   SRC_DATA=<real data dir> DATA_DIR=<isolated dir> DATABASE_URL=file:<db> npx tsx scripts/qa/qd152-ui-seed.ts
 */

const P1 = "6b8a7dd7-e204-4b9f-9b19-7122411c6df7";
const P2 = "4c25708b-c4a9-4fb4-90ce-5661cbc17eeb";

async function main(): Promise<void> {
  if (!process.env.DATA_DIR || !process.env.DATABASE_URL || /data[\\/]app\.db/.test(process.env.DATABASE_URL) || !process.env.SRC_DATA) {
    throw new Error("Chỉ chạy với SRC_DATA, DATA_DIR và DATABASE_URL riêng cho kiểm thử.");
  }
  const SRC = process.env.SRC_DATA;
  const { prisma } = await import("../../src/lib/prisma");
  const { projectSubdir, toRelative, ensureProjectDirs, toAbsolute } = await import("../../src/lib/paths");
  const { probeDuration } = await import("../../src/media/ffmpeg");
  const { renderProject, DEFAULT_TARGET } = await import("../../src/media/render");

  const scriptSrc = fs.readFileSync(path.resolve("scripts", "qa", "aivietlab-real-test.ts"), "utf8");
  const six = [...scriptSrc.matchAll(/text: "([^"]+)",\s*image: IMG\((P1|P2), "([^"]+)"\)/g)].map((m, i) => ({
    text: m[1]!,
    image: path.join(SRC, "projects", m[2] === "P1" ? P1 : P2, "images", m[3]!),
    line: path.join(SRC, "projects", "aivietlab-test-2026-10-22", "audio", `line-${i + 1}.wav`),
  }));
  const scenes = [
    ...six,
    { text: "Và đây là chiếc bình giữ nhiệt inox vàng đồng, giữ nóng suốt cả ngày.", image: path.join(SRC, "projects", "236b0f85-d007-4e3e-a030-194126037c91", "images", "import-90dac9de-775d-4e7a-a0b7-177fa23405e2.jpg"), line: six[5]!.line },
  ];
  const idiom = await prisma.idiom.create({ data: { phrase: "QĐ-152 UI", slug: `qd152-ui-${Date.now()}`, meaning: "m", literalMeaning: "l", exampleSentence: "e", category: "qa" } });

  const make = async (title: string, list: typeof scenes) => {
    const p = await prisma.project.create({ data: { idiomId: idiom.id, title, status: "media_ready", language: "vi", targetDuration: 45 } });
    ensureProjectDirs(p.id);
    const rows = [];
    for (const [i, s] of list.entries()) {
      const img = path.join(projectSubdir(p.id, "images"), `scene-${i + 1}${path.extname(s.image)}`);
      fs.copyFileSync(s.image, img);
      const line = path.join(projectSubdir(p.id, "audio"), `line-${i + 1}.wav`);
      fs.copyFileSync(s.line, line);
      const durationSec = await probeDuration(line);
      rows.push(
        await prisma.scene.create({
          data: {
            projectId: p.id, sceneNumber: i + 1, duration: Math.ceil(durationSec + 0.6), subtitle: s.text, dialogue: `Narrator: ${s.text}`,
            motionSource: "LOCAL_MOTION", imagePath: toRelative(img), status: "completed",
            dialogueLines: { create: { lineNumber: 1, text: s.text, voiceId: "Thục Đoan", durationSec, outputPath: toRelative(line), status: "completed" } },
          },
          include: { dialogueLines: true },
        }),
      );
    }
    return { p, rows };
  };

  const main = await make("QĐ-152 UI · Review AI AIVietLab", scenes);
  const r = await renderProject({
    projectId: main.p.id,
    target: { ...DEFAULT_TARGET, width: 540, height: 960 },
    burnSubtitles: true,
    scenes: main.rows.map((s) => ({
      sceneNumber: s.sceneNumber, duration: s.duration, subtitle: s.subtitle, videoPath: null, imagePath: toAbsolute(s.imagePath!), audioPath: null,
      dialogueLines: s.dialogueLines.map((l) => ({ lineNumber: l.lineNumber, speaker: "Narrator", text: l.text, audioPath: toAbsolute(l.outputPath), durationSec: l.durationSec })),
    })),
  });
  await prisma.asset.create({ data: { projectId: main.p.id, kind: "final", provider: "ffmpeg", model: "libx264", status: "completed", filePath: toRelative(r.videoPath), bytes: fs.statSync(r.videoPath).size } });
  await prisma.project.update({ where: { id: main.p.id }, data: { finalVideoPath: toRelative(r.videoPath), subtitlePath: toRelative(r.subtitlePathSrt), status: "completed" } });
  // Some leftovers for DỌN FILE TẠM.
  fs.writeFileSync(path.join(projectSubdir(main.p.id, "temp"), "leftover.part"), "x".repeat(1000));
  const side = await make("QĐ-152 UI · Dự án phụ", scenes.slice(0, 2));
  console.log(JSON.stringify({ main: main.p.id, side: side.p.id, video: r.videoPath }, null, 2));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
