import fs from "node:fs";
import path from "node:path";
import { ProviderError } from "@/providers/types";
import { logger } from "@/lib/logger";
import { classifyHttpError } from "@/providers/openai/openai-client";
import {
  clampSpeed,
  type AudioFormat,
  type VoiceModelConfig,
} from "@/providers/voice-config";

/**
 * HTTP client for OpenAI's speech endpoint.
 *
 * Unlike image and video, this vendor's TTS is SYNCHRONOUS: one POST returns
 * the audio bytes. There is no task to poll and no job to resume, which also
 * means there is no window where a clip is paid for but unclaimed.
 *
 * The interesting parameter is `instructions`, which gpt-4o-mini-tts accepts
 * and the older tts-1 models ignore. It is the difference between a voice that
 * reads a line and one that acts it, and it is why this model was chosen: the
 * comedy in these videos lives in the delivery.
 */

export const OPENAI_SPEECH_PATH = "/audio/speech";

/** Voices OpenAI ships. Listed so the UI can offer them without a network call. */
export const OPENAI_VOICES = [
  { id: "alloy", label: "Alloy - trung tính", gender: "male" as const },
  { id: "ash", label: "Ash - nam, chắc", gender: "male" as const },
  { id: "ballad", label: "Ballad - nam, trầm ấm", gender: "male" as const },
  { id: "coral", label: "Coral - nữ, sáng", gender: "female" as const },
  { id: "echo", label: "Echo - nam, rõ", gender: "male" as const },
  { id: "fable", label: "Fable - nam, kể chuyện", gender: "male" as const },
  { id: "nova", label: "Nova - nữ, trẻ trung", gender: "female" as const },
  { id: "onyx", label: "Onyx - nam, trầm", gender: "male" as const },
  { id: "sage", label: "Sage - nữ, điềm tĩnh", gender: "female" as const },
  { id: "shimmer", label: "Shimmer - nữ, nhẹ", gender: "female" as const },
] as const;

export function isKnownVoice(id: string): boolean {
  return OPENAI_VOICES.some((v) => v.id === id);
}

function headers(config: VoiceModelConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    // The key goes in a header and nowhere else.
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as { error?: { message?: string } };
      return (json.error?.message ?? text).slice(0, 500);
    } catch {
      return text.slice(0, 400);
    }
  } catch {
    return "";
  }
}

export interface SpeechRequest {
  text: string;
  voiceId: string;
  /** Delivery direction. Sent only when the model supports it. */
  instructions: string;
  speed: number;
  format: AudioFormat;
}

export interface SpeechResult {
  bytes: number;
  durationMs: number;
  /** Characters billed - what the price is actually multiplied by. */
  billedChars: number;
}

/**
 * Synthesise one line and write it to disk.
 *
 * Refuses to overwrite: an existing file at the output path means something
 * already produced audio there, and silently replacing it would discard a clip
 * that was paid for.
 */
export async function createSpeech(
  config: VoiceModelConfig,
  request: SpeechRequest,
  outputPath: string,
): Promise<SpeechResult> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}${OPENAI_SPEECH_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = Date.now();

  const body: Record<string, unknown> = {
    model: config.model,
    input: request.text,
    voice: request.voiceId,
    response_format: request.format,
    speed: clampSpeed(request.speed),
  };
  // Older TTS models reject an unknown field rather than ignoring it, so this
  // is gated on the capability flag instead of always being sent.
  if (config.supportsInstructions && request.instructions.trim().length > 0) {
    body.instructions = request.instructions.trim();
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const durationMs = Date.now() - started;

    if (!response.ok) {
      const detail = await readError(response);
      const { retryable, code, message } = classifyHttpError(response.status);
      await logger.error({
        event: "provider.voice_http_error",
        provider: config.providerName,
        model: config.model,
        durationMs,
        message: `${message} ${detail}`,
      });
      throw new ProviderError(
        `${message} (${detail})`,
        config.providerName,
        retryable,
        code,
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      // Billed and useless. Treated as an error so the ledger still records the
      // charge rather than pretending nothing happened.
      throw new ProviderError(
        "OpenAI trả về tệp âm thanh rỗng.",
        config.providerName,
        true,
        "empty_audio",
      );
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (fs.existsSync(outputPath)) {
      throw new ProviderError(
        `Đã có tệp tại ${outputPath}. Không ghi đè lên âm thanh đã tạo.`,
        config.providerName,
        false,
        "output_exists",
      );
    }
    fs.writeFileSync(outputPath, bytes);

    await logger.info({
      event: "provider.voice_created",
      provider: config.providerName,
      model: config.model,
      durationMs,
      message:
        `Đã tạo ${bytes.byteLength} byte ${request.format}, ` +
        `giọng ${request.voiceId}, ${request.text.length} ký tự` +
        (body.instructions ? ", có instructions" : ""),
    });

    return {
      bytes: bytes.byteLength,
      durationMs,
      billedChars: request.text.length,
    };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      // Synchronous endpoint: a timeout here may still have been billed, and
      // there is no task id to ask about, so it must never be auto-resent.
      await logger.warn({
        event: "provider.voice_timeout",
        provider: config.providerName,
        model: config.model,
        message:
          `Quá ${config.timeoutMs}ms không có phản hồi. CÓ THỂ đã bị tính phí ` +
          `- không gửi lại tự động.`,
      });
      throw new ProviderError(
        `Quá thời gian chờ ${config.timeoutMs}ms khi tạo giọng nói.`,
        config.providerName,
        false,
        "timeout",
      );
    }
    throw new ProviderError(
      err instanceof Error ? err.message : "Lỗi mạng không xác định.",
      config.providerName,
      true,
      "network",
    );
  } finally {
    clearTimeout(timer);
  }
}
