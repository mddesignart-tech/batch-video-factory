import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderStatus, Complexity } from "@/domain/enums";
import type { QualityReport } from "@/domain/script";
import type {
  CostEstimate,
  GeneratedAsset,
  ImageProvider,
  ImageRequest,
  JobStatus,
  ProviderJob,
  QualityProvider,
  QualityRequest,
  UpscaleProvider,
  UpscaleRequest,
  VideoProvider,
  VideoRequest,
  VoiceProvider,
  VoiceRequest,
} from "@/providers/types";
import { ProviderError } from "@/providers/types";
import { hashCode, sleep } from "@/lib/utils";
import {
  estimateSpeechDuration,
  writeMockClip,
  writeMockVoice,
  writeSceneCard,
} from "./mock-media";

/**
 * Mock image / video / voice / upscale / quality providers.
 *
 * They model the asynchronous shape of a real vendor: create -> poll -> download.
 * Jobs live in an in-memory map keyed by a fake external id, complete after a
 * short simulated delay, and occasionally fail on purpose (see FAILURE_RATE) so
 * the retry and fallback paths are exercised without spending anything.
 */

interface MockJobRecord {
  externalId: string;
  createdAt: number;
  durationMs: number;
  state: "processing" | "completed" | "failed";
  error?: string;
  produce: () => Promise<GeneratedAsset>;
  cost: number;
}

const jobs = new Map<string, MockJobRecord>();

/**
 * Deterministic simulated failure. Off by default; a batch test can switch it on
 * to prove the retry/fallback machinery works end to end.
 */
export const MOCK_FAILURE_ENV = "MOCK_FAILURE_RATE";

function failureRate(): number {
  const raw = Number(process.env[MOCK_FAILURE_ENV]);
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
}

function shouldFail(key: string): boolean {
  const rate = failureRate();
  if (rate <= 0) return false;
  return (hashCode(key) % 1000) / 1000 < rate;
}

function register(rec: Omit<MockJobRecord, "externalId">): ProviderJob {
  const externalId = `mock_${randomUUID()}`;
  jobs.set(externalId, { ...rec, externalId });
  return {
    externalId,
    state: "processing",
    provider: "mock",
    model: "mock",
    estimatedCost: rec.cost,
  };
}

function statusOf(externalId: string): JobStatus {
  const rec = jobs.get(externalId);
  if (!rec) {
    throw new ProviderError(
      `Không tìm thấy job ${externalId}`,
      "mock",
      false,
      "job_not_found",
    );
  }
  const elapsed = Date.now() - rec.createdAt;
  if (rec.state === "processing" && elapsed >= rec.durationMs) {
    rec.state = rec.error ? "failed" : "completed";
  }
  return {
    externalId,
    state: rec.state,
    progress:
      rec.state === "completed"
        ? 1
        : Math.min(0.99, elapsed / Math.max(1, rec.durationMs)),
    error: rec.error,
  };
}

async function downloadOf(externalId: string): Promise<GeneratedAsset> {
  const rec = jobs.get(externalId);
  if (!rec) {
    throw new ProviderError(
      `Không tìm thấy job ${externalId}`,
      "mock",
      false,
      "job_not_found",
    );
  }
  // Wait out the remaining simulated generation time rather than failing early.
  const remaining = rec.durationMs - (Date.now() - rec.createdAt);
  if (remaining > 0) await sleep(Math.min(remaining, 5000));
  if (rec.error) {
    rec.state = "failed";
    throw new ProviderError(rec.error, "mock", true, "generation_failed");
  }
  rec.state = "completed";
  return rec.produce();
}

/** Test helper - drop all simulated jobs. */
export function resetMockJobs(): void {
  jobs.clear();
}

// ------------------------------------------------------------------ image ---

export class MockImageProvider implements ImageProvider {
  getName(): string {
    return "mock";
  }
  async checkStatus(): Promise<ProviderStatus> {
    return "connected";
  }

  async estimateCost(req: ImageRequest): Promise<CostEstimate> {
    return { amount: 0, unit: "per_image", detail: `Mock image ${req.model}` };
  }

  async createImage(req: ImageRequest): Promise<ProviderJob> {
    const key = `${req.sceneId}:${req.model}:${req.prompt}`;
    const started = Date.now();
    return register({
      createdAt: started,
      durationMs: 200 + (hashCode(key) % 400),
      state: "processing",
      cost: 0,
      error: shouldFail(`img:${key}`)
        ? "Mock image provider timeout"
        : undefined,
      produce: async () => {
        const bytes = writeSceneCard(req.outputPath, {
          sceneNumber: sceneNumberFromPrompt(req.prompt),
          totalScenes: 6,
          caption: req.prompt.slice(0, 110),
          complexity: complexityFromPrompt(req.prompt),
          provider: "mock",
          model: req.model,
          width: req.width,
          height: req.height,
          seed: req.seed ?? hashCode(req.sceneId),
        });
        return {
          filePath: req.outputPath,
          bytes,
          actualCost: 0,
          generationTimeMs: Date.now() - started,
        };
      },
    });
  }

  async getJobStatus(externalId: string): Promise<JobStatus> {
    return statusOf(externalId);
  }
  async downloadResult(externalId: string): Promise<GeneratedAsset> {
    return downloadOf(externalId);
  }
  async cancelJob(externalId: string): Promise<void> {
    jobs.delete(externalId);
  }
}

// ------------------------------------------------------------------ video ---

export class MockVideoProvider implements VideoProvider {
  getName(): string {
    return "mock";
  }
  async checkStatus(): Promise<ProviderStatus> {
    return "connected";
  }

  async estimateCost(req: VideoRequest): Promise<CostEstimate> {
    return {
      amount: 0,
      unit: "per_second",
      detail: `Mock video ${req.model}, ${req.durationSeconds}s`,
    };
  }

  async createVideo(req: VideoRequest): Promise<ProviderJob> {
    const key = `${req.sceneId}:${req.model}`;
    const started = Date.now();
    return register({
      createdAt: started,
      // Longer clips "take longer", like the real thing.
      durationMs: 300 + Math.round(req.durationSeconds * 120),
      state: "processing",
      cost: 0,
      error: shouldFail(`vid:${key}`)
        ? "Mock video provider returned an unusable clip"
        : undefined,
      produce: async () => {
        // Reuse the keyframe when the router chose image-to-video, otherwise
        // draw a fresh card so a text-to-video scene still yields something.
        let still = req.referenceImagePath;
        if (!still || !fs.existsSync(still)) {
          still = path.join(
            path.dirname(req.outputPath),
            `${path.basename(req.outputPath, path.extname(req.outputPath))}_key.png`,
          );
          writeSceneCard(still, {
            sceneNumber: sceneNumberFromPrompt(req.prompt),
            totalScenes: 6,
            caption: req.prompt.slice(0, 110),
            complexity: complexityFromPrompt(req.prompt),
            provider: "mock",
            model: req.model,
            width: req.width,
            height: req.height,
            seed: req.seed ?? hashCode(req.sceneId),
          });
        }
        const produced = await writeMockClip({
          stillPath: still,
          outputPath: req.outputPath,
          durationSeconds: req.durationSeconds,
          width: req.width,
          height: req.height,
          fps: req.fps,
        });
        return {
          filePath: produced,
          bytes: fs.existsSync(produced) ? fs.statSync(produced).size : 0,
          actualCost: 0,
          generationTimeMs: Date.now() - started,
        };
      },
    });
  }

  async getJobStatus(externalId: string): Promise<JobStatus> {
    return statusOf(externalId);
  }
  async downloadResult(externalId: string): Promise<GeneratedAsset> {
    return downloadOf(externalId);
  }
  async cancelJob(externalId: string): Promise<void> {
    jobs.delete(externalId);
  }
}

// ------------------------------------------------------------------ voice ---

export class MockVoiceProvider implements VoiceProvider {
  getName(): string {
    return "mock";
  }
  async checkStatus(): Promise<ProviderStatus> {
    return "connected";
  }

  async estimateCost(req: VoiceRequest): Promise<CostEstimate> {
    return {
      amount: 0,
      unit: "per_1k_chars",
      detail: `Mock voice ${req.voiceId}, ${req.text.length} ký tự`,
    };
  }

  async createVoice(req: VoiceRequest): Promise<ProviderJob> {
    const started = Date.now();
    return register({
      createdAt: started,
      durationMs: 120 + (req.text.length % 200),
      state: "processing",
      cost: 0,
      produce: async () => {
        // Fit the line to the scene: never longer than the slot it plays in.
        const natural = estimateSpeechDuration(req.text, req.speed);
        const duration = Math.min(
          Math.max(0.6, req.targetDuration),
          Math.max(0.6, natural),
        );
        const bytes = writeMockVoice(req.outputPath, {
          text: req.text,
          durationSeconds: duration,
          voiceId: req.voiceId,
        });
        return {
          filePath: req.outputPath,
          bytes,
          actualCost: 0,
          generationTimeMs: Date.now() - started,
          meta: { durationSeconds: Number(duration.toFixed(2)) },
        };
      },
    });
  }

  async getJobStatus(externalId: string): Promise<JobStatus> {
    return statusOf(externalId);
  }
  async downloadResult(externalId: string): Promise<GeneratedAsset> {
    return downloadOf(externalId);
  }

  async listVoices() {
    return [
      { id: "mock-male-us", label: "Max (US, nam)", accent: "US" as const, gender: "male" as const },
      { id: "mock-female-us", label: "Mia (US, nữ)", accent: "US" as const, gender: "female" as const },
      { id: "mock-male-uk", label: "Leo (UK, nam)", accent: "UK" as const, gender: "male" as const },
      { id: "mock-female-uk", label: "Ella (UK, nữ)", accent: "UK" as const, gender: "female" as const },
    ];
  }
}

// ---------------------------------------------------------------- upscale ---

export class MockUpscaleProvider implements UpscaleProvider {
  getName(): string {
    return "mock";
  }
  async checkStatus(): Promise<ProviderStatus> {
    return "connected";
  }
  async estimateCost(): Promise<CostEstimate> {
    return { amount: 0, unit: "per_job", detail: "Mock upscale" };
  }
  async upscale(req: UpscaleRequest): Promise<GeneratedAsset> {
    const started = Date.now();
    await sleep(150);
    // Nothing to actually upscale in mock mode - copy so the path is real.
    fs.mkdirSync(path.dirname(req.outputPath), { recursive: true });
    fs.copyFileSync(req.inputPath, req.outputPath);
    return {
      filePath: req.outputPath,
      bytes: fs.statSync(req.outputPath).size,
      actualCost: 0,
      generationTimeMs: Date.now() - started,
    };
  }
}

// ---------------------------------------------------------------- quality ---

export class MockQualityProvider implements QualityProvider {
  getName(): string {
    return "mock";
  }
  async checkStatus(): Promise<ProviderStatus> {
    return "connected";
  }
  async estimateCost(): Promise<CostEstimate> {
    return { amount: 0, unit: "per_job", detail: "Mock quality evaluation" };
  }

  async evaluate(req: QualityRequest): Promise<QualityReport> {
    await sleep(80);
    const target = req.videoPath ?? req.imagePath ?? req.sceneId;
    const seed = hashCode(target);
    // Deterministic but varied, so the "retry if below threshold" branch in
    // BALANCED / QUALITY mode really does trigger for some scenes.
    const score = (offset: number) => 6 + ((seed >> offset) % 5);
    const missing = target !== req.sceneId && !fs.existsSync(target);
    if (missing) {
      return {
        characterConsistency: 1,
        motionQuality: 1,
        visualArtifacts: 1,
        promptAdherence: 1,
        composition: 1,
        subtitleSafeFraming: 1,
        overallUsability: 1,
        notes: "Không tìm thấy tệp media để đánh giá.",
      };
    }
    return {
      characterConsistency: score(0),
      motionQuality: score(2),
      visualArtifacts: score(4),
      promptAdherence: score(6),
      composition: score(8),
      subtitleSafeFraming: score(10),
      overallUsability: score(12),
      notes: "Mock đánh giá chất lượng (không gọi API).",
    };
  }
}

// ----------------------------------------------------------------- helpers ---

function sceneNumberFromPrompt(prompt: string): number {
  const match = /scene\s*(\d+)/i.exec(prompt);
  return match?.[1] ? Number(match[1]) : 1;
}

function complexityFromPrompt(prompt: string): Complexity {
  if (/two characters|both characters|facepalm|interact/i.test(prompt)) {
    return "HIGH";
  }
  if (/medium shot|reaction/i.test(prompt)) return "MEDIUM";
  return "LOW";
}
