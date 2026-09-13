import fs from "node:fs";
import path from "node:path";
import { ProviderError } from "@/providers/types";
import { logger } from "@/lib/logger";
import { classifyHttpError } from "./openai-client";

/**
 * HTTP client for the OpenAI video API (Sora).
 *
 * Unlike images, this is genuinely asynchronous: create returns a job, the job
 * is polled, and only then is the file downloaded. That shape matters for cost
 * safety - a poll or a download that fails must never cause a second paid
 * create, so creating and collecting are separate operations here and the
 * caller holds the job id in the database between them.
 */

export interface OpenAIVideoConfig {
  providerName: string;
  /** API model name, e.g. "sora-2". */
  model: string;
  apiKey: string;
  baseUrl: string;
  /** Dollars per second, from ModelRegistry. Never a constant in code. */
  pricePerSecond: number;
  /** Exact output size the API accepts, e.g. "720x1280". */
  size: string;
  /** How long to wait for one HTTP call (not for the whole job). */
  timeoutMs: number;
}

export interface VideoCreateRequest {
  prompt: string;
  seconds: number;
  /**
   * Absolute path of the first-frame image.
   *
   * The API requires it to match `size` exactly, so the caller must have
   * resized it already; sending a mismatched image is a 400 and a wasted trip.
   */
  inputReferencePath?: string;
}

export interface VideoJob {
  id: string;
  status: string;
  /** 0-100 when the API reports it. */
  progress: number;
  error?: string;
}

/** Job states the API reports. Anything else is treated as still running. */
const TERMINAL_OK = new Set(["completed", "succeeded"]);
const TERMINAL_FAIL = new Set(["failed", "cancelled", "canceled", "error"]);

export function isTerminal(status: string): "ok" | "failed" | null {
  const s = status.toLowerCase();
  if (TERMINAL_OK.has(s)) return "ok";
  if (TERMINAL_FAIL.has(s)) return "failed";
  return null;
}

/**
 * Create attempts are capped at ONE.
 *
 * A video costs dollars, not cents. Every other retry policy in this codebase
 * balances reliability against a fraction of a cent; here a single accidental
 * repeat is the most expensive mistake the system can make, so a create is
 * never retried automatically - the caller resumes the existing job instead.
 */
export const MAX_CREATE_ATTEMPTS = 1;

interface VideoApiResponse {
  id?: string;
  status?: string;
  progress?: number;
  error?: { message?: string; code?: string } | string | null;
}

function authHeaders(config: OpenAIVideoConfig): Record<string, string> {
  // The key goes in a header and nowhere else - never a query string, never a
  // log line, never a stored request body.
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

async function readError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as { error?: { message?: string } };
      return json.error?.message?.slice(0, 400) ?? text.slice(0, 250);
    } catch {
      return text.slice(0, 250);
    }
  } catch {
    return "";
  }
}

function errorText(error: VideoApiResponse["error"]): string | undefined {
  if (!error) return undefined;
  if (typeof error === "string") return error;
  return error.message ?? error.code;
}

/** Submit one paid generation job. Never retried automatically. */
export async function createVideo(
  config: OpenAIVideoConfig,
  request: VideoCreateRequest,
): Promise<VideoJob> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/videos`;
  const started = Date.now();

  const form = new FormData();
  form.append("model", config.model);
  form.append("prompt", request.prompt);
  form.append("size", config.size);
  form.append("seconds", String(request.seconds));

  if (request.inputReferencePath) {
    const bytes = fs.readFileSync(request.inputReferencePath);
    const name = path.basename(request.inputReferencePath);
    form.append(
      "input_reference",
      new Blob([new Uint8Array(bytes)], { type: mimeFor(name) }),
      name,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders(config),
      body: form,
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
        // A create is never auto-retried whatever the classifier says: the
        // caller must decide, because the request may already have been billed.
        false,
        classified.code,
      );
    }

    const json = (await response.json()) as VideoApiResponse;
    if (!json.id) {
      throw new ProviderError(
        "Nhà cung cấp nhận yêu cầu nhưng không trả về mã job.",
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
      message: `Đã tạo job video ${json.id}, trạng thái ${json.status ?? "?"}, ${request.seconds}s ${config.size}`,
    });

    return {
      id: json.id,
      status: json.status ?? "queued",
      progress: json.progress ?? 0,
      error: errorText(json.error),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // The single most dangerous case: the request may have been accepted and
      // billed even though we never saw the reply. Say so explicitly so the
      // caller looks for an existing job rather than submitting another.
      await logger.warn({
        event: "provider.video_create_timeout",
        provider: config.providerName,
        model: config.model,
        message:
          `Quá ${config.timeoutMs}ms không có phản hồi khi tạo video. ` +
          `Job CÓ THỂ đã được tạo và tính phí - phải kiểm tra danh sách job ` +
          `trước khi gửi lại.`,
      });
      throw new ProviderError(
        "Hết thời gian chờ khi gửi yêu cầu tạo video. Job có thể đã được tạo " +
          "và tính phí, nên hệ thống KHÔNG tự gửi lại. Hãy kiểm tra job hiện có.",
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

/** Read one job's state. Free: polling is not billed. */
export async function getVideoJob(
  config: OpenAIVideoConfig,
  jobId: string,
): Promise<VideoJob> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/videos/${encodeURIComponent(jobId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      headers: authHeaders(config),
      signal: controller.signal,
    });
    if (!response.ok) {
      const classified = classifyHttpError(response.status);
      const detail = await readError(response);
      throw new ProviderError(
        `${classified.message}${detail ? ` (${detail})` : ""}`,
        config.providerName,
        classified.retryable,
        classified.code,
      );
    }
    const json = (await response.json()) as VideoApiResponse;
    return {
      id: json.id ?? jobId,
      status: json.status ?? "unknown",
      progress: json.progress ?? 0,
      error: errorText(json.error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** List recent jobs, so a timed-out create can be reconciled before retrying. */
export async function listVideoJobs(
  config: OpenAIVideoConfig,
  limit = 20,
): Promise<VideoJob[]> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/videos?limit=${limit}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      headers: authHeaders(config),
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const json = (await response.json()) as { data?: VideoApiResponse[] };
    return (json.data ?? [])
      .filter((j): j is VideoApiResponse & { id: string } => Boolean(j.id))
      .map((j) => ({
        id: j.id,
        status: j.status ?? "unknown",
        progress: j.progress ?? 0,
        error: errorText(j.error),
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Stream the finished MP4 to disk. Free: the video was billed at creation. */
export async function downloadVideo(
  config: OpenAIVideoConfig,
  jobId: string,
  outputPath: string,
): Promise<number> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/videos/${encodeURIComponent(jobId)}/content`;
  const controller = new AbortController();
  // Downloads are a file transfer, not a request-response, so they get their
  // own longer ceiling rather than the per-call timeout.
  const timer = setTimeout(() => controller.abort(), config.timeoutMs * 4);

  try {
    const response = await fetch(url, {
      headers: authHeaders(config),
      signal: controller.signal,
    });
    if (!response.ok) {
      const classified = classifyHttpError(response.status);
      const detail = await readError(response);
      throw new ProviderError(
        `Không tải được video: ${classified.message}${detail ? ` (${detail})` : ""}`,
        config.providerName,
        classified.retryable,
        classified.code,
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new ProviderError(
        "Nhà cung cấp trả về tệp video rỗng.",
        config.providerName,
        true,
        "empty_video",
      );
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    // Refuse to clobber: generated assets are paid for and must never be lost
    // to a rerun writing over the same name.
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

function mimeFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}
