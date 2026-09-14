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

/**
 * Providers that need no key at all.
 *
 * `mock` runs in-process; Ollama and LM Studio run on this machine. Everything
 * else must prove it has a key before the router will consider it.
 */
export const KEYLESS_PROVIDERS = new Set(["mock", "ollama", "lmstudio"]);

/** Conventional env-var name for a provider that has not declared one. */
export function defaultEnvVarFor(providerName: string): string {
  return `${providerName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/**
 * Extra env-var names a vendor is known by, tried in order.
 *
 * Some vendors document a name that does not match our NAME_API_KEY
 * convention. Runway's own SDK and docs read `RUNWAYML_API_SECRET`, so someone
 * following Runway's quickstart pastes the key under that name and our
 * convention would report "missing key" with the key sitting right there.
 *
 * The vendor's documented name comes FIRST so a project following the vendor's
 * instructions works untouched; our conventional name stays as a fallback so
 * existing .env files keep working.
 */
export const ENV_VAR_ALIASES: Record<string, readonly string[]> = {
  runway: ["RUNWAYML_API_SECRET", "RUNWAY_API_KEY"],
  google: ["GOOGLE_AI_API_KEY", "GEMINI_API_KEY"],
};

/** Every env-var name to try for this provider, most-official first. */
export function envVarCandidates(
  providerName: string,
  configured?: string,
): string[] {
  const names: string[] = [];
  if (configured && configured.trim().length > 0) names.push(configured.trim());
  for (const alias of ENV_VAR_ALIASES[providerName] ?? []) names.push(alias);
  names.push(defaultEnvVarFor(providerName));
  return [...new Set(names)];
}

/**
 * First env var that actually holds a value, or null.
 *
 * Returns the NAME, never the value, so callers can report which variable was
 * used without the key itself reaching a log line.
 */
export function resolvedEnvVarName(
  providerName: string,
  configured?: string,
): string | null {
  for (const name of envVarCandidates(providerName, configured)) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim().length > 0) return name;
  }
  return null;
}

/**
 * Does this provider have a usable key in the environment?
 *
 * The env-var name comes from the provider row (`apiKeyEnvVar`), falling back to
 * the conventional NAME_API_KEY. This used to be a hard-coded table, which meant
 * adding a provider silently made it invisible to the router: it was reported as
 * "missing key" forever even with the key sitting right there in .env. That bug
 * is why a real Groq key still routed to mock on the first end-to-end run.
 */
export function hasEnvKey(providerName: string, envVar?: string): boolean {
  if (KEYLESS_PROVIDERS.has(providerName)) return true;
  return resolvedEnvVarName(providerName, envVar) !== null;
}
