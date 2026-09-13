import { isMockMode } from "@/lib/env";
import type { ModelType } from "@/domain/enums";
import {
  MockImageProvider,
  MockQualityProvider,
  MockUpscaleProvider,
  MockVideoProvider,
  MockVoiceProvider,
} from "./mock/mock-visual-providers";
import { MockTextProvider } from "./mock/mock-text-provider";
import type {
  ImageProvider,
  QualityProvider,
  TextProvider,
  UpscaleProvider,
  VideoProvider,
  VoiceProvider,
} from "./types";
import { ProviderError } from "./types";

/**
 * The only place that maps a provider *name* to an implementation.
 *
 * Milestone 1 ships exactly one working implementation - the mock family. Real
 * vendors are registered here one at a time in Milestone 2. Until then asking
 * for one raises a clear, actionable error rather than silently falling back to
 * mock output and pretending a provider works when it has never been tested.
 */

const mockText = new MockTextProvider();
const mockImage = new MockImageProvider();
const mockVideo = new MockVideoProvider();
const mockVoice = new MockVoiceProvider();
const mockUpscale = new MockUpscaleProvider();
const mockQuality = new MockQualityProvider();

/** Provider names the app knows about, and which slots they can fill. */
export const KNOWN_PROVIDERS: Record<string, ModelType[]> = {
  mock: ["text", "image", "video", "voice", "upscale", "quality"],
  openai: ["text", "image", "voice"],
  google: ["text", "image", "video"],
  runway: ["video"],
  kling: ["video"],
  elevenlabs: ["voice"],
};

/** Implemented and tested today. Everything else is Milestone 2 work. */
export const IMPLEMENTED_PROVIDERS = new Set<string>(["mock"]);

function notImplemented(name: string, type: ModelType): never {
  throw new ProviderError(
    `Nhà cung cấp "${name}" (${type}) chưa được tích hợp trong phiên bản này. ` +
      `Bật AI_MOCK_MODE=true hoặc chọn nhà cung cấp khác.`,
    name,
    false,
    "provider_not_implemented",
  );
}

/**
 * Mock mode is a hard gate, not a preference: while it is on, every slot returns
 * a mock implementation no matter what the router or the scene override asked
 * for. That is what makes "cannot accidentally spend money" a property of the
 * system rather than a habit.
 */
export function getTextProvider(name: string): TextProvider {
  if (isMockMode() || name === "mock") return mockText;
  return notImplemented(name, "text");
}

export function getImageProvider(name: string): ImageProvider {
  if (isMockMode() || name === "mock") return mockImage;
  return notImplemented(name, "image");
}

export function getVideoProvider(name: string): VideoProvider {
  if (isMockMode() || name === "mock") return mockVideo;
  return notImplemented(name, "video");
}

export function getVoiceProvider(name: string): VoiceProvider {
  if (isMockMode() || name === "mock") return mockVoice;
  return notImplemented(name, "voice");
}

export function getUpscaleProvider(name: string): UpscaleProvider {
  if (isMockMode() || name === "mock") return mockUpscale;
  return notImplemented(name, "upscale");
}

export function getQualityProvider(name: string): QualityProvider {
  if (isMockMode() || name === "mock") return mockQuality;
  return notImplemented(name, "quality");
}

export function isProviderImplemented(name: string): boolean {
  return IMPLEMENTED_PROVIDERS.has(name);
}
