import type { VideoProvider } from "./types";
import type { VideoModelConfig } from "./video-config";

/**
 * VIDEO PROVIDER ADAPTERS - the single place a video vendor is plugged in.
 *
 * The pipeline sends one generic VideoRequest (prompt, keyframe, duration,
 * size, fps); each adapter converts it, submits, polls, downloads, normalises
 * errors and reports cost. No vendor-specific code lives in the scene workflow.
 *
 * Adding a provider = one adapter class + one line here + its ModelRegistry
 * rows (price, capability profile). Storyboard, voice, subtitles, the smooth
 * pass and the final render are not touched. Loaded lazily so a vendor's
 * client is never imported unless it is used.
 */
export const VIDEO_ADAPTERS: Record<string, (config: VideoModelConfig) => Promise<VideoProvider>> = {
  openai: async (config) => new (await import("./openai/openai-video-provider")).OpenAIVideoProvider(config),
  google: async (config) => new (await import("./google/google-video-provider")).GoogleVideoProvider(config),
  runway: async (config) => new (await import("./runway/runway-video-provider")).RunwayVideoProvider(config),
};

export function hasVideoAdapter(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(VIDEO_ADAPTERS, name);
}
