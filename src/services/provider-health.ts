import type { ProviderConfig } from "@prisma/client";
import type { ProviderStatus } from "@/domain/enums";
import { hasEnvKey, isMockMode } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { parseJson } from "@/lib/utils";
import { isProviderImplemented } from "@/providers/registry";
import { getConnectivity } from "./connectivity";

/**
 * Provider availability.
 *
 * Status is derived from configuration - is it enabled, is there a key, is it
 * actually implemented - rather than from live pinging. Hammering vendor APIs
 * just to render a green dot costs money and rate limit budget for no benefit.
 * A real reachability check happens only when the operator explicitly asks.
 */

export interface ProviderHealth {
  name: string;
  displayName: string;
  enabled: boolean;
  apiConfigured: boolean;
  implemented: boolean;
  status: ProviderStatus;
  types: string[];
  priority: number;
  fallbackPriority: number;
  apiKeyMask: string | null;
  modelCount: number;
  lastCheckedAt: Date | null;
  note: string;
}

export function deriveStatus(
  config: Pick<ProviderConfig, "name" | "enabled" | "apiKeyEnc" | "status">,
  online: boolean,
): ProviderStatus {
  // Mock mode makes every provider slot answerable locally, so nothing is
  // reported as broken just because the operator has no keys yet.
  if (isMockMode()) return config.name === "mock" ? "connected" : "disabled";
  if (!config.enabled) return "disabled";
  if (!isProviderImplemented(config.name)) return "unavailable";
  const hasKey = config.apiKeyEnc !== null || hasEnvKey(config.name);
  if (!hasKey) return "missing_key";
  if (!online) return "unavailable";
  if (config.status === "rate_limited") return "rate_limited";
  return "connected";
}

export async function listProviderHealth(): Promise<ProviderHealth[]> {
  const [configs, modelCounts, connectivity] = await Promise.all([
    prisma.providerConfig.findMany({ orderBy: { priority: "asc" } }),
    prisma.modelRegistry.groupBy({
      by: ["provider"],
      _count: { _all: true },
    }),
    getConnectivity(),
  ]);

  const counts = new Map(
    modelCounts.map((row) => [row.provider, row._count._all]),
  );
  const online = connectivity === "ONLINE";

  return configs.map((config) => {
    const status = deriveStatus(config, online);
    return {
      name: config.name,
      displayName: config.displayName,
      enabled: config.enabled,
      apiConfigured: config.apiKeyEnc !== null || hasEnvKey(config.name),
      implemented: isProviderImplemented(config.name),
      status,
      types: parseJson<string[]>(config.types, []),
      priority: config.priority,
      fallbackPriority: config.fallbackPriority,
      // Only ever the mask. The plaintext key has no path to the browser.
      apiKeyMask: config.apiKeyMask,
      modelCount: counts.get(config.name) ?? 0,
      lastCheckedAt: config.lastCheckedAt,
      note: noteFor(status, config.name),
    };
  });
}

function noteFor(status: ProviderStatus, name: string): string {
  switch (status) {
    case "connected":
      return isMockMode() ? "Đang chạy ở chế độ mock (không tốn phí)" : "Sẵn sàng";
    case "missing_key":
      return "Chưa có API key. Thêm vào .env hoặc trong trang Nhà cung cấp AI.";
    case "unavailable":
      return isProviderImplemented(name)
        ? "Không có kết nối Internet."
        : "Chưa được tích hợp trong phiên bản này (Milestone 2).";
    case "rate_limited":
      return "Đang bị giới hạn tần suất. Router sẽ tự chuyển sang nhà cung cấp dự phòng.";
    case "disabled":
    default:
      return "Đã tắt.";
  }
}

/**
 * Provider names the router may pick from right now. Everything downstream -
 * routing, cost preview, generation - filters through this one list.
 */
export async function availableProviderNames(): Promise<string[]> {
  if (isMockMode()) return ["mock"];
  const health = await listProviderHealth();
  return health
    .filter((h) => h.status === "connected")
    .sort((a, b) => a.priority - b.priority)
    .map((h) => h.name);
}

/**
 * Fallback order for a given provider: everything else that is usable, ordered
 * by its configured fallback priority.
 */
export async function fallbackChain(primary: string): Promise<string[]> {
  const health = await listProviderHealth();
  return health
    .filter((h) => h.name !== primary && h.status === "connected")
    .sort((a, b) => a.fallbackPriority - b.fallbackPriority)
    .map((h) => h.name);
}

export async function markRateLimited(name: string): Promise<void> {
  await prisma.providerConfig.updateMany({
    where: { name },
    data: { status: "rate_limited", lastCheckedAt: new Date() },
  });
}

export async function clearRateLimit(name: string): Promise<void> {
  await prisma.providerConfig.updateMany({
    where: { name, status: "rate_limited" },
    data: { status: "connected", lastCheckedAt: new Date() },
  });
}
