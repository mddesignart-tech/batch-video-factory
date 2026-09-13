import { z } from "zod";

/**
 * Server-only environment access. Nothing here may be imported from a client
 * component - API keys must never cross into the browser bundle.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : v.toLowerCase() === "true"));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v);
      return v === undefined || v === "" || Number.isNaN(n) ? def : n;
    });

const EnvSchema = z.object({
  DATABASE_URL: z.string().default("file:../data/app.db"),
  AI_MOCK_MODE: bool(true),
  SECRET_ENCRYPTION_KEY: z.string().optional(),
  JOB_CONCURRENCY: int(2),
  JOB_WORKER_ENABLED: bool(true),
  FFMPEG_PATH: z.string().optional(),
  FFPROBE_PATH: z.string().optional(),
  CLEANUP_TEMP_DAYS: int(3),
  CLEANUP_FAILED_DAYS: int(7),
  CLEANUP_FINAL_DAYS: z.string().optional(),
  NODE_ENV: z.string().default("development"),
});

export type AppEnv = z.infer<typeof EnvSchema>;

let cached: AppEnv | null = null;

export function env(): AppEnv {
  if (!cached) cached = EnvSchema.parse(process.env);
  return cached;
}

/** Test helper: forget the memoised env after mutating process.env. */
export function resetEnvCache(): void {
  cached = null;
}

/**
 * Mock mode is the master safety switch. While it is on, no provider is allowed
 * to open a network connection or bill anything.
 */
export function isMockMode(): boolean {
  return env().AI_MOCK_MODE;
}

/** Env-var names checked when deciding whether a provider has a usable key. */
export const PROVIDER_ENV_VARS: Record<string, string> = {
  mock: "",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_AI_API_KEY",
  runway: "RUNWAY_API_KEY",
  kling: "KLING_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  text_ai: "TEXT_AI_API_KEY",
  voice_ai: "VOICE_API_KEY",
};

export function hasEnvKey(providerName: string): boolean {
  const varName = PROVIDER_ENV_VARS[providerName];
  if (varName === undefined) return false;
  if (varName === "") return true; // mock provider needs no key
  const value = process.env[varName];
  return typeof value === "string" && value.trim().length > 0;
}
