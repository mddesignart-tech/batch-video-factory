import type { ModelRegistry } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { isMockMode } from "@/lib/env";
import {
  effectiveProfile,
  routingModeChange,
  routingModeOf,
  storedProfile,
  VideoModelProfileSchema,
  type RoutingMode,
  type VideoModelProfile,
} from "@/domain/video-model-profile";
import { hasVideoAdapter } from "@/providers/video-adapters";
import { ProviderConfigError, resolveApiKey } from "@/providers/provider-credentials";
import { discoverModels } from "./model-discovery";
import { refreshRunwayBalance } from "./provider-budget";

/**
 * Nhà cung cấp AI → Video AI (Nâng cao). Operator controls for the video model
 * registry: routing mode, default, capability profile, discovered models and a
 * connection check. Never part of the daily workflow, and nothing here ever
 * creates a video: every action is a registry write or a FREE read.
 */

export interface VideoModelRow {
  id: string;
  provider: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  lifecycle: string;
  routingMode: RoutingMode;
  verification: string;
  reliability: string;
  price: number;
  priceUnit: string;
  profile: ReturnType<typeof effectiveProfile>;
  benchmarkRuns: number;
  benchmarkPassed: number;
  adapter: boolean;
}

export async function listVideoModels(): Promise<VideoModelRow[]> {
  const [models, runs] = await Promise.all([
    prisma.modelRegistry.findMany({ where: { type: "video" }, orderBy: [{ provider: "asc" }, { price: "asc" }] }),
    prisma.videoBenchmark.groupBy({ by: ["provider", "model", "outcome"], _count: { _all: true } }),
  ]);
  return models.map((m) => {
    const mine = runs.filter((r) => r.provider === m.provider && r.model === m.modelId);
    return {
      id: m.id,
      provider: m.provider,
      modelId: m.modelId,
      displayName: m.displayName,
      enabled: m.enabled,
      lifecycle: m.lifecycle,
      routingMode: routingModeOf(m.lifecycle, m.enabled),
      verification: m.verification,
      reliability: m.reliability,
      price: m.price,
      priceUnit: m.priceUnit,
      profile: effectiveProfile(m),
      benchmarkRuns: mine.reduce((n, r) => n + r._count._all, 0),
      benchmarkPassed: mine.filter((r) => r.outcome === "succeeded").reduce((n, r) => n + r._count._all, 0),
      adapter: m.provider === "mock" || m.provider === "ffmpeg" || hasVideoAdapter(m.provider),
    };
  });
}

export class VideoModelAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoModelAdminError";
  }
}

async function videoModel(id: string): Promise<ModelRegistry> {
  const m = await prisma.modelRegistry.findUnique({ where: { id } });
  if (!m || m.type !== "video") throw new VideoModelAdminError("Không tìm thấy model video.");
  return m;
}

/** Enable/Disable, PIN_ONLY, AUTO_OK (benchmark first), DEPRECATED. */
export async function setVideoRoutingMode(id: string, mode: RoutingMode): Promise<ModelRegistry> {
  const m = await videoModel(id);
  const change = routingModeChange(m, mode);
  if (!change.ok) throw new VideoModelAdminError(change.reason);
  const updated = await prisma.modelRegistry.update({
    where: { id },
    data: { lifecycle: change.lifecycle, enabled: change.enabled },
  });
  await logger.info({
    event: "model.routing_mode",
    provider: m.provider,
    model: m.modelId,
    message: `${m.provider}/${m.modelId}: ${routingModeOf(m.lifecycle, m.enabled)} → ${mode} (lifecycle ${m.lifecycle} → ${change.lifecycle}).`,
  });
  return updated;
}

function withProfile(m: ModelRegistry, patch: Partial<VideoModelProfile>): string {
  const base = storedProfile(m.capabilityProfileJson) ?? VideoModelProfileSchema.parse({});
  return JSON.stringify(VideoModelProfileSchema.parse({ ...base, ...patch }));
}

/** "Mặc định": offered first when a scene needs a person to choose. Never auto-buys. */
export async function setDefaultVideoModel(id: string): Promise<void> {
  const target = await videoModel(id);
  const others = await prisma.modelRegistry.findMany({ where: { type: "video", id: { not: id } } });
  for (const m of others) {
    if (storedProfile(m.capabilityProfileJson)?.isDefault) {
      await prisma.modelRegistry.update({ where: { id: m.id }, data: { capabilityProfileJson: withProfile(m, { isDefault: false }) } });
    }
  }
  await prisma.modelRegistry.update({ where: { id }, data: { capabilityProfileJson: withProfile(target, { isDefault: true }) } });
}

/** Store a capability profile (aspect ratios, durations, credits, quality scores). */
export async function saveVideoCapabilityProfile(id: string, input: unknown): Promise<ModelRegistry> {
  const m = await videoModel(id);
  const parsed = VideoModelProfileSchema.safeParse(input);
  if (!parsed.success) {
    throw new VideoModelAdminError(`Hồ sơ khả năng không hợp lệ: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
  }
  return prisma.modelRegistry.update({ where: { id: m.id }, data: { capabilityProfileJson: JSON.stringify(parsed.data) } });
}

/**
 * A model a provider just told us about. It goes in DISABLED + PIN_ONLY, price
 * unknown and unverified: it is never auto-routed until a person prices and
 * benchmarks it.
 */
export async function registerDiscoveredVideoModel(input: { provider: string; modelId: string; displayName?: string }): Promise<ModelRegistry> {
  const existing = await prisma.modelRegistry.findUnique({ where: { provider_modelId: { provider: input.provider, modelId: input.modelId } } });
  if (existing) return existing;
  return prisma.modelRegistry.create({
    data: {
      provider: input.provider,
      modelId: input.modelId,
      displayName: input.displayName ?? input.modelId,
      type: "video",
      enabled: false,
      lifecycle: "PIN_ONLY",
      verification: "UNVERIFIED",
      priceUnit: "per_second",
      price: 0,
      existenceSource: "ACCOUNT_LISTING",
      notes: "Phát hiện qua “Hỏi nhà cung cấp”. Chưa có giá, chưa benchmark - không tự định tuyến.",
    },
  });
}

export interface ConnectionCheck {
  provider: string;
  ok: boolean;
  auth: "OK" | "MISSING_KEY" | "FAILED" | "NOT_CHECKED";
  available: boolean;
  /** Registry models of this provider the vendor still lists, when it can say. */
  modelsListed: string[] | null;
  modelsMissing: string[];
  note: string;
  /** Always 0: the check never creates anything. */
  paidRequests: 0;
}

/**
 * "Kiểm tra kết nối": authentication, provider availability and - where the
 * API can list models - model availability. FREE reads only; no video is ever
 * created. In Mock Mode nothing leaves the machine.
 */
export async function testVideoProviderConnection(provider: string): Promise<ConnectionCheck> {
  const base = { provider, modelsListed: null, modelsMissing: [] as string[], paidRequests: 0 as const };
  if (isMockMode() || provider === "mock") {
    return { ...base, ok: true, auth: "NOT_CHECKED", available: true, note: "Chế độ mock: không gọi ra ngoài, không tốn phí." };
  }
  if (!hasVideoAdapter(provider)) {
    return { ...base, ok: false, auth: "NOT_CHECKED", available: false, note: `Chưa có adapter cho nhà cung cấp "${provider}".` };
  }
  try {
    await resolveApiKey(provider);
  } catch (err) {
    return {
      ...base,
      ok: false,
      auth: "MISSING_KEY",
      available: false,
      note: err instanceof ProviderConfigError ? err.message : "Chưa có API key.",
    };
  }
  const registry = await prisma.modelRegistry.findMany({ where: { provider, type: "video" }, select: { modelId: true } });

  if (provider === "runway") {
    // GET organization: authenticates and reads the credit balance. Free.
    const r = await refreshRunwayBalance();
    return { ...base, ok: r.ok, auth: r.ok ? "OK" : "FAILED", available: r.ok, note: r.ok ? `Kết nối OK. Số dư: ${r.credits ?? "?"} credit.` : r.note };
  }
  if (provider === "openai") {
    // GET /models: authenticates and lists models. Free.
    const d = await discoverModels(provider, "text");
    if (!d.ok) return { ...base, ok: false, auth: "FAILED", available: false, note: d.error ?? "Không đọc được danh sách model." };
    const listed = d.models.map((m) => m.id);
    const missing = registry.map((r) => r.modelId.split(":")[0]!).filter((id) => !listed.includes(id));
    return { ...base, ok: true, auth: "OK", available: true, modelsListed: listed, modelsMissing: [...new Set(missing)], note: "Kết nối OK." };
  }
  return { ...base, ok: true, auth: "OK", available: true, note: "Đã có API key. Nhà cung cấp này chưa có cách kiểm tra trực tuyến miễn phí." };
}
