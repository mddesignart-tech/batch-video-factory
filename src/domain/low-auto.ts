import { COMFORTABLE_CAST } from "./crowding";
import type { CameraMode } from "./camera-intent";

/**
 * May the router buy a paid clip for this scene on its own?
 *
 * A NARROW gate, deliberately. `h3_max` has four benchmark samples and three of
 * them scored 8.9 or better - but all three were one or two characters on a
 * plain background with a locked camera. That is the shape of scene this gate
 * describes, and nothing wider. Reading a 9.07 average as a licence to route
 * anything LOW would be extrapolating from evidence that does not exist.
 *
 * THE RULE THAT MATTERS MOST
 * --------------------------
 * A scene that can be made for free must stay free. `decideMotion` runs FIRST
 * and its LOCAL_MOTION verdict is final: this gate never converts a local scene
 * into a paid one. Low-auto exists to stop paid clips going to the wrong model,
 * not to find new things to buy - and a system that quietly turns free work
 * into billed work is the single easiest way to lose a budget without anyone
 * noticing a decision was made.
 */

/** Cast size this gate is willing to vouch for, from the crowding module. */
export const LOW_AUTO_MAX_CHARACTERS = COMFORTABLE_CAST;

/**
 * WHERE in the pipeline the question is being asked.
 *
 * It changes what a missing keyframe MEANS, and that distinction is the whole
 * reason the field exists. Before the image step there is legitimately no file
 * on disk yet; refusing the scene there would condemn every project at the only
 * moment when every project looks the same. After the image step and before the
 * video call, a missing keyframe is a real, final defect: h3_max is
 * image-to-video, and the three good samples were all image-to-video.
 *
 *   PLANNING  a keyframe that does not exist YET is `keyframe_pending`, and a
 *             verdict blocked on nothing else reports `pendingOnly` so a cost
 *             preview can say "this will be eligible" without claiming it is.
 *   VIDEO     a keyframe that does not exist is `needs_keyframe`, full stop.
 *             This is the stage where money moves, and "it will be there later"
 *             is not a file.
 */
export type LowAutoStage = "PLANNING" | "VIDEO";

export interface LowAutoInput {
  complexity: string;
  characterCount: number;
  /** A keyframe file that actually exists, not merely a preference for one. */
  hasKeyframe: boolean;
  cameraMode: CameraMode;
  /** Beans, coins, confetti: the signal that cost this project two failed clips. */
  repeatedSmallObjects: boolean;
  /** Registry lifecycle of the candidate model. */
  modelLifecycle: string;
  /** Registry reliability of the candidate model. */
  modelReliability: string;
  /** Did the prompt go through the camera guardrail composer? */
  promptGuarded: boolean;
  /** Contradictions found in the final prompt. Any at all disqualifies. */
  contradictions: string[];
  estimatedCost: number;
  /** Dollars left under the app-wide cap. */
  budgetRemaining: number;
  /** Dollars left in this vendor's own wallet. Null when the vendor meters itself. */
  providerBudgetRemaining: number | null;

  // ---- added when the gate was wired into the real router ----------------

  /** Defaults to VIDEO: the stricter reading, for a caller that did not say. */
  stage?: LowAutoStage;
  /**
   * How this scene gets its movement, as the pipeline will actually run it.
   *
   * A LOCAL_MOTION scene has no business in a paid gate at all. Passing it here
   * and having the gate say "eligible" would be true and useless - the question
   * was never whether the model COULD, it was whether anything should be bought.
   */
  motionSource?: "AI_VIDEO" | "LOCAL_MOTION";
  /** Registry verification state. Only BENCHMARK_VERIFIED may auto-route. */
  modelVerification?: string;
  /** Dollars this one video may cost under the batch approval. Null = no cap set. */
  perVideoCapRemaining?: number | null;
  /**
   * Is a person's explicit pin already pointing somewhere else?
   *
   * Low-auto is the router's own initiative and must never compete with an
   * instruction. It does not win the argument; it declines to have it.
   */
  manualPinElsewhere?: boolean;
}

export interface LowAutoBlocker {
  code: string;
  message: string;
}

export interface LowAutoVerdict {
  eligible: boolean;
  blockers: LowAutoBlocker[];
  /**
   * True when the ONLY thing standing in the way is a keyframe that has not
   * been generated yet, at a stage where that is normal.
   *
   * A planner may show this as "will be eligible once the still exists". The
   * video stage must still treat the verdict as ineligible, because `eligible`
   * is false either way - this flag explains a refusal, it never softens one.
   */
  pendingOnly: boolean;
}

/**
 * Every condition, checked, with the failures NAMED rather than counted.
 *
 * All of them are evaluated - the function does not stop at the first failure -
 * because an operator fixing one blocker only to meet the next one is a worse
 * experience than being told all three at once.
 */
export function lowAutoEligibility(input: LowAutoInput): LowAutoVerdict {
  const blockers: LowAutoBlocker[] = [];
  const stage: LowAutoStage = input.stage ?? "VIDEO";

  if (input.complexity !== "LOW") {
    blockers.push({
      code: "not_low",
      message: `độ khó ${input.complexity}, cổng này chỉ nhận LOW`,
    });
  }

  // A free scene is not a cheap purchase, it is not a purchase. Checked before
  // anything else because every question below it is about which paid model to
  // use, and that question should never have been reached.
  if (input.motionSource === "LOCAL_MOTION") {
    blockers.push({
      code: "local_motion",
      message: "cảnh dùng LOCAL_MOTION ($0) — không có gì để mua ở đây",
    });
  }

  if (input.manualPinElsewhere) {
    blockers.push({
      code: "manual_pin_elsewhere",
      message: "người dùng đã ghim model khác — tự định tuyến không được chen vào",
    });
  }

  if (!input.hasKeyframe) {
    // Not a preference. The three good samples were all image-to-video; a
    // text-to-video run on this model has never been measured, so routing one
    // automatically would be buying an untested path.
    //
    // The STAGE decides which of the two failures this is. Both block; they
    // differ in what an operator should do about it, and telling a planner
    // "this scene can never work" when the answer is "generate the image first"
    // sends someone rewriting a scene that was fine.
    blockers.push(
      stage === "PLANNING"
        ? {
            code: "keyframe_pending",
            message: "chưa tới bước tạo ảnh — keyframe sẽ có sau, chưa kết luận được",
          }
        : {
            code: "needs_keyframe",
            message: "chưa có keyframe — image-to-video bắt buộc phải có ảnh gốc",
          },
    );
  }

  if (input.characterCount > LOW_AUTO_MAX_CHARACTERS) {
    blockers.push({
      code: "too_many_characters",
      message:
        `${input.characterCount} nhân vật, vượt mức ${LOW_AUTO_MAX_CHARACTERS} ` +
        `mà model đã được đo`,
    });
  }

  if (input.cameraMode !== "LOCKED_CAMERA") {
    // A directed shot is not forbidden in general - it is simply outside what
    // has been measured. Every h3_max sample scored so far had a locked camera.
    blockers.push({
      code: "camera_not_locked",
      message: "kịch bản yêu cầu camera chuyển động — chưa có bằng chứng ở dạng này",
    });
  }

  if (input.repeatedSmallObjects) {
    blockers.push({
      code: "dense_small_objects",
      message:
        "cảnh có nhiều vật thể nhỏ lặp lại — đúng loại cảnh đã làm hỏng hai clip trả phí",
    });
  }

  // Exactly LOW_AUTO. Not "not deprecated", which is what this used to check
  // and which quietly let LOW_AUTO_CANDIDATE through - the one state whose
  // entire purpose is to be a proposal that has NOT been granted. An earlier
  // version of this gate returned `eligible: true` for a candidate, and the
  // only reason that never spent anything is that nothing called the gate.
  if (input.modelLifecycle !== "LOW_AUTO") {
    blockers.push({
      code: "model_lifecycle",
      message:
        input.modelLifecycle === "LOW_AUTO_CANDIDATE"
          ? "model mới là ỨNG VIÊN LOW_AUTO, chưa được cấp quyền tự định tuyến"
          : `vòng đời model = ${input.modelLifecycle}, cần đúng LOW_AUTO`,
    });
  }

  if (input.modelReliability !== "OK") {
    blockers.push({
      code: "model_degraded",
      message: `độ tin cậy model = ${input.modelReliability}`,
    });
  }

  // The grant is supposed to rest on paid runs somebody scored. A row that says
  // LOW_AUTO while saying UNVERIFIED is a contradiction, and the safe reading of
  // a contradiction is the restrictive one.
  if (input.modelVerification !== undefined && input.modelVerification !== "BENCHMARK_VERIFIED") {
    blockers.push({
      code: "not_benchmark_verified",
      message: `model ở trạng thái xác minh ${input.modelVerification}, cần BENCHMARK_VERIFIED`,
    });
  }

  if (!input.promptGuarded) {
    blockers.push({
      code: "prompt_not_guarded",
      message: "prompt chưa đi qua bộ guardrail camera",
    });
  }

  if (input.contradictions.length > 0) {
    blockers.push({
      code: "prompt_contradiction",
      message: `prompt tự mâu thuẫn: ${input.contradictions.join("; ")}`,
    });
  }

  if (input.estimatedCost > input.budgetRemaining) {
    blockers.push({
      code: "over_global_budget",
      message:
        `ước tính $${input.estimatedCost.toFixed(6)} vượt phần còn lại ` +
        `$${input.budgetRemaining.toFixed(6)} của hạn mức chung`,
    });
  }

  // Null means the vendor bills externally and we hold no wallet for it, which
  // is not the same as a wallet holding zero. Treating the two alike would
  // block every externally-metered provider forever.
  if (
    input.providerBudgetRemaining !== null &&
    input.estimatedCost > input.providerBudgetRemaining
  ) {
    blockers.push({
      code: "over_provider_budget",
      message:
        `ví nhà cung cấp còn $${input.providerBudgetRemaining.toFixed(6)}, ` +
        `không đủ cho $${input.estimatedCost.toFixed(6)}`,
    });
  }

  // The per-video ceiling from the batch approval. A third, independent limit:
  // the global cap protects the project, the provider wallet protects the
  // vendor account, and this one stops a single scene eating an approval that
  // was meant to cover several.
  if (
    input.perVideoCapRemaining !== undefined &&
    input.perVideoCapRemaining !== null &&
    input.estimatedCost > input.perVideoCapRemaining
  ) {
    blockers.push({
      code: "over_per_video_cap",
      message:
        `trần mỗi video còn $${input.perVideoCapRemaining.toFixed(6)}, ` +
        `không đủ cho $${input.estimatedCost.toFixed(6)}`,
    });
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    // "Only waiting on the still" - true when that is the single objection.
    // Any second blocker means the scene has a real problem and the pending
    // keyframe is not the story.
    pendingOnly: blockers.length === 1 && blockers[0]!.code === "keyframe_pending",
  };
}

/** What a scene should do when low-auto cannot take it. */
export type LowAutoFallback = "LOCAL_MOTION" | "NEEDS_KEYFRAME" | "NEEDS_PROVIDER";

/**
 * Where an ineligible scene goes.
 *
 * Never to another paid model. Every other paid video model in this registry is
 * currently blocked for a reason someone wrote down - gen4_turbo DEGRADED after
 * two BAD_OUTPUT failures, gen4.5 PIN_ONLY, Sora DEPRECATED - and quietly
 * picking one of them to rescue a scene would undo all three decisions at once,
 * silently, at the moment nobody is watching.
 */
export function lowAutoFallback(
  verdict: LowAutoVerdict,
  opts: { localMotionAllowed: boolean },
): LowAutoFallback {
  if (opts.localMotionAllowed) return "LOCAL_MOTION";
  // Both keyframe codes land here. They differ in blame, not in destination:
  // the scene needs a still either way, and the planning-stage wording exists
  // so the operator is told to generate one rather than to rewrite the scene.
  if (verdict.blockers.some((b) => b.code === "needs_keyframe" || b.code === "keyframe_pending")) {
    return "NEEDS_KEYFRAME";
  }
  return "NEEDS_PROVIDER";
}

/**
 * The single question the ROUTER asks: may I pick this model by myself?
 *
 * Returns a sentence when the answer is no, null when it is yes. Null-means-yes
 * matches `autoRouteBlock` and `requiresExplicitPin` next to it in the router,
 * so the three objections read as one list rather than as three shapes.
 *
 * WHY THIS EXISTS SEPARATELY FROM `lowAutoEligibility`
 * ---------------------------------------------------
 * It does not add rules. It makes the rules REACHABLE. `lowAutoEligibility` was
 * written, tested seventeen ways, and called by nothing but its own tests and a
 * preview script - so every condition in it was, in production, decorative. The
 * router had one lever, `isAutoRoutable`, and that lever could only say ACTIVE.
 *
 * It also fails CLOSED on a missing context. A caller that routes video without
 * supplying the scene facts gets a refusal, not a pass: the grant is
 * conditional, and a condition nobody evaluated has not been satisfied.
 */
export function lowAutoRouteBlock(
  model: { lifecycle: string; reliability: string; verification?: string },
  scene: Omit<
    LowAutoInput,
    "modelLifecycle" | "modelReliability" | "modelVerification"
  > | null,
): string | null {
  if (model.lifecycle !== "LOW_AUTO") return null; // not our business
  if (scene === null) {
    return "cổng LOW_AUTO không nhận được dữ liệu cảnh — không thể tự định tuyến";
  }
  const verdict = lowAutoEligibility({
    ...scene,
    modelLifecycle: model.lifecycle,
    modelReliability: model.reliability,
    modelVerification: model.verification,
  });
  if (verdict.eligible) return null;
  return verdict.blockers.map((b) => b.message).join("; ");
}
