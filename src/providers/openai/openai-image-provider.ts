import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CostEstimate,
  GeneratedAsset,
  ImageProvider,
  ImageRequest,
  JobStatus,
  ProviderJob,
} from "@/providers/types";
import type { ProviderStatus } from "@/domain/enums";
import { ProviderError } from "@/providers/types";
import {
  createImage,
  nearestSize,
  type OpenAIImageConfig,
} from "./openai-image-client";

/**
 * OpenAI image generation, adapted to the job-based ImageProvider interface.
 *
 * The Images API is synchronous - one request, one image, no polling - while
 * the interface is built around the asynchronous video APIs. So the work
 * happens inside createImage and the result is parked in memory under an id
 * that getJobStatus and downloadResult look up. That keeps the pipeline's
 * create/poll/download shape working unchanged for a provider that has no
 * concept of a job.
 *
 * The parked record holds a file already written to disk, not image bytes, so
 * a long queue cannot balloon memory.
 */

interface FinishedImage {
  filePath: string;
  bytes: number;
  actualCost: number;
  generationTimeMs: number;
  meta: Record<string, string | number | boolean>;
}

/**
 * Results waiting to be collected.
 *
 * Module-level rather than per-instance because a provider object is built per
 * call from config; an instance-local map would lose the result immediately.
 */
const finished = new Map<string, FinishedImage>();

export class OpenAIImageProvider implements ImageProvider {
  constructor(private readonly config: OpenAIImageConfig) {}

  getName(): string {
    return this.config.providerName;
  }

  /** Must not perform a paid call, so this only reports whether a key exists. */
  async checkStatus(): Promise<ProviderStatus> {
    return this.config.apiKey.length > 0 ? "connected" : "missing_key";
  }

  async estimateCost(req: ImageRequest): Promise<CostEstimate> {
    return {
      amount: this.config.pricePerImage,
      unit: "per_image",
      detail:
        `${this.config.model} (${this.config.quality}) ` +
        `${nearestSize(req.width, req.height)}`,
    };
  }

  async createImage(req: ImageRequest): Promise<ProviderJob> {
    const externalId = `openai-image-${randomUUID()}`;
    const started = Date.now();

    const result = await createImage(this.config, {
      prompt: req.prompt,
      negativePrompt: req.negativePrompt,
      width: req.width,
      height: req.height,
      referenceImages: req.referenceImages,
      purpose: req.sceneId ? `scene ${req.sceneId}` : "image",
    });

    fs.mkdirSync(path.dirname(req.outputPath), { recursive: true });
    fs.writeFileSync(req.outputPath, result.data);

    finished.set(externalId, {
      filePath: req.outputPath,
      bytes: result.data.byteLength,
      actualCost: actualCostOf(result, this.config),
      generationTimeMs: Date.now() - started,
      meta: {
        size: result.size,
        quality: result.quality,
        usedReferences: result.usedReferences,
        referenceCount: req.referenceImages.length,
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
      },
    });

    return {
      externalId,
      state: "completed",
      provider: this.config.providerName,
      model: this.config.model,
      estimatedCost: this.config.pricePerImage,
    };
  }

  async getJobStatus(externalId: string): Promise<JobStatus> {
    const record = finished.get(externalId);
    return record
      ? { externalId, state: "completed", progress: 100 }
      : {
          externalId,
          state: "failed",
          progress: 0,
          error: "Không tìm thấy kết quả ảnh cho job này.",
        };
  }

  async downloadResult(externalId: string): Promise<GeneratedAsset> {
    const record = finished.get(externalId);
    if (!record) {
      throw new ProviderError(
        "Không tìm thấy kết quả ảnh để lấy về.",
        this.config.providerName,
        false,
        "missing_result",
      );
    }
    // The file is already on disk; hand it over and release the slot so a long
    // batch does not accumulate records for work that is finished.
    finished.delete(externalId);
    return {
      filePath: record.filePath,
      bytes: record.bytes,
      actualCost: record.actualCost,
      generationTimeMs: record.generationTimeMs,
      meta: record.meta,
    };
  }

  async cancelJob(externalId: string): Promise<void> {
    // Nothing to cancel - the call already returned - but dropping the record
    // keeps the map honest.
    finished.delete(externalId);
  }
}

/**
 * What the call really cost.
 *
 * The API bills output tokens, so when it reports them the cost is exact.
 * Falling back to the per-image estimate matters: a response with no usage
 * figures must still be charged something, or spend silently vanishes from the
 * ledger and the cap refunds itself.
 */
export function actualCostOf(
  result: { outputTokens: number | null; inputTokens: number | null },
  config: OpenAIImageConfig,
): number {
  if (config.pricePerMillionOutputTokens > 0 && result.outputTokens !== null) {
    return (
      Math.round(
        (result.outputTokens * config.pricePerMillionOutputTokens) / 1e6 * 1e6,
      ) / 1e6
    );
  }
  return config.pricePerImage;
}

/** Test helper: drop every parked result. */
export function clearFinishedImages(): void {
  finished.clear();
}
