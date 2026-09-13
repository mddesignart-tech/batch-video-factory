import fs from "node:fs";
import path from "node:path";
import type { ModelRegistry, Project, Scene } from "@prisma/client";
import type { AssetKind, ModelType, QualityMode, RouterStrategy } from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { sha256 } from "@/lib/crypto";
import { projectSubdir, toRelative, uuidFilename } from "@/lib/paths";
import { parseJson, round, sleep } from "@/lib/utils";
import {
  getImageProvider,
  getQualityProvider,
  getVideoProvider,
  getVoiceProvider,
} from "@/providers/registry";
import {
  ProviderError,
  type GeneratedAsset,
  type JobStatus,
} from "@/providers/types";
import { routeScene, RoutingError, type RouteDecision } from "./ai-router";
import {
  shouldEvaluateQuality,
  shouldGenerateKeyframe,
} from "./cost-estimator";
import { recordCost, spentOnProject } from "./cost-tracker";
import { availableProviderNames } from "./provider-health";
import { targetForAspect } from "@/media/render";
import { overallQualityScore, QualityReportSchema } from "@/domain/script";

/**
 * Scene media generation.
 *
 * The rule that shapes this whole file: **never pay twice for the same work.**
 * Before any generation call we compute a deterministic idempotency key and look
 * for an existing ProviderJob. If one is still processing we attach to it and
 * poll; if one already completed we reuse its output. A retry after a timeout is
 * therefore free, and a fallback to a second provider only happens once we know
 * the first job is genuinely dead.
 */

export const RETRY_BACKOFF_MS = [10_000, 30_000, 90_000] as const;
export const DEFAULT_MAX_RETRIES = 3;

export function backoffFor(attempt: number): number {
  const index = Math.min(attempt, RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[index] ?? 90_000;
}

export class GenerationError extends Error {
  constructor(
    message: string,
    readonly stage: AssetKind | "quality",
    readonly provider: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GenerationError";
  }
}

interface SceneContext {
  scene: Scene;
  project: Project;
  models: ModelRegistry[];
  availableProviders: string[];
  budgetRemaining: number;
}

async function loadContext(sceneId: string): Promise<SceneContext> {
  const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
  if (!scene) throw new Error(`Không tìm thấy cảnh ${sceneId}`);
  const project = await prisma.project.findUnique({
    where: { id: scene.projectId },
  });
  if (!project) throw new Error(`Không tìm thấy dự án ${scene.projectId}`);

  const [models, availableProviders, spent] = await Promise.all([
    prisma.modelRegistry.findMany({ where: { enabled: true } }),
    availableProviderNames(),
    spentOnProject(project.id),
  ]);

  return {
    scene,
    project,
    models,
    availableProviders,
    budgetRemaining: Math.max(0, round(project.maxBudget - spent)),
  };
}

function routeFor(
  ctx: SceneContext,
  type: ModelType,
  usage: { seconds?: number; images?: number; characters?: number; jobs?: number },
  manual: { provider?: string | null; model?: string | null },
): RouteDecision {
  const { scene, project } = ctx;
  const characterCount = parseJson<string[]>(scene.characterIdsJson, []).length || 1;
  return routeScene(ctx.models, {
    type,
    qualityMode: project.qualityMode as QualityMode,
    strategy: scene.routingMode as RouterStrategy,
    complexity: scene.complexity as "LOW" | "MEDIUM" | "HIGH",
    spendPriority: scene.spendPriority as "LOW" | "NORMAL" | "HIGH",
    durationSeconds: scene.duration,
    characterCount,
    consistencyRequired: type === "image" || type === "video",
    needs1080p: type === "video",
    needsReferenceImage:
      type === "video" &&
      shouldGenerateKeyframe(
        project.qualityMode as QualityMode,
        scene.complexity as "LOW" | "MEDIUM" | "HIGH",
        characterCount,
      ),
    budgetRemaining: ctx.budgetRemaining,
    usage,
    availableProviders: ctx.availableProviders,
    manualProvider: manual.provider ?? null,
    manualModel: manual.model ?? null,
  });
}

/**
 * Deterministic per-request key.
 *
 * `generation` is the scene's retry counter: a transient failure reuses the same
 * key (so we resume the in-flight vendor job), while an explicit "regenerate"
 * from the operator bumps the counter and legitimately buys a new one.
 */
export function idempotencyKey(opts: {
  sceneId: string;
  kind: string;
  provider: string;
  model: string;
  prompt: string;
  generation: number;
}): string {
  return sha256(
    [
      opts.sceneId,
      opts.kind,
      opts.provider,
      opts.model,
      sha256(opts.prompt),
      String(opts.generation),
    ].join("|"),
  );
}

interface RunOptions {
  ctx: SceneContext;
  kind: AssetKind | "quality";
  decision: RouteDecision;
  prompt: string;
  outputPath: string;
  create: () => Promise<{ externalId: string }>;
  poll: (externalId: string) => Promise<JobStatus>;
  download: (externalId: string) => Promise<GeneratedAsset>;
}

/**
 * Create-or-resume, then poll to completion and download.
 *
 * This is the only place in the app that is allowed to start a paid generation.
 */
async function runProviderJob(opts: RunOptions): Promise<GeneratedAsset> {
  const { ctx, kind, decision, prompt, create, poll, download } = opts;
  const key = idempotencyKey({
    sceneId: ctx.scene.id,
    kind,
    provider: decision.provider,
    model: decision.modelId,
    prompt,
    generation: ctx.scene.retryCount,
  });

  const existing = await prisma.providerJob.findUnique({
    where: { idempotencyKey: key },
  });

  // Already paid for and finished - hand back the file, charge nothing.
  if (existing?.status === "completed" && existing.externalId) {
    const stored = parseJson<{ filePath?: string }>(existing.responseJson, {});
    if (stored.filePath && fs.existsSync(stored.filePath)) {
      await logger.info({
        event: "provider.job.reused",
        provider: decision.provider,
        model: decision.modelId,
        projectId: ctx.project.id,
        sceneId: ctx.scene.id,
        message: `Tái sử dụng kết quả ${kind} đã có, không tạo lại.`,
      });
      return {
        filePath: stored.filePath,
        bytes: fs.existsSync(stored.filePath)
          ? fs.statSync(stored.filePath).size
          : 0,
        actualCost: 0,
        generationTimeMs: 0,
      };
    }
  }

  let externalId: string;
  let record = existing;

  if (
    existing &&
    (existing.status === "pending" || existing.status === "processing") &&
    existing.externalId
  ) {
    // A previous attempt may still be running on the vendor's side. Attaching to
    // it is the difference between one charge and two.
    externalId = existing.externalId;
    await logger.warn({
      event: "provider.job.resumed",
      provider: decision.provider,
      model: decision.modelId,
      projectId: ctx.project.id,
      sceneId: ctx.scene.id,
      message: `Job ${kind} trước đó vẫn đang chạy, tiếp tục theo dõi thay vì tạo mới.`,
    });
  } else {
    const created = await create();
    externalId = created.externalId;
    record = await prisma.providerJob.upsert({
      where: { idempotencyKey: key },
      create: {
        provider: decision.provider,
        model: decision.modelId,
        kind,
        externalId,
        idempotencyKey: key,
        status: "processing",
        requestJson: JSON.stringify({ prompt: prompt.slice(0, 2000) }),
        projectId: ctx.project.id,
        sceneId: ctx.scene.id,
        attempts: (existing?.attempts ?? 0) + 1,
        estimatedCost: decision.estimatedCost,
      },
      update: {
        externalId,
        status: "processing",
        attempts: { increment: 1 },
        error: null,
      },
    });
  }

  try {
    // Poll with a ceiling so a stuck vendor job cannot wedge the worker forever.
    const deadline = Date.now() + 10 * 60 * 1000;
    let status = await poll(externalId);
    while (
      (status.state === "pending" || status.state === "processing") &&
      Date.now() < deadline
    ) {
      await sleep(750);
      status = await poll(externalId);
    }
    if (status.state === "failed") {
      throw new ProviderError(
        status.error ?? `Nhà cung cấp báo lỗi khi tạo ${kind}.`,
        decision.provider,
        true,
        "generation_failed",
      );
    }
    if (status.state !== "completed") {
      throw new ProviderError(
        `Job ${kind} quá thời gian chờ.`,
        decision.provider,
        true,
        "timeout",
      );
    }

    const asset = await download(externalId);
    await prisma.providerJob.update({
      where: { idempotencyKey: key },
      data: {
        status: "completed",
        completedAt: new Date(),
        actualCost: asset.actualCost,
        responseJson: JSON.stringify({
          filePath: asset.filePath,
          bytes: asset.bytes,
        }),
      },
    });
    return asset;
  } catch (err) {
    await prisma.providerJob.update({
      where: { idempotencyKey: key },
      data: {
        status: "failed",
        error: err instanceof Error ? err.message.slice(0, 500) : String(err),
      },
    });
    void record;
    throw err;
  }
}

/**
 * Try the routed model, then its fallbacks in order.
 *
 * A fallback is only attempted for a retryable failure. A non-retryable one
 * (unimplemented provider, bad request) fails fast rather than burning through
 * every provider with the same broken input.
 */
async function withFallback<T>(
  ctx: SceneContext,
  decision: RouteDecision,
  attempt: (d: RouteDecision) => Promise<T>,
): Promise<{ result: T; used: RouteDecision }> {
  const chain: RouteDecision[] = [
    decision,
    ...decision.fallbacks.map((f) => ({
      ...decision,
      provider: f.provider,
      modelId: f.modelId,
      displayName: f.displayName,
      estimatedCost: f.estimatedCost,
      quality: f.quality,
      reason: `Dự phòng sau khi ${decision.provider}/${decision.modelId} thất bại`,
      fallbacks: [],
    })),
  ];

  let lastError: unknown;
  for (const candidate of chain) {
    try {
      return { result: await attempt(candidate), used: candidate };
    } catch (err) {
      lastError = err;
      const retryable = !(err instanceof ProviderError) || err.retryable;
      await logger.warn({
        event: "provider.fallback",
        provider: candidate.provider,
        model: candidate.modelId,
        projectId: ctx.project.id,
        sceneId: ctx.scene.id,
        message:
          err instanceof Error ? err.message : "Lỗi không xác định từ nhà cung cấp",
      });
      if (!retryable) break;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Tất cả nhà cung cấp đều thất bại.");
}

async function saveAsset(opts: {
  ctx: SceneContext;
  kind: AssetKind;
  decision: RouteDecision;
  prompt: string;
  asset: GeneratedAsset;
}): Promise<void> {
  const { ctx, kind, decision, prompt, asset } = opts;
  await prisma.asset.create({
    data: {
      projectId: ctx.project.id,
      sceneId: ctx.scene.id,
      kind,
      provider: decision.provider,
      model: decision.modelId,
      prompt: prompt.slice(0, 4000),
      status: "completed",
      generationTimeMs: asset.generationTimeMs,
      estimatedCost: decision.estimatedCost,
      actualCost: asset.actualCost,
      filePath: toRelative(asset.filePath),
      bytes: asset.bytes,
    },
  });
  await recordCost({
    projectId: ctx.project.id,
    batchId: ctx.project.batchId,
    sceneId: ctx.scene.id,
    category: kind === "audio" ? "voice" : (kind as "image" | "video"),
    provider: decision.provider,
    model: decision.modelId,
    amount: asset.actualCost,
    isRetry: ctx.scene.retryCount > 0,
  });
}

// ------------------------------------------------------------------ image ---

export async function generateSceneImage(sceneId: string): Promise<string | null> {
  const ctx = await loadContext(sceneId);
  const { scene, project } = ctx;

  const characterCount =
    parseJson<string[]>(scene.characterIdsJson, []).length || 1;
  if (
    !shouldGenerateKeyframe(
      project.qualityMode as QualityMode,
      scene.complexity as "LOW" | "MEDIUM" | "HIGH",
      characterCount,
    )
  ) {
    return null; // deliberately skipped in ECONOMY for simple scenes
  }

  const decision = routeFor(ctx, "image", { images: 1, jobs: 1 }, {
    provider: scene.imageProvider,
    model: scene.imageModel,
  });
  const target = targetForAspect(project.aspectRatio);
  const outputPath = path.join(
    projectSubdir(project.id, "images"),
    uuidFilename(".png"),
  );

  const { result, used } = await withFallback(ctx, decision, async (d) => {
    const provider = getImageProvider(d.provider);
    return runProviderJob({
      ctx,
      kind: "image",
      decision: d,
      prompt: scene.imagePrompt,
      outputPath,
      create: async () =>
        provider.createImage({
          projectId: project.id,
          sceneId: scene.id,
          model: d.modelId,
          prompt: scene.imagePrompt,
          negativePrompt: "",
          width: target.width,
          height: target.height,
          seed: undefined,
          referenceImages: [],
          outputPath,
        }),
      poll: (id) => provider.getJobStatus(id),
      download: (id) => provider.downloadResult(id),
    });
  });

  await saveAsset({ ctx, kind: "image", decision: used, prompt: scene.imagePrompt, asset: result });
  await prisma.scene.update({
    where: { id: scene.id },
    data: {
      imagePath: toRelative(result.filePath),
      imageProvider: used.provider,
      imageModel: used.modelId,
      status: "image_ready",
      errorMessage: null,
    },
  });
  return result.filePath;
}

// ------------------------------------------------------------------ video ---

export async function generateSceneVideo(sceneId: string): Promise<string> {
  const ctx = await loadContext(sceneId);
  const { scene, project } = ctx;

  const decision = routeFor(
    ctx,
    "video",
    { seconds: scene.duration, jobs: 1 },
    { provider: scene.videoProvider, model: scene.videoModel },
  );
  const target = targetForAspect(project.aspectRatio);
  const outputPath = path.join(
    projectSubdir(project.id, "videos"),
    uuidFilename(".mp4"),
  );
  const keyframe = scene.imagePath
    ? path.join(projectSubdir(project.id, "images"), path.basename(scene.imagePath))
    : undefined;

  const { result, used } = await withFallback(ctx, decision, async (d) => {
    const provider = getVideoProvider(d.provider);
    return runProviderJob({
      ctx,
      kind: "video",
      decision: d,
      prompt: scene.videoPrompt,
      outputPath,
      create: async () =>
        provider.createVideo({
          projectId: project.id,
          sceneId: scene.id,
          model: d.modelId,
          prompt: scene.videoPrompt,
          negativePrompt: "",
          durationSeconds: scene.duration,
          width: target.width,
          height: target.height,
          fps: target.fps,
          referenceImagePath: keyframe,
          outputPath,
        }),
      poll: (id) => provider.getJobStatus(id),
      download: (id) => provider.downloadResult(id),
    });
  });

  await saveAsset({ ctx, kind: "video", decision: used, prompt: scene.videoPrompt, asset: result });
  await prisma.scene.update({
    where: { id: scene.id },
    data: {
      videoPath: toRelative(result.filePath),
      videoProvider: used.provider,
      videoModel: used.modelId,
      status: "video_ready",
      errorMessage: null,
    },
  });
  return result.filePath;
}

// ------------------------------------------------------------------ voice ---

export function speechTextFor(scene: Pick<Scene, "dialogue" | "narration">): string {
  // Dialogue carries the comedy; narration is the fallback when a beat has none.
  const dialogue = stripSpeakerLabel(scene.dialogue.trim());
  const narration = scene.narration.trim();
  return dialogue.length > 0 ? dialogue : narration;
}

function stripSpeakerLabel(line: string): string {
  return line.replace(/^[A-Za-z ]{1,20}:\s*/, "").replace(/^"|"$/g, "");
}

export async function generateSceneVoice(sceneId: string): Promise<string | null> {
  const ctx = await loadContext(sceneId);
  const { scene, project } = ctx;

  const text = speechTextFor(scene);
  if (text.length === 0) return null;

  const decision = routeFor(
    ctx,
    "voice",
    { characters: text.length, jobs: 1 },
    { provider: scene.voiceProvider, model: scene.voiceModel },
  );

  const characterIds = parseJson<string[]>(scene.characterIdsJson, []);
  const character = characterIds[0]
    ? await prisma.character.findFirst({ where: { name: characterIds[0] } })
    : null;

  const outputPath = path.join(
    projectSubdir(project.id, "audio"),
    uuidFilename(".wav"),
  );

  const { result, used } = await withFallback(ctx, decision, async (d) => {
    const provider = getVoiceProvider(d.provider);
    return runProviderJob({
      ctx,
      kind: "audio",
      decision: d,
      prompt: text,
      outputPath,
      create: async () =>
        provider.createVoice({
          projectId: project.id,
          sceneId: scene.id,
          model: d.modelId,
          text,
          voiceId: character?.voiceId ?? "mock-male-us",
          accent: "US",
          gender: "male",
          speed: 1,
          targetDuration: scene.duration,
          outputPath,
        }),
      poll: (id) => provider.getJobStatus(id),
      download: (id) => provider.downloadResult(id),
    });
  });

  await saveAsset({ ctx, kind: "audio", decision: used, prompt: text, asset: result });
  await prisma.scene.update({
    where: { id: scene.id },
    data: {
      audioPath: toRelative(result.filePath),
      voiceProvider: used.provider,
      voiceModel: used.modelId,
      status: "audio_ready",
    },
  });
  return result.filePath;
}

// ---------------------------------------------------------------- quality ---

/** Score threshold below which a scene is regenerated, per mode. */
export const QUALITY_THRESHOLD: Record<QualityMode, number> = {
  ECONOMY: 3, // only genuinely unusable output is redone
  BALANCED: 6,
  QUALITY: 7.5,
  CUSTOM: 6,
};

export interface QualityOutcome {
  score: number;
  shouldRetry: boolean;
  reason: string;
}

export async function evaluateScene(sceneId: string): Promise<QualityOutcome | null> {
  const ctx = await loadContext(sceneId);
  const { scene, project } = ctx;
  const mode = project.qualityMode as QualityMode;

  if (!shouldEvaluateQuality(mode, scene.spendPriority as "LOW" | "NORMAL" | "HIGH")) {
    return null;
  }

  let decision: RouteDecision;
  try {
    decision = routeFor(ctx, "quality", { jobs: 1 }, { provider: null, model: null });
  } catch (err) {
    // No quality model configured is not a pipeline failure - just skip.
    if (err instanceof RoutingError) return null;
    throw err;
  }

  const provider = getQualityProvider(decision.provider);
  const videoPath = scene.videoPath
    ? path.join(projectSubdir(project.id, "videos"), path.basename(scene.videoPath))
    : undefined;

  const report = QualityReportSchema.parse(
    await provider.evaluate({
      projectId: project.id,
      sceneId: scene.id,
      model: decision.modelId,
      videoPath,
      prompt: scene.videoPrompt,
      expectedCharacters: parseJson<string[]>(scene.characterIdsJson, []),
    }),
  );

  // Charge what the provider says it charged, not what the registry predicted -
  // the same rule the image/video/voice stages follow. Keeping one stage on
  // estimates would make the cost ledger disagree with itself.
  const charged = await provider.estimateCost({
    projectId: project.id,
    sceneId: scene.id,
    model: decision.modelId,
    videoPath,
    prompt: scene.videoPrompt,
    expectedCharacters: [],
  });

  const score = overallQualityScore(report);
  const threshold = QUALITY_THRESHOLD[mode];
  const attemptsLeft = scene.retryCount < (mode === "QUALITY" ? 2 : 1);
  const shouldRetry = score < threshold && attemptsLeft;

  await prisma.scene.update({
    where: { id: scene.id },
    data: { qualityScore: score, qualityJson: JSON.stringify(report) },
  });
  await recordCost({
    projectId: project.id,
    batchId: project.batchId,
    sceneId: scene.id,
    category: "quality",
    provider: decision.provider,
    model: decision.modelId,
    amount: charged.amount,
  });

  return {
    score,
    shouldRetry,
    reason: shouldRetry
      ? `Điểm ${score}/10 dưới ngưỡng ${threshold} của chế độ ${mode}. Sẽ tạo lại cảnh này.`
      : `Điểm ${score}/10 đạt yêu cầu.`,
  };
}
