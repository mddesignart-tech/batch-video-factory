import { prisma } from "./prisma";
import { env } from "./env";
import { parseJson } from "./utils";

/**
 * App settings live in the DB so they survive restarts and can be edited from
 * the admin UI. Env vars provide the defaults on a fresh install.
 */

export interface AppSettings {
  defaultQualityMode: string;
  defaultRouterStrategy: string;
  defaultTargetDuration: number;
  defaultMaxBudget: number;
  jobConcurrency: number;
  workerEnabled: boolean;
  cleanupTempDays: number;
  cleanupFailedDays: number;
  cleanupFinalDays: number | null;
  burnSubtitles: boolean;
  maxRetries: number;
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
    jobConcurrency: e.JOB_CONCURRENCY,
    workerEnabled: e.JOB_WORKER_ENABLED,
    cleanupTempDays: e.CLEANUP_TEMP_DAYS,
    cleanupFailedDays: e.CLEANUP_FAILED_DAYS,
    // Final exports are kept indefinitely unless an operator opts in.
    cleanupFinalDays: Number.isFinite(finalDays) ? finalDays : null,
    burnSubtitles: true,
    maxRetries: 3,
  };
}

export async function getSettings(): Promise<AppSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  const stored = parseJson<Partial<AppSettings>>(row?.valueJson, {});
  return { ...defaultSettings(), ...stored };
}

export async function saveSettings(
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const next = { ...(await getSettings()), ...patch };
  const valueJson = JSON.stringify(next);
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, valueJson },
    update: { valueJson },
  });
  return next;
}
