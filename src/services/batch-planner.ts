import type {
  Complexity,
  MotionSource,
  QualityMode,
  SpendPriority,
  VideoPlanStatus,
} from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { round } from "@/lib/utils";
import { sceneCharacters } from "@/domain/scene-characters";
import {
  estimateProject,
  type CostBreakdown,
  type PlannedSceneInput,
  type ProjectEstimate,
} from "./cost-estimator";
import { availableProviderNames, productionProviderNames } from "./provider-health";
import {
  basisForProviders,
  recommendAuthorization,
  type CostBasis,
  type Recommendation,
} from "@/domain/cost-basis";
import { spendStatus, type SpendStatus } from "./spend-guard";
import { providerSpendBreakdown, type ProviderSpendRow } from "./provider-budget";
import { speechTextFor } from "./generation";

/**
 * Costing a batch BEFORE anything is approved, and without spending a cent.
 *
 * Everything here is reads: the idiom library, the model registry, the ledger.
 * No provider is contacted, so an operator can plan, re-plan and change their
 * mind as often as they like. That is the point of splitting planning from
 * approval - the expensive decision should be made by someone who has already
 * seen the number.
 *
 * ## The honest limitation, stated up front
 *
 * A video's real cost depends on its script: how many scenes, how complex, who
 * is in them. At planning time most of these videos have no script, because
 * writing one costs money (about $0.003 at Groq prices) and the operator has
 * not approved anything yet.
 *
 * So a video with no script is priced against a REFERENCE PROFILE - a
 * representative six-scene short, described below. Every such video is labelled
 * `reference-profile` in the plan, and the UI must show that label. Presenting
 * a modelled figure as a measured one is how a $4 batch becomes a $6 batch with
 * nobody at fault.
 *
 * The estimate is not the safeguard, though. The per-video ceiling is checked
 * again at generation time against the REAL script, and the batch ceiling is
 * checked before every single request. A bad estimate makes the plan wrong; it
 * cannot make the spending wrong.
 */

/**
 * A representative six-scene idiom short.
 *
 * Shaped from the three scripts that have actually been produced end to end:
 * a hook, a setup, two busier middle beats, and two cheap closing scenes.
 * Deliberately not an average of anything - it is one concrete plausible video,
 * which is easier to check against reality than a blended number.
 */
export const REFERENCE_SCENE_PROFILE: {
  sceneNumber: number;
  duration: number;
  complexity: Complexity;
  spendPriority: SpendPriority;
  characterCount: number;
  speechText: string;
}[] = [
  { sceneNumber: 1, duration: 3, complexity: "MEDIUM", spendPriority: "HIGH", characterCount: 1, speechText: "Break a leg!" },
  { sceneNumber: 2, duration: 5.5, complexity: "MEDIUM", spendPriority: "NORMAL", characterCount: 1, speechText: "Wait, you want me to do THAT?" },
  { sceneNumber: 3, duration: 5.5, complexity: "HIGH", spendPriority: "NORMAL", characterCount: 2, speechText: "I am VERY prepared." },
  { sceneNumber: 4, duration: 5, complexity: "HIGH", spendPriority: "HIGH", characterCount: 2, speechText: "That is NOT what I meant." },
  { sceneNumber: 5, duration: 3.5, complexity: "LOW", spendPriority: "LOW", characterCount: 2, speechText: "It just means good luck." },
  { sceneNumber: 6, duration: 3, complexity: "LOW", spendPriority: "LOW", characterCount: 2, speechText: "Break a leg on your interview!" },
];

export interface PlannedSceneRow {
  sceneNumber: number;
  complexity: Complexity;
  motionSource: MotionSource;
  motionReason: string;
  videoProvider: string | null;
  videoModel: string | null;
  estimatedCost: number;
  needsProvider?: string;
  /** Set when the chosen model would REJECT this scene's length as written. */
  durationTransform?: string;
}

export interface PlannedVideo {
  idiomId: string;
  phrase: string;
  /** Set when a project already exists, e.g. a resumed batch. */
  projectId: string | null;
  /** Whether this row was priced from a real script or the reference profile. */
  basis: "real-script" | "reference-profile";
  sceneCount: number;
  localMotionScenes: number;
  aiVideoScenes: number;
  scenes: PlannedSceneRow[];
  /** Every provider this video would pay, deduplicated. */
  providers: string[];
  breakdown: CostBreakdown;
  estimatedCost: number;
  status: VideoPlanStatus;
  warnings: string[];
}

/**
 * One costing of the same batch, against one set of providers.
 *
 * There are always two of these: what the batch will cost when it RUNS (mock
 * prices while mock mode is on) and what it would cost FOR REAL. Keeping them
 * as two values of the same shape - rather than one number and an adjective -
 * is what stops them being confused for each other on screen.
 */
export interface BatchCosting {
  costBasis: CostBasis;
  videos: PlannedVideo[];
  /** Sum over videos that are actually runnable. */
  estimatedTotal: number;
  /** Sum over every video, runnable or not. Shown so nothing is hidden. */
  estimatedTotalIncludingBlocked: number;
  runnableCount: number;
  blockedCount: number;
  /** Providers this costing would pay. */
  providerScope: string[];
  /** Scenes that want a video model nobody has cleared for them. */
  needsProvider: string[];
}

export interface BatchPlan {
  qualityMode: QualityMode;

  /**
   * The costing that will actually run if approved right now.
   *
   * In mock mode its `costBasis` is MOCK and its figures are SIMULATED. The UI
   * must say so rather than printing them as a forecast.
   */
  runtime: BatchCosting;

  /**
   * What the same batch would cost against real vendors at list prices.
   *
   * Null only when no real provider is configured at all - there is then
   * nothing honest to forecast, and the UI has to say that instead of falling
   * back to the mock number.
   */
  production: BatchCosting | null;

  /**
   * The forecast an operator should authorise money against.
   *
   * ALWAYS the production figure when there is one. Recommending a ceiling from
   * mock prices is the bug this whole structure exists to prevent.
   */
  recommendation: Recommendation;

  maxCostPerVideo: number;
  globalCap: SpendStatus;
  wallets: ProviderSpendRow[];
  warnings: string[];
  generatedAt: string;

  // ---- flattened aliases, kept so existing callers keep compiling ----
  /** Alias of `runtime.videos`. */
  videos: PlannedVideo[];
  /** Alias of `runtime.estimatedTotal`. */
  estimatedTotal: number;
  estimatedTotalIncludingBlocked: number;
  runnableCount: number;
  blockedCount: number;
  providerScope: string[];
  /** Alias of `recommendation.recommended`. */
  suggestedAuthorizedMaxSpend: number;
}

export interface PlanBatchInput {
  /** Explicit idiom picks. When empty, the library is filtered instead. */
  idiomIds?: string[];
  category?: string | null;
  difficulty?: string | null;
  amount: number;
  qualityMode: QualityMode;
  targetDuration: number;
  maxCostPerVideo: number;
}

/**
 * Which idioms this batch would use, in the order it would use them.
 *
 * Least-used first, so a library gets covered evenly rather than the same few
 * idioms being remade. Explicit picks win outright - an operator naming the
 * idioms has already decided.
 */
export async function selectIdioms(input: PlanBatchInput): Promise<
  { id: string; phrase: string }[]
> {
  if (input.idiomIds && input.idiomIds.length > 0) {
    const rows = await prisma.idiom.findMany({
      where: { id: { in: input.idiomIds } },
      select: { id: true, phrase: true },
    });
    // Preserve the operator's order rather than the database's.
    const byId = new Map(rows.map((r) => [r.id, r]));
    return input.idiomIds
      .map((id) => byId.get(id))
      .filter((r): r is { id: string; phrase: string } => r !== undefined);
  }

  return prisma.idiom.findMany({
    where: {
      status: { in: ["unused", "planned"] },
      ...(input.category ? { category: input.category } : {}),
      ...(input.difficulty ? { difficulty: input.difficulty } : {}),
    },
    orderBy: [{ timesUsed: "asc" }, { createdAt: "asc" }],
    take: Math.max(1, input.amount),
    select: { id: true, phrase: true },
  });
}

/** Scenes for one idiom: the real script when there is one, the profile when not. */
async function scenesFor(
  idiomId: string,
  batchId: string | null,
): Promise<{
  scenes: PlannedSceneInput[];
  basis: "real-script" | "reference-profile";
  projectId: string | null;
}> {
  // Only a project inside THIS batch counts. A project for the same idiom in
  // some other batch describes a different run with different settings, and
  // pricing against it would quietly import decisions nobody made here.
  const project = batchId
    ? await prisma.project.findFirst({
        where: { idiomId, batchId },
        orderBy: { createdAt: "desc" },
        include: { scenes: { where: { skipped: false }, orderBy: { sceneNumber: "asc" } } },
      })
    : null;

  if (project && project.scenes.length > 0) {
    return {
      projectId: project.id,
      basis: "real-script",
      scenes: project.scenes.map((scene) => ({
        sceneNumber: scene.sceneNumber,
        duration: scene.duration,
        complexity: scene.complexity as Complexity,
        spendPriority: scene.spendPriority as SpendPriority,
        characterCount: sceneCharacters(scene).present.length || 1,
        speechText: speechTextFor(scene),
        manualImageProvider: scene.imageProvider,
        manualImageModel: scene.imageModel,
        manualVideoProvider: scene.videoProvider,
        manualVideoModel: scene.videoModel,
        manualVoiceProvider: scene.voiceProvider,
        manualVoiceModel: scene.voiceModel,
      })),
    };
  }

  return {
    projectId: project?.id ?? null,
    basis: "reference-profile",
    scenes: REFERENCE_SCENE_PROFILE.map((s) => ({ ...s })),
  };
}

function toPlannedVideo(
  idiom: { id: string; phrase: string },
  estimate: ProjectEstimate,
  basis: "real-script" | "reference-profile",
  projectId: string | null,
  maxCostPerVideo: number,
): PlannedVideo {
  const scenes: PlannedSceneRow[] = estimate.scenes.map((plan) => ({
    sceneNumber: plan.sceneNumber,
    complexity: plan.complexity,
    motionSource: plan.motionSource,
    motionReason: plan.motionReason,
    videoProvider: plan.video?.provider ?? null,
    videoModel: plan.video?.modelId ?? null,
    estimatedCost: plan.estimatedCost,
    needsProvider: plan.needsProvider,
    durationTransform:
      plan.duration_plan?.status === "DURATION_TRANSFORM_REQUIRED"
        ? plan.duration_plan.reason
        : undefined,
  }));

  const providers = [
    ...new Set(
      [
        // The script's provider is chosen once for the whole project rather
        // than per scene, so walking `scenes` alone misses it - and a scope
        // that names every vendor except the one that writes the script would
        // refuse the very first paid call the batch makes.
        estimate.textProvider,
        ...estimate.scenes.flatMap((p) => [p.image, p.video, p.voice, p.quality]),
      ]
        .map((d) => (typeof d === "string" ? d : d?.provider))
        .filter((name): name is string => typeof name === "string")
        // Mock is not a vendor and must never appear in a provider scope: it
        // would read as approval to pay someone.
        .filter((name) => name !== "mock"),
    ),
  ].sort();

  const warnings: string[] = [...estimate.errors, ...estimate.needsProvider];

  // A length the vendor would reject is not a rounding detail - the request
  // cannot leave as written, and shortening a scene to suit an API changes the
  // video. Surfaced here so the plan table shows it instead of quietly pricing
  // a transformed request as though it were the one that was asked for.
  for (const plan of estimate.scenes) {
    if (plan.duration_plan?.status === "DURATION_TRANSFORM_REQUIRED") {
      warnings.push(`Cảnh ${plan.sceneNumber}: ${plan.duration_plan.reason}`);
    }
  }

  // Order matters, and so does telling the two blockers apart. They send the
  // operator to different places: NEEDS_PROVIDER means approve a model,
  // OVER_VIDEO_BUDGET means raise a ceiling or pick a cheaper mode. Labelling a
  // budget problem as a provider problem is how someone spends an afternoon in
  // the model registry fixing nothing.
  //
  // The budget verdict is checked first because it is the one that ALSO
  // explains a routing failure: when the per-video ceiling is what the router
  // ran out of, every downstream "no model fits" is a symptom of it.
  const ranOutOfBudget = estimate.errorCodes.includes("over_budget");
  const overCeiling = estimate.breakdown.total > maxCostPerVideo;

  let status: VideoPlanStatus = "OK";
  if (ranOutOfBudget || overCeiling) {
    status = "OVER_VIDEO_BUDGET";
    warnings.push(
      ranOutOfBudget
        ? `Hạn mức $${maxCostPerVideo.toFixed(2)} cho một video không đủ để định ` +
          `tuyến hết các cảnh. Hãy nâng hạn mức/video hoặc đổi sang chế độ rẻ hơn.`
        : `Dự toán $${estimate.breakdown.total.toFixed(4)} vượt hạn mức ` +
          `$${maxCostPerVideo.toFixed(2)} cho một video.`,
    );
  } else if (estimate.needsProvider.length > 0 || estimate.errors.length > 0) {
    status = "NEEDS_PROVIDER";
  }

  if (basis === "reference-profile") {
    warnings.push(
      "Chưa có kịch bản thật nên dự toán dựa trên kịch bản mẫu 6 cảnh. " +
        "Chi phí thật sẽ được kiểm tra lại theo kịch bản thật trước khi chi.",
    );
  }

  return {
    idiomId: idiom.id,
    phrase: idiom.phrase,
    projectId,
    basis,
    sceneCount: estimate.scenes.length,
    localMotionScenes: estimate.localMotionScenes,
    aiVideoScenes: estimate.aiVideoScenes,
    scenes,
    providers,
    breakdown: estimate.breakdown,
    estimatedCost: estimate.breakdown.total,
    status,
    warnings,
  };
}

/**
 * Build the whole plan. Reads only; contacts nobody; costs nothing.
 *
 * Each video is priced in isolation against the PER-VIDEO ceiling, not against
 * a share of a batch budget that does not exist yet. Pricing them against a
 * running remainder would make video 8 look cheap simply because videos 1-7 had
 * already eaten the money, which is backwards: the operator needs to see what
 * each video costs before deciding how much to authorise for all of them.
 */
/** Cost one set of idioms against one set of providers. Pure reads. */
async function costAgainst(
  idioms: { id: string; phrase: string }[],
  models: Awaited<ReturnType<typeof prisma.modelRegistry.findMany>>,
  providers: string[],
  input: PlanBatchInput,
  batchId: string | null,
): Promise<BatchCosting> {
  const videos: PlannedVideo[] = [];

  for (const idiom of idioms) {
    const { scenes, basis, projectId } = await scenesFor(idiom.id, batchId);
    const estimate = estimateProject({
      scenes,
      models,
      qualityMode: input.qualityMode,
      strategy: "AUTO",
      // The per-video ceiling IS the budget a single video is planned against.
      maxBudget: input.maxCostPerVideo,
      availableProviders: providers,
      // 1080p is a QUALITY-mode demand, matching services/generation.
      needs1080p: input.qualityMode === "QUALITY",
    });
    videos.push(
      toPlannedVideo(idiom, estimate, basis, projectId, input.maxCostPerVideo),
    );
  }

  const runnable = videos.filter((v) => v.status === "OK");
  return {
    costBasis: basisForProviders(providers),
    videos,
    estimatedTotal: round(
      runnable.reduce((sum, v) => sum + v.estimatedCost, 0),
      6,
    ),
    estimatedTotalIncludingBlocked: round(
      videos.reduce((sum, v) => sum + v.estimatedCost, 0),
      6,
    ),
    runnableCount: runnable.length,
    blockedCount: videos.length - runnable.length,
    providerScope: [...new Set(runnable.flatMap((v) => v.providers))].sort(),
    needsProvider: [
      ...new Set(
        videos.flatMap((v) =>
          v.scenes
            .filter((scene) => scene.needsProvider !== undefined)
            .map((scene) => `${v.phrase} cảnh ${scene.sceneNumber}: ${scene.needsProvider}`),
        ),
      ),
    ],
  };
}

/**
 * Build the whole plan. Reads only; contacts nobody; costs nothing.
 *
 * The batch is costed TWICE, against two different provider sets:
 *
 *   runtime     who the router can actually call right now. In mock mode that
 *               is `mock` alone, so these figures are SIMULATED.
 *   production  who would be reachable with mock mode off, at real list prices.
 *               This is the forecast money gets authorised against.
 *
 * Doing only the first is the bug this replaced: every "Tổng chi phí dự kiến"
 * the batch page showed was built from mock prices and presented as a forecast
 * of real spending, and mock prices are not close - mock voice is 25x OpenAI's
 * real rate, mock image is under half gpt-image-2's.
 *
 * Each video is priced against the PER-VIDEO ceiling, not against a running
 * remainder. Pricing them against a remainder would make video 8 look cheap
 * simply because videos 1-7 had eaten the money, which is backwards: the
 * operator needs to see what each video costs before deciding how much to
 * authorise for all of them.
 */
export async function planBatch(
  input: PlanBatchInput,
  batchId: string | null = null,
): Promise<BatchPlan> {
  const [idioms, models, runtimeProviders, prodProviders, globalCap, wallets] =
    await Promise.all([
      selectIdioms(input),
      prisma.modelRegistry.findMany({ where: { enabled: true } }),
      availableProviderNames(),
      productionProviderNames(),
      spendStatus(),
      providerSpendBreakdown(),
    ]);

  const runtime = await costAgainst(idioms, models, runtimeProviders, input, batchId);

  // Recomputed against real vendors even while mock mode is on. Skipped only
  // when no real provider is configured at all - there is then nothing honest
  // to forecast, and saying so beats quoting the mock number.
  const production =
    prodProviders.length > 0
      ? await costAgainst(idioms, models, prodProviders, input, batchId)
      : null;

  // The ceiling is recommended from the PRODUCTION figure whenever there is
  // one. Recommending from mock prices is exactly how a made-up number reaches
  // the approval box.
  const basisForMoney = production ?? runtime;
  const recommendation = recommendAuthorization(
    basisForMoney.estimatedTotal,
    globalCap.remaining,
  );

  const warnings: string[] = [];
  if (idioms.length < input.amount) {
    warnings.push(
      `Yêu cầu ${input.amount} video nhưng chỉ tìm được ${idioms.length} thành ngữ ` +
        `phù hợp. Lô sẽ chỉ chạy ${idioms.length} video.`,
    );
  }
  if (runtime.blockedCount > 0) {
    warnings.push(
      `${runtime.blockedCount} video bị chặn và sẽ KHÔNG tự chạy. ` +
        `Xem cột trạng thái để biết lý do.`,
    );
  }
  if (runtime.costBasis === "MOCK") {
    warnings.push(
      production
        ? `Đang ở Mock Mode: bảng dưới dùng GIÁ GIẢ LẬP, không phải tiền. Dự toán ` +
          `chạy thật là $${production.estimatedTotal.toFixed(4)} — đó mới là con ` +
          `số để duyệt hạn mức.`
        : `Đang ở Mock Mode và chưa có nhà cung cấp thật nào được cấu hình, nên ` +
          `KHÔNG có dự toán chạy thật. Mọi con số dưới đây là giá giả lập.`,
    );
  }
  if (production && production.needsProvider.length > 0) {
    warnings.push(
      `${production.needsProvider.length} cảnh chưa có nhà cung cấp được duyệt ` +
        `cho độ khó của nó. Những cảnh này sẽ KHÔNG được tự định tuyến.`,
    );
  }
  if (recommendation.clampedByGlobalCap) {
    warnings.push(
      `Dự toán $${basisForMoney.estimatedTotal.toFixed(4)} vượt phần còn lại của ` +
        `hạn mức toàn ứng dụng ($${globalCap.remaining.toFixed(6)}). Lô sẽ dừng ở ` +
        `BUDGET_EXHAUSTED trước khi chạy hết.`,
    );
  }

  return {
    qualityMode: input.qualityMode,
    runtime,
    production,
    recommendation,
    maxCostPerVideo: input.maxCostPerVideo,
    globalCap,
    wallets,
    warnings,
    generatedAt: new Date().toISOString(),

    videos: runtime.videos,
    estimatedTotal: runtime.estimatedTotal,
    estimatedTotalIncludingBlocked: runtime.estimatedTotalIncludingBlocked,
    runnableCount: runtime.runnableCount,
    blockedCount: runtime.blockedCount,
    providerScope: runtime.providerScope,
    suggestedAuthorizedMaxSpend: recommendation.recommended,
  };
}

/**
 * Kept as a thin alias of `recommendAuthorization`.
 *
 * The margin logic moved to domain/cost-basis, next to the CostBasis type, so
 * that the rule "recommend from the PRODUCTION figure, never the mock one"
 * lives beside the type that tells them apart.
 */
export function suggestCeiling(estimatedTotal: number, globalRemaining: number): number {
  return recommendAuthorization(estimatedTotal, globalRemaining).recommended;
}
