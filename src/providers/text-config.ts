import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import type { OpenAICompatibleConfig } from "./openai/openai-client";

/**
 * Builds a text provider's runtime config from the database plus environment.
 *
 * Kept out of the provider class so the class stays a pure HTTP adapter, and so
 * that "where does the key come from" and "where does the price come from" have
 * exactly one answer each:
 *   - key   : provider config (encrypted at rest) else the provider's env var
 *   - price : ModelRegistry, never a constant in code
 */

/** Default endpoints per known provider. Overridable in the provider config. */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  together: "https://api.together.xyz/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  // Local runtimes: no key, no cost, ideal for testing this integration.
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
};

/** Providers that run locally and therefore need no API key and cost nothing. */
export const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio"]);

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

/**
 * Resolve the API key.
 *
 * A key saved through the admin UI wins over the environment variable, because
 * it is the more deliberate act. Neither path ever returns the key to a caller
 * outside the provider layer.
 */
async function resolveApiKey(providerName: string): Promise<string> {
  if (LOCAL_PROVIDERS.has(providerName)) return "";

  const config = await prisma.providerConfig.findUnique({
    where: { name: providerName },
  });

  if (config?.apiKeyEnc) {
    try {
      return decryptSecret(config.apiKeyEnc);
    } catch {
      throw new TextConfigError(
        `Không giải mã được API key đã lưu của ${providerName}. ` +
          `Có thể SECRET_ENCRYPTION_KEY đã thay đổi. Hãy nhập lại key.`,
      );
    }
  }

  const envVar = config?.apiKeyEnvVar || `${providerName.toUpperCase()}_API_KEY`;
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();

  throw new TextConfigError(
    `Chưa có API key cho ${providerName}. Thêm ${envVar} vào tệp .env ` +
      `hoặc nhập key trong trang "Nhà cung cấp AI".`,
  );
}

export async function buildTextConfig(
  providerName: string,
  modelId: string,
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
  if (!model.enabled) {
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
