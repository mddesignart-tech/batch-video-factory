import type { Platform } from "./output-preset";

/**
 * Where a platform's own buttons and captions sit over a vertical video
 * (V1.2 Phase 6, QĐ-114). Fractions of the frame, approximate on purpose: the
 * apps change their layouts and differ per device, so this is a WARNING aid for
 * the preview overlay, never a rule that edits content.
 */
export interface SafeArea {
  platform: Platform;
  label: string;
  /** Fraction of the height covered at the top (search / title bar). */
  top: number;
  /** Fraction of the height covered at the bottom (caption, channel, music). */
  bottom: number;
  /** Fraction of the width covered on the right (like / comment / share). */
  right: number;
  /** Fraction of the width on the left (usually none). */
  left: number;
}

export const SAFE_AREAS: Record<"YOUTUBE_SHORTS" | "TIKTOK" | "REELS", SafeArea> = {
  YOUTUBE_SHORTS: { platform: "YOUTUBE_SHORTS", label: "YouTube Shorts", top: 0.1, bottom: 0.2, right: 0.14, left: 0.03 },
  TIKTOK: { platform: "TIKTOK", label: "TikTok", top: 0.08, bottom: 0.2, right: 0.15, left: 0.03 },
  REELS: { platform: "REELS", label: "Instagram Reels", top: 0.1, bottom: 0.2, right: 0.13, left: 0.03 },
};

export function safeAreaFor(platform: Platform): SafeArea | null {
  if (platform === "YOUTUBE_SHORTS" || platform === "TIKTOK" || platform === "REELS") return SAFE_AREAS[platform];
  return null;
}

/**
 * The band the burnt-in subtitles occupy, as the renderer draws them
 * (media/subtitles.ts buildASS): bottom-centred, bottom margin 20% of the
 * height, side margins 7.5% of the width, font 7.8% of the height, bold Arial.
 */
export function subtitleBand(opts: { width: number; height: number; longestLineChars: number; lines: number }): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  const fontPx = Math.round(opts.height * 0.078);
  const lineHeight = fontPx * 1.25;
  const marginV = opts.height * 0.2;
  const marginH = opts.width * 0.075;
  // Bold Arial averages ~0.55 em per character.
  const textWidth = Math.min(opts.width - 2 * marginH, opts.longestLineChars * fontPx * 0.55);
  const left = (opts.width - textWidth) / 2;
  return {
    bottom: 1 - marginV / opts.height,
    top: 1 - (marginV + lineHeight * Math.max(1, opts.lines)) / opts.height,
    left: left / opts.width,
    right: (left + textWidth) / opts.width,
  };
}

export interface SafeAreaWarning {
  zone: "top" | "bottom" | "right";
  message: string;
}

/**
 * Warnings for subtitles that reach into a platform's UI. `lines` are the
 * subtitle texts of the video; the longest decides the width.
 */
export function checkSubtitleSafeArea(opts: {
  platform: Platform;
  width: number;
  height: number;
  subtitles: string[];
  burnt: boolean;
  /** The renderer's own line wrapping (media/subtitles.ts wrapSubtitle). */
  wrap: (text: string) => string[];
}): SafeAreaWarning[] {
  const area = safeAreaFor(opts.platform);
  if (!area || !opts.burnt || opts.subtitles.length === 0) return [];
  let longest = 0;
  let maxLines = 1;
  for (const s of opts.subtitles) {
    const lines = opts.wrap(s);
    for (const l of lines) longest = Math.max(longest, l.length);
    maxLines = Math.max(maxLines, lines.length);
  }
  const band = subtitleBand({ width: opts.width, height: opts.height, longestLineChars: longest, lines: maxLines });
  const out: SafeAreaWarning[] = [];
  if (band.bottom > 1 - area.bottom + 1e-9) {
    out.push({ zone: "bottom", message: `Phụ đề nằm trong vùng chữ/tên kênh phía dưới của ${area.label}.` });
  }
  if (band.right > 1 - area.right + 1e-9) {
    out.push({
      zone: "right",
      message: `Dòng phụ đề dài (${longest} ký tự) chạm vùng nút bấm bên phải của ${area.label}. Cân nhắc câu ngắn hơn.`,
    });
  }
  if (band.top < area.top) {
    out.push({ zone: "top", message: `Phụ đề lên quá cao, chạm vùng trên của ${area.label}.` });
  }
  return out;
}
