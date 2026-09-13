"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { errorMessage } from "@/lib/utils";
import {
  discoverTextModels,
  type ModelDiscovery,
} from "@/services/model-discovery";
import {
  confirmProvider,
  revokeProvider,
  setSpendCap,
  spendStatus,
} from "@/services/spend-guard";
import type { ActionResult } from "./idioms";

/**
 * Actions for the real-spending gate.
 *
 * Confirming a provider is the single most consequential click in the app - it
 * is what allows real money to be spent - so it is deliberately its own action,
 * scoped to one provider/model pair, and never bundled into a larger form.
 */

/**
 * What the operator must be shown before they can confirm.
 *
 * Assembled server-side so the numbers come from the registry rather than from
 * anything the browser could have stale.
 */
export interface SpendPreview {
  provider: string;
  model: string;
  displayName: string;
  priceInput: number;
  priceOutput: number;
  /** Upper-bound cost of one script generation run. */
  estimatedPerScript: number;
  mockMode: boolean;
  spent: number;
  cap: number;
  remaining: number;
  confirmed: boolean;
  isFree: boolean;
  warnings: string[];
}

/**
 * A full script run is: 1 generation + 1 self-score, and possibly a rewrite
 * (another generation + score). Four calls is the realistic worst case.
 */
const CALLS_PER_SCRIPT_WORST_CASE = 4;
const TYPICAL_INPUT_TOKENS = 1400;
const TYPICAL_OUTPUT_TOKENS = 2500;

export async function getSpendPreview(
  provider: string,
  modelId: string,
): Promise<SpendPreview | null> {
  const [model, status] = await Promise.all([
    prisma.modelRegistry.findUnique({
      where: { provider_modelId: { provider, modelId } },
    }),
    spendStatus(),
  ]);
  if (!model) return null;

  const perCall =
    (TYPICAL_INPUT_TOKENS / 1000) * model.price +
    (TYPICAL_OUTPUT_TOKENS / 1000) * model.priceOutput;
  const estimatedPerScript = round6(perCall * CALLS_PER_SCRIPT_WORST_CASE);

  const isFree = provider === "ollama" || provider === "lmstudio";
  const warnings: string[] = [];

  if (!isFree && model.price <= 0 && model.priceOutput <= 0) {
    warnings.push(
      "Model này đang để giá 0. Hãy nhập giá thực tế từ bảng giá của nhà cung cấp " +
        "trong trang Mô hình AI, nếu không phần ước tính và hạn mức chi tiêu sẽ vô nghĩa.",
    );
  }
  if (!model.enabled) {
    warnings.push("Model đang bị tắt. Bật nó trong trang Mô hình AI trước khi dùng.");
  }
  if (isMockMode()) {
    warnings.push(
      "AI_MOCK_MODE vẫn đang bật, nên mọi yêu cầu vẫn chạy bằng mock và " +
        "KHÔNG tốn phí. Đặt AI_MOCK_MODE=false trong .env rồi khởi động lại " +
        "để thực sự gọi API thật.",
    );
  }
  if (!isFree && estimatedPerScript > status.remaining) {
    warnings.push(
      `Một kịch bản ước tính tốn tới $${estimatedPerScript.toFixed(4)} nhưng ` +
        `hạn mức chỉ còn $${status.remaining.toFixed(4)}.`,
    );
  }

  return {
    provider,
    model: modelId,
    displayName: model.displayName,
    priceInput: model.price,
    priceOutput: model.priceOutput,
    estimatedPerScript,
    mockMode: isMockMode(),
    spent: status.spent,
    cap: status.cap,
    remaining: status.remaining,
    confirmed: status.confirmedProviders.includes(`${provider}/${modelId}`),
    isFree,
    warnings,
  };
}

export async function approveRealSpending(
  provider: string,
  modelId: string,
): Promise<ActionResult> {
  try {
    const preview = await getSpendPreview(provider, modelId);
    if (!preview) {
      return { ok: false, message: "Không tìm thấy model trong bảng Mô hình AI." };
    }
    if (!preview.isFree && preview.priceInput <= 0 && preview.priceOutput <= 0) {
      // Confirming a model with no price would authorise spending against a cap
      // that cannot be computed. Refuse rather than approve something blind.
      return {
        ok: false,
        message:
          "Chưa nhập giá cho model này. Hãy nhập giá input/output thực tế trong " +
          "trang Mô hình AI trước khi cho phép gọi API thật.",
      };
    }

    await confirmProvider(provider, modelId);
    revalidatePath("/providers");
    return {
      ok: true,
      message:
        `Đã cho phép gọi API thật với ${provider}/${modelId}. ` +
        `Hạn mức còn lại: $${preview.remaining.toFixed(4)}.`,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function revokeRealSpending(
  provider: string,
  modelId: string,
): Promise<ActionResult> {
  await revokeProvider(provider, modelId);
  revalidatePath("/providers");
  return {
    ok: true,
    message: `Đã thu hồi quyền gọi API thật của ${provider}/${modelId}.`,
  };
}

export async function updateSpendCap(formData: FormData): Promise<ActionResult> {
  const parsed = z
    .object({ cap: z.coerce.number().min(0).max(1000) })
    .safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { ok: false, message: "Hạn mức không hợp lệ (0 - 1000 USD)." };
  }

  const status = await spendStatus();
  if (parsed.data.cap < status.spent) {
    return {
      ok: false,
      message:
        `Hạn mức mới ($${parsed.data.cap.toFixed(2)}) thấp hơn số đã chi ` +
        `($${status.spent.toFixed(4)}). Mọi yêu cầu trả phí sẽ bị chặn ngay lập tức.`,
    };
  }

  await setSpendCap(parsed.data.cap);
  revalidatePath("/settings");
  revalidatePath("/providers");
  return {
    ok: true,
    message: `Đã đặt hạn mức chi tiêu API thật là $${parsed.data.cap.toFixed(2)}.`,
  };
}

/**
 * Ask a provider for its live model list.
 *
 * Free on every OpenAI-compatible API, so it needs no spend gate. It exists
 * because model names are the provider's data, not ours - Groq retired a model
 * we had seeded and the first real call 404'd.
 */
export async function listProviderModels(
  provider: string,
): Promise<ModelDiscovery> {
  return discoverTextModels(provider);
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
