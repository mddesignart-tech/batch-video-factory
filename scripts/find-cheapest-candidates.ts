import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { sceneCharacters } from "@/domain/scene-characters";
import { recommendAuthorization } from "@/domain/cost-basis";
import type { Complexity, QualityMode, SpendPriority } from "@/domain/enums";
import {
  estimateProject,
  type PlannedSceneInput,
  type ProjectEstimate,
} from "@/services/cost-estimator";
import { productionProviderNames } from "@/services/provider-health";
import { spendStatus } from "@/services/spend-guard";
import { speechTextFor } from "@/services/generation";
import { peekCreateToken } from "@/services/create-token";

/**
 * Find the cheapest, safest video to run for real first.
 *
 * Reads only. It scans projects that already have a script on this machine -
 * so the scene shapes are REAL, not a reference profile - prices each against
 * real vendors at list prices, and ranks them.
 *
 * "Cheapest" is not the whole test. A video that routes entirely to models
 * nobody has cleared is not a good first run at any price, so a candidate is
 * disqualified outright when any scene comes back NEEDS_PROVIDER. Sorting on
 * cost alone would put a blocked video at the top with a total of $0.00,
 * because scenes that cannot route cost nothing.
 *
 *   npx tsx scripts/find-cheapest-candidates.ts --mode ECONOMY --top 3
 */

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const money = (n: number, d = 4) => `$${n.toFixed(d)}`;
const pad = (s: string, n: number) => s.padEnd(n);

interface Candidate {
  phrase: string;
  projectId: string;
  sceneCount: number;
  localMotion: number;
  runwayLow: number;
  mediumScenes: number;
  highScenes: number;
  blockedScenes: number;
  estimate: ProjectEstimate;
  blockingReason: string;
  runnable: boolean;
}

async function main(): Promise<void> {
  const mode = arg("mode", "ECONOMY").toUpperCase() as QualityMode;
  const top = Number(arg("top", "3")) || 3;

  console.log("=".repeat(96));
  console.log("  TIM VIDEO RE VA AN TOAN NHAT DE CHAY THAT  (DRY RUN, KHONG GOI API)");
  console.log("=".repeat(96));

  const token = await peekCreateToken();
  console.log(`  AI_MOCK_MODE         : ${isMockMode()}`);
  console.log(`  CREATE_ATTEMPT_TOKEN : ${token ? "CO (!!)" : "0"}`);
  console.log(`  Che do               : ${mode}`);

  const providers = await productionProviderNames();
  console.log(`  Provider thuc te     : ${providers.join(", ") || "(khong co)"}`);
  if (providers.length === 0) {
    console.log("\n  KHONG co nha cung cap that nao duoc cau hinh.");
    return;
  }

  const models = await prisma.modelRegistry.findMany({ where: { enabled: true } });

  // Only projects with a REAL script. A reference profile would rank videos
  // against a shape none of them actually has.
  const projects = await prisma.project.findMany({
    where: { scriptJson: { not: null } },
    orderBy: { createdAt: "desc" },
    include: {
      idiom: { select: { phrase: true } },
      scenes: { where: { skipped: false }, orderBy: { sceneNumber: "asc" } },
    },
  });

  // One row per idiom, newest script wins: older projects for the same idiom
  // are earlier drafts, not separate candidates.
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const project of projects) {
    if (project.scenes.length === 0) continue;
    if (seen.has(project.idiomId)) continue;
    seen.add(project.idiomId);

    const scenes: PlannedSceneInput[] = project.scenes.map((scene) => ({
      sceneNumber: scene.sceneNumber,
      duration: scene.duration,
      complexity: scene.complexity as Complexity,
      spendPriority: scene.spendPriority as SpendPriority,
      characterCount: sceneCharacters(scene).present.length || 1,
      speechText: speechTextFor(scene),
    }));

    const estimate = estimateProject({
      scenes,
      models,
      qualityMode: mode,
      strategy: "AUTO",
      // Deliberately not a real ceiling: this asks what the work costs, and a
      // budget would silently downgrade models and report a cheaper video than
      // the one that would be made.
      maxBudget: 1000,
      availableProviders: providers,
      needs1080p: mode === "QUALITY",
    });

    const blocked = estimate.scenes.filter((p) => p.needsProvider !== undefined);
    const runwayLow = estimate.scenes.filter(
      (p) => p.video?.provider === "runway",
    ).length;

    candidates.push({
      phrase: project.idiom.phrase,
      projectId: project.id,
      sceneCount: scenes.length,
      localMotion: estimate.localMotionScenes,
      runwayLow,
      mediumScenes: scenes.filter((s) => s.complexity === "MEDIUM").length,
      highScenes: scenes.filter((s) => s.complexity === "HIGH").length,
      blockedScenes: blocked.length,
      estimate,
      blockingReason:
        blocked.length > 0
          ? `${blocked.length} cảnh NEEDS_PROVIDER (cảnh ${blocked
              .map((p) => p.sceneNumber)
              .join(", ")})`
          : estimate.errors.length > 0
            ? estimate.errors[0]!
            : "",
      runnable: blocked.length === 0 && estimate.errors.length === 0,
    });
  }

  if (candidates.length === 0) {
    console.log("\n  Khong co project nao co kich ban tren may nay.");
    return;
  }

  // Runnable first, then cheapest. Cost alone would float a fully blocked video
  // to the top, because a scene that cannot route is priced at zero.
  candidates.sort((a, b) => {
    if (a.runnable !== b.runnable) return a.runnable ? -1 : 1;
    return a.estimate.breakdown.total - b.estimate.breakdown.total;
  });

  console.log(`\n  Da quet ${candidates.length} project co kich ban that.\n`);
  console.log(
    `  ${pad("#", 3)}${pad("Idiom", 22)}${pad("Canh", 6)}${pad("LOCAL", 7)}` +
      `${pad("RUNWAY", 8)}${pad("MED", 5)}${pad("HIGH", 6)}${pad("Image", 10)}` +
      `${pad("Video", 10)}${pad("Text", 10)}${pad("Voice", 10)}${pad("TOTAL", 11)}Chan`,
  );
  console.log("  " + "-".repeat(94));

  candidates.forEach((c, i) => {
    const b = c.estimate.breakdown;
    console.log(
      `  ${pad(String(i + 1), 3)}${pad(c.phrase.slice(0, 20), 22)}` +
        `${pad(String(c.sceneCount), 6)}${pad(String(c.localMotion), 7)}` +
        `${pad(String(c.runwayLow), 8)}${pad(String(c.mediumScenes), 5)}` +
        `${pad(String(c.highScenes), 6)}${pad(money(b.image), 10)}` +
        `${pad(money(b.video), 10)}${pad(money(b.text), 10)}` +
        `${pad(money(b.voice), 10)}${pad(money(b.total), 11)}` +
        (c.runnable ? "-" : c.blockingReason),
    );
  });

  const cap = await spendStatus();
  const runnable = candidates.filter((c) => c.runnable);

  console.log("\n" + "=".repeat(96));
  console.log(`  TOP ${top} UNG VIEN CHAY DUOC`);
  console.log("=".repeat(96));

  if (runnable.length === 0) {
    console.log("\n  KHONG co ung vien nao chay duoc voi dinh tuyen hien tai.");
    console.log("  Moi project deu co it nhat mot canh khong dinh tuyen duoc.");
    console.log("\n  Ly do, theo tung project:");
    for (const c of candidates.slice(0, top)) {
      console.log(`    - ${c.phrase}: ${c.blockingReason}`);
    }
    const first = candidates[0];
    if (first) {
      const sample = first.estimate.scenes.find((p) => p.needsProvider);
      if (sample?.needsProvider) {
        console.log(`\n  Chi tiet mot canh (${first.phrase}, canh ${sample.sceneNumber}):`);
        console.log(`    ${sample.needsProvider}`);
      }
    }
    return;
  }

  for (const [i, c] of runnable.slice(0, top).entries()) {
    const rec = recommendAuthorization(c.estimate.breakdown.total, cap.remaining);
    const b = c.estimate.breakdown;
    console.log(`\n  ${i + 1}. ${c.phrase}   (project ${c.projectId.slice(0, 8)})`);
    console.log(`     ${c.sceneCount} canh: ${c.localMotion} LOCAL_MOTION, ${c.runwayLow} Runway, ${c.sceneCount - c.localMotion - c.runwayLow} khac`);
    console.log(`     TEXT ${money(b.text)}  IMAGE ${money(b.image)}  VIDEO ${money(b.video)}  VOICE ${money(b.voice)}`);
    console.log(`     TOTAL ${money(b.total)}   -> de xuat tran ${money(rec.recommended, 2)} (+10%)`);
    for (const plan of c.estimate.scenes) {
      const src = plan.motionSource === "LOCAL_MOTION" ? "LOCAL" : "AI   ";
      const d = plan.duration_plan;
      const dur = d ? `${d.willSend}s${d.status === "DURATION_TRANSFORM_REQUIRED" ? " !!" : ""}` : "-";
      console.log(
        `       canh ${plan.sceneNumber} ${src} ${pad(plan.complexity, 7)}` +
          `${pad(plan.video ? `${plan.video.provider}/${plan.video.modelId}` : "ffmpeg", 30)}` +
          `${pad(dur, 7)}${money(plan.video?.estimatedCost ?? 0)}`,
      );
    }
  }

  console.log(
    `\n  Han muc tong: da chi ${money(cap.spent, 6)} / ${money(cap.cap, 2)}, con ${money(cap.remaining, 6)}`,
  );
  console.log("\n  CHI PHI API CUA LAN CHAY NAY: $0.00 (chi doc du lieu)\n");

}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
