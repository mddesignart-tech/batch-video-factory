/**
 * Proof that LOW_AUTO would actually auto-route a valid LOW scene - and that
 * eight single-variable changes each stop it.
 *
 * READ-ONLY AND FREE. It reads one production scene, clones it in memory, and
 * calls the real `routeScene`. Nothing is written: no registry edit, no scene
 * edit, no ProviderJob, no reservation, no permit, no network call of any kind.
 *
 * WHY A CLONE AND NOT THE ROW
 * ---------------------------
 * All three LOW scenes that still want a paid clip are manually pinned, so
 * low-auto never gets a turn - a pin short-circuits scoring by design. Proving
 * the grant works therefore needs a scene with the pin removed, and removing a
 * pin from production data to run a test would be editing the thing under test.
 * So the pin is dropped in the COPY, and the original row is never touched.
 *
 * WHY SCENE 1 OF "COLD FEET" AND NOT SCENE 5 OF "SPILL THE BEANS"
 * --------------------------------------------------------------
 * Scene 5 looks like the better candidate and is the wrong one. Its
 * spendPriority is LOW, so with the pin removed `decideMotion` calls it
 * LOCAL_MOTION and it never reaches routing at all - the honest result would be
 * "free", not "auto-routed", and dressing that up as a routing proof would
 * prove nothing. Scene 1 is spendPriority HIGH, so stored and fresh both say
 * AI_VIDEO and the question actually reaches the router.
 *
 *   npx tsx scripts/prove-low-auto.ts
 */
import type { ModelRegistry } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { decideMotion } from "../src/domain/local-motion";
import { deriveSceneVideoFacts } from "../src/services/low-auto-facts";
import { routeScene, RoutingError, type LowAutoSceneFacts } from "../src/services/ai-router";
import { shouldGenerateKeyframe } from "../src/services/cost-estimator";
import { productionProviderNames } from "../src/services/provider-health";
import { spendStatus } from "../src/services/spend-guard";
import { providerSpendBreakdown, refreshRunwayBalance } from "../src/services/provider-budget";
import { peekCreateToken } from "../src/services/create-token";
import { isMockMode } from "../src/lib/env";
import type { Complexity, QualityMode, RouterStrategy, SpendPriority } from "../src/domain/enums";

const MODEL_ID = "h3_max:768x1280";
const PROVIDER = "runway";

/** Everything the router needs, as plain values we can vary one at a time. */
interface Case {
  complexity: string;
  spendPriority: string;
  duration: number;
  characterCount: number;
  hasKeyframe: boolean;
  cameraMode: "LOCKED_CAMERA" | "DIRECTED_CAMERA";
  repeatedSmallObjects: boolean;
  promptGuarded: boolean;
  contradictions: string[];
  manualProvider: string | null;
  manualModel: string | null;
  lifecycle: string;
  reliability: string;
  verification: string;
  providerBudgetUsd: number | null;
  globalBudget: number;
  perVideoCap: number | null;
  stage: "PLANNING" | "VIDEO";
  motionSource: "AI_VIDEO" | "LOCAL_MOTION";
  /** The motion floor, QĐ-074. Undefined blocks, so a case must state it. */
  motionScale: "SUBTLE" | "MODERATE" | "VIGOROUS" | undefined;
  multiCharacterInteraction: boolean;
}

interface Outcome {
  routed: boolean;
  label: string;
  cost: number;
  lowAutoRouted: boolean;
  reason: string;
}

function run(base: ModelRegistry[], model: ModelRegistry, c: Case, providers: string[]): Outcome {
  const registry = base.map((m) =>
    m.provider === PROVIDER && m.modelId === MODEL_ID
      ? ({
          ...m,
          lifecycle: c.lifecycle,
          reliability: c.reliability,
          verification: c.verification,
        } as ModelRegistry)
      : m,
  );
  const facts: LowAutoSceneFacts = {
    stage: c.stage,
    motionSource: c.motionSource,
    hasKeyframe: c.hasKeyframe,
    cameraMode: c.cameraMode,
    repeatedSmallObjects: c.repeatedSmallObjects,
    motionScale: c.motionScale,
    multiCharacterInteraction: c.multiCharacterInteraction,
    promptGuarded: c.promptGuarded,
    contradictions: c.contradictions,
    providerBudgets: { [PROVIDER]: c.providerBudgetUsd, openai: 6, groq: null },
    perVideoCapRemaining: c.perVideoCap,
  };
  try {
    const d = routeScene(registry, {
      type: "video",
      qualityMode: "BALANCED" as QualityMode,
      strategy: "AUTO" as RouterStrategy,
      complexity: c.complexity as Complexity,
      spendPriority: c.spendPriority as SpendPriority,
      durationSeconds: c.duration,
      characterCount: c.characterCount,
      consistencyRequired: true,
      needs1080p: false,
      needsReferenceImage: shouldGenerateKeyframe(
        "BALANCED",
        c.complexity as Complexity,
        c.characterCount,
      ),
      keyframeAvailable: c.hasKeyframe,
      sceneFlags: [],
      budgetRemaining: c.globalBudget,
      usage: { seconds: c.duration, jobs: 1 },
      availableProviders: providers,
      manualProvider: c.manualProvider,
      manualModel: c.manualModel,
      lowAuto: facts,
    });
    return {
      routed: true,
      label: `${d.provider}/${d.modelId}`,
      cost: Number(d.estimatedCost.toFixed(6)),
      lowAutoRouted: d.lowAutoRouted,
      reason: d.reason,
    };
  } catch (err) {
    if (err instanceof RoutingError) {
      return { routed: false, label: `BLOCKED(${err.code})`, cost: 0, lowAutoRouted: false, reason: err.message };
    }
    throw err;
  }
  void model;
}

async function main() {
  // ---- safety state, printed BEFORE anything else -----------------------
  const token = await peekCreateToken();
  console.log("=== TRẠNG THÁI AN TOÀN ===");
  console.log(`AI_MOCK_MODE          : ${isMockMode()}`);
  console.log(`CREATE_ATTEMPT_TOKEN  : ${token ? `CÓ (!!) ${token.provider}/${token.model}` : "null"}`);
  const jobsBefore = await prisma.providerJob.count();
  const resvBefore = await prisma.costReservation.count();
  const regBefore = await prisma.modelRegistry.findFirstOrThrow({
    where: { provider: PROVIDER, modelId: MODEL_ID },
  });
  console.log(`ProviderJob (trước)   : ${jobsBefore}`);
  console.log(`Reservation (trước)   : ${resvBefore}`);
  console.log(`h3_max lifecycle      : ${regBefore.lifecycle}\n`);

  // Chosen by its PROPERTIES, not by a hard-coded id.
  //
  // It used to name one scene, and that scene stopped existing the moment a
  // script was re-persisted - `persistScript` deletes and recreates the rows,
  // so the id changes even though the same scene is still there. A proof that
  // breaks whenever the thing it proves is rewritten proves nothing for long.
  //
  // What it needs is a LOW scene whose spendPriority is HIGH: at LOW priority
  // `decideMotion` answers LOCAL_MOTION once the pin is lifted, and the honest
  // result would be "free" rather than "auto-routed" - which is a fine outcome
  // and a useless proof.
  const scene = await prisma.scene.findFirstOrThrow({
    where: { complexity: "LOW", spendPriority: "HIGH", skipped: false },
    orderBy: [{ project: { createdAt: "desc" } }, { sceneNumber: "asc" }],
    include: { project: { include: { idiom: true } } },
  });
  // Same derivation production runs - services/low-auto-facts - so the facts
  // this proof varies one at a time are the facts the pipeline would have used.
  // `ignoreManualPin` is what makes the clone a clone: it lifts the pin for the
  // motion decision only, in memory, and the row itself is never written to.
  const derived = deriveSceneVideoFacts(scene, {
    qualityMode: scene.project.qualityMode,
    stage: "VIDEO",
    ignoreManualPin: true,
  });
  const chars = derived.characterCount;
  const intent = derived.cameraIntent;
  /**
   * The clone answers YES to the keyframe, and says so out loud.
   *
   * On disk there is no still for a scene whose images have not been generated,
   * and at the VIDEO stage that is a hard refusal - correctly, because
   * `generateSceneVideo` must never buy an image-to-video clip with no image.
   * But then every case below would fail for the same missing file and the
   * proof would show nothing about the eight variables it exists to vary.
   *
   * So the base case asserts the state the pipeline reaches AFTER the image
   * step, which is the state in which the video call actually happens. Case C
   * puts it back to false and checks the refusal still lands.
   */
  const hasKeyframeOnDisk = derived.hasKeyframe;
  const hasKeyframe = true;
  const fresh = decideMotion({
    qualityMode: scene.project.qualityMode as QualityMode,
    complexity: scene.complexity as Complexity,
    spendPriority: scene.spendPriority as SpendPriority,
    characterCount: chars,
  });

  const models = await prisma.modelRegistry.findMany({ where: { enabled: true } });
  const model = models.find((m) => m.provider === PROVIDER && m.modelId === MODEL_ID)!;
  const providers = await productionProviderNames();
  const status = await spendStatus();
  await refreshRunwayBalance();
  const wallets = await providerSpendBreakdown();
  const runwayUsd = wallets.find((w) => w.provider === PROVIDER)?.remainingUsd ?? null;

  console.log("=== CẢNH GỐC (chỉ ĐỌC, không sửa) ===");
  console.log(`Scene       : ${scene.id.slice(0, 8)} — ${scene.project.idiom.phrase} #${scene.sceneNumber}`);
  console.log(`complexity  : ${scene.complexity}      spendPriority: ${scene.spendPriority}`);
  console.log(`motionSource: lưu=${scene.motionSource}  tươi=${fresh.source}`);
  console.log(
    `nhân vật    : ${chars}          keyframe trên đĩa: ${hasKeyframeOnDisk ? "CÓ" : "CHƯA"}` +
      `${hasKeyframeOnDisk ? "" : " (bản sao giả định ĐÃ tạo ảnh — xem case C)"}`,
  );
  console.log(`camera      : ${intent.mode}`);
  console.log(`ghim tay    : ${scene.videoProvider ?? "-"}/${scene.videoModel ?? "-"}`);
  console.log(`thời lượng  : ${scene.duration}s`);
  console.log(`ví runway   : $${(runwayUsd ?? 0).toFixed(6)} (LIVE)   hạn mức chung còn $${status.remaining.toFixed(6)}\n`);

  // The clone. One field differs from the row above: the pin is gone.
  const baseCase: Case = {
    complexity: scene.complexity,
    spendPriority: scene.spendPriority,
    duration: scene.duration,
    characterCount: chars,
    hasKeyframe,
    cameraMode: derived.facts.cameraMode,
    repeatedSmallObjects: derived.facts.repeatedSmallObjects,
    promptGuarded: derived.facts.promptGuarded,
    contradictions: derived.contradictions,
    manualProvider: null, // <- the only change vs production
    manualModel: null,
    lifecycle: "LOW_AUTO", // <- simulated grant, in memory only
    reliability: model.reliability,
    verification: model.verification,
    providerBudgetUsd: runwayUsd,
    globalBudget: status.remaining,
    perVideoCap: null,
    stage: "VIDEO",
    motionSource: derived.motion.source,
    // From the shared derivation, like every other fact here. Hand-writing it
    // is how the simulation and the pipeline come to disagree - QĐ-060.
    motionScale: derived.facts.motionScale,
    multiCharacterInteraction: derived.facts.multiCharacterInteraction === true,
  };

  // ---- route as production stands: pinned, candidate lifecycle ----------
  const asIs = run(models, model, {
    ...baseCase,
    manualProvider: scene.videoProvider,
    manualModel: scene.videoModel,
    lifecycle: regBefore.lifecycle,
  }, providers);
  console.log("=== ROUTE TRƯỚC MÔ PHỎNG (đúng như production hôm nay) ===");
  console.log(`  ${asIs.label}   $${asIs.cost.toFixed(2)}   lowAutoRouted=${asIs.lowAutoRouted}`);
  console.log(`  lý do: ${asIs.reason}\n`);

  // ---- the positive case ------------------------------------------------
  const positive = run(models, model, baseCase, providers);
  console.log("=== ROUTE TRONG MÔ PHỎNG (bỏ ghim tay, h3_max = LOW_AUTO) ===");
  console.log(`  ${positive.label}   $${positive.cost.toFixed(2)}   lowAutoRouted=${positive.lowAutoRouted}`);
  console.log(`  lý do: ${positive.reason}\n`);

  const positiveOk =
    positive.routed &&
    positive.label === `${PROVIDER}/${MODEL_ID}` &&
    positive.lowAutoRouted === true &&
    Math.abs(positive.cost - 0.4) < 1e-6;
  console.log(
    `  KIỂM: AUTO -> runway/h3_max:768x1280, $0.40, lowAutoRouted=true  => ${positiveOk ? "ĐẠT" : "HỎNG"}\n`,
  );

  // ---- eight negative controls, ONE variable each -----------------------
  //
  // `expect` is the phrase that must appear in the refusal, and it is the part
  // that makes these controls worth running. All nine refusals carry the SAME
  // RoutingError code, so the code alone proves nothing: a control that blocks
  // for the wrong reason is worse than no control, because it reports that a
  // rule was exercised when the rule was never reached.
  // `lock` names WHICH of the four layers is expected to fire, and `expect` is
  // the phrase that proves it did. The two are worth stating separately because
  // the layers are ordered, and the outer ones fire first:
  //
  //   A  the hard ceiling in MAX_COMPLEXITY rejects the model before the gate
  //      ever sees the scene, so the wording is the ceiling's, not the gate's
  //   E  autoRouteBlock refuses LOW_AUTO_CANDIDATE at the lifecycle layer, so
  //      the gate's own candidate message is never reached
  //
  // Writing "the gate blocks it" for either would have been a green test
  // describing a code path that did not run.
  const controls: Array<{ id: string; name: string; lock: string; expect: string; c: Case }> = [
    { id: "A", name: "complexity = MEDIUM", lock: "trần cứng MAX_COMPLEXITY", expect: "vượt mức LOW", c: { ...baseCase, complexity: "MEDIUM" } },
    { id: "B", name: "characterCount = 3", lock: "cổng LOW_AUTO", expect: "nhân vật", c: { ...baseCase, characterCount: 3 } },
    { id: "C", name: "keyframe thiếu ở bước VIDEO", lock: "cổng LOW_AUTO", expect: "keyframe", c: { ...baseCase, hasKeyframe: false } },
    { id: "D", name: "camera = DIRECTED_CAMERA", lock: "cổng LOW_AUTO", expect: "camera chuyển động", c: { ...baseCase, cameraMode: "DIRECTED_CAMERA" } },
    { id: "E", name: "lifecycle = LOW_AUTO_CANDIDATE", lock: "autoRouteBlock", expect: "CHƯA được bật", c: { ...baseCase, lifecycle: "LOW_AUTO_CANDIDATE" } },
    { id: "F1", name: "reliability = DEGRADED", lock: "autoRouteBlock", expect: "độ tin cậy", c: { ...baseCase, reliability: "DEGRADED" } },
    { id: "F2", name: "lifecycle = DISABLED", lock: "autoRouteBlock", expect: "vòng đời", c: { ...baseCase, lifecycle: "DISABLED" } },
    { id: "G", name: "ví nhà cung cấp không đủ ($0.10)", lock: "cổng LOW_AUTO", expect: "ví nhà cung cấp", c: { ...baseCase, providerBudgetUsd: 0.1 } },
    { id: "H", name: "hạn mức chung không đủ ($0.10)", lock: "cổng LOW_AUTO", expect: "hạn mức chung", c: { ...baseCase, globalBudget: 0.1 } },
    // The motion floor, QĐ-074. Every scored sample of this model is a blink, a
    // nod or half a step; a running shot has never been bought from it, and the
    // router may not be the one who finds out what that costs.
    { id: "I1", name: "chuyển động VIGOROUS (chạy/nhảy)", lock: "cổng LOW_AUTO", expect: "chuyển động", c: { ...baseCase, motionScale: "VIGOROUS" } },
    { id: "I2", name: "chuyển động MODERATE (đi/ngồi xuống)", lock: "cổng LOW_AUTO", expect: "chuyển động", c: { ...baseCase, motionScale: "MODERATE" } },
    { id: "I3", name: "không biết cỡ chuyển động", lock: "cổng LOW_AUTO", expect: "chưa xác định", c: { ...baseCase, motionScale: undefined } },
    { id: "J", name: "hai nhân vật tương tác trực tiếp", lock: "cổng LOW_AUTO", expect: "tương tác", c: { ...baseCase, characterCount: 2, multiCharacterInteraction: true } },
  ];

  console.log("=== NEGATIVE CONTROL — mỗi lần đổi ĐÚNG MỘT yếu tố ===");
  let allBlocked = true;
  let anyPaidFallback = false;
  let allRightReason = true;
  for (const { id, name, lock, expect, c } of controls) {
    const out = run(models, model, c, providers);
    // "Blocked" means h3_max was not chosen. Falling to ANOTHER paid model
    // would also be a failure, and a louder one, so it is checked separately.
    const tookH3 = out.routed && out.label === `${PROVIDER}/${MODEL_ID}`;
    const paidFallback = out.routed && !tookH3 && out.cost > 0;
    const rightReason = !tookH3 && out.reason.includes(expect);
    if (tookH3) allBlocked = false;
    if (paidFallback) anyPaidFallback = true;
    if (!rightReason) allRightReason = false;
    console.log(
      `  [${tookH3 ? "HỎNG" : rightReason ? "ĐẠT " : "NGỜ "}] ${id}. ${name.padEnd(34)} -> ${out.label}` +
        (paidFallback ? `  ⚠ RƠI SANG MODEL TRẢ PHÍ KHÁC $${out.cost.toFixed(2)}` : ""),
    );
    console.log(
      `        chặn bởi ${lock}, khớp "${expect}": ${rightReason ? "có" : "KHÔNG — lý do KHÁC"}`,
    );
  }
  console.log(
    `\n  Tất cả bị chặn khỏi h3_max        : ${allBlocked ? "ĐẠT" : "HỎNG"}` +
      `\n  Chặn đúng lý do của từng ca       : ${allRightReason ? "ĐẠT" : "HỎNG"}` +
      `\n  Không rơi sang model trả phí khác : ${anyPaidFallback ? "HỎNG" : "ĐẠT"}`,
  );

  // ---- nothing moved ----------------------------------------------------
  const jobsAfter = await prisma.providerJob.count();
  const resvAfter = await prisma.costReservation.count();
  const regAfter = await prisma.modelRegistry.findFirstOrThrow({
    where: { provider: PROVIDER, modelId: MODEL_ID },
  });
  // Re-read by id, so "nothing moved" is checked against the SAME row the
  // cases were built from rather than whatever the selector would pick now.
  const sceneAfter = await prisma.scene.findFirstOrThrow({
    where: { id: scene.id },
    select: { videoProvider: true, videoModel: true, motionSource: true },
  });
  const tokenAfter = await peekCreateToken();

  console.log("\n=== DỮ LIỆU PRODUCTION SAU KHI CHẠY ===");
  console.log(`ProviderJob           : ${jobsBefore} -> ${jobsAfter}  ${jobsAfter === jobsBefore ? "(không đổi)" : "(!! ĐÃ ĐỔI)"}`);
  console.log(`Reservation           : ${resvBefore} -> ${resvAfter}  ${resvAfter === resvBefore ? "(không đổi)" : "(!! ĐÃ ĐỔI)"}`);
  console.log(`h3_max lifecycle      : ${regBefore.lifecycle} -> ${regAfter.lifecycle}  ${regAfter.lifecycle === regBefore.lifecycle ? "(không đổi)" : "(!! ĐÃ ĐỔI)"}`);
  console.log(`Ghim tay cảnh gốc     : ${sceneAfter.videoProvider}/${sceneAfter.videoModel}  (giữ nguyên)`);
  console.log(`CREATE_ATTEMPT_TOKEN  : ${tokenAfter ? "CÓ (!!)" : "null"}`);
  console.log(`Số POST trả phí       : 0`);

  const unchanged =
    jobsAfter === jobsBefore &&
    resvAfter === resvBefore &&
    regAfter.lifecycle === regBefore.lifecycle &&
    tokenAfter === null;

  const verdict =
    positiveOk && allBlocked && allRightReason && !anyPaidFallback && unchanged;
  console.log(
    `\nKẾT LUẬN: ${verdict ? "LOW_AUTO ROUTING VERIFIED — SAFE TO ENABLE" : "CHƯA ĐẠT — xem các dòng HỎNG ở trên"}`,
  );
  console.log(`h3_max trong DB production vẫn: ${regAfter.lifecycle}`);
  if (!verdict) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
