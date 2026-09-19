import { PrismaClient } from "@prisma/client";

/**
 * Regenerate a chosen set of scene images.
 *
 * Takes an explicit list rather than "everything missing", because each image
 * costs real money and a blanket regeneration is the easiest way to spend far
 * more than intended. It estimates first, refuses to start if the estimate
 * would break the cap, and reports the reference routing for each scene so the
 * character-consistency claim can be checked rather than assumed.
 *
 * Usage:
 *   npx tsx scripts/regenerate-scenes.ts --dry-run
 *   npx tsx scripts/regenerate-scenes.ts --real
 */

const prisma = new PrismaClient();

/**
 * The scenes to draw, chosen for coverage rather than convenience:
 * one character alone, two both speaking, three with one speaking, a silent
 * scene, and a pair that excludes the lead.
 */
const TARGETS: { idiom: string; scenes: number[] }[] = parseTargets();

/** `--only "Piece of cake:3"` narrows the run to one scene. */
function parseTargets(): { idiom: string; scenes: number[] }[] {
  const i = process.argv.indexOf("--only");
  const spec = i >= 0 ? process.argv[i + 1] : undefined;
  if (spec) {
    const [idiom, scene] = spec.split(":");
    if (idiom && scene) return [{ idiom, scenes: [Number(scene)] }];
  }
  return [{ idiom: "Spill the beans", scenes: [1, 2, 3, 4, 5, 6] }];
}

const MODEL = "gpt-image-2:medium";
const PROVIDER = "openai";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * A ceiling for THIS run, separate from the app-wide cap.
 *
 * The app cap protects the account; this protects the batch. A run that was
 * authorised at "about $0.29" must not quietly become $1.50 because a price
 * changed or more scenes matched than expected.
 */
function runLimit(): number {
  const i = process.argv.indexOf("--limit");
  const raw = i >= 0 ? process.argv[i + 1] : undefined;
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

async function main(): Promise<void> {
  const real = flag("real");
  const dryRun = flag("dry-run") || !real;

  process.env.AI_MOCK_MODE = real ? "false" : "true";
  const { resetEnvCache } = await import("../src/lib/env");
  resetEnvCache();

  const { buildSceneImageRequest, generateSceneImage } = await import(
    "../src/services/generation"
  );
  const { sceneCharacters } = await import("../src/domain/scene-characters");
  const { spendStatus } = await import("../src/services/spend-guard");
  const { estimateImageBatchCost } = await import("../src/services/image-quality");
  const modelRow = await prisma.modelRegistry.findUniqueOrThrow({
    where: { provider_modelId: { provider: PROVIDER, modelId: MODEL } },
  });
  const before = await spendStatus();

  // Resolve the targets into real scene rows first, so the estimate counts what
  // will actually be drawn rather than what was asked for.
  const jobs: { idiom: string; sceneId: string; sceneNumber: number }[] = [];
  for (const target of TARGETS) {
    const project = await prisma.project.findFirst({
      where: { idiom: { phrase: target.idiom } },
      include: { scenes: true },
    });
    if (!project) {
      console.log(`  Khong tim thay du an: ${target.idiom}`);
      continue;
    }
    for (const number of target.scenes) {
      const scene = project.scenes.find((s) => s.sceneNumber === number);
      if (!scene) {
        console.log(`  ${target.idiom} khong co canh ${number}`);
        continue;
      }
      jobs.push({ idiom: target.idiom, sceneId: scene.id, sceneNumber: number });
    }
  }

  const estimate = estimateImageBatchCost({
    mode: "BALANCED",
    imageCount: jobs.length,
    pricePerImage: modelRow.price,
  });
  const limit = runLimit();

  console.log("\n========== TAO LAI ANH CANH ==========\n");
  console.log(`  Che do    : ${real ? "THAT (co tinh tien)" : "MOCK (mien phi)"}`);
  console.log(`  Model     : ${PROVIDER}/${MODEL}`);
  console.log(`  So anh    : ${jobs.length}`);
  console.log(`  Uoc tinh  : $${estimate.total.toFixed(4)}`);
  console.log(`  Da chi    : $${before.spent.toFixed(6)} / $${before.cap.toFixed(2)}`);
  console.log(`  Sau khi chay: $${(before.spent + estimate.total).toFixed(4)}`);

  if (Number.isFinite(limit)) {
    console.log(`  Han muc lan nay: $${limit.toFixed(2)}`);
  }

  // The per-run ceiling is checked before the app-wide cap because it is the
  // tighter of the two and the one the operator just authorised by name.
  if (estimate.total > limit) {
    console.log(
      `\n  [DUNG] Uoc tinh $${estimate.total.toFixed(4)} vuot han muc lan nay ` +
        `$${limit.toFixed(2)}. Khong goi API. Hoi lai truoc khi chay.\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (before.spent + estimate.total > before.cap) {
    console.log("\n  [DUNG] Uoc tinh vuot han muc tong. Khong chay.\n");
    process.exitCode = 1;
    return;
  }

  console.log("\n---------- DINH TUYEN ANH THAM CHIEU ----------");
  for (const job of jobs) {
    const scene = await prisma.scene.findUniqueOrThrow({
      where: { id: job.sceneId },
      include: { project: true },
    });
    const lists = sceneCharacters(scene);
    const shot = await buildSceneImageRequest(scene, scene.project.stylePresetId);

    console.log(`\n  ${job.idiom} canh ${job.sceneNumber}`);
    console.log(`    Trong khung : ${lists.present.join(", ") || "-"}`);
    if (shot.trimmedCharacters.length > 0) {
      console.log(
        `    DA CAT BOT  : ${shot.trimmedCharacters.join(", ")} — kich ban liet ke nhung khong dan canh`,
      );
    }
    console.log(`    Co thoai    : ${lists.speaking.join(", ") || "khong ai"}`);
    console.log(`    Trong tam   : ${lists.primary.join(", ") || "-"}`);
    console.log(`    Thu tu anh  : ${shot.referencedCharacters.join(" > ") || "khong"}`);
    if (shot.unreferencedCharacters.length > 0) {
      console.log(`    THIEU ANH CHUAN: ${shot.unreferencedCharacters.join(", ")}`);
    }
    if (shot.droppedByLimit.length > 0) {
      console.log(`    BI CAT       : ${shot.droppedByLimit.join(", ")}`);
    }
    if (shot.repairedCharacters.length > 0) {
      console.log(`    DA TU SUA    : ${shot.repairedCharacters.join(", ")}`);
    }
  }

  if (dryRun) {
    console.log("\n  --dry-run: chi kiem tra, khong goi API.\n");
    return;
  }

  console.log("\n---------- DANG TAO ----------");
  let drawn = 0;
  for (const job of jobs) {
    // Re-checked before every image, not only once up front. An estimate that
    // turns out too low must stop the run mid-way rather than be discovered
    // afterwards from the bill.
    const spentThisRun = (await spendStatus()).spent - before.spent;
    if (spentThisRun >= limit) {
      console.log(
        `  [DUNG] Da tieu $${spentThisRun.toFixed(6)} trong lan chay nay, cham ` +
          `han muc $${limit.toFixed(2)}. Bo qua ${jobs.length - drawn} anh con lai.`,
      );
      break;
    }

    await prisma.scene.update({
      where: { id: job.sceneId },
      data: {
        imageProvider: PROVIDER,
        imageModel: MODEL,
        routingMode: "MANUAL",
      },
    });
    try {
      const filePath = await generateSceneImage(job.sceneId, { force: true });
      drawn++;
      console.log(`  ${job.idiom} canh ${job.sceneNumber}: ${filePath}`);
    } catch (err) {
      console.log(
        `  ${job.idiom} canh ${job.sceneNumber}: THAT BAI - ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const after = await spendStatus();
  console.log("\n---------- CHI PHI ----------");
  console.log(`  Da ve       : ${drawn}/${jobs.length} anh`);
  console.log(`  Uoc tinh    : $${estimate.total.toFixed(6)}`);
  console.log(`  THUC TE     : $${(after.spent - before.spent).toFixed(6)}`);
  console.log(`  Tong da chi : $${after.spent.toFixed(6)} / $${after.cap.toFixed(2)}`);
  console.log(`  Con lai     : $${(after.cap - after.spent).toFixed(6)}`);
  console.log("");
}

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
