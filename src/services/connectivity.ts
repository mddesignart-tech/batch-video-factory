import { isMockMode } from "@/lib/env";

/**
 * ConnectivityService.
 *
 * The app is local-first: losing the Internet must never break editing, browsing
 * or rendering. This service is the single place the UI asks "can we reach an
 * external AI right now?", and it is deliberately cheap - one short-timeout HEAD
 * request, cached for 30 seconds, never a per-provider ping storm.
 */

export type Connectivity = "ONLINE" | "OFFLINE";

export const OFFLINE_MESSAGE =
  "Không có kết nối Internet. Bạn vẫn có thể chỉnh sửa dự án, quản lý nội dung và render các media đã có.";

const CACHE_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;
const PROBE_URLS = [
  "https://www.gstatic.com/generate_204",
  "https://cloudflare.com/cdn-cgi/trace",
];

let cached: { status: Connectivity; at: number } | null = null;

async function probe(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    return res.ok || res.status === 204;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function getConnectivity(
  opts: { force?: boolean } = {},
): Promise<Connectivity> {
  // In mock mode nothing external is ever contacted, so there is no reason to
  // probe - and no reason to disable any control in the UI.
  if (isMockMode()) return "ONLINE";

  const now = Date.now();
  if (!opts.force && cached && now - cached.at < CACHE_MS) return cached.status;

  const results = await Promise.all(PROBE_URLS.map(probe));
  const status: Connectivity = results.some(Boolean) ? "ONLINE" : "OFFLINE";
  cached = { status, at: now };
  return status;
}

export function resetConnectivityCache(): void {
  cached = null;
}

/**
 * Local work that must keep functioning with the network unplugged. Anything not
 * on this list is an external-AI feature and gets disabled gracefully offline.
 */
export const OFFLINE_CAPABLE_FEATURES = [
  "dashboard",
  "idioms",
  "characters",
  "style-presets",
  "projects",
  "script-editing",
  "storyboard-editing",
  "media-browser",
  "video-preview",
  "cost-history",
  "logs",
  "ffmpeg-render",
  "subtitles",
  "audio-mixing",
  "mp4-export",
  "mock-generation",
] as const;

export type OfflineCapableFeature = (typeof OFFLINE_CAPABLE_FEATURES)[number];

export function isOfflineCapable(feature: string): boolean {
  return (OFFLINE_CAPABLE_FEATURES as readonly string[]).includes(feature);
}

/** Mock mode keeps generation available offline; real providers do not. */
export function canGenerate(status: Connectivity): boolean {
  return isMockMode() || status === "ONLINE";
}
