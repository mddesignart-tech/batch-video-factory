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
  referencePriority,
  sceneCharacters,
  type SceneCharacterLists,
} from "@/domain/scene-characters";
import { MAX_REFERENCES_SENT } from "@/providers/openai/openai-image-client";
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
import { assertCanSpend } from "./spend-guard";
import { consumeCreateToken } from "./create-token";
import { isMockMode } from "@/lib/env";
import { isFreeVideoProvider } from "@/providers/video-config";
import { availableProviderNames } from "./provider-health";
import { targetForAspect } from "@/media/render";
import {
  buildNegativePrompt,
  buildScenePrompt,
  getCharacterSheetsByName,
  referenceAbsolutePath,
  type CharacterSheet,
} from "./character-service";
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
  const characterCount = sceneCharacters(scene).present.length || 1;
  return routeScene(ctx.models, {
    type,
    qualityMode: project.qualityMode as QualityMode,
    strategy: scene.routingMode as RouterStrategy,
    complexity: scene.complexity as "LOW" | "MEDIUM" | "HIGH",
    spendPriority: scene.spendPriority as "LOW" | "NORMAL" | "HIGH",
    durationSeconds: scene.duration,
    characterCount,
    consistencyRequired: type === "image" || type === "video",
    // Native 1080p is a QUALITY-mode demand, not a property of video as such.
    // The final render is 1080x1920 either way; a 720x1280 clip upscaled into
    // it is an ordinary pipeline, and at Sora's prices insisting on native
    // 1080p costs seven times as much per second for a 9:16 Short nobody
    // watches full-screen. Requiring it unconditionally silently excluded every
    // affordable video model.
    needs1080p: type === "video" && project.qualityMode === "QUALITY",
    needsReferenceImage:
      type === "video" &&
      shouldGenerateKeyframe(
        project.qualityMode as QualityMode,
        scene.complexity as "LOW" | "MEDIUM" | "HIGH",
        characterCount,
      ),
    // Whether a keyframe EXISTS, not whether we would like one. Veo bills 8
    // seconds instead of 4 when an image is attached, so the estimate has to
    // follow the file on disk rather than the preference.
    keyframeAvailable: Boolean(scene.imagePath),
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
  /**
   * Billable request parameters that are not already implied by the model id.
   *
   * Video duration is the reason this exists: the same scene, prompt and model
   * at 5 seconds and at 10 seconds are two different purchases, but they hashed
   * to the same key, so the 10-second run would "resume" the finished
   * 5-second job and hand back the short clip as though it were the new one.
   * Output size does NOT belong here - it is already part of the model id.
   */
  variant?: string;
}): string {
  return sha256(
    [
      opts.sceneId,
      opts.kind,
      opts.provider,
      opts.model,
      sha256(opts.prompt),
      String(opts.generation),
      opts.variant ?? "",
    ].join("|"),
  );
}

/**
 * Does this create need a single-use permit?
 *
 * Video only, and only when real money is in play. Mock mode and free local
 * providers are excluded because there is nothing to authorise, and requiring a
 * permit there would break every offline run and every test for no benefit.
 */
function needsCreatePermit(kind: string, provider: string): boolean {
  if (kind !== "video") return false;
  if (isMockMode()) return false;
  return !isFreeVideoProvider(provider);
}

interface RunOptions {
  ctx: SceneContext;
  kind: AssetKind | "quality";
  decision: RouteDecision;
  prompt: string;
  /** Extra billable parameters for the idempotency key. See idempotencyKey. */
  variant?: string;
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
  const { ctx, kind, decision, prompt, variant, create, poll, download } = opts;
  const key = idempotencyKey({
    sceneId: ctx.scene.id,
    kind,
    provider: decision.provider,
    model: decision.modelId,
    prompt,
    generation: ctx.scene.retryCount,
    variant: variant ?? "",
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
    // The spend gate belongs here and only here.
    //
    // This is the single function allowed to start a paid generation, so this
    // is the single place the app-wide cap can be enforced for every media
    // type at once. It was previously checked only in script and character
    // work, which meant scene images and videos - the expensive ones - could
    // run past the cap entirely.
    //
    // It sits inside this branch on purpose: resuming a job that was already
    // paid for must never be blocked by a cap the earlier charge helped reach.
    await assertCanSpend({
      provider: decision.provider,
      model: decision.modelId,
      estimatedCost: decision.estimatedCost,
    });

    // "Can we afford it" and "did anyone authorise THIS purchase" are different
    // questions, and the spend guard only answers the first. A create that
    // fails for free spends nothing, so a retry loop passes the guard every
    // time while issuing one real purchase attempt after another. Video is
    // where that costs the most, so video creates need a single-use permit.
    //
    // Consumed BEFORE the request leaves, and never refunded on failure: the
    // attempt is what the permit covers, not the outcome.
    if (needsCreatePermit(kind, decision.provider)) {
      await consumeCreateToken({
        provider: decision.provider,
        model: decision.modelId,
        sceneId: ctx.scene.id,
        kind,
        estimatedCost: decision.estimatedCost,
      });
    }

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

  const lists = sceneCharacters(scene);
  const characterCount = lists.present.length || 1;
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

  const shot = await buildSceneImageRequest(scene, project.stylePresetId);
  if (shot.droppedByLimit.length > 0) {
    await logger.warn({
      event: "scene.references_dropped",
      message:
        `Nhà cung cấp chỉ nhận ${MAX_REFERENCES_SENT} ảnh tham chiếu nên ` +
        `${shot.droppedByLimit.join(", ")} chỉ được mô tả bằng chữ.`,
      data: { scene: scene.sceneNumber, dropped: shot.droppedByLimit },
    });
  }

  const { result, used } = await withFallback(ctx, decision, async (d) => {
    const provider = await getImageProvider(d.provider, d.modelId);
    return runProviderJob({
      ctx,
      kind: "image",
      decision: d,
      prompt: shot.prompt,
      outputPath,
      create: async () =>
        provider.createImage({
          projectId: project.id,
          sceneId: scene.id,
          model: d.modelId,
          prompt: shot.prompt,
          negativePrompt: shot.negativePrompt,
          width: target.width,
          height: target.height,
          // A character's own seed only helps when exactly one character is in
          // the shot; with two it biases the image toward whichever seed we
          // picked, so we let the references carry the consistency instead.
          seed:
            shot.characters.length === 1
              ? (shot.characters[0]?.seed ?? undefined)
              : undefined,
          referenceImages: shot.referenceImages,
          outputPath,
        }),
      poll: (id) => provider.getJobStatus(id),
      download: (id) => provider.downloadResult(id),
    });
  });

  await saveAsset({ ctx, kind: "image", decision: used, prompt: shot.prompt, asset: result });
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

export interface SceneImageRequest {
  prompt: string;
  negativePrompt: string;
  /** Absolute paths, already trimmed to what the provider will accept. */
  referenceImages: string[];
  /** Every character in frame, in reference-priority order. */
  characters: CharacterSheet[];
  /** Characters whose approved master is being sent with this request. */
  referencedCharacters: string[];
  /** In frame but with no approved master, so only described in words. */
  unreferencedCharacters: string[];
  /**
   * Characters named in the scene text but missing from `charactersPresent`,
   * which this call added back. Surfaced so the UI can say what it corrected.
   */
  repairedCharacters: string[];
  /** In frame, but dropped from the reference list by the provider's cap. */
  droppedByLimit: string[];
  /** Listed by the script but never staged, so removed from this image. */
  trimmedCharacters: string[];
}

/**
 * Assemble everything a scene image needs to stay on-model.
 *
 * The text model writes `imagePrompt` describing the action, but it is not
 * allowed to describe what the characters look like - that comes from the
 * stored character sheets and the approved master images, every single time.
 * Exported so the storyboard UI can show the operator the exact prompt that
 * will be sent before any money is spent.
 *
 * Presence comes from `charactersPresent`, never from who has a line. A
 * character reacting silently in the background is drawn just as often as the
 * one talking, and needs their reference just as much.
 */
export async function buildSceneImageRequest(
  scene: Pick<
    Scene,
    | "imagePrompt"
    | "visualDescription"
    | "camera"
    | "characterAction"
    | "charactersPresentJson"
    | "speakingCharactersJson"
    | "primaryCharactersJson"
  >,
  stylePresetId: string | null,
  /** How many reference images the provider will accept. */
  referenceLimit = MAX_REFERENCES_SENT,
): Promise<SceneImageRequest> {
  const stored = sceneCharacters(scene);
  const sceneText = [
    scene.visualDescription,
    scene.imagePrompt,
    scene.characterAction,
  ].join(" ");

  const { lists: repairedLists, repaired } = await repairSceneCharacters(
    stored,
    sceneText,
  );
  // Only the staging text decides who is drawn - the same text that becomes the
  // subject of the prompt. Boilerplate listing every character by name would
  // defeat the trim entirely, so imagePrompt is excluded here.
  const { lists, trimmed } = trimUnusedCharacters(
    repairedLists,
    [scene.visualDescription, scene.characterAction].join(" "),
  );

  // Priority order decides who keeps a reference image when the provider caps
  // the count: the focus of the shot first, then whoever speaks, then the rest.
  const ordered = referencePriority(lists);
  const [characters, stylePrompt] = await Promise.all([
    getCharacterSheetsByName(ordered),
    resolveStylePrompt(stylePresetId),
  ]);

  // `visualDescription` is the scene; it is never optional.
  //
  // The old order preferred `imagePrompt` and fell back to `visualDescription`
  // only when it was empty - but real text models fill `imagePrompt` with style
  // and character boilerplate ("3D cartoon style... Characters: Max, Leo as
  // defined"), which is never empty and carries no action. The result was that
  // "Max holds an enormous jar of beans" never reached the image API at all,
  // and every scene came back as a plain-background character line-up.
  //
  // The model's own `imagePrompt` is dropped on purpose: this pipeline already
  // supplies the style preset and the canonical character sheets, so including
  // it duplicates both and crowds out the part only it can provide.
  const action = [scene.visualDescription, scene.characterAction]
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join(" ");

  // Every character in frame gets their full profile in the prompt, whether or
  // not a reference image survives the cap.
  const prompt = buildScenePrompt({
    sceneDescription: action.length > 0 ? action : scene.imagePrompt,
    characters,
    stylePrompt,
    camera: scene.camera,
  });

  // Only approved references are ever sent. An unapproved master would quietly
  // become the thing every later scene is matched against.
  const withMaster = characters.filter((c) => c.primaryReference !== null);
  const sent = withMaster.slice(0, referenceLimit);
  const dropped = withMaster.slice(referenceLimit);

  return {
    prompt,
    negativePrompt: buildNegativePrompt(characters),
    referenceImages: sent.map((c) =>
      referenceAbsolutePath(c.primaryReference as string),
    ),
    characters,
    referencedCharacters: sent.map((c) => c.name),
    unreferencedCharacters: characters
      .filter((c) => c.primaryReference === null)
      .map((c) => c.name),
    repairedCharacters: repaired,
    droppedByLimit: dropped.map((c) => c.name),
    trimmedCharacters: trimmed,
  };
}

/**
 * Add characters the scene text clearly shows but the lists forgot.
 *
 * The text model lists who speaks far more reliably than who is visible, so a
 * scene whose description says "Leo folds his arms" can arrive with Leo absent
 * from `charactersPresent`. Generating from that would send no reference for
 * him and let the model invent his face - the exact inconsistency this step
 * exists to stop. Repairing beats refusing: the scene is otherwise fine, and
 * the correction is reported rather than done silently.
 */
export async function repairSceneCharacters(
  lists: SceneCharacterLists,
  sceneText: string,
): Promise<{ lists: SceneCharacterLists; repaired: string[] }> {
  const known = await prisma.character.findMany({
    where: { enabled: true },
    select: { name: true },
  });

  const present = [...lists.present];
  const repaired: string[] = [];

  for (const { name } of known) {
    if (present.some((n) => n.toLowerCase() === name.toLowerCase())) continue;
    if (!mentionsCharacter(sceneText, name)) continue;
    present.push(name);
    repaired.push(name);
  }

  if (repaired.length > 0) {
    await logger.warn({
      event: "scene.characters_repaired",
      message:
        `Cảnh nhắc tới ${repaired.join(", ")} nhưng không liệt kê trong ` +
        `charactersPresent. Đã bổ sung trước khi tạo ảnh.`,
      data: { added: repaired },
    });
  }

  return {
    lists: { ...lists, present },
    repaired,
  };
}

/**
 * Drop characters the scene lists but never actually stages.
 *
 * The mirror image of the repair above, and just as necessary. Told to list
 * everyone visible, the text model over-corrected and began pasting the third
 * character into scenes whose description never mentions them - so they would
 * be drawn silently at the edge of frame, costing a reference image and
 * pushing the real subjects towards the crop.
 *
 * The test is deliberately narrow: only a character who is absent from the
 * scene's own staging text AND has no line AND is not the focus can be
 * dropped. Anyone the scene actually uses survives.
 */
export function trimUnusedCharacters(
  lists: SceneCharacterLists,
  stagingText: string,
): { lists: SceneCharacterLists; trimmed: string[] } {
  // Silence is not evidence of absence.
  //
  // A description like "a funny moment" names nobody, and trimming against it
  // would drop every silent character - recreating, from the other direction,
  // the exact bug this whole area exists to prevent. Only text that names
  // characters is treated as a statement about the cast.
  const namesSomeone = lists.present.some((name) =>
    mentionsCharacter(stagingText, name),
  );
  if (!namesSomeone) return { lists, trimmed: [] };

  const trimmed: string[] = [];
  const kept = lists.present.filter((name) => {
    const speaks = lists.speaking.some((n) => equals(n, name));
    const leads = lists.primary.some((n) => equals(n, name));
    if (speaks || leads) return true;
    if (mentionsCharacter(stagingText, name)) return true;
    trimmed.push(name);
    return false;
  });

  // Never empty the cast. A scene whose description names nobody would
  // otherwise lose every character and be drawn as an empty room.
  if (kept.length === 0) return { lists, trimmed: [] };

  return { lists: { ...lists, present: kept }, trimmed };
}

function equals(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Whether a body of scene text names this character.
 *
 * Word-boundary matching, so "Mia" does not fire on "Amiable" and "Max" does
 * not fire on "maximum".
 */
export function mentionsCharacter(text: string, name: string): boolean {
  // Split into words rather than building a regex: character names are
  // arbitrary user input, and a name containing a regex metacharacter would
  // either throw or match the wrong thing.
  const target = name.trim().toLowerCase();
  if (target.length === 0) return false;
  const words = text.toLowerCase().split(/[^a-z0-9]+/);
  return words.includes(target);
}

const DEFAULT_STYLE_PROMPT =
  "consistent 3D cartoon style, bright colours, soft even lighting";

async function resolveStylePrompt(stylePresetId: string | null): Promise<string> {
  if (!stylePresetId) return DEFAULT_STYLE_PROMPT;
  const preset = await prisma.stylePreset.findUnique({
    where: { id: stylePresetId },
  });
  if (!preset) return DEFAULT_STYLE_PROMPT;
  // A preset is several fields, not one string. Joining them here keeps the
  // prompt builder ignorant of how presets are stored.
  return [
    preset.positivePrompt,
    preset.lightingStyle,
    preset.cameraLanguage,
    preset.visualTone,
  ]
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join(", ");
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
    const provider = await getVideoProvider(d.provider, d.modelId);
    return runProviderJob({
      ctx,
      kind: "video",
      decision: d,
      prompt: scene.videoPrompt,
      // Duration is billable and is not implied by the model id, so it has to
      // be part of the key: a 5s and a 10s clip of the same scene are two
      // different purchases, not one job to resume.
      variant: `${scene.duration}s`,
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

  // Voice follows the SPEAKING list, not presence: a character standing
  // silently in frame must be drawn but must not be given a line.
  const speaking = sceneCharacters(scene).speaking;
  const character = speaking[0]
    ? await prisma.character.findFirst({ where: { name: speaking[0] } })
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
      expectedCharacters: sceneCharacters(scene).present,
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
