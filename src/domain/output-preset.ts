import { z } from "zod";

/**
 * Output presets (V1.2 Phase 6, QĐ-114).
 *
 * A preset says how a finished video is RENDERED and EXPORTED - frame size,
 * frame rate, encoder quality, subtitles, thumbnail, metadata. It never says
 * how a scene is MADE: pictures, clips and voices are produced for the
 * project's own aspect ratio and are never invalidated by a preset. Changing
 * the preset of a finished video is therefore a local re-render and re-export
 * ($0), never a purchase.
 *
 * Only H.264 video and AAC audio are offered: that is what the renderer writes
 * and what every short-video platform accepts. Intro/outro clips and watermarks
 * are NOT part of Phase 6 - a field that is stored but silently ignored would
 * be a lie on the settings page, so there is none.
 */

export const SUBTITLE_MODES = ["BOTH", "BURN", "SRT", "NONE"] as const;
export type SubtitleMode = (typeof SUBTITLE_MODES)[number];

export const VI_SUBTITLE_MODE: Record<SubtitleMode, string> = {
  BOTH: "Cả hai (in chữ lên video + file SRT)",
  BURN: "Chỉ in chữ lên video",
  SRT: "Chỉ file SRT",
  NONE: "Không phụ đề",
};

export const PLATFORMS = ["YOUTUBE_SHORTS", "TIKTOK", "REELS", "YOUTUBE", "CUSTOM"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Encoder quality: x264 CRF. Lower = better and bigger. 20 is what V1 always used. */
export const QUALITY_CRF = { HIGH: 18, STANDARD: 20, SMALL: 23 } as const;
export type Quality = keyof typeof QUALITY_CRF;

export const outputPresetSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "id chỉ gồm chữ thường, số và dấu gạch ngang"),
  name: z.string().trim().min(1).max(60),
  platform: z.enum(PLATFORMS),
  width: z.number().int().min(240).max(3840),
  height: z.number().int().min(240).max(3840),
  fps: z.number().int().min(12).max(60),
  videoCodec: z.literal("h264"),
  quality: z.enum(["HIGH", "STANDARD", "SMALL"]),
  audioCodec: z.literal("aac"),
  audioBitrateKbps: z.number().int().min(64).max(320),
  subtitleMode: z.enum(SUBTITLE_MODES),
  thumbnail: z.boolean(),
  metadata: z.boolean(),
  /** captions.txt + description.txt beside the MP4 (copy-paste helpers). */
  textFiles: z.boolean(),
});
export type OutputPreset = z.infer<typeof outputPresetSchema> & { builtIn?: boolean };

const base = {
  videoCodec: "h264" as const,
  quality: "STANDARD" as const,
  audioCodec: "aac" as const,
  audioBitrateKbps: 192,
  fps: 30,
};

/**
 * Built-in presets. YOUTUBE_SHORTS is the default and renders EXACTLY what V1
 * rendered (1080x1920, 30 fps, CRF 20, AAC 192k, burnt subtitles), so choosing
 * it changes no render recipe and re-renders nothing.
 */
export const BUILT_IN_PRESETS: readonly OutputPreset[] = [
  {
    ...base,
    id: "youtube-shorts",
    name: "YouTube Shorts",
    platform: "YOUTUBE_SHORTS",
    width: 1080,
    height: 1920,
    subtitleMode: "BOTH",
    thumbnail: true,
    metadata: true,
    textFiles: true,
    builtIn: true,
  },
  {
    ...base,
    id: "tiktok",
    name: "TikTok",
    platform: "TIKTOK",
    width: 1080,
    height: 1920,
    subtitleMode: "BURN",
    thumbnail: true,
    metadata: true,
    textFiles: true,
    builtIn: true,
  },
  {
    ...base,
    id: "instagram-reels",
    name: "Instagram Reels",
    platform: "REELS",
    width: 1080,
    height: 1920,
    subtitleMode: "BURN",
    thumbnail: true,
    metadata: true,
    textFiles: false,
    builtIn: true,
  },
  {
    ...base,
    id: "facebook-reels",
    name: "Facebook Reels",
    platform: "REELS",
    width: 1080,
    height: 1920,
    subtitleMode: "BURN",
    thumbnail: true,
    metadata: true,
    textFiles: false,
    builtIn: true,
  },
  {
    ...base,
    id: "square",
    name: "Bài đăng vuông 1:1",
    platform: "CUSTOM",
    width: 1080,
    height: 1080,
    subtitleMode: "BURN",
    thumbnail: true,
    metadata: true,
    textFiles: false,
    builtIn: true,
  },
  {
    ...base,
    id: "instagram-feed",
    name: "Instagram Feed dọc 4:5",
    platform: "CUSTOM",
    width: 1080,
    height: 1350,
    subtitleMode: "BURN",
    thumbnail: true,
    metadata: true,
    textFiles: false,
    builtIn: true,
  },
  {
    ...base,
    id: "youtube-landscape",
    name: "YouTube ngang 16:9",
    platform: "YOUTUBE",
    width: 1920,
    height: 1080,
    subtitleMode: "BOTH",
    thumbnail: true,
    metadata: true,
    textFiles: true,
    builtIn: true,
  },
];

export const DEFAULT_PRESET_ID = "youtube-shorts";

export function findPreset(id: string | null | undefined, custom: readonly OutputPreset[]): OutputPreset | null {
  if (!id) return null;
  return BUILT_IN_PRESETS.find((p) => p.id === id) ?? custom.find((p) => p.id === id) ?? null;
}

/** The preset to use: the batch's, else Settings' default, else YouTube Shorts. */
export function resolvePreset(
  batchPresetId: string | null | undefined,
  defaultPresetId: string | null | undefined,
  custom: readonly OutputPreset[],
): OutputPreset {
  return (
    findPreset(batchPresetId, custom) ??
    findPreset(defaultPresetId, custom) ??
    (BUILT_IN_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID) as OutputPreset)
  );
}

/** Validate a person's custom preset; a built-in id cannot be overwritten. */
export function validateCustomPreset(input: unknown): { ok: true; preset: OutputPreset } | { ok: false; message: string } {
  const parsed = outputPresetSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, message: `Preset không hợp lệ: ${first?.path.join(".") ?? ""} ${first?.message ?? ""}`.trim() };
  }
  if (BUILT_IN_PRESETS.some((p) => p.id === parsed.data.id)) {
    return { ok: false, message: `"${parsed.data.id}" là preset có sẵn — hãy đặt id khác.` };
  }
  if (parsed.data.width % 2 !== 0 || parsed.data.height % 2 !== 0) {
    return { ok: false, message: "Chiều rộng và chiều cao phải là số chẵn (H.264 yêu cầu)." };
  }
  return { ok: true, preset: { ...parsed.data, platform: "CUSTOM" } };
}

/** What the renderer takes from a preset. */
export interface PresetRender {
  target: { width: number; height: number; fps: number };
  burnSubtitles: boolean;
  /**
   * Encoder settings, ONLY when they differ from V1's (CRF 20, AAC 192k). Left
   * undefined otherwise so the render recipe of an unchanged video stays equal
   * and nothing is rendered again.
   */
  encode?: { crf: number; audioBitrateKbps: number };
  /** From a project output profile (QĐ-121), only when not the defaults. */
  fit?: "COVER" | "CONTAIN";
  subtitleBottomPct?: number;
}

export function presetRender(preset: OutputPreset): PresetRender {
  const crf = QUALITY_CRF[preset.quality];
  const encode = crf !== 20 || preset.audioBitrateKbps !== 192 ? { crf, audioBitrateKbps: preset.audioBitrateKbps } : undefined;
  return {
    target: { width: preset.width, height: preset.height, fps: preset.fps },
    burnSubtitles: preset.subtitleMode === "BOTH" || preset.subtitleMode === "BURN",
    ...(encode ? { encode } : {}),
  };
}

/** Does the export folder carry an .srt for this preset? */
export function exportsSrt(preset: OutputPreset): boolean {
  return preset.subtitleMode === "BOTH" || preset.subtitleMode === "SRT";
}

function ratio(w: number, h: number): string {
  const g = (a: number, b: number): number => (b === 0 ? a : g(b, a % b));
  const d = g(w, h);
  return `${w / d}:${h / d}`;
}

export function presetAspect(preset: Pick<OutputPreset, "width" | "height">): string {
  return ratio(preset.width, preset.height);
}

/**
 * A preset whose shape differs from the video's own: the pictures were made for
 * the project's ratio and will be cropped to fill the frame. Allowed, and said.
 */
export function aspectWarning(preset: OutputPreset, projectAspect: string): string | null {
  const a = presetAspect(preset);
  if (a === projectAspect) return null;
  return `Preset ${preset.name} là ${a}, video được tạo cho ${projectAspect}: khung hình sẽ bị cắt để lấp đầy. Không tạo lại ảnh/clip.`;
}
