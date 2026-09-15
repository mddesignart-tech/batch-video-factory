/**
 * Where a money figure came from.
 *
 * This exists because three very different numbers were being displayed in the
 * same place, in the same format, with nothing to tell them apart - and one of
 * them was fiction.
 *
 * The concrete failure: `availableProviderNames()` returns `["mock"]` whenever
 * AI_MOCK_MODE is on, and the cost estimator routes only to providers on that
 * list. So every "Tổng chi phí dự kiến" the batch page has ever shown was
 * computed from the SIMULATED prices on the mock model rows - and those prices
 * are not close to the real ones. Mock voice is priced at $0.015 per 1k
 * characters against OpenAI's real $0.0006, twenty-five times too high; mock
 * image is $0.02 against gpt-image-2's $0.048, less than half. The number was
 * wrong in both directions and labelled as a forecast of real spending.
 *
 * A single `number` cannot carry that distinction, so the distinction has to be
 * carried beside it, everywhere, by type.
 */

export const COST_BASES = ["MOCK", "PRODUCTION_ESTIMATE", "ACTUAL"] as const;
export type CostBasis = (typeof COST_BASES)[number];

/**
 * MOCK
 *   Simulated prices from the `mock` provider's rows. They exist so budget
 *   logic, routing and the spend guard can be exercised for free. They are NOT
 *   an approximation of anything a vendor charges and must never be presented
 *   as a forecast.
 *
 * PRODUCTION_ESTIMATE
 *   Computed from real vendor rows at their list prices, for the providers that
 *   would actually be reachable with mock mode off. This is the number an
 *   operator authorises money against.
 *
 * ACTUAL
 *   What a vendor reported having charged. The only figure that is money.
 */
export const VI_COST_BASIS: Record<CostBasis, string> = {
  MOCK: "Giá giả lập (mock) — KHÔNG phải tiền",
  PRODUCTION_ESTIMATE: "Dự toán chạy thật",
  ACTUAL: "Chi phí thật đã bị tính",
};

/** Short tag for tables, where the full sentence will not fit. */
export const VI_COST_BASIS_SHORT: Record<CostBasis, string> = {
  MOCK: "MOCK",
  PRODUCTION_ESTIMATE: "DỰ TOÁN THẬT",
  ACTUAL: "THỰC TẾ",
};

/**
 * Derive the basis from the providers a plan actually routed to.
 *
 * Derived rather than passed in, because a flag a caller has to remember to set
 * is a flag that eventually gets set wrong - and getting THIS one wrong is how
 * a simulated price ends up on the approval screen. Reading it back off the
 * chosen providers cannot drift from what was chosen.
 */
export function basisForProviders(providers: readonly string[]): CostBasis {
  const real = providers.filter((name) => name !== "mock");
  return real.length > 0 ? "PRODUCTION_ESTIMATE" : "MOCK";
}

/**
 * Safety margin over a forecast, as a fraction.
 *
 * Estimates are built from list prices and billed-second rules, and vendors
 * round in their own favour. A batch that halts on the last scene of the last
 * video because the invoice came in three cents high has wasted everything
 * before it, so the recommended ceiling carries headroom.
 *
 * It is a RECOMMENDATION. The app never approves it - a person types the
 * number they are willing to lose.
 */
export const DEFAULT_SAFETY_MARGIN = 0.1;

export interface Recommendation {
  estimated: number;
  safetyMarginPct: number;
  /** estimated + margin, rounded up to a whole cent. */
  recommended: number;
  /** Lowered to this because the app-wide cap allows no more. */
  clampedByGlobalCap: boolean;
}

/**
 * What to pre-fill the authorisation box with, and why.
 *
 * Never above what the app-wide cap still allows: authorising more than the
 * tool has left would create a permission that cannot be honoured, and the
 * failure would surface halfway through a run rather than at the click.
 */
export function recommendAuthorization(
  estimated: number,
  globalRemaining: number,
  safetyMarginPct: number = DEFAULT_SAFETY_MARGIN,
): Recommendation {
  if (estimated <= 0) {
    return {
      estimated: 0,
      safetyMarginPct,
      recommended: 0,
      clampedByGlobalCap: false,
    };
  }
  const withMargin = Math.ceil(estimated * (1 + safetyMarginPct) * 100) / 100;
  const capped = Math.max(0, globalRemaining);
  return {
    estimated,
    safetyMarginPct,
    recommended: Math.min(withMargin, capped),
    clampedByGlobalCap: withMargin > capped,
  };
}
