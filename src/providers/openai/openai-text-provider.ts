import type { ProviderStatus } from "@/domain/enums";
import {
  ScriptScoreSchema,
  YoutubeMetaSchema,
  type ScriptDoc,
  type ScriptScore,
} from "@/domain/script";
import type {
  CostEstimate,
  ProviderUsage,
  ScriptRequest,
  TextProvider,
  YoutubeMeta,
} from "@/providers/types";
import { ProviderError } from "@/providers/types";
import { buildPrompt } from "@/lib/prompts";
import { logger } from "@/lib/logger";
import { parseScript, repairJson } from "@/services/script-service";
import {
  chatCompletion,
  usageFrom,
  type ChatMessage,
  type ChatResult,
  type OpenAICompatibleConfig,
} from "./openai-client";

/**
 * Text provider speaking the OpenAI Chat Completions dialect.
 *
 * That dialect is the de-facto standard, so this one class covers OpenAI itself
 * and every service that mirrors it - DeepSeek, Groq, OpenRouter, Together,
 * Google's OpenAI-compatible endpoint - plus locally hosted models via Ollama or
 * LM Studio, which cost nothing at all and are the cheapest honest way to test
 * this integration.
 *
 * Which one is in use is decided entirely by `baseUrl` and the API key in the
 * provider config. No business logic outside this folder knows the difference.
 */
export class OpenAICompatibleTextProvider implements TextProvider {
  constructor(private readonly config: OpenAICompatibleConfig) {}

  getName(): string {
    return this.config.providerName;
  }

  async checkStatus(): Promise<ProviderStatus> {
    // Deliberately does not call the API: reporting a status must never cost
    // money. Configuration is all we inspect.
    if (!this.config.apiKey && this.config.requiresKey) return "missing_key";
    return "connected";
  }

  /**
   * Pre-flight estimate.
   *
   * The Chat Completions API gives no cost endpoint, so this is derived from
   * the registry price and a token estimate. Output tokens are capped by
   * `maxOutputTokens`, so the figure is an upper bound rather than a guess -
   * which is the right direction to be wrong in when the number gates spending.
   */
  async estimateScriptCost(req: ScriptRequest): Promise<CostEstimate> {
    const inputTokens = estimateTokens(req.systemPrompt);
    const outputTokens = this.config.maxOutputTokens;
    const amount =
      (inputTokens / 1000) * this.config.pricePer1kInput +
      (outputTokens / 1000) * this.config.pricePer1kOutput;

    return {
      amount: round6(amount),
      unit: "per_1k_tokens",
      detail:
        `${this.config.providerName}/${this.config.model}: ` +
        `~${inputTokens} token vào, tối đa ${outputTokens} token ra`,
    };
  }

  async generateScript(
    req: ScriptRequest,
  ): Promise<{ script: ScriptDoc; usage: ProviderUsage }> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a comedy writer for short vertical videos teaching English " +
          "idioms. You reply with one valid JSON object and nothing else.",
      },
      { role: "user", content: req.systemPrompt },
    ];

    const result = await chatCompletion(this.config, {
      messages,
      // Enough variety to avoid formulaic jokes, not so much that the JSON
      // structure starts drifting.
      temperature: 0.9,
      jsonMode: true,
      purpose: "script",
    });

    const usage = this.usageOf(result);
    try {
      // parseScript applies the repair-then-revalidate path from Milestone 1: a
      // fenced block, a prose preamble or a trailing comma is fixed and retried
      // once before anything is allowed to fail.
      return { script: parseScript(result.content), usage };
    } catch (err) {
      // The call was billed even though its output is unusable. Attach the cost
      // so the caller records it rather than losing it.
      throw new ProviderError(
        err instanceof Error ? err.message : String(err),
        this.config.providerName,
        true,
        "invalid_json",
        usage,
      );
    }
  }

  async scoreScript(
    script: ScriptDoc,
    model: string,
  ): Promise<{ score: ScriptScore; usage: ProviderUsage }> {
    const prompt = await buildPrompt("quality", {
      prompt:
        `Idiom: ${script.idiom}\nHook: ${script.hook}\n` +
        `Punchline: ${script.punchline}\nMeaning: ${script.meaning}\n` +
        `Example: ${script.exampleSentence}\n` +
        `Scenes: ${script.scenes.length}`,
      expectedCharacters: [
        ...new Set(script.scenes.flatMap((s) => s.characters)),
      ].join(", "),
    });

    const result = await chatCompletion(this.config, {
      messages: [
        {
          role: "system",
          content:
            "You score short-video scripts for an English-learning channel. " +
            "Reply with one valid JSON object and nothing else.",
        },
        {
          role: "user",
          content:
            `${prompt}\n\nScore this SCRIPT (not a video clip) on these axes ` +
            `and return JSON with exactly these keys: hook, humor, clarity, ` +
            `learningValue, visualFeasibility (each 1-10), and notes (string).`,
        },
      ],
      temperature: 0.2,
      jsonMode: true,
      purpose: "score",
      modelOverride: model,
    });

    return {
      score: parseJsonWith(
        result.content,
        ScriptScoreSchema,
        "điểm chất lượng kịch bản",
        this.config.providerName,
      ),
      usage: this.usageOf(result),
    };
  }

  async generateYoutubeMeta(
    script: ScriptDoc,
    model: string,
  ): Promise<{ meta: YoutubeMeta; usage: ProviderUsage }> {
    const prompt = await buildPrompt("youtube", {
      idiom: script.idiom,
      meaning: script.meaning,
      exampleSentence: script.exampleSentence,
      hook: script.hook,
      punchline: script.punchline,
    });

    const result = await chatCompletion(this.config, {
      messages: [
        {
          role: "system",
          content:
            "You write upload metadata for short educational videos. " +
            "Reply with one valid JSON object and nothing else.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
      jsonMode: true,
      purpose: "youtube",
      modelOverride: model,
    });

    return {
      meta: parseJsonWith(
        result.content,
        YoutubeMetaSchema,
        "metadata YouTube",
        this.config.providerName,
      ),
      usage: this.usageOf(result),
    };
  }

  /**
   * Turn reported token counts into money.
   *
   * Billing uses what the API says it consumed, never our pre-flight estimate.
   * When a provider reports no usage block (common on local runtimes) the cost
   * is 0 - which is correct there, and honest everywhere else because we refuse
   * to invent a charge we cannot substantiate.
   */
  private usageOf(result: ChatResult): ProviderUsage {
    return usageFrom(result, this.config);
  }
}

// ----------------------------------------------------------------- helpers ---

/**
 * Rough token count: ~4 characters per token for English.
 *
 * Only used for the pre-flight estimate. Actual billing uses the token counts
 * the API reports back, so an imprecise guess here never becomes a wrong charge.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Parse a JSON response through a Zod schema, repairing the usual damage first.
 *
 * Shares the repair rules with the script path so a model that wraps output in
 * a code fence is handled identically everywhere.
 */
function parseJsonWith<T>(
  raw: string,
  schema: { parse: (v: unknown) => T },
  what: string,
  provider: string,
): T {
  const attempt = (text: string): T => schema.parse(JSON.parse(text));
  try {
    return attempt(raw);
  } catch {
    try {
      return attempt(repairJson(raw));
    } catch (err) {
      void logger.error({
        event: "provider.json_invalid",
        provider,
        message: `Không đọc được ${what} từ nhà cung cấp.`,
        data: { sample: raw.slice(0, 400) },
      });
      throw new ProviderError(
        `Nhà cung cấp trả về ${what} không đúng định dạng JSON. ` +
          (err instanceof Error ? err.message : ""),
        provider,
        // Malformed output is worth one more sample; a different roll of the
        // dice often parses. The queue's attempt limit stops it looping.
        true,
        "invalid_json",
      );
    }
  }
}

export type { ChatResult };
