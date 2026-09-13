import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
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
import { logger } from "@/lib/logger";
import { FFMPEG_MISSING_MESSAGE, resolveFfmpeg } from "@/media/ffmpeg";
import {
  createVideo,
  downloadVideo,
  getVideoJob,
  isTerminal,
  type OpenAIVideoConfig,
} from "./openai-video-client";
import { parseSize } from "../video-config";

/**
 * OpenAI video generation (Sora), behind the job-based VideoProvider interface.
 *
 * This one really is asynchronous, so the interface fits: createVideo submits
 * and returns immediately, getJobStatus polls, downloadResult collects. The job
 * id lives in the database between those calls, which is what lets a crashed or
 * timed-out run resume an already-paid job instead of buying a second one.
 */

/**
 * Where each submitted job should be written, and what it cost.
 *
 * The cost is carried here because the API bills at CREATION by duration, but
 * the pipeline records cost at DOWNLOAD. Returning 0 from downloadResult - as
 * this did at first - made a real $0.40 charge vanish from the ledger and let
 * the spend cap refund itself, the same hole that had to be closed for text.
 */
const outputs = new Map<
  string,
  { outputPath: string; startedAt: number; actualCost: number }
>();

export class OpenAIVideoProvider implements VideoProvider {
  constructor(private readonly config: OpenAIVideoConfig) {}

  getName(): string {
    return this.config.providerName;
  }

  /** Must not perform a paid call, so this only reports whether a key exists. */
  async checkStatus(): Promise<ProviderStatus> {
    return this.config.apiKey.length > 0 ? "connected" : "missing_key";
  }

  /** Dollars for a clip of this length, at the registry's price per second. */
  private costFor(seconds: number): number {
    return Math.round(seconds * this.config.pricePerSecond * 1e6) / 1e6;
  }

  async estimateCost(req: VideoRequest): Promise<CostEstimate> {
    const amount = this.costFor(req.durationSeconds);
    return {
      amount,
      unit: "per_second",
      detail:
        `${this.config.model} ${this.config.size}, ${req.durationSeconds}s ` +
        `x $${this.config.pricePerSecond}/s`,
    };
  }

  async createVideo(req: VideoRequest): Promise<ProviderJob> {
    // The API requires the first-frame image to match the output size exactly,
    // so the keyframe is resized here rather than sent as-is and rejected.
    let reference: string | undefined;
    let temporary: string | undefined;
    if (req.referenceImagePath) {
      const prepared = prepareKeyframe(req.referenceImagePath, this.config.size);
      reference = prepared.path;
      if (prepared.temporary) temporary = prepared.path;
    }

    try {
      const job = await createVideo(this.config, {
        prompt: req.prompt,
        seconds: req.durationSeconds,
        inputReferencePath: reference,
      });

      outputs.set(job.id, {
        outputPath: req.outputPath,
        startedAt: Date.now(),
        actualCost: this.costFor(req.durationSeconds),
      });

      return {
        externalId: job.id,
        state: job.status === "queued" ? "pending" : "processing",
        provider: this.config.providerName,
        model: this.config.model,
        estimatedCost: this.costFor(req.durationSeconds),
      };
    } finally {
      if (temporary && fs.existsSync(temporary)) {
        try {
          fs.unlinkSync(temporary);
        } catch {
          // A stranded temp file is not worth failing a paid job over.
        }
      }
    }
  }

  async getJobStatus(externalId: string): Promise<JobStatus> {
    const job = await getVideoJob(this.config, externalId);
    const terminal = isTerminal(job.status);
    return {
      externalId,
      state:
        terminal === "ok"
          ? "completed"
          : terminal === "failed"
            ? "failed"
            : "processing",
      progress: job.progress,
      error: job.error,
    };
  }

  async downloadResult(externalId: string): Promise<GeneratedAsset> {
    const record = outputs.get(externalId);
    if (!record) {
      throw new ProviderError(
        `Không biết ghi video ${externalId} vào đâu. Job này được tạo ở lần ` +
          `chạy khác - hãy tải về bằng đường dẫn đích rõ ràng.`,
        this.config.providerName,
        false,
        "unknown_output_path",
      );
    }
    const bytes = await this.downloadTo(externalId, record.outputPath);
    outputs.delete(externalId);
    return {
      filePath: record.outputPath,
      bytes,
      // Billed at creation by duration; reported here because this is where the
      // pipeline records cost. Zero would lose the charge entirely.
      actualCost: record.actualCost,
      generationTimeMs: Date.now() - record.startedAt,
      meta: { size: this.config.size, model: this.config.model },
    };
  }

  /** Collect a job whose destination is known to the caller, not to this map. */
  async downloadTo(externalId: string, outputPath: string): Promise<number> {
    const bytes = await downloadVideo(this.config, externalId, outputPath);
    await logger.info({
      event: "provider.video_downloaded",
      provider: this.config.providerName,
      model: this.config.model,
      message: `Đã tải video ${externalId}: ${Math.round(bytes / 1024)} KB`,
    });
    return bytes;
  }

  async cancelJob(externalId: string): Promise<void> {
    outputs.delete(externalId);
  }
}

/**
 * Make a keyframe match the video's exact output size.
 *
 * Uses the same scale-to-cover-then-centre-crop as the final render, so what
 * the video is built from is exactly what the storyboard's 9:16 overlay showed
 * the operator. An image that is already the right size is passed through
 * untouched rather than re-encoded.
 */
export function prepareKeyframe(
  sourcePath: string,
  size: string,
): { path: string; temporary: boolean } {
  const { width, height } = parseSize(size);
  const target = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "keyframe-")),
    `frame-${width}x${height}.png`,
  );

  const binary = resolveFfmpeg();
  if (!binary) throw new Error(FFMPEG_MISSING_MESSAGE);

  execFileSync(
    binary,
    [
      "-v",
      "error",
      "-i",
      sourcePath,
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
      "-frames:v",
      "1",
      "-y",
      target,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  return { path: target, temporary: true };
}

/** Test helper: forget every pending output path. */
export function clearVideoOutputs(): void {
  outputs.clear();
}
