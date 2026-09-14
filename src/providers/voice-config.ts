import { prisma } from "@/lib/prisma";
import {
  LOCAL_PROVIDERS,
  ProviderConfigError,
  resolveApiKey,
  resolveBaseUrl,
} from "./provider-credentials";

/**
 * Builds a voice provider's runtime config from the database plus environment.
 *
 * Same split as text, image and video: the provider class stays a pure HTTP
 * adapter, the key comes from provider config or its env var, and the price
 * comes from ModelRegistry - never a constant in code.
 *
 * Adding ElevenLabs, Deepgram or Google TTS later means writing one adapter and
 * adding a name to VOICE_PROVIDERS. Nothing in the services layer names a
 * vendor, which is the property that makes that true.
 */

/** Voice providers this build speaks to. */
export const VOICE_PROVIDERS = new Set(["openai"]);

/** Speech is short; a long timeout here just delays a clear failure. */
export const DEFAULT_VOICE_TIMEOUT_MS = 120_000;

/**
 * Speed bounds. Outside these the vendor rejects the request, so clamping here
 * turns a 400 into a slightly-wrong pace, which is the better failure.
 */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

export class VoiceConfigError extends ProviderConfigError {
  constructor(message: string) {
    super(message);
    this.name = "VoiceConfigError";
  }
}

export interface VoiceModelConfig {
  providerName: string;
  /** API model name. */
  model: string;
  apiKey: string;
  baseUrl: string;
  /** Dollars per 1000 characters, from ModelRegistry. */
  pricePer1kChars: number;
  /** Whether this model takes a free-text delivery direction. */
  supportsInstructions: boolean;
  /** Container the adapter will ask for. */
  format: AudioFormat;
  timeoutMs: number;
}

/**
 * Output container.
 *
 * WAV is the default on purpose: it needs no decode step before ffmpeg, and the
 * pipeline measures every clip's real duration rather than trusting the
 * provider, which is far cheaper on an uncompressed stream.
 */
export type AudioFormat = "wav" | "mp3" | "opus" | "aac" | "flac";

export const FORMAT_EXTENSION: Record<AudioFormat, string> = {
  wav: ".wav",
  mp3: ".mp3",
  opus: ".opus",
  aac: ".aac",
  flac: ".flac",
};

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

export async function buildVoiceConfig(
  providerName: string,
  modelId: string,
  requireEnabled = true,
): Promise<VoiceModelConfig> {
  if (!VOICE_PROVIDERS.has(providerName)) {
    throw new VoiceConfigError(
      `Nhà cung cấp giọng nói "${providerName}" chưa được tích hợp. ` +
        `Các lựa chọn hiện có: ${[...VOICE_PROVIDERS].join(", ")}.`,
    );
  }

  const model = await prisma.modelRegistry.findUnique({
    where: { provider_modelId: { provider: providerName, modelId } },
  });

  if (!model) {
    throw new VoiceConfigError(
      `Không tìm thấy model ${providerName}/${modelId} trong bảng Mô hình AI.`,
    );
  }
  if (model.type !== "voice") {
    throw new VoiceConfigError(
      `Model ${providerName}/${modelId} không phải model giọng nói (đang là "${model.type}").`,
    );
  }
  if (requireEnabled && !model.enabled) {
    throw new VoiceConfigError(
      `Model ${providerName}/${modelId} đang bị tắt. Bật nó trong trang Mô hình AI.`,
    );
  }
  if (requireEnabled && model.price <= 0 && !LOCAL_PROVIDERS.has(providerName)) {
    // A zero price makes every estimate read "free" and lets the spend cap be
    // blown through without a warning.
    throw new VoiceConfigError(
      `Model ${providerName}/${modelId} chưa có giá. Nhập giá mỗi 1000 ký tự ` +
        `trong trang Mô hình AI trước khi dùng, nếu không hạn mức chi tiêu sẽ vô nghĩa.`,
    );
  }

  return {
    providerName,
    model: modelId,
    apiKey: await resolveApiKey(providerName),
    baseUrl: await resolveBaseUrl(providerName),
    pricePer1kChars: model.price,
    supportsInstructions: model.supportsVoiceInstructions,
    format: "wav",
    timeoutMs: DEFAULT_VOICE_TIMEOUT_MS,
  };
}

/** True when this provider bills nothing (local runtime). */
export function isFreeVoiceProvider(providerName: string): boolean {
  return LOCAL_PROVIDERS.has(providerName);
}
