/**
 * "Bạn muốn đăng video ở đâu?" - platform presets and the project OUTPUT
 * PROFILE (QĐ-121). Pure: no database, no FFmpeg.
 *
 * Two shapes, deliberately kept apart:
 *
 *   project.aspectRatio   the shape pictures and clips are MADE in (it is in
 *                         every image/clip reuse key - changing it re-buys)
 *   output profile        the shape the video is RENDERED in (local, $0)
 *
 * A new project sets both from the platform. Changing the platform of a
 * project that already has assets changes only the output: the assets are
 * cropped / fitted locally, nothing is bought. Re-making the assets in the new
 * shape is a separate, explicit, priced choice.
 *
 * A platform is only a frame preset. Nothing here uploads anywhere.
 */

export const PLATFORM_IDS = [
  "TIKTOK",
  "YOUTUBE_SHORTS",
  "INSTAGRAM_REELS",
  "FACEBOOK_REELS",
  "YOUTUBE_LANDSCAPE",
  "SQUARE",
  "INSTAGRAM_FEED",
  "CUSTOM",
] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

/** The engines behind the platforms: TikTok / Shorts / Reels share one. */
export type OutputShape = "VERTICAL_SHORT_9_16" | "LANDSCAPE_16_9" | "SQUARE_1_1" | "PORTRAIT_FEED_4_5" | "CUSTOM";

export const FIT_MODES = ["AUTO", "COVER", "CONTAIN"] as const;
export type FitMode = (typeof FIT_MODES)[number];

/** Vietnamese labels: no "object-fit" vocabulary for a person. */
export const VI_FIT_MODE: Record<FitMode, string> = {
  AUTO: "Tự động – Khuyên dùng",
  COVER: "Lấp đầy khung",
  CONTAIN: "Hiện toàn bộ",
};

export interface PlatformPreset {
  id: PlatformId;
  label: string;
  icon: string;
  shape: OutputShape;
  width: number;
  height: number;
  fps: number;
  /** One line a non-technical person reads. */
  hint: string;
  /** Built-in export preset (QĐ-114) for subtitles / thumbnail / text files. */
  exportPresetId: string;
}

const V = { width: 1080, height: 1920, fps: 30, shape: "VERTICAL_SHORT_9_16" as const, hint: "Video dọc – phù hợp TikTok, Shorts, Reels" };

export const PLATFORM_PRESETS: readonly PlatformPreset[] = [
  { id: "TIKTOK", label: "TikTok", icon: "📱", ...V, exportPresetId: "tiktok" },
  { id: "YOUTUBE_SHORTS", label: "YouTube Shorts", icon: "▶", ...V, exportPresetId: "youtube-shorts" },
  { id: "INSTAGRAM_REELS", label: "Instagram Reels", icon: "📸", ...V, exportPresetId: "instagram-reels" },
  { id: "FACEBOOK_REELS", label: "Facebook Reels", icon: "📘", ...V, exportPresetId: "facebook-reels" },
  {
    id: "YOUTUBE_LANDSCAPE",
    label: "YouTube ngang",
    icon: "🖥",
    shape: "LANDSCAPE_16_9",
    width: 1920,
    height: 1080,
    fps: 30,
    hint: "Video ngang – phù hợp YouTube thường",
    exportPresetId: "youtube-landscape",
  },
  { id: "SQUARE", label: "Bài đăng vuông", icon: "⬜", shape: "SQUARE_1_1", width: 1080, height: 1080, fps: 30, hint: "Video vuông – bài đăng Facebook / Instagram", exportPresetId: "square" },
  {
    id: "INSTAGRAM_FEED",
    label: "Instagram Feed dọc",
    icon: "🖼",
    shape: "PORTRAIT_FEED_4_5",
    width: 1080,
    height: 1350,
    fps: 30,
    hint: "Video dọc 4:5 – bài đăng Instagram / Facebook",
    exportPresetId: "instagram-feed",
  },
  { id: "CUSTOM", label: "Tùy chỉnh", icon: "⚙", shape: "CUSTOM", width: 1080, height: 1920, fps: 30, hint: "Kích thước tự đặt", exportPresetId: "youtube-shorts" },
];

/** Default when nothing is chosen: the short vertical video this factory makes. */
export const DEFAULT_PLATFORM: PlatformId = "TIKTOK";
export const DEFAULT_PLATFORM_NOTE = "Mặc định: Video ngắn dọc – phù hợp TikTok, Shorts và Reels.";

export interface OutputProfile {
  platform: PlatformId;
  width: number;
  height: number;
  fps: number;
  fit: FitMode;
  /** Subtitle distance from the bottom, % of height. Null = automatic for the shape. */
  subtitleBottomPct: number | null;
}

export function platformPreset(id: string | null | undefined): PlatformPreset | null {
  return PLATFORM_PRESETS.find((p) => p.id === id) ?? null;
}

export function profileFromPlatform(id: PlatformId, custom?: { width?: number; height?: number; fps?: number }): OutputProfile {
  const p = platformPreset(id) ?? platformPreset(DEFAULT_PLATFORM)!;
  return {
    platform: p.id,
    width: id === "CUSTOM" && custom?.width ? custom.width : p.width,
    height: id === "CUSTOM" && custom?.height ? custom.height : p.height,
    fps: custom?.fps ?? p.fps,
    fit: "AUTO",
    subtitleBottomPct: null,
  };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** "9:16", "16:9", "4:5", or the reduced ratio of a custom size. */
export function aspectOf(width: number, height: number): string {
  const d = gcd(width, height) || 1;
  return `${width / d}:${height / d}`;
}

/** The generation shapes the app can make assets in (targetForAspect). */
export const GENERATION_ASPECTS = ["9:16", "16:9", "1:1", "4:5"] as const;

/** Nearest shape assets can be MADE in, for any output size. */
export function generationAspectFor(width: number, height: number): (typeof GENERATION_ASPECTS)[number] {
  const want = Math.log(width / height);
  const value = (a: string) => {
    const [w, h] = a.split(":").map(Number);
    return Math.log(w! / h!);
  };
  let best: (typeof GENERATION_ASPECTS)[number] = "9:16";
  for (const a of GENERATION_ASPECTS) if (Math.abs(value(a) - want) < Math.abs(value(best) - want)) best = a;
  return best;
}

export function orientationOf(width: number, height: number): "PORTRAIT" | "LANDSCAPE" | "SQUARE" {
  const r = width / height;
  if (r > 1.1) return "LANDSCAPE";
  if (r < 0.9) return "PORTRAIT";
  return "SQUARE";
}

/** "video dọc 9:16" / "video ngang 16:9" / "video vuông 1:1". */
export function viShape(width: number, height: number): string {
  const o = orientationOf(width, height);
  return `video ${o === "LANDSCAPE" ? "ngang" : o === "PORTRAIT" ? "dọc" : "vuông"} ${aspectOf(width, height)}`;
}

/** Which platform a stored size is (legacy projects; Custom when nothing matches). */
export function platformForSize(width: number, height: number): PlatformId {
  const exact = PLATFORM_PRESETS.find((p) => p.id !== "CUSTOM" && p.width === width && p.height === height);
  return exact?.id ?? "CUSTOM";
}

/** Sizes for the aspect ratios a V1.2 project could have (targetForAspect). */
const SIZE_FOR_ASPECT: Record<string, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

/**
 * The profile of a project. A stored one wins; a project from before profiles
 * existed is INFERRED from what it renders today (the batch preset's size when
 * the batch names one, else its aspect ratio) - read-only, nothing rewritten.
 */
export function resolveProfile(opts: {
  stored: string | null | undefined;
  aspectRatio: string;
  batchPresetSize?: { width: number; height: number; fps: number } | null;
}): OutputProfile & { inferred: boolean } {
  const parsed = parseProfile(opts.stored);
  if (parsed) return { ...parsed, inferred: false };
  const size = opts.batchPresetSize ?? { ...(SIZE_FOR_ASPECT[opts.aspectRatio] ?? SIZE_FOR_ASPECT["9:16"]!), fps: 30 };
  return {
    platform: platformForSize(size.width, size.height),
    width: size.width,
    height: size.height,
    fps: size.fps,
    fit: "AUTO",
    subtitleBottomPct: null,
    inferred: true,
  };
}

export function parseProfile(json: string | null | undefined): OutputProfile | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<OutputProfile>;
    const checked = validateProfile(v);
    return checked.ok ? checked.profile : null;
  } catch {
    return null;
  }
}

/** Accept a person's profile, or say plainly what is wrong. */
export function validateProfile(v: Partial<OutputProfile>): { ok: true; profile: OutputProfile } | { ok: false; message: string } {
  const platform = PLATFORM_IDS.includes(v.platform as PlatformId) ? (v.platform as PlatformId) : null;
  if (!platform) return { ok: false, message: "Chọn một nền tảng." };
  const width = Math.round(Number(v.width));
  const height = Math.round(Number(v.height));
  const fps = Math.round(Number(v.fps ?? 30));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 240 || height < 240 || width > 3840 || height > 3840) {
    return { ok: false, message: "Kích thước phải từ 240 đến 3840 điểm ảnh." };
  }
  if (width % 2 !== 0 || height % 2 !== 0) return { ok: false, message: "Chiều rộng và chiều cao phải là số chẵn." };
  if (!Number.isFinite(fps) || fps < 12 || fps > 60) return { ok: false, message: "FPS phải từ 12 đến 60." };
  const fit = FIT_MODES.includes(v.fit as FitMode) ? (v.fit as FitMode) : "AUTO";
  const pct = v.subtitleBottomPct === null || v.subtitleBottomPct === undefined ? null : Number(v.subtitleBottomPct);
  if (pct !== null && (!Number.isFinite(pct) || pct < 3 || pct > 45)) {
    return { ok: false, message: "Vị trí phụ đề phải từ 3% đến 45% chiều cao." };
  }
  return { ok: true, profile: { platform, width, height, fps, fit, subtitleBottomPct: pct } };
}

/** Is this profile the plain V1 default (TikTok/Shorts frame, auto fit, auto subtitles)? */
export function isDefaultVertical(p: OutputProfile): boolean {
  return p.width === 1080 && p.height === 1920 && p.fps === 30 && p.fit === "AUTO" && p.subtitleBottomPct === null;
}

/**
 * Where subtitles may sit, per frame shape. Tall vertical video keeps clear of
 * the platforms' bottom bar (caption, username, buttons): 20% from the bottom.
 * Sides keep 7.5% each and lines are wrapped short, so text stays off the
 * edges. The 9:16 numbers are exactly what V1 rendered, so existing videos look
 * the same. (A wider right margin for the action rail would shift centred text;
 * not done - see QĐ-121.)
 */
export function subtitleSafeArea(
  width: number,
  height: number,
  bottomPct: number | null = null,
): { marginV: number; marginL: number; marginR: number } {
  const r = width / height;
  const autoBottom = r < 0.7 ? 0.2 : r < 0.9 ? 0.12 : r < 1.1 ? 0.1 : 0.08;
  const side = 0.075;
  return {
    marginV: Math.round(height * (bottomPct !== null ? bottomPct / 100 : autoBottom)),
    marginL: Math.round(width * side),
    marginR: Math.round(width * side),
  };
}

/**
 * How a source of one shape goes into a frame of another, never stretched:
 *   COVER    fill the frame, crop the overflow (centre)
 *   CONTAIN  show all of it, the rest filled with a blurred copy
 *   AUTO     COVER while the shapes are close (a 2:3 picture in 9:16 - the
 *            usual case, exactly V1's behaviour); CONTAIN when cropping would
 *            cut a large part (16:9 into 9:16 would lose two thirds: heads,
 *            products, text)
 */
export function effectiveFit(fit: FitMode, source: { width: number; height: number } | null, target: { width: number; height: number }): "COVER" | "CONTAIN" {
  if (fit !== "AUTO") return fit;
  if (!source || source.width <= 0 || source.height <= 0) return "COVER";
  const gap = Math.abs(Math.log(source.width / source.height) - Math.log(target.width / target.height));
  return gap <= Math.log(1.35) ? "COVER" : "CONTAIN";
}
