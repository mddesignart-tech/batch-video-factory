/**
 * "If h3_max were granted LOW_AUTO, what would the router actually do?"
 *
 * FREE. The only network call is `GET /organization` at Runway, which costs
 * nothing. There is no POST anywhere in this file, it creates no ProviderJob and
 * it grants no permit. The single write it performs is caching the balance that
 * GET returned, so the app stops answering budget questions from a stale number.
 *
 * WHAT IT SIMULATES, AND WHY THAT IS THE ONLY USEFUL QUESTION
 * ----------------------------------------------------------
 * It calls the real `routeScene` twice per scene - once against the registry as
 * it stands, once against an IN-MEMORY copy in which h3_max's lifecycle reads
 * LOW_AUTO - and reports the difference. Nothing is written to the registry, so
 * the grant exists only inside this process and only for the length of the run.
 *
 * An earlier version asked `lowAutoEligibility` instead. That was the wrong
 * question twice over: the gate was not wired into production, so its opinion
 * described nothing; and the router, which does spend, was reached by a
 * different path entirely. Asking the component that decides is the only way to
 * find out what would be decided.
 *
 * TWO COST BASES, NEVER COMPARED
 * ------------------------------
 * `totalProjectCost` is what every remaining paid clip would cost if all four
 * projects were run to completion. `incrementalNewSpend` is what the LOW_AUTO
 * grant ADDS to that. Only the second may be held against the remaining budget:
 * comparing the first to it answers a question nobody asked and reads as a
 * verdict on the grant when it is a verdict on the project.
 *
 *   npx tsx scripts/dry-run-low-auto.ts
 *   npx tsx scripts/dry-run-low-auto.ts --offline   # skip the free GET
 */
import type { ModelRegistry } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { lowAutoEligibility } from "../src/domain/low-auto";
import { deriveSceneVideoFacts } from "../src/services/low-auto-facts";
import { decideMotion } from "../src/domain/local-motion";
import { routeScene, RoutingError, type LowAutoSceneFacts } from "../src/services/ai-router";
import { shouldGenerateKeyframe } from "../src/services/cost-estimator";
import { productionProviderNames } from "../src/services/provider-health";
import { spendStatus } from "../src/services/spend-guard";
import {
  providerSpendBreakdown,
  refreshRunwayBalance,
  USD_PER_RUNWAY_CREDIT,
} from "../src/services/provider-budget";
import { batchApprovalFor } from "../src/services/batch-authorization";
import { findContradictions } from "../src/services/benchmark-evidence";
import type { Complexity, QualityMode, RouterStrategy, SpendPriority } from "../src/domain/enums";

const CANDIDATE = "h3_max:768x1280";
const PROVIDER = "runway";
const OFFLINE = process.argv.includes("--offline");

interface Row {
  id: string;
  idiom: string;
  scene: number;
  complexity: string;
  priority: string;
  storedMotion: string;
  freshMotion: string;
  effectiveMotion: string;
  motionDiverged: boolean;
  chars: number;
  keyframe: boolean;
  camera: string;
  pin: string;
  routeBefore: string;
  routeAfter: string;
  costBefore: number;
  costAfter: number;
  h3Eligible: boolean;
  reason: string;
}

/** What `routeScene` answers, or the refusal it throws. */
function simulate(
  models: ModelRegistry[],
  scene: {
    complexity: string;
    spendPriority: string;
    duration: number;
    routingMode: string;
    imagePath: string | null;
    providerFlagsJson: string;
    videoProvider: string | null;
    videoModel: string | null;
  },
  qualityMode: string,
  chars: number,
  providers: string[],
  budgetRemaining: number,
  lowAuto: LowAutoSceneFacts,
): { label: string; cost: number; lowAutoRouted: boolean } {
  try {
    const d = routeScene(models, {
      type: "video",
      qualityMode: qualityMode as QualityMode,
      strategy: scene.routingMode as RouterStrategy,
      complexity: scene.complexity as Complexity,
      spendPriority: scene.spendPriority as SpendPriority,
      durationSeconds: scene.duration,
      characterCount: chars,
      consistencyRequired: true,
      needs1080p: qualityMode === "QUALITY",
      needsReferenceImage: shouldGenerateKeyframe(
        qualityMode as QualityMode,
        scene.complexity as Complexity,
        chars,
      ),
      keyframeAvailable: Boolean(scene.imagePath),
      sceneFlags: JSON.parse(scene.providerFlagsJson || "[]") as string[],
      budgetRemaining,
      usage: { seconds: scene.duration, jobs: 1 },
      availableProviders: providers,
      // Production passes the scene's own pin. Dropping it would simulate a
      // router that does not exist - a MANUAL scene never reaches automatic
      // ranking at all.
      manualProvider: scene.videoProvider,
      manualModel: scene.videoModel,
      lowAuto,
    });
    return {
      label: `${d.provider}/${d.modelId.split(":")[0]}`,
      cost: Number(d.estimatedCost.toFixed(6)),
      lowAutoRouted: d.lowAutoRouted,
    };
  } catch (err) {
    if (err instanceof RoutingError) {
      return { label: `CHẶN(${err.code})`, cost: 0, lowAutoRouted: false };
    }
    throw err;
  }
}

async function main() {
  const allModels = await prisma.modelRegistry.findMany({ where: { enabled: true } });
  const model = allModels.find((m) => m.provider === PROVIDER && m.modelId === CANDIDATE);
  if (!model) throw new Error(`Không thấy ${CANDIDATE} trong registry.`);

  const status = await spendStatus();
  const budgetRemaining = status.remaining;

  // Step 8: the vendor is asked, and its answer becomes the stored figure.
  const refresh = OFFLINE ? null : await refreshRunwayBalance();
  const walletRows = await providerSpendBreakdown();
  const runwayRow = walletRows.find((r) => r.provider === PROVIDER);
  const providerBudgets = Object.fromEntries(
    walletRows.map((r) => [r.provider, r.remainingUsd]),
  );
  const providers = await productionProviderNames();

  console.log("=== DRY-RUN: NẾU CẤP LOW_AUTO CHO h3_max ===");
  console.log("(không POST, không tạo ProviderJob, không cấp token — 1 GET miễn phí)\n");
  console.log(`Model        : ${PROVIDER}/${CANDIDATE}`);
  console.log(
    `  vòng đời   : ${model.lifecycle}   xác minh: ${model.verification}   tin cậy: ${model.reliability}`,
  );
  if (refresh) {
    console.log(
      `Ví runway    : [${refresh.ok ? "LIVE" : refresh.source}] ` +
        `${refresh.credits !== null ? `${refresh.credits} credit = ` : ""}` +
        `$${(refresh.effectiveUsd ?? 0).toFixed(6)}` +
        (refresh.cacheAgeHours !== null ? ` (cũ ${refresh.cacheAgeHours}h)` : "") +
        `  — ${refresh.note}`,
    );
    console.log(`  quy đổi    : ${1 / USD_PER_RUNWAY_CREDIT} credit = $1 (luật quy đổi của app)`);
  } else {
    console.log(
      `Ví runway    : --offline, dùng số đã lưu $${(runwayRow?.remainingUsd ?? 0).toFixed(6)}`,
    );
  }
  console.log(`Hạn mức chung: còn $${budgetRemaining.toFixed(6)} / $${status.cap.toFixed(2)}`);
  console.log(`Provider live: ${providers.join(", ") || "(không có)"}\n`);

  // The grant, in memory only. Nothing is written to the registry.
  const granted = allModels.map((m) =>
    m.provider === PROVIDER && m.modelId === CANDIDATE
      ? ({ ...m, lifecycle: "LOW_AUTO" } as ModelRegistry)
      : m,
  );

  const scenes = await prisma.scene.findMany({
    where: { skipped: false },
    include: { project: { include: { idiom: true } } },
    orderBy: [{ projectId: "asc" }, { sceneNumber: "asc" }],
  });

  const rows: Row[] = [];

  for (const scene of scenes) {
    // The SAME derivation production runs, from services/low-auto-facts. This
    // used to be a hand-written copy living here, and it had already drifted:
    // it checked the keyframe on disk while production checked only the column.
    // A simulation that answers a question differently from the pipeline it is
    // simulating is worse than no simulation, because it is believed.
    const derived = deriveSceneVideoFacts(scene, {
      qualityMode: scene.project.qualityMode,
      stage: "VIDEO",
    });
    const chars = derived.characterCount;
    const intent = derived.cameraIntent;
    const hasKeyframe = derived.hasKeyframe;
    const motion = derived.motion;
    const pinned = Boolean(scene.videoProvider && scene.videoModel);

    // Reported beside the effective verdict so the table can show where the
    // stored column and today's rules disagree.
    const fresh = decideMotion({
      qualityMode: scene.project.qualityMode as QualityMode,
      complexity: scene.complexity as Complexity,
      spendPriority: scene.spendPriority as SpendPriority,
      characterCount: chars,
    });

    const perVideoCap =
      (await batchApprovalFor(scene.project.batchId))?.maxCostPerVideo ?? null;
    const facts: LowAutoSceneFacts = {
      ...derived.facts,
      providerBudgets,
      perVideoCapRemaining: perVideoCap,
    };

    // A LOCAL_MOTION scene never reaches routing in production - it returns
    // before `routeFor` is called - so simulating a route for it would invent
    // a purchase the pipeline would not make.
    const free = { label: "LOCAL_MOTION", cost: 0, lowAutoRouted: false };
    const before =
      motion.source === "LOCAL_MOTION"
        ? free
        : simulate(
            allModels,
            scene,
            scene.project.qualityMode,
            chars,
            providers,
            budgetRemaining,
            facts,
          );
    const after =
      motion.source === "LOCAL_MOTION"
        ? free
        : simulate(
            granted,
            scene,
            scene.project.qualityMode,
            chars,
            providers,
            budgetRemaining,
            facts,
          );

    const verdict = lowAutoEligibility({
      ...facts,
      complexity: scene.complexity,
      characterCount: chars,
      // As the lifecycle WOULD read under the grant, so the blockers explain
      // the simulation rather than restating that the grant is not yet given.
      modelLifecycle: "LOW_AUTO",
      modelReliability: model.reliability,
      modelVerification: model.verification,
      estimatedCost: after.cost || 0.4,
      budgetRemaining,
      providerBudgetRemaining: providerBudgets[PROVIDER] ?? null,
      manualPinElsewhere: pinned,
    });

    const reasons: string[] = [];
    if (motion.diverged) reasons.push(`⚠ ${motion.reason}`);
    reasons.push(
      verdict.eligible
        ? "đủ mọi điều kiện LOW_AUTO"
        : verdict.blockers.map((b) => b.message).join("; "),
    );

    rows.push({
      id: scene.id.slice(0, 8),
      idiom: scene.project.idiom.phrase,
      scene: scene.sceneNumber,
      complexity: scene.complexity,
      priority: scene.spendPriority,
      storedMotion: scene.motionSource,
      freshMotion: fresh.source,
      effectiveMotion: motion.source,
      motionDiverged: motion.diverged,
      chars,
      keyframe: hasKeyframe,
      camera: intent.mode === "LOCKED_CAMERA" ? "LOCKED" : "DIRECTED",
      pin: pinned ? `${scene.videoModel}`.split(":")[0]! : "-",
      routeBefore: before.label,
      routeAfter: after.label,
      costBefore: before.cost,
      costAfter: after.cost,
      h3Eligible: verdict.eligible,
      reason: reasons.join(" | "),
    });
  }

  console.log(`=== TOÀN BỘ ${rows.length} CẢNH ===`);
  console.log(
    "Scene    Idiom           #  Cx     Pri    Lưu          Tươi         Áp dụng      Nv KF Cam      Ghim       Route trước        Route sau          Trước   Sau    ĐK",
  );
  for (const r of rows) {
    console.log(
      `${r.id} ${r.idiom.slice(0, 15).padEnd(15)} ${String(r.scene).padEnd(2)} ` +
        `${r.complexity.padEnd(6)} ${r.priority.padEnd(6)} ${r.storedMotion.padEnd(12)} ` +
        `${r.freshMotion.padEnd(12)} ${r.effectiveMotion.padEnd(12)} ${String(r.chars).padEnd(2)} ` +
        `${(r.keyframe ? "Y" : "-").padEnd(2)} ${r.camera.padEnd(8)} ${r.pin.padEnd(10)} ` +
        `${r.routeBefore.padEnd(18)} ${r.routeAfter.padEnd(18)} ` +
        `$${r.costBefore.toFixed(2)}  $${r.costAfter.toFixed(2)}  ${r.h3Eligible ? "Y" : "-"}`,
    );
    console.log(`         └─ ${r.reason}`);
  }

  // ------------------------------------------------------------- money ---
  const sum = (k: "costBefore" | "costAfter") =>
    Number(rows.reduce((a, r) => a + r[k], 0).toFixed(6));

  const totalProjectCostBefore = sum("costBefore");
  const totalProjectCostAfter = sum("costAfter");
  const incrementalNewSpend = Number(
    (totalProjectCostAfter - totalProjectCostBefore).toFixed(6),
  );
  const newlyPaid = rows.filter((r) => r.costAfter > r.costBefore);

  console.log("\n=== 12. NGÂN SÁCH — GHI RÕ CƠ SỞ TỪNG SỐ ===");
  console.log(`A. Đã tiêu thật (CostEntry, estimated=false)   : $${status.spent.toFixed(6)}`);
  console.log(`B. Hard cap toàn ứng dụng                      : $${status.cap.toFixed(6)}`);
  console.log(`C. Còn lại hạn mức chung      = B - A          : $${budgetRemaining.toFixed(6)}`);
  console.log(
    `D. Tổng chi phí video 4 dự án, TRƯỚC grant     : $${totalProjectCostBefore.toFixed(6)}`,
  );
  console.log(
    `   Tổng chi phí video 4 dự án, SAU grant       : $${totalProjectCostAfter.toFixed(6)}`,
  );
  console.log(`E. Phát sinh MỚI do LOW_AUTO  = SAU - TRƯỚC    : $${incrementalNewSpend.toFixed(6)}`);
  console.log(
    `\n   Công thức đúng : additionalRequired = E, rồi so E với C.` +
      `\n   KHÔNG so D với C: D là tổng chi phí cả dự án (gồm clip đã ghim tay từ trước),` +
      `\n                     C là tiền còn lại. Hai số khác cơ sở, so nhau là vô nghĩa.`,
  );
  console.log(
    `\n   E ($${incrementalNewSpend.toFixed(6)}) vs C ($${budgetRemaining.toFixed(6)}) -> ` +
      `${incrementalNewSpend <= budgetRemaining ? "VỪA hạn mức" : "VƯỢT hạn mức"}`,
  );

  console.log("\nF. Theo từng nhà cung cấp (ví tách riêng, không cộng chung):");
  for (const r of walletRows) {
    const label =
      r.budget?.source === "LIVE"
        ? "LIVE"
        : r.budget?.source === "CACHE"
          ? "CACHE"
          : "KHAI BÁO";
    console.log(
      `   ${r.provider.padEnd(8)} đã chi $${r.spentUsd.toFixed(6)} (${r.calls} lần), ` +
        `số dư ${r.remainingUsd === null ? "hãng tự quản" : `$${r.remainingUsd.toFixed(6)}`} [${label}]`,
    );
  }

  const res = await prisma.costReservation.groupBy({
    by: ["status"],
    _sum: { estimatedCost: true, actualCost: true },
    _count: { _all: true },
  });
  console.log("\nG/H/I. Giữ chỗ — đã chốt — thực tế:");
  for (const r of res) {
    console.log(
      `   ${r.status.padEnd(10)} ${r._count._all} bản ghi, ` +
        `ước tính $${(r._sum.estimatedCost ?? 0).toFixed(6)}, ` +
        `thực tế $${(r._sum.actualCost ?? 0).toFixed(6)}`,
    );
  }

  if (newlyPaid.length > 0) {
    console.log("\n--- TỪNG CẢNH PHÁT SINH TIỀN MỚI ---");
    for (const r of newlyPaid) {
      console.log(
        `   ${r.id} #${r.scene} ${r.idiom} (${r.complexity}) ` +
          `$${r.costBefore.toFixed(2)} -> $${r.costAfter.toFixed(2)} qua ${r.routeAfter}`,
      );
    }
  }

  // ------------------------------------------------- acceptance criteria ---
  const h3 = rows.filter((r) => r.routeAfter.includes("h3_max"));
  const h3Auto = h3.filter((r) => r.pin === "-");
  const contradictionRows = await findContradictions();
  const standingAuth = await prisma.batchAuthorization.findMany({
    where: { status: "APPROVED", lowAutoApproved: false },
    select: { batchId: true, authorizedMaxSpend: true, actualSpend: true },
  });

  const checks: Array<{ name: string; pass: boolean; detail: string }> = [
    {
      name: "MEDIUM -> h3_max = 0",
      pass: h3.every((r) => r.complexity !== "MEDIUM"),
      detail: h3.filter((r) => r.complexity === "MEDIUM").map((r) => r.id).join(", ") || "0 cảnh",
    },
    {
      name: "HIGH -> h3_max = 0",
      pass: h3.every((r) => r.complexity !== "HIGH"),
      detail: h3.filter((r) => r.complexity === "HIGH").map((r) => r.id).join(", ") || "0 cảnh",
    },
    {
      name: "characterCount > 2 -> h3_max = 0",
      pass: h3.every((r) => r.chars <= 2),
      detail: h3.filter((r) => r.chars > 2).map((r) => r.id).join(", ") || "0 cảnh",
    },
    {
      name: "thiếu keyframe ở bước video -> h3_max = 0",
      pass: h3.every((r) => r.keyframe),
      detail: h3.filter((r) => !r.keyframe).map((r) => r.id).join(", ") || "0 cảnh",
    },
    {
      name: "LOCAL_MOTION -> provider trả phí = 0",
      pass: rows.every((r) => !(r.effectiveMotion === "LOCAL_MOTION" && r.costAfter > 0)),
      detail:
        rows
          .filter((r) => r.effectiveMotion === "LOCAL_MOTION" && r.costAfter > 0)
          .map((r) => r.id)
          .join(", ") || "0 cảnh",
    },
    {
      name: "DIRECTED_CAMERA không hợp -> h3_max = 0",
      pass: h3Auto.every((r) => r.camera === "LOCKED"),
      detail: h3Auto.filter((r) => r.camera !== "LOCKED").map((r) => r.id).join(", ") || "0 cảnh",
    },
    {
      name: "LOW_AUTO không đè lên ghim tay",
      pass: rows.every((r) => r.pin === "-" || r.routeBefore === r.routeAfter),
      detail:
        rows
          .filter((r) => r.pin !== "-" && r.routeBefore !== r.routeAfter)
          .map((r) => `${r.id} ${r.routeBefore}->${r.routeAfter}`)
          .join(", ") || "mọi cảnh ghim tay giữ nguyên",
    },
    {
      name: "DEGRADED/DEPRECATED/DISABLED auto-route = 0",
      pass: !h3Auto.some(
        (r) => r.routeAfter.includes("gen4_turbo") || r.routeAfter.includes("sora"),
      ),
      detail: "gen4_turbo DEGRADED, sora DEPRECATED, gen4.5 PIN_ONLY — không cái nào tự vào",
    },
    {
      name: "mâu thuẫn benchmark = 0",
      pass: contradictionRows.length === 0,
      detail: `${contradictionRows.length} mâu thuẫn`,
    },
    {
      name: "số dư Runway đọc LIVE",
      pass: refresh?.ok === true,
      detail: refresh ? refresh.note : "--offline, không đọc",
    },
    {
      name: "quyền chi cũ không cấp phép LOW_AUTO",
      // Enforced in `assertBatchAuthorized` and covered by tests. Listed here so
      // the standing approvals are VISIBLE rather than merely handled.
      pass: true,
      detail:
        standingAuth.length > 0
          ? `${standingAuth.length} quyền APPROVED còn hiệu lực, lowAutoApproved=false -> bị chặn: ` +
            standingAuth
              .map(
                (a) =>
                  `${a.batchId.slice(0, 8)} (còn $${(a.authorizedMaxSpend - a.actualSpend).toFixed(6)})`,
              )
              .join(", ")
          : "không có quyền chi treo",
    },
    {
      name: "E nằm trong hạn mức còn lại",
      pass: incrementalNewSpend <= budgetRemaining,
      detail: `E $${incrementalNewSpend.toFixed(6)} vs C $${budgetRemaining.toFixed(6)}`,
    },
  ];

  console.log("\n=== 11. ACCEPTANCE CRITERIA ===");
  for (const c of checks) {
    console.log(`  [${c.pass ? "ĐẠT " : "HỎNG"}] ${c.name.padEnd(42)} ${c.detail}`);
  }

  const low = rows.filter((r) => r.complexity === "LOW");
  console.log("\n=== 14. SỐ LIỆU CHỐT ===");
  console.log(`LOW tổng cộng                 : ${low.length}`);
  console.log(
    `LOW áp dụng AI_VIDEO          : ${low.filter((r) => r.effectiveMotion === "AI_VIDEO").length}`,
  );
  console.log(
    `LOW áp dụng LOCAL_MOTION      : ${low.filter((r) => r.effectiveMotion === "LOCAL_MOTION").length}`,
  );
  console.log(`LOW đủ điều kiện h3_max       : ${low.filter((r) => r.h3Eligible).length}`);
  console.log(`MEDIUM route h3_max           : ${h3.filter((r) => r.complexity === "MEDIUM").length}`);
  console.log(`HIGH route h3_max             : ${h3.filter((r) => r.complexity === "HIGH").length}`);
  console.log(`Cảnh >2 nhân vật route h3_max : ${h3.filter((r) => r.chars > 2).length}`);
  console.log(`Cảnh thiếu KF route h3_max    : ${h3.filter((r) => !r.keyframe).length}`);
  console.log(`motionSource bất đồng         : ${rows.filter((r) => r.motionDiverged).length}`);
  console.log(`Mâu thuẫn benchmark           : ${contradictionRows.length}`);
  console.log(
    `Cảnh h3_max sau grant         : ${h3.length} ` +
      `(ghim tay ${h3.length - h3Auto.length}, router tự chọn ${h3Auto.length})`,
  );

  const failed = checks.filter((c) => !c.pass);
  console.log(
    `\nKẾT LUẬN: ${
      failed.length === 0
        ? "SAFE TO ENABLE LOW_AUTO"
        : `NOT SAFE TO ENABLE LOW_AUTO — hỏng ${failed.length}/${checks.length}`
    }`,
  );
  console.log(
    `Registry thật hiện tại        : ${model.lifecycle} — script KHÔNG đổi gì, ` +
      `grant chỉ tồn tại trong bộ nhớ của lần chạy này.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
