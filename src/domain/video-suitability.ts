import type { Complexity } from "./enums";
import { splitModelSize } from "./video-duration";

/**
 * Which video model may be trusted with which kind of scene.
 *
 * This encodes benchmark evidence, not preference. Every rule below is written
 * because a real clip was paid for and looked at:
 *
 *   Sora-2, "Spill the beans" scene 4, two attempts
 *     identity 10 / motion 3, then identity 7 / motion 8, camera 10 both times.
 *     Never failed. $0.40 for 4 seconds.
 *
 *   Runway gen4_turbo, same scene 4, two attempts
 *     FAILED both times with INTERNAL.BAD_OUTPUT.CODE01, 0 credits.
 *
 *   Runway gen4_turbo, scene 5 (one character, plain background)
 *     SUCCEEDED. Identity 10, camera 10, artifacts 7, motion 4. $0.25 for 5s.
 *
 * The pattern that reading gives: Runway holds a character better than Sora and
 * costs 37.5% less, but it obeys a prompt loosely and it refuses outright on
 * busy scenes. That makes it a good default for simple shots and a bad one for
 * everything else - which is a per-scene decision, not a per-video one.
 *
 * Nothing here is permanent. These are the rules the evidence supports TODAY,
 * and they should be revisited when there is more of it.
 */

/** Marker written on a scene that a provider has already refused. */
export const RUNWAY_UNSUITABLE = "RUNWAY_UNSUITABLE";

export interface SuitabilityInput {
  provider: string;
  /**
   * Registry model id, e.g. "gen4_turbo:720x1280".
   *
   * Required in practice for Runway. The limits below were measured on
   * gen4_turbo, and applying them to gen4.5 - a different model that has never
   * been tested - would be exactly the "inventing a limit for something
   * untested" mistake this file warns about two paragraphs up. Omitting it
   * falls back to provider-wide rules, which is right for a provider whose
   * models genuinely behave alike.
   */
  model?: string;
  complexity: Complexity;
  characterCount: number;
  /** Markers already recorded against this scene. */
  sceneFlags?: string[];
}

export interface SuitabilityVerdict {
  allowed: boolean;
  /** Why, in the operator's language. Empty when allowed with no caveat. */
  reason: string;
}

/**
 * Complexity ceilings per provider.
 *
 * A provider absent from this table has no ceiling - it is trusted with any
 * scene until evidence says otherwise. Inventing a limit for an untested
 * provider would be guessing, and a guess that blocks a model is as wrong as a
 * guess that picks one.
 */
const MAX_COMPLEXITY: Record<string, Complexity> = {
  // Keyed by "provider/apiModel". gen4_turbo failed scene 4 twice and passed
  // scene 5; that is a fact about gen4_turbo and about nothing else.
  "runway/gen4_turbo": "LOW",
};

/** How many characters a provider has actually been shown to handle. */
const MAX_CHARACTERS: Record<string, number> = {
  // Two characters standing together is the case gen4_turbo failed twice.
  "runway/gen4_turbo": 2,
};

/**
 * The key a rule is looked up under: the exact model first, the bare provider
 * as a fallback.
 *
 * Model first because that is the level evidence is actually gathered at. A
 * provider-wide entry still works for a vendor whose models behave alike, but
 * nothing should inherit a limit just for sharing a company.
 */
function ruleKeys(provider: string, model?: string): string[] {
  const apiModel = model ? splitModelSize(model).apiModel : "";
  return apiModel ? [`${provider}/${apiModel}`, provider] : [provider];
}

function lookup<T>(table: Record<string, T>, provider: string, model?: string): T | undefined {
  for (const key of ruleKeys(provider, model)) {
    if (key in table) return table[key];
  }
  return undefined;
}

const RANK: Record<Complexity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export function checkSuitability(input: SuitabilityInput): SuitabilityVerdict {
  const { provider, complexity, characterCount, sceneFlags = [] } = input;

  // A scene this provider has already refused. Retrying the same input is how
  // a benchmark turns into a bill for nothing: the two scene-4 attempts were
  // byte-identical and failed identically.
  if (provider === "runway" && sceneFlags.includes(RUNWAY_UNSUITABLE)) {
    return {
      allowed: false,
      reason:
        "Runway đã thất bại với chính cảnh này (INTERNAL.BAD_OUTPUT). " +
        "Gửi lại y hệt sẽ hỏng y hệt - hãy đổi nhà cung cấp hoặc sửa cảnh.",
    };
  }

  const ceiling = lookup(MAX_COMPLEXITY, provider, input.model);
  if (ceiling && RANK[complexity] > RANK[ceiling]) {
    return {
      allowed: false,
      reason:
        `Cảnh ${complexity} vượt mức ${ceiling} mà ${input.model ?? provider} ` +
        `đã được kiểm chứng. Benchmark: model này hỏng ở cảnh phức tạp, ` +
        `đạt ở cảnh đơn giản.`,
    };
  }

  const maxChars = lookup(MAX_CHARACTERS, provider, input.model);
  if (maxChars !== undefined && characterCount > maxChars) {
    return {
      allowed: false,
      reason:
        `Cảnh có ${characterCount} nhân vật, nhiều hơn mức ${maxChars} mà ` +
        `${input.model ?? provider} đã chứng minh xử lý được.`,
    };
  }

  return { allowed: true, reason: "" };
}

/**
 * Does this failure mean "never send this scene here again"?
 *
 * Only a vendor-side output failure counts. A 400 is our mistake and is worth
 * fixing and retrying; a rate limit or a 500 is transient. `BAD_OUTPUT` is the
 * model saying it could not make something acceptable from this input, and that
 * will not change on a retry.
 */
export function marksProviderUnsuitable(
  provider: string,
  errorCode: string | null | undefined,
): string | null {
  if (provider !== "runway") return null;
  if (!errorCode) return null;
  return errorCode.toUpperCase().includes("BAD_OUTPUT") ? RUNWAY_UNSUITABLE : null;
}

/** Add a marker without duplicating one already present. */
export function withFlag(flags: string[], flag: string): string[] {
  return flags.includes(flag) ? flags : [...flags, flag];
}
