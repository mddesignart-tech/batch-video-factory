import fs from "node:fs";
import type {
  CostEstimate,
  GeneratedAsset,
  JobStatus,
  ProviderJob,
  VoiceProvider,
  VoiceRequest,
} from "@/providers/types";
import { ProviderError } from "@/providers/types";
import type { ProviderStatus } from "@/domain/enums";
import { createSpeech, OPENAI_VOICES } from "./openai-voice-client";
import type { VoiceModelConfig } from "@/providers/voice-config";

/**
 * OpenAI text-to-speech behind the job-based VoiceProvider interface.
 *
 * The endpoint is synchronous - one POST returns the bytes - but the interface
 * is create/poll/download because image and video are genuinely asynchronous
 * and the pipeline has one job runner for all three. So createVoice does the
 * work and hands back an id that getJobStatus reports as already finished.
 *
 * That is a real simplification rather than a fudge: with nothing pending
 * between calls, there is no window in which audio is paid for but unclaimed,
 * which is the failure the job machinery exists to survive.
 */

interface Finished {
  outputPath: string;
  actualCost: number;
  billedChars: number;
  durationMs: number;
}

const finished = new Map<string, Finished>();

export class OpenAIVoiceProvider implements VoiceProvider {
  constructor(private readonly config: VoiceModelConfig) {}

  getName(): string {
    return this.config.providerName;
  }

  /** Must not perform a paid call, so this only reports whether a key exists. */
  async checkStatus(): Promise<ProviderStatus> {
    return this.config.apiKey.length > 0 ? "connected" : "missing_key";
  }

  /**
   * Dollars for this line, at the registry's price per 1000 characters.
   *
   * Billing counts the characters SENT, so the estimate and the charge use the
   * same number and cannot drift apart the way a duration-based guess would.
   */
  private costFor(text: string): number {
    return Math.round((text.length / 1000) * this.config.pricePer1kChars * 1e6) / 1e6;
  }

  async estimateCost(req: VoiceRequest): Promise<CostEstimate> {
    return {
      amount: this.costFor(req.text),
      unit: "per_1k_chars",
      detail:
        `${this.config.model}, ${req.text.length} ký tự x ` +
        `$${this.config.pricePer1kChars}/1k ký tự`,
    };
  }

  async createVoice(req: VoiceRequest): Promise<ProviderJob> {
    if (req.text.trim().length === 0) {
      throw new ProviderError(
        "Không có lời thoại để đọc.",
        this.config.providerName,
        false,
        "empty_text",
      );
    }

    const result = await createSpeech(
      this.config,
      {
        text: req.text,
        voiceId: req.voiceId,
        instructions: req.instructions ?? "",
        speed: req.speed,
        format: this.config.format,
      },
      req.outputPath,
    );

    const id = `voice_${Buffer.from(req.outputPath).toString("base64url").slice(0, 40)}`;
    finished.set(id, {
      outputPath: req.outputPath,
      actualCost: this.costFor(req.text),
      billedChars: result.billedChars,
      durationMs: result.durationMs,
    });

    return {
      externalId: id,
      // Already done. The endpoint is synchronous, so there is nothing pending
      // between this call and the download.
      state: "completed",
      provider: this.config.providerName,
      model: this.config.model,
      estimatedCost: this.costFor(req.text),
    };
  }

  async getJobStatus(externalId: string): Promise<JobStatus> {
    const done = finished.get(externalId);
    if (!done) {
      return {
        externalId,
        state: "failed",
        progress: 0,
        error: "Không tìm thấy job giọng nói.",
      };
    }
    return { externalId, state: "completed", progress: 100 };
  }

  async downloadResult(externalId: string): Promise<GeneratedAsset> {
    const done = finished.get(externalId);
    if (!done) {
      throw new ProviderError(
        `Không tìm thấy job giọng nói ${externalId}.`,
        this.config.providerName,
        false,
        "unknown_job",
      );
    }
    if (!fs.existsSync(done.outputPath)) {
      throw new ProviderError(
        `Tệp âm thanh đã biến mất: ${done.outputPath}.`,
        this.config.providerName,
        false,
        "missing_file",
      );
    }
    finished.delete(externalId);
    return {
      filePath: done.outputPath,
      bytes: fs.statSync(done.outputPath).size,
      // The real charge, not the forecast. Returning 0 here is how a real
      // charge vanishes from the ledger and lets the spend cap refund itself.
      actualCost: done.actualCost,
      generationTimeMs: done.durationMs,
      meta: { billedChars: done.billedChars, model: this.config.model },
    };
  }

  async listVoices(): Promise<
    { id: string; label: string; accent: "US" | "UK"; gender: "male" | "female" }[]
  > {
    // A static list, not a network call: OpenAI has no voice-listing endpoint,
    // and inventing a paid request to discover names would be absurd.
    return OPENAI_VOICES.map((v) => ({
      id: v.id,
      label: v.label,
      accent: "US" as const,
      gender: v.gender,
    }));
  }
}

/** Test helper: forget every completed job. */
export function clearVoiceOutputs(): void {
  finished.clear();
}
