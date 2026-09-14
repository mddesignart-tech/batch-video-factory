import type { Complexity } from "./enums";

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
  runway: "LOW",
};

/** How many characters a provider has actually been shown to handle. */
const MAX_CHARACTERS: Record<string, number> = {
  // Two characters standing together is the case that failed twice. Until a
  // two-character scene succeeds, one is what the evidence supports.
  runway: 2,
};

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

  const ceiling = MAX_COMPLEXITY[provider];
  if (ceiling && RANK[complexity] > RANK[ceiling]) {
    return {
      allowed: false,
      reason:
        `Cảnh ${complexity} vượt mức ${ceiling} mà ${provider} đã được kiểm chứng. ` +
        `Benchmark: ${provider} hỏng ở cảnh phức tạp, đạt ở cảnh đơn giản.`,
    };
  }

  const maxChars = MAX_CHARACTERS[provider];
  if (maxChars !== undefined && characterCount > maxChars) {
    return {
      allowed: false,
      reason:
        `Cảnh có ${characterCount} nhân vật, nhiều hơn mức ${maxChars} mà ` +
        `${provider} đã chứng minh xử lý được.`,
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
