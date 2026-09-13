import type { VideoProvider } from "../src/providers/types";
import type { VideoModelConfig } from "../src/providers/video-config";

/**
 * Build a provider from an already-resolved config.
 *
 * The registry's `getVideoProvider` looks the config up itself and refuses a
 * disabled model, which is right for generation and wrong for a price
 * comparison - a model has to be quotable before anyone decides to enable it.
 * This takes the config the caller already built instead.
 */
export async function getVideoProviderForConfig(
  name: string,
  config: VideoModelConfig,
): Promise<VideoProvider> {
  if (name === "runway") {
    const { RunwayVideoProvider } = await import(
      "../src/providers/runway/runway-video-provider"
    );
    return new RunwayVideoProvider(config);
  }
  if (name === "google") {
    const { GoogleVideoProvider } = await import(
      "../src/providers/google/google-video-provider"
    );
    return new GoogleVideoProvider(config);
  }
  const { OpenAIVideoProvider } = await import(
    "../src/providers/openai/openai-video-provider"
  );
  return new OpenAIVideoProvider(config);
}
