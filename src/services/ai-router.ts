import type { ModelRegistry } from "@prisma/client";
import type {
  Complexity,
  ModelType,
  QualityMode,
  RouterStrategy,
  SpendPriority,
} from "@/domain/enums";
import { isAutoRoutable } from "@/domain/enums";
import { autoRouteBlock } from "./provider-catalog";
import { costForModel, qualityIndex, valueIndex, type UsageUnits } from "./pricing";
import { planDuration, splitModelSize } from "@/domain/video-duration";
import { checkSuitability, requiresExplicitPin } from "@/domain/video-suitability";
import { round } from "@/lib/utils";

/**
 * AIRouterService - decides which provider/model generates each individual
 * scene.
 *
 * The product principle is "quality per dollar", not "cheapest" and not "best".
 * Concretely that means:
 *   - every scene is routed on its own, so one video can mix a cheap model for
 *     a static explanation card with a stronger one for the punchline;
 *   - each mode sets a *minimum acceptable quality* that scales with the scene's
 *     complexity and spend priority, and then buys the best value at or above
 *     that floor rather than the most expensive option available;
 *   - the remaining budget is a hard ceiling that can force a downgrade, and if
 *     even the cheapest feasible model does not fit, routing fails loudly
 *     instead of silently overspending.
 */

export interface RouteContext {
  type: ModelType;
  qualityMode: QualityMode;
  strategy: RouterStrategy;
  complexity: Complexity;
  spendPriority: SpendPriority;
  durationSeconds: number;
  characterCount: number;
  /** Character identity must hold across scenes - weights consistency. */
  consistencyRequired: boolean;
  needs1080p: boolean;
  needsReferenceImage: boolean;
  /**
   * Whether a keyframe image actually exists to send, as opposed to whether one
   * is wanted. Only affects video billing (Veo's 8-second rule). Left undefined,
   * `needsReferenceImage` stands in for it.
   */
  keyframeAvailable?: boolean;
  /**
   * Markers recorded against this scene, such as RUNWAY_UNSUITABLE.
   *
   * A provider that has already refused this exact scene is excluded from it:
   * the two scene-4 attempts were byte-identical and failed identically, and a
   * third would have done the same.
   */
  sceneFlags?: string[];
  /** Dollars still available for this project/batch. */
  budgetRemaining: number;
  usage: UsageUnits;
  /** Provider names currently usable (key present, enabled, not rate limited). */
  availableProviders: string[];
  /** Manual pin. Honoured in CUSTOM/MANUAL, and respected everywhere else too. */
  manualProvider?: string | null;
  manualModel?: string | null;
}

export interface RouteCandidate {
  provider: string;
  modelId: string;
  displayName: string;
  estimatedCost: number;
  quality: number;
  value: number;
}

export interface RouteDecision {
  provider: string;
  modelId: string;
  displayName: string;
  estimatedCost: number;
  quality: number;
  /** Human-readable Vietnamese explanation shown in the storyboard editor. */
  reason: string;
  /** Ordered alternates to try if the chosen model fails. */
  fallbacks: RouteCandidate[];
  /** True when the budget forced something weaker than the mode wanted. */
  downgraded: boolean;
}

export class RoutingError extends Error {
  constructor(
    message: string,
    readonly code:
      | "no_models"
      | "no_capable_models"
      | "needs_explicit_pin"
      | "over_budget"
      | "manual_not_found",
  ) {
    super(message);
    this.name = "RoutingError";
  }
}

/**
 * Minimum quality index a model must reach to be considered, given how much the
 * viewer will notice this particular scene. This is the heart of "use cheaper AI
 * where the difference is not noticeable".
 */
export function qualityFloor(
  mode: QualityMode,
  complexity: Complexity,
  spendPriority: SpendPriority,
): number {
  const complexityBump =
    complexity === "HIGH" ? 1.5 : complexity === "MEDIUM" ? 0.75 : 0;
  const priorityBump =
    spendPriority === "HIGH" ? 1.5 : spendPriority === "LOW" ? -0.75 : 0;

  const base: Record<QualityMode, number> = {
    // Economy takes usable output and stops there; it only escalates when the
    // scene genuinely cannot be produced by a weak model.
    ECONOMY: 3,
    BALANCED: 5,
    QUALITY: 7,
    CUSTOM: 5,
  };

  const floor = base[mode] + complexityBump + priorityBump;
  // Economy refuses to be talked into premium tiers by a busy scene.
  const cap = mode === "ECONOMY" ? 5.5 : 9.5;
  return Math.min(cap, Math.max(1, round(floor, 2)));
}

/** Does this model physically support what the scene needs? */
/**
 * Why a model cannot serve this scene, in words.
 *
 * Mirrors `isCapable` in the same order. Kept next to it so a new capability
 * check added there without a matching reason here is obvious in review.
 */
export function explainIncapable(model: ModelRegistry, ctx: RouteContext): string {
  if (!model.enabled) return "model đang bị tắt trong bảng Mô hình AI";
  if (model.type !== ctx.type) {
    return `model thuộc loại "${model.type}", cảnh này cần "${ctx.type}"`;
  }
  if (!ctx.availableProviders.includes(model.provider)) {
    return `nhà cung cấp "${model.provider}" chưa sẵn sàng (thiếu key, đang tắt, hoặc bị giới hạn tần suất)`;
  }
  if (ctx.type === "video") {
    if (model.maxDuration > 0 && ctx.durationSeconds > model.maxDuration) {
      return `cảnh dài ${ctx.durationSeconds}s nhưng model chỉ hỗ trợ tối đa ${model.maxDuration}s`;
    }
    if (ctx.needsReferenceImage && !model.supportsImageToVideo) {
      return "cảnh cần image-to-video nhưng model không hỗ trợ";
    }
    if (ctx.needs1080p && !model.supports1080p) {
      return "chế độ Chất lượng cao yêu cầu 1080p gốc, model này không có";
    }
    const suitability = checkSuitability({
      provider: model.provider,
      model: model.modelId,
      complexity: ctx.complexity,
      characterCount: ctx.characterCount,
      sceneFlags: ctx.sceneFlags,
    });
    if (!suitability.allowed) return suitability.reason;
    if (
      ctx.consistencyRequired &&
      ctx.characterCount >= 2 &&
      !model.supportsCharacterReference &&
      !model.supportsReferenceImage
    ) {
      return `cảnh có ${ctx.characterCount} nhân vật cần giữ nhất quán nhưng model không nhận ảnh tham chiếu`;
    }
  }
  return "không đáp ứng yêu cầu của cảnh";
}

export function isCapable(model: ModelRegistry, ctx: RouteContext): boolean {
  if (!model.enabled) return false;
  if (model.type !== ctx.type) return false;
  if (!ctx.availableProviders.includes(model.provider)) return false;

  if (ctx.type === "video") {
    if (model.maxDuration > 0 && ctx.durationSeconds > model.maxDuration) {
      return false;
    }
    if (ctx.needsReferenceImage && !model.supportsImageToVideo) return false;
    if (!ctx.needsReferenceImage && !model.supportsTextToVideo && !model.supportsImageToVideo) {
      return false;
    }
    if (ctx.needs1080p && !model.supports1080p) return false;

    // Benchmark evidence, not preference. A provider that has actually refused
    // this class of scene is excluded from it - see domain/video-suitability.
    if (
      !checkSuitability({
        provider: model.provider,
        model: model.modelId,
        complexity: ctx.complexity,
        characterCount: ctx.characterCount,
        sceneFlags: ctx.sceneFlags,
      }).allowed
    ) {
      return false;
    }

    // Two characters that must stay on-model need explicit reference support.
    if (
      ctx.consistencyRequired &&
      ctx.characterCount >= 2 &&
      !model.supportsCharacterReference &&
      !model.supportsReferenceImage
    ) {
      return false;
    }
  }

  if (ctx.type === "image" && ctx.consistencyRequired) {
    if (!model.supportsReferenceImage && !model.supportsCharacterReference) {
      return false;
    }
  }

  if (ctx.type === "upscale" && !model.supportsUpscale) return false;

  return true;
}

/**
 * Usage for ONE candidate, with the vendor's own billing rules applied.
 *
 * Video vendors do not sell arbitrary lengths: Runway bills a 4-second scene as
 * 5, and Veo forces 8 whenever a keyframe or 1080p is involved. Those rules are
 * per-model, so the conversion has to happen per candidate rather than once for
 * the whole route.
 *
 * This is the fix for a real accounting hole: the router used to price video as
 * `price x seconds requested` and hand that figure to `assertCanSpend`, so the
 * hard cap was being checked against a number 20% (Runway) to 50% (Veo) below
 * the actual invoice.
 */
function usageForCandidate(
  model: ModelRegistry,
  ctx: RouteContext,
): UsageUnits {
  if (ctx.type !== "video" || ctx.usage.seconds === undefined) return ctx.usage;
  const { size } = splitModelSize(model.modelId);
  // `willSend` rather than the requested length: a vendor that only sells 4, 8
  // or 12 seconds will be sent 8 for a 6-second scene, and pricing the 6 would
  // quote for a request that cannot be made.
  return {
    ...ctx.usage,
    seconds: planDuration({
      provider: model.provider,
      model: model.modelId,
      size,
      requestedSeconds: ctx.usage.seconds,
      // Err towards "a keyframe is being sent". For Veo that is the more
      // expensive branch, and over-quoting is the safe direction for a cap.
      hasKeyframe: ctx.keyframeAvailable ?? ctx.needsReferenceImage,
    }).willSend,
  };
}

function toCandidate(model: ModelRegistry, ctx: RouteContext): RouteCandidate {
  const estimatedCost = costForModel(model, usageForCandidate(model, ctx));
  return {
    provider: model.provider,
    modelId: model.modelId,
    displayName: model.displayName,
    estimatedCost,
    quality: qualityIndex(model),
    value: valueIndex(model, estimatedCost),
  };
}

const byCheapest = (a: RouteCandidate, b: RouteCandidate) =>
  a.estimatedCost - b.estimatedCost || b.quality - a.quality;

const byQuality = (a: RouteCandidate, b: RouteCandidate) =>
  b.quality - a.quality || a.estimatedCost - b.estimatedCost;

const byValue = (a: RouteCandidate, b: RouteCandidate) =>
  b.value - a.value || b.quality - a.quality;

export function routeScene(
  models: ModelRegistry[],
  ctx: RouteContext,
): RouteDecision {
  if (models.length === 0) {
    throw new RoutingError(
      "Chưa có mô hình AI nào trong hệ thống. Hãy thêm mô hình ở mục Mô hình AI.",
      "no_models",
    );
  }

  const capable = models.filter((m) => isCapable(m, ctx));
  if (capable.length === 0) {
    throw new RoutingError(
      `Không có mô hình ${ctx.type} nào đáp ứng yêu cầu của cảnh này ` +
        `(${ctx.durationSeconds}s, ${ctx.characterCount} nhân vật).`,
      "no_capable_models",
    );
  }

  // A manual pin short-circuits scoring, but still has to be capable and to fit
  // the budget - a pinned model is not a licence to overspend.
  const wantsManual =
    ctx.strategy === "MANUAL" ||
    (ctx.manualProvider != null && ctx.manualModel != null);

  if (wantsManual) {
    const pinned = capable.find(
      (m) => m.provider === ctx.manualProvider && m.modelId === ctx.manualModel,
    );
    if (!pinned) {
      // Say WHICH requirement the pinned model failed. "Not suitable" sends the
      // operator hunting through a capability table; naming the mismatch turns
      // a debugging session into a one-line fix.
      const known = models.find(
        (m) => m.provider === ctx.manualProvider && m.modelId === ctx.manualModel,
      );
      throw new RoutingError(
        known
          ? `Mô hình được chọn thủ công (${ctx.manualProvider}/${ctx.manualModel}) ` +
            `không dùng được cho cảnh này: ${explainIncapable(known, ctx)}`
          : `Không tìm thấy mô hình được chọn thủ công ` +
            `(${ctx.manualProvider}/${ctx.manualModel}) trong bảng Mô hình AI.`,
        "manual_not_found",
      );
    }
    const candidate = toCandidate(pinned, ctx);
    assertAffordable(candidate, ctx);
    return {
      ...candidate,
      reason: "Người dùng chọn thủ công",
      fallbacks: [],
      downgraded: false,
    };
  }

  // Models that can do the work but are not cleared to be CHOSEN. They stayed
  // in `capable` so a manual pin still reaches them; automatic routing steps
  // over them.
  //
  // Two independent objections, and either one is enough:
  //
  //   lifecycle              what the OPERATOR says - PIN_ONLY, or a vendor
  //                          shutdown date that makes the model a dead end
  //   NEEDS_EXPLICIT_PIN     what the BENCHMARK EVIDENCE says
  //   reliability            what OUR OWN PAID PRODUCTION RUNS did
  //
  // They are kept apart because they answer different questions and can
  // disagree: Sora-2 has good evidence and is being retired anyway, and a model
  // can benchmark well and still be the one that has returned BAD_OUTPUT on
  // three different scenes since.
  const blocked = (m: ModelRegistry): boolean =>
    autoRouteBlock(m) !== null ||
    !isAutoRoutable(m.lifecycle) ||
    requiresExplicitPin(m.provider, m.modelId) !== null;
  const pinOnly = capable.filter(blocked);
  const automatic = capable.filter((m) => !blocked(m));
  if (automatic.length === 0) {
    // Do NOT fall through to the pin-only model. Silently spending on a
    // candidate that is under review is exactly what marking it was meant to
    // prevent - so name it and let a person decide.
  const names = pinOnly
      .map((m) => `${m.provider}/${m.modelId}${m.lifecycle ? ` (${m.lifecycle})` : ""}`)
      .join(", ");
    const first = pinOnly[0];
    const why = first
      ? autoRouteBlock(first)
        ? `${first.provider}/${first.modelId}: ${autoRouteBlock(first)}. ` +
          `${first.reliabilityNote || first.replacementNote}`.trimEnd()
        : !isAutoRoutable(first.lifecycle)
        ? first.lifecycle === "DEPRECATED"
          ? `${first.provider}/${first.modelId} đã bị đánh dấu NGỪNG DÙNG` +
            (first.shutdownDate
              ? ` (nhà cung cấp tắt ngày ${first.shutdownDate.toISOString().slice(0, 10)})`
              : "") +
            `. ${first.replacementNote}`.trimEnd()
          : `${first.provider}/${first.modelId} chỉ được chọn tay.`
        : (requiresExplicitPin(first.provider, first.modelId) ?? "")
      : "";
    throw new RoutingError(
      pinOnly.length > 0
        ? `Cảnh này chỉ còn ứng viên chưa được chốt: ${names}. ${why} ` +
          `Hãy chọn thủ công nếu bạn đồng ý chi.`
        : `Không có mô hình ${ctx.type} nào đáp ứng yêu cầu của cảnh này ` +
          `(${ctx.durationSeconds}s, ${ctx.characterCount} nhân vật).`,
      pinOnly.length > 0 ? "needs_explicit_pin" : "no_capable_models",
    );
  }

  const candidates = automatic.map((m) => toCandidate(m, ctx));
  const strategy = effectiveStrategy(ctx);

  // The quality floor is the AUTO heuristic: it is how a mode decides that this
  // particular scene deserves a better model. When the operator names a strategy
  // explicitly they are overriding that judgement, so the floor does not apply -
  // asking for CHEAPEST and being handed the premium model would be a bug, not a
  // safeguard.
  const floor =
    ctx.strategy === "AUTO"
      ? qualityFloor(ctx.qualityMode, ctx.complexity, ctx.spendPriority)
      : 0;
  const atOrAboveFloor = candidates.filter((c) => c.quality >= floor);
  // If nothing clears the bar, take the best available rather than failing: a
  // usable cheap clip beats no clip at all.
  const pool = atOrAboveFloor.length > 0 ? atOrAboveFloor : candidates;
  const relaxedFloor = atOrAboveFloor.length === 0;
  const sorter =
    strategy === "CHEAPEST"
      ? byCheapest
      : strategy === "BEST_QUALITY"
        ? byQuality
        : byValue;

  const ranked = [...pool].sort(sorter);
  let chosen = ranked[0]!;
  let downgraded = false;

  // Budget ceiling. Step down through the affordable options rather than
  // refusing outright - a cheaper scene is better than a stalled project.
  if (chosen.estimatedCost > ctx.budgetRemaining) {
    const affordable = candidates
      .filter((c) => c.estimatedCost <= ctx.budgetRemaining)
      .sort(byValue);
    const next = affordable[0];
    if (!next) {
      throw new RoutingError(
        `Chi phí tối thiểu cho cảnh này là ${formatMoney(
          Math.min(...candidates.map((c) => c.estimatedCost)),
        )} nhưng ngân sách còn lại chỉ ${formatMoney(ctx.budgetRemaining)}.`,
        "over_budget",
      );
    }
    chosen = next;
    downgraded = true;
  }

  const fallbacks = ranked
    .filter(
      (c) =>
        !(c.provider === chosen.provider && c.modelId === chosen.modelId) &&
        c.estimatedCost <= ctx.budgetRemaining,
    )
    .slice(0, 3);

  return {
    ...chosen,
    reason: explain(ctx, strategy, floor, chosen, { downgraded, relaxedFloor }),
    fallbacks,
    downgraded,
  };
}

function effectiveStrategy(ctx: RouteContext): RouterStrategy {
  if (ctx.strategy !== "AUTO") return ctx.strategy;
  switch (ctx.qualityMode) {
    case "ECONOMY":
      return "CHEAPEST";
    case "QUALITY":
      return "BEST_QUALITY";
    case "BALANCED":
    case "CUSTOM":
    default:
      return "BEST_VALUE";
  }
}

function assertAffordable(c: RouteCandidate, ctx: RouteContext): void {
  if (c.estimatedCost > ctx.budgetRemaining) {
    throw new RoutingError(
      `Mô hình đã chọn tốn ${formatMoney(c.estimatedCost)} nhưng ngân sách còn lại chỉ ${formatMoney(
        ctx.budgetRemaining,
      )}.`,
      "over_budget",
    );
  }
}

function explain(
  ctx: RouteContext,
  strategy: RouterStrategy,
  floor: number,
  chosen: RouteCandidate,
  flags: { downgraded: boolean; relaxedFloor: boolean },
): string {
  const bits: string[] = [];

  if (ctx.spendPriority === "HIGH") {
    bits.push("cảnh quan trọng (hook/punchline) nên ưu tiên chất lượng");
  } else if (ctx.spendPriority === "LOW") {
    bits.push("cảnh phụ nên ưu tiên tiết kiệm");
  }

  if (ctx.complexity === "HIGH") {
    bits.push("cảnh phức tạp, nhiều chuyển động/nhân vật");
  } else if (ctx.complexity === "LOW") {
    bits.push("cảnh đơn giản, mô hình rẻ là đủ");
  }

  const strategyLabel: Record<RouterStrategy, string> = {
    AUTO: "tự động",
    CHEAPEST: "chọn rẻ nhất",
    BEST_VALUE: "chọn giá trị tốt nhất",
    BEST_QUALITY: "chọn chất lượng cao nhất",
    MANUAL: "thủ công",
  };

  bits.push(
    `${strategyLabel[strategy]} với ngưỡng chất lượng ${floor.toFixed(1)}/10 ` +
      `(mô hình đạt ${chosen.quality.toFixed(1)})`,
  );

  if (flags.relaxedFloor) {
    bits.push("không có mô hình nào đạt ngưỡng nên dùng mô hình tốt nhất hiện có");
  }
  if (flags.downgraded) {
    bits.push("đã hạ cấp mô hình để không vượt ngân sách");
  }

  return bits.join("; ");
}

function formatMoney(value: number): string {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
}
