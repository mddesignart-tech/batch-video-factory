import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { isMockMode } from "@/lib/env";
import {
  buildTextConfig,
  OPENAI_COMPATIBLE_PROVIDERS,
  TextConfigError,
} from "@/providers/text-config";

/**
 * Ask a provider which models it actually offers.
 *
 * Written after a real failure: the seed shipped `llama-3.3-70b-versatile`, Groq
 * removed it, and the first real call died with a 404. Model names are the
 * provider's data, not ours, so the registry has to be reconcilable against the
 * live list rather than trusted forever.
 *
 * Listing models is a free endpoint on every OpenAI-compatible API, so this
 * never costs anything and never needs the spend gate.
 */

export interface DiscoveredModel {
  id: string;
  contextWindow: number | null;
  ownedBy: string | null;
  /** Already present in ModelRegistry for this provider. */
  known: boolean;
}

export interface ModelDiscovery {
  provider: string;
  ok: boolean;
  error?: string;
  models: DiscoveredModel[];
  /** Registry rows whose model no longer exists upstream. */
  stale: string[];
}

interface ModelsResponse {
  data?: { id?: string; context_window?: number; owned_by?: string }[];
  error?: { message?: string };
}

/**
 * Models that are not chat models. Listing endpoints mix in speech, embedding
 * and moderation models, none of which can write a script.
 */
const NON_CHAT = /whisper|tts|embed|guard|moderation|orpheus|rerank|distil/i;

export async function discoverTextModels(
  providerName: string,
): Promise<ModelDiscovery> {
  if (isMockMode()) {
    return {
      provider: providerName,
      ok: false,
      error:
        "Đang ở chế độ mock nên không gọi ra ngoài. Đặt AI_MOCK_MODE=false để lấy danh sách thật.",
      models: [],
      stale: [],
    };
  }

  if (!OPENAI_COMPATIBLE_PROVIDERS.has(providerName)) {
    return {
      provider: providerName,
      ok: false,
      error: `Nhà cung cấp "${providerName}" chưa được tích hợp cho loại text.`,
      models: [],
      stale: [],
    };
  }

  let config;
  try {
    // Any enabled model of this provider will do - we only need its base URL and
    // key, not the model itself.
    const anyModel = await prisma.modelRegistry.findFirst({
      where: { provider: providerName, type: "text" },
      // Prefer an enabled row when there is one, but do not require it.
      orderBy: { enabled: "desc" },
    });
    if (!anyModel) {
      return {
        provider: providerName,
        ok: false,
        error: `Chưa có model text nào của ${providerName} trong bảng Mô hình AI.`,
        models: [],
        stale: [],
      };
    }
    config = await buildTextConfig(providerName, anyModel.modelId, false);
  } catch (err) {
    return {
      provider: providerName,
      ok: false,
      error:
        err instanceof TextConfigError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
      models: [],
      stale: [],
    };
  }

  const url = `${config.baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const headers: Record<string, string> = {};
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        provider: providerName,
        ok: false,
        error: `Nhà cung cấp trả về mã ${response.status}. ${body.slice(0, 200)}`,
        models: [],
        stale: [],
      };
    }

    const json = (await response.json()) as ModelsResponse;
    const ids = (json.data ?? [])
      .map((m) => ({
        id: m.id ?? "",
        contextWindow: m.context_window ?? null,
        ownedBy: m.owned_by ?? null,
      }))
      .filter((m) => m.id.length > 0 && !NON_CHAT.test(m.id));

    const registry = await prisma.modelRegistry.findMany({
      where: { provider: providerName, type: "text" },
      select: { modelId: true },
    });
    const registryIds = new Set(registry.map((r) => r.modelId));
    const liveIds = new Set(ids.map((m) => m.id));

    const models: DiscoveredModel[] = ids
      .map((m) => ({ ...m, known: registryIds.has(m.id) }))
      .sort((a, b) => a.id.localeCompare(b.id));

    // A registry row the provider no longer serves. Calling it gives a 404 at
    // the worst possible moment, so surface it before that happens.
    const stale = [...registryIds].filter((id) => !liveIds.has(id)).sort();

    await logger.info({
      event: "provider.models_listed",
      provider: providerName,
      message: `${models.length} model khả dụng, ${stale.length} model trong bảng đã lỗi thời.`,
    });

    return { provider: providerName, ok: true, models, stale };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      provider: providerName,
      ok: false,
      error: aborted
        ? "Quá thời gian chờ khi lấy danh sách model."
        : err instanceof Error
          ? err.message
          : String(err),
      models: [],
      stale: [],
    };
  } finally {
    clearTimeout(timer);
  }
}
