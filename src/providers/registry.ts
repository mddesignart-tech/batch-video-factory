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

/**
 * Implemented today. Text providers speak the OpenAI Chat Completions dialect,
 * which covers OpenAI and the many services that mirror it, plus local runtimes.
 * Image generation is OpenAI only. Video has three adapters - OpenAI (Sora),
 * Google (Veo) and Runway - each speaking its own dialect. Voice and upscale
 * remain mock-only.
 */
export const IMPLEMENTED_PROVIDERS = new Set<string>([
  "mock",
  "openai",
  "runway",
  "deepseek",
  "groq",
  "openrouter",
  "together",
  "google",
  "ollama",
  "lmstudio",
]);

/** Which slots a given provider can actually fill in THIS build. */
export const IMPLEMENTED_TYPES: Record<string, ModelType[]> = {
  mock: ["text", "image", "video", "voice", "upscale", "quality"],
  openai: ["text", "image", "video"],
  runway: ["video"],
  deepseek: ["text"],
  groq: ["text"],
  openrouter: ["text"],
  together: ["text"],
  google: ["text", "video"],
  ollama: ["text"],
  lmstudio: ["text"],
};

export function isTypeImplemented(name: string, type: ModelType): boolean {
  return (IMPLEMENTED_TYPES[name] ?? []).includes(type);
}

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
/**
 * Text is async because a real provider's config (key, base URL, price) lives
 * in the database. The mock path still short-circuits before any of that.
 *
 * `model` is required: the registry row is where the price comes from, and a
 * provider cannot be constructed without knowing which row applies.
 */
export async function getTextProvider(
  name: string,
  model: string,
): Promise<TextProvider> {
  if (isMockMode() || name === "mock") return mockText;

  const { OPENAI_COMPATIBLE_PROVIDERS, buildTextConfig } = await import(
    "./text-config"
  );
  if (!OPENAI_COMPATIBLE_PROVIDERS.has(name)) notImplemented(name, "text");

  const { OpenAICompatibleTextProvider } = await import(
    "./openai/openai-text-provider"
  );
  return new OpenAICompatibleTextProvider(await buildTextConfig(name, model));
}

/**
 * Image is async for the same reason text is: key, endpoint and price all come
 * from the database. `model` carries the quality tier as a suffix, which is how
 * one API model with three prices becomes three routable registry rows.
 */
export async function getImageProvider(
  name: string,
  model: string,
): Promise<ImageProvider> {
  if (isMockMode() || name === "mock") return mockImage;

  const { IMAGE_PROVIDERS, buildImageConfig } = await import("./image-config");
  if (!IMAGE_PROVIDERS.has(name)) notImplemented(name, "image");

  const { OpenAIImageProvider } = await import("./openai/openai-image-provider");
  return new OpenAIImageProvider(await buildImageConfig(name, model));
}

/**
 * Video is async for the same reasons as the others: key, endpoint and price
 * all come from the database. `model` carries the output size as a suffix,
 * which is how one API model priced by resolution becomes several routable
 * registry rows.
 */
export async function getVideoProvider(
  name: string,
  model: string,
): Promise<VideoProvider> {
  if (isMockMode() || name === "mock") return mockVideo;

  const { VIDEO_PROVIDERS, buildVideoConfig } = await import("./video-config");
  if (!VIDEO_PROVIDERS.has(name)) notImplemented(name, "video");

  const config = await buildVideoConfig(name, model);

  // Each vendor speaks a different dialect - multipart vs JSON data URI vs
  // long-running operation - so they get one adapter each rather than a single
  // class full of branches.
  if (name === "runway") {
    const { RunwayVideoProvider } = await import("./runway/runway-video-provider");
    return new RunwayVideoProvider(config);
  }
  if (name === "google") {
    const { GoogleVideoProvider } = await import("./google/google-video-provider");
    return new GoogleVideoProvider(config);
  }

  const { OpenAIVideoProvider } = await import("./openai/openai-video-provider");
  return new OpenAIVideoProvider(config);
}

/**
 * Voice, resolved the same way as the others: key, endpoint and price all come
 * from the database, never from a constant here.
 *
 * This is the single plug-in point. Adding ElevenLabs, Deepgram or Google TTS
 * later is one adapter plus one branch below - nothing in the services layer
 * names a vendor, which is the property that keeps that true.
 */
export async function getVoiceProvider(
  name: string,
  model: string,
): Promise<VoiceProvider> {
  if (isMockMode() || name === "mock") return mockVoice;

  const { VOICE_PROVIDERS, buildVoiceConfig } = await import("./voice-config");
  if (!VOICE_PROVIDERS.has(name)) notImplemented(name, "voice");

  const config = await buildVoiceConfig(name, model);

  if (name === "openai") {
    const { OpenAIVoiceProvider } = await import("./openai/openai-voice-provider");
    return new OpenAIVoiceProvider(config);
  }
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
