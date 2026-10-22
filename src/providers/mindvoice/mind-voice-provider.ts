import fs from "node:fs";
import path from "node:path";
import type { CostEstimate, GeneratedAsset, JobStatus, ProviderJob, VoiceProvider, VoiceRequest } from "@/providers/types";
import { ProviderError } from "@/providers/types";
import type { ProviderStatus } from "@/domain/enums";
import { ffmpeg } from "@/media/ffmpeg";
import {
  atempoFilter,
  clampMindSpeed,
  MIND_AUTO_VOICE,
  MIND_ENGINES,
  MIND_MODEL,
  MIND_PROVIDER,
  mindVoiceLabel,
  pickMindVoice,
  type MindEngineId,
} from "@/domain/mind-voice";
import { mindHealth, mindTts, mindVoices, MIND_GENERATE_TIMEOUT_MS } from "./mind-voice-client";

/**
 * Mind Voice behind the job-based VoiceProvider interface (QĐ-145).
 *
 * Synchronous like OpenAI's TTS: one POST returns the audio, so createVoice
 * does the work and the job is already finished. Costs $0 - local generation.
 * `instructions` (an OpenAI concept) is never sent: the Voice Director's intent
 * reaches the engine as the few inline cues it documents, already in `text`.
 */

interface Finished {
  outputPath: string;
  durationMs: number;
  voiceId: string;
  engine: MindEngineId;
  variant: string;
  speedApplied: "native" | "atempo" | "none";
}

const finished = new Map<string, Finished>();

export class MindVoiceProvider implements VoiceProvider {
  constructor(private readonly config: { baseUrl: string; timeoutMs?: number }) {}

  getName(): string {
    return MIND_PROVIDER;
  }

  async checkStatus(): Promise<ProviderStatus> {
    try {
      await mindHealth(this.config.baseUrl);
      return "connected";
    } catch {
      return "unavailable";
    }
  }

  async estimateCost(): Promise<CostEstimate> {
    return { amount: 0, unit: "per_1k_chars", detail: "Mind Voice chạy tại máy: $0." };
  }

  /** The voice and engine for this line, from what the service lists now. */
  private async resolveVoice(req: VoiceRequest): Promise<{ voiceId: string; engine: MindEngineId }> {
    const voices = await mindVoices(this.config.baseUrl);
    if (req.voiceId && req.voiceId !== MIND_AUTO_VOICE) {
      const known = voices.find((v) => v.id === req.voiceId);
      if (!known) throw new ProviderError(`Mind Voice không có giọng "${req.voiceId}".`, MIND_PROVIDER, false, "mind_voice_not_found");
      return { voiceId: known.id, engine: known.engine };
    }
    const pick = pickMindVoice(voices, req.language ?? "vi");
    if (!pick.ok) throw new ProviderError(pick.message, MIND_PROVIDER, false, `mind_${pick.code.toLowerCase()}`);
    return { voiceId: pick.voice.id, engine: pick.voice.engine };
  }

  async createVoice(req: VoiceRequest): Promise<ProviderJob> {
    if (req.text.trim().length === 0) {
      throw new ProviderError("Không có lời thoại để đọc.", MIND_PROVIDER, false, "empty_text");
    }
    if (fs.existsSync(req.outputPath)) {
      throw new ProviderError(`Đã có tệp âm thanh tại ${req.outputPath}; không ghi đè.`, MIND_PROVIDER, false, "output_exists");
    }
    const started = Date.now();
    const { voiceId, engine } = await this.resolveVoice(req);
    const speed = clampMindSpeed(req.speed);
    const audio = await mindTts(
      this.config.baseUrl,
      { engine, voice: voiceId, text: req.text, language: req.language ?? MIND_ENGINES[engine].language, speed },
      this.config.timeoutMs ?? MIND_GENERATE_TIMEOUT_MS,
    );

    fs.mkdirSync(path.dirname(req.outputPath), { recursive: true });
    // An engine without native speed read at 1x: stretch once, pitch kept.
    const tempo = audio.speedApplied ? null : atempoFilter(speed);
    if (tempo) {
      const raw = `${req.outputPath}.raw.wav`;
      fs.writeFileSync(raw, audio.bytes);
      try {
        await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-i", raw, "-af", tempo, "-c:a", "pcm_s16le", req.outputPath]);
      } finally {
        fs.rmSync(raw, { force: true });
      }
    } else {
      fs.writeFileSync(req.outputPath, audio.bytes);
    }

    const id = `mind_${Buffer.from(req.outputPath).toString("base64url").slice(0, 40)}`;
    finished.set(id, {
      outputPath: req.outputPath,
      durationMs: Date.now() - started,
      voiceId,
      engine,
      variant: audio.variant,
      speedApplied: audio.speedApplied ? "native" : tempo ? "atempo" : "none",
    });
    return { externalId: id, state: "completed", provider: MIND_PROVIDER, model: MIND_MODEL, estimatedCost: 0, sentRequest: { ...audio.body } };
  }

  async getJobStatus(externalId: string): Promise<JobStatus> {
    return finished.has(externalId)
      ? { externalId, state: "completed", progress: 100 }
      : { externalId, state: "failed", progress: 0, error: "Không tìm thấy job giọng nói Mind Voice." };
  }

  async downloadResult(externalId: string): Promise<GeneratedAsset> {
    const done = finished.get(externalId);
    if (!done) throw new ProviderError(`Không tìm thấy job giọng nói ${externalId}.`, MIND_PROVIDER, false, "unknown_job");
    if (!fs.existsSync(done.outputPath)) {
      throw new ProviderError(`Tệp âm thanh đã biến mất: ${done.outputPath}.`, MIND_PROVIDER, false, "missing_file");
    }
    finished.delete(externalId);
    const engine = MIND_ENGINES[done.engine];
    return {
      filePath: done.outputPath,
      bytes: fs.statSync(done.outputPath).size,
      actualCost: 0,
      generationTimeMs: done.durationMs,
      meta: {
        provider: "MIND_VOICE_LOCAL",
        localGeneration: true,
        generationDurationMs: done.durationMs,
        voiceId: done.voiceId,
        engine: done.engine,
        variant: done.variant,
        speed: done.speedApplied,
        license: engine.license,
        attribution: engine.attribution,
        model: MIND_MODEL,
      },
    };
  }

  async listVoices(): Promise<{ id: string; label: string; accent: "US" | "UK"; gender: "male" | "female" }[]> {
    try {
      const voices = await mindVoices(this.config.baseUrl);
      return voices
        .filter((v) => v.installed)
        .map((v) => ({
          id: v.id,
          label: `${mindVoiceLabel(v)} · ${MIND_ENGINES[v.engine].label}`,
          // Not used by local engines; the interface wants one.
          accent: "US" as const,
          gender: v.gender === "female" ? ("female" as const) : ("male" as const),
        }));
    } catch {
      return [];
    }
  }
}

/** Test helper. */
export function clearMindOutputs(): void {
  finished.clear();
}
