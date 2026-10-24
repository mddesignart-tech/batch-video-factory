/**
 * QĐ-158: what the Character Voice Manager means for every scene of a database -
 * read-only (planSceneVoice: no request, no write). Run it on a COPY of the real
 * database with the migration applied; it refuses data/app.db.
 *
 *   DATABASE_URL=file:<copy.db> DATA_DIR=<data dir> npx tsx scripts/qa/qd158-plan-impact.ts
 *
 * Prints, per project: lines whose voice is DONE / REUSE (kept as is), lines that
 * would need new audio, and lines now BLOCKED by a saved voice that no longer exists.
 */

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL || /data[\\/]app\.db/.test(process.env.DATABASE_URL)) {
    throw new Error("Chỉ chạy trên bản sao database, không chạy trên data/app.db.");
  }
  process.env.JOB_WORKER_ENABLED = "false";
  const { prisma } = await import("../../src/lib/prisma");
  const { planSceneVoice } = await import("../../src/services/generation");
  const { characterVoiceIssues } = await import("../../src/services/voice-catalog");

  for (const c of await prisma.character.findMany({ orderBy: { createdAt: "asc" } })) {
    const issues = await characterVoiceIssues(c);
    console.log(`NHÂN VẬT ${c.name}: ${c.voiceProvider}/${c.voiceModel}/${c.voiceId}${issues.length ? ` -> CẢNH BÁO: ${issues.map((i) => i.detail).join("; ")}` : " -> hợp lệ"}`);
  }
  const projects = await prisma.project.findMany({
    where: { deletedAt: null },
    include: { scenes: { where: { deletedAt: null, skipped: false }, orderBy: { sceneNumber: "asc" } } },
    orderBy: { createdAt: "asc" },
  });
  const total: Record<string, number> = {};
  for (const p of projects) {
    const states: Record<string, number> = {};
    const blocked: string[] = [];
    for (const s of p.scenes) {
      try {
        const plan = await planSceneVoice(s.id);
        for (const l of plan.lines) {
          states[l.state] = (states[l.state] ?? 0) + 1;
          total[l.state] = (total[l.state] ?? 0) + 1;
          if (l.state === "BLOCKED") blocked.push(`cảnh ${s.sceneNumber} câu ${l.lineNumber} (${l.speaker}): ${(l.message ?? "").slice(0, 90)}`);
        }
      } catch (err) {
        blocked.push(`cảnh ${s.sceneNumber}: LỖI ĐỌC ${(err as Error).message.slice(0, 90)}`);
      }
    }
    console.log(`\nDỰ ÁN ${p.title} [${p.status}] ${JSON.stringify(states)}`);
    for (const b of blocked) console.log(`  - ${b}`);
  }
  console.log(`\nTỔNG ${JSON.stringify(total)}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
