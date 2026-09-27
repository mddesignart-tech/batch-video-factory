import { prisma } from "@/lib/prisma";
import { parseJson } from "@/lib/utils";

/**
 * The video model a person APPROVED for a scene, frozen until they approve
 * again (QĐ-111).
 *
 * Invariant: the provider/model shown at preflight and covered by the batch
 * authorisation is the provider/model the POST uses. The order is
 *
 *   plan -> resolve provider/model -> FREEZE -> price -> approve -> reserve -> POST
 *
 * and never "approve A -> the router runs again -> buy B". Before this, the
 * executor compared the model STORED on the scene against the approved set and
 * only then let `generateSceneVideo` route again - so on a resume the check
 * judged one model and the purchase used another (QĐ-110, "phát hiện").
 *
 * Stored in `BatchAuthorization.note` (JSON, next to `plannedVideoModels`) so
 * the freeze lives and dies with the approval it belongs to - no migration.
 * Keyed by scene id. A scene with an entry is executed with exactly that
 * provider + model + duration, or not at all:
 *
 *   APPROVED_MODEL_UNAVAILABLE   the model is gone / disabled / no longer cleared
 *                                for how it was chosen (LOW_AUTO) - STOP, no fallback
 *   APPROVED_MODEL_CHANGED       the request names another model (a pin edited
 *                                after approval, a registry change) - STOP
 *   APPROVED_PARAMS_CHANGED      billable parameters moved (duration) - STOP
 *   APPROVED_COST_CHANGED        the same request now costs more than approved - STOP
 *   APPROVED_MODEL_MISSING       the approval froze choices, but not for this
 *                                scene - it was never shown to anyone - STOP
 *
 * The way out of every one of them is the same: plan again (preflight) and get
 * a new yes. `replanVideoModels` drops a video's entries; the next TIẾP TỤC then
 * shows the newly routed model and freezes it only when the person confirms.
 */

export interface FrozenVideoChoice {
  provider: string;
  model: string;
  /** Billable length the price was computed for. */
  durationSeconds: number;
  /** What the approval was shown for this clip. */
  estimatedCost: number;
  /** Chosen by the router under LOW_AUTO (true) or pinned by a person (false). */
  lowAuto: boolean;
  pinned: boolean;
  frozenAt: string;
}

export type FrozenVideoMap = Record<string, FrozenVideoChoice>;

export const FROZEN_CODES = [
  "APPROVED_MODEL_UNAVAILABLE",
  "APPROVED_MODEL_CHANGED",
  "APPROVED_PARAMS_CHANGED",
  "APPROVED_COST_CHANGED",
  "APPROVED_MODEL_MISSING",
] as const;
export type FrozenCode = (typeof FROZEN_CODES)[number];

interface AuthNote {
  plannedVideoModels?: string[];
  runnableProjectIds?: string[] | null;
  frozenVideo?: FrozenVideoMap;
  [key: string]: unknown;
}

/**
 * The frozen map of an approval note, or null when the approval predates the
 * freeze (no key at all). Null keeps the older rule - the run may not use a
 * model outside `plannedVideoModels` - instead of refusing every legacy batch.
 */
export function frozenFromNote(note: string | null | undefined): FrozenVideoMap | null {
  const parsed = parseJson<AuthNote>(note, {});
  return parsed.frozenVideo && typeof parsed.frozenVideo === "object" ? parsed.frozenVideo : null;
}

export function videoKey(c: { provider: string; model: string }): string {
  return `${c.provider}/${c.model}`;
}

/**
 * The note with `frozenVideo` merged in; every other key is kept. `approved`
 * also lists the entries' models in `plannedVideoModels` - only for a choice a
 * person has just been shown and said yes to, never for a freeze that merely
 * records what an earlier approval already covered.
 */
export function noteWithFrozen(
  note: string | null | undefined,
  entries: FrozenVideoMap,
  opts: { drop?: string[]; approved?: boolean } = {},
): string {
  const parsed = parseJson<AuthNote>(note, {});
  const map: FrozenVideoMap = { ...(parsed.frozenVideo ?? {}) };
  for (const id of opts.drop ?? []) delete map[id];
  Object.assign(map, entries);
  const planned = new Set(parsed.plannedVideoModels ?? []);
  if (opts.approved) for (const c of Object.values(entries)) planned.add(videoKey(c));
  return JSON.stringify({ ...parsed, plannedVideoModels: [...planned], frozenVideo: map });
}

export async function frozenChoicesForBatch(batchId: string | null | undefined): Promise<FrozenVideoMap | null> {
  if (!batchId) return null;
  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId }, select: { note: true } });
  return auth ? frozenFromNote(auth.note) : null;
}

/** Add (or replace) frozen entries on a batch's approval. */
export async function freezeVideoChoices(
  batchId: string,
  entries: FrozenVideoMap,
  opts: { approved?: boolean } = {},
): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId }, select: { note: true } });
  if (!auth) return;
  await prisma.batchAuthorization.update({ where: { batchId }, data: { note: noteWithFrozen(auth.note, entries, opts) } });
}

/**
 * LẬP LẠI KẾ HOẠCH MODEL for one video: its scenes lose their frozen choice, so
 * the next preflight routes them afresh. Nothing is bought here; the next paid
 * TIẾP TỤC asks for confirmation of the NEW model and freezes it only then.
 */
export async function replanVideoModels(projectId: string): Promise<number> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { batchId: true, scenes: { select: { id: true } } },
  });
  if (!project.batchId) return 0;
  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId: project.batchId }, select: { note: true } });
  const map = frozenFromNote(auth?.note);
  if (!auth || !map) return 0;
  const drop = project.scenes.map((s) => s.id).filter((id) => map[id]);
  if (drop.length === 0) return 0;
  await prisma.batchAuthorization.update({
    where: { batchId: project.batchId },
    data: { note: noteWithFrozen(auth.note, {}, { drop }) },
  });
  return drop.length;
}

export class FrozenChoiceError extends Error {
  constructor(
    message: string,
    readonly code: FrozenCode,
  ) {
    super(`${code}: ${message}`);
    this.name = "FrozenChoiceError";
  }
}
