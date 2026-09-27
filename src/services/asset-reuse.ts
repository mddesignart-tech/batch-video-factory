import fs from "node:fs";
import path from "node:path";
import type { Asset, ProviderJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { projectSubdir, toAbsolute, toRelative, uuidFilename } from "@/lib/paths";
import { reuseKeyKind } from "@/domain/asset-reuse-key";
import { fileSha256 } from "./asset-content";
import { jobPossiblyBilled } from "./paid-recovery";
import { getSettings } from "@/lib/settings";

/**
 * THE reuse engine (V1.2 Phase 4, QĐ-112). Generation, the preflight and the
 * resume plan all ask this one module "does this asset already exist?" - none
 * of them keeps a reuse rule of its own.
 *
 * Three scopes, in order: SAME_SCENE, SAME_PROJECT, GLOBAL (another project).
 * A candidate is reused only when ALL hold:
 *   - same reuse key (so: same kind, model, parameters, inputs - see buildAssetReuseKey)
 *   - status completed, validity VALID
 *   - the file is on disk, non-empty, and its bytes still hash to the stored sha256
 * A file that is gone is MISSING_LOCAL_FILE; one whose bytes changed is INVALID.
 * Neither is ever reused "blind".
 *
 * Money: a reuse is a REFERENCE - its own Asset row (source REUSED, cost 0) and
 * its own file link. No ProviderJob, no CostEntry, no reservation; the original
 * purchase keeps its ledger line untouched.
 */

export type ReuseScope = "SAME_SCENE" | "SAME_PROJECT" | "GLOBAL";

export type ReuseLookup =
  | { status: "REUSE"; asset: Asset; scope: ReuseScope; absolutePath: string }
  | { status: "IN_PROGRESS"; job: ProviderJob }
  | { status: "NEEDS_RECOVERY"; job: ProviderJob; reason: string }
  | { status: "NONE"; rejected: { assetId: string; validity: Validity }[] };

export type Validity = "VALID" | "MISSING_LOCAL_FILE" | "INVALID";

/** Is this stored asset still exactly what it claims to be? Reads only. */
export function validateAssetFile(asset: Pick<Asset, "filePath" | "sha256" | "bytes">): Validity {
  let absolute: string;
  try {
    absolute = toAbsolute(asset.filePath);
  } catch {
    return "INVALID";
  }
  if (!fs.existsSync(absolute)) return "MISSING_LOCAL_FILE";
  const size = fs.statSync(absolute).size;
  if (size === 0) return "INVALID";
  if (!asset.sha256) return "INVALID"; // a keyed asset without a hash cannot be verified
  try {
    return fileSha256(absolute) === asset.sha256 ? "VALID" : "INVALID";
  } catch {
    return "INVALID";
  }
}

function scopeOf(asset: Asset, where: { sceneId?: string | null; projectId?: string | null }): ReuseScope {
  if (where.sceneId && asset.sceneId === where.sceneId) return "SAME_SCENE";
  if (where.projectId && asset.projectId === where.projectId) return "SAME_PROJECT";
  return "GLOBAL";
}

const SCOPE_ORDER: Record<ReuseScope, number> = { SAME_SCENE: 0, SAME_PROJECT: 1, GLOBAL: 2 };

export type ReusePolicy = "GLOBAL" | "PROJECT" | "SCENE";

/** The reuse scope in force: environment override, else the app setting (default GLOBAL). */
export async function reusePolicy(): Promise<ReusePolicy> {
  const env = process.env.ASSET_REUSE_SCOPE?.trim().toUpperCase();
  if (env === "GLOBAL" || env === "PROJECT" || env === "SCENE") return env;
  return (await getSettings()).assetReuseScope ?? "GLOBAL";
}

/** May an asset found in `scope` be reused under `policy`? */
export function scopeAllowed(scope: ReuseScope, policy: ReusePolicy): boolean {
  if (policy === "GLOBAL") return true;
  if (policy === "PROJECT") return scope !== "GLOBAL";
  return scope === "SAME_SCENE";
}

// ------------------------------------------------------ creation lock ---

const creating = new Map<string, Promise<void>>();

/** True while some caller in this process holds the creation lock for this key. */
export function isCreating(reuseKey: string): boolean {
  return creating.has(reuseKey);
}

/**
 * One creation per reuse key at a time (in this process - one app, one SQLite,
 * like the reservation lock). A second caller for the same key WAITS, then runs
 * its own `fn`, which re-asks the engine and finds the first caller's asset: the
 * asset is bought once, never twice. Callers for different keys never wait.
 */
export async function withAssetCreationLock<T>(reuseKey: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireAssetCreationLock(reuseKey);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** The same lock, held across code that cannot be one callback. Always release in `finally`. */
export async function acquireAssetCreationLock(reuseKey: string): Promise<() => void> {
  const previous = creating.get(reuseKey) ?? Promise.resolve();
  let open!: () => void;
  const mine = new Promise<void>((r) => (open = r));
  const tail = previous.then(() => mine);
  creating.set(reuseKey, tail);
  await previous.catch(() => undefined);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    open();
    if (creating.get(reuseKey) === tail) creating.delete(reuseKey);
  };
}

// ------------------------------------------------------------- lookup ---

/**
 * Find a reusable asset for this key, nearest scope first.
 *
 * `mark` (execution only) records MISSING_LOCAL_FILE / INVALID on the rows it
 * rejects, so the next preflight does not have to rediscover them. A preflight
 * passes mark=false and stays read-only.
 *
 * With no reusable asset it also answers whether a request for the SAME asset
 * is already out there under another idempotency key: in flight (IN_PROGRESS /
 * NEEDS_RECOVERY) or failed after it may have been billed (NEEDS_RECOVERY).
 * Every requester sees that and none of them sends a second paid request.
 */
export async function findReusableAsset(opts: {
  reuseKey: string;
  sceneId?: string | null;
  projectId?: string | null;
  /** The caller's own idempotency key: its own earlier job is handled by runProviderJob. */
  ownIdempotencyKey?: string;
  mark?: boolean;
  /**
   * The caller holds this key's creation lock. Creation is serialised per key,
   * so a foreign request still in flight under this key is then an ORPHAN
   * (nobody in this process is creating it) - NEEDS_RECOVERY, not IN_PROGRESS.
   */
  holdingLock?: boolean;
}): Promise<ReuseLookup> {
  const rows = await prisma.asset.findMany({
    where: { reuseKey: opts.reuseKey, status: "completed", validity: "VALID" },
    orderBy: { createdAt: "asc" },
  });
  const policy = await reusePolicy();
  const ordered = rows
    .map((a) => ({ a, scope: scopeOf(a, opts) }))
    .filter((x) => scopeAllowed(x.scope, policy))
    .sort((x, y) => SCOPE_ORDER[x.scope] - SCOPE_ORDER[y.scope]);
  const rejected: { assetId: string; validity: Validity }[] = [];
  for (const { a, scope } of ordered) {
    const validity = validateAssetFile(a);
    if (validity === "VALID") {
      return { status: "REUSE", asset: a, scope, absolutePath: toAbsolute(a.filePath) };
    }
    rejected.push({ assetId: a.id, validity });
    if (opts.mark) {
      await prisma.asset.update({ where: { id: a.id }, data: { validity, validatedAt: new Date() } });
      await logger.warn({
        event: "asset.reuse_rejected",
        projectId: a.projectId,
        sceneId: a.sceneId ?? undefined,
        message: `Asset ${a.id.slice(0, 8)} (${a.kind}) không dùng lại được: ${validity}. Không dùng lại "mù".`,
      });
    }
  }

  const others = await prisma.providerJob.findMany({
    where: {
      reuseKey: opts.reuseKey,
      ...(opts.ownIdempotencyKey ? { idempotencyKey: { not: opts.ownIdempotencyKey } } : {}),
      status: { in: ["pending", "processing", "failed"] },
    },
    orderBy: { createdAt: "desc" },
  });
  for (const job of others) {
    if (job.idempotencyKey.includes("#reviewed-")) continue; // archived after a person checked it
    if (job.status === "pending" || job.status === "processing") {
      if (!job.externalId) continue; // never left this machine
      return isCreating(opts.reuseKey) && !opts.holdingLock
        ? { status: "IN_PROGRESS", job }
        : {
            status: "NEEDS_RECOVERY",
            job,
            reason: `Một request tạo đúng asset này (${job.provider}/${job.model}, task ${job.externalId}) đang chờ mà không ai theo dõi.`,
          };
    }
    if (job.status === "failed" && (await jobPossiblyBilled(job))) {
      return {
        status: "NEEDS_RECOVERY",
        job,
        reason: `Một request tạo đúng asset này (${job.provider}/${job.model}) thất bại sau khi có thể đã bị tính tiền.`,
      };
    }
  }
  return { status: "NONE", rejected };
}

/**
 * Read-only batch lookup for the preflight: which of these keys have a VALID
 * asset right now that the scope policy lets THIS scene use. One query, then
 * the same file validation the execution applies.
 */
export async function reusableKeys(
  keys: string[],
  where: { sceneId?: string | null; projectId?: string | null } = {},
): Promise<Map<string, Asset>> {
  const out = new Map<string, Asset>();
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return out;
  const policy = await reusePolicy();
  const rows = await prisma.asset.findMany({
    where: { reuseKey: { in: unique }, status: "completed", validity: "VALID" },
    orderBy: { createdAt: "asc" },
  });
  for (const a of rows) {
    if (out.has(a.reuseKey!)) continue;
    if (!scopeAllowed(scopeOf(a, where), policy)) continue;
    if (validateAssetFile(a) === "VALID") out.set(a.reuseKey!, a);
  }
  return out;
}

// ------------------------------------------------------------- attach ---

const SUBDIR: Record<string, "images" | "videos" | "audio"> = { image: "images", video: "videos", audio: "audio" };

/**
 * Make `source` this scene's asset without buying anything.
 *
 * Same project: the scene points at the same file (the project owns it once).
 * Another project: the file is HARD-LINKED into this project's folder (copied
 * if the volume cannot link) - so deleting or cleaning up the other project can
 * never take this video's file with it, and no second copy of the bytes is made
 * where linking works.
 *
 * Idempotent: a scene that already has a VALID row for this key gets that row
 * back - a double click never makes a second mapping.
 */
export async function attachReusedAsset(opts: {
  source: Asset;
  projectId: string;
  sceneId: string;
  scope: ReuseScope;
}): Promise<{ asset: Asset; absolutePath: string; created: boolean }> {
  const { source } = opts;
  const existing = await prisma.asset.findFirst({
    where: { sceneId: opts.sceneId, kind: source.kind, reuseKey: source.reuseKey, status: "completed", validity: "VALID" },
    orderBy: { createdAt: "asc" },
  });
  if (existing && validateAssetFile(existing) === "VALID") {
    return { asset: existing, absolutePath: toAbsolute(existing.filePath), created: false };
  }

  let filePath = source.filePath;
  if (source.projectId !== opts.projectId) {
    const dir = projectSubdir(opts.projectId, SUBDIR[source.kind] ?? "images");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `reuse-${uuidFilename(path.extname(source.filePath) || ".bin")}`);
    try {
      fs.linkSync(toAbsolute(source.filePath), dest);
    } catch {
      fs.copyFileSync(toAbsolute(source.filePath), dest);
    }
    filePath = toRelative(dest);
  }
  const asset = await prisma.asset.create({
    data: {
      projectId: opts.projectId,
      sceneId: opts.sceneId,
      kind: source.kind,
      provider: source.provider,
      model: source.model,
      prompt: source.prompt,
      negativePrompt: source.negativePrompt,
      status: "completed",
      source: "REUSED",
      estimatedCost: 0,
      actualCost: 0,
      filePath,
      bytes: source.bytes,
      mimeType: source.mimeType,
      width: source.width,
      height: source.height,
      durationSec: source.durationSec,
      sha256: source.sha256,
      reuseKey: source.reuseKey,
      reusedFromAssetId: source.reusedFromAssetId ?? source.id,
      validity: "VALID",
      validatedAt: new Date(),
    },
  });
  await logger.info({
    event: "asset.reused",
    provider: source.provider,
    model: source.model,
    projectId: opts.projectId,
    sceneId: opts.sceneId,
    message:
      `Dùng lại ${reuseKeyKind(source.reuseKey) ?? source.kind} đã có (${opts.scope}, asset ${source.id.slice(0, 8)}). ` +
      `Không gửi request, chi phí tăng thêm $0.`,
  });
  return { asset, absolutePath: toAbsolute(filePath), created: true };
}
