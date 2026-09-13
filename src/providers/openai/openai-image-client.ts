import fs from "node:fs";
import path from "node:path";
import { ProviderError } from "@/providers/types";
import { logger } from "@/lib/logger";
import { classifyHttpError } from "./openai-client";

/**
 * HTTP client for the OpenAI Images API.
 *
 * Two endpoints, chosen by whether we have reference images:
 *   - /images/generations : text only. Used for a character's first master.
 *   - /images/edits       : text plus reference images. Used for every scene,
 *                           because it is the only way to tell the model what
 *                           the character already looks like.
 *
 * The second is what makes character consistency possible at all. Passing the
 * approved master back in with `input_fidelity: high` asks the API to preserve
 * the face and clothing rather than reinvent them from the description.
 */

export const IMAGE_QUALITY_TIERS = ["low", "medium", "high"] as const;
export type ImageQualityTier = (typeof IMAGE_QUALITY_TIERS)[number];

export interface OpenAIImageConfig {
  providerName: string;
  /** The API model name, with our quality suffix already stripped. */
  model: string;
  /** low | medium | high - OpenAI's own quality tiers. */
  quality: ImageQualityTier;
  apiKey: string;
  baseUrl: string;
  /** Dollars per image, from ModelRegistry. Never a constant in code. */
  pricePerImage: number;
  /**
   * Dollars per 1M output tokens, from ModelRegistry.
   *
   * The Images API bills by token, not by image, so this is what turns a
   * reply into an exact cost. `pricePerImage` stays the pre-flight estimate -
   * it has to, because the cap must be checked before the tokens are known.
   */
  pricePerMillionOutputTokens: number;
  /**
   * Whether this model accepts the `input_fidelity` hint.
   *
   * gpt-image-1 does; gpt-image-2 rejects it with a 400. Sending it blindly
   * fails every reference-guided scene, which is exactly the request we most
   * need to succeed.
   */
  supportsInputFidelity: boolean;
  timeoutMs: number;
}

export interface ImageCallRequest {
  prompt: string;
  /** Folded into the prompt: the Images API has no negative-prompt field. */
  negativePrompt: string;
  width: number;
  height: number;
  /** Absolute paths of reference images. Non-empty switches to /images/edits. */
  referenceImages: string[];
  purpose: string;
}

export interface ImageCallResult {
  /** Decoded PNG bytes. Written to disk by the caller, never by the vendor. */
  data: Buffer;
  durationMs: number;
  model: string;
  size: string;
  quality: ImageQualityTier;
  /** Tokens reported by the API, when it reports them. Informational only. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Whether the reference-guided endpoint was used. */
  usedReferences: boolean;
}

/** Retries are deliberately tighter than for text: each attempt costs cents. */
export const MAX_IMAGE_ATTEMPTS = 2;
const BACKOFF_MS = 2000;

/** Largest reference file we will upload, per the API's own limit. */
const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;
/** How many references to send. More costs more input tokens for little gain. */
export const MAX_REFERENCES_SENT = 3;

/**
 * The sizes gpt-image-1 accepts.
 *
 * The API rejects anything else outright, so an arbitrary 1080x1920 request has
 * to be mapped onto the nearest supported shape and cropped later by FFmpeg.
 */
const SUPPORTED_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;

/** Nearest supported size for a requested aspect ratio. */
export function nearestSize(width: number, height: number): string {
  const portrait = "1024x1536";
  if (width <= 0 || height <= 0) return portrait;
  const wanted = width / height;
  let best: string = portrait;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const size of SUPPORTED_SIZES) {
    const parts = size.split("x");
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!w || !h) continue;
    const gap = Math.abs(w / h - wanted);
    if (gap < bestGap) {
      bestGap = gap;
      best = size;
    }
  }
  return best;
}

/**
 * Fold the negative prompt into the positive one.
 *
 * gpt-image-1 has no negative prompt parameter. Dropping the field silently
 * would lose every "no watermark, no extra fingers" guard the character sheets
 * carry, so it becomes a trailing instruction instead.
 */
export function mergeNegative(prompt: string, negative: string): string {
  const n = negative.trim();
  if (n.length === 0) return prompt;
  return `${prompt}\n\nAvoid: ${n}.`;
}

interface ImageApiResponse {
  data?: { b64_json?: string; revised_prompt?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

export async function createImage(
  config: OpenAIImageConfig,
  request: ImageCallRequest,
): Promise<ImageCallResult> {
  const size = nearestSize(request.width, request.height);
  const prompt = mergeNegative(request.prompt, request.negativePrompt);
  const references = usableReferences(request.referenceImages);
  const useEdits = references.length > 0;
  const url = `${config.baseUrl.replace(/\/+$/, "")}/images/${
    useEdits ? "edits" : "generations"
  }`;

  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_IMAGE_ATTEMPTS; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const headers: Record<string, string> = {};
      // The key goes in a header and nowhere else - never a query string,
      // never a log line, never a stored request body.
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

      const init: RequestInit = useEdits
        ? {
            method: "POST",
            headers,
            body: buildEditForm(config, prompt, size, references),
            signal: controller.signal,
          }
        : {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: config.model,
              prompt,
              n: 1,
              size,
              quality: config.quality,
              output_format: "png",
            }),
            signal: controller.signal,
          };

      const response = await fetch(url, init);
      const durationMs = Date.now() - started;

      if (!response.ok) {
        const classified = classifyHttpError(response.status);
        const detail = await safeErrorBody(response);

        await logger.error({
          event: "provider.image_http_error",
          provider: config.providerName,
          model: config.model,
          durationMs,
          status: String(response.status),
          message: `${classified.message} ${detail}`.trim(),
        });

        const error = new ProviderError(
          `${classified.message}${detail ? ` (${detail})` : ""}`,
          config.providerName,
          classified.retryable,
          classified.code,
        );
        if (!classified.retryable) throw error;

        lastError = error;
        if (attempt < MAX_IMAGE_ATTEMPTS - 1) {
          const retryAfter = Number(response.headers.get("retry-after"));
          await sleep(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 30_000)
              : BACKOFF_MS,
          );
          continue;
        }
        throw error;
      }

      const json = (await response.json()) as ImageApiResponse;
      const b64 = json.data?.[0]?.b64_json;

      if (!b64) {
        // An OK response with no image still bills. Non-retryable: sending the
        // identical request again would produce the identical empty reply and
        // charge a second time.
        throw new ProviderError(
          "Nhà cung cấp trả về phản hồi không chứa ảnh.",
          config.providerName,
          false,
          "empty_image",
        );
      }

      const data = Buffer.from(b64, "base64");

      await logger.info({
        event: "provider.image_completed",
        provider: config.providerName,
        model: config.model,
        durationMs,
        message: `${request.purpose}: ${size} ${config.quality}, ${references.length} ảnh tham chiếu, ${Math.round(data.byteLength / 1024)} KB`,
      });

      return {
        data,
        durationMs,
        model: config.model,
        size,
        quality: config.quality,
        inputTokens: json.usage?.input_tokens ?? null,
        outputTokens: json.usage?.output_tokens ?? null,
        usedReferences: useEdits,
      };
    } catch (err) {
      lastError = err;
      if (err instanceof ProviderError && !err.retryable) throw err;

      if (err instanceof Error && err.name === "AbortError") {
        await logger.warn({
          event: "provider.image_timeout",
          provider: config.providerName,
          model: config.model,
          message: `Quá ${config.timeoutMs}ms không có phản hồi.`,
        });
      }
      if (attempt < MAX_IMAGE_ATTEMPTS - 1) {
        await sleep(BACKOFF_MS);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ProviderError(
        "Không tạo được ảnh sau nhiều lần thử.",
        config.providerName,
        true,
        "exhausted",
      );
}

function buildEditForm(
  config: OpenAIImageConfig,
  prompt: string,
  size: string,
  references: string[],
): FormData {
  const form = new FormData();
  form.append("model", config.model);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", size);
  form.append("quality", config.quality);
  // The whole point of passing references: ask the API to hold the face and
  // clothing steady instead of regenerating them from the text description.
  // Models that do not accept the hint still honour the reference images
  // themselves, so its absence weakens consistency rather than removing it.
  if (config.supportsInputFidelity) {
    form.append("input_fidelity", "high");
  }

  for (const absolute of references) {
    const bytes = fs.readFileSync(absolute);
    const name = path.basename(absolute);
    form.append(
      "image[]",
      new Blob([new Uint8Array(bytes)], { type: mimeFor(name) }),
      name,
    );
  }
  return form;
}

/** Drop references that are missing, empty, or too large to upload. */
function usableReferences(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (out.length >= MAX_REFERENCES_SENT) break;
    try {
      const stat = fs.statSync(p);
      if (stat.isFile() && stat.size > 0 && stat.size <= MAX_REFERENCE_BYTES) {
        out.push(p);
      }
    } catch {
      // A reference that vanished is not worth failing the whole generation
      // over; the prompt still carries the written description.
    }
  }
  return out;
}

function mimeFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

async function safeErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as ImageApiResponse;
      return json.error?.message?.slice(0, 300) ?? text.slice(0, 200);
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
