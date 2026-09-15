import type { ModelRegistry } from "@prisma/client";
import type {
  Complexity,
  CostCategory,
  MotionSource,
  QualityMode,
  RouterStrategy,
  SpendPriority,
} from "@/domain/enums";
import { decideMotion, keyframeRequired } from "@/domain/local-motion";
import { planDuration, splitModelSize, type DurationPlan } from "@/domain/video-duration";
import { basisForProviders, type CostBasis } from "@/domain/cost-basis";
import { routeScene, RoutingError, type RouteDecision } from "./ai-router";
import { costForModel, expectedRetryMultiplier } from "./pricing";
import { round } from "@/lib/utils";

/**
 * Cost estimation and preview.
 *
 * Two jobs:
 *  1. Tell the operator what a project will cost in each mode *before* any money
 *     moves, broken down by stage so it is obvious where the money goes.
 *  2. Produce the per-scene routing plan the generator will actually follow, so
 *     the estimate and the execution cannot drift apart.
 */

export interface PlannedSceneInput {
  sceneNumber: number;
  duration: number;
  complexity: Complexity;
  spendPriority: SpendPriority;
  characterCount: number;
  /** Spoken text for this scene (dialogue + narration). */
  speechText: string;
  manualImageProvider?: string | null;
  manualImageModel?: string | null;
  manualVideoProvider?: string | null;
  manualVideoModel?: string | null;
  manualVoiceProvider?: string | null;
  manualVoiceModel?: string | null;
}

export interface ScenePlan {
  sceneNumber: number;
  duration: number;
  complexity: Complexity;
  spendPriority: SpendPriority;
  image: RouteDecision | null;
  /** Null whenever `motionSource` is LOCAL_MOTION - no model is called. */
  video: RouteDecision | null;
  voice: RouteDecision | null;
  quality: RouteDecision | null;
  /** Where this scene's movement comes from, and why. */
  motionSource: MotionSource;
  motionReason: string;
  /**
   * What length would really be sent to the chosen video model.
   *
   * Null for a locally animated scene. When its status is
   * DURATION_TRANSFORM_REQUIRED the scene cannot be sent as written - the price
   * beside it is for the TRANSFORMED request, which is the honest number, but
   * the transform itself is a content decision nobody has taken yet.
   */
  duration_plan: DurationPlan | null;
  /**
   * Set when the scene WANTS a video model and none may serve it.
   *
   * Deliberately not folded into `error`: those are different situations and
   * lead to different actions. `error` means the plan is broken. This means the
   * plan is fine but a provider still has to be approved before it can run, and
   * the honest response is to say so rather than quietly animate a still and
   * call it the same video.
   */
  needsProvider?: string;
  /**
   * The routing failure's code, when one occurred.
   *
   * Carried alongside the message because the two answer different questions.
   * "over_budget" and "no_capable_models" both read as "the scene did not
   * route", but one means the ceiling is too low and the other means no model
   * can do the work - and telling an operator to approve a provider when the
   * real problem is their own budget sends them to fix the wrong thing.
   */
  errorCode?: RoutingError["code"];
  estimatedCost: number;
  error?: string;
}

export interface CostBreakdown {
  text: number;
  image: number;
  video: number;
  voice: number;
  upscale: number;
  quality: number;
  retries: number;
  total: number;
}

export interface ProjectEstimate {
  qualityMode: QualityMode;
  scenes: ScenePlan[];
  breakdown: CostBreakdown;
  /** Populated when a scene could not be routed at all. */
  errors: string[];
  /** Scenes that want a video model nobody has approved for them. */
  needsProvider: string[];
  /** Routing failure codes seen across the scenes, deduplicated. */
  errorCodes: RoutingError["code"][];
  /**
   * Whether these figures are simulated or a real forecast.
   *
   * Derived from the providers that were actually routable, not passed in: a
   * flag a caller must remember to set is a flag that eventually gets set
   * wrong, and getting this one wrong is precisely how a mock price reached the
   * approval screen labelled as a forecast.
   */
  costBasis: CostBasis;
  /**
   * The provider that would write the script, or null when none is available.
   *
   * Exposed because the text model is chosen HERE rather than per scene, so it
   * is invisible to anything that walks `scenes` looking for providers. A batch
   * approval built that way would name every vendor except the one that writes
   * the script - and then refuse the script as out of scope.
   */
  textProvider: string | null;
  /** How many scenes are animated locally for $0. */
  localMotionScenes: number;
  /** How many scenes call a paid video model. */
  aiVideoScenes: number;
  withinBudget: boolean;
  maxBudget: number;
}

export interface EstimateInput {
  scenes: PlannedSceneInput[];
  models: ModelRegistry[];
  qualityMode: QualityMode;
  strategy: RouterStrategy;
  maxBudget: number;
  availableProviders: string[];
  needs1080p?: boolean;
  aspectWidth?: number;
}

/**
 * Whether a scene gets its own keyframe image.
 *
 * Keyframes are the main lever for character consistency, so they are on by
 * default. ECONOMY skips them for simple scenes - a static explanation card does
 * not need a reference pass to look right - but keeps them where two characters
 * share the frame and drift would be obvious.
 */
export function shouldGenerateKeyframe(
  mode: QualityMode,
  complexity: Complexity,
  characterCount: number,
): boolean {
  if (mode === "ECONOMY") return complexity === "HIGH" || characterCount >= 2;
  return true;
}

/** Whether the generated scene gets scored afterwards. */
export function shouldEvaluateQuality(
  mode: QualityMode,
  spendPriority: SpendPriority,
): boolean {
  if (mode === "ECONOMY") return false;
  if (mode === "QUALITY") return true;
  // Balanced: only check the scenes viewers actually judge the video on.
  return spendPriority === "HIGH";
}

export function estimateProject(input: EstimateInput): ProjectEstimate {
  const {
    scenes,
    models,
    qualityMode,
    strategy,
    maxBudget,
    availableProviders,
  } = input;

  const breakdown: CostBreakdown = {
    text: 0,
    image: 0,
    video: 0,
    voice: 0,
    upscale: 0,
    quality: 0,
    retries: 0,
    total: 0,
  };
  const errors: string[] = [];
  const needsProvider: string[] = [];
  const errorCodes: RoutingError["code"][] = [];

  // One script generation + one self-scoring pass + one metadata pass.
  const textModel = pickCheapestEnabled(models, "text", availableProviders);
  if (textModel) {
    breakdown.text = round(
      costForModel(textModel, { tokens: 4500, jobs: 1 }) +
        costForModel(textModel, { tokens: 1500, jobs: 1 }) +
        costForModel(textModel, { tokens: 900, jobs: 1 }),
    );
  }

  // Budget is consumed as we walk the scenes, so a later scene genuinely sees
  // less headroom - the same thing that happens during real generation.
  let spent = breakdown.text;
  const plans: ScenePlan[] = [];

  for (const scene of scenes) {
    const remaining = Math.max(0, maxBudget - spent);
    const plan = planScene({
      scene,
      models,
      qualityMode,
      strategy,
      availableProviders,
      budgetRemaining: remaining,
      needs1080p: input.needs1080p ?? false,
    });
    plans.push(plan);
    if (plan.error) errors.push(`Cảnh ${scene.sceneNumber}: ${plan.error}`);
    if (plan.needsProvider) {
      needsProvider.push(`Cảnh ${scene.sceneNumber}: ${plan.needsProvider}`);
    }
    if (plan.errorCode && !errorCodes.includes(plan.errorCode)) {
      errorCodes.push(plan.errorCode);
    }

    breakdown.image += plan.image?.estimatedCost ?? 0;
    breakdown.video += plan.video?.estimatedCost ?? 0;
    breakdown.voice += plan.voice?.estimatedCost ?? 0;
    breakdown.quality += plan.quality?.estimatedCost ?? 0;
    spent += plan.estimatedCost;
  }

  const subtotal =
    breakdown.text +
    breakdown.image +
    breakdown.video +
    breakdown.voice +
    breakdown.quality +
    breakdown.upscale;

  // Retries are a real, predictable cost. Estimating without them is how a
  // "$3 video" turns into $5 and destroys trust in the number.
  const avgSuccess = averageSuccessRate(plans, models);
  breakdown.retries = round(
    subtotal * (expectedRetryMultiplier(qualityMode, avgSuccess) - 1),
  );

  breakdown.image = round(breakdown.image);
  breakdown.video = round(breakdown.video);
  breakdown.voice = round(breakdown.voice);
  breakdown.quality = round(breakdown.quality);
  breakdown.total = round(subtotal + breakdown.retries);

  return {
    qualityMode,
    scenes: plans,
    breakdown,
    errors,
    needsProvider,
    errorCodes,
    costBasis: basisForProviders(availableProviders),
    textProvider: textModel?.provider ?? null,
    localMotionScenes: plans.filter((p) => p.motionSource === "LOCAL_MOTION").length,
    aiVideoScenes: plans.filter((p) => p.motionSource === "AI_VIDEO").length,
    // An incomplete plan is not an affordable one. When a scene could not be
    // routed - usually because the budget ran out partway through - its cost is
    // zero, which would otherwise make an impossible project look cheap.
    //
    // A scene waiting on a provider counts the same way. Its video cost is zero
    // because nothing was routed, and letting that read as "affordable" is how
    // an unrunnable plan gets approved.
    withinBudget:
      breakdown.total <= maxBudget &&
      errors.length === 0 &&
      needsProvider.length === 0,
    maxBudget,
  };
}

export function planScene(opts: {
  scene: PlannedSceneInput;
  models: ModelRegistry[];
  qualityMode: QualityMode;
  strategy: RouterStrategy;
  availableProviders: string[];
  budgetRemaining: number;
  needs1080p: boolean;
}): ScenePlan {
  const {
    scene,
    models,
    qualityMode,
    strategy,
    availableProviders,
    needs1080p,
  } = opts;

  // Decide where the movement comes from FIRST. Everything below depends on it:
  // a locally animated scene calls no video model, and - the part that is easy
  // to get wrong - it makes the keyframe mandatory rather than optional.
  const motion = decideMotion({
    qualityMode,
    complexity: scene.complexity,
    spendPriority: scene.spendPriority,
    characterCount: scene.characterCount,
  });

  const wantsKeyframe = keyframeRequired(
    motion.source,
    shouldGenerateKeyframe(qualityMode, scene.complexity, scene.characterCount),
  );
  const wantsQuality = shouldEvaluateQuality(qualityMode, scene.spendPriority);

  let remaining = opts.budgetRemaining;
  let error: string | undefined;
  let needsProvider: string | undefined;
  let errorCode: RoutingError["code"] | undefined;

  const routeOrNull = (
    type: "image" | "video" | "voice" | "quality",
    enabled: boolean,
    usage: { seconds?: number; images?: number; characters?: number; jobs?: number },
    manualProvider?: string | null,
    manualModel?: string | null,
    /**
     * A stage the pipeline runs without, when nothing can serve it.
     *
     * `evaluateScene` catches RoutingError and returns null - "no quality model
     * configured is not a pipeline failure, just skip". The estimator did not
     * mirror that, so a registry with no real quality model made every
     * high-priority scene report an error and the whole video read as
     * unrunnable - for a stage that would have been skipped silently at
     * runtime. An estimate that refuses work the generator would happily do is
     * worse than no estimate: it hides a video that was fine.
     */
    optional = false,
  ): RouteDecision | null => {
    if (!enabled || error) return null;
    try {
      const decision = routeScene(models, {
        type,
        qualityMode,
        strategy,
        complexity: scene.complexity,
        spendPriority: scene.spendPriority,
        durationSeconds: scene.duration,
        characterCount: scene.characterCount,
        // Characters must look the same in every scene of every video, so the
        // image and video stages always demand reference support.
        consistencyRequired: type === "image" || type === "video",
        needs1080p: type === "video" ? needs1080p : false,
        needsReferenceImage: type === "video" ? wantsKeyframe : false,
        budgetRemaining: remaining,
        usage,
        availableProviders,
        manualProvider,
        manualModel,
      });
      remaining = Math.max(0, remaining - decision.estimatedCost);
      return decision;
    } catch (err) {
      if (err instanceof RoutingError) {
        if (optional) return null;
        error = err.message;
        errorCode = err.code;
        return null;
      }
      throw err;
    }
  };

  const image = routeOrNull(
    "image",
    wantsKeyframe,
    { images: 1, jobs: 1 },
    scene.manualImageProvider,
    scene.manualImageModel,
  );
  // A locally animated scene never reaches the router, so it can neither cost
  // anything nor fail for want of a provider.
  //
  // `errorBeforeVideo` is remembered because `routeOrNull` refuses to route once
  // anything has failed. Without it, an image failure would be re-read as "no
  // video provider" further down and reported as the wrong problem.
  const errorBeforeVideo = error;
  const video =
    motion.source === "AI_VIDEO"
      ? routeOrNull(
          "video",
          true,
          { seconds: scene.duration, jobs: 1 },
          scene.manualVideoProvider,
          scene.manualVideoModel,
        )
      : null;

  // A scene that wants a video model and cannot HAVE one is not the same as a
  // broken plan, and must not be silently redirected to a still either. Say
  // which it is and let a person decide - guessing here is how a batch spends
  // money on a model nobody cleared, or ships a slideshow labelled as a video.
  //
  // "Cannot have one" means no model is cleared for the work. Running out of
  // budget is a different sentence with a different fix, and reporting it as a
  // missing provider sends the operator to the model registry to solve a
  // problem that lives in their own ceiling.
  const MISSING_PROVIDER: RoutingError["code"][] = [
    "no_models",
    "no_capable_models",
    "needs_explicit_pin",
    "manual_not_found",
  ];
  if (
    motion.source === "AI_VIDEO" &&
    !video &&
    error &&
    error !== errorBeforeVideo &&
    errorCode !== undefined &&
    MISSING_PROVIDER.includes(errorCode)
  ) {
    needsProvider = error;
    error = errorBeforeVideo;
  }
  const speechChars = scene.speechText.trim().length;
  const voice = routeOrNull(
    "voice",
    speechChars > 0,
    { characters: speechChars, jobs: 1 },
    scene.manualVoiceProvider,
    scene.manualVoiceModel,
  );
  // Optional: the generator skips scoring when no quality model is configured,
  // so the estimate has to as well.
  const quality = routeOrNull("quality", wantsQuality, { jobs: 1 }, null, null, true);

  // What length the chosen model would actually accept. Computed from the
  // decision that was made, so it cannot describe a different model than the
  // one being priced.
  const durationPlan: DurationPlan | null = video
    ? planDuration({
        provider: video.provider,
        model: video.modelId,
        size: splitModelSize(video.modelId).size,
        requestedSeconds: scene.duration,
        hasKeyframe: wantsKeyframe,
      })
    : null;

  const estimatedCost = round(
    (image?.estimatedCost ?? 0) +
      (video?.estimatedCost ?? 0) +
      (voice?.estimatedCost ?? 0) +
      (quality?.estimatedCost ?? 0),
  );

  return {
    sceneNumber: scene.sceneNumber,
    duration: scene.duration,
    complexity: scene.complexity,
    spendPriority: scene.spendPriority,
    image,
    video,
    voice,
    quality,
    motionSource: motion.source,
    motionReason: motion.reason,
    duration_plan: durationPlan,
    needsProvider,
    errorCode,
    estimatedCost,
    error,
  };
}

/** Side-by-side preview of all three automatic modes. */
export function estimateAllModes(
  input: Omit<EstimateInput, "qualityMode">,
): Record<"ECONOMY" | "BALANCED" | "QUALITY", ProjectEstimate> {
  const modes: ("ECONOMY" | "BALANCED" | "QUALITY")[] = [
    "ECONOMY",
    "BALANCED",
    "QUALITY",
  ];
  const out = {} as Record<"ECONOMY" | "BALANCED" | "QUALITY", ProjectEstimate>;
  for (const mode of modes) {
    out[mode] = estimateProject({
      ...input,
      qualityMode: mode,
      // A mode preview should show the mode's own default behaviour, not a
      // strategy the operator pinned for a different mode.
      strategy: "AUTO",
      // Same reason for 1080p: it is a demand QUALITY makes and the other two
      // modes do not. Carrying one flag across all three would price ECONOMY
      // as though it insisted on native 1080p, and exclude every model that
      // does not have it.
      needs1080p: mode === "QUALITY",
    });
  }
  return out;
}

function pickCheapestEnabled(
  models: ModelRegistry[],
  type: string,
  availableProviders: string[],
): ModelRegistry | null {
  const pool = models
    .filter(
      (m) =>
        m.type === type &&
        m.enabled &&
        availableProviders.includes(m.provider),
    )
    .sort((a, b) => a.price - b.price);
  return pool[0] ?? null;
}

function averageSuccessRate(
  plans: ScenePlan[],
  models: ModelRegistry[],
): number {
  const lookup = new Map(
    models.map((m) => [`${m.provider}/${m.modelId}`, m.historicalSuccessRate]),
  );
  const rates: number[] = [];
  for (const plan of plans) {
    for (const decision of [plan.image, plan.video, plan.voice]) {
      if (!decision) continue;
      const rate = lookup.get(`${decision.provider}/${decision.modelId}`);
      if (typeof rate === "number") rates.push(rate);
    }
  }
  if (rates.length === 0) return 1;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}

export const COST_CATEGORY_LABELS: Record<CostCategory, string> = {
  text: "Kịch bản (Text AI)",
  image: "Ảnh (Image AI)",
  video: "Video (Video AI)",
  voice: "Giọng đọc (Voice AI)",
  upscale: "Nâng cấp độ phân giải",
  quality: "Đánh giá chất lượng",
  retry: "Dự phòng tạo lại",
};
