import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CostEstimate, GeneratedAsset, JobStatus, ProviderJob, VoiceProvider, VoiceRequest } from "@/providers/types";
import { ProviderError } from "@/providers/types";
import type { ProviderStatus } from "@/domain/enums";
import { ffmpeg } from "@/media/ffmpeg";
import { CIT_AUTO_VOICE, CIT_ENGINES, CIT_MODEL, CIT_PROVIDER, isWav, pickCitVoice, type CitApiSpec, type CitEngineId } from "@/domain/cit";
import { citApiSpec, citGenerate, citHealth, citVoices, CIT_GENERATE_TIMEOUT_MS } from "./cit-client";

/**
 * CIT Voice Studio behind the job-based VoiceProvider interface (QĐ-144).
 *
 * Synchronous like OpenAI's TTS: one POST returns the audio, so createVoice
 * does the work and the job is already finished. Costs $0 - local generation.
 *
 * The request carries only what CIT documents and the running CIT's OpenAPI
 * declares. `instructions` (an OpenAI concept) is never sent: the Voice
 * Director's intent reaches CIT as inline tags already inside `text`.
 */

interface Finished {
  outputPath: string;
  durationMs: number;
  voiceId: string;
  engine: CitEngineId;
  converted: boolean;
}

const finished = new Map<string, Finished>();

export class CitVoiceProvider implements VoiceProvider {
  private spec: CitApiSpec | null | undefined;

  constructor(private readonly config: { baseUrl: string; timeoutMs?: number }) {}

  getName(): string {
    return CIT_PROVIDER;
  }

  async checkStatus(): Promise<ProviderStatus> {
    try {
      await citHealth(this.config.baseUrl);
      return "connected";
    } catch {
      return "unavailable";
    }
  }

  async estimateCost(): Promise<CostEstimate> {
    return { amount: 0, unit: "per_1k_chars", detail: "CIT Voice Studio chạy tại máy: $0." };
  }

  private async apiSpec(): Promise<CitApiSpec | null> {
    if (this.spec === undefined) this.spec = await citApiSpec(this.config.baseUrl);
    return this.spec;
  }

  /** "Tự động": the voice for this line's language, from what CIT lists now. */
  private async resolveVoice(req: VoiceRequest): Promise<{ voiceId: string; engine: CitEngineId }> {
    const voices = await citVoices(this.config.baseUrl);
    if (req.voiceId && req.voiceId !== CIT_AUTO_VOICE) {
      return { voiceId: req.voiceId, engine: voices.find((v) => v.id === req.voiceId)?.engine ?? "UNKNOWN" };
    }
    const pick = pickCitVoice(voices, await citHealth(this.config.baseUrl), req.language ?? "vi");
    if (!pick.ok) throw new ProviderError(pick.message, CIT_PROVIDER, false, pick.code.toLowerCase());
    return { voiceId: pick.voice.id, engine: pick.voice.engine };
  }

  async createVoice(req: VoiceRequest): Promise<ProviderJob> {
    if (req.text.trim().length === 0) {
      throw new ProviderError("Không có lời thoại để đọc.", CIT_PROVIDER, false, "empty_text");
    }
    if (fs.existsSync(req.outputPath)) {
      throw new ProviderError(`Đã có tệp âm thanh tại ${req.outputPath}; không ghi đè.`, CIT_PROVIDER, false, "output_exists");
    }
    const started = Date.now();
    const spec = await this.apiSpec();
    const { voiceId, engine } = await this.resolveVoice(req);
    const audio = await citGenerate(
      this.config.baseUrl,
      spec?.generate ?? null,
      { text: req.text, voiceId, speed: req.speed, language: req.language ?? null },
      this.config.timeoutMs ?? CIT_GENERATE_TIMEOUT_MS,
    );

    fs.mkdirSync(path.dirname(req.outputPath), { recursive: true });
    // WAV goes straight into the voice pipeline (which trims and levels every
    // clip anyway); anything else is decoded to WAV once.
    let converted = false;
    if (isWav(audio.bytes)) {
      fs.writeFileSync(req.outputPath, audio.bytes);
    } else {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "cit-"));
      try {
        const raw = path.join(work, "cit-audio");
        fs.writeFileSync(raw, audio.bytes);
        await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-i", raw, "-c:a", "pcm_s16le", "-f", "wav", req.outputPath]);
        converted = true;
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    }

    const id = `cit_${Buffer.from(req.outputPath).toString("base64url").slice(0, 40)}`;
    finished.set(id, { outputPath: req.outputPath, durationMs: Date.now() - started, voiceId, engine, converted });
    return { externalId: id, state: "completed", provider: CIT_PROVIDER, model: CIT_MODEL, estimatedCost: 0, sentRequest: { ...audio.body } };
  }

  async getJobStatus(externalId: string): Promise<JobStatus> {
    return finished.has(externalId)
      ? { externalId, state: "completed", progress: 100 }
      : { externalId, state: "failed", progress: 0, error: "Không tìm thấy job giọng nói CIT." };
  }

  async downloadResult(externalId: string): Promise<GeneratedAsset> {
    const done = finished.get(externalId);
    if (!done) throw new ProviderError(`Không tìm thấy job giọng nói ${externalId}.`, CIT_PROVIDER, false, "unknown_job");
    if (!fs.existsSync(done.outputPath)) {
      throw new ProviderError(`Tệp âm thanh đã biến mất: ${done.outputPath}.`, CIT_PROVIDER, false, "missing_file");
    }
    finished.delete(externalId);
    const engine = done.engine === "UNKNOWN" ? null : CIT_ENGINES[done.engine];
    return {
      filePath: done.outputPath,
      bytes: fs.statSync(done.outputPath).size,
      actualCost: 0,
      generationTimeMs: done.durationMs,
      meta: {
        provider: "CIT_LOCAL",
        localGeneration: true,
        generationDurationMs: done.durationMs,
        voiceId: done.voiceId,
        engine: done.engine,
        license: engine?.license ?? "unknown",
        attribution: engine?.attribution ?? "",
        converted: done.converted,
        model: CIT_MODEL,
      },
    };
  }

  async listVoices(): Promise<{ id: string; label: string; accent: "US" | "UK"; gender: "male" | "female" }[]> {
    try {
      const voices = await citVoices(this.config.baseUrl);
      return voices.map((v) => ({
        id: v.id,
        label: `${v.label}${v.engine === "UNKNOWN" ? "" : ` · ${CIT_ENGINES[v.engine].label}`}`,
        accent: "US" as const,
        gender: /n[ữu]|female|woman/i.test(v.gender ?? "") ? ("female" as const) : ("male" as const),
      }));
    } catch {
      return [];
    }
  }
}

/** Test helper. */
export function clearCitOutputs(): void {
  finished.clear();
}
