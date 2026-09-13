import type { ModelRegistry } from "@prisma/client";
import type {
  Complexity,
  CostCategory,
  QualityMode,
  RouterStrategy,
  SpendPriority,
} from "@/domain/enums";
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
  video: RouteDecision | null;
  voice: RouteDecision | null;
  quality: RouteDecision | null;
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
    // An incomplete plan is not an affordable one. When a scene could not be
    // routed - usually because the budget ran out partway through - its cost is
    // zero, which would otherwise make an impossible project look cheap.
    withinBudget: breakdown.total <= maxBudget && errors.length === 0,
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

  const wantsKeyframe = shouldGenerateKeyframe(
    qualityMode,
    scene.complexity,
    scene.characterCount,
  );
  const wantsQuality = shouldEvaluateQuality(qualityMode, scene.spendPriority);

  let remaining = opts.budgetRemaining;
  let error: string | undefined;

  const routeOrNull = (
    type: "image" | "video" | "voice" | "quality",
    enabled: boolean,
    usage: { seconds?: number; images?: number; characters?: number; jobs?: number },
    manualProvider?: string | null,
    manualModel?: string | null,
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
        error = err.message;
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
  const video = routeOrNull(
    "video",
    true,
    { seconds: scene.duration, jobs: 1 },
    scene.manualVideoProvider,
    scene.manualVideoModel,
  );
  const speechChars = scene.speechText.trim().length;
  const voice = routeOrNull(
    "voice",
    speechChars > 0,
    { characters: speechChars, jobs: 1 },
    scene.manualVoiceProvider,
    scene.manualVoiceModel,
  );
  const quality = routeOrNull("quality", wantsQuality, { jobs: 1 });

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
