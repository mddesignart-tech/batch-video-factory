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

/**
 * Ranges the candidate models accept, in whole seconds.
 *
 * MANUAL data, from docs.dev.runwayml.com/assets/inputs (2026-09-15). Runway
 * serves no endpoint that reports this, so it cannot be verified in code -
 * which is exactly why it is written down with a date and a source rather than
 * left as a constant somebody will later assume was measured.
 *
 * h3_max's floor of 5 matters for us: our LOW scenes are written at exactly 5
 * seconds (QĐ-030), so the request goes out unchanged with nothing padded and
 * nothing thrown away.
 */
export const WAN3_MIN_SECONDS = 2;
export const WAN3_MAX_SECONDS = 30;
export const H3_MAX_MIN_SECONDS = 5;
export const H3_MAX_MAX_SECONDS = 15;

/** Runway models that bill per second rather than per fixed clip length. */
const RUNWAY_PER_SECOND_MODELS = new Set(["gen4.5", "wan3", "h3_max", "veo3.1_fast"]);

/** Clip lengths Veo sells, before its 8-second forcing rules apply. */
export const VEO_DURATIONS = [4, 6, 8] as const;

/**
 * Clip lengths OpenAI's Sora-2 accepts. Nothing else is a valid request.
 *
 * This set was missing entirely, and its absence was not a small gap. The
 * `default` branch below billed "exactly what was asked", so the estimator
 * happily quoted a 3-second scene at $0.30, a 5-second at $0.50 and a 6-second
 * at $0.60 - three prices for three requests the API would have REJECTED. The
 * cost preview was arithmetic on durations that could never be sent.
 *
 * The project's own benchmark table already held the evidence: two 4-second
 * clips succeeded, and a 6-second request came back HTTP 400. That was recorded
 * as "probably not a valid length - unproven without another POST". It was a
 * valid reading of the data, and this is the confirmation.
 */
export const SORA_DURATIONS = [4, 8, 12] as const;

/**
 * Durations a model accepts, or null when it bills continuously.
 *
 * Keyed by `provider/apiModel`, falling back to the bare provider, the same way
 * the suitability rules are looked up - evidence is gathered per model, and a
 * model should not inherit a limit just for sharing a company.
 */
const ALLOWED_DURATIONS: Record<string, readonly number[]> = {
  "openai/sora-2": SORA_DURATIONS,
  "runway/gen4_turbo": RUNWAY_TURBO_DURATIONS,
  "google/veo": VEO_DURATIONS,
  // Continuous ranges, listed as whole seconds. Written out rather than
  // expressed as a min/max pair so `allowedDurationsFor` keeps ONE shape -
  // a second representation of "what lengths are legal" is a second place for
  // the two to disagree.
  "runway/wan3": wholeSeconds(WAN3_MIN_SECONDS, WAN3_MAX_SECONDS),
  "runway/h3_max": wholeSeconds(H3_MAX_MIN_SECONDS, H3_MAX_MAX_SECONDS),
  "runway/veo3.1_fast": wholeSeconds(2, 10),
};

function wholeSeconds(min: number, max: number): readonly number[] {
  const out: number[] = [];
  for (let n = min; n <= max; n += 1) out.push(n);
  return out;
}

export function allowedDurationsFor(
  provider: string,
  model?: string,
): readonly number[] | null {
  const apiModel = model ? splitModelSize(model).apiModel : "";
  if (apiModel && ALLOWED_DURATIONS[`${provider}/${apiModel}`]) {
    return ALLOWED_DURATIONS[`${provider}/${apiModel}`]!;
  }
  return ALLOWED_DURATIONS[provider] ?? null;
}

/** What has to happen to a scene's length before it can be sent. */
export type DurationStatus =
  /** The vendor takes this length as asked. */
  | "EXACT"
  /** Sendable as asked, but the vendor bills a longer clip. */
  | "PADDED"
  /**
   * The vendor would REJECT this length. The request cannot go out unchanged,
   * and changing a scene's length is a content decision, not a rounding detail.
   */
  | "DURATION_TRANSFORM_REQUIRED";

export interface DurationPlan {
  requested: number;
  /** The length that would actually be sent, and therefore billed. */
  willSend: number;
  /** Null when the model bills continuously. */
  allowed: readonly number[] | null;
  status: DurationStatus;
  /** Vietnamese, for the plan table. */
  reason: string;
}

/**
 * Decide what length would really be sent, and say so out loud.
 *
 * The important part is what this does NOT do: it never quietly substitutes a
 * length. A scene written for six seconds that a vendor cannot take is reported
 * as `DURATION_TRANSFORM_REQUIRED` with the nearest length it would accept, and
 * a person decides whether the scene becomes eight seconds or goes somewhere
 * else. Silently rewriting it would change the video to suit the vendor, and
 * would do it at the layer least able to judge whether that is acceptable.
 *
 * `willSend` is still populated for a rejected length, because the COST preview
 * must be honest about what a transformed request would cost - $0.80 for an
 * eight-second Sora clip, not $0.60 for a six-second one that cannot exist.
 */
export function planDuration(args: {
  provider: string;
  model?: string;
  size: string;
  requestedSeconds: number;
  hasKeyframe: boolean;
}): DurationPlan {
  const { provider, model, requestedSeconds } = args;
  const allowed = allowedDurationsFor(provider, model);
  const billed = billedVideoSeconds(args);

  if (allowed === null) {
    return {
      requested: requestedSeconds,
      willSend: billed,
      allowed: null,
      status: billed > requestedSeconds ? "PADDED" : "EXACT",
      reason:
        billed > requestedSeconds
          ? `nhà cung cấp tính tiền tối thiểu ${billed}s`
          : "gửi đúng thời lượng yêu cầu",
    };
  }

  if (allowed.includes(requestedSeconds)) {
    return {
      requested: requestedSeconds,
      willSend: requestedSeconds,
      allowed,
      status: "EXACT",
      reason: "thời lượng nằm trong tập hợp lệ của nhà cung cấp",
    };
  }

  return {
    requested: requestedSeconds,
    willSend: billed,
    allowed,
    status: "DURATION_TRANSFORM_REQUIRED",
    reason:
      `cảnh dài ${requestedSeconds}s nhưng ${model ?? provider} chỉ nhận ` +
      `${allowed.join("/")}s. Request này KHÔNG gửi được như hiện tại. ` +
      `Gần nhất là ${billed}s — đổi hay không là quyết định về nội dung, ` +
      `không phải chuyện làm tròn.`,
  };
}

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
        // Whole seconds, clamped to the range THIS model sells. Rounding UP so
        // a fractional scene length is never quoted short.
        //
        // The range comes from the model's own row, not from gen4.5's. When
        // gen4.5 was the only per-second model, its 2-10 was hardcoded here;
        // adding siblings made that silently wrong in both directions - it
        // would quote a 12-second h3_max clip as 10 (under-billing a request
        // the vendor accepts) and pad nothing at h3_max's real floor of 5.
        const allowed = allowedDurationsFor("runway", apiModel);
        const min = allowed?.[0] ?? RUNWAY_GEN45_MIN_SECONDS;
        const max = allowed?.[allowed.length - 1] ?? RUNWAY_GEN45_MAX_SECONDS;
        return Math.min(max, Math.max(min, Math.ceil(requestedSeconds)));
      }
      return nearestFrom(RUNWAY_TURBO_DURATIONS, requestedSeconds);
    }
    case "google":
      if (forcedToEightSeconds(size, hasKeyframe)) return 8;
      return nearestFrom(VEO_DURATIONS, requestedSeconds);
    case "openai":
      // Sora sells 4, 8 or 12 seconds and rejects anything else. The old
      // `default` branch billed exactly what was asked, which produced prices
      // for 3-, 5- and 6-second requests that the API would refuse to accept.
      return nearestFrom(SORA_DURATIONS, requestedSeconds);
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
