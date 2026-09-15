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
}

export interface LowAutoBlocker {
  code: string;
  message: string;
}

export interface LowAutoVerdict {
  eligible: boolean;
  blockers: LowAutoBlocker[];
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

  if (input.complexity !== "LOW") {
    blockers.push({
      code: "not_low",
      message: `độ khó ${input.complexity}, cổng này chỉ nhận LOW`,
    });
  }

  if (!input.hasKeyframe) {
    // Not a preference. The three good samples were all image-to-video; a
    // text-to-video run on this model has never been measured, so routing one
    // automatically would be buying an untested path.
    blockers.push({
      code: "needs_keyframe",
      message: "chưa có keyframe — image-to-video bắt buộc phải có ảnh gốc",
    });
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

  if (input.modelLifecycle === "DEPRECATED" || input.modelLifecycle === "DISABLED") {
    blockers.push({
      code: "model_lifecycle",
      message: `model đang ở vòng đời ${input.modelLifecycle}`,
    });
  }

  if (input.modelReliability !== "OK") {
    blockers.push({
      code: "model_degraded",
      message: `độ tin cậy model = ${input.modelReliability}`,
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

  return { eligible: blockers.length === 0, blockers };
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
  if (verdict.blockers.some((b) => b.code === "needs_keyframe")) {
    return "NEEDS_KEYFRAME";
  }
  return "NEEDS_PROVIDER";
}
