import { prisma } from "@/lib/prisma";
import {
  LOCAL_PROVIDERS,
  ProviderConfigError,
  resolveApiKey,
  resolveBaseUrl,
} from "./provider-credentials";

/**
 * Builds a video provider's runtime config from the database plus environment.
 *
 * Same split as text and image: the provider class stays a pure HTTP adapter,
 * the key comes from provider config or its env var, and the price comes from
 * ModelRegistry - never a constant in code.
 *
 * The price check here is stricter than elsewhere on purpose. A mispriced text
 * call wastes a fraction of a cent; a mispriced video call wastes dollars, and
 * a zero price would make every estimate and every budget check evaluate to
 * "free" right before the most expensive request the system can make.
 */

/** Video providers this build speaks to. */
export const VIDEO_PROVIDERS = new Set(["openai", "google", "runway"]);

/** One HTTP call's ceiling. Whole-job waiting is the caller's concern. */
export const DEFAULT_VIDEO_TIMEOUT_MS = 120_000;

export class VideoConfigError extends ProviderConfigError {
  constructor(message: string) {
    super(message);
    this.name = "VideoConfigError";
  }
}

/**
 * What every video adapter needs, whatever dialect it speaks.
 *
 * `size` is carried as a plain "WxH" string because that is the one thing all
 * three vendors express differently - OpenAI takes "720x1280", Runway takes
 * "720:1280", Google takes an aspect ratio plus a resolution tier - and each
 * adapter translates it on the way out.
 */
export interface VideoModelConfig {
  providerName: string;
  /** API model name, with our size suffix already stripped. */
  model: string;
  apiKey: string;
  baseUrl: string;
  /** Dollars per second, from ModelRegistry. Never a constant in code. */
  pricePerSecond: number;
  /** Output size as "WIDTHxHEIGHT". */
  size: string;
  timeoutMs: number;
}

/**
 * Registry model ids carry the output size as a suffix: `sora-2:720x1280`.
 *
 * Vendors price by resolution as well as by second, and price lives in the
 * registry rather than in code, so each resolution needs its own row. It also
 * lets the router treat them as separate options with real cost differences -
 * and it makes the size an operator-visible fact rather than a hidden default.
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

/** Parse "720x1280" into numbers, for resizing the keyframe to match. */
export function parseSize(size: string): { width: number; height: number } {
  const parts = size.split("x");
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new VideoConfigError(`Kích thước video không hợp lệ: "${size}".`);
  }
  return { width, height };
}

/** Nearest standard aspect ratio label, for vendors that want one. */
export function aspectRatioFor(size: string): "9:16" | "16:9" | "1:1" {
  const { width, height } = parseSize(size);
  if (width > height) return "16:9";
  if (width === height) return "1:1";
  return "9:16";
}

/** Resolution tier label, for vendors that want one instead of pixel sizes. */
export function resolutionTierFor(size: string): "720p" | "1080p" | "4k" {
  const { width, height } = parseSize(size);
  const shortSide = Math.min(width, height);
  if (shortSide >= 2000) return "4k";
  if (shortSide >= 1000) return "1080p";
  return "720p";
}

export async function buildVideoConfig(
  providerName: string,
  modelId: string,
  requireEnabled = true,
): Promise<VideoModelConfig> {
  if (!VIDEO_PROVIDERS.has(providerName)) {
    throw new VideoConfigError(
      `Nhà cung cấp video "${providerName}" chưa được tích hợp. ` +
        `Các lựa chọn hiện có: ${[...VIDEO_PROVIDERS].join(", ")}.`,
    );
  }

  const model = await prisma.modelRegistry.findUnique({
    where: { provider_modelId: { provider: providerName, modelId } },
  });

  if (!model) {
    throw new VideoConfigError(
      `Không tìm thấy model ${providerName}/${modelId} trong bảng Mô hình AI.`,
    );
  }
  if (model.type !== "video") {
    throw new VideoConfigError(
      `Model ${providerName}/${modelId} không phải model video (đang là "${model.type}").`,
    );
  }
  if (requireEnabled && !model.enabled) {
    throw new VideoConfigError(
      `Model ${providerName}/${modelId} đang bị tắt. Bật nó trong trang Mô hình AI.`,
    );
  }
  if (requireEnabled && model.price <= 0) {
    throw new VideoConfigError(
      `Model ${providerName}/${modelId} chưa có giá. Video là thứ đắt nhất hệ ` +
        `thống này gọi, nên phải nhập giá thật trước khi dùng — giá 0 sẽ khiến ` +
        `mọi ước tính và mọi hạn mức trở thành vô nghĩa.`,
    );
  }
  if (requireEnabled && model.priceUnit !== "per_second") {
    throw new VideoConfigError(
      `Model ${providerName}/${modelId} có đơn vị giá "${model.priceUnit}", ` +
        `nhưng ước tính video tính theo giây. Sửa lại trong trang Mô hình AI.`,
    );
  }

  const { apiModel, size } = splitModelSize(modelId);

  return {
    providerName,
    model: apiModel,
    // A key is needed to CALL a provider, not to quote one. Demanding it here
    // made the price comparison unable to show any provider the operator has
    // not signed up for yet - which is exactly the comparison they need before
    // deciding whether to sign up.
    apiKey: requireEnabled ? await resolveApiKey(providerName) : "",
    // Google's shared default points at its OpenAI-compatible shim, which has
    // no video endpoints. Veo lives on the plain Gemini path.
    baseUrl:
      providerName === "google"
        ? (await resolveBaseUrl(providerName)).replace(/\/openai\/?$/, "")
        : await resolveBaseUrl(providerName),
    pricePerSecond: model.price,
    size,
    timeoutMs: DEFAULT_VIDEO_TIMEOUT_MS,
  };
}

/** True when this provider bills nothing (local runtime). */
export function isFreeVideoProvider(providerName: string): boolean {
  return LOCAL_PROVIDERS.has(providerName);
}
