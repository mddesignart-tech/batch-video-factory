import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { parseJson } from "@/lib/utils";
import { resolveApiKey, resolveBaseUrl } from "@/providers/provider-credentials";
import { RUNWAY_API_VERSION } from "@/providers/runway/runway-video-client";

/**
 * What a provider account ACTUALLY offers, and how sure we are of it.
 *
 * Three kinds of fact live in ModelRegistry and they are not equally solid:
 *
 *   LIVE   - the provider's API said so, in this process, just now
 *   CACHE  - the provider's API said so at a recorded time in the past
 *   MANUAL - we typed it in from documentation
 *
 * Every accessor here returns the label with the data. There is deliberately no
 * function that hands back a model list on its own, because the moment a caller
 * can get the list without the provenance, someone will treat a month-old
 * snapshot as proof the account still has the model.
 *
 * WHAT RUNWAY ACTUALLY EXPOSES - checked, not assumed:
 *
 *   GET /organization        200  tier.models{}, creditBalance, rate limits
 *   GET /models              404  Cannot GET /v1/models
 *   GET /organization/usage  404
 *   GET /pricing             404
 *   GET /capabilities        404
 *
 * So existence and rate limits can be LIVE. Price, resolution, duration, aspect
 * ratio and audio support CANNOT: there is no endpoint that serves them. Those
 * are MANUAL, sourced from the public docs, and must be labelled as such however
 * confident they look sitting in the same database row.
 */

export type Provenance = "LIVE" | "CACHE" | "MANUAL";

/**
 * How far a model has been proven. See ModelRegistry.verification.
 *
 * CATALOG_LISTED is the state people over-read. It means the account listing
 * names the model - nothing about whether a create request would be accepted,
 * and nothing about whether our adapter can build one. Runway's
 * /image_to_video serves MiniMax, Alibaba and Google models through one URL and
 * they do NOT share a request schema, so "the catalogue lists it" and "we can
 * call it" are genuinely different claims.
 */
export const VERIFICATION_STATES = [
  "UNVERIFIED",
  "CATALOG_LISTED",
  "API_CREATE_VERIFIED",
  "BENCHMARK_VERIFIED",
] as const;
export type Verification = (typeof VERIFICATION_STATES)[number];

function verificationRank(value: string | null | undefined): number {
  const i = VERIFICATION_STATES.indexOf((value ?? "UNVERIFIED") as Verification);
  return i < 0 ? 0 : i;
}

/**
 * Record how far a model has been proven. Only ever moves FORWARD.
 *
 * A catalogue refresh must not knock a benchmarked model back to
 * CATALOG_LISTED: the clip still happened. Downgrading is a deliberate act, the
 * same way clearing a reliability verdict is.
 */
export async function recordVerification(
  provider: string,
  modelId: string,
  state: Verification,
  note: string,
): Promise<boolean> {
  const row = await prisma.modelRegistry.findFirst({
    where: { provider, modelId },
    select: { verification: true },
  });
  if (!row) return false;
  if (verificationRank(state) <= verificationRank(row.verification)) return false;
  await prisma.modelRegistry.updateMany({
    where: { provider, modelId },
    data: { verification: state, verificationNote: note, verifiedAt: new Date() },
  });
  await logger.warn({
    event: "model.verification_advanced",
    provider,
    model: modelId,
    message: `${provider}/${modelId}: ${row.verification} -> ${state}. ${note}`,
  });
  return true;
}

/** Runway's account endpoint. NOT /models, which does not exist. */
export const RUNWAY_CATALOG_ENDPOINT = "/organization";

export interface CatalogModel {
  key: string;
  maxConcurrent: number | null;
  maxDaily: number | null;
}

export interface Catalog {
  provider: string;
  /** LIVE or CACHE. Never MANUAL - a catalogue is what the vendor said. */
  source: Exclude<Provenance, "MANUAL">;
  fetchedAt: Date;
  /** Milliseconds since the data was read from the provider. 0 when LIVE. */
  ageMs: number;
  endpoint: string;
  models: CatalogModel[];
  creditBalance: number | null;
}

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

interface RunwayOrganization {
  creditBalance?: number;
  tier?: {
    models?: Record<
      string,
      { maxConcurrentGenerations?: number; maxDailyGenerations?: number }
    >;
  };
}

/**
 * Ask Runway what this account can use. Read-only and unbilled.
 *
 * GET /organization costs nothing - it is the same call the preflight uses to
 * read the credit balance. Nothing in this module can POST.
 */
export async function fetchRunwayCatalog(): Promise<Catalog> {
  const apiKey = await resolveApiKey("runway");
  if (!apiKey) {
    throw new CatalogError(
      "Chưa có RUNWAY_API_KEY nên không đọc được danh mục model của tài khoản.",
      "no_key",
    );
  }
  const baseUrl = (await resolveBaseUrl("runway")).replace(/\/+$/, "");
  const url = `${baseUrl}${RUNWAY_CATALOG_ENDPOINT}`;

  const response = await fetch(url, {
    headers: {
      "X-Runway-Version": RUNWAY_API_VERSION,
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    throw new CatalogError(
      `GET ${RUNWAY_CATALOG_ENDPOINT} trả về HTTP ${response.status}.`,
      `http_${response.status}`,
    );
  }
  const json = (await response.json()) as RunwayOrganization;
  const entries = Object.entries(json.tier?.models ?? {});
  if (entries.length === 0) {
    throw new CatalogError(
      "Tài khoản trả về danh sách model rỗng. Không ghi đè cache bằng dữ liệu trống.",
      "empty",
    );
  }

  const models: CatalogModel[] = entries
    .map(([key, limits]) => ({
      key,
      maxConcurrent: limits?.maxConcurrentGenerations ?? null,
      maxDaily: limits?.maxDailyGenerations ?? null,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const fetchedAt = new Date();
  await prisma.providerCatalogSnapshot.upsert({
    where: { provider: "runway" },
    create: {
      provider: "runway",
      payloadJson: JSON.stringify(json).slice(0, 200_000),
      modelKeysJson: JSON.stringify(models.map((m) => m.key)),
      endpoint: RUNWAY_CATALOG_ENDPOINT,
      fetchedAt,
    },
    update: {
      payloadJson: JSON.stringify(json).slice(0, 200_000),
      modelKeysJson: JSON.stringify(models.map((m) => m.key)),
      endpoint: RUNWAY_CATALOG_ENDPOINT,
      fetchedAt,
    },
  });

  return {
    provider: "runway",
    source: "LIVE",
    fetchedAt,
    ageMs: 0,
    endpoint: RUNWAY_CATALOG_ENDPOINT,
    models,
    creditBalance: typeof json.creditBalance === "number" ? json.creditBalance : null,
  };
}

/** The stored snapshot, always labelled CACHE and always carrying its age. */
export async function cachedCatalog(provider: string): Promise<Catalog | null> {
  const row = await prisma.providerCatalogSnapshot.findUnique({ where: { provider } });
  if (!row) return null;
  const payload = parseJson<RunwayOrganization>(row.payloadJson, {});
  const keys = parseJson<string[]>(row.modelKeysJson, []);
  const limits = payload.tier?.models ?? {};
  return {
    provider,
    source: "CACHE",
    fetchedAt: row.fetchedAt,
    ageMs: Date.now() - row.fetchedAt.getTime(),
    endpoint: row.endpoint,
    models: keys.map((key) => ({
      key,
      maxConcurrent: limits[key]?.maxConcurrentGenerations ?? null,
      maxDaily: limits[key]?.maxDailyGenerations ?? null,
    })),
    creditBalance: null,
  };
}

/**
 * Live if possible, cached if not - and the caller is always told which.
 *
 * `allowCache: false` makes a network failure an error rather than a silent
 * downgrade to stale data. Anything about to spend money should use that.
 */
export async function readCatalog(
  provider: string,
  opts: { allowCache?: boolean } = {},
): Promise<Catalog> {
  const allowCache = opts.allowCache ?? true;
  if (provider !== "runway") {
    throw new CatalogError(`Chưa hỗ trợ đọc danh mục của ${provider}.`, "unsupported");
  }
  try {
    return await fetchRunwayCatalog();
  } catch (err) {
    if (!allowCache) throw err;
    const cached = await cachedCatalog(provider);
    if (!cached) throw err;
    await logger.warn({
      event: "catalog.using_cache",
      provider,
      message:
        `Không đọc được danh mục live (${err instanceof Error ? err.message : String(err)}). ` +
        `Dùng bản lưu lúc ${cached.fetchedAt.toISOString()} — ĐÂY LÀ CACHE, không phải live.`,
    });
    return cached;
  }
}

export interface ReconcileRow {
  provider: string;
  modelId: string;
  providerModelKey: string | null;
  /** Did the account listing contain this model? Null when unmapped. */
  confirmed: boolean | null;
  lifecycle: string;
  reliability: string;
  autoRoutable: boolean;
  problem: string;
}

/**
 * Compare what the registry believes against what the account actually lists.
 *
 * Reports, never repairs. A model missing from the account could equally mean
 * the vendor retired it or that we mapped the key wrong, and those want
 * opposite fixes - so the decision stays with a person.
 */
export async function reconcileRegistry(catalog: Catalog): Promise<ReconcileRow[]> {
  const keys = new Set(catalog.models.map((m) => m.key));
  const rows = await prisma.modelRegistry.findMany({
    where: { provider: catalog.provider },
    orderBy: { modelId: "asc" },
  });

  return rows.map((row) => {
    const confirmed = row.providerModelKey ? keys.has(row.providerModelKey) : null;
    const blocked = autoRouteBlock(row);
    const problems: string[] = [];
    if (confirmed === null) {
      problems.push("chưa ánh xạ providerModelKey");
    } else if (!confirmed) {
      problems.push(`tài khoản KHÔNG có "${row.providerModelKey}"`);
    }
    if (row.existenceSource !== "ACCOUNT_LISTING") {
      problems.push(`nguồn tồn tại = ${row.existenceSource}`);
    }
    return {
      provider: row.provider,
      modelId: row.modelId,
      providerModelKey: row.providerModelKey,
      confirmed,
      lifecycle: row.lifecycle,
      reliability: row.reliability,
      autoRoutable: blocked === null,
      problem: problems.join("; "),
    };
  });
}

/** Stamp the LIVE facts - existence and rate limits - onto the registry. */
export async function applyCatalogToRegistry(catalog: Catalog): Promise<number> {
  if (catalog.source !== "LIVE") {
    throw new CatalogError(
      "Chỉ ghi dữ liệu LIVE vào registry. Bản cache không được đóng dấu là đã xác nhận.",
      "not_live",
    );
  }
  const byKey = new Map(catalog.models.map((m) => [m.key, m]));
  const rows = await prisma.modelRegistry.findMany({
    where: { provider: catalog.provider, providerModelKey: { not: null } },
  });

  let updated = 0;
  for (const row of rows) {
    const live = row.providerModelKey ? byKey.get(row.providerModelKey) : undefined;
    if (!live) continue;
    await prisma.modelRegistry.update({
      where: { id: row.id },
      data: {
        // Named after the endpoint that answered, not "LIVE". Being in the
        // account listing is not evidence the API would accept a create.
        existenceSource: "ACCOUNT_LISTING",
        existenceCheckedAt: catalog.fetchedAt,
        maxConcurrent: live.maxConcurrent,
        maxDaily: live.maxDaily,
      },
    });
    updated += 1;
  }
  return updated;
}

/**
 * Why automatic routing must not pick this model, or null if it may.
 *
 * One function, so every caller agrees. It is deliberately stricter than the
 * stored `lifecycle` string alone, because that string is only as fresh as the
 * last person who edited it - and a seed script that rewrites it is exactly how
 * a retired model comes back to life.
 */
export function autoRouteBlock(
  model: {
    lifecycle: string;
    reliability: string;
    shutdownDate: Date | null;
    providerModelKey?: string | null;
    existenceSource?: string;
  },
  now: Date = new Date(),
): string | null {
  // A date that has passed outranks any label. If the vendor switched the model
  // off last Tuesday, a row still reading ACTIVE is simply wrong, and believing
  // it costs a failed paid call to discover.
  if (model.shutdownDate && model.shutdownDate.getTime() <= now.getTime()) {
    return `nhà cung cấp đã tắt model này từ ${model.shutdownDate
      .toISOString()
      .slice(0, 10)}`;
  }
  if (model.lifecycle === "DEPRECATED") {
    // Name the retirement AND the date. "No model available" would send an
    // operator hunting through the registry for a row that is sitting right
    // there, enabled and working - the date is what explains why it is refused.
    const when = model.shutdownDate
      ? ` (nhà cung cấp tắt ngày ${model.shutdownDate.toISOString().slice(0, 10)})`
      : "";
    return `đã bị đánh dấu NGỪNG DÙNG${when}`;
  }
  if (model.lifecycle === "LOW_AUTO_CANDIDATE") {
    return "ứng viên LOW_AUTO — đã đủ bằng chứng nhưng CHƯA được bật";
  }
  if (model.lifecycle && model.lifecycle !== "ACTIVE") {
    return `vòng đời = ${model.lifecycle}`;
  }
  if (model.reliability && model.reliability !== "OK") {
    return `độ tin cậy = ${model.reliability}`;
  }
  return null;
}
