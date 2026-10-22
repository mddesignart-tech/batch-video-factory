import { prisma } from "@/lib/prisma";
import { parseJson } from "@/lib/utils";
import { ProviderError } from "@/providers/types";
import { mindHealth, mindVoices } from "@/providers/mindvoice/mind-voice-client";
import {
  MIND_ADAPTER_VERSION,
  MIND_DEFAULT_BASE_URL,
  MIND_ENGINES,
  MIND_LABEL,
  MIND_MODEL,
  MIND_OFFLINE_GUIDE,
  MIND_PROVIDER,
  type MindEngineId,
  type MindHealth,
  type MindVoice,
} from "@/domain/mind-voice";

/**
 * Mind Voice discovery (QĐ-145): what the running service says about itself,
 * kept in one Setting row.
 *
 * Kept, not just shown: the Voice Director reads voice -> engine and the
 * engine's model variant from here WITHOUT a network call, so a line's voice
 * key is the same whether Mind Voice happens to be running or not. A stopped
 * service therefore never makes finished audio look stale - render again stays
 * 0 TTS requests.
 */

export const MIND_CATALOG_SETTING = "mindvoice.catalog";

export interface MindCatalog {
  checkedAt: string;
  online: boolean;
  baseUrl: string;
  error: string | null;
  health: MindHealth | null;
  voices: MindVoice[];
}

/** The Mind Voice row of Nhà cung cấp AI and its one voice model: $0, PIN_ONLY, never the default. */
export async function ensureMindRegistry(): Promise<void> {
  await prisma.providerConfig.upsert({
    where: { name: MIND_PROVIDER },
    create: {
      name: MIND_PROVIDER,
      displayName: MIND_LABEL,
      types: JSON.stringify(["voice"]),
      enabled: true,
      apiKeyEnvVar: "",
      baseUrl: MIND_DEFAULT_BASE_URL,
      priority: 89,
      fallbackPriority: 89,
      status: "connected",
      notes: "TTS chạy tại máy bằng Mind Voice (VieNeu-TTS / Supertonic 3), chỉ localhost. $0, không ghi sổ chi, không bao giờ là dự phòng của nhà cung cấp trả phí.",
    },
    update: {},
  });
  await prisma.modelRegistry.upsert({
    where: { provider_modelId: { provider: MIND_PROVIDER, modelId: MIND_MODEL } },
    create: {
      provider: MIND_PROVIDER,
      modelId: MIND_MODEL,
      displayName: "Mind Voice (VieNeu-TTS v3 Turbo / Supertonic 3) — Local",
      type: "voice",
      enabled: true,
      priceUnit: "per_1k_chars",
      price: 0,
      supportsAudio: true,
      supportsVoiceInstructions: false,
      // Chosen only by a person (narrator voice / character), never by the router.
      lifecycle: "PIN_ONLY",
      notes: `${MIND_ENGINES.vieneu.attribution}. ${MIND_ENGINES.supertonic.attribution}. Adapter ${MIND_ADAPTER_VERSION}.`,
    },
    update: {},
  });
}

export async function mindBaseUrl(): Promise<string> {
  const row = await prisma.providerConfig.findUnique({ where: { name: MIND_PROVIDER }, select: { baseUrl: true } });
  return row?.baseUrl?.trim() || MIND_DEFAULT_BASE_URL;
}

export async function cachedMindCatalog(): Promise<MindCatalog | null> {
  const row = await prisma.setting.findUnique({ where: { key: MIND_CATALOG_SETTING } });
  return row ? parseJson<MindCatalog | null>(row.valueJson, null) : null;
}

/**
 * Ask the running service: /health and /voices. Offline is an answer, not an
 * error - the last known voices are kept so keys stay stable.
 */
export async function refreshMindCatalog(): Promise<MindCatalog> {
  await ensureMindRegistry();
  const baseUrl = await mindBaseUrl();
  const previous = await cachedMindCatalog();
  let catalog: MindCatalog;
  try {
    const health = await mindHealth(baseUrl);
    const voices = await mindVoices(baseUrl);
    catalog = { checkedAt: new Date().toISOString(), online: true, baseUrl, error: null, health, voices };
  } catch (err) {
    const offline = err instanceof ProviderError && err.code === "mind_offline";
    catalog = {
      checkedAt: new Date().toISOString(),
      online: false,
      baseUrl,
      error: offline ? MIND_OFFLINE_GUIDE : err instanceof Error ? err.message : String(err),
      health: previous?.health ?? null,
      voices: previous?.voices ?? [],
    };
  }
  await prisma.setting.upsert({
    where: { key: MIND_CATALOG_SETTING },
    create: { key: MIND_CATALOG_SETTING, valueJson: JSON.stringify(catalog) },
    update: { valueJson: JSON.stringify(catalog) },
  });
  return catalog;
}

/** The engine of a Mind Voice voice, from the kept catalog (no network). */
export function engineOfMindVoice(catalog: MindCatalog | null, voiceId: string): MindEngineId | null {
  return catalog?.voices.find((v) => v.id === voiceId)?.engine ?? null;
}

/** The installed model variant of an engine, from the kept catalog (no network). */
export function variantOfMindEngine(catalog: MindCatalog | null, engine: MindEngineId): string | null {
  return catalog?.health?.engines.find((e) => e.id === engine)?.variant ?? null;
}
