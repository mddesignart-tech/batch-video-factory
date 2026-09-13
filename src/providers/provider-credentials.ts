import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";

/**
 * Where a provider's key and endpoint come from.
 *
 * Shared by every provider type so "how do we authenticate to OpenAI" has one
 * answer rather than one per media type. Two rules hold everywhere:
 *   - a key entered in the admin UI wins over the environment variable
 *   - a resolved key is returned to the provider layer and nowhere else
 */

/** Default endpoints per known provider. Overridable in the provider config. */
export const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  together: "https://api.together.xyz/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  // Video-only vendors. Runway serves its API from a separate `dev` host, and
  // Google's video work goes through the same Gemini endpoint as its text.
  runway: "https://api.dev.runwayml.com/v1",
  kling: "https://api.klingai.com/v1",
  // Local runtimes: no key, no cost, ideal for testing an integration.
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
};

/** Providers that run locally and therefore need no API key and cost nothing. */
export const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio"]);

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export async function resolveApiKey(providerName: string): Promise<string> {
  if (LOCAL_PROVIDERS.has(providerName)) return "";

  const config = await prisma.providerConfig.findUnique({
    where: { name: providerName },
  });

  if (config?.apiKeyEnc) {
    try {
      return decryptSecret(config.apiKeyEnc);
    } catch {
      throw new ProviderConfigError(
        `Không giải mã được API key đã lưu của ${providerName}. ` +
          `Có thể SECRET_ENCRYPTION_KEY đã thay đổi. Hãy nhập lại key.`,
      );
    }
  }

  const envVar = config?.apiKeyEnvVar || `${providerName.toUpperCase()}_API_KEY`;
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();

  throw new ProviderConfigError(
    `Chưa có API key cho ${providerName}. Thêm ${envVar} vào tệp .env ` +
      `hoặc nhập key trong trang "Nhà cung cấp AI".`,
  );
}

/** True when a key exists, without ever returning the key itself. */
export async function hasApiKey(providerName: string): Promise<boolean> {
  try {
    const key = await resolveApiKey(providerName);
    return LOCAL_PROVIDERS.has(providerName) || key.length > 0;
  } catch {
    return false;
  }
}

export async function resolveBaseUrl(providerName: string): Promise<string> {
  const config = await prisma.providerConfig.findUnique({
    where: { name: providerName },
  });
  const baseUrl =
    (config?.baseUrl && config.baseUrl.trim().length > 0
      ? config.baseUrl.trim()
      : DEFAULT_BASE_URLS[providerName]) ?? "";
  if (baseUrl.length === 0) {
    throw new ProviderConfigError(
      `Chưa có baseUrl cho ${providerName}. Nhập trong trang Nhà cung cấp AI.`,
    );
  }
  return baseUrl;
}
