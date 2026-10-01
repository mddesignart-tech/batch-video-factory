import { prisma } from "./prisma";
import { env } from "./env";
import { parseJson } from "./utils";
import { DEFAULT_MIX, resolveMix, type AudioMixSettings } from "@/media/mix-config";
import { DEFAULT_PRESET_ID, outputPresetSchema, type OutputPreset } from "@/domain/output-preset";
import { DEFAULT_SOCIAL_TEMPLATES, type SocialTemplates } from "@/domain/social-metadata";

/**
 * App settings live in the DB so they survive restarts and can be edited from
 * the admin UI. Env vars provide the defaults on a fresh install.
 */

export interface AppSettings {
  defaultQualityMode: string;
  defaultRouterStrategy: string;
  defaultTargetDuration: number;
  defaultMaxBudget: number;
  /**
   * Per-video spend limit an imported video gets when its storyboard names
   * none (V1.2, QĐ-108). A limit, not a target: it never raises anything and
   * never sits above the global cap.
   */
  defaultMaxCostPerVideo: number;
  /**
   * Cap on what ONE VIDEO_AI scene may spend, when the storyboard names none.
   * Null = no scene cap (only the video / batch / global limits apply).
   */
  defaultMaxCostVideoAiScene: number | null;
  /**
   * How far an identical, already-paid asset may be reused (QĐ-112):
   *   GLOBAL   any scene of any project (default - importing the same storyboard
   *            again buys nothing it already has)
   *   PROJECT  only within the same video
   *   SCENE    only the scene's own assets (the pre-Phase-4 behaviour)
   * `ASSET_REUSE_SCOPE` in the environment overrides it (the test suite runs
   * SCENE so its files, which share one database, stay independent).
   */
  assetReuseScope: "GLOBAL" | "PROJECT" | "SCENE";
  /**
   * Paid AI quality scoring (QĐ-113). OFF by default: estimates show its price as
   * OPTIONAL and never add it to what a run needs; a paid scoring provider is not
   * called. A free/local scorer (mock) is unaffected.
   */
  aiPaidQa: boolean;
  jobConcurrency: number;
  workerEnabled: boolean;
  cleanupTempDays: number;
  cleanupFailedDays: number;
  cleanupFinalDays: number | null;
  burnSubtitles: boolean;
  maxRetries: number;
  /**
   * How the three audio layers sit against each other.
   *
   * Stored with the rest of the app settings rather than per project: an
   * operator tunes these once by ear and wants every video to match. A project
   * may still override at render time.
   */
  audioMix: AudioMixSettings;
  /** V1.2 Phase 6 (QĐ-114): preset a new batch renders/exports with. */
  defaultOutputPresetId: string;
  /** PARTIAL: a blocked video never stops the others. STRICT: any blocker = no start. */
  defaultBatchMode: "PARTIAL" | "STRICT";
  /** Videos one batch run works on at the same time (1 = one after another). */
  maxConcurrentVideos: number;
  /** FFmpeg final renders at the same time, across every run in this app. */
  maxConcurrentLocalRenders: number;
  /** Media steps that may send a paid request at the same time, across every run. */
  maxConcurrentPaidRequests: number;
  /** Presets the person made. Built-ins are not stored. */
  customPresets: OutputPreset[];
  /** Title / description templates for metadata.json and description.txt. */
  socialTemplates: SocialTemplates;
}

/** Hard bounds: more parallelism than this buys SQLite contention, not speed. */
export const CONCURRENCY_LIMITS = {
  maxConcurrentVideos: { min: 1, max: 4 },
  maxConcurrentLocalRenders: { min: 1, max: 2 },
  maxConcurrentPaidRequests: { min: 1, max: 2 },
} as const;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Stored values are data from an older version or a hand edit: bound them. */
function sanitizeDaily(s: AppSettings): AppSettings {
  const presets = Array.isArray(s.customPresets)
    ? s.customPresets.filter((p) => outputPresetSchema.safeParse(p).success)
    : [];
  return {
    ...s,
    defaultBatchMode: s.defaultBatchMode === "STRICT" ? "STRICT" : "PARTIAL",
    maxConcurrentVideos: clampInt(s.maxConcurrentVideos, 1, CONCURRENCY_LIMITS.maxConcurrentVideos.max, 1),
    maxConcurrentLocalRenders: clampInt(s.maxConcurrentLocalRenders, 1, CONCURRENCY_LIMITS.maxConcurrentLocalRenders.max, 1),
    maxConcurrentPaidRequests: clampInt(s.maxConcurrentPaidRequests, 1, CONCURRENCY_LIMITS.maxConcurrentPaidRequests.max, 1),
    customPresets: presets,
    defaultOutputPresetId:
      typeof s.defaultOutputPresetId === "string" && s.defaultOutputPresetId ? s.defaultOutputPresetId : DEFAULT_PRESET_ID,
    socialTemplates: {
      title: typeof s.socialTemplates?.title === "string" ? s.socialTemplates.title : DEFAULT_SOCIAL_TEMPLATES.title,
      description:
        typeof s.socialTemplates?.description === "string" ? s.socialTemplates.description : DEFAULT_SOCIAL_TEMPLATES.description,
    },
  };
}

export const SETTINGS_KEY = "app.settings";

export function defaultSettings(): AppSettings {
  const e = env();
  const finalDays = e.CLEANUP_FINAL_DAYS
    ? Number(e.CLEANUP_FINAL_DAYS)
    : Number.NaN;
  return {
    defaultQualityMode: "BALANCED",
    defaultRouterStrategy: "AUTO",
    defaultTargetDuration: 25,
    defaultMaxBudget: 10,
    defaultMaxCostPerVideo: 1.5,
    defaultMaxCostVideoAiScene: null,
    assetReuseScope: "GLOBAL",
    aiPaidQa: false,
    jobConcurrency: e.JOB_CONCURRENCY,
    workerEnabled: e.JOB_WORKER_ENABLED,
    cleanupTempDays: e.CLEANUP_TEMP_DAYS,
    cleanupFailedDays: e.CLEANUP_FAILED_DAYS,
    // Final exports are kept indefinitely unless an operator opts in.
    cleanupFinalDays: Number.isFinite(finalDays) ? finalDays : null,
    burnSubtitles: true,
    maxRetries: 3,
    audioMix: { ...DEFAULT_MIX },
    defaultOutputPresetId: DEFAULT_PRESET_ID,
    defaultBatchMode: "PARTIAL",
    maxConcurrentVideos: 1,
    maxConcurrentLocalRenders: 1,
    maxConcurrentPaidRequests: 1,
    customPresets: [],
    socialTemplates: { ...DEFAULT_SOCIAL_TEMPLATES },
  };
}

export async function getSettings(): Promise<AppSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  const stored = parseJson<Partial<AppSettings>>(row?.valueJson, {});
  const base = defaultSettings();
  return sanitizeDaily({
    ...base,
    ...stored,
    // A nested object would otherwise be replaced wholesale by a stored value
    // written before a knob existed, leaving that knob undefined. resolveMix
    // also clamps anything out of range, so a bad stored value cannot reach a
    // render.
    audioMix: resolveMix({ ...base.audioMix, ...(stored.audioMix ?? {}) }),
  });
}

export async function saveSettings(
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const current = await getSettings();
  const next = sanitizeDaily({
    ...current,
    ...patch,
    audioMix: resolveMix({ ...current.audioMix, ...(patch.audioMix ?? {}) }),
  });
  const valueJson = JSON.stringify(next);
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, valueJson },
    update: { valueJson },
  });
  return next;
}
