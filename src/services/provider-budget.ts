import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { round } from "@/lib/utils";

/**
 * One wallet per provider. They are never added together.
 *
 * This exists because adding them is the obvious mistake and an expensive one:
 * $6 topped up at OpenAI buys nothing at Runway, and a guard that saw $6 + 1000
 * Runway credits as "plenty available" would happily authorise a Sora call
 * against money that is sitting in the wrong account. The request would then
 * fail at the vendor with a 402 - after being counted as affordable.
 *
 * The app-wide cap in `spend-guard` still applies on top. It answers a different
 * question - "has this tool spent more than I authorised IN TOTAL" - and a
 * request must pass both. Neither replaces the other:
 *
 *   the app cap   protects the operator from this tool
 *   the wallets   describe what each vendor will actually honour
 *
 * Balances here are what the OPERATOR told us. Where a vendor exposes a real
 * balance - Runway does - that live figure is the authority and this is a
 * cross-check.
 */

export const PROVIDER_BUDGET_SETTING = "spend.providerBudgets";

/** How a provider's money is counted. */
export type BudgetUnit =
  | "usd" // prepaid dollars, e.g. OpenAI
  | "credits" // vendor credits, e.g. Runway
  | "external"; // billed elsewhere, e.g. a Groq plan with its own quota

export interface ProviderBudget {
  provider: string;
  unit: BudgetUnit;
  /**
   * What the operator says is available, in `unit`.
   *
   * For "external" this is not a limit but a note: the vendor enforces its own
   * quota and we have no number worth pretending to hold.
   */
  available: number;
  /** Dollars per credit, for converting an estimate. 1 for usd. */
  usdPerUnit: number;
  /** Free text: where the money came from, when it was checked. */
  note: string;
  /** ISO date the operator last confirmed this figure. */
  updatedAt: string;
  /**
   * Can this balance be read back from the vendor?
   *
   * Runway exposes one at GET /organization, so its figure can be refreshed and
   * trusted. OpenAI does not expose a balance to an API key, so its number is
   * whatever the operator typed - which must be LABELLED as declared. Showing a
   * typed figure as if it were live is how someone plans a render against money
   * that was spent last week.
   */
  liveBalanceAvailable: boolean;
}

/**
 * Defaults reflecting what is known right now.
 *
 * Runway's 1000 credits are the live figure read from GET /organization at the
 * time of writing, and 25 of them were spent on the scene-5 clip. It is listed
 * here so the two wallets appear side by side and cannot be mistaken for one,
 * not because this app is the authority on it.
 */
export function defaultBudgets(): ProviderBudget[] {
  const now = new Date().toISOString();
  return [
    {
      provider: "openai",
      unit: "usd",
      available: 6,
      usdPerUnit: 1,
      note: "Nạp $6 vào tài khoản OpenAI. Dùng cho Image, Sora, TTS, GPT.",
      updatedAt: now,
      // OpenAI gives an API key no way to read the account balance, so this is
      // a declared figure and the UI must say so.
      liveBalanceAvailable: false,
    },
    {
      provider: "runway",
      unit: "credits",
      available: 975,
      // 5 credits/second at $0.01/credit, confirmed against a real charge:
      // the scene-5 clip cost exactly 25 credits for 5 seconds.
      usdPerUnit: 0.01,
      note: "Credit riêng của Runway. KHÔNG liên quan tới số dư OpenAI.",
      updatedAt: now,
      // GET /organization returns creditBalance, so this one can be refreshed
      // from the vendor and checked against our ledger.
      liveBalanceAvailable: true,
    },
    {
      provider: "groq",
      unit: "external",
      available: 0,
      usdPerUnit: 1,
      note: "Groq tự tính theo gói/hạn mức riêng của họ. Tool không giữ số dư.",
      updatedAt: now,
      liveBalanceAvailable: false,
    },
  ];
}

function parse(valueJson: string | undefined): ProviderBudget[] | null {
  if (!valueJson) return null;
  try {
    const value: unknown = JSON.parse(valueJson);
    if (!Array.isArray(value)) return null;
    const rows: ProviderBudget[] = [];
    for (const raw of value) {
      if (raw === null || typeof raw !== "object") continue;
      const b = raw as Partial<ProviderBudget>;
      if (typeof b.provider !== "string" || typeof b.available !== "number") continue;
      rows.push({
        provider: b.provider,
        unit: b.unit === "credits" || b.unit === "external" ? b.unit : "usd",
        available: Number.isFinite(b.available) ? b.available : 0,
        usdPerUnit:
          typeof b.usdPerUnit === "number" && Number.isFinite(b.usdPerUnit)
            ? b.usdPerUnit
            : 1,
        note: typeof b.note === "string" ? b.note : "",
        updatedAt: typeof b.updatedAt === "string" ? b.updatedAt : "",
        // Default FALSE. A balance is declared until something proves it can be
        // read back; assuming otherwise would label a typed number as live.
        liveBalanceAvailable: b.liveBalanceAvailable === true,
      });
    }
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

export async function getProviderBudgets(): Promise<ProviderBudget[]> {
  const row = await prisma.setting.findUnique({
    where: { key: PROVIDER_BUDGET_SETTING },
  });
  return parse(row?.valueJson) ?? defaultBudgets();
}

export async function setProviderBudget(
  update: Pick<ProviderBudget, "provider" | "available"> &
    Partial<
      Pick<ProviderBudget, "unit" | "usdPerUnit" | "note" | "liveBalanceAvailable">
    >,
): Promise<ProviderBudget[]> {
  const current = await getProviderBudgets();
  const now = new Date().toISOString();
  const existing = current.find((b) => b.provider === update.provider);

  const next: ProviderBudget[] = existing
    ? current.map((b) =>
        b.provider === update.provider
          ? {
              ...b,
              available: Math.max(0, update.available),
              unit: update.unit ?? b.unit,
              usdPerUnit: update.usdPerUnit ?? b.usdPerUnit,
              note: update.note ?? b.note,
              liveBalanceAvailable:
                update.liveBalanceAvailable ?? b.liveBalanceAvailable,
              updatedAt: now,
            }
          : b,
      )
    : [
        ...current,
        {
          provider: update.provider,
          unit: update.unit ?? "usd",
          available: Math.max(0, update.available),
          usdPerUnit: update.usdPerUnit ?? 1,
          note: update.note ?? "",
          updatedAt: now,
          // A newly declared wallet is declared unless the caller states
          // otherwise. Only a provider we can actually read a balance from
          // should ever be marked live.
          liveBalanceAvailable: update.liveBalanceAvailable ?? false,
        },
      ];

  await prisma.setting.upsert({
    where: { key: PROVIDER_BUDGET_SETTING },
    create: {
      key: PROVIDER_BUDGET_SETTING,
      valueJson: JSON.stringify(next),
    },
    update: { valueJson: JSON.stringify(next) },
  });
  await logger.warn({
    event: "spend.provider_budget_changed",
    provider: update.provider,
    message:
      `Ngân sách ${update.provider} đặt thành ${update.available} ` +
      `${update.unit ?? existing?.unit ?? "usd"}.`,
  });
  return next;
}

/** Add to a provider's wallet, for a top-up. */
export async function addProviderBudget(
  provider: string,
  amount: number,
): Promise<ProviderBudget[]> {
  const current = await getProviderBudgets();
  const existing = current.find((b) => b.provider === provider);
  return setProviderBudget({
    provider,
    available: (existing?.available ?? 0) + amount,
    unit: existing?.unit,
    usdPerUnit: existing?.usdPerUnit,
    note: existing?.note,
  });
}

export interface ProviderSpendRow {
  provider: string;
  /** Real dollars this tool has recorded against that provider. */
  spentUsd: number;
  calls: number;
  budget: ProviderBudget | null;
  /** Available converted to dollars, for display beside spend. */
  availableUsd: number | null;
  /**
   * Whether this provider's own wallet can still cover work.
   *
   * Null for "external": the vendor enforces its own quota and inventing a
   * remaining figure would be a fiction the guard might then act on.
   */
  remainingUsd: number | null;
}

/**
 * Spend per provider, beside each provider's own wallet.
 *
 * Deliberately NOT summed into a single "available" figure anywhere in this
 * function's return. Two vendors' balances are not fungible and a caller that
 * wants one number is about to make the mistake this module exists to prevent.
 */
export async function providerSpendBreakdown(): Promise<ProviderSpendRow[]> {
  const [grouped, budgets] = await Promise.all([
    prisma.costEntry.groupBy({
      by: ["provider"],
      where: { estimated: false, provider: { not: "mock" } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    getProviderBudgets(),
  ]);

  const providers = new Set<string>([
    ...grouped.map((g) => g.provider),
    ...budgets.map((b) => b.provider),
  ]);

  return [...providers]
    .map((provider) => {
      const row = grouped.find((g) => g.provider === provider);
      const budget = budgets.find((b) => b.provider === provider) ?? null;
      const spentUsd = round(row?._sum.amount ?? 0, 6);
      const availableUsd =
        budget && budget.unit !== "external"
          ? round(budget.available * budget.usdPerUnit, 6)
          : null;
      return {
        provider,
        spentUsd,
        calls: row?._count._all ?? 0,
        budget,
        availableUsd,
        // A prepaid balance is what is LEFT: the spend already came out of it.
        // Subtracting recorded spend again would double-count.
        remainingUsd: availableUsd,
      };
    })
    .sort((a, b) => b.spentUsd - a.spentUsd);
}

export class ProviderBudgetExceededError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly availableUsd: number,
    readonly wouldSpendUsd: number,
  ) {
    super(message);
    this.name = "ProviderBudgetExceededError";
  }
}

/**
 * Can THIS provider's own wallet cover this request?
 *
 * Separate from the app-wide cap on purpose. A request must satisfy both, and
 * they fail for different reasons an operator needs told apart: "this tool has
 * spent its allowance" is a decision to revisit, "that account has no money" is
 * a trip to the vendor's billing page.
 */
export async function assertProviderBudget(opts: {
  provider: string;
  model: string;
  estimatedCost: number;
}): Promise<void> {
  const budgets = await getProviderBudgets();
  const budget = budgets.find((b) => b.provider === opts.provider);

  // No wallet recorded, or one the vendor enforces itself. Nothing to check
  // here - the app-wide cap still applies, and the vendor will refuse if it
  // must. Inventing a limit would block work for no reason.
  if (!budget || budget.unit === "external") return;

  const availableUsd = round(budget.available * budget.usdPerUnit, 6);
  const cost = Math.max(0, opts.estimatedCost);

  if (cost > availableUsd) {
    throw new ProviderBudgetExceededError(
      `Tài khoản ${opts.provider} chỉ còn ${budget.available} ${budget.unit} ` +
        `(≈$${availableUsd.toFixed(4)}), không đủ cho yêu cầu ước tính ` +
        `$${cost.toFixed(4)}. Đây là số dư RIÊNG của ${opts.provider} — ` +
        `tiền ở nhà cung cấp khác không dùng được ở đây. ` +
        `Hãy nạp thêm tại ${opts.provider}, hoặc chọn nhà cung cấp khác.`,
      opts.provider,
      availableUsd,
      cost,
    );
  }
}
