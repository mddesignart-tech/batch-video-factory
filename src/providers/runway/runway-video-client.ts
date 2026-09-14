import fs from "node:fs";
import path from "node:path";
import { ProviderError } from "@/providers/types";
import { logger } from "@/lib/logger";
import { classifyHttpError } from "@/providers/openai/openai-client";
import type { VideoModelConfig } from "@/providers/video-config";
import { RUNWAY_DURATIONS, nearestFrom } from "@/domain/video-duration";

/**
 * HTTP client for the Runway video API.
 *
 * Shape matches the other async video vendors - create a task, poll it,
 * collect the result - but three details differ and each one is a trap:
 *
 *   - the API version is a required header, not a URL segment, so a missing
 *     `X-Runway-Version` is a hard failure rather than a default;
 *   - the keyframe is sent as a base64 data URI inside JSON, not as multipart;
 *   - `ratio` is an explicit pixel pair like "720:1280", not an aspect label,
 *     and the separator is a colon where OpenAI uses an "x".
 */

/**
 * API version pinned deliberately.
 *
 * Runway treats this header as the contract: leaving it off or letting it
 * float means a vendor-side change can alter request handling underneath a
 * working integration. Bump it on purpose, never by accident.
 */
export const RUNWAY_API_VERSION = "2024-11-06";

export const RUNWAY_BASE_URL = "https://api.dev.runwayml.com/v1";

/**
 * Durations Runway accepts for a single clip.
 *
 * NOT verified against a live account - taken from the published examples.
 * The API is the authority; an unsupported value comes back as a free 400.
 * It matters here because 4 seconds - our benchmark length - is not in the
 * list, so a Runway comparison runs 5 seconds and costs proportionally more.
 *
 * Defined in `@/domain/video-duration` and re-exported here. The router has to
 * price this rule before any adapter is built, so the rule cannot live in the
 * adapter - that split is what let the spend guard under-quote Runway by 20%.
 */
export { RUNWAY_DURATIONS };

export interface RunwayTask {
  id: string;
  status: string;
  progress: number;
  /** Present once the task succeeds. */
  outputUrl?: string;
  error?: string;
}

const TERMINAL_OK = new Set(["succeeded"]);
const TERMINAL_FAIL = new Set(["failed", "cancelled", "canceled"]);

export function isTerminal(status: string): "ok" | "failed" | null {
  const s = status.toLowerCase();
  if (TERMINAL_OK.has(s)) return "ok";
  if (TERMINAL_FAIL.has(s)) return "failed";
  return null;
}

/** Runway wants "720:1280" where the registry stores "720x1280". */
export function toRunwayRatio(size: string): string {
  return size.replace("x", ":");
}

/** Nearest allowed duration, never rounding DOWN into a shorter paid clip. */
export function nearestDuration(seconds: number): number {
  return nearestFrom(RUNWAY_DURATIONS, seconds);
}

/** A keyframe has to travel inside JSON here, so it becomes a data URI. */
export function toDataUri(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : "image/png";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function headers(config: VideoModelConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Runway-Version": RUNWAY_API_VERSION,
    // The key goes in a header and nowhere else.
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as { error?: string; message?: string };
      return (json.error ?? json.message ?? text).slice(0, 300);
    } catch {
      return text.slice(0, 250);
    }
  } catch {
    return "";
  }
}

/** Submit one paid generation task. Never retried automatically. */
export async function createTask(
  config: VideoModelConfig,
  request: { prompt: string; seconds: number; keyframePath: string },
): Promise<RunwayTask> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/image_to_video`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({
        model: config.model,
        promptImage: toDataUri(request.keyframePath),
        promptText: request.prompt,
        ratio: toRunwayRatio(config.size),
        duration: nearestDuration(request.seconds),
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
        // Never auto-retried whatever the classifier says: the request may
        // already have been billed.
        false,
        classified.code,
      );
    }

    const json = (await response.json()) as { id?: string; status?: string };
    if (!json.id) {
      throw new ProviderError(
        "Runway nhận yêu cầu nhưng không trả về mã task.",
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
      message: `Đã tạo task ${json.id}, ${nearestDuration(request.seconds)}s ${config.size}`,
    });

    return { id: json.id, status: json.status ?? "PENDING", progress: 0 };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      await logger.warn({
        event: "provider.video_create_timeout",
        provider: config.providerName,
        model: config.model,
        message:
          `Quá ${config.timeoutMs}ms không có phản hồi khi tạo task. ` +
          `Task CÓ THỂ đã được tạo và tính phí.`,
      });
      throw new ProviderError(
        "Hết thời gian chờ khi gửi yêu cầu tạo video. Task có thể đã được tạo " +
          "và tính phí, nên hệ thống KHÔNG tự gửi lại. Hãy kiểm tra task hiện có.",
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

/** Read one task's state. Free: polling is not billed. */
export async function getTask(
  config: VideoModelConfig,
  taskId: string,
): Promise<RunwayTask> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/tasks/${encodeURIComponent(taskId)}`;
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
    const json = (await response.json()) as {
      id?: string;
      status?: string;
      progress?: number;
      output?: string[];
      failure?: string;
      failureCode?: string;
    };
    return {
      id: json.id ?? taskId,
      status: json.status ?? "UNKNOWN",
      // Runway reports progress as 0-1; the rest of the app uses 0-100.
      progress: Math.round((json.progress ?? 0) * 100),
      outputUrl: json.output?.[0],
      error: json.failure ?? json.failureCode,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the finished clip to disk.
 *
 * The output is a signed URL on a CDN rather than an API endpoint, so this one
 * request carries no auth header - sending the key to a storage host would
 * leak it somewhere it has no business being.
 */
export async function downloadTaskOutput(
  config: VideoModelConfig,
  outputUrl: string,
  outputPath: string,
): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs * 4);

  try {
    const response = await fetch(outputUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new ProviderError(
        `Không tải được video Runway: mã ${response.status}.`,
        config.providerName,
        response.status >= 500,
        `http_${response.status}`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new ProviderError(
        "Runway trả về tệp video rỗng.",
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
