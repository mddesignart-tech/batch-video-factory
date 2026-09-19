import { PrismaClient } from "@prisma/client";

/**
 * The Image AI acceptance run.
 *
 * Generates a Character Master for each character, approves it, then draws a
 * few scenes from several idioms and reports what was actually sent - above all
 * whether each scene carried the character references that keep Max and Leo
 * on-model.
 *
 * Runs identically in mock mode (free) and against a real provider. That is the
 * point: the plumbing is proven for $0.00 before a single cent is spent.
 *
 * Usage:
 *   npx tsx scripts/image-test.ts                       # mock, free
 *   npx tsx scripts/image-test.ts --real --model gpt-image-1:medium
 *   npx tsx scripts/image-test.ts --real --scenes 2 --dry-run
 */

const prisma = new PrismaClient();

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value ?? fallback;
}

const IDIOMS = ["Break a leg", "Spill the beans", "Piece of cake"];

async function main(): Promise<void> {
  const real = flag("real");
  const dryRun = flag("dry-run");
  const scenesPerProject = Number(arg("scenes", "3"));
  const model = arg("model", real ? "gpt-image-1:medium" : "mock-image-pro");
  const provider = real ? "openai" : "mock";

  process.env.AI_MOCK_MODE = real ? "false" : "true";
  const { resetEnvCache } = await import("../src/lib/env");
  resetEnvCache();

  const { generateCharacterMaster, approveCharacterReference } = await import(
    "../src/services/character-master"
  );
  const { getCharacterSheet } = await import(
    "../src/services/character-service"
  );
  const { buildSceneImageRequest, generateSceneImage } = await import(
    "../src/services/generation"
  );
  const { spendStatus } = await import("../src/services/spend-guard");

  const before = await spendStatus();
  const modelRow = await prisma.modelRegistry.findUnique({
    where: { provider_modelId: { provider, modelId: model } },
  });

  console.log("\n========== BAI TEST IMAGE AI ==========\n");
  console.log(`  Che do      : ${real ? "THAT (co tinh tien)" : "MOCK (mien phi)"}`);
  console.log(`  Provider    : ${provider}`);
  console.log(`  Model       : ${model}`);
  console.log(`  Gia         : $${modelRow?.price ?? "?"} / anh`);
  console.log(`  Da chi      : $${before.spent.toFixed(6)} / han muc $${before.cap.toFixed(2)}`);

  const characters = await prisma.character.findMany({
    where: { enabled: true },
    orderBy: { name: "asc" },
  });
  const projects = await prisma.project.findMany({
    where: { idiom: { phrase: { in: IDIOMS } } },
    include: { idiom: true, scenes: { orderBy: { sceneNumber: "asc" } } },
  });

  const plannedImages =
    characters.length +
    projects.reduce((n, p) => n + Math.min(scenesPerProject, p.scenes.length), 0);
  const plannedCost = plannedImages * (modelRow?.price ?? 0);

  console.log(`\n  Du kien     : ${characters.length} anh chuan + ${plannedImages - characters.length} anh canh = ${plannedImages} anh`);
  console.log(`  Uoc tinh    : $${plannedCost.toFixed(4)}`);
  console.log(`  Sau khi chay: $${(before.spent + plannedCost).toFixed(4)} / $${before.cap.toFixed(2)}`);

  if (before.spent + plannedCost > before.cap) {
    console.log("\n  [DUNG] Uoc tinh vuot han muc. Khong chay.\n");
    process.exitCode = 1;
    return;
  }
  if (dryRun) {
    console.log("\n  --dry-run: chi uoc tinh, khong goi API.\n");
    return;
  }

  // ---------------------------------------------------- character masters ---
  console.log("\n---------- 1. ANH CHUAN NHAN VAT ----------");
  for (const character of characters) {
    const existing = await prisma.characterReference.findFirst({
      where: { characterId: character.id, isPrimary: true, approved: true },
    });
    if (existing) {
      console.log(`\n  ${character.name}: da co anh chuan, GIU NGUYEN (khong ve lai, khong tieu tien).`);
      console.log(`    ${existing.filePath}`);
      continue;
    }

    console.log(`\n  ${character.name}: dang tao anh chuan...`);
    try {
      const result = await generateCharacterMaster({
        characterId: character.id,
        provider,
        model,
      });
      console.log(`    Tep       : ${result.relativePath}`);
      console.log(`    Kich thuoc: ${(result.bytes / 1024).toFixed(0)} KB`);
      console.log(`    Chi phi   : $${result.actualCost.toFixed(6)}`);
      // Approving is a human decision in the UI; the test script approves so the
      // scene stage downstream has something to match against.
      await approveCharacterReference(result.referenceId);
      console.log(`    Da duyet lam anh chuan.`);
    } catch (err) {
      console.log(`    THAT BAI: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
  }

  // ------------------------------------------------------- scene images ----
  console.log("\n---------- 2. ANH CANH ----------");
  const consistency: {
    idiom: string;
    scene: number;
    characters: string[];
    referencesSent: number;
    file: string;
  }[] = [];

  for (const project of projects) {
    console.log(`\n  ${project.idiom.phrase} (${project.scenes.length} canh)`);
    const chosen = project.scenes.slice(0, scenesPerProject);

    for (const scene of chosen) {
      const shot = await buildSceneImageRequest(scene, project.stylePresetId);
      const names = shot.characters.map((c) => c.name);

      // Pin the model so the run tests the model that was asked for rather than
      // whatever the router would have preferred.
      await prisma.scene.update({
        where: { id: scene.id },
        data: { imageProvider: provider, imageModel: model, routingMode: "MANUAL" },
      });

      try {
        const filePath = await generateSceneImage(scene.id, { force: true });
        if (!filePath) {
          console.log(`    Canh ${scene.sceneNumber}: bo qua (che do tiet kiem)`);
          continue;
        }
        console.log(
          `    Canh ${scene.sceneNumber}: ${names.join(", ") || "khong co nhan vat"} | ` +
            `${shot.referenceImages.length} anh tham chieu gui kem`,
        );
        consistency.push({
          idiom: project.idiom.phrase,
          scene: scene.sceneNumber,
          characters: names,
          referencesSent: shot.referenceImages.length,
          file: filePath,
        });
      } catch (err) {
        console.log(
          `    Canh ${scene.sceneNumber}: THAT BAI - ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // ------------------------------------------------------- consistency -----
  console.log("\n---------- 3. TINH NHAT QUAN NHAN VAT ----------");
  for (const character of characters) {
    const sheet = await getCharacterSheet(character.id);
    const appearances = consistency.filter((c) =>
      c.characters.includes(character.name),
    );
    const withReference = appearances.filter((a) => a.referencesSent > 0);

    console.log(`\n  ${character.name}`);
    console.log(`    Anh chuan          : ${sheet?.primaryReference ?? "KHONG CO"}`);
    console.log(`    Xuat hien o        : ${appearances.length} canh`);
    console.log(`    Co anh tham chieu  : ${withReference.length}/${appearances.length} canh`);
    if (appearances.length > 0 && withReference.length < appearances.length) {
      console.log(
        `    CANH BAO: co canh khong duoc gui anh tham chieu - nhan vat de bi ve khac.`,
      );
    }
    for (const a of appearances) {
      console.log(`      ${a.idiom} canh ${a.scene}: ${a.file}`);
    }
  }

  // ------------------------------------------------------------- cost ------
  const after = await spendStatus();
  const imageRows = await prisma.costEntry.aggregate({
    where: { category: "image", estimated: false, provider: { not: "mock" } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const mockRows = await prisma.costEntry.count({
    where: { category: "image", provider: "mock" },
  });

  console.log("\n---------- 4. CHI PHI ----------");
  console.log(`  Chi phi API THAT cho anh : $${(imageRows._sum.amount ?? 0).toFixed(6)} (${imageRows._count._all} lan goi)`);
  console.log(`  Lan goi MOCK (0 dong)    : ${mockRows}`);
  console.log(`  Tong da chi (moi loai)   : $${after.spent.toFixed(6)}`);
  console.log(`  Lan chay nay tieu them   : $${(after.spent - before.spent).toFixed(6)}`);
  console.log(`  Han muc                  : $${after.cap.toFixed(2)}, con $${(after.cap - after.spent).toFixed(6)}`);
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
