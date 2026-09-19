import type { ModelRegistry } from "@prisma/client";
import type {
  Complexity,
  ModelType,
  QualityMode,
  RouterStrategy,
  SpendPriority,
} from "@/domain/enums";
import { isAutoRoutable } from "@/domain/enums";
import { lowAutoRouteBlock, type LowAutoInput } from "@/domain/low-auto";
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

  /**
   * The scene facts a LOW_AUTO model is judged against.
   *
   * Optional because most routes never meet one: image, voice and text models
   * have no LOW_AUTO grant, and a video route where no candidate holds the
   * grant never reads this. But when a LOW_AUTO candidate IS in the pool and
   * this is absent, the candidate is refused rather than waved through - see
   * `lowAutoRouteBlock`. Absent facts are not favourable facts.
   */
  lowAuto?: LowAutoSceneFacts;
}

/**
 * Everything `lowAutoEligibility` needs that the router does not already hold.
 *
 * Deliberately a plain data bag assembled by the CALLER. The router does not
 * read the database, classify a camera or compose a prompt - it decides - and a
 * router that started doing those things to fill its own gate would be
 * impossible to test without a database.
 */
export type LowAutoSceneFacts = Pick<
  LowAutoInput,
  | "hasKeyframe"
  | "cameraMode"
  | "repeatedSmallObjects"
  | "promptGuarded"
  | "contradictions"
  | "stage"
  | "motionSource"
  | "motionScale"
  | "multiCharacterInteraction"
  | "perVideoCapRemaining"
> & {
  /**
   * Each vendor's own wallet, in dollars, keyed by provider name.
   *
   * A map rather than one number because the gate runs per CANDIDATE and two
   * vendors' balances are not fungible - the same mistake services/provider-budget
   * exists to prevent. A provider absent from the map reads as null, which means
   * "we hold no wallet for this vendor", NOT "this vendor has no money".
   */
  providerBudgets: Record<string, number | null>;
};

export interface RouteCandidate {
  provider: string;
  modelId: string;
  displayName: string;
  estimatedCost: number;
  quality: number;
  value: number;
  /**
   * Is THIS candidate a model the router is choosing under a LOW_AUTO grant?
   *
   * Carried per candidate, not just on the winner, because a fallback is bought
   * with the same money as the first choice. `withFallback` used to clone the
   * decision with `...decision`, so a fallback onto a LOW_AUTO model inherited
   * `lowAutoRouted: false` from a first choice that was not one - and batch
   * authorisation gate 2b, which exists to stop an approval of NAMED clips
   * funding a clip the router picked, had nothing to fire on. See QĐ-069.
   */
  lowAuto: boolean;
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
  /**
   * True when the ROUTER chose this model by itself under a LOW_AUTO grant.
   *
   * Carried out of routing rather than re-derived downstream, because "was this
   * the router's idea or the operator's?" stops being answerable once the
   * decision is just a provider and a model id - and the batch gate needs the
   * answer to decide whether the approval on file covers it.
   *
   * A manual pin is never low-auto, even when it names the same model: the
   * person chose it, and that is the distinction the whole flag exists to keep.
   */
  lowAutoRouted: boolean;
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
    lowAuto: model.lifecycle === "LOW_AUTO",
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
    // Name the models and WHY each one was excluded. "No model meets the
    // requirements" is true and useless: it describes a set by its emptiness
    // and leaves the operator to rediscover, one at a time, which capability or
    // measured limit ruled out which candidate. `explainIncapable` already
    // exists for exactly this and was not being used here.
    //
    // Only models of the right TYPE are listed. A video route has no business
    // explaining why the voice models did not qualify.
    const sameType = models.filter((m) => m.type === ctx.type);
    const why = sameType
      .map((m) => `${m.provider}/${m.modelId}: ${explainIncapable(m, ctx)}`)
      .join(" | ");
    throw new RoutingError(
      sameType.length > 0
        ? `Không mô hình ${ctx.type} nào dùng được cho cảnh này ` +
          `(${ctx.durationSeconds}s, ${ctx.characterCount} nhân vật). ${why}`
        : `Chưa có mô hình ${ctx.type} nào trong bảng Mô hình AI.`,
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
    // A PIN IS NOT A KEY TO EVERY DOOR.
    //
    // Naming a model overrules the router's JUDGEMENT - which model is best
    // value for this scene - and nothing else. It cannot overrule a fact about
    // the world: a model the vendor has switched off will not run because an
    // operator typed its name, and the request would be bought and refused.
    //
    // THE LINE IS "DATE" VERSUS "LABEL", and it is already drawn elsewhere in
    // this project. QĐ-038: a shutdown date that has passed outranks any label,
    // because the label is only as recent as the last person to edit it while
    // the date is a fact about the vendor. QĐ-028: deprecating Sora blocks the
    // ROUTER from choosing it, NOT a person - deleting that path would turn a
    // deliberate one-off into an impossibility and make old work unreproducible.
    //
    // So a pin cannot overrule a model that is genuinely gone, and is not asked
    // to justify itself for a model that merely has a retirement announced.
    // `enabled: false` and an unavailable provider are already caught by
    // `isCapable`, which is why such a model never reaches this branch.
    // Reliability is deliberately absent: DEGRADED means "this went wrong for us
    // before", a judgement, and QĐ-035 keeps degraded models pinnable precisely
    // so they can be benchmarked again.
    if (pinned.shutdownDate && pinned.shutdownDate.getTime() <= Date.now()) {
      throw new RoutingError(
        `Mô hình được chọn thủ công (${pinned.provider}/${pinned.modelId}) đã bị nhà ` +
          `cung cấp tắt từ ${pinned.shutdownDate.toISOString().slice(0, 10)}. ` +
          `Ghim tay không mở lại được model đã tắt — request sẽ hỏng và vẫn có ` +
          `thể bị tính tiền. ${pinned.replacementNote}`.trimEnd(),
        "manual_not_found",
      );
    }
    if (pinned.lifecycle === "DISABLED") {
      throw new RoutingError(
        `Mô hình được chọn thủ công (${pinned.provider}/${pinned.modelId}) đang bị ` +
          `TẮT trong bảng Mô hình AI. Hãy bật lại nếu bạn thực sự muốn dùng.`,
        "manual_not_found",
      );
    }

    const candidate = toCandidate(pinned, ctx);
    assertAffordable(candidate, ctx);
    // A pin on a retiring model goes through, but never SILENTLY. "Must not
    // bypass automatically" is satisfied by saying so, not by refusing: the
    // operator gets the clip they asked for and the sentence that tells them
    // the path is closing.
    const retiring =
      pinned.lifecycle === "DEPRECATED"
        ? ` ⚠ Model đang NGỪNG DÙNG` +
          (pinned.shutdownDate
            ? ` — nhà cung cấp tắt ngày ${pinned.shutdownDate.toISOString().slice(0, 10)}`
            : "") +
          `. ${pinned.replacementNote}`.trimEnd()
        : "";
    return {
      ...candidate,
      reason: `Người dùng chọn thủ công.${retiring}`,
      fallbacks: [],
      downgraded: false,
      // A pin is an instruction, never the router's initiative - even when the
      // model it names happens to hold a LOW_AUTO grant.
      lowAutoRouted: false,
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
  //   LOW_AUTO gate          whether THIS SCENE is the shape the grant covers
  //
  // They are kept apart because they answer different questions and can
  // disagree: Sora-2 has good evidence and is being retired anyway, and a model
  // can benchmark well and still be the one that has returned BAD_OUTPUT on
  // three different scenes since.
  //
  // The fourth is the newest and the only scene-dependent one. `isAutoRoutable`
  // now needs the complexity to answer for a LOW_AUTO model at all, and
  // `lowAutoRouteBlock` then checks the rest of what the grant was conditioned
  // on. Before this, the low-auto gate existed and nothing called it.
  const lowAutoWhy = (m: ModelRegistry): string | null =>
    lowAutoRouteBlock(
      { lifecycle: m.lifecycle, reliability: m.reliability, verification: m.verification },
      ctx.lowAuto
        ? {
            ...ctx.lowAuto,
            complexity: ctx.complexity,
            characterCount: ctx.characterCount,
            estimatedCost: costForModel(m, usageForCandidate(m, ctx)),
            budgetRemaining: ctx.budgetRemaining,
            providerBudgetRemaining: ctx.lowAuto.providerBudgets[m.provider] ?? null,
            manualPinElsewhere: Boolean(ctx.manualProvider && ctx.manualModel),
          }
        : null,
    );

  const blocked = (m: ModelRegistry): boolean =>
    autoRouteBlock(m) !== null ||
    !isAutoRoutable(m.lifecycle, { complexity: ctx.complexity }) ||
    requiresExplicitPin(m.provider, m.modelId) !== null ||
    lowAutoWhy(m) !== null;
  const pinOnly = capable.filter(blocked);
  const automatic = capable.filter((m) => !blocked(m));
  if (automatic.length === 0) {
    // Do NOT fall through to the pin-only model. Silently spending on a
    // candidate that is under review is exactly what marking it was meant to
    // prevent - so name it and let a person decide.
    //
    // EVERY blocked model gets its OWN sentence. This used to take
    // `pinOnly[0]`, which is the registry's arbitrary first row, and describe
    // only that one: asking "why did h3_max not run?" on a MEDIUM scene
    // answered with Sora-2's shutdown date, a model nobody had mentioned and
    // which had nothing to do with the refusal. One reason for a list of
    // candidates is one reason too few.
    const why = (m: ModelRegistry): string => {
      const auto = autoRouteBlock(m);
      if (auto) return `${auto}. ${m.reliabilityNote || m.replacementNote}`.trimEnd();
      if (!isAutoRoutable(m.lifecycle, { complexity: ctx.complexity })) {
        if (m.lifecycle === "DEPRECATED") {
          return (
            `đã bị đánh dấu NGỪNG DÙNG` +
            (m.shutdownDate
              ? ` (nhà cung cấp tắt ngày ${m.shutdownDate.toISOString().slice(0, 10)})`
              : "") +
            `. ${m.replacementNote}`
          ).trimEnd();
        }
        if (m.lifecycle === "LOW_AUTO") {
          return `chỉ tự định tuyến cho cảnh LOW, cảnh này là ${ctx.complexity}`;
        }
        return "chỉ được chọn tay";
      }
      // The low-auto gate is the most specific objection, so it speaks for
      // itself: "không đủ điều kiện" would hide which of eleven conditions
      // failed, and the operator's next action depends entirely on which.
      return lowAutoWhy(m) ?? requiresExplicitPin(m.provider, m.modelId) ?? "";
    };

    // Models excluded EARLIER, by a measured limit rather than by an operator's
    // label. They never reach `pinOnly` because `isCapable` drops them, so
    // without this they vanish from the explanation entirely - which is exactly
    // what happened to h3_max on a MEDIUM scene: the hard ceiling did its job
    // and then the error talked about something else.
    const ruledOut =
      ctx.type === "video"
        ? models.filter(
            (m) =>
              m.enabled &&
              m.type === ctx.type &&
              ctx.availableProviders.includes(m.provider) &&
              !capable.includes(m) &&
              !checkSuitability({
                provider: m.provider,
                model: m.modelId,
                complexity: ctx.complexity,
                characterCount: ctx.characterCount,
                sceneFlags: ctx.sceneFlags,
              }).allowed,
          )
        : [];

    const lines = [
      ...pinOnly.map((m) => `${m.provider}/${m.modelId} (${m.lifecycle}): ${why(m)}`),
      ...ruledOut.map(
        (m) =>
          `${m.provider}/${m.modelId}: ` +
          checkSuitability({
            provider: m.provider,
            model: m.modelId,
            complexity: ctx.complexity,
            characterCount: ctx.characterCount,
            sceneFlags: ctx.sceneFlags,
          }).reason,
      ),
    ];

    throw new RoutingError(
      lines.length > 0
        ? `Không mô hình ${ctx.type} nào được phép tự định tuyến cho cảnh này. ` +
          `${lines.join(" | ")} — hãy chọn thủ công nếu bạn đồng ý chi.`
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
    // Read off the candidate rather than looked up again. The lookup it replaces
    // searched `automatic` for the chosen provider/model and silently answered
    // false when it found nothing, which made a missing row indistinguishable
    // from an operator's choice - on the flag that decides whether a batch
    // approval covers this clip.
    lowAutoRouted: chosen.lowAuto,
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
