import { prisma } from "@/lib/prisma";
import { parseJson } from "@/lib/utils";
import { ProviderError } from "@/providers/types";
import { citApiSpec, citHealth, citVoices } from "@/providers/cit/cit-client";
import {
  CIT_ADAPTER_VERSION,
  CIT_DEFAULT_BASE_URL,
  CIT_ENGINES,
  CIT_LABEL,
  CIT_MODEL,
  CIT_OFFLINE_GUIDE,
  CIT_PROVIDER,
  engineLabel,
  type CitApiSpec,
  type CitEngineId,
  type CitHealth,
  type CitVoice,
} from "@/domain/cit";

/**
 * CIT Voice Studio discovery (QĐ-144): what the running CIT says about itself,
 * kept in one Setting row.
 *
 * Kept, not just shown: the Voice Director reads the voice -> engine map from
 * here WITHOUT a network call, so the voice key of a line is the same whether
 * CIT happens to be open or not. A closed CIT therefore never makes finished
 * audio look stale - render again stays 0 TTS requests.
 */

export const CIT_CATALOG_SETTING = "cit.catalog";

export interface CitCatalog {
  checkedAt: string;
  online: boolean;
  baseUrl: string;
  error: string | null;
  health: CitHealth | null;
  voices: CitVoice[];
  spec: CitApiSpec | null;
}

/** The CIT row of Nhà cung cấp AI and its one voice model: $0, PIN_ONLY, never the default. */
export async function ensureCitRegistry(): Promise<void> {
  await prisma.providerConfig.upsert({
    where: { name: CIT_PROVIDER },
    create: {
      name: CIT_PROVIDER,
      displayName: CIT_LABEL,
      types: JSON.stringify(["voice"]),
      enabled: true,
      apiKeyEnvVar: "",
      baseUrl: CIT_DEFAULT_BASE_URL,
      priority: 90,
      fallbackPriority: 90,
      status: "connected",
      notes: "TTS chạy tại máy qua Local API của CIT Voice Studio. $0, không ghi sổ chi, không bao giờ là dự phòng của nhà cung cấp trả phí.",
    },
    update: {},
  });
  await prisma.modelRegistry.upsert({
    where: { provider_modelId: { provider: CIT_PROVIDER, modelId: CIT_MODEL } },
    create: {
      provider: CIT_PROVIDER,
      modelId: CIT_MODEL,
      displayName: "CIT Voice Studio (VieNeu-TTS / Supertonic 3) — Local",
      type: "voice",
      enabled: true,
      priceUnit: "per_1k_chars",
      price: 0,
      supportsAudio: true,
      supportsVoiceInstructions: false,
      // Chosen only by a person (narrator voice / character), never by the router.
      lifecycle: "PIN_ONLY",
      notes: `${CIT_ENGINES.VIENEU.attribution}. ${CIT_ENGINES.SUPERTONIC.attribution}. Adapter ${CIT_ADAPTER_VERSION}.`,
    },
    update: {},
  });
}

export async function citBaseUrl(): Promise<string> {
  const row = await prisma.providerConfig.findUnique({ where: { name: CIT_PROVIDER }, select: { baseUrl: true } });
  return row?.baseUrl?.trim() || CIT_DEFAULT_BASE_URL;
}

export async function cachedCitCatalog(): Promise<CitCatalog | null> {
  const row = await prisma.setting.findUnique({ where: { key: CIT_CATALOG_SETTING } });
  return row ? parseJson<CitCatalog | null>(row.valueJson, null) : null;
}

/**
 * Ask the running CIT: /health, /voices, /openapi.json. Offline is an answer,
 * not an error - the last known voices are kept so keys stay stable.
 */
export async function refreshCitCatalog(): Promise<CitCatalog> {
  await ensureCitRegistry();
  const baseUrl = await citBaseUrl();
  const previous = await cachedCitCatalog();
  let catalog: CitCatalog;
  try {
    const health = await citHealth(baseUrl);
    const [listed, spec] = await Promise.all([citVoices(baseUrl), citApiSpec(baseUrl)]);
    // The real CIT's /voices names no engine per voice; when /health reports
    // exactly one known engine, every voice it lists is that engine's.
    const known = [...new Set(health.engines.map((e) => e.engine).filter((e) => e !== "UNKNOWN"))];
    const voices = known.length === 1 ? listed.map((v) => (v.engine === "UNKNOWN" ? { ...v, engine: known[0]! } : v)) : listed;
    catalog = { checkedAt: new Date().toISOString(), online: true, baseUrl, error: null, health, voices, spec };
  } catch (err) {
    const offline = err instanceof ProviderError && err.code === "cit_offline";
    catalog = {
      checkedAt: new Date().toISOString(),
      online: false,
      baseUrl,
      error: offline ? CIT_OFFLINE_GUIDE : err instanceof Error ? err.message : String(err),
      health: previous?.health ?? null,
      voices: previous?.voices ?? [],
      spec: previous?.spec ?? null,
    };
  }
  await prisma.setting.upsert({
    where: { key: CIT_CATALOG_SETTING },
    create: { key: CIT_CATALOG_SETTING, valueJson: JSON.stringify(catalog) },
    update: { valueJson: JSON.stringify(catalog) },
  });
  return catalog;
}

/** The engine of a CIT voice, from the kept catalog (no network). */
export function engineOfVoice(catalog: CitCatalog | null, voiceId: string): CitEngineId {
  return catalog?.voices.find((v) => v.id === voiceId)?.engine ?? "UNKNOWN";
}

/** What the VIDEO OUTPUT card shows (Vietnamese, plain). */
export interface CitStatusView {
  label: string;
  online: boolean;
  baseUrl: string;
  checkedAt: string;
  message: string;
  version: string | null;
  languages: string[];
  engines: { id: CitEngineId; label: string; name: string; installed: boolean | null; license: string | null }[];
  voices: { id: string; label: string; engine: CitEngineId; engineLabel: string; languages: string[]; gender: string | null }[];
  voiceCount: number;
  pronunciation: string;
  conversation: boolean;
  generateFields: string[];
}

export function citStatusView(c: CitCatalog): CitStatusView {
  const engines = (c.health?.engines ?? []).map((e) => ({
    id: e.engine,
    label: engineLabel(e.engine),
    name: e.name,
    installed: e.installed,
    license: e.engine === "UNKNOWN" ? null : CIT_ENGINES[e.engine].license,
  }));
  return {
    label: CIT_LABEL,
    online: c.online,
    baseUrl: c.baseUrl,
    checkedAt: c.checkedAt,
    message: c.online ? `Đang chạy · ${c.voices.length} giọng` : `Offline. ${c.error ?? CIT_OFFLINE_GUIDE}`,
    version: c.health?.version ?? null,
    languages: c.health?.languages ?? [],
    engines,
    voices: c.voices.map((v) => ({ id: v.id, label: v.label, engine: v.engine, engineLabel: engineLabel(v.engine), languages: v.languages, gender: v.gender })),
    voiceCount: c.voices.length,
    // Phase 1 reads, never writes, the person's dictionary.
    pronunciation:
      c.spec && c.spec.pronunciationPaths.length > 0
        ? `Từ điển phát âm có trong API (${c.spec.pronunciationPaths.join(", ")}) - CIT tự áp dụng; ứng dụng này không sửa từ điển.`
        : "Từ điển phát âm do CIT tự áp dụng khi đọc (Từ điển trong CIT); ứng dụng này không sửa từ điển.",
    conversation: c.spec?.conversation ?? false,
    generateFields: c.spec?.generate?.fields ?? ["text", "voice_id"],
  };
}
