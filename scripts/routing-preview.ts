import { PrismaClient } from "@prisma/client";

/**
 * What each scene would cost, and which model would make it.
 *
 * Reads the project out of the database and runs the real router over it. No
 * network, no cost - the whole point is to see the bill before agreeing to it,
 * and a preview that called the API to find out would defeat itself.
 *
 * The comparison it prints is the one that decides whether per-scene routing is
 * worth its complexity: routed cost against the cost of putting every scene
 * through the best model.
 *
 * Usage:
 *   npx tsx scripts/routing-preview.ts --idiom "Spill the beans"
 */

const prisma = new PrismaClient();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
function fmt(n: number, d = 4): string {
  return Number.isFinite(n) ? n.toFixed(d) : "?";
}

async function main(): Promise<void> {
  const idiom = arg("idiom", "Spill the beans");
  const mode = arg("mode", "BALANCED");

  const { classifyScene, assignSpendPriority, extractSignals } = await import(
    "../src/services/complexity"
  );
  const { routeScene, RoutingError } = await import("../src/services/ai-router");
  const { sceneCharacters } = await import("../src/domain/scene-characters");
  const { billedVideoSeconds, splitModelSize } = await import(
    "../src/domain/video-duration"
  );
  const { checkSuitability } = await import("../src/domain/video-suitability");
  const { parseJson } = await import("../src/lib/utils");
  const { costForModel } = await import("../src/services/pricing");

  const project = await prisma.project.findFirst({
    where: { idiom: { phrase: idiom } },
    include: { idiom: true, scenes: { orderBy: { sceneNumber: "asc" } } },
  });
  if (!project) {
    console.log(`Khong tim thay du an "${idiom}".`);
    process.exitCode = 1;
    return;
  }

  // Every REAL video model, whether enabled or not: a preview should show what
  // routing would do, not only what is switched on right now.
  //
  // Mock is excluded deliberately. It is free and it would win every scene,
  // turning a cost comparison into a comparison with zero - which answers
  // nothing about whether per-scene routing is worth having.
  const allModels = await prisma.modelRegistry.findMany({
    where: { type: "video", provider: { not: "mock" } },
  });
  const providers = [...new Set(allModels.map((m) => m.provider))];

  console.log("\n========== XEM TRUOC DINH TUYEN VA CHI PHI ==========\n");
  console.log("  (Khong goi API. Chi doc du lieu va chay Router that.)\n");
  console.log(`  Du an : ${project.idiom.phrase}`);
  console.log(`  Che do: ${mode}`);
  console.log(`  Model video trong bang: ${allModels.length} (${providers.join(", ")})\n`);

  interface Row {
    sceneNumber: number;
    complexity: string;
    score: number;
    characters: number;
    duration: number;
    priority: string;
    provider: string;
    model: string;
    cost: number;
    reasons: string[];
    runwayBlocked: string;
  }

  const rows: Row[] = [];
  let startSeconds = 0;
  const active = project.scenes.filter((s) => !s.skipped);

  for (const scene of active) {
    const classified = classifyScene({
      duration: scene.duration,
      visualDescription: scene.visualDescription,
      characterAction: scene.characterAction,
      camera: scene.camera,
      // Dialogue is NOT passed: what characters say is not evidence about
      // what the picture contains. See complexity.extractSignals.
    });
    const priority = assignSpendPriority({
      sceneNumber: scene.sceneNumber,
      totalScenes: active.length,
      startSeconds,
      complexity: classified.complexity,
    });
    const characters = sceneCharacters(scene).present.length || 1;
    const sceneFlags = parseJson<string[]>(scene.providerFlagsJson, []);

    // Why Runway is or is not in the running for this scene, stated plainly.
    const runway = checkSuitability({
      provider: "runway",
      complexity: classified.complexity,
      characterCount: characters,
      sceneFlags,
    });

    let provider = "-";
    let model = "-";
    let cost = 0;
    try {
      const decision = routeScene(allModels, {
        type: "video",
        qualityMode: mode as "ECONOMY" | "BALANCED" | "QUALITY" | "CUSTOM",
        strategy: "AUTO",
        complexity: classified.complexity,
        spendPriority: priority.priority,
        durationSeconds: scene.duration,
        characterCount: characters,
        consistencyRequired: true,
        needs1080p: false,
        needsReferenceImage: true,
        keyframeAvailable: Boolean(scene.imagePath),
        sceneFlags,
        budgetRemaining: 999,
        usage: { seconds: scene.duration, jobs: 1 },
        availableProviders: providers,
      });
      provider = decision.provider;
      model = decision.modelId;
      cost = decision.estimatedCost;
    } catch (err) {
      provider = err instanceof RoutingError ? "KHONG DINH TUYEN DUOC" : "LOI";
      model = err instanceof Error ? err.message.slice(0, 60) : "";
    }

    rows.push({
      sceneNumber: scene.sceneNumber,
      complexity: classified.complexity,
      score: classified.score,
      characters,
      duration: scene.duration,
      priority: priority.priority,
      provider,
      model,
      cost,
      reasons: classified.reasons,
      runwayBlocked: runway.allowed ? "" : runway.reason,
    });
    startSeconds += scene.duration;
  }

  // ---- per scene ---------------------------------------------------------
  console.log("--- 1. TUNG CANH ---\n");
  console.log("  Canh  Do kho  Diem  NV  Dai   Uu tien  Nha cung cap / model            Chi phi");
  for (const r of rows) {
    console.log(
      `  ${String(r.sceneNumber).padStart(4)}  ${r.complexity.padEnd(6)}  ` +
        `${fmt(r.score, 1).padStart(4)}  ${String(r.characters).padStart(2)}  ` +
        `${fmt(r.duration, 1).padStart(4)}s ${r.priority.padEnd(8)} ` +
        `${`${r.provider}/${r.model}`.padEnd(31)} $${fmt(r.cost)}`,
    );
    if (r.reasons.length > 0) {
      console.log(`        vi: ${r.reasons.join("; ")}`);
    }
    if (r.runwayBlocked) {
      console.log(`        Runway bi loai: ${r.runwayBlocked}`);
    }
  }

  // ---- which signals actually fired --------------------------------------
  //
  // Printed as a grid so a score can be audited rather than trusted. Every
  // column here comes from a VISUAL field; dialogue is not read at all.
  console.log("");
  console.log("--- 1b. TIN HIEU HINH ANH THUC SU KICH HOAT ---");
  console.log("");
  console.log(
    "  Canh  NV  Tay  Vat  Vat-nho  Day-dac  Vat-ly  Camera  Chu  Che  Movers",
  );
  for (const scene of active) {
    const sig = extractSignals({
      duration: scene.duration,
      visualDescription: scene.visualDescription,
      characterAction: scene.characterAction,
      camera: scene.camera,
      characters: sceneCharacters(scene).present,
    });
    const yn = (v: boolean) => (v ? " CO " : "  . ");
    console.log(
      `  ${String(scene.sceneNumber).padStart(4)}  ${String(sig.characterCount).padStart(2)} ` +
        `${yn(sig.handInteraction)} ${yn(sig.objectInteraction)} ` +
        `${yn(sig.repeatedSmallObjects).padStart(7)}  ` +
        `${yn(sig.environmentComplex).padStart(6)}   ` +
        `${yn(sig.complexPhysics).padStart(5)}  ` +
        `${yn(sig.cameraMotion).padStart(5)}  ` +
        `${yn(sig.textInFrame)} ${yn(sig.occlusion)} ` +
        `${String(sig.independentMovers).padStart(5)}`,
    );
  }
  console.log("");
  console.log(
    "  (Vat-nho = nhieu vat the nho lap lai. Day-dac = boi canh nhieu chi tiet.)",
  );
  console.log("  (Khong doc dialogue - chi doc visualDescription/action/camera.)");

  // ---- distribution ------------------------------------------------------
  const counts = { LOW: 0, MEDIUM: 0, HIGH: 0 } as Record<string, number>;
  for (const r of rows) counts[r.complexity] = (counts[r.complexity] ?? 0) + 1;

  console.log("\n--- 2. PHAN BO DO KHO ---\n");
  for (const level of ["LOW", "MEDIUM", "HIGH"]) {
    console.log(`  ${level.padEnd(7)}: ${counts[level] ?? 0} canh`);
  }

  // ---- cost comparison ---------------------------------------------------
  //
  // The comparison that justifies per-scene routing: what it costs against
  // putting every scene through the strongest model available.
  const routedTotal = rows.reduce((s, r) => s + r.cost, 0);

  const sora = allModels.find((m) => m.modelId === "sora-2:720x1280");
  let soraTotal = 0;
  if (sora) {
    for (const r of rows) {
      const { size } = splitModelSize(sora.modelId);
      const seconds = billedVideoSeconds({
        provider: sora.provider,
        size,
        requestedSeconds: r.duration,
        hasKeyframe: true,
      });
      soraTotal += costForModel(sora, { seconds, jobs: 1 });
    }
  }

  // A third figure, to explain the second.
  //
  // Runway sells 5- and 10-second clips only, so a 3-second scene is billed as
  // 5. Against Sora's per-second rate that turns a headline 37.5% saving on a
  // 4-second clip into 17% on a 3-second one - and most scenes here are 3
  // seconds. The ceiling below is what routing would save if suitability let
  // every scene go to Runway, which is the honest upper bound.
  const runway = allModels.find((m) => m.modelId === "gen4_turbo:720x1280");
  let runwayTotal = 0;
  if (runway) {
    for (const r of rows) {
      const { size } = splitModelSize(runway.modelId);
      const seconds = billedVideoSeconds({
        provider: runway.provider,
        size,
        requestedSeconds: r.duration,
        hasKeyframe: true,
      });
      runwayTotal += costForModel(runway, { seconds, jobs: 1 });
    }
  }

  console.log("\n--- 3. SO SANH CHI PHI ---\n");
  console.log(`  Dinh tuyen theo canh : $${fmt(routedTotal)}`);
  console.log(`  Toan bo dung Sora-2  : $${fmt(soraTotal)}`);
  console.log(`  Toan bo dung Runway  : $${fmt(runwayTotal)}  <- tran ly thuyet, KHONG an toan`);

  console.log("\n  Gia tung canh neu ep dung mot nha cung cap:");
  console.log("  Canh  Dai    Sora-2    Runway   (Runway tinh tien toi thieu 5s)");
  for (const r of rows) {
    const rwSec = billedVideoSeconds({
      provider: "runway",
      size: "720x1280",
      requestedSeconds: r.duration,
      hasKeyframe: true,
    });
    const soraCost = sora ? costForModel(sora, { seconds: r.duration, jobs: 1 }) : 0;
    const rwCost = runway ? costForModel(runway, { seconds: rwSec, jobs: 1 }) : 0;
    console.log(
      `  ${String(r.sceneNumber).padStart(4)}  ${fmt(r.duration, 1).padStart(4)}s  ` +
        `$${fmt(soraCost)}  $${fmt(rwCost)}  (tinh ${rwSec}s)`,
    );
  }
  const saved = soraTotal - routedTotal;
  const pct = soraTotal > 0 ? (saved / soraTotal) * 100 : 0;
  console.log(
    `  Tiet kiem            : $${fmt(saved)}  (${saved >= 0 ? "" : "-"}${fmt(Math.abs(pct), 1)}%)`,
  );

  const spent = await prisma.costEntry.aggregate({
    where: { estimated: false, provider: { not: "mock" } },
    _sum: { amount: true },
  });
  console.log(`\n  Da chi that (toan he thong): $${fmt(spent._sum.amount ?? 0, 6)}`);
  console.log("\n  (Khong co lenh goi API nao trong script nay.)\n");
}

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
