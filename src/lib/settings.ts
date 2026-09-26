import { prisma } from "./prisma";
import { env } from "./env";
import { parseJson } from "./utils";
import { DEFAULT_MIX, resolveMix, type AudioMixSettings } from "@/media/mix-config";

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
    jobConcurrency: e.JOB_CONCURRENCY,
    workerEnabled: e.JOB_WORKER_ENABLED,
    cleanupTempDays: e.CLEANUP_TEMP_DAYS,
    cleanupFailedDays: e.CLEANUP_FAILED_DAYS,
    // Final exports are kept indefinitely unless an operator opts in.
    cleanupFinalDays: Number.isFinite(finalDays) ? finalDays : null,
    burnSubtitles: true,
    maxRetries: 3,
    audioMix: { ...DEFAULT_MIX },
  };
}

export async function getSettings(): Promise<AppSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  const stored = parseJson<Partial<AppSettings>>(row?.valueJson, {});
  const base = defaultSettings();
  return {
    ...base,
    ...stored,
    // A nested object would otherwise be replaced wholesale by a stored value
    // written before a knob existed, leaving that knob undefined. resolveMix
    // also clamps anything out of range, so a bad stored value cannot reach a
    // render.
    audioMix: resolveMix({ ...base.audioMix, ...(stored.audioMix ?? {}) }),
  };
}

export async function saveSettings(
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    audioMix: resolveMix({ ...current.audioMix, ...(patch.audioMix ?? {}) }),
  };
  const valueJson = JSON.stringify(next);
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, valueJson },
    update: { valueJson },
  });
  return next;
}
