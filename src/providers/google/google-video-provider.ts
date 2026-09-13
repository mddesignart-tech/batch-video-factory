import fs from "node:fs";
import type {
  CostEstimate,
  GeneratedAsset,
  JobStatus,
  ProviderJob,
  VideoProvider,
  VideoRequest,
} from "@/providers/types";
import { ProviderError } from "@/providers/types";
import type { ProviderStatus } from "@/domain/enums";
import { prepareKeyframe } from "@/providers/openai/openai-video-provider";
import type { VideoModelConfig } from "@/providers/video-config";
import {
  createOperation,
  downloadVideoFile,
  forcedToEightSeconds,
  getOperation,
  nearestDuration,
} from "./google-video-client";

/**
 * Google Veo video generation, behind the job-based VideoProvider interface.
 *
 * The behaviour that shapes this adapter is Veo's duration rule: 1080p and
 * reference-image generations are forced to 8 seconds. A 4-second scene with a
 * keyframe therefore costs twice what a naive "4 x price" estimate would say,
 * so the estimate applies the rule up front instead of discovering it on the
 * invoice.
 */

const outputs = new Map<
  string,
  { outputPath: string; startedAt: number; actualCost: number }
>();

export class GoogleVideoProvider implements VideoProvider {
  constructor(private readonly config: VideoModelConfig) {}

  getName(): string {
    return this.config.providerName;
  }

  async checkStatus(): Promise<ProviderStatus> {
    return this.config.apiKey.length > 0 ? "connected" : "missing_key";
  }

  /** Seconds Veo will actually bill for this request. */
  private billedSeconds(seconds: number, hasKeyframe: boolean): number {
    if (forcedToEightSeconds(this.config.size, hasKeyframe)) return 8;
    return nearestDuration(seconds);
  }

  private costFor(seconds: number, hasKeyframe: boolean): number {
    const billed = this.billedSeconds(seconds, hasKeyframe);
    return Math.round(billed * this.config.pricePerSecond * 1e6) / 1e6;
  }

  async estimateCost(req: VideoRequest): Promise<CostEstimate> {
    const hasKeyframe = Boolean(req.referenceImagePath);
    const billed = this.billedSeconds(req.durationSeconds, hasKeyframe);
    return {
      amount: this.costFor(req.durationSeconds, hasKeyframe),
      unit: "per_second",
      detail:
        `${this.config.model} ${this.config.size}, ` +
        (billed === req.durationSeconds
          ? `${billed}s`
          : `yêu cầu ${req.durationSeconds}s nhưng bị ép thành ${billed}s ` +
            `(ảnh keyframe hoặc độ phân giải cao)`) +
        ` x $${this.config.pricePerSecond}/s`,
    };
  }

  async createVideo(req: VideoRequest): Promise<ProviderJob> {
    const hasKeyframe = Boolean(req.referenceImagePath);
    const prepared = hasKeyframe
      ? prepareKeyframe(req.referenceImagePath as string, this.config.size)
      : null;

    try {
      const operation = await createOperation(this.config, {
        prompt: req.prompt,
        seconds: this.billedSeconds(req.durationSeconds, hasKeyframe),
        keyframePath: prepared?.path,
      });

      outputs.set(operation.name, {
        outputPath: req.outputPath,
        startedAt: Date.now(),
        actualCost: this.costFor(req.durationSeconds, hasKeyframe),
      });

      return {
        externalId: operation.name,
        state: "pending",
        provider: this.config.providerName,
        model: this.config.model,
        estimatedCost: this.costFor(req.durationSeconds, hasKeyframe),
      };
    } finally {
      if (prepared?.temporary && fs.existsSync(prepared.path)) {
        try {
          fs.unlinkSync(prepared.path);
        } catch {
          // A stranded temp file is not worth failing a paid job over.
        }
      }
    }
  }

  async getJobStatus(externalId: string): Promise<JobStatus> {
    const operation = await getOperation(this.config, externalId);
    return {
      externalId,
      state: operation.error
        ? "failed"
        : operation.done
          ? "completed"
          : "processing",
      progress: operation.progress,
      error: operation.error,
    };
  }

  async downloadResult(externalId: string): Promise<GeneratedAsset> {
    const record = outputs.get(externalId);
    if (!record) {
      throw new ProviderError(
        `Không biết ghi video ${externalId} vào đâu. Operation này được tạo ở lần chạy khác.`,
        this.config.providerName,
        false,
        "unknown_output_path",
      );
    }

    const operation = await getOperation(this.config, externalId);
    if (!operation.videoUri) {
      throw new ProviderError(
        `Operation ${externalId} chưa có tệp kết quả (done=${operation.done}).`,
        this.config.providerName,
        true,
        "result_not_ready",
      );
    }

    const bytes = await downloadVideoFile(
      this.config,
      operation.videoUri,
      record.outputPath,
    );
    outputs.delete(externalId);

    return {
      filePath: record.outputPath,
      bytes,
      actualCost: record.actualCost,
      generationTimeMs: Date.now() - record.startedAt,
      meta: { size: this.config.size, model: this.config.model },
    };
  }

  async cancelJob(externalId: string): Promise<void> {
    outputs.delete(externalId);
  }
}

/** Test helper: forget every pending output path. */
export function clearGoogleOutputs(): void {
  outputs.clear();
}
