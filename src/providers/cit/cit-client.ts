import { ProviderError } from "@/providers/types";
import {
  CIT_DOCUMENTED_GENERATE,
  CIT_OFFLINE_GUIDE,
  CIT_PROVIDER,
  clampCitSpeed,
  parseCitHealth,
  parseCitOpenApi,
  parseCitVoices,
  type CitApiSpec,
  type CitGenerateSchema,
  type CitHealth,
  type CitVoice,
} from "@/domain/cit";

/**
 * HTTP client for CIT Voice Studio's documented LOCAL API (QĐ-144).
 *
 * Only the public endpoints: /health, /voices, /openapi.json and
 * POST /api/tts/generate. No key on the same machine (the README: local calls
 * need none). A connection that cannot be made is CIT_OFFLINE - never retried
 * on another provider, because every other voice provider costs money.
 */

export const CIT_STATUS_TIMEOUT_MS = 4_000;
export const CIT_GENERATE_TIMEOUT_MS = 180_000;

export function citOffline(detail: string): ProviderError {
  return new ProviderError(`CIT_OFFLINE: ${CIT_OFFLINE_GUIDE} (${detail})`, CIT_PROVIDER, false, "cit_offline");
}

async function request(baseUrl: string, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, { ...init, signal: controller.signal });
  } catch (err) {
    const why = controller.signal.aborted ? `quá ${Math.round(timeoutMs / 1000)} s không phản hồi` : err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw citOffline(`${path}: ${why}`);
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(baseUrl: string, path: string): Promise<unknown> {
  const r = await request(baseUrl, path, { method: "GET" }, CIT_STATUS_TIMEOUT_MS);
  if (!r.ok) throw new ProviderError(`CIT ${path} trả HTTP ${r.status}.`, CIT_PROVIDER, false, `cit_http_${r.status}`);
  return r.json();
}

/** GET /health. Throws CIT_OFFLINE when nothing answers. */
export async function citHealth(baseUrl: string): Promise<CitHealth> {
  return parseCitHealth(await getJson(baseUrl, "/health"));
}

/** GET /voices - the voices CIT really has, never a list of our own. */
export async function citVoices(baseUrl: string): Promise<CitVoice[]> {
  return parseCitVoices(await getJson(baseUrl, "/voices"));
}

/** GET /openapi.json; null when CIT does not serve it. */
export async function citApiSpec(baseUrl: string): Promise<CitApiSpec | null> {
  try {
    return parseCitOpenApi(await getJson(baseUrl, "/openapi.json"));
  } catch (err) {
    if (err instanceof ProviderError && err.code === "cit_offline") throw err;
    return null;
  }
}

export interface CitGenerateRequest {
  text: string;
  voiceId: string;
  speed: number;
  language: string | null;
}

/** Only the fields the running CIT declares (text + voice_id are documented). */
export function citGenerateBody(schema: CitGenerateSchema | null, req: CitGenerateRequest): Record<string, string | number> {
  const s = schema ?? CIT_DOCUMENTED_GENERATE;
  const has = (f: string) => s.fields.includes(f);
  const body: Record<string, string | number> = { text: req.text, voice_id: req.voiceId };
  if (has("speed")) body.speed = clampCitSpeed(req.speed, s.speed);
  if (has("language") && req.language && (s.languages.length === 0 || s.languages.includes(req.language))) body.language = req.language;
  const formatKey = ["format", "output_format", "response_format"].find(has);
  if (formatKey && (s.formats.length === 0 || s.formats.includes("wav"))) body[formatKey] = "wav";
  return body;
}

/** POST /api/tts/generate -> the audio bytes. */
export async function citGenerate(
  baseUrl: string,
  schema: CitGenerateSchema | null,
  req: CitGenerateRequest,
  timeoutMs = CIT_GENERATE_TIMEOUT_MS,
): Promise<{ bytes: Buffer; contentType: string; body: Record<string, string | number> }> {
  const body = citGenerateBody(schema, req);
  const form = (schema ?? CIT_DOCUMENTED_GENERATE).bodyType === "form";
  const r = await request(
    baseUrl,
    "/api/tts/generate",
    form
      ? { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString() }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    timeoutMs,
  );
  const contentType = r.headers.get("content-type") ?? "";
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 300);
    throw new ProviderError(`CIT /api/tts/generate trả HTTP ${r.status}: ${detail}`, CIT_PROVIDER, false, `cit_http_${r.status}`);
  }
  if (contentType.includes("json") || contentType.startsWith("text/")) {
    const detail = (await r.text().catch(() => "")).slice(0, 300);
    throw new ProviderError(`CIT trả ${contentType || "văn bản"} thay vì âm thanh: ${detail}`, CIT_PROVIDER, false, "cit_not_audio");
  }
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.byteLength === 0) throw new ProviderError("CIT trả về tệp âm thanh rỗng.", CIT_PROVIDER, false, "cit_empty_audio");
  return { bytes, contentType, body };
}
