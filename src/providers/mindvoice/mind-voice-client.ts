import { ProviderError } from "@/providers/types";
import { MIND_OFFLINE_GUIDE, MIND_PROVIDER, parseMindHealth, parseMindVoices, type MindEngineId, type MindHealth, type MindVoice } from "@/domain/mind-voice";

/**
 * HTTP client for the Mind Voice service (QĐ-145), localhost only.
 *
 * A connection that cannot be made is MIND_OFFLINE - never retried on another
 * provider, because every other voice provider costs money.
 */

export const MIND_STATUS_TIMEOUT_MS = 4_000;
export const MIND_GENERATE_TIMEOUT_MS = 300_000;

export function mindOffline(detail: string): ProviderError {
  return new ProviderError(`MIND_OFFLINE: ${MIND_OFFLINE_GUIDE} (${detail})`, MIND_PROVIDER, false, "mind_offline");
}

async function request(baseUrl: string, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, { ...init, signal: controller.signal });
  } catch (err) {
    const why = controller.signal.aborted ? `quá ${Math.round(timeoutMs / 1000)} s không phản hồi` : err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw mindOffline(`${path}: ${why}`);
  } finally {
    clearTimeout(timer);
  }
}

/** The service's own `{ error: { code, message } }`, as a ProviderError. */
async function failure(r: Response, path: string): Promise<ProviderError> {
  let code = `mind_http_${r.status}`;
  let message = `Mind Voice ${path} trả HTTP ${r.status}.`;
  try {
    const body = (await r.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code) code = `mind_${body.error.code.toLowerCase()}`;
    if (body.error?.message) message = body.error.message;
  } catch {
    // not JSON - keep the status line
  }
  return new ProviderError(message, MIND_PROVIDER, false, code);
}

async function getJson(baseUrl: string, path: string, timeoutMs = MIND_STATUS_TIMEOUT_MS): Promise<unknown> {
  const r = await request(baseUrl, path, { method: "GET" }, timeoutMs);
  if (!r.ok) throw await failure(r, path);
  return r.json();
}

async function postJson(baseUrl: string, path: string, body: unknown, timeoutMs = MIND_STATUS_TIMEOUT_MS): Promise<unknown> {
  const r = await request(baseUrl, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeoutMs);
  if (!r.ok) throw await failure(r, path);
  return r.json();
}

export async function mindHealth(baseUrl: string): Promise<MindHealth> {
  return parseMindHealth(await getJson(baseUrl, "/health"));
}

export async function mindVoices(baseUrl: string): Promise<MindVoice[]> {
  return parseMindVoices(await getJson(baseUrl, "/voices"));
}

/** Model Manager status, raw from the service (shown, not interpreted). */
export async function mindModels(baseUrl: string, remote: boolean): Promise<unknown> {
  return getJson(baseUrl, `/models${remote ? "?remote=1" : ""}`, remote ? 20_000 : MIND_STATUS_TIMEOUT_MS);
}

export async function mindInstall(baseUrl: string, engine: MindEngineId, variant: string | null): Promise<unknown> {
  return postJson(baseUrl, "/models/install", { engine, ...(variant ? { variant } : {}) });
}

export async function mindVerify(baseUrl: string, engine: MindEngineId): Promise<{ ok: boolean; message: string; bad: string[] }> {
  return (await postJson(baseUrl, "/models/verify", { engine }, 120_000)) as { ok: boolean; message: string; bad: string[] };
}

export interface MindTtsRequest {
  engine: MindEngineId;
  voice: string;
  text: string;
  language: string;
  speed: number;
}

export interface MindTtsResult {
  bytes: Buffer;
  sampleRate: number;
  durationSec: number;
  variant: string;
  /** False = the engine read at 1x; the caller applies the speed. */
  speedApplied: boolean;
  body: MindTtsRequest;
}

/** POST /tts -> WAV bytes. */
export async function mindTts(baseUrl: string, req: MindTtsRequest, timeoutMs = MIND_GENERATE_TIMEOUT_MS): Promise<MindTtsResult> {
  const r = await request(baseUrl, "/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) }, timeoutMs);
  if (!r.ok) throw await failure(r, "/tts");
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.byteLength === 0) throw new ProviderError("Mind Voice trả về tệp âm thanh rỗng.", MIND_PROVIDER, false, "mind_empty_audio");
  return {
    bytes,
    sampleRate: Number(r.headers.get("x-sample-rate") ?? 0),
    durationSec: Number(r.headers.get("x-duration") ?? 0),
    variant: r.headers.get("x-engine-variant") ?? "",
    speedApplied: r.headers.get("x-speed-applied") === "1",
    body: req,
  };
}
