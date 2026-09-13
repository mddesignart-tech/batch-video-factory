import { PrismaClient } from "@prisma/client";

/**
 * Character presence verification.
 *
 * Regenerates the scripts for a few idioms and reports, per scene, who is in
 * frame, who speaks, who leads, and exactly which reference images the image
 * request would carry.
 *
 * No image is generated: the whole point is that the payload can be checked
 * without paying an image provider. Only the text call costs anything, and
 * only when --real is passed.
 *
 * Usage:
 *   npx tsx scripts/presence-test.ts             # mock text, free
 *   npx tsx scripts/presence-test.ts --real      # real text model
 *   npx tsx scripts/presence-test.ts --inspect   # no regeneration, read as-is
 */

const prisma = new PrismaClient();

const IDIOMS = ["Break a leg", "Spill the beans", "Piece of cake"];

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const real = flag("real");
  const inspectOnly = flag("inspect");

  process.env.AI_MOCK_MODE = real ? "false" : "true";
  const { resetEnvCache } = await import("../src/lib/env");
  resetEnvCache();

  const { generateProjectScript, persistScript } = await import(
    "../src/services/project-service"
  );
  const { buildSceneImageRequest } = await import("../src/services/generation");
  const { sceneCharacters } = await import("../src/domain/scene-characters");
  const { spendStatus } = await import("../src/services/spend-guard");

  const before = await spendStatus();
  console.log("\n========== KIEM TRA CHARACTER PRESENCE ==========\n");
  console.log(`  Text AI  : ${real ? "THAT (co tinh tien)" : "MOCK (mien phi)"}`);
  console.log(`  Image AI : KHONG GOI - chi kiem tra payload`);
  console.log(`  Da chi   : $${before.spent.toFixed(6)} / $${before.cap.toFixed(2)}`);

  const projects = await prisma.project.findMany({
    where: { idiom: { phrase: { in: IDIOMS } } },
    include: { idiom: true },
  });

  let totalScenes = 0;
  let scenesWithSilentCharacter = 0;
  let scenesMissingReference = 0;
  let repairedTotal = 0;

  for (const project of projects) {
    if (!inspectOnly) {
      console.log(`\n  Dang tao lai kich ban: ${project.idiom.phrase}...`);
      try {
        const script = await generateProjectScript(project.id);
        await persistScript(project.id, script);
      } catch (err) {
        console.log(`    THAT BAI: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    const scenes = await prisma.scene.findMany({
      where: { projectId: project.id },
      orderBy: { sceneNumber: "asc" },
    });

    console.log(`\n---------- ${project.idiom.phrase} ----------`);

    for (const scene of scenes) {
      const lists = sceneCharacters(scene);
      const shot = await buildSceneImageRequest(scene, project.stylePresetId);
      totalScenes++;

      // The case the old single list could not express: on screen, no line.
      const silent = lists.present.filter(
        (n) => !lists.speaking.some((s) => s.toLowerCase() === n.toLowerCase()),
      );
      if (silent.length > 0) scenesWithSilentCharacter++;
      if (shot.unreferencedCharacters.length > 0) scenesMissingReference++;
      repairedTotal += shot.repairedCharacters.length;

      console.log(`\n  Canh ${scene.sceneNumber}`);
      console.log(`    Trong khung hinh : ${lists.present.join(", ") || "-"}`);
      console.log(`    Co thoai         : ${lists.speaking.join(", ") || "khong ai"}`);
      console.log(`    Trong tam        : ${lists.primary.join(", ") || "-"}`);
      if (silent.length > 0) {
        console.log(`    Co mat nhung im lang: ${silent.join(", ")}`);
      }
      console.log(`    Anh tham chieu gui: ${shot.referencedCharacters.join(", ") || "khong"} (${shot.referenceImages.length})`);
      if (shot.repairedCharacters.length > 0) {
        console.log(`    DA TU SUA         : bo sung ${shot.repairedCharacters.join(", ")}`);
      }
      if (shot.unreferencedCharacters.length > 0) {
        console.log(`    CHUA CO ANH CHUAN : ${shot.unreferencedCharacters.join(", ")}`);
      }
      if (shot.droppedByLimit.length > 0) {
        console.log(`    BI CAT VI GIOI HAN: ${shot.droppedByLimit.join(", ")}`);
      }

      // The regression itself: everyone visible must have their profile in the
      // prompt, whether or not they have a line.
      for (const name of lists.present) {
        if (!shot.prompt.includes(`${name}:`)) {
          console.log(`    [HONG] ${name} co mat nhung KHONG co ho so trong prompt`);
          process.exitCode = 1;
        }
      }
    }
  }

  const after = await spendStatus();
  console.log("\n---------- TONG KET ----------");
  console.log(`  Tong so canh                       : ${totalScenes}`);
  console.log(`  Canh co nguoi im lang trong khung  : ${scenesWithSilentCharacter}`);
  console.log(`  Canh phai tu sua danh sach         : ${repairedTotal}`);
  console.log(`  Canh co nguoi chua co anh chuan    : ${scenesMissingReference}`);
  console.log(`\n  Chi phi Text AI lan nay : $${(after.spent - before.spent).toFixed(6)}`);
  console.log(`  Chi phi Image AI lan nay: $0.000000 (khong goi)`);
  console.log(`  Tong da chi             : $${after.spent.toFixed(6)} / $${after.cap.toFixed(2)}`);
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
