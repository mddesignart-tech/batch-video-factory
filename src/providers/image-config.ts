import { prisma } from "@/lib/prisma";
import {
  LOCAL_PROVIDERS,
  ProviderConfigError,
  resolveApiKey,
  resolveBaseUrl,
} from "./provider-credentials";
import {
  IMAGE_QUALITY_TIERS,
  type ImageQualityTier,
  type OpenAIImageConfig,
} from "./openai/openai-image-client";

/**
 * Builds an image provider's runtime config from the database plus environment.
 *
 * Same split as the text side: the provider class stays a pure HTTP adapter,
 * and the two questions that decide whether money is spent safely have exactly
 * one answer each - the key comes from provider config or its env var, and the
 * price comes from ModelRegistry, never from a constant in code.
 */

/** Image providers this build speaks to. */
export const IMAGE_PROVIDERS = new Set(["openai"]);

export const DEFAULT_IMAGE_TIMEOUT_MS = 180_000;

export class ImageConfigError extends ProviderConfigError {
  constructor(message: string) {
    super(message);
    this.name = "ImageConfigError";
  }
}

/**
 * Registry model ids carry the quality tier as a suffix: `gpt-image-1:medium`.
 *
 * The API charges a different price for each tier of the same model, and price
 * lives in ModelRegistry rather than in code. One row per tier is therefore the
 * only shape that lets the operator edit those prices - and it has a useful
 * side effect: the router sees three options with genuinely different cost and
 * quality ratings and can choose between them like any other models.
 */
export function splitModelTier(modelId: string): {
  apiModel: string;
  quality: ImageQualityTier;
} {
  const at = modelId.lastIndexOf(":");
  if (at > 0) {
    const suffix = modelId.slice(at + 1);
    if ((IMAGE_QUALITY_TIERS as readonly string[]).includes(suffix)) {
      return {
        apiModel: modelId.slice(0, at),
        quality: suffix as ImageQualityTier,
      };
    }
  }
  // No suffix: the model has a single price, so "medium" is a label, not a
  // billing decision.
  return { apiModel: modelId, quality: "medium" };
}

export async function buildImageConfig(
  providerName: string,
  modelId: string,
  requireEnabled = true,
): Promise<OpenAIImageConfig> {
  if (!IMAGE_PROVIDERS.has(providerName)) {
    throw new ImageConfigError(
      `Nhà cung cấp ảnh "${providerName}" chưa được tích hợp. ` +
        `Các lựa chọn hiện có: ${[...IMAGE_PROVIDERS].join(", ")}.`,
    );
  }

  const model = await prisma.modelRegistry.findUnique({
    where: { provider_modelId: { provider: providerName, modelId } },
  });

  if (!model) {
    throw new ImageConfigError(
      `Không tìm thấy model ${providerName}/${modelId} trong bảng Mô hình AI.`,
    );
  }
  if (model.type !== "image") {
    throw new ImageConfigError(
      `Model ${providerName}/${modelId} không phải model ảnh (đang là "${model.type}").`,
    );
  }
  if (requireEnabled && !model.enabled) {
    throw new ImageConfigError(
      `Model ${providerName}/${modelId} đang bị tắt. Bật nó trong trang Mô hình AI.`,
    );
  }
  if (requireEnabled && model.price <= 0) {
    // A zero price would make every estimate read "free" and let the spend cap
    // be blown through without a single warning.
    throw new ImageConfigError(
      `Model ${providerName}/${modelId} chưa có giá. Nhập giá mỗi ảnh trong ` +
        `trang Mô hình AI trước khi dùng, nếu không hạn mức chi tiêu sẽ vô nghĩa.`,
    );
  }

  const { apiModel, quality } = splitModelTier(modelId);

  return {
    providerName,
    model: apiModel,
    quality,
    apiKey: await resolveApiKey(providerName),
    baseUrl: await resolveBaseUrl(providerName),
    pricePerImage: model.price,
    pricePerMillionOutputTokens: model.priceOutput,
    supportsInputFidelity: model.supportsInputFidelity,
    timeoutMs: DEFAULT_IMAGE_TIMEOUT_MS,
  };
}

/** True when this provider bills nothing (local runtime). */
export function isFreeImageProvider(providerName: string): boolean {
  return LOCAL_PROVIDERS.has(providerName);
}
