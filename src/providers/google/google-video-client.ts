import fs from "node:fs";
import path from "node:path";
import { ProviderError } from "@/providers/types";
import { logger } from "@/lib/logger";
import { classifyHttpError } from "@/providers/openai/openai-client";
import {
  aspectRatioFor,
  resolutionTierFor,
  type VideoModelConfig,
} from "@/providers/video-config";
import {
  VEO_DURATIONS,
  forcedToEightSeconds,
  nearestFrom,
} from "@/domain/video-duration";

/**
 * HTTP client for Google's Veo video generation, via the Gemini API.
 *
 * Three things differ from the other vendors and each one matters:
 *
 *   - authentication is an `x-goog-api-key` header, not a bearer token;
 *   - the job is a long-running *operation* addressed by an opaque name, and
 *     the reply carries `done` rather than a status string;
 *   - the finished file is fetched from a Files API URI that needs the key
 *     appended, so the download is authenticated where Runway's is not.
 */

export const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Durations Veo accepts.
 *
 * NOT verified against a live account - taken from the published docs, which
 * also state that 1080p and reference-image generations are forced to 8
 * seconds. Whether a single first-frame image counts as a "reference image"
 * for that rule is unclear from the documentation, and it doubles the price if
 * it does. The API is the authority; an unsupported value is a free 400.
 */
export { VEO_DURATIONS };

export interface VeoOperation {
  name: string;
  done: boolean;
  progress: number;
  /** Files API URI of the finished clip, once done. */
  videoUri?: string;
  error?: string;
}

/** Nearest allowed duration, never rounding DOWN into a shorter paid clip. */
export function nearestDuration(seconds: number): number {
  return nearestFrom(VEO_DURATIONS, seconds);
}

/**
 * Does this request fall under the vendor's "must be 8 seconds" rule?
 *
 * Surfaced as its own function because it changes the price: a 4-second clip
 * that silently becomes 8 seconds costs twice the estimate, which is exactly
 * the kind of surprise the spend guards exist to prevent.
 */
export { forcedToEightSeconds };

function headers(config: VideoModelConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    // Google uses its own header name; a bearer token is silently ignored.
    ...(config.apiKey ? { "x-goog-api-key": config.apiKey } : {}),
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as { error?: { message?: string } };
      return json.error?.message?.slice(0, 300) ?? text.slice(0, 250);
    } catch {
      return text.slice(0, 250);
    }
  } catch {
    return "";
  }
}

interface OperationResponse {
  name?: string;
  done?: boolean;
  error?: { message?: string };
  metadata?: { progressPercent?: number };
  response?: {
    generatedVideos?: { video?: { uri?: string } }[];
    generateVideoResponse?: {
      generatedSamples?: { video?: { uri?: string } }[];
    };
  };
}

function extractUri(json: OperationResponse): string | undefined {
  return (
    json.response?.generatedVideos?.[0]?.video?.uri ??
    json.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
  );
}

/** Submit one paid generation. Never retried automatically. */
export async function createOperation(
  config: VideoModelConfig,
  request: { prompt: string; seconds: number; keyframePath?: string },
): Promise<VeoOperation> {
  const url =
    `${config.baseUrl.replace(/\/+$/, "")}/models/` +
    `${encodeURIComponent(config.model)}:predictLongRunning`;

  const instance: Record<string, unknown> = { prompt: request.prompt };
  if (request.keyframePath) {
    instance.image = {
      bytesBase64Encoded: fs.readFileSync(request.keyframePath).toString("base64"),
      mimeType: mimeFor(request.keyframePath),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({
        instances: [instance],
        parameters: {
          aspectRatio: aspectRatioFor(config.size),
          resolution: resolutionTierFor(config.size),
          durationSeconds: nearestDuration(request.seconds),
          // Veo adds a generated soundtrack by default. This pipeline supplies
          // its own narration later, so the vendor's audio would be paid for
          // and then thrown away.
          generateAudio: false,
        },
      }),
      signal: controller.signal,
    });
    const durationMs = Date.now() - started;

    if (!response.ok) {
      const classified = classifyHttpError(response.status);
      const detail = await readError(response);
      await logger.error({
        event: "provider.video_http_error",
        provider: config.providerName,
        model: config.model,
        durationMs,
        status: String(response.status),
        message: `${classified.message} ${detail}`.trim(),
      });
      throw new ProviderError(
        `${classified.message}${detail ? ` (${detail})` : ""}`,
        config.providerName,
        false,
        classified.code,
      );
    }

    const json = (await response.json()) as OperationResponse;
    if (!json.name) {
      throw new ProviderError(
        "Google nhận yêu cầu nhưng không trả về tên operation.",
        config.providerName,
        false,
        "missing_job_id",
      );
    }

    await logger.info({
      event: "provider.video_created",
      provider: config.providerName,
      model: config.model,
      durationMs,
      message: `Đã tạo operation ${json.name}, ${nearestDuration(request.seconds)}s ${config.size}`,
    });

    return { name: json.name, done: json.done ?? false, progress: 0 };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      await logger.warn({
        event: "provider.video_create_timeout",
        provider: config.providerName,
        model: config.model,
        message:
          `Quá ${config.timeoutMs}ms không có phản hồi. Operation CÓ THỂ đã ` +
          `được tạo và tính phí.`,
      });
      throw new ProviderError(
        "Hết thời gian chờ khi gửi yêu cầu tạo video. Operation có thể đã được " +
          "tạo và tính phí, nên hệ thống KHÔNG tự gửi lại.",
        config.providerName,
        false,
        "create_timeout",
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Read one operation's state. Free: polling is not billed. */
export async function getOperation(
  config: VideoModelConfig,
  name: string,
): Promise<VeoOperation> {
  // The operation name is already a full resource path, so it is appended
  // rather than URL-encoded whole - encoding the slashes would 404.
  const url = `${config.baseUrl.replace(/\/+$/, "")}/${name}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      headers: headers(config),
      signal: controller.signal,
    });
    if (!response.ok) {
      const classified = classifyHttpError(response.status);
      throw new ProviderError(
        `${classified.message} ${await readError(response)}`.trim(),
        config.providerName,
        classified.retryable,
        classified.code,
      );
    }
    const json = (await response.json()) as OperationResponse;
    return {
      name: json.name ?? name,
      done: json.done ?? false,
      progress: json.metadata?.progressPercent ?? 0,
      videoUri: extractUri(json),
      error: json.error?.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the finished clip. The Files API needs the key, so it is sent again. */
export async function downloadVideoFile(
  config: VideoModelConfig,
  videoUri: string,
  outputPath: string,
): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs * 4);

  try {
    const response = await fetch(videoUri, {
      headers: config.apiKey ? { "x-goog-api-key": config.apiKey } : {},
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ProviderError(
        `Không tải được video Veo: mã ${response.status}.`,
        config.providerName,
        response.status >= 500,
        `http_${response.status}`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new ProviderError(
        "Google trả về tệp video rỗng.",
        config.providerName,
        true,
        "empty_video",
      );
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (fs.existsSync(outputPath)) {
      throw new ProviderError(
        `Tệp đích đã tồn tại: ${outputPath}. Không ghi đè tài sản đã tạo.`,
        config.providerName,
        false,
        "output_exists",
      );
    }
    fs.writeFileSync(outputPath, bytes);
    return bytes.byteLength;
  } finally {
    clearTimeout(timer);
  }
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}
