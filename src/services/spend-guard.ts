import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { isMockMode } from "@/lib/env";
import { round } from "@/lib/utils";

/**
 * Hard spend cap for real provider calls.
 *
 * This is a separate, blunter instrument than a project's MAX BUDGET. A project
 * budget stops one project from getting expensive; this stops the *whole
 * application* from spending more than the operator has explicitly authorised,
 * across every project, batch and retry combined.
 *
 * It is checked immediately before every real (non-mock) provider request, and
 * it counts actual recorded spend, not estimates.
 */

export const SPEND_CAP_SETTING = "spend.cap";
export const SPEND_CONFIRM_SETTING = "spend.confirmedProviders";

/** Default authorised ceiling for the whole app, in USD. */
export const DEFAULT_SPEND_CAP = 0.5;

export class SpendCapExceededError extends Error {
  constructor(
    message: string,
    readonly spent: number,
    readonly cap: number,
    readonly wouldSpend: number,
  ) {
    super(message);
    this.name = "SpendCapExceededError";
  }
}

export class ProviderNotConfirmedError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly model: string,
  ) {
    super(message);
    this.name = "ProviderNotConfirmedError";
  }
}

export async function getSpendCap(): Promise<number> {
  const row = await prisma.setting.findUnique({
    where: { key: SPEND_CAP_SETTING },
  });
  if (!row) return DEFAULT_SPEND_CAP;
  try {
    const value: unknown = JSON.parse(row.valueJson);
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : DEFAULT_SPEND_CAP;
  } catch {
    return DEFAULT_SPEND_CAP;
  }
}

export async function setSpendCap(cap: number): Promise<void> {
  const valueJson = JSON.stringify(Math.max(0, cap));
  await prisma.setting.upsert({
    where: { key: SPEND_CAP_SETTING },
    create: { key: SPEND_CAP_SETTING, valueJson },
    update: { valueJson },
  });
  await logger.warn({
    event: "spend.cap_changed",
    message: `Hạn mức chi tiêu API đổi thành $${cap.toFixed(2)}.`,
  });
}

/**
 * Everything actually charged by a real provider, ever.
 *
 * Mock entries are $0 so they do not move this number, but they are excluded
 * explicitly anyway - the cap must mean "real money", and relying on mock rows
 * happening to be zero would be fragile.
 */
export async function totalRealSpend(): Promise<number> {
  const agg = await prisma.costEntry.aggregate({
    where: { estimated: false, provider: { not: "mock" } },
    _sum: { amount: true },
  });
  return round(agg._sum.amount ?? 0);
}

export interface SpendStatus {
  spent: number;
  cap: number;
  remaining: number;
  /** Providers the operator has explicitly approved for real calls. */
  confirmedProviders: string[];
}

export async function spendStatus(): Promise<SpendStatus> {
  const [spent, cap, confirmed] = await Promise.all([
    totalRealSpend(),
    getSpendCap(),
    confirmedProviders(),
  ]);
  return {
    spent,
    cap,
    remaining: round(Math.max(0, cap - spent)),
    confirmedProviders: confirmed,
  };
}

// --------------------------------------------------------- confirmation ---

export async function confirmedProviders(): Promise<string[]> {
  const row = await prisma.setting.findUnique({
    where: { key: SPEND_CONFIRM_SETTING },
  });
  if (!row) return [];
  try {
    const value: unknown = JSON.parse(row.valueJson);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Record that the operator has seen provider + model + estimated cost and said
 * yes. Confirmation is per provider/model pair, not global: approving a cheap
 * text model must not silently authorise an expensive video one.
 */
export async function confirmProvider(
  provider: string,
  model: string,
): Promise<void> {
  const key = `${provider}/${model}`;
  const current = await confirmedProviders();
  if (current.includes(key)) return;
  const valueJson = JSON.stringify([...current, key]);
  await prisma.setting.upsert({
    where: { key: SPEND_CONFIRM_SETTING },
    create: { key: SPEND_CONFIRM_SETTING, valueJson },
    update: { valueJson },
  });
  await logger.warn({
    event: "spend.provider_confirmed",
    provider,
    model,
    message: `Người dùng đã xác nhận cho phép gọi API thật: ${key}`,
  });
}

export async function revokeProvider(
  provider: string,
  model: string,
): Promise<void> {
  const key = `${provider}/${model}`;
  const current = await confirmedProviders();
  const valueJson = JSON.stringify(current.filter((c) => c !== key));
  await prisma.setting.upsert({
    where: { key: SPEND_CONFIRM_SETTING },
    create: { key: SPEND_CONFIRM_SETTING, valueJson },
    update: { valueJson },
  });
}

export async function isProviderConfirmed(
  provider: string,
  model: string,
): Promise<boolean> {
  return (await confirmedProviders()).includes(`${provider}/${model}`);
}

/**
 * Whether a model may be switched on for the router to use.
 *
 * A model with no price is the quiet path to an unexpected bill: every estimate
 * and every budget check involving it silently evaluates to zero. Local runtimes
 * are the honest exception - they really do cost nothing.
 *
 * Pure so it can be tested directly; the server action is a thin wrapper.
 */
export function canEnableModel(model: {
  provider: string;
  type: string;
  price: number;
  priceOutput: number;
}): { allowed: true } | { allowed: false; reason: string } {
  if (model.provider === "mock") return { allowed: true };
  if (LOCAL_FREE_PROVIDERS.has(model.provider)) return { allowed: true };

  const unpriced =
    model.type === "text"
      ? model.price <= 0 && model.priceOutput <= 0
      : model.price <= 0;

  if (unpriced) {
    return {
      allowed: false,
      reason:
        "Hãy nhập giá thực tế của mô hình này trước khi bật, nếu không phần ước tính " +
        "chi phí và hạn mức chi tiêu sẽ sai. Model text cần cả giá input và output.",
    };
  }
  return { allowed: true };
}

/** Providers that run on this machine and therefore bill nothing. */
export const LOCAL_FREE_PROVIDERS = new Set(["ollama", "lmstudio"]);

// ------------------------------------------------------------ the gate ---

/**
 * The gate every real provider call must pass.
 *
 * Three conditions, in order of how badly getting them wrong would hurt:
 *   1. mock mode short-circuits (nothing to guard),
 *   2. the provider/model pair must have been explicitly confirmed,
 *   3. projected spend must stay under the authorised cap.
 */
export async function assertCanSpend(opts: {
  provider: string;
  model: string;
  estimatedCost: number;
}): Promise<SpendStatus> {
  const status = await spendStatus();
  if (isMockMode()) return status;

  if (opts.provider !== "mock") {
    if (!status.confirmedProviders.includes(`${opts.provider}/${opts.model}`)) {
      throw new ProviderNotConfirmedError(
        `Chưa được phép gọi API thật của ${opts.provider}/${opts.model}. ` +
          `Hãy mở trang "Nhà cung cấp AI", xem chi phí ước tính và bấm xác nhận trước.`,
        opts.provider,
        opts.model,
      );
    }

    const projected = round(status.spent + Math.max(0, opts.estimatedCost));
    if (projected > status.cap) {
      throw new SpendCapExceededError(
        `Đã chi $${status.spent.toFixed(4)} cho API thật. Yêu cầu này ước tính ` +
          `thêm $${opts.estimatedCost.toFixed(4)}, tổng $${projected.toFixed(4)} ` +
          `sẽ vượt hạn mức $${status.cap.toFixed(2)}. Yêu cầu bị chặn. ` +
          `Hãy tăng hạn mức trong trang Cài đặt nếu muốn tiếp tục.`,
        status.spent,
        status.cap,
        projected,
      );
    }
  }

  return status;
}
