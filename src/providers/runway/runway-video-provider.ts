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
import { logger } from "@/lib/logger";
import { billedVideoSeconds } from "@/domain/video-duration";
import {
  fitVideoPrompt,
  RUNWAY_MAX_PROMPT_CHARS,
} from "@/domain/video-prompt";
import {
  createTask,
  downloadTaskOutput,
  getTask,
  isTerminal,
  nearestDuration,
  toRunwayRatio,
  RUNWAY_API_VERSION,
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

  /** Seconds Runway will charge for, by THIS model's rule. */
  private billedSeconds(seconds: number): number {
    return billedVideoSeconds({
      provider: this.config.providerName,
      model: this.config.model,
      size: this.config.size,
      requestedSeconds: seconds,
      hasKeyframe: true,
    });
  }

  /** Billed at the duration Runway will actually use, not the one requested. */
  private costFor(seconds: number): number {
    const billed = this.billedSeconds(seconds);
    return Math.round(billed * this.config.pricePerSecond * 1e6) / 1e6;
  }

  async estimateCost(req: VideoRequest): Promise<CostEstimate> {
    const billed = this.billedSeconds(req.durationSeconds);
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

    // Runway caps promptText at 1000 characters. Fit it BEFORE the request so
    // the outcome is a logged rewrite rather than a 400 on the paid path. The
    // movement description is preserved verbatim - only the trailing
    // constraint boilerplate is compacted - so the clip still benchmarks the
    // same motion as every other vendor.
    const fitted = fitVideoPrompt(req.prompt, RUNWAY_MAX_PROMPT_CHARS);
    if (fitted.changed) {
      await logger.warn({
        event: "provider.prompt_compacted",
        provider: this.config.providerName,
        model: this.config.model,
        projectId: req.projectId,
        sceneId: req.sceneId,
        message: `Prompt ${fitted.note}`,
      });
    }

    const prepared = prepareKeyframe(req.referenceImagePath, this.config.size);
    try {
      const task = await createTask(this.config, {
        prompt: fitted.text,
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
        // The real request, minus the key and the base64 image. Recorded so a
        // vendor-side failure can be investigated against what was sent rather
        // than what was intended.
        sentRequest: {
          endpoint: `${this.config.baseUrl.replace(/\/+$/, "")}/image_to_video`,
          apiVersion: RUNWAY_API_VERSION,
          model: this.config.model,
          ratio: toRunwayRatio(this.config.size),
          size: this.config.size,
          durationRequested: req.durationSeconds,
          durationSent: nearestDuration(req.durationSeconds),
          promptTextLength: fitted.text.length,
          promptTextBytes: Buffer.byteLength(fitted.text, "utf8"),
          promptText: fitted.text,
          promptCompacted: fitted.changed,
          keyframeBytes: fs.existsSync(prepared.path)
            ? fs.statSync(prepared.path).size
            : 0,
          keyframeMime: "image/png",
        },
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
