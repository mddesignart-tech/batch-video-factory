/**
 * How long each video vendor actually BILLS for, as opposed to how long we
 * asked for.
 *
 * This lives in `domain/` with no database and no HTTP imports on purpose, so
 * that the three places which must agree can all reach it:
 *
 *   - the AI Router, which estimates cost *before* the spend guard runs;
 *   - the provider adapters, which quote and record the real charge;
 *   - the benchmark and test scripts.
 *
 * Before this existed, the router priced video as `price x seconds requested`
 * while the adapters priced it correctly. The spend guard therefore checked the
 * cap against a number that was too LOW - 20% low for Runway, 50% low for Veo -
 * which is the one direction a spending limit must never be wrong in.
 *
 * Every rule here rounds UP when uncertain. Quoting above the invoice makes the
 * remaining budget look smaller than it is; quoting below it lets a call through
 * the cap that should have been refused.
 */

/**
 * Clip lengths Runway's gen4_turbo sells. A 4-second scene is billed as 5.
 *
 * Per MODEL, not per provider: gen4.5 bills by the second across a 2-10 second
 * range, so applying gen4_turbo's quantisation to it would quote a 6-second
 * scene as 10 and refuse a request that is actually affordable. The rule was
 * always model-specific; there was only ever one model to notice it with.
 */
export const RUNWAY_TURBO_DURATIONS = [5, 10] as const;

/** Kept under its old name for callers that mean gen4_turbo. */
export const RUNWAY_DURATIONS = RUNWAY_TURBO_DURATIONS;

/** gen4.5 accepts any whole number of seconds in this range. */
export const RUNWAY_GEN45_MIN_SECONDS = 2;
export const RUNWAY_GEN45_MAX_SECONDS = 10;

/** Runway models that bill per second rather than per fixed clip length. */
const RUNWAY_PER_SECOND_MODELS = new Set(["gen4.5"]);

/** Clip lengths Veo sells, before its 8-second forcing rules apply. */
export const VEO_DURATIONS = [4, 6, 8] as const;

/**
 * Nearest allowed duration, never rounding DOWN into a shorter paid clip.
 *
 * Rounding down would quote for a clip we are not going to get, and would also
 * quote less than the vendor charges.
 */
export function nearestFrom(
  allowed: readonly number[],
  seconds: number,
): number {
  const fit = allowed.find((d) => d >= seconds);
  return fit ?? allowed[allowed.length - 1] ?? seconds;
}

/**
 * Veo is forced to 8 seconds by either a keyframe image or a 1080p output.
 *
 * UNVERIFIED against a live account: whether the FIRST keyframe counts as a
 * "reference image" for this rule is not confirmed. The assumption here is that
 * it DOES, so the quote comes out high rather than under the invoice.
 */
export function forcedToEightSeconds(
  size: string,
  hasKeyframe: boolean,
): boolean {
  return hasKeyframe || !isSevenTwentyP(size);
}

/**
 * Short-side resolution test, duplicated from `resolutionTierFor` rather than
 * imported: that helper lives beside the database config, and this module must
 * stay free of database imports so the router can use it.
 *
 * An unparseable size is treated as NOT 720p, which forces the 8-second rule
 * and therefore quotes high. Guessing 720p here would quote low.
 */
function isSevenTwentyP(size: string): boolean {
  const [w, h] = size.split("x").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return false;
  return Math.min(w as number, h as number) < 1000;
}

/**
 * Seconds the vendor will charge for, given what we intend to send.
 *
 * `provider` is the registry provider name; `size` is the "WIDTHxHEIGHT" suffix
 * from the registry model id. An unknown provider bills exactly what was asked,
 * which is the correct default: a vendor with no known rounding rule should not
 * have one invented for it.
 */
export function billedVideoSeconds(args: {
  provider: string;
  size: string;
  requestedSeconds: number;
  hasKeyframe: boolean;
  /**
   * API model name, without the size suffix.
   *
   * Optional so existing callers keep working, but pass it for Runway: its two
   * models bill differently, and guessing wrong quotes a 6-second gen4.5 clip
   * at gen4_turbo's 10-second minimum.
   */
  model?: string;
}): number {
  const { provider, size, requestedSeconds, hasKeyframe, model } = args;
  switch (provider) {
    case "runway": {
      const apiModel = model ? splitModelSize(model).apiModel : "";
      if (RUNWAY_PER_SECOND_MODELS.has(apiModel)) {
        // Whole seconds, clamped to the range the model sells. Rounding UP so
        // a fractional scene length is never quoted short.
        return Math.min(
          RUNWAY_GEN45_MAX_SECONDS,
          Math.max(RUNWAY_GEN45_MIN_SECONDS, Math.ceil(requestedSeconds)),
        );
      }
      return nearestFrom(RUNWAY_TURBO_DURATIONS, requestedSeconds);
    }
    case "google":
      if (forcedToEightSeconds(size, hasKeyframe)) return 8;
      return nearestFrom(VEO_DURATIONS, requestedSeconds);
    default:
      return requestedSeconds;
  }
}

/**
 * True when the vendor will charge for more time than was asked for.
 *
 * Used to label a quote in the UI and in scripts, so an operator can see that
 * $0.25 for a 4-second scene is a 5-second minimum and not a pricing error.
 */
export function isDurationPaddedBy(args: {
  provider: string;
  size: string;
  requestedSeconds: number;
  hasKeyframe: boolean;
  model?: string;
}): number {
  return billedVideoSeconds(args) - args.requestedSeconds;
}

/**
 * Registry model ids carry the output size as a suffix: `sora-2:720x1280`.
 *
 * Pure string work, kept here rather than beside the database config so the
 * router can read a candidate's size without pulling in a Prisma client.
 * `video-config` re-exports it, so the adapters' import path is unchanged.
 *
 * A missing or malformed suffix falls back to 720x1280 - the size every vendor
 * in this build supports, and the cheapest, so the fallback cannot silently
 * quote a premium tier.
 */
export function splitModelSize(modelId: string): {
  apiModel: string;
  size: string;
} {
  const at = modelId.lastIndexOf(":");
  if (at > 0) {
    const suffix = modelId.slice(at + 1);
    if (/^\d{3,4}x\d{3,4}$/.test(suffix)) {
      return { apiModel: modelId.slice(0, at), size: suffix };
    }
  }
  return { apiModel: modelId, size: "720x1280" };
}
