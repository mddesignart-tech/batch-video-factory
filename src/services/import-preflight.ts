import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { round } from "@/lib/utils";
import { basisForProviders, recommendAuthorization } from "@/domain/cost-basis";
import type { QualityMode } from "@/domain/enums";
import { spendStatus } from "./spend-guard";
import { providerSpendBreakdown } from "./provider-budget";
import { productionProviderNames, availableProviderNames } from "./provider-health";
import { previewProjectCost } from "./project-service";
import {
  characterReadiness,
  findCharacterByName,
  hasAnyDescriptiveField,
  missingBibleFields,
  unlockedAttributes,
  type CharacterReadiness,
} from "./character-service";
import { sceneCharacters } from "@/domain/scene-characters";
import type { BatchPlan, BatchCosting, PlannedVideo, PlannedSceneRow } from "./batch-planner";

/**
 * Pricing an imported batch, from the scenes that are already in the database.
 *
 * ## Why this is not `planBatch`
 *
 * V1's planner has to guess. At planning time most of its videos have no script
 * - writing one costs money - so it prices them against a reference profile and
 * says so. An imported batch has the opposite problem and the opposite luxury:
 * every scene is already written down, with its duration, its complexity and
 * whether it brought its own keyframe. There is nothing to guess, so guessing
 * would be strictly worse.
 *
 * So this walks the real projects and asks `previewProjectCost` - the same
 * function the run itself checks its plan against - and assembles the answers
 * into the same `BatchPlan` shape V1 stores. Same shape matters: it is what
 * lets `batch_expand`, the approval gate, the batch page and `resume-batch.ts`
 * treat an imported batch as an ordinary one.
 *
 * ## What it must never do
 *
 * Spend, approve, or start anything. It is all reads, and the batch it prices
 * stays `PLANNED` with a `DRAFT` authorisation until a person types a number.
 */

export interface ImportSceneLine {
  sceneNumber: number;
  duration: number;
  complexity: string;
  motionSource: string;
  motionMode: string;
  /** Who is in this shot, by the names the pipeline will resolve. */
  characters: string[];
  /** The scene's own camera direction, so a reader can see what was asked for. */
  camera: string;
  /** Null for a LOCAL_MOTION scene: there is no model, because there is no purchase. */
  videoModel: string | null;
  keyframe: "supplied" | "will-generate";
  estimatedCost: number;
  /** Per asset: BUY (this run pays), REUSE (already owned), NONE (not needed). */
  plan: {
    image: AssetPlan;
    video: AssetPlan;
    voice: AssetPlan;
  };
}

/**
 * What will happen to one asset of one scene.
 *
 * Three states, not two. "Not needed" and "already owned" both cost $0 and mean
 * completely different things: a LOCAL_MOTION scene never wanted a clip, while
 * a resumed scene wanted one and already has it. Collapsing them would let a
 * preview claim savings on purchases that were never on the table. QĐ-071.
 */
export type AssetPlan = "BUY" | "REUSE" | "NONE";

/** How many of each asset a run will buy, and how many it already owns. */
export interface AssetCounts {
  imageBuy: number;
  imageReuse: number;
  videoBuy: number;
  videoReuse: number;
  voiceBuy: number;
  voiceReuse: number;
}

function emptyCounts(): AssetCounts {
  return {
    imageBuy: 0,
    imageReuse: 0,
    videoBuy: 0,
    videoReuse: 0,
    voiceBuy: 0,
    voiceReuse: 0,
  };
}

/**
 * BUY / REUSE / NONE, from the two facts the estimator reports.
 *
 * `needs` and `reuse` are mutually exclusive by construction - the estimator
 * does not route an asset it is reusing - so a scene can never be both. Neither
 * means the stage does not apply to this scene at all.
 */
function assetPlan(needs: boolean, reuse: boolean): AssetPlan {
  if (needs) return "BUY";
  return reuse ? "REUSE" : "NONE";
}

function addCounts(into: AssetCounts, line: ImportSceneLine["plan"]): void {
  if (line.image === "BUY") into.imageBuy += 1;
  if (line.image === "REUSE") into.imageReuse += 1;
  if (line.video === "BUY") into.videoBuy += 1;
  if (line.video === "REUSE") into.videoReuse += 1;
  if (line.voice === "BUY") into.voiceBuy += 1;
  if (line.voice === "REUSE") into.voiceReuse += 1;
}

export interface ImportVideoPreview {
  projectId: string;
  title: string;
  sceneCount: number;
  localMotionCount: number;
  videoAiCount: number;
  suppliedImages: number;
  missingImages: number;
  providers: string[];
  breakdown: {
    text: number;
    image: number;
    video: number;
    voice: number;
    quality: number;
    retries: number;
    /**
     * Always 0, and stated anyway.
     *
     * The render is FFmpeg on this machine and costs nothing. A reader who does
     * not see a render line cannot tell "free" from "forgotten", and the
     * difference between those two matters when the number they are about to
     * approve is a ceiling. QĐ-071.
     */
    render: number;
  };
  counts: AssetCounts;
  estimatedCost: number;
  status: "OK" | "OVER_VIDEO_BUDGET" | "NEEDS_PROVIDER";
  /**
   * Where this ONE video is in its own life, independent of its neighbours.
   *
   * A batch is a convenience for approving money once; it is not a unit of
   * work. One video that cannot be priced must not make the other two
   * unreadable, and one that has already been rendered must not look pending
   * because a sibling is still running. See QĐ-073.
   */
  lifecycle: ImportVideoLifecycle;
  /** Why it is BLOCKED, in one sentence. Null unless it is. */
  blockedReason: string | null;
  warnings: string[];
  /** Cast of this video, resolved against the character table. */
  characters: ImportVideoCharacter[];
  scenes: ImportSceneLine[];
}

/**
 * The per-video states the operator sees on the import screen.
 *
 *   IMPORTED   rows exist, nothing priced yet
 *   BLOCKED    priced, and something stops it running. Names the reason.
 *   READY      priced, nothing in the way, waiting for money to be approved
 *   APPROVED   an approval covers it; work has not started
 *   RUNNING    media or render in progress
 *   COMPLETED  final MP4 exists
 *   FAILED     gave up; the project row says why
 */
export const IMPORT_VIDEO_LIFECYCLE = [
  "IMPORTED",
  "BLOCKED",
  "READY",
  "APPROVED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
] as const;
export type ImportVideoLifecycle = (typeof IMPORT_VIDEO_LIFECYCLE)[number];

export interface ImportVideoCharacter {
  name: string;
  readiness: CharacterReadiness;
  /** Reference images this character has right now. */
  referenceCount: number;
  /** Core descriptive fields not stated, as labels. */
  missingFields: string[];
  /** Lockable attributes with no value - the prompt will not claim to lock them. */
  unlockedAttributes: string[];
  /** Row id, so the import screen can edit the Bible without a second lookup. */
  characterId: string | null;
  /** How many scenes of this video name them. */
  sceneCount: number;
}

export interface ImportPreflight {
  batchId: string;
  batchName: string;
  videos: ImportVideoPreview[];
  totalScenes: number;
  totalSuppliedImages: number;
  totalMissingImages: number;
  totalLocalMotion: number;
  totalVideoAi: number;
  /** Every distinct character in the batch, de-duplicated by name. */
  characters: ImportVideoCharacter[];
  /** How many videos sit in each lifecycle state. */
  lifecycleCounts: Record<ImportVideoLifecycle, number>;
  estimatedTotal: number;
  /** Sum including videos that cannot run, so nothing is hidden. */
  estimatedTotalIncludingBlocked: number;
  runnableCount: number;
  blockedCount: number;
  maxCostPerVideo: number;
  maxCostForBatch: number;
  suggestedAuthorizedMaxSpend: number;
  /**
   * The headroom between the forecast and the ceiling being suggested, named.
   *
   * `suggestedAuthorizedMaxSpend` already contained this, folded in. An operator
   * approving a ceiling is entitled to see how much of it is the estimate and
   * how much is slack - those are different things to agree to, and one number
   * covering both invites reading the slack as forecast. QĐ-071.
   */
  safetyMargin: number;
  safetyMarginPercent: number;
  /** True when the plan as priced already exceeds the ceiling the operator set. */
  overBatchCeiling: boolean;
  globalRemaining: number;
  /** How many of each asset the whole batch will buy vs. already owns. */
  counts: AssetCounts;
  /**
   * Each vendor's own wallet, as it stands right now.
   *
   * `remainingUsd` is null when the vendor meters itself and we hold no wallet
   * for it - which is NOT the same as a wallet holding zero, and the preview
   * must not render it as $0.00. Wallets are never summed together: the money
   * in one vendor's account cannot pay another's bill.
   */
  providerWallets: Array<{
    provider: string;
    spentUsd: number;
    remainingUsd: number | null;
    live: boolean;
  }>;
  costBasis: string;
  warnings: string[];
}

/**
 * Price every video in an imported batch and write the plan back onto the row.
 *
 * The write is what makes the rest of the machinery work: `batch_expand` reads
 * `planJson` to know which videos to start, and `approveAuthorization` reads it
 * to check the amount being approved against the amount that was shown.
 */
export async function preflightImportedBatch(batchId: string): Promise<ImportPreflight> {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: {
      projects: {
        orderBy: { createdAt: "asc" },
        include: {
          idiom: { select: { id: true, phrase: true } },
          scenes: { where: { skipped: false }, orderBy: { sceneNumber: "asc" } },
        },
      },
    },
  });
  if (!batch) throw new Error(`Không tìm thấy lô ${batchId}.`);
  if (batch.projects.length === 0) {
    throw new Error("Lô nhập chưa có video nào. Hãy nhập storyboard trước.");
  }

  const [cap, wallets, production, available, authorization] = await Promise.all([
    spendStatus(),
    providerSpendBreakdown(),
    productionProviderNames(),
    availableProviderNames(),
    prisma.batchAuthorization.findUnique({ where: { batchId } }),
  ]);
  const moneyApproved = authorization?.status === "APPROVED";

  const videos: ImportVideoPreview[] = [];
  const planned: PlannedVideo[] = [];
  const warnings: string[] = [];

  for (const project of batch.projects) {
    const preview = await previewProjectCost(project.id);
    const estimate = preview.current;

    const sceneLines: ImportSceneLine[] = [];
    const plannedScenes: PlannedSceneRow[] = [];

    const counts = emptyCounts();

    for (const row of estimate.scenes) {
      const scene = project.scenes.find((s) => s.sceneNumber === row.sceneNumber);
      const plan = {
        image: assetPlan(row.needs.image, row.reuse.image),
        video: assetPlan(row.needs.video, row.reuse.video),
        voice: assetPlan(row.needs.voice, row.reuse.voice),
      };
      addCounts(counts, plan);
      sceneLines.push({
        sceneNumber: row.sceneNumber,
        duration: scene?.duration ?? 0,
        complexity: scene?.complexity ?? "LOW",
        motionSource: row.motionSource,
        motionMode: scene?.motionMode ?? "AUTO",
        characters: scene ? sceneCharacters(scene).present : [],
        camera: scene?.camera ?? "",
        videoModel: row.video ? `${row.video.provider}/${row.video.modelId}` : null,
        keyframe: scene?.imageSource === "IMPORTED" ? "supplied" : "will-generate",
        estimatedCost: round(row.estimatedCost, 6),
        plan,
      });
      plannedScenes.push({
        sceneNumber: row.sceneNumber,
        complexity: (scene?.complexity ?? "LOW") as PlannedSceneRow["complexity"],
        motionSource: row.motionSource as PlannedSceneRow["motionSource"],
        motionReason: row.motionReason ?? "",
        videoProvider: row.video?.provider ?? null,
        videoModel: row.video?.modelId ?? null,
        estimatedCost: round(row.estimatedCost, 6),
      });
    }

    const supplied = project.scenes.filter((s) => s.imageSource === "IMPORTED").length;
    const localMotion = sceneLines.filter((s) => s.motionSource === "LOCAL_MOTION").length;
    const videoAi = sceneLines.length - localMotion;
    const total = round(estimate.breakdown.total, 6);

    const videoWarnings: string[] = [...estimate.errors];

    // Budget verdict FIRST, exactly as `planBatch` orders it, and for the same
    // reason: when the per-video ceiling is what the router ran out of, every
    // downstream "no model fits this scene" is a SYMPTOM of it. Reporting that
    // as NEEDS_PROVIDER sends the operator into the model registry to fix
    // something that is not broken.
    const ranOutOfBudget = estimate.errorCodes.includes("over_budget");
    const overCeiling = total > batch.maxCostPerVideo;

    let status: ImportVideoPreview["status"] = "OK";
    if (ranOutOfBudget || overCeiling) {
      status = "OVER_VIDEO_BUDGET";
      videoWarnings.push(
        ranOutOfBudget
          ? `Hạn mức $${batch.maxCostPerVideo.toFixed(2)} cho một video không đủ để định ` +
            `tuyến hết các cảnh. Hãy nâng hạn mức/video hoặc bỏ bớt cảnh Video AI.`
          : `Dự toán $${total.toFixed(6)} vượt hạn mức $${batch.maxCostPerVideo.toFixed(2)} ` +
            `cho một video.`,
      );
      videoWarnings.push(
        "Video này sẽ KHÔNG chạy; các video khác trong lô không bị ảnh hưởng.",
      );
    } else if (estimate.needsProvider.length > 0 || estimate.errors.length > 0) {
      status = "NEEDS_PROVIDER";
    }

    const providers = [
      ...new Set(
        estimate.scenes
          .flatMap((s) => [s.image?.provider, s.video?.provider, s.voice?.provider])
          .filter((p): p is string => typeof p === "string" && p.length > 0),
      ),
    ].sort();

    // THE CAST OF THIS VIDEO, resolved against the character table.
    //
    // Read from the scenes rather than from the storyboard file, because the
    // scenes are what the pipeline will act on - a name edited after import is
    // in one and not the other. Counted per video: the same character appearing
    // in six scenes is one person with one reference, and a screen that said
    // "6 characters" would be describing the wrong thing. QĐ-073.
    const castCounts = new Map<string, number>();
    for (const scene of project.scenes) {
      for (const name of sceneCharacters(scene).present) {
        castCounts.set(name, (castCounts.get(name) ?? 0) + 1);
      }
    }
    const characters: ImportVideoCharacter[] = [];
    for (const [name, sceneCount] of castCounts) {
      const row = await findCharacterByName(name);
      const referenceCount = row
        ? await prisma.characterReference.count({ where: { characterId: row.id } })
        : 0;
      characters.push({
        name,
        // A name with no row at all is reported as needing a reference, which is
        // true and is the first thing to fix. `requireCharacterSheetsByName`
        // refuses it later with a sharper message; this screen only has to make
        // the problem visible before anyone approves money for it.
        readiness: row
          ? characterReadiness({
              hasReference: referenceCount > 0,
              hasAnyDescriptiveField: hasAnyDescriptiveField(row),
            })
          : "NEEDS_CHARACTER_REFERENCE",
        referenceCount,
        missingFields: row ? missingBibleFields(row) : [],
        unlockedAttributes: row ? unlockedAttributes(row) : [],
        characterId: row?.id ?? null,
        sceneCount,
      });
    }
    characters.sort((a, b) => b.sceneCount - a.sceneCount || a.name.localeCompare(b.name));

    // A video's own state, decided by its own row and its own price.
    //
    // The order is "what has already happened" before "what is in the way",
    // because a finished video is finished regardless of what its estimate says
    // now, and a failed one needs its failure read rather than its forecast.
    let blockedReason: string | null = null;
    let lifecycle: ImportVideoLifecycle;
    if (project.status === "completed") {
      lifecycle = "COMPLETED";
    } else if (project.status === "failed" || project.status === "cancelled") {
      lifecycle = "FAILED";
      blockedReason = project.errorMessage ?? null;
    } else if (
      project.status === "media_generating" ||
      project.status === "media_ready" ||
      project.status === "rendering"
    ) {
      lifecycle = "RUNNING";
    } else if (status !== "OK") {
      lifecycle = "BLOCKED";
      blockedReason =
        status === "OVER_VIDEO_BUDGET"
          ? `Dự toán $${total.toFixed(6)} vượt trần $${batch.maxCostPerVideo.toFixed(2)} cho một video.`
          : (estimate.needsProvider[0] ??
            estimate.errors[0] ??
            "Có cảnh chưa định tuyến được model.");
    } else if (moneyApproved) {
      lifecycle = "APPROVED";
    } else {
      lifecycle = "READY";
    }

    videos.push({
      lifecycle,
      blockedReason,
      characters,
      projectId: project.id,
      title: project.title,
      sceneCount: project.scenes.length,
      localMotionCount: localMotion,
      videoAiCount: videoAi,
      suppliedImages: supplied,
      missingImages: project.scenes.length - supplied,
      providers,
      breakdown: {
        text: round(estimate.breakdown.text, 6),
        image: round(estimate.breakdown.image, 6),
        video: round(estimate.breakdown.video, 6),
        voice: round(estimate.breakdown.voice, 6),
        quality: round(estimate.breakdown.quality, 6),
        retries: round(estimate.breakdown.retries, 6),
        // FFmpeg, on this machine. Zero, said out loud.
        render: 0,
      },
      counts,
      estimatedCost: total,
      status,
      warnings: videoWarnings,
      scenes: sceneLines,
    });

    planned.push({
      idiomId: project.idiomId,
      phrase: project.title,
      projectId: project.id,
      // Never the reference profile: every one of these has a real script,
      // because a person wrote it before the import.
      basis: "real-script",
      sceneCount: project.scenes.length,
      localMotionScenes: localMotion,
      aiVideoScenes: videoAi,
      scenes: plannedScenes,
      providers,
      breakdown: estimate.breakdown,
      estimatedCost: total,
      status,
      warnings: videoWarnings,
    });
  }

  const runnable = planned.filter((v) => v.status === "OK");
  const estimatedTotal = round(runnable.reduce((n, v) => n + v.estimatedCost, 0), 6);
  const estimatedAll = round(planned.reduce((n, v) => n + v.estimatedCost, 0), 6);
  const providerScope = [...new Set(planned.flatMap((v) => v.providers))].sort();
  const needsProvider = planned.flatMap((v) =>
    v.status === "NEEDS_PROVIDER" ? [v.phrase] : [],
  );

  const costing: BatchCosting = {
    costBasis: basisForProviders(available),
    videos: planned,
    estimatedTotal,
    estimatedTotalIncludingBlocked: estimatedAll,
    runnableCount: runnable.length,
    blockedCount: planned.length - runnable.length,
    providerScope,
    needsProvider,
  };
  const productionCosting: BatchCosting | null =
    production.length > 0 ? { ...costing, costBasis: "PRODUCTION_ESTIMATE" } : null;

  const recommendation = recommendAuthorization(
    (productionCosting ?? costing).estimatedTotal,
    cap.remaining,
  );

  if (estimatedTotal > batch.maxBudget) {
    warnings.push(
      `Dự toán $${estimatedTotal.toFixed(6)} vượt trần bạn đặt cho cả lô nhập ` +
        `($${batch.maxBudget.toFixed(2)}). Hãy nâng trần hoặc bỏ bớt video.`,
    );
  }
  if (recommendation.clampedByGlobalCap) {
    warnings.push(
      `Hạn mức tổng của ứng dụng chỉ còn $${cap.remaining.toFixed(6)}, thấp hơn mức đề xuất.`,
    );
  }

  const plan: BatchPlan = {
    qualityMode: batch.qualityMode as QualityMode,
    runtime: costing,
    production: productionCosting,
    recommendation,
    maxCostPerVideo: batch.maxCostPerVideo,
    globalCap: cap,
    wallets,
    warnings,
    generatedAt: new Date().toISOString(),
    videos: planned,
    estimatedTotal,
    estimatedTotalIncludingBlocked: estimatedAll,
    runnableCount: runnable.length,
    blockedCount: planned.length - runnable.length,
    providerScope,
    suggestedAuthorizedMaxSpend: recommendation.recommended,
  };

  await prisma.batch.update({
    where: { id: batchId },
    data: { planJson: JSON.stringify(plan), estimatedCost: estimatedTotal },
  });
  await prisma.batchAuthorization.updateMany({
    where: { batchId, status: "DRAFT" },
    data: { estimatedCost: estimatedTotal },
  });

  await logger.info({
    event: "import.preflight",
    message:
      `Dự toán lô nhập ${batchId}: ${planned.length} video, ` +
      `$${estimatedTotal.toFixed(6)}. Chưa cấp phép chi gì.`,
  });

  return {
    batchId,
    batchName: batch.name,
    videos,
    totalScenes: videos.reduce((n, v) => n + v.sceneCount, 0),
    totalSuppliedImages: videos.reduce((n, v) => n + v.suppliedImages, 0),
    totalMissingImages: videos.reduce((n, v) => n + v.missingImages, 0),
    totalLocalMotion: videos.reduce((n, v) => n + v.localMotionCount, 0),
    totalVideoAi: videos.reduce((n, v) => n + v.videoAiCount, 0),
    // Characters are counted ACROSS the batch by identity, not by appearance.
    // One Max shared by three videos is one character with one reference, and
    // adding up the per-video lists would report him three times.
    characters: (() => {
      const byName = new Map<string, ImportVideoCharacter>();
      for (const v of videos) {
        for (const c of v.characters) {
          const seen = byName.get(c.name);
          if (seen) seen.sceneCount += c.sceneCount;
          else byName.set(c.name, { ...c });
        }
      }
      return [...byName.values()].sort(
        (a, b) => b.sceneCount - a.sceneCount || a.name.localeCompare(b.name),
      );
    })(),
    lifecycleCounts: IMPORT_VIDEO_LIFECYCLE.reduce(
      (acc, state) => {
        acc[state] = videos.filter((v) => v.lifecycle === state).length;
        return acc;
      },
      {} as Record<ImportVideoLifecycle, number>,
    ),
    estimatedTotal,
    estimatedTotalIncludingBlocked: estimatedAll,
    runnableCount: runnable.length,
    blockedCount: planned.length - runnable.length,
    maxCostPerVideo: batch.maxCostPerVideo,
    maxCostForBatch: batch.maxBudget,
    suggestedAuthorizedMaxSpend: recommendation.recommended,
    // The slack inside the recommendation, pulled back out. Never negative: a
    // recommendation clamped by the global cap can sit BELOW the estimate, and
    // reporting that as a negative margin would read as a discount rather than
    // as the refusal it is - `clampedByGlobalCap` already warns about it.
    safetyMargin: round(Math.max(0, recommendation.recommended - estimatedTotal), 6),
    safetyMarginPercent:
      estimatedTotal > 0
        ? round(
            (Math.max(0, recommendation.recommended - estimatedTotal) / estimatedTotal) * 100,
            2,
          )
        : 0,
    overBatchCeiling: estimatedTotal > batch.maxBudget,
    globalRemaining: cap.remaining,
    counts: videos.reduce((into, v) => {
      into.imageBuy += v.counts.imageBuy;
      into.imageReuse += v.counts.imageReuse;
      into.videoBuy += v.counts.videoBuy;
      into.videoReuse += v.counts.videoReuse;
      into.voiceBuy += v.counts.voiceBuy;
      into.voiceReuse += v.counts.voiceReuse;
      return into;
    }, emptyCounts()),
    // Listed per vendor, never summed. `remainingUsd: null` means "we hold no
    // wallet for this vendor", which a renderer must show as "không rõ" rather
    // than as $0.00.
    providerWallets: wallets.map((w) => ({
      provider: w.provider,
      spentUsd: w.spentUsd,
      remainingUsd: w.remainingUsd,
      live: w.budget?.liveBalanceAvailable === true,
    })),
    costBasis: costing.costBasis,
    warnings,
  };
}
