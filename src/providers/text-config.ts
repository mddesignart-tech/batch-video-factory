import { prisma } from "@/lib/prisma";
import type { OpenAICompatibleConfig } from "./openai/openai-client";
import {
  DEFAULT_BASE_URLS,
  LOCAL_PROVIDERS,
  resolveApiKey,
} from "./provider-credentials";

/**
 * Builds a text provider's runtime config from the database plus environment.
 *
 * Kept out of the provider class so the class stays a pure HTTP adapter, and so
 * that "where does the key come from" and "where does the price come from" have
 * exactly one answer each:
 *   - key   : provider config (encrypted at rest) else the provider's env var
 *   - price : ModelRegistry, never a constant in code
 */

/** Text providers this build speaks to. All use the Chat Completions dialect. */
export const OPENAI_COMPATIBLE_PROVIDERS = new Set([
  "openai",
  "deepseek",
  "groq",
  "openrouter",
  "together",
  "google",
  "ollama",
  "lmstudio",
]);

/**
 * Output ceiling per call.
 *
 * Measured, not guessed: a 6-scene script with full image and video prompts for
 * every scene came back truncated at 2500 tokens on the first real run. 6000
 * leaves comfortable headroom. It also caps the pre-flight estimate, so raising
 * it makes estimates more conservative - the safe direction.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 6000;
export const DEFAULT_TIMEOUT_MS = 90_000;

export class TextConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextConfigError";
  }
}

export async function buildTextConfig(
  providerName: string,
  modelId: string,
  /**
   * Whether the model must be switched on.
   *
   * True for anything that generates. False for listing models, which needs
   * only the base URL and key - refusing there would make it impossible to
   * discover a model before enabling it, which is backwards.
   */
  requireEnabled = true,
): Promise<OpenAICompatibleConfig> {
  if (!OPENAI_COMPATIBLE_PROVIDERS.has(providerName)) {
    throw new TextConfigError(
      `Nhà cung cấp text "${providerName}" chưa được tích hợp. ` +
        `Các lựa chọn hiện có: ${[...OPENAI_COMPATIBLE_PROVIDERS].join(", ")}.`,
    );
  }

  const [config, model] = await Promise.all([
    prisma.providerConfig.findUnique({ where: { name: providerName } }),
    prisma.modelRegistry.findUnique({
      where: { provider_modelId: { provider: providerName, modelId } },
    }),
  ]);

  if (!model) {
    throw new TextConfigError(
      `Không tìm thấy model ${providerName}/${modelId} trong bảng Mô hình AI.`,
    );
  }
  if (requireEnabled && !model.enabled) {
    throw new TextConfigError(
      `Model ${providerName}/${modelId} đang bị tắt. Bật nó trong trang Mô hình AI.`,
    );
  }

  const baseUrl =
    (config?.baseUrl && config.baseUrl.trim().length > 0
      ? config.baseUrl.trim()
      : DEFAULT_BASE_URLS[providerName]) ?? "";

  if (baseUrl.length === 0) {
    throw new TextConfigError(
      `Chưa có baseUrl cho ${providerName}. Nhập trong trang Nhà cung cấp AI.`,
    );
  }

  return {
    providerName,
    model: modelId,
    apiKey: await resolveApiKey(providerName),
    baseUrl,
    requiresKey: !LOCAL_PROVIDERS.has(providerName),
    // Prices come from the registry, which the operator maintains. Never a
    // hard-coded vendor rate.
    pricePer1kInput: model.price,
    pricePer1kOutput: model.priceOutput,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

/** True when this provider bills nothing (local runtime). */
export function isFreeProvider(providerName: string): boolean {
  return LOCAL_PROVIDERS.has(providerName);
}

export { LOCAL_PROVIDERS };
