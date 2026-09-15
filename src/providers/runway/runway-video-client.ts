import fs from "node:fs";
import path from "node:path";
import { ProviderError } from "@/providers/types";
import { logger } from "@/lib/logger";
import { classifyHttpError } from "@/providers/openai/openai-client";
import type { VideoModelConfig } from "@/providers/video-config";
import { RUNWAY_DURATIONS, billedVideoSeconds } from "@/domain/video-duration";

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
  /** The vendor's human-readable message. */
  error?: string;
  /**
   * The vendor's MACHINE code, kept separate from the message.
   *
   * These used to be collapsed - `error: json.failure ?? json.failureCode` -
   * and since Runway sends both, the code was thrown away every time. That
   * silently disabled the one mechanism built to stop the router re-sending a
   * scene Runway has already refused: `marksProviderUnsuitable` looks for
   * "BAD_OUTPUT" in the code, and by the time it ran the code had become the
   * string "generation_failed".
   *
   * The cost of that was measured, not theoretical: a real paid run came back
   * INTERNAL.BAD_OUTPUT.CODE01 and the scene was left unflagged, ready to be
   * sent to the same model again.
   */
  failureCode?: string;
  /**
   * Credits the vendor says it charged. NULL means "not reported".
   *
   * Zero is a real, useful answer and must survive: Runway returns
   * `cost: { credits: 0 }` on a failed task, which is proof that nothing was
   * billed. A truthy check would turn that proof back into "unknown" and leave
   * the money held. Hence `number | null`, never `number | undefined` with a
   * `||` fallback.
   */
  billedCredits: number | null;
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

/**
 * How each model wants the output size expressed.
 *
 * Runway's /image_to_video is ONE endpoint serving models from several vendors,
 * and they do not share a request schema. Sending the Gen-4 shape to all of
 * them is a validation error waiting to happen - and a rejected create is still
 * a create, which is the one thing this project will not spend.
 *
 *   RATIO       gen4_turbo, gen4.5 - `ratio: "720:1280"`, no `resolution`
 *   RESOLUTION  h3_max, wan3       - `resolution: "768p"`, and NO `ratio` field
 *                                    at all; the output aspect ratio follows
 *                                    the input image
 *
 * Verbatim from docs.dev.runwayml.com/assets/inputs (read 2026-09-15):
 *
 *   "MiniMax H3 Max supports `resolution` of `480p` or `768p`. Durations are
 *    5-15 seconds. There is no `ratio` parameter. Image-to-video accepts a
 *    first frame or first and last keyframes (each at least 256 pixels on both
 *    sides); output aspect ratio follows the input image."
 *
 * Note the lower-case `p`. The SIBLING model `hailuo3` spells the same idea
 * `768P` and does take a `ratio` - two MiniMax models, two schemas, one letter
 * apart. That is precisely why this is a table and not an if-statement.
 */
type SizeStyle = "RATIO" | "RESOLUTION";

const SIZE_STYLE: Record<string, SizeStyle> = {
  gen4_turbo: "RATIO",
  "gen4.5": "RATIO",
  gen3a_turbo: "RATIO",
  h3_max: "RESOLUTION",
  wan3: "RESOLUTION",
};

/** Resolution tiers each RESOLUTION-style model sells, shortest side first. */
const RESOLUTION_TIERS: Record<string, readonly string[]> = {
  h3_max: ["480p", "768p"],
  wan3: ["480p", "720p", "1080p"],
};

export function sizeStyleFor(model: string): SizeStyle {
  // Unknown models get the Gen-4 shape, which is what the endpoint has always
  // meant by default - but they are not silently trusted: nothing reaches this
  // function without a registry row, and a registry row is added deliberately.
  return SIZE_STYLE[model] ?? "RATIO";
}

/**
 * "768x1280" -> "768p", picking the tier the model actually sells.
 *
 * The short side is the tier, because these are portrait clips: a 768x1280
 * frame is 768p, not 1280p. Getting that backwards would ask for a tier the
 * model does not sell and buy a 400.
 */
export function toRunwayResolution(model: string, size: string): string {
  const tiers = RESOLUTION_TIERS[model] ?? [];
  const [w, h] = size.split("x").map(Number);
  const shortSide = Math.min(w || 0, h || 0);
  const wanted = `${shortSide}p`;
  if (tiers.includes(wanted)) return wanted;
  // Not a tier this model sells. Round DOWN to one it does, so a request can
  // never silently cost more than the registry row was priced at. wan3 is the
  // reason: its own default is `auto_1080p` at 20 credits/s, four times the
  // 480p rate, so an omitted or optimistic value is a 4x bill.
  const numeric = tiers
    .map((t) => ({ tier: t, px: Number(t.replace("p", "")) }))
    .filter((t) => Number.isFinite(t.px))
    .sort((a, b) => a.px - b.px);
  const affordable = numeric.filter((t) => t.px <= shortSide).pop();
  return affordable?.tier ?? numeric[0]?.tier ?? wanted;
}

export interface RunwayCreateBody {
  model: string;
  promptImage: string;
  promptText: string;
  duration: number;
  ratio?: string;
  resolution?: string;
}

/**
 * The exact JSON that will be sent. Built here, and tested here, so the request
 * can be asserted without a network call and without spending anything.
 */
export function buildCreateBody(
  config: VideoModelConfig,
  request: { prompt: string; seconds: number; keyframePath: string },
): RunwayCreateBody {
  const base = {
    model: config.model,
    promptImage: toDataUri(request.keyframePath),
    promptText: request.prompt,
    duration: nearestDuration(request.seconds, config.model),
  };
  if (sizeStyleFor(config.model) === "RESOLUTION") {
    // `ratio` is deliberately ABSENT, not empty. These models reject the field
    // outright rather than ignoring it.
    return { ...base, resolution: toRunwayResolution(config.model, config.size) };
  }
  return { ...base, ratio: toRunwayRatio(config.size) };
}

/**
 * Duration this MODEL will accept, and be billed for.
 *
 * gen4_turbo sells 5- and 10-second clips only; gen4.5 bills by the second
 * across 2-10. Sending a quantised length to gen4.5 would buy a different clip
 * than the scene needs, and quoting one would refuse a request that is
 * affordable - so the rule follows the model rather than the vendor.
 *
 * The single-argument form is kept for callers that mean gen4_turbo.
 */
export function nearestDuration(seconds: number, model?: string): number {
  return billedVideoSeconds({
    provider: "runway",
    model: model ?? "gen4_turbo",
    size: "720x1280",
    requestedSeconds: seconds,
    hasKeyframe: true,
  });
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
      const json = JSON.parse(text) as Record<string, unknown>;
      const headline =
        (typeof json.error === "string" ? json.error : undefined) ??
        (typeof json.message === "string" ? json.message : undefined) ??
        "";
      // Keep the field-level detail. Runway answers a bad body with a bare
      // "Validation of body failed" in `error` and puts WHICH field failed in a
      // sibling key. Returning only the headline threw away the one part that
      // says what to fix, and turned a one-line correction into guesswork.
      const extras = Object.entries(json)
        .filter(([k]) => k !== "error" && k !== "message")
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("; ");
      const full = [headline, extras].filter((p) => p.length > 0).join(" | ");
      return (full.length > 0 ? full : text).slice(0, 600);
    } catch {
      return text.slice(0, 400);
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
      body: JSON.stringify(buildCreateBody(config, request)),
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
      message: `Đã tạo task ${json.id}, ${nearestDuration(request.seconds, config.model)}s ${config.size}`,
    });

    // A freshly created task has been billed nothing yet, and has no failure
    // code. `null` says "not reported", which is the truth at this moment.
    return {
      id: json.id,
      status: json.status ?? "PENDING",
      progress: 0,
      billedCredits: null,
    };
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
      cost?: { credits?: number };
    };
    return {
      id: json.id ?? taskId,
      status: json.status ?? "UNKNOWN",
      // Runway reports progress as 0-1; the rest of the app uses 0-100.
      progress: Math.round((json.progress ?? 0) * 100),
      outputUrl: json.output?.[0],
      error: json.failure ?? json.failureCode,
      // Kept SEPARATE from `error`. See RunwayTask.failureCode.
      failureCode: json.failureCode,
      // `typeof === "number"`, not `?? null` after a truthy test: zero credits
      // is the answer that matters most, and any truthy check erases it.
      billedCredits:
        typeof json.cost?.credits === "number" ? json.cost.credits : null,
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
