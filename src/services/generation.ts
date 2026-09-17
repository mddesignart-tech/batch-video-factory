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
import {
  routeScene,
  RoutingError,
  type LowAutoSceneFacts,
  type RouteDecision,
} from "./ai-router";
import {
  shouldEvaluateQuality,
  shouldGenerateKeyframe,
} from "./cost-estimator";
import { recordCost, spentOnProject } from "./cost-tracker";
import { providerSpendBreakdown } from "./provider-budget";
import { assertCanSpend } from "./spend-guard";
import { consumeCreateToken } from "./create-token";
import {
  assertBatchAuthorized,
  batchApprovalFor,
} from "./batch-authorization";
import { commit as commitReservation, release as releaseReservation } from "./cost-reservation";
import {
  decideMotion,
  effectiveMotionSource,
  keyframeRequired,
  type MotionResolution,
} from "@/domain/local-motion";
import { parseDialogueLines } from "@/domain/dialogue-lines";
import { marksProviderUnsuitable, withFlag } from "@/domain/video-suitability";
import { deriveSceneVideoFacts } from "./low-auto-facts";
import { knownBadInput, recordFailureEvidence } from "./model-reliability";
import { probeDuration } from "@/media/ffmpeg";
import { normalizeVoiceClip } from "@/media/audio-normalize";
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
  /**
   * Set when this scene belongs to a batch with a LIVE approval.
   *
   * Its presence changes which permit model applies - batch authorisation
   * instead of a single-use create token - so it is resolved once here rather
   * than re-queried at each spend site, where the two could drift apart.
   */
  batchId: string | null;
}

async function loadContext(sceneId: string): Promise<SceneContext> {
  const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
  if (!scene) throw new Error(`Không tìm thấy cảnh ${sceneId}`);
  const project = await prisma.project.findUnique({
    where: { id: scene.projectId },
  });
  if (!project) throw new Error(`Không tìm thấy dự án ${scene.projectId}`);

  const [models, availableProviders, spent, batchAuth] = await Promise.all([
    prisma.modelRegistry.findMany({ where: { enabled: true } }),
    availableProviderNames(),
    spentOnProject(project.id),
    batchApprovalFor(project.batchId),
  ]);

  return {
    scene,
    project,
    models,
    availableProviders,
    budgetRemaining: Math.max(0, round(project.maxBudget - spent)),
    batchId: batchAuth?.batchId ?? null,
  };
}

/**
 * Each vendor's own wallet in dollars, keyed by provider.
 *
 * Read fresh at the moment of routing rather than carried in `SceneContext`,
 * because a batch of scenes routes one after another and the wallet moves
 * between them. A figure captured when the batch started would be stale by the
 * third clip, in the direction that permits spending.
 */
async function providerWalletsUsd(): Promise<Record<string, number | null>> {
  const rows = await providerSpendBreakdown();
  return Object.fromEntries(rows.map((r) => [r.provider, r.remainingUsd]));
}

/**
 * Headroom under the approval's per-video ceiling, or null when there is no
 * approval to impose one.
 *
 * Null means "no batch authorisation governs this call", which is the benchmark
 * and manual-test path where CREATE_ATTEMPT_TOKEN applies instead. It does not
 * mean "unlimited": the global cap and the provider wallet are still checked.
 */
async function perVideoCapFor(batchId: string | null): Promise<number | null> {
  if (!batchId) return null;
  const auth = await batchApprovalFor(batchId);
  return auth ? auth.maxCostPerVideo : null;
}

function routeFor(
  ctx: SceneContext,
  type: ModelType,
  usage: { seconds?: number; images?: number; characters?: number; jobs?: number },
  manual: { provider?: string | null; model?: string | null },
  lowAuto?: LowAutoSceneFacts,
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
    //
    // The video path supplies `lowAuto.hasKeyframe`, which has actually looked
    // on disk; the column alone only proves a filename was once written down.
    // Prefer the stronger answer when it is available, and note that the two
    // differ exactly when a stored image has since been deleted - the case
    // where billing for an attached image would be billing for nothing.
    keyframeAvailable: lowAuto?.hasKeyframe ?? Boolean(scene.imagePath),
    // Providers this scene has already defeated. Excluded from routing.
    sceneFlags: parseJson<string[]>(scene.providerFlagsJson, []),
    budgetRemaining: ctx.budgetRemaining,
    usage,
    availableProviders: ctx.availableProviders,
    manualProvider: manual.provider ?? null,
    manualModel: manual.model ?? null,
    lowAuto,
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
export function needsCreatePermit(
  kind: string,
  provider: string,
  /**
   * Whether this create is covered by a live BATCH_SPEND_AUTHORIZATION.
   *
   * A batch does NOT get to skip authorisation - it gets a different one. The
   * token means "one confirmation buys one POST", which cannot express a ten
   * video run; the batch approval means "spend up to this ceiling on this plan",
   * checked before every request. Requiring both would make batches impossible;
   * requiring neither would make them unaccountable. So exactly one applies, and
   * which one is decided here.
   */
  batchAuthorized = false,
): boolean {
  if (kind !== "video") return false;
  if (isMockMode()) return false;
  if (batchAuthorized) return false;
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
  /**
   * Start the paid work.
   *
   * `sentRequest` is optional but strongly wanted: it is the sanitized record of
   * what the adapter actually sent, which is the only useful evidence when a
   * vendor fails for a reason it will not explain.
   */
  create: () => Promise<{
    externalId: string;
    sentRequest?: Record<string, unknown>;
  }>;
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
  /** Set once a batch reservation is holding money for this request. */
  let reservedKey: string | null = null;
  /** Set once a request may have left this machine. */
  let createAttempted = false;

  if (
    existing &&
    (existing.status === "pending" || existing.status === "processing") &&
    existing.externalId
  ) {
    // A previous attempt may still be running on the vendor's side. Attaching to
    // it is the difference between one charge and two.
    externalId = existing.externalId;
    // The earlier attempt already reserved against the batch under this same
    // key. Claim it so the outcome of THIS attempt settles that money instead
    // of leaving it held forever.
    if (ctx.batchId) reservedKey = key;
    // And treat it as already sent, because it WAS: this branch only runs when
    // a previous attempt got an externalId back from the vendor. Leaving the
    // flag false would make a failed poll look like a request that never left,
    // and hand the batch back budget for a clip the vendor is billing for.
    createAttempted = true;
    await logger.warn({
      event: "provider.job.resumed",
      provider: decision.provider,
      model: decision.modelId,
      projectId: ctx.project.id,
      sceneId: ctx.scene.id,
      message: `Job ${kind} trước đó vẫn đang chạy, tiếp tục theo dõi thay vì tạo mới.`,
    });
  } else {
    // Never buy the same failure twice.
    //
    // Checked BEFORE the budget gate and before any reservation, because the
    // cheapest possible handling of a request we already know the answer to is
    // to not make it. The fingerprint covers model + kind + prompt + keyframe +
    // duration: change any of them and this is a different question, which is
    // allowed to be asked.
    const seen = await knownBadInput({
      model: decision.modelId,
      kind,
      prompt,
      keyframePath: ctx.scene.imagePath,
      durationSeconds: ctx.scene.duration,
    });
    if (seen) {
      throw new ProviderError(
        `${decision.provider}/${decision.modelId} đã thất bại với đúng yêu cầu này ` +
          `(${seen.failureCode}, ${seen.at.toISOString().slice(0, 10)}` +
          `${seen.taskId ? `, task ${seen.taskId}` : ""}). ` +
          `Không gửi lại. Hãy đổi mô tả cảnh, keyframe hoặc mô hình.`,
        decision.provider,
        // Deliberately NOT retryable, which also means no fallback to a more
        // expensive model. Reaching this line means routing already failed to
        // exclude a model it had evidence against - the scene flag should have
        // done it upstream, for free. Quietly buying a different model to paper
        // over that would hide the bug and spend money doing it; stopping makes
        // someone look.
        false,
        seen.failureCode,
      );
    }

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
    // time while issuing one real purchase attempt after another.
    //
    // Which instrument answers the second question depends on where this scene
    // came from, and exactly one of them applies:
    //
    //   inside an approved batch  BATCH_SPEND_AUTHORIZATION, checked and
    //                             RESERVED here so the next concurrent job sees
    //                             this money as spoken for
    //   anywhere else             a single-use create token, consumed BEFORE the
    //                             request leaves and never refunded on failure -
    //                             the attempt is what it covers, not the outcome
    //
    // They are mutually exclusive by construction: `needsCreatePermit` returns
    // false exactly when a batch approval applies. Requiring both would make
    // batches impossible; requiring neither would make them unaccountable.
    if (ctx.batchId) {
      const gate = await assertBatchAuthorized({
        batchId: ctx.batchId,
        projectId: ctx.project.id,
        sceneId: ctx.scene.id,
        kind,
        provider: decision.provider,
        model: decision.modelId,
        estimatedCost: decision.estimatedCost,
        // The SAME key as the ProviderJob above. That is what lets a resume find
        // its own reservation rather than opening a second one.
        idempotencyKey: key,
        // Whether the router picked this itself. An approval signed against a
        // plan of named clips does not cover clips the router chose afterwards.
        lowAutoRouted: decision.lowAutoRouted,
      });
      reservedKey = key;
      await logger.debug({
        event: "batch.gate_passed",
        provider: decision.provider,
        model: decision.modelId,
        projectId: ctx.project.id,
        sceneId: ctx.scene.id,
        message:
          `Lô còn $${gate.ledger.available.toFixed(6)} trong hạn mức ` +
          `$${gate.ledger.ceiling.toFixed(6)}${gate.reused ? " (dùng lại chỗ đã giữ)" : ""}.`,
      });
    }

    if (needsCreatePermit(kind, decision.provider, Boolean(ctx.batchId))) {
      await consumeCreateToken({
        provider: decision.provider,
        model: decision.modelId,
        sceneId: ctx.scene.id,
        kind,
        estimatedCost: decision.estimatedCost,
      });
    }

    // Past this line a request may have reached the vendor, so a failure can no
    // longer be assumed free. See the catch block.
    createAttempted = true;
    const created = await create();
    externalId = created.externalId;

    // Never lose a previous task id.
    //
    // Runway has NO endpoint that lists tasks - a task can only be looked up by
    // an id someone wrote down. Overwriting `externalId` on a retry therefore
    // erased the earlier task permanently, and with it any way to find out
    // whether it had been billed. Two real tasks were created during the first
    // benchmark and only the second survived in the ledger.
    const priorIds = parseJson<string[]>(existing?.previousExternalIds, []);
    if (existing?.externalId && existing.externalId !== externalId) {
      priorIds.push(existing.externalId);
      await logger.warn({
        event: "provider.job.new_task_id",
        provider: decision.provider,
        model: decision.modelId,
        projectId: ctx.project.id,
        sceneId: ctx.scene.id,
        message:
          `Lần thử này tạo task mới ${externalId}. Task trước ${existing.externalId} ` +
          `được giữ lại để tra cứu - nhà cung cấp có thể đã tính phí nó.`,
      });
    }

    // What was SENT, not what was intended. The adapter may rewrite the prompt
    // to fit a vendor limit, and a record of the request that was never made is
    // worse than no record when a provider fails for an unexplained reason.
    const requestJson = JSON.stringify(
      created.sentRequest ?? { prompt: prompt.slice(0, 2000) },
    ).slice(0, 8000);

    record = await prisma.providerJob.upsert({
      where: { idempotencyKey: key },
      create: {
        provider: decision.provider,
        model: decision.modelId,
        kind,
        externalId,
        idempotencyKey: key,
        status: "processing",
        requestJson,
        projectId: ctx.project.id,
        sceneId: ctx.scene.id,
        attempts: (existing?.attempts ?? 0) + 1,
        estimatedCost: decision.estimatedCost,
        previousExternalIds: JSON.stringify(priorIds),
      },
      update: {
        externalId,
        status: "processing",
        requestJson,
        attempts: { increment: 1 },
        error: null,
        previousExternalIds: JSON.stringify(priorIds),
      },
    });
  }

  // What the vendor told us about ITS side of the failure. Both stay null
  // unless a terminal failed status actually said so, and `null` means "not
  // reported" - which is a different answer from `0`, and must stay different.
  let vendorFailureCode: string | null = null;
  let vendorBilledUnits: number | null = null;

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
      // Remember what the vendor said before the exception flattens it.
      vendorFailureCode = status.failureCode ?? null;
      vendorBilledUnits =
        typeof status.billedUnits === "number" ? status.billedUnits : null;
      throw new ProviderError(
        status.error ?? `Nhà cung cấp báo lỗi khi tạo ${kind}.`,
        decision.provider,
        true,
        // The vendor's own code, not one of ours. A generic "generation_failed"
        // here is what made `marksProviderUnsuitable` unreachable in practice:
        // it looks for BAD_OUTPUT, and BAD_OUTPUT never survived this line.
        status.failureCode ?? "generation_failed",
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
    // Settle the hold against the invoice. The held estimate is replaced by
    // what the vendor actually charged, which is usually the moment a batch
    // discovers it has more or less headroom than the plan promised.
    if (reservedKey) await commitReservation(reservedKey, asset.actualCost);
    return asset;
  } catch (err) {
    // Settle the hold honestly. `createAttempted` is the only thing we actually
    // know: it says a request may have reached the vendor. If it did not, the
    // money goes back to the batch; if it might have, the hold stands, because
    // handing back budget for a clip that was billed is how a batch overspends
    // while every figure on screen still adds up.
    //
    // Unless the vendor has told us otherwise. `billedUnits === 0` is not a
    // missing value, it is the vendor stating it charged nothing, and it beats
    // our inference from `createAttempted` because it is a fact and that is a
    // guess. The first real paid run is the proof: Runway returned
    // `cost: { credits: 0 }` on the failed clip and the credit balance was
    // unchanged at 831 before and after - yet $0.25 stayed committed against
    // the batch, because the code never looked at the number.
    //
    // Note the comparison. `!vendorBilledUnits` would have been true for zero
    // AND for null, quietly turning "confirmed free" into "unknown" - the exact
    // truthy check that loses the only value worth having.
    const vendorConfirmedFree = vendorBilledUnits === 0;
    if (reservedKey) {
      await releaseReservation(reservedKey, {
        billed: vendorConfirmedFree ? false : createAttempted,
        actualCost: vendorConfirmedFree
          ? 0
          : err instanceof ProviderError && typeof err.usage?.actualCost === "number"
            ? err.usage.actualCost
            : undefined,
      });
    }

    await prisma.providerJob.update({
      where: { idempotencyKey: key },
      data: {
        status: "failed",
        error: err instanceof Error ? err.message.slice(0, 500) : String(err),
        failureCode:
          vendorFailureCode ??
          (err instanceof ProviderError ? err.code : null),
        billedUnits: vendorBilledUnits,
        actualCost: vendorConfirmedFree ? 0 : undefined,
      },
    });

    // Some failures mean "never send THIS scene to THIS provider again".
    //
    // Runway's INTERNAL.BAD_OUTPUT is the model saying it cannot make something
    // acceptable from this input, which does not change on a retry - scene 4
    // was attempted twice with byte-identical requests and failed identically.
    // Recording that stops the router offering the same dead end, and stops the
    // next operator paying to learn it a third time.
    const code = vendorFailureCode ?? (err instanceof ProviderError ? err.code : null);

    // Write down what this cost us to learn, keyed by the exact request. Only
    // vendor-side verdicts get recorded - `recordFailureEvidence` drops our own
    // 400s and transient 5xx, so a bug of ours never convicts a model.
    //
    // Guarded: evidence is bookkeeping, and failing to file it must not replace
    // the real error with a database one.
    if (code && createAttempted) {
      try {
        const verdict = await recordFailureEvidence({
          provider: decision.provider,
          model: decision.modelId,
          kind,
          prompt,
          keyframePath: ctx.scene.imagePath,
          durationSeconds: ctx.scene.duration,
          failureCode: code,
          message: err instanceof Error ? err.message : String(err),
          projectId: ctx.project.id,
          sceneId: ctx.scene.id,
          taskId: externalId,
          billedUnits: vendorBilledUnits,
          actualCost: vendorConfirmedFree ? 0 : decision.estimatedCost,
        });
        if (verdict.recorded && verdict.reliability !== "OK") {
          await logger.warn({
            event: "provider.model_unreliable",
            provider: decision.provider,
            model: decision.modelId,
            projectId: ctx.project.id,
            sceneId: ctx.scene.id,
            message:
              `${decision.modelId} bị đánh dấu ${verdict.reliability} sau ` +
              `${verdict.distinctScenes} cảnh khác nhau thất bại. Router sẽ ` +
              `không tự chọn mô hình này cho tới khi benchmark lại.`,
          });
        }
      } catch (evidenceErr) {
        await logger.warn({
          event: "provider.evidence_failed",
          provider: decision.provider,
          model: decision.modelId,
          message: `Không ghi được bằng chứng thất bại: ${String(evidenceErr)}`,
        });
      }
    }
    const flag = marksProviderUnsuitable(decision.provider, code);
    if (flag) {
      const current = parseJson<string[]>(ctx.scene.providerFlagsJson, []);
      const next = withFlag(current, flag);
      if (next.length !== current.length) {
        await prisma.scene.update({
          where: { id: ctx.scene.id },
          data: { providerFlagsJson: JSON.stringify(next) },
        });
        await logger.warn({
          event: "provider.marked_unsuitable",
          provider: decision.provider,
          model: decision.modelId,
          projectId: ctx.project.id,
          sceneId: ctx.scene.id,
          message:
            `Đánh dấu ${flag} cho cảnh này. ${decision.provider} sẽ không được ` +
            `định tuyến vào đây nữa cho tới khi cảnh được sửa.`,
        });
      }
    }

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
  // ECONOMY skips keyframes for simple scenes - but those are exactly the
  // scenes routed to LOCAL_MOTION, which has nothing to animate without one.
  // Both rules are right on their own and together they delete the scene.
  const wantsKeyframe = keyframeRequired(
    motionResolutionFor(ctx).source,
    shouldGenerateKeyframe(
      project.qualityMode as QualityMode,
      scene.complexity as "LOW" | "MEDIUM" | "HIGH",
      characterCount,
    ),
  );
  if (!wantsKeyframe) {
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

/**
 * How this scene gets its movement.
 *
 * The stored field is still the default and still protects against a registry
 * edit turning a free scene into a paid one between approval and execution.
 * What changed is what happens when the stored field and today's rules
 * DISAGREE: it used to return `stored` unconditionally, which meant a scene
 * recorded as AI_VIDEO stayed billable even after the classifier decided a
 * still would do. Four scenes in this project were in exactly that state.
 *
 * `effectiveMotionSource` holds the rule - free wins, paid needs both to agree,
 * an explicit manual pin is an instruction - and the divergence is logged here
 * rather than written back, so the disagreement stays visible in the audit
 * trail instead of being tidied away by the process that noticed it.
 */
function motionResolutionFor(ctx: SceneContext): MotionResolution {
  return effectiveMotionSource(
    ctx.scene.motionSource,
    decideMotion({
      qualityMode: ctx.project.qualityMode as QualityMode,
      complexity: ctx.scene.complexity as "LOW" | "MEDIUM" | "HIGH",
      spendPriority: ctx.scene.spendPriority as "LOW" | "NORMAL" | "HIGH",
      characterCount: sceneCharacters(ctx.scene).present.length || 1,
    }),
    // Both halves, not either: a provider with no model is not a choice of
    // model, and the pin has to name the thing being bought to count as an
    // instruction to buy it.
    { manuallyPinned: Boolean(ctx.scene.videoProvider && ctx.scene.videoModel) },
  );
}

/**
 * Returns the clip path, or null when the scene is animated locally.
 *
 * Null is a success, not a gap: the renderer already turns a keyframe into a
 * moving shot with scale/crop plus a slow push-in, and that path costs nothing
 * and cannot fail at a vendor. Most scenes in a six-scene short do not need
 * more than that, and buying six AI clips when two would do is the single
 * biggest avoidable cost in this pipeline.
 */
export async function generateSceneVideo(sceneId: string): Promise<string | null> {
  const ctx = await loadContext(sceneId);
  const { scene, project } = ctx;

  // Everything the routing gate will be asked about this scene, derived ONCE
  // and shared with the dry-run and the proof script - see
  // services/low-auto-facts. Composed here, before the LOCAL_MOTION branch,
  // because the motion verdict is part of the same derivation: computing it
  // twice from the same inputs is how the report and the pipeline came to
  // disagree in the first place.
  const derived = deriveSceneVideoFacts(scene, {
    qualityMode: project.qualityMode,
    stage: "VIDEO",
  });
  const motion = derived.motion;
  if (motion.diverged) {
    // Logged at WARN and BEFORE anything is generated, because this is the
    // moment the two records of what this scene should cost were found to
    // disagree - and whichever way it was settled, somebody should be able to
    // find out that it happened without re-deriving it from the money.
    await logger.warn({
      event: "scene.motion_source_diverged",
      projectId: project.id,
      sceneId: scene.id,
      message:
        `Cảnh ${scene.sceneNumber}: motionSource lưu = ${scene.motionSource}, ` +
        `quyết định áp dụng = ${motion.source}. ${motion.reason}`,
    });
  }

  if (motion.source === "LOCAL_MOTION") {
    // The keyframe is now load-bearing rather than optional: with no clip and
    // no image the renderer would drop this scene entirely, and a scene missing
    // from a finished video is the kind of failure nobody notices until upload.
    if (!scene.imagePath) {
      throw new GenerationError(
        `Cảnh ${scene.sceneNumber} dùng chuyển động tại máy (LOCAL_MOTION) nên ` +
          `BẮT BUỘC phải có ảnh keyframe, nhưng cảnh chưa có ảnh. Hãy tạo ảnh trước.`,
        "video",
        "ffmpeg",
        false,
      );
    }
    await prisma.scene.update({
      where: { id: scene.id },
      data: {
        videoPath: null,
        videoProvider: "ffmpeg",
        videoModel: "local-motion",
        status: "video_ready",
        errorMessage: null,
      },
    });
    await logger.info({
      event: "scene.local_motion",
      projectId: project.id,
      sceneId: scene.id,
      message:
        `Cảnh ${scene.sceneNumber} dùng ảnh + chuyển động FFmpeg, không gọi ` +
        `Video AI. Chi phí video: $0,00.`,
    });
    return null;
  }

  // The LAST step before the prompt leaves this machine - and now also the step
  // before ROUTING, which is why it moved above the `routeFor` call.
  //
  // The low-auto gate asks whether the prompt went through the guardrail and
  // whether it contradicts itself. Both are properties of the composed prompt,
  // so composing it after choosing the model would have meant answering those
  // two questions about a prompt that did not exist yet. The old order was fine
  // when nothing downstream of routing fed back into it; it stopped being fine
  // the moment the router started asking about the prompt.
  //
  // Applied once, and reused for the idempotency key, the request body and the
  // stored asset - so all three describe the same request. Computing it inside
  // `create()` instead would key the job on a prompt different from the one
  // actually sent, and a resume would then look like a new purchase.
  //
  // This is not cosmetic. The same scene, same keyframe and same model scored
  // camera 1/10 without a lock guardrail and 10/10 with one; 17 of this
  // project's 23 scenes were carrying prompts with no camera lock at all.
  const { cameraIntent, guarded, videoPrompt, contradictions } = derived;
  if (guarded.added.length > 0 || guarded.truncated) {
    await logger.info({
      event: "scene.camera_guardrail",
      projectId: project.id,
      sceneId: scene.id,
      message: `${cameraIntent.reason} -> ${guarded.note}`,
    });
  }
  if (contradictions.length > 0) {
    // Refuse rather than warn, and refuse BEFORE routing. A prompt that both
    // forbids and requests the same move makes the model choose, and it chooses
    // differently every run - which is precisely the instability the guardrails
    // exist to remove. Sending it would be paying for a coin toss, and picking
    // a model for it first would be doing arithmetic about a purchase that must
    // not happen.
    throw new GenerationError(
      `Prompt cảnh ${scene.sceneNumber} tự mâu thuẫn: ${contradictions.join("; ")}. ` +
        `Hãy sửa ý đồ camera trong kịch bản rồi chạy lại.`,
      "video",
      scene.videoProvider ?? "router",
      false,
    );
  }

  const decision = routeFor(
    ctx,
    "video",
    { seconds: scene.duration, jobs: 1 },
    { provider: scene.videoProvider, model: scene.videoModel },
    // The scene facts a LOW_AUTO candidate is judged against. VIDEO stage: this
    // is the call that spends, so a keyframe that is merely expected later is a
    // keyframe that does not exist.
    {
      ...derived.facts,
      // The environment half, which is not a property of the scene: each
      // vendor's wallet as it stands right now, and what the batch approval
      // still allows one video to cost.
      providerBudgets: await providerWalletsUsd(),
      perVideoCapRemaining: await perVideoCapFor(ctx.batchId),
    },
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
      prompt: videoPrompt,
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
          prompt: videoPrompt,
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

  await saveAsset({ ctx, kind: "video", decision: used, prompt: videoPrompt, asset: result });
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

/**
 * Resolve every voice setting for one character, falling back sensibly.
 *
 * Nothing here names a vendor. The character row decides who speaks for it,
 * which is what lets an operator switch a character to ElevenLabs later
 * without a deploy.
 */
async function voiceSettingsFor(
  speaker: string,
): Promise<{
  characterId: string | null;
  provider: string | null;
  model: string | null;
  voiceId: string;
  instructions: string;
  speed: number;
  gender: "male" | "female";
  accent: "US" | "UK";
}> {
  const character = await prisma.character.findFirst({ where: { name: speaker } });

  // In Mock Mode the character's real provider/model pair is not routable -
  // `openai/gpt-4o-mini-tts` is not a mock model - so pinning it would fail
  // routing outright rather than run free. Mock Mode is a hard gate, so the
  // router picks a mock voice and the character's choice waits for real mode.
  const pin = !isMockMode();

  return {
    characterId: character?.id ?? null,
    // Null lets the router choose; a value pins it. Both are legitimate.
    provider: pin ? character?.voiceProvider || null : null,
    model: pin ? character?.voiceModel || null : null,
    voiceId: character?.voiceId ?? "mock-male-us",
    instructions: character?.voiceInstructions ?? "",
    speed: character?.voiceSpeed ?? 1,
    gender: character?.voiceGender === "female" ? "female" : "male",
    accent: character?.voiceAccent === "UK" ? "UK" : "US",
  };
}

/**
 * Generate one audio file per spoken line, not one per scene.
 *
 * The old version made a single file and handed it to whoever was first in the
 * speaking list, so a scene where two characters trade lines - the ordinary
 * case - either lost the second speaker or had the first one read both parts.
 *
 * Returns the paths written, in line order.
 */
export async function generateSceneVoice(sceneId: string): Promise<string[]> {
  const ctx = await loadContext(sceneId);
  const { scene, project } = ctx;

  // Speech follows the SPEAKING list, never the PRESENT list. A character
  // standing silently in frame must be drawn and must not be given a line.
  const speaking = sceneCharacters(scene).speaking;
  const lines = parseDialogueLines(scene.dialogue, scene.narration, speaking);
  if (lines.length === 0) return [];

  const written: string[] = [];

  for (const line of lines) {
    const settings = await voiceSettingsFor(line.speaker);

    const decision = routeFor(
      ctx,
      "voice",
      { characters: line.text.length, jobs: 1 },
      { provider: settings.provider, model: settings.model },
    );

    const outputPath = path.join(
      projectSubdir(project.id, "audio"),
      uuidFilename(extensionForVoice(decision.provider)),
    );

    // The row exists BEFORE the call, so a crash mid-generation leaves a line
    // marked pending rather than no trace that the work was attempted.
    const row = await prisma.dialogueLine.upsert({
      where: { sceneId_lineNumber: { sceneId: scene.id, lineNumber: line.lineNumber } },
      create: {
        sceneId: scene.id,
        characterId: settings.characterId,
        lineNumber: line.lineNumber,
        text: line.text,
        provider: decision.provider,
        model: decision.modelId,
        voiceId: settings.voiceId,
        instructions: settings.instructions,
        speed: settings.speed,
        estimatedCost: decision.estimatedCost,
        status: "processing",
      },
      update: {
        characterId: settings.characterId,
        text: line.text,
        provider: decision.provider,
        model: decision.modelId,
        voiceId: settings.voiceId,
        instructions: settings.instructions,
        speed: settings.speed,
        estimatedCost: decision.estimatedCost,
        status: "processing",
        error: "",
      },
    });

    try {
      const { result, used } = await withFallback(ctx, decision, async (d) => {
        const provider = await getVoiceProvider(d.provider, d.modelId);
        return runProviderJob({
          ctx,
          kind: "audio",
          decision: d,
          prompt: line.text,
          // Two lines in one scene differ by speaker and wording, and both are
          // billable, so both belong in the key.
          variant: `line${line.lineNumber}:${settings.voiceId}`,
          outputPath,
          create: async () =>
            provider.createVoice({
              projectId: project.id,
              sceneId: scene.id,
              model: d.modelId,
              text: line.text,
              voiceId: settings.voiceId,
              instructions: settings.instructions,
              accent: settings.accent,
              gender: settings.gender,
              speed: settings.speed,
              targetDuration: scene.duration,
              outputPath,
            }),
          poll: (id) => provider.getJobStatus(id),
          download: (id) => provider.downloadResult(id),
        });
      });

      await saveAsset({
        ctx,
        kind: "audio",
        decision: used,
        prompt: line.text,
        asset: result,
      });

      // Level and trim BEFORE measuring.
      //
      // The three test clips came off the same model spanning more than ten
      // decibels - Max at -16.0 LUFS, Leo at -26.9. A viewer sets the volume
      // for Leo and then gets shouted at by Max. Per-character gain would fix
      // those three and break the next three, so it is measured and automatic.
      //
      // Trimming also changes the length, which is why duration is taken from
      // the FINISHED file: subtitles line up against the audio that ships, not
      // against what came back from the vendor.
      let durationSec = 0;
      try {
        const levelled = await normalizeVoiceClip(result.filePath, result.filePath);
        durationSec = levelled.durationSec;
      } catch (normErr) {
        // A levelling failure must not throw away audio that was paid for. Keep
        // the clip, record the real duration, and say plainly that it is not
        // levelled rather than letting it into a mix as if it were.
        await logger.warn({
          event: "audio.normalize_failed",
          provider: used.provider,
          model: used.modelId,
          projectId: project.id,
          sceneId: scene.id,
          message: `Không chuẩn hoá được âm lượng, giữ nguyên tệp gốc: ${
            normErr instanceof Error ? normErr.message : String(normErr)
          }`,
        });
        try {
          durationSec = await probeDuration(result.filePath);
        } catch {
          durationSec = 0;
        }
      }

      await prisma.dialogueLine.update({
        where: { id: row.id },
        data: {
          provider: used.provider,
          model: used.modelId,
          actualCost: result.actualCost,
          durationSec,
          outputPath: toRelative(result.filePath),
          status: "completed",
        },
      });
      written.push(result.filePath);
    } catch (err) {
      await prisma.dialogueLine.update({
        where: { id: row.id },
        data: {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }

  // The scene still carries the FIRST line's audio so existing renderers keep
  // working. Mixing several lines into one track is the next step, and it needs
  // the per-line durations this function now records.
  const first = written[0];
  if (first) {
    await prisma.scene.update({
      where: { id: scene.id },
      data: {
        audioPath: toRelative(first),
        status: "audio_ready",
      },
    });
  }
  return written;
}

/** Container each vendor returns. Kept beside the adapters it describes. */
function extensionForVoice(provider: string): string {
  return provider === "mock" ? ".wav" : ".wav";
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
