import { ProviderError, type ProviderUsage } from "@/providers/types";
import { logger } from "@/lib/logger";

/**
 * HTTP client for the OpenAI Chat Completions dialect.
 *
 * Everything about *spending money safely* that is specific to a text API lives
 * here: error classification, bounded retries, and capturing the token counts
 * the provider reports so actual cost can be computed rather than guessed.
 */

export interface OpenAICompatibleConfig {
  /** Registry name: "openai", "deepseek", "ollama", ... */
  providerName: string;
  model: string;
  apiKey: string;
  /** e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Local runtimes (Ollama, LM Studio) accept any key, including none. */
  requiresKey: boolean;
  pricePer1kInput: number;
  pricePer1kOutput: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature: number;
  jsonMode: boolean;
  /** Short label used in logs: script | score | youtube. */
  purpose: string;
  modelOverride?: string;
}

export interface ChatResult {
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  model: string;
  finishReason: string | null;
}

/** How many times a *retryable* failure may be re-sent. */
export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 4000] as const;

/**
 * Error classification.
 *
 * This is the difference between a transient hiccup and burning through an API
 * budget on a request that will never succeed. A bad key or a malformed request
 * fails the same way every time, so retrying it only wastes money and time.
 */
export function classifyHttpError(status: number): {
  retryable: boolean;
  code: string;
  message: string;
} {
  if (status === 401 || status === 403) {
    return {
      retryable: false,
      code: "auth_failed",
      message:
        "API key bị từ chối. Kiểm tra lại key trong .env hoặc trang Nhà cung cấp AI.",
    };
  }
  if (status === 400 || status === 422) {
    return {
      retryable: false,
      code: "bad_request",
      message: "Yêu cầu không hợp lệ. Gửi lại y hệt cũng sẽ hỏng.",
    };
  }
  if (status === 404) {
    return {
      retryable: false,
      code: "model_not_found",
      message: "Không tìm thấy model. Kiểm tra lại tên model trong trang Mô hình AI.",
    };
  }
  if (status === 402) {
    return {
      retryable: false,
      code: "insufficient_quota",
      message: "Tài khoản hết hạn mức hoặc chưa nạp tiền.",
    };
  }
  if (status === 429) {
    return {
      retryable: true,
      code: "rate_limited",
      message: "Bị giới hạn tần suất. Sẽ thử lại sau.",
    };
  }
  if (status >= 500) {
    return {
      retryable: true,
      code: "provider_error",
      message: "Nhà cung cấp gặp lỗi máy chủ. Sẽ thử lại sau.",
    };
  }
  return {
    retryable: false,
    code: `http_${status}`,
    message: `Nhà cung cấp trả về mã ${status}.`,
  };
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  model?: string;
  error?: { message?: string; type?: string };
}

/**
 * One chat completion, with bounded retries.
 *
 * Note what is NOT retried: anything the classifier calls non-retryable, and
 * anything after the attempt budget is spent. There is no unbounded loop
 * anywhere in this function, which is the property that matters when each
 * attempt costs money.
 */
export async function chatCompletion(
  config: OpenAICompatibleConfig,
  request: ChatRequest,
): Promise<ChatResult> {
  const model = request.modelOverride ?? config.model;
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      // The key goes in a header and nowhere else - never a query string, never
      // a log, never the request body we serialise for storage.
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      const body: Record<string, unknown> = {
        model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: config.maxOutputTokens,
      };
      if (request.jsonMode) {
        body.response_format = { type: "json_object" };
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const durationMs = Date.now() - started;

      if (!response.ok) {
        const classified = classifyHttpError(response.status);
        const detail = await safeErrorBody(response);

        await logger.error({
          event: "provider.http_error",
          provider: config.providerName,
          model,
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

        // Honour Retry-After when the provider sends one; it knows better than
        // our fixed backoff does.
        const retryAfter = Number(response.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30_000)
          : (BACKOFF_MS[attempt] ?? 4000);

        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(wait);
          continue;
        }
        throw error;
      }

      const json = (await response.json()) as ChatCompletionResponse;
      const content = json.choices?.[0]?.message?.content ?? "";

      if (content.trim().length === 0) {
        throw new ProviderError(
          "Nhà cung cấp trả về nội dung rỗng.",
          config.providerName,
          true,
          "empty_response",
        );
      }

      const result: ChatResult = {
        content,
        inputTokens: json.usage?.prompt_tokens ?? null,
        outputTokens: json.usage?.completion_tokens ?? null,
        durationMs,
        model: json.model ?? model,
        finishReason: json.choices?.[0]?.finish_reason ?? null,
      };

      await logger.info({
        event: "provider.text_completed",
        provider: config.providerName,
        model: result.model,
        durationMs,
        message: `${request.purpose}: ${result.inputTokens ?? "?"} token vào, ${
          result.outputTokens ?? "?"
        } token ra`,
        data: { finishReason: result.finishReason },
      });

      // A truncated response is almost certainly invalid JSON. Say so clearly
      // rather than letting the parser fail with something cryptic.
      if (result.finishReason === "length") {
        // The provider already billed for this call, so the error carries what
        // it consumed. Throwing without that would lose real spend.
        throw new ProviderError(
          `Phản hồi bị cắt vì chạm giới hạn ${config.maxOutputTokens} token. ` +
            `Hãy tăng maxOutputTokens hoặc rút ngắn prompt.`,
          config.providerName,
          false,
          "truncated",
          usageFrom(result, config),
        );
      }

      return result;
    } catch (err) {
      lastError = err;

      if (err instanceof ProviderError && !err.retryable) throw err;

      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted) {
        await logger.warn({
          event: "provider.timeout",
          provider: config.providerName,
          model,
          message: `Quá ${config.timeoutMs}ms không có phản hồi.`,
        });
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(BACKOFF_MS[attempt] ?? 4000);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ProviderError(
        "Không gọi được nhà cung cấp sau nhiều lần thử.",
        config.providerName,
        true,
        "exhausted",
      );
}

/**
 * Cost of a call from what the provider reported.
 *
 * Shared by the success path and the post-billing failure paths so a truncated
 * or unparseable reply is still accounted for.
 */
export function usageFrom(
  result: ChatResult,
  config: OpenAICompatibleConfig,
): ProviderUsage {
  const input = result.inputTokens ?? 0;
  const output = result.outputTokens ?? 0;
  return {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
    actualCost:
      Math.round(
        ((input / 1000) * config.pricePer1kInput +
          (output / 1000) * config.pricePer1kOutput) *
          1e6,
      ) / 1e6,
    model: result.model,
  };
}

/** Read an error body without ever letting a parse failure mask the real error. */
async function safeErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as ChatCompletionResponse;
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
