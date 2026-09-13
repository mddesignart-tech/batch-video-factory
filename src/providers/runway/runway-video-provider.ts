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
  createTask,
  downloadTaskOutput,
  getTask,
  isTerminal,
  nearestDuration,
} from "./runway-video-client";

/**
 * Runway video generation, behind the job-based VideoProvider interface.
 *
 * The one behaviour worth calling out is the duration: Runway sells 5- and
 * 10-second clips, so a 4-second scene is billed as 5. The estimate reflects
 * what will actually be charged rather than what was asked for - an estimate
 * that quoted 4 seconds would be wrong by 25% every single time.
 */

const outputs = new Map<
  string,
  { outputPath: string; startedAt: number; actualCost: number }
>();

export class RunwayVideoProvider implements VideoProvider {
  constructor(private readonly config: VideoModelConfig) {}

  getName(): string {
    return this.config.providerName;
  }

  async checkStatus(): Promise<ProviderStatus> {
    return this.config.apiKey.length > 0 ? "connected" : "missing_key";
  }

  /** Billed at the duration Runway will actually use, not the one requested. */
  private costFor(seconds: number): number {
    const billed = nearestDuration(seconds);
    return Math.round(billed * this.config.pricePerSecond * 1e6) / 1e6;
  }

  async estimateCost(req: VideoRequest): Promise<CostEstimate> {
    const billed = nearestDuration(req.durationSeconds);
    return {
      amount: this.costFor(req.durationSeconds),
      unit: "per_second",
      detail:
        `${this.config.model} ${this.config.size}, ` +
        (billed === req.durationSeconds
          ? `${billed}s`
          : `yêu cầu ${req.durationSeconds}s nhưng tính tiền ${billed}s`) +
        ` x $${this.config.pricePerSecond}/s`,
    };
  }

  async createVideo(req: VideoRequest): Promise<ProviderJob> {
    if (!req.referenceImagePath) {
      // Runway's image_to_video endpoint has no text-only mode, so this is a
      // clear refusal rather than a request the API would reject for us.
      throw new ProviderError(
        "Runway image_to_video bắt buộc phải có ảnh keyframe.",
        this.config.providerName,
        false,
        "keyframe_required",
      );
    }

    const prepared = prepareKeyframe(req.referenceImagePath, this.config.size);
    try {
      const task = await createTask(this.config, {
        prompt: req.prompt,
        seconds: req.durationSeconds,
        keyframePath: prepared.path,
      });

      outputs.set(task.id, {
        outputPath: req.outputPath,
        startedAt: Date.now(),
        actualCost: this.costFor(req.durationSeconds),
      });

      return {
        externalId: task.id,
        state: "pending",
        provider: this.config.providerName,
        model: this.config.model,
        estimatedCost: this.costFor(req.durationSeconds),
      };
    } finally {
      if (prepared.temporary && fs.existsSync(prepared.path)) {
        try {
          fs.unlinkSync(prepared.path);
        } catch {
          // A stranded temp file is not worth failing a paid job over.
        }
      }
    }
  }

  async getJobStatus(externalId: string): Promise<JobStatus> {
    const task = await getTask(this.config, externalId);
    const terminal = isTerminal(task.status);
    return {
      externalId,
      state:
        terminal === "ok"
          ? "completed"
          : terminal === "failed"
            ? "failed"
            : "processing",
      progress: task.progress,
      error: task.error,
    };
  }

  async downloadResult(externalId: string): Promise<GeneratedAsset> {
    const record = outputs.get(externalId);
    if (!record) {
      throw new ProviderError(
        `Không biết ghi video ${externalId} vào đâu. Task này được tạo ở lần chạy khác.`,
        this.config.providerName,
        false,
        "unknown_output_path",
      );
    }

    const task = await getTask(this.config, externalId);
    if (!task.outputUrl) {
      throw new ProviderError(
        `Task ${externalId} chưa có tệp kết quả (trạng thái ${task.status}).`,
        this.config.providerName,
        true,
        "result_not_ready",
      );
    }

    const bytes = await downloadTaskOutput(
      this.config,
      task.outputUrl,
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
export function clearRunwayOutputs(): void {
  outputs.clear();
}
