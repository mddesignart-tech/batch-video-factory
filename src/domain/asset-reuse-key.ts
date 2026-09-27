import { createHash } from "node:crypto";

/**
 * THE identity of a generated asset (V1.2 Phase 4, QĐ-112).
 *
 * One function builds every reuse key - no module hashes its own. A key covers
 * every input that changes the OUTPUT, and nothing that does not: the project,
 * the scene, the batch and the time are deliberately absent, so the same request
 * made from another scene or another project is recognised as the same asset.
 *
 *   reuse:v1:<kind>:<sha256 of the canonical inputs>
 *
 * The version is part of the key. Changing what goes into a key (a new field, a
 * different normaliser) means bumping REUSE_KEY_VERSION, and then no old asset
 * can match a new key by accident - it is a different key space.
 *
 * Normalisation is deliberately MILD: line endings and runs of whitespace only.
 * Punctuation, case and wording are kept - "Hello!" and "Hello?" are read with a
 * different intonation by a TTS model, and a prompt's capitals can change an
 * image. Treating those as equal would reuse an asset that is not the same.
 */

export const REUSE_KEY_VERSION = "v1";

export type ReuseKind = "image" | "video" | "audio" | "local_motion";

/** Line endings to \n, trim, collapse runs of spaces/tabs; newlines kept as one. */
export function normalizeText(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, all) => l.length > 0 || (i > 0 && all[i - 1]!.length > 0))
    .join("\n")
    .trim();
}

export interface ImageKeyInput {
  kind: "image";
  provider: string;
  model: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  seed?: number | null;
  /** Content hashes of the reference images SENT, in the order sent (order matters to the model). */
  referenceHashes: string[];
  /** "Name@version" of every character drawn: a new character master invalidates the picture. */
  characterVersions?: string[];
}

export interface VideoKeyInput {
  kind: "video";
  provider: string;
  model: string;
  prompt: string;
  negativePrompt?: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  /** Content hash of the keyframe sent, or null for text-to-video. */
  keyframeHash: string | null;
}

export interface VoiceKeyInput {
  kind: "audio";
  provider: string;
  model: string;
  /** Exactly what is spoken (not the subtitle). */
  text: string;
  voiceId: string;
  instructions?: string;
  speed?: number;
  accent?: string;
  /** Only for adapters whose output depends on it (see voiceReuseKey). */
  targetDuration?: number | null;
}

export interface LocalMotionKeyInput {
  kind: "local_motion";
  /** The FFmpeg arguments with every input path replaced by that file's content hash. */
  args: string[];
}

export type AssetKeyInput = ImageKeyInput | VideoKeyInput | VoiceKeyInput | LocalMotionKeyInput;

/** Stable JSON: object keys sorted, undefined dropped - so field order never changes a key. */
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

function fields(input: AssetKeyInput): Record<string, unknown> {
  switch (input.kind) {
    case "image":
      return {
        provider: input.provider,
        model: input.model,
        prompt: normalizeText(input.prompt),
        negativePrompt: normalizeText(input.negativePrompt),
        width: input.width,
        height: input.height,
        seed: input.seed ?? null,
        references: input.referenceHashes,
        characters: input.characterVersions ?? [],
      };
    case "video":
      return {
        provider: input.provider,
        model: input.model,
        prompt: normalizeText(input.prompt),
        negativePrompt: normalizeText(input.negativePrompt),
        durationSeconds: input.durationSeconds,
        width: input.width,
        height: input.height,
        fps: input.fps,
        keyframe: input.keyframeHash,
      };
    case "audio":
      return {
        provider: input.provider,
        model: input.model,
        text: normalizeText(input.text),
        voiceId: input.voiceId,
        instructions: normalizeText(input.instructions),
        speed: input.speed ?? 1,
        accent: input.accent ?? "",
        targetDuration: input.targetDuration ?? undefined,
      };
    case "local_motion":
      return { args: input.args };
  }
}

export function buildAssetReuseKey(input: AssetKeyInput): string {
  const hash = createHash("sha256").update(canonical(fields(input))).digest("hex");
  return `reuse:${REUSE_KEY_VERSION}:${input.kind}:${hash}`;
}

/** The kind a key was built for, or null for a malformed / foreign key. */
export function reuseKeyKind(key: string | null | undefined): ReuseKind | null {
  const m = /^reuse:v\d+:(image|video|audio|local_motion):[0-9a-f]{64}$/.exec(key ?? "");
  return m ? (m[1] as ReuseKind) : null;
}
