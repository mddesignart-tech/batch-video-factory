/**
 * "If LOW_AUTO were switched on, what would the router actually do?"
 *
 * FREE and read-only. No network, no writes, no API of any kind. It runs the
 * same motion decision, the same camera classifier, the same guardrail composer
 * and the same eligibility gate that production would run - so the table it
 * prints is a simulation of a decision, not a guess about one.
 *
 * THE ORDER IS THE POINT
 * ----------------------
 * `decideMotion` runs FIRST and its LOCAL_MOTION verdict is final. A scene that
 * can be made for free stays free, even when it would sail through every paid
 * eligibility check. Low-auto exists to stop paid clips reaching the wrong
 * model, not to find new things to buy - and a preview that got that order
 * backwards would recommend spending money on work already done for nothing.
 *
 *   npx tsx scripts/dry-run-low-auto.ts
 */
import fs from "node:fs";
import { prisma } from "../src/lib/prisma";
import { classifyCameraIntent } from "../src/domain/camera-intent";
import {
  applyCameraGuardrails,
  findPromptContradictions,
  RUNWAY_MAX_PROMPT_CHARS,
} from "../src/domain/video-prompt";
import { lowAutoEligibility, lowAutoFallback } from "../src/domain/low-auto";
import { decideMotion } from "../src/domain/local-motion";
import { extractSignals } from "../src/services/complexity";
import { sceneCharacters } from "../src/domain/scene-characters";
import { billedVideoSeconds } from "../src/domain/video-duration";
import { toAbsolute } from "../src/lib/paths";
import type { Complexity, QualityMode, SpendPriority } from "../src/domain/enums";

const CANDIDATE = "h3_max:768x1280";

interface Row {
  id: string;
  scene: number;
  idiom: string;
  current: string;
  keyframe: boolean;
  eligible: boolean;
  simulated: string;
  costBefore: number;
  costAfter: number;
  reason: string;
}

async function main() {
  const model = await prisma.modelRegistry.findFirst({
    where: { provider: "runway", modelId: CANDIDATE },
  });
  if (!model) throw new Error(`Không thấy ${CANDIDATE} trong registry.`);

  const { spendStatus } = await import("../src/services/spend-guard");
  const { providerSpendBreakdown } = await import("../src/services/provider-budget");
  const status = await spendStatus();
  const budgetRemaining = Math.max(0, status.cap - status.spent);
  // `remainingUsd` is null for a vendor that enforces its own quota. Kept as
  // null rather than coerced to 0: inventing a figure is exactly the fiction
  // the budget module refuses to produce, and the gate reads null as "not our
  // ledger to check" rather than as "no money left".
  const runway = (await providerSpendBreakdown()).find((r) => r.provider === "runway");
  const providerRemaining: number | null = runway?.remainingUsd ?? null;

  console.log("=== DRY-RUN: NẾU BẬT LOW_AUTO CHO h3_max ===");
  console.log("(không gọi API, không ghi gì, không tạo video)\n");
  console.log(`Model     : runway/${CANDIDATE}`);
  console.log(`  vòng đời: ${model.lifecycle}   xác minh: ${model.verification}   tin cậy: ${model.reliability}`);
  console.log(`Ngân sách : còn $${budgetRemaining.toFixed(6)} / $${status.cap.toFixed(2)}`);
  console.log(`Ví runway : ${providerRemaining === null ? "(nhà cung cấp tự tính)" : `$${providerRemaining.toFixed(6)}`}\n`);

  const scenes = await prisma.scene.findMany({
    where: { skipped: false },
    include: { project: { include: { idiom: true } } },
    orderBy: [{ projectId: "asc" }, { sceneNumber: "asc" }],
  });

  const rows: Row[] = [];
  let changedRoute = 0;
  let contradictionCount = 0;
  let unresolved = 0;

  for (const scene of scenes) {
    if (scene.complexity !== "LOW") continue;

    const chars = sceneCharacters(scene).present.length || 1;
    const signals = extractSignals(scene);
    const intent = classifyCameraIntent(scene);
    const guarded = applyCameraGuardrails(scene.videoPrompt, intent, RUNWAY_MAX_PROMPT_CHARS);
    const contradictions = findPromptContradictions(guarded.text);
    if (contradictions.length > 0) contradictionCount += 1;

    const hasKeyframe = Boolean(scene.imagePath) && fs.existsSync(toAbsolute(scene.imagePath ?? ""));

    // FIRST, and its answer is final.
    const motion = decideMotion({
      qualityMode: scene.project.qualityMode as QualityMode,
      complexity: scene.complexity as Complexity,
      spendPriority: scene.spendPriority as SpendPriority,
      characterCount: chars,
    });
    const localAllowed = motion.source === "LOCAL_MOTION" && hasKeyframe;

    const billed = billedVideoSeconds({
      provider: "runway",
      model: CANDIDATE,
      size: "768x1280",
      requestedSeconds: scene.duration,
      hasKeyframe,
    });
    const cost = Number((model.price * billed).toFixed(6));

    const verdict = lowAutoEligibility({
      complexity: scene.complexity,
      characterCount: chars,
      hasKeyframe,
      cameraMode: intent.mode,
      repeatedSmallObjects: signals.repeatedSmallObjects,
      modelLifecycle: model.lifecycle,
      modelReliability: model.reliability,
      promptGuarded: guarded.added.length > 0 || guarded.skipped.length > 0,
      contradictions,
      estimatedCost: cost,
      budgetRemaining,
      providerBudgetRemaining: providerRemaining,
    });

    const currentRoute = scene.motionSource === "LOCAL_MOTION" ? "LOCAL_MOTION" : "AI_VIDEO";
    const currentCost = scene.motionSource === "LOCAL_MOTION" ? 0 : 0;

    let simulated: string;
    let reason: string;
    if (motion.source === "LOCAL_MOTION") {
      // Free stays free. Full stop.
      simulated = "LOCAL_MOTION";
      reason = `giữ local — ${motion.reason}`;
    } else if (verdict.eligible) {
      simulated = `h3_max ($${cost.toFixed(2)})`;
      reason = "đủ mọi điều kiện";
    } else {
      const fb = lowAutoFallback(verdict, { localMotionAllowed: localAllowed });
      simulated = fb;
      reason = verdict.blockers.map((b) => b.message).join("; ");
      if (fb !== "LOCAL_MOTION") unresolved += 1;
    }

    const simCost = simulated.startsWith("h3_max") ? cost : 0;
    if (
      (currentRoute === "LOCAL_MOTION" && simulated.startsWith("h3_max")) ||
      (currentRoute === "AI_VIDEO" && simulated === "LOCAL_MOTION")
    ) {
      changedRoute += 1;
    }

    rows.push({
      id: scene.id.slice(0, 8),
      scene: scene.sceneNumber,
      idiom: scene.project.idiom.phrase,
      current: currentRoute,
      keyframe: hasKeyframe,
      eligible: verdict.eligible,
      simulated,
      costBefore: currentCost,
      costAfter: simCost,
      reason,
    });
  }

  console.log(
    "Scene     #  Idiom            Route hiện tại  Keyframe  Đủ ĐK  Route mô phỏng     Trước   Sau",
  );
  for (const r of rows) {
    console.log(
      `${r.id} ${String(r.scene).padEnd(3)}${r.idiom.slice(0, 16).padEnd(17)}` +
        `${r.current.padEnd(16)}${(r.keyframe ? "có" : "KHÔNG").padEnd(10)}` +
        `${(r.eligible ? "có" : "không").padEnd(7)}${r.simulated.padEnd(19)}` +
        `$${r.costBefore.toFixed(2)}   $${r.costAfter.toFixed(2)}`,
    );
    console.log(`          └─ ${r.reason}`);
  }

  const localKept = rows.filter((r) => r.simulated === "LOCAL_MOTION").length;
  const h3 = rows.filter((r) => r.simulated.startsWith("h3_max"));
  const needsKeyframe = rows.filter((r) => r.simulated === "NEEDS_KEYFRAME").length;
  const needsProvider = rows.filter((r) => r.simulated === "NEEDS_PROVIDER").length;
  const before = rows.reduce((a, r) => a + r.costBefore, 0);
  const after = rows.reduce((a, r) => a + r.costAfter, 0);

  console.log("\n=== TỔNG KẾT ===");
  console.log(`Tổng cảnh LOW               : ${rows.length}`);
  console.log(`LOCAL_MOTION giữ nguyên     : ${localKept}`);
  console.log(`Ứng viên h3_max             : ${h3.length}`);
  console.log(`NEEDS_KEYFRAME              : ${needsKeyframe}`);
  console.log(`NEEDS_PROVIDER              : ${needsProvider}`);
  console.log(`Cảnh bị ĐỔI route           : ${changedRoute}`);
  console.log(`  (LOCAL_MOTION -> h3_max   : ${rows.filter((r) => r.current === "LOCAL_MOTION" && r.simulated.startsWith("h3_max")).length})`);
  console.log(`Chi phí ước tính hiện tại   : $${before.toFixed(6)}`);
  console.log(`Chi phí nếu bật LOW_AUTO    : $${after.toFixed(6)}`);
  console.log(`Chênh lệch                  : ${after - before >= 0 ? "+" : ""}$${(after - before).toFixed(6)}`);
  console.log(`Mâu thuẫn prompt            : ${contradictionCount}`);
  console.log(`Chưa giải quyết được        : ${unresolved}`);
  console.log(
    `\nRouter production hiện tại  : ${model.lifecycle === "ACTIVE" ? "ĐÃ BẬT" : "VẪN CHẶN — đây chỉ là mô phỏng"}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
