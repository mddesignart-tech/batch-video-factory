import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { round } from "@/lib/utils";
import { sceneCharacters } from "@/domain/scene-characters";
import { recommendAuthorization, VI_COST_BASIS } from "@/domain/cost-basis";
import { decideMotion, keyframeRequired } from "@/domain/local-motion";
import type { Complexity, QualityMode, SpendPriority } from "@/domain/enums";
import {
  estimateProject,
  shouldEvaluateQuality,
  shouldGenerateKeyframe,
  type PlannedSceneInput,
} from "@/services/cost-estimator";
import { REFERENCE_SCENE_PROFILE } from "@/services/batch-planner";
import { productionProviderNames } from "@/services/provider-health";
import { spendStatus } from "@/services/spend-guard";
import { speechTextFor } from "@/services/generation";
import { peekCreateToken } from "@/services/create-token";

/**
 * Dry-run production cost audit for ONE video.
 *
 * Reads the registry and the ledger, routes every stage, prints the money, and
 * contacts nobody. There is no code path in this file that can POST anything -
 * it imports the estimator, never a provider adapter.
 *
 * It exists because the batch page's estimate was being computed from MOCK
 * prices whenever mock mode was on, and displayed as a forecast of real
 * spending. This prices the same work against real vendors at list prices, so
 * the two can be compared side by side.
 *
 *   npx tsx scripts/production-estimate.ts --idiom "Break a leg" --mode ECONOMY
 */

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const money = (n: number, d = 6) => `$${n.toFixed(d)}`;
const pad = (s: string, n: number) => s.padEnd(n);

async function main(): Promise<void> {
  const idiomPhrase = arg("idiom", "Break a leg");
  const mode = arg("mode", "ECONOMY").toUpperCase() as QualityMode;
  /**
   * Price every AI scene against ONE named model, bypassing the lifecycle gate.
   *
   * A manual pin is the existing mechanism for reaching a PIN_ONLY or
   * DEPRECATED model, and it is the right one here: this is an audit asking
   * "what WOULD this cost on Sora", not a request to route there. Nothing about
   * this flag makes the model auto-routable for a real run.
   *
   *   --assume-video "openai/sora-2:720x1280"
   */
  const assumeVideo = arg("assume-video", "");

  console.log("=".repeat(78));
  console.log("  DU TOAN CHAY THAT - 1 VIDEO  (DRY RUN, KHONG GOI API)");
  console.log("=".repeat(78));

  const token = await peekCreateToken();
  console.log(`  AI_MOCK_MODE         : ${isMockMode()}`);
  console.log(`  CREATE_ATTEMPT_TOKEN : ${token ? "CO (!!)" : "0"}`);
  console.log(`  Che do               : ${mode}`);

  const providers = await productionProviderNames();
  console.log(`  Provider thuc te     : ${providers.join(", ") || "(khong co)"}`);
  if (providers.length === 0) {
    console.log("\n  KHONG co nha cung cap that nao duoc cau hinh. Khong the du toan.");
    return;
  }

  // ---- scenes: the real script when one exists, else the reference profile --
  const idiom = await prisma.idiom.findFirst({
    where: { phrase: { contains: idiomPhrase } },
  });
  if (!idiom) {
    console.log(`\n  Khong tim thay thanh ngu "${idiomPhrase}".`);
    return;
  }

  const project = await prisma.project.findFirst({
    where: { idiomId: idiom.id, scriptJson: { not: null } },
    orderBy: { createdAt: "desc" },
    include: { scenes: { where: { skipped: false }, orderBy: { sceneNumber: "asc" } } },
  });

  const usingRealScript = Boolean(project && project.scenes.length > 0);
  const scenes: PlannedSceneInput[] = usingRealScript
    ? project!.scenes.map((scene) => ({
        sceneNumber: scene.sceneNumber,
        duration: scene.duration,
        complexity: scene.complexity as Complexity,
        spendPriority: scene.spendPriority as SpendPriority,
        characterCount: sceneCharacters(scene).present.length || 1,
        speechText: speechTextFor(scene),
      }))
    : REFERENCE_SCENE_PROFILE.map((s) => ({ ...s }));

  if (assumeVideo) {
    const at = assumeVideo.indexOf("/");
    const pinProvider = assumeVideo.slice(0, at);
    const pinModel = assumeVideo.slice(at + 1);
    for (const scene of scenes) {
      scene.manualVideoProvider = pinProvider;
      scene.manualVideoModel = pinModel;
    }
    console.log(`  GIA DINH             : ep moi canh video ve ${assumeVideo}`);
    console.log(`                         (chi de tinh toan - KHONG lam no tro lai auto-route)`);
  }

  console.log(`  Thanh ngu            : ${idiom.phrase}`);
  console.log(
    `  Nguon canh           : ${
      usingRealScript ? "KICH BAN THAT (da co)" : "KICH BAN MAU 6 canh (chua co that)"
    }`,
  );
  console.log(`  So canh              : ${scenes.length}`);

  const models = await prisma.modelRegistry.findMany({ where: { enabled: true } });

  // A ceiling high enough not to distort routing. This audit asks what the work
  // costs, not what fits a budget - clamping here would silently downgrade
  // models and report a cheaper video than the one that would be made.
  const estimate = estimateProject({
    scenes,
    models,
    qualityMode: mode,
    strategy: "AUTO",
    maxBudget: 1000,
    availableProviders: providers,
    needs1080p: mode === "QUALITY",
  });

  console.log(`  Co so gia            : ${VI_COST_BASIS[estimate.costBasis]}`);

  // ------------------------------------------------------------------ TEXT --
  const textModel = models
    .filter((m) => m.type === "text" && providers.includes(m.provider))
    .sort((a, b) => a.price - b.price)[0];

  console.log("\n" + "-".repeat(78));
  console.log("  TEXT AI");
  console.log("-".repeat(78));
  if (textModel) {
    console.log(`    provider        : ${textModel.provider}`);
    console.log(`    model           : ${textModel.modelId}`);
    console.log(`    gia             : ${money(textModel.price)}/1k token vao, ${money(textModel.priceOutput)}/1k token ra`);
    console.log(`    so lan goi      : 3  (kich ban + cham diem + metadata)`);
    console.log(`    du toan         : ${money(estimate.breakdown.text)}`);
  } else {
    console.log("    KHONG co text model nao kha dung.");
  }

  // ----------------------------------------------------------------- IMAGE --
  const keyframeScenes = scenes.filter((scene) => {
    const motion = decideMotion({
      qualityMode: mode,
      complexity: scene.complexity,
      spendPriority: scene.spendPriority,
      characterCount: scene.characterCount,
    });
    return keyframeRequired(
      motion.source,
      shouldGenerateKeyframe(mode, scene.complexity, scene.characterCount),
    );
  });
  const imageDecision = estimate.scenes.find((p) => p.image !== null)?.image ?? null;

  console.log("\n" + "-".repeat(78));
  console.log("  IMAGE AI");
  console.log("-".repeat(78));
  console.log(`    so anh          : ${keyframeScenes.length}`);
  if (imageDecision) {
    console.log(`    provider/model  : ${imageDecision.provider}/${imageDecision.modelId}`);
    console.log(
      `    gia moi anh     : ${money(
        keyframeScenes.length > 0 ? estimate.breakdown.image / keyframeScenes.length : 0,
      )}`,
    );
  } else {
    console.log("    KHONG co image model nao kha dung.");
  }
  console.log(`    du toan         : ${money(estimate.breakdown.image)}`);

  // ----------------------------------------------------------------- VIDEO --
  console.log("\n" + "-".repeat(78));
  console.log("  VIDEO  (tung canh)");
  console.log("-".repeat(78));
  console.log(
    `    ${pad("Canh", 6)}${pad("Nguon", 14)}${pad("Do kho", 9)}${pad("Provider", 10)}` +
      `${pad("Model", 26)}${pad("Giay tinh tien", 16)}Du toan`,
  );

  let aiScenes = 0;
  let localScenes = 0;
  for (const plan of estimate.scenes) {
    const isLocal = plan.motionSource === "LOCAL_MOTION";
    if (isLocal) localScenes += 1;
    else aiScenes += 1;

    let billed = "-";
    let durationNote = "";
    if (plan.video && plan.duration_plan) {
      const d = plan.duration_plan;
      billed = `${d.willSend}s (xin ${d.requested}s)`;
      if (d.status === "DURATION_TRANSFORM_REQUIRED") {
        billed += " !!";
        durationNote = d.reason;
      } else if (d.status === "PADDED") {
        durationNote = d.reason;
      }
    }

    console.log(
      `    ${pad(String(plan.sceneNumber), 6)}` +
        `${pad(isLocal ? "LOCAL_MOTION" : "VIDEO_AI", 14)}` +
        `${pad(plan.complexity, 9)}` +
        `${pad(plan.video?.provider ?? "ffmpeg", 10)}` +
        `${pad(plan.video?.modelId ?? "local-motion", 26)}` +
        `${pad(billed, 16)}` +
        `${money(plan.video?.estimatedCost ?? 0)}` +
        (plan.needsProvider ? "   <-- NEEDS_PROVIDER" : ""),
    );
    if (plan.needsProvider) {
      console.log(`           NEEDS_PROVIDER: ${plan.needsProvider}`);
    }
    if (durationNote) {
      console.log(`           DURATION: ${durationNote}`);
    }
  }
  console.log(`    ${"-".repeat(70)}`);
  console.log(`    LOCAL_MOTION: ${localScenes} canh ($0)   VIDEO_AI: ${aiScenes} canh`);
  console.log(`    du toan video   : ${money(estimate.breakdown.video)}`);

  // ----------------------------------------------------------------- VOICE --
  const speechChars = scenes.reduce((n, s) => n + s.speechText.trim().length, 0);
  const voiceDecision = estimate.scenes.find((p) => p.voice !== null)?.voice ?? null;

  console.log("\n" + "-".repeat(78));
  console.log("  VOICE AI");
  console.log("-".repeat(78));
  console.log(`    so ky tu        : ${speechChars}`);
  if (voiceDecision) {
    console.log(`    provider/model  : ${voiceDecision.provider}/${voiceDecision.modelId}`);
  } else {
    console.log("    KHONG co voice model nao kha dung.");
  }
  console.log(`    du toan         : ${money(estimate.breakdown.voice)}`);

  // --------------------------------------------------------------- QUALITY --
  const wantsQuality = scenes.some((s) => shouldEvaluateQuality(mode, s.spendPriority));
  console.log("\n" + "-".repeat(78));
  console.log("  CHAM DIEM CHAT LUONG");
  console.log("-".repeat(78));
  console.log(`    co chay khong   : ${wantsQuality ? "co" : "khong (che do nay bo qua)"}`);
  console.log(`    du toan         : ${money(estimate.breakdown.quality)}`);

  // ---------------------------------------------------------------- RENDER --
  console.log("\n" + "-".repeat(78));
  console.log("  RENDER + PHU DE");
  console.log("-".repeat(78));
  console.log("    FFmpeg tai may, khong goi API   du toan: $0.000000");

  // ----------------------------------------------------------------- TOTAL --
  const subtotal = round(
    estimate.breakdown.text +
      estimate.breakdown.image +
      estimate.breakdown.video +
      estimate.breakdown.voice +
      estimate.breakdown.quality,
    6,
  );

  console.log("\n" + "=".repeat(78));
  console.log("  TONG");
  console.log("=".repeat(78));
  console.log(`    TEXT            : ${money(estimate.breakdown.text)}`);
  console.log(`    IMAGE           : ${money(estimate.breakdown.image)}`);
  console.log(`    VIDEO           : ${money(estimate.breakdown.video)}`);
  console.log(`    VOICE           : ${money(estimate.breakdown.voice)}`);
  console.log(`    QUALITY         : ${money(estimate.breakdown.quality)}`);
  console.log(`    RENDER          : ${money(0)}`);
  console.log(`    ${"-".repeat(40)}`);
  console.log(`    Cong             : ${money(subtotal)}`);
  console.log(`    Du phong tao lai : ${money(estimate.breakdown.retries)}`);
  console.log(`    TOTAL            : ${money(estimate.breakdown.total)}`);

  const cap = await spendStatus();
  const rec = recommendAuthorization(estimate.breakdown.total, cap.remaining);
  console.log("\n" + "=".repeat(78));
  console.log("  DE XUAT HAN MUC DUYET CHI");
  console.log("=".repeat(78));
  console.log(`    Estimated        : ${money(rec.estimated)}`);
  console.log(`    Safety margin    : ${(rec.safetyMarginPct * 100).toFixed(0)}%`);
  console.log(`    Recommended max  : ${money(rec.recommended)}`);
  if (rec.clampedByGlobalCap) {
    console.log(`    !! Bi ep xuong vi han muc tong chi con ${money(cap.remaining)}`);
  }
  console.log(`    Han muc tong     : da chi ${money(cap.spent)} / ${money(cap.cap, 2)}, con ${money(cap.remaining)}`);
  console.log("\n    KHONG tu duyet. Nguoi dung phai tu nhap so va bam duyet.");

  if (estimate.needsProvider.length > 0) {
    console.log("\n" + "=".repeat(78));
    console.log("  NEEDS_PROVIDER");
    console.log("=".repeat(78));
    for (const line of estimate.needsProvider) console.log(`    ${line}`);
  }
  if (estimate.errors.length > 0) {
    console.log("\n  LOI DINH TUYEN:");
    for (const line of estimate.errors) console.log(`    ${line}`);
  }

  console.log("\n  CHI PHI API CUA LAN CHAY NAY: $0.00 (chi doc du lieu)\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
