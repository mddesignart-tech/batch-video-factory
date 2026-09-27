import { buildAssetReuseKey } from "@/domain/asset-reuse-key";
import { fileSha256OrNull } from "./asset-content";

/**
 * Reuse keys for the three paid asset kinds, built from what the request will
 * actually SEND (QĐ-112). Shared by generation (before a POST) and the
 * preflight (before approval), so both ask the same question with the same key.
 *
 * Dependencies are carried by CONTENT, which is what makes invalidation
 * automatic and narrow:
 *   image  <- prompt, size, seed, model, and the reference images' content
 *             (a new character master = new hashes = new image key)
 *   video  <- prompt, duration, size, fps, model, and the KEYFRAME's content
 *             (a new picture = new keyframe hash = new clip key; a new voice or
 *              subtitle changes nothing here)
 *   voice  <- spoken text, voice, model, speed/instructions/accent
 *             (a subtitle is not spoken, so it is not in the key)
 */

export interface Target {
  width: number;
  height: number;
  fps: number;
}

export function imageReuseKey(opts: {
  provider: string;
  model: string;
  prompt: string;
  negativePrompt: string;
  target: Target;
  seed: number | null | undefined;
  referenceImages: string[];
  /** The characters in the shot, with the version of their sheet (identity-sensitive). */
  characters: { name: string; version: number }[];
}): string {
  return buildAssetReuseKey({
    kind: "image",
    provider: opts.provider,
    model: opts.model,
    prompt: opts.prompt,
    negativePrompt: opts.negativePrompt,
    width: opts.target.width,
    height: opts.target.height,
    seed: opts.seed ?? null,
    // A reference that is not on disk cannot be sent; its absence is part of
    // the request, so it is part of the key.
    referenceHashes: opts.referenceImages.map((p) => fileSha256OrNull(p) ?? "missing"),
    characterVersions: opts.characters.map((c) => `${c.name}@${c.version}`).sort(),
  });
}

export function videoReuseKey(opts: {
  provider: string;
  model: string;
  prompt: string;
  durationSeconds: number;
  target: Target;
  /** Absolute keyframe path, or a known content hash when predicting. */
  keyframe: { path: string } | { hash: string | null };
}): string {
  const keyframeHash = "path" in opts.keyframe ? fileSha256OrNull(opts.keyframe.path) : opts.keyframe.hash;
  return buildAssetReuseKey({
    kind: "video",
    provider: opts.provider,
    model: opts.model,
    prompt: opts.prompt,
    negativePrompt: "",
    durationSeconds: opts.durationSeconds,
    width: opts.target.width,
    height: opts.target.height,
    fps: opts.target.fps,
    keyframeHash,
  });
}

export function voiceReuseKey(opts: {
  provider: string;
  model: string;
  text: string;
  voiceId: string;
  instructions?: string | null;
  speed?: number | null;
  accent?: string | null;
  /**
   * The scene length the adapter is handed. Only the MOCK voice adapter shapes
   * its output by it; the real ones (OpenAI TTS) ignore it - so for them it is
   * not part of the key, and changing a scene's length does not re-buy speech.
   */
  targetDuration?: number | null;
}): string {
  const durationSensitive = opts.provider === "mock";
  return buildAssetReuseKey({
    kind: "audio",
    provider: opts.provider,
    model: opts.model,
    text: opts.text,
    voiceId: opts.voiceId,
    instructions: opts.instructions ?? "",
    speed: opts.speed ?? 1,
    accent: opts.accent ?? "",
    targetDuration: durationSensitive ? (opts.targetDuration ?? null) : undefined,
  });
}
