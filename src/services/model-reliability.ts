import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { failureIsAboutTheModel } from "@/domain/video-suitability";

/**
 * What our own paid failures say about a model.
 *
 * This is the third opinion about whether a model may be used, and the only one
 * that comes from money we actually spent:
 *
 *   enabled       is the row switched on at all
 *   lifecycle     what the VENDOR and the operator say (DEPRECATED, PIN_ONLY)
 *   reliability   what OUR OWN production runs did          <- this file
 *
 * It exists because of one clip. Runway gen4_turbo was sent a scene, answered
 * INTERNAL.BAD_OUTPUT.CODE01 with `cost: { credits: 0 }`, and nothing in the
 * system was any wiser afterwards: the code was folded into a prose message,
 * the per-scene unsuitability flag never fired, and the model stayed first
 * choice for the next scene of the same kind. The information had been paid
 * for and then dropped on the floor.
 *
 * Two rules, at two different scopes, because they answer different questions:
 *
 *   the INPUT rule - this exact request into this model already failed. Never
 *                    send it again; it is not a gamble, it is a repeat.
 *                    Scoped to (model, fingerprint).
 *   the MODEL rule - this model has failed on SEVERAL DIFFERENT scenes. Stop
 *                    choosing it automatically until someone re-benchmarks it.
 *                    Scoped to the model.
 *
 * The second is deliberately hard to trigger. One scene failing twice says
 * something about the scene; a model is only accused when the failures are
 * spread across distinct scenes, and only for failures that are about the model
 * at all - a 400 is our bug, a 429 is a queue, and neither is evidence.
 */

/** Distinct scenes a model must fail on before it stops being auto-routable. */
export const DEGRADED_AT = 2;
/** ...and before it is treated as unusable for production without review. */
export const UNSUITABLE_AT = 3;

export type Reliability = "OK" | "DEGRADED" | "UNSUITABLE";

export interface FingerprintInput {
  model: string;
  kind: string;
  prompt: string;
  /** Keyframe/reference image actually attached, if any. */
  keyframePath?: string | null;
  durationSeconds?: number | null;
}

/**
 * A stable id for "this exact request into this exact model".
 *
 * Includes the model, so a failure teaches us nothing about a different model
 * and does not block one. Includes the keyframe path and the duration, because
 * both change what the vendor is being asked to do: swapping the still or
 * asking for eight seconds instead of four is a NEW request that deserves its
 * own chance, and a rule that blocked those would quietly freeze a scene
 * forever after one bad clip.
 */
export function fingerprintInput(input: FingerprintInput): string {
  const parts = [
    input.model,
    input.kind,
    input.prompt.trim(),
    input.keyframePath ?? "",
    input.durationSeconds == null ? "" : String(input.durationSeconds),
  ];
  return createHash("sha256").update(parts.join("|~|")).digest("hex").slice(0, 32);
}

export interface RecordFailureInput extends FingerprintInput {
  provider: string;
  failureCode: string;
  message?: string;
  projectId?: string | null;
  sceneId?: string | null;
  taskId?: string | null;
  billedUnits?: number | null;
  actualCost?: number;
}

export interface RecordFailureResult {
  recorded: boolean;
  fingerprint: string;
  reliability: Reliability;
  distinctScenes: number;
}

/**
 * Write down a paid failure, then re-judge the model in light of it.
 *
 * Only failures that are ABOUT THE MODEL are recorded. `failureIsAboutTheModel`
 * is the same predicate the benchmark evidence uses, and sharing it is the
 * point: the two must never disagree about what a result means.
 */
export async function recordFailureEvidence(
  input: RecordFailureInput,
): Promise<RecordFailureResult> {
  const fingerprint = fingerprintInput(input);
  if (!failureIsAboutTheModel(input.failureCode)) {
    const current = await reliabilityOf(input.model);
    return { recorded: false, fingerprint, reliability: current, distinctScenes: 0 };
  }

  // Upsert, not create: the same input failing a second time is the SAME fact,
  // and counting it twice would let one stubborn scene convict a model on its
  // own - exactly the confusion the model rule is built to avoid.
  await prisma.modelFailureEvidence.upsert({
    where: { model_fingerprint: { model: input.model, fingerprint } },
    create: {
      provider: input.provider,
      model: input.model,
      kind: input.kind,
      fingerprint,
      failureCode: input.failureCode,
      message: (input.message ?? "").slice(0, 500),
      projectId: input.projectId ?? null,
      sceneId: input.sceneId ?? null,
      taskId: input.taskId ?? null,
      billedUnits: input.billedUnits ?? null,
      actualCost: input.actualCost ?? 0,
    },
    update: {
      failureCode: input.failureCode,
      message: (input.message ?? "").slice(0, 500),
      taskId: input.taskId ?? null,
      // Preserve a reported zero. `?? null` keeps "not reported" distinct from
      // "reported as free"; a truthy check here would erase the difference.
      billedUnits: input.billedUnits ?? null,
    },
  });

  const verdict = await evaluateReliability(input.provider, input.model);
  return {
    recorded: true,
    fingerprint,
    reliability: verdict.reliability,
    distinctScenes: verdict.distinctScenes,
  };
}

/** Has this exact request into this exact model already been paid for and failed? */
export async function knownBadInput(
  input: FingerprintInput,
): Promise<{ failureCode: string; taskId: string | null; at: Date } | null> {
  const fingerprint = fingerprintInput(input);
  const row = await prisma.modelFailureEvidence.findUnique({
    where: { model_fingerprint: { model: input.model, fingerprint } },
  });
  if (!row) return null;
  return { failureCode: row.failureCode, taskId: row.taskId, at: row.createdAt };
}

export interface ReliabilityVerdict {
  reliability: Reliability;
  distinctScenes: number;
  note: string;
}

/**
 * Re-judge a model from its recorded failures and persist the verdict.
 *
 * Counts DISTINCT SCENES, not rows. A model that failed four times on one scene
 * has told us about that scene; a model that failed twice on two different
 * scenes has told us about itself.
 *
 * Only ever escalates. Clearing a verdict is `clearReliability`, which is a
 * deliberate human act after a re-benchmark - a model must not quietly redeem
 * itself because an unrelated row was deleted.
 */
export async function evaluateReliability(
  provider: string,
  model: string,
): Promise<ReliabilityVerdict> {
  const rows = await prisma.modelFailureEvidence.findMany({
    where: { model },
    select: { sceneId: true, failureCode: true },
  });
  // A null sceneId cannot be proved distinct from any other, so it counts once.
  const distinctScenes = new Set(rows.map((r) => r.sceneId ?? "__unknown__")).size;

  const target: Reliability =
    distinctScenes >= UNSUITABLE_AT
      ? "UNSUITABLE"
      : distinctScenes >= DEGRADED_AT
        ? "DEGRADED"
        : "OK";

  const codes = [...new Set(rows.map((r) => r.failureCode))].join(", ");
  const note =
    target === "OK"
      ? ""
      : `${distinctScenes} cảnh khác nhau thất bại (${codes}). ` +
        `Router sẽ không tự chọn ${provider}/${model} cho tới khi benchmark lại.`;

  const current = await reliabilityOf(model);
  if (rank(target) > rank(current)) {
    await prisma.modelRegistry.updateMany({
      where: { provider, modelId: model },
      data: {
        reliability: target,
        reliabilityNote: note,
        reliabilityUpdatedAt: new Date(),
      },
    });
    await logger.warn({
      event: "model.reliability_downgraded",
      provider,
      model,
      message: `${provider}/${model} -> ${target}. ${note}`,
    });
    return { reliability: target, distinctScenes, note };
  }
  return { reliability: current, distinctScenes, note };
}

/** Hand a model back to the router after a re-benchmark. A human decision. */
export async function clearReliability(
  provider: string,
  model: string,
  note: string,
): Promise<void> {
  await prisma.modelRegistry.updateMany({
    where: { provider, modelId: model },
    data: {
      reliability: "OK",
      reliabilityNote: note,
      reliabilityUpdatedAt: new Date(),
    },
  });
}

export async function reliabilityOf(model: string): Promise<Reliability> {
  const row = await prisma.modelRegistry.findFirst({
    where: { modelId: model },
    select: { reliability: true },
  });
  return normalise(row?.reliability);
}

/** Failure counts per model, for the report and the UI. */
export async function failureTally(model: string): Promise<{
  failures: number;
  distinctScenes: number;
  codes: string[];
}> {
  const rows = await prisma.modelFailureEvidence.findMany({
    where: { model },
    select: { sceneId: true, failureCode: true },
  });
  return {
    failures: rows.length,
    distinctScenes: new Set(rows.map((r) => r.sceneId ?? "__unknown__")).size,
    codes: [...new Set(rows.map((r) => r.failureCode))],
  };
}

function normalise(value: string | null | undefined): Reliability {
  return value === "DEGRADED" || value === "UNSUITABLE" ? value : "OK";
}

function rank(value: Reliability): number {
  return value === "UNSUITABLE" ? 2 : value === "DEGRADED" ? 1 : 0;
}

/**
 * May the router CHOOSE this model on its own?
 *
 * Nullish means OK: a row written before this column existed is not evidence of
 * anything, and treating unknown as guilty would empty the router overnight.
 */
export function isReliableForAuto(reliability: string | null | undefined): boolean {
  if (reliability === null || reliability === undefined || reliability === "") {
    return true;
  }
  return reliability === "OK";
}
