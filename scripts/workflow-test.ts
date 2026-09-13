import { PrismaClient } from "@prisma/client";

/**
 * End-to-end workflow check with a real text provider.
 *
 * Idiom -> project -> script (REAL Text AI) -> JSON validation -> storyboard ->
 * quality score -> routing plan -> cost estimate.
 *
 * Media stays mock: this only swaps the text stage. Nothing here starts image,
 * video or voice generation.
 *
 * Usage:
 *   npx tsx scripts/workflow-test.ts --idiom "Break a leg"
 *   npx tsx scripts/workflow-test.ts --keep     (giu lai du an de xem tren UI)
 */

const prisma = new PrismaClient();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function line(): void {
  console.log("-".repeat(72));
}

async function main(): Promise<void> {
  const idiomPhrase = arg("idiom", "Break a leg");
  const keep = process.argv.includes("--keep");

  // Real text, mock media. The registry gate is what makes the split possible.
  process.env.AI_MOCK_MODE = "false";
  const { resetEnvCache } = await import("../src/lib/env");
  resetEnvCache();

  const { createProjectForIdiom, previewProjectCost, selectTextModel } =
    await import("../src/services/project-service");
  const { spendStatus } = await import("../src/services/spend-guard");

  const idiom = await prisma.idiom.findFirst({ where: { phrase: idiomPhrase } });
  if (!idiom) {
    console.error(`Khong tim thay thanh ngu "${idiomPhrase}".`);
    process.exitCode = 1;
    return;
  }

  const before = await spendStatus();
  const chosen = await selectTextModel("BALANCED");

  console.log("\nWORKFLOW THAT: Text AI that, media van mock");
  line();
  console.log(`Thanh ngu      : ${idiom.phrase}`);
  console.log(`Text AI duoc chon: ${chosen.provider}/${chosen.model}`);
  console.log(`Da chi truoc   : $${before.spent.toFixed(6)}`);
  console.log(`Han muc        : $${before.cap.toFixed(2)}`);
  line();

  console.log("\n[1/5] Tao du an + sinh kich ban bang Text AI that...");
  const project = await createProjectForIdiom({
    idiomId: idiom.id,
    qualityMode: "BALANCED",
    targetDuration: 27,
    maxBudget: 10,
    autoGenerateScript: true,
    // Never: media generation is a separate, explicit step.
    autoStartMedia: false,
  });

  const full = await prisma.project.findUniqueOrThrow({
    where: { id: project.id },
    include: { scenes: { orderBy: { sceneNumber: "asc" } } },
  });

  console.log(`      Trang thai: ${full.status}`);
  console.log(`      Tieu de   : ${full.title}`);

  console.log("\n[2/5] Kiem tra JSON hop le va luu vao SQLite...");
  const script = JSON.parse(full.scriptJson ?? "{}") as {
    hook: string;
    punchline: string;
    meaning: string;
    exampleSentence: string;
    angleKey: string;
    scenes: unknown[];
  };
  console.log(`      JSON parse: OK`);
  console.log(`      So canh trong DB: ${full.scenes.length}`);
  console.log(`      Goc hai huoc: ${script.angleKey}`);

  console.log("\n[3/5] Noi dung kich ban that:");
  console.log(`      Hook      : ${script.hook}`);
  console.log(`      Punchline : ${script.punchline}`);
  console.log(`      Nghia that: ${script.meaning}`);
  console.log(`      Vi du     : ${script.exampleSentence}`);

  console.log("\n[4/5] Storyboard (do Text AI that sinh ra):");
  for (const s of full.scenes) {
    console.log(
      `      Canh ${s.sceneNumber} | ${s.duration}s | ${s.complexity.padEnd(6)} | ` +
        `uu tien ${s.spendPriority}`,
    );
    console.log(`        Phu de   : ${s.subtitle}`);
    console.log(`        Thoai    : ${s.dialogue || "(khong co)"}`);
    console.log(`        Prompt anh  : ${s.imagePrompt.slice(0, 90)}...`);
    console.log(`        Prompt video: ${s.videoPrompt.slice(0, 90)}...`);
  }

  const score = JSON.parse(full.scriptScoreJson ?? "{}") as Record<string, unknown>;
  console.log("\n      Diem chat luong kich ban (do Text AI that cham):");
  console.log(
    `        hook ${score.hook}, humor ${score.humor}, clarity ${score.clarity}, ` +
      `learning ${score.learningValue}, visual ${score.visualFeasibility}`,
  );
  console.log(`        viet lai: ${score.rewritten}, tranh trung: ${score.duplicateAvoided}`);

  console.log("\n[5/5] Dinh tuyen + uoc tinh chi phi media (van la mock):");
  const preview = await previewProjectCost(project.id);
  for (const plan of preview.current.scenes) {
    console.log(
      `      Canh ${plan.sceneNumber}: video=${plan.video?.modelId ?? "-"} ` +
        `anh=${plan.image?.modelId ?? "-"} ` +
        `($${plan.estimatedCost.toFixed(4)})`,
    );
  }
  console.log(`      Tiet kiem      : $${preview.modes.ECONOMY.breakdown.total.toFixed(4)}`);
  console.log(`      Can bang       : $${preview.modes.BALANCED.breakdown.total.toFixed(4)}`);
  console.log(`      Chat luong cao : $${preview.modes.QUALITY.breakdown.total.toFixed(4)}`);
  console.log(`      Trong ngan sach: ${preview.budget.allowed}`);

  const after = await spendStatus();
  const costs = await prisma.costEntry.findMany({
    where: { projectId: project.id },
    select: { category: true, provider: true, model: true, amount: true, note: true },
  });

  line();
  console.log("CHI PHI THAT CUA LAN CHAY NAY");
  for (const c of costs) {
    console.log(
      `  ${c.category.padEnd(6)} ${c.provider}/${c.model} ` +
        `$${c.amount.toFixed(6)}  ${c.note}`,
    );
  }
  console.log(`  Tong lan chay nay : $${(after.spent - before.spent).toFixed(6)}`);
  console.log(`  Tong tu truoc den gio: $${after.spent.toFixed(6)}`);
  console.log(`  Han muc con lai   : $${after.remaining.toFixed(6)}`);

  const jobs = await prisma.providerJob.findMany({
    where: { projectId: project.id },
    select: {
      kind: true,
      provider: true,
      status: true,
      inputTokens: true,
      outputTokens: true,
      durationMs: true,
      actualCost: true,
    },
  });
  console.log("\nGHI NHAN TUNG REQUEST (bang ProviderJob)");
  console.table(jobs);

  if (!keep) {
    await prisma.project.delete({ where: { id: project.id } });
    console.log("\nDa xoa du an thu nghiem. Dung --keep neu muon giu lai.");
  } else {
    console.log(`\nDu an duoc giu lai: /projects/${project.id}`);
  }
  console.log("");
}

main()
  .catch((err: unknown) => {
    console.error("\nWORKFLOW THAT BAI:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
