import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * QĐ-158: an old project whose speaker's saved voice no longer exists - does
 * "Render lại" still work, with the audio the person approved, and no TTS?
 *
 * ONLY on a COPY of the database (refuses data/app.db) and a separate DATA_DIR:
 * the project's folder is COPIED from SRC_DATA first, so nothing real is touched.
 *
 *   SRC_DATA=<real data dir> DATA_DIR=<scratch dir> DATABASE_URL=file:<copy.db> \
 *     npx tsx scripts/qa/qd158-rerender-check.ts <projectId>
 */

const sha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);

async function main(): Promise<void> {
  const projectId = process.argv[2];
  const { DATA_DIR, DATABASE_URL, SRC_DATA } = process.env;
  if (!projectId || !DATA_DIR || !SRC_DATA || !DATABASE_URL || /data[\\/]app\.db/.test(DATABASE_URL) || path.resolve(DATA_DIR) === path.resolve(SRC_DATA)) {
    throw new Error("Cần projectId, SRC_DATA, DATA_DIR riêng và DATABASE_URL là bản sao (không phải data/app.db).");
  }
  process.env.AI_MOCK_MODE = "true";
  process.env.JOB_WORKER_ENABLED = "false";
  fs.cpSync(path.join(SRC_DATA, "projects", projectId), path.join(DATA_DIR, "projects", projectId), { recursive: true });

  const { prisma } = await import("../../src/lib/prisma");
  const { toAbsolute } = await import("../../src/lib/paths");
  const { requeueRender } = await import("../../src/services/project-service");
  const { claimNext, completeJob } = await import("../../src/jobs/queue");
  const { runJob } = await import("../../src/jobs/handlers");
  const { planSceneVoice } = await import("../../src/services/generation");

  const lines = await prisma.dialogueLine.findMany({ where: { scene: { projectId } }, orderBy: [{ scene: { sceneNumber: "asc" } }, { lineNumber: "asc" }] });
  const before = Object.fromEntries(lines.map((l) => [l.outputPath, sha(toAbsolute(l.outputPath))]));
  const ttsBefore = await prisma.providerJob.count({ where: { kind: "audio" } });
  const costBefore = await prisma.costEntry.count();
  const scenes = await prisma.scene.findMany({ where: { projectId, deletedAt: null }, orderBy: { sceneNumber: "asc" } });
  const plan = [];
  for (const s of scenes) plan.push(...(await planSceneVoice(s.id)).lines.map((l) => `${l.state}:${l.voiceId}`));

  await requeueRender(projectId);
  const job = await claimNext();
  if (!job || job.type !== "render_final") throw new Error(`Job không đúng: ${job?.type}`);
  const res = await runJob(job);
  if (res.deferred) throw new Error("Render bị hoãn.");
  await completeJob(job.id, res.result);

  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const after = Object.fromEntries(lines.map((l) => [l.outputPath, sha(toAbsolute(l.outputPath))]));
  console.log(
    JSON.stringify(
      {
        projectId,
        status: project.status,
        finalVideo: project.finalVideoPath,
        finalExists: Boolean(project.finalVideoPath && fs.existsSync(toAbsolute(project.finalVideoPath))),
        voicePlanBefore: plan,
        approvedAudioUnchanged: lines.every((l) => before[l.outputPath] === after[l.outputPath]),
        linesUsed: lines.map((l) => `${l.provider}/${l.voiceId} ${l.outputPath}`),
        newTtsRequests: (await prisma.providerJob.count({ where: { kind: "audio" } })) - ttsBefore,
        newCostEntries: (await prisma.costEntry.count()) - costBefore,
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
