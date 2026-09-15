import type { ModelRegistry } from "@prisma/client";
import type { PriceUnit } from "@/domain/enums";
import { round } from "@/lib/utils";

/**
 * Six decimals, not the four `round()` defaults to.
 *
 * Exactly the bug the cost LEDGER was fixed for, left behind in the estimator:
 * a voice line of 37 characters at $0.0006 per 1k costs $0.0000222, which at
 * four places is $0.0000. Per scene it disappears; across six scenes the whole
 * video's speech estimate came out as $0.00 while the real figure is $0.000135.
 *
 * The amount is small. The habit of quietly rounding real money to zero is not,
 * and a 200-scene batch would round away something that matters.
 */
const MONEY_DIGITS = 6;

/**
 * Price maths.
 *
 * Every number here comes out of the ModelRegistry table, which is editable in
 * the admin UI. There is deliberately no hard-coded vendor price anywhere in the
 * codebase: when a provider changes its rate card, that is a data edit, not a
 * release.
 */

export interface UsageUnits {
  seconds?: number;
  images?: number;
  characters?: number;
  tokens?: number;
  jobs?: number;
}

export function costForModel(model: ModelRegistry, usage: UsageUnits): number {
  const unit = model.priceUnit as PriceUnit;
  switch (unit) {
    case "per_second":
      return round(model.price * (usage.seconds ?? 0), MONEY_DIGITS);
    case "per_image":
      return round(model.price * (usage.images ?? 1), MONEY_DIGITS);
    case "per_1k_chars":
      return round(model.price * ((usage.characters ?? 0) / 1000), MONEY_DIGITS);
    case "per_1k_tokens":
      return round(model.price * ((usage.tokens ?? 0) / 1000), MONEY_DIGITS);
    case "per_job":
      return round(model.price * (usage.jobs ?? 1), MONEY_DIGITS);
    default:
      return 0;
  }
}

/**
 * A single 0-10 number combining the three ratings an operator maintains plus
 * the success rate the app measures itself. Consistency is weighted heavily for
 * this niche: a video where the character's face changes between scenes reads as
 * broken no matter how pretty each individual frame is.
 */
export function qualityIndex(model: ModelRegistry): number {
  const base =
    model.qualityRating * 0.5 +
    model.consistencyRating * 0.35 +
    model.speedRating * 0.15;
  // A model that fails often is worse than its rating claims, because every
  // failure costs a retry.
  return round(base * clamp01(model.historicalSuccessRate), 3);
}

/** Quality delivered per dollar. Free (mock) models sort by quality alone. */
export function valueIndex(model: ModelRegistry, cost: number): number {
  const q = qualityIndex(model);
  if (cost <= 0) return q * 1000;
  return round(q / cost, 4);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** Retry allowance per mode, used to pad an estimate honestly. */
export const RETRY_FACTOR: Record<string, number> = {
  ECONOMY: 0.05,
  BALANCED: 0.2,
  QUALITY: 0.45,
  CUSTOM: 0.2,
};

export function expectedRetryMultiplier(
  qualityMode: string,
  successRate: number,
): number {
  const allowance = RETRY_FACTOR[qualityMode] ?? 0.2;
  const failureRate = 1 - clamp01(successRate);
  return 1 + allowance * Math.max(failureRate, 0.15);
}
