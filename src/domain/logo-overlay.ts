/**
 * LOGO OVERLAY: where a LOGO Reference sits on the finished video, and how big.
 * Pure: no database, no FFmpeg.
 *
 * The logo is the brand's identity, so it is never stretched, cropped,
 * recoloured or re-shaped - only scaled as a whole (both sides by the same
 * factor) and made more or less see-through. Sizes scale with the output frame,
 * never fixed pixels: the logo reads the same on 9:16, 16:9, 1:1 and 4:5.
 */

import { platformSafeArea, type LogoPosition, type LogoSize, type OutputControls, type SubtitleLayout } from "./output-controls";

/** Logo size: its AREA equals a square of this share of the frame's short side. */
export const LOGO_SIZE_PCT: Record<Exclude<LogoSize, "CUSTOM">, number> = { SMALL: 8, MEDIUM: 12, LARGE: 18 };

/** A wide wordmark or a tall badge never grows past these shares of the frame. */
const MAX_WIDTH_SHARE = 0.4;
const MAX_HEIGHT_SHARE = 0.25;

export interface LogoPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function logoSizePct(c: Pick<OutputControls["logo"], "size" | "customPct">): number {
  return c.size === "CUSTOM" ? c.customPct : LOGO_SIZE_PCT[c.size];
}

/**
 * The logo's box on the frame. `logo` is the picture's own size (only its
 * shape matters). Area-based so a square badge and a 4:1 wordmark look equally
 * "big"; both sides scale together, so the shape is exactly the source's.
 *
 * The margin is a share of the short side. On a vertical short (9:16) the
 * platform's own UI (search bar on top, buttons on the right, caption at the
 * bottom - the same safe area the subtitles keep clear of) is a floor under it.
 */
export function logoPlacement(
  c: Pick<OutputControls["logo"], "position" | "size" | "customPct" | "marginPct">,
  frame: { width: number; height: number },
  logo: { width: number; height: number },
): LogoPlacement {
  const { width: W, height: H } = frame;
  const short = Math.min(W, H);
  const side = (short * logoSizePct(c)) / 100;
  const aspect = logo.width > 0 && logo.height > 0 ? logo.width / logo.height : 1;
  let w = side * Math.sqrt(aspect);
  let h = side / Math.sqrt(aspect);
  const shrink = Math.min(1, (W * MAX_WIDTH_SHARE) / w, (H * MAX_HEIGHT_SHARE) / h);
  w *= shrink;
  h *= shrink;
  // Even sizes keep yuv420p chroma aligned; the shape changes by < 1 px.
  const width = Math.max(2, 2 * Math.round(w / 2));
  const height = Math.max(2, 2 * Math.round(h / 2));

  const margin = (short * c.marginPct) / 100;
  const vertical = W / H < 0.7;
  const safe = vertical ? platformSafeArea(W, H) : { top: 0, bottom: 0, left: 0, right: 0 };
  const left = Math.max(margin, safe.left * W);
  const right = Math.max(margin, safe.right * W);
  const top = Math.max(margin, safe.top * H);
  const bottom = Math.max(margin, safe.bottom * H);

  const p = c.position;
  const x = p.endsWith("LEFT") ? left : p.endsWith("RIGHT") ? W - right - width : (W - width) / 2;
  const y = p.startsWith("TOP") ? top : H - bottom - height;
  return {
    x: Math.round(Math.min(Math.max(0, x), W - width)),
    y: Math.round(Math.min(Math.max(0, y), H - height)),
    width,
    height,
  };
}

/** The band the subtitles take on screen (px), from the renderer's own layout. */
export function subtitleBox(layout: SubtitleLayout, frame: { width: number; height: number }): LogoPlacement {
  const block = Math.min(layout.maxBlockHeight, layout.maxLines * layout.fontSize * 1.25) + layout.outline * 2;
  const { width: W, height: H } = frame;
  const y =
    layout.alignment === 8 ? layout.marginV : layout.alignment === 5 ? (H - block) / 2 : H - layout.marginV - block;
  return { x: layout.marginL, y: Math.round(y), width: W - layout.marginL - layout.marginR, height: Math.round(block) };
}

const overlaps = (a: LogoPlacement, b: LogoPlacement) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Same corner, other edge: bottom-right ↔ top-right, and so on. */
export function oppositeVertical(p: LogoPosition): LogoPosition {
  return (p.startsWith("TOP") ? p.replace("TOP", "BOTTOM") : p.replace("BOTTOM", "TOP")) as LogoPosition;
}

export interface LogoSubtitleClash {
  message: string;
  /** Where the logo would be clear of the captions (a suggestion; never applied by itself). */
  suggest: LogoPosition;
}

/**
 * The logo would cover the burnt-in captions. Only a WARNING with a suggested
 * position - the person's own choice is never moved behind their back.
 */
export function logoSubtitleClash(
  placement: LogoPlacement,
  layout: SubtitleLayout | null,
  frame: { width: number; height: number },
  position: LogoPosition,
): LogoSubtitleClash | null {
  if (!layout) return null;
  if (!overlaps(placement, subtitleBox(layout, frame))) return null;
  const suggest = oppositeVertical(position);
  return {
    message: "Logo đang chồng lên vùng phụ đề. Nên chuyển logo lên/xuống phía đối diện hoặc thu nhỏ logo.",
    suggest,
  };
}

/** JPG has no transparency: the logo's background shows as a solid box. */
export function logoAlphaWarning(filename: string): string | null {
  return /\.jpe?g$/i.test(filename) ? "Logo JPG không có nền trong suốt - nền của ảnh sẽ hiện thành một khối. Nên dùng PNG/WebP trong suốt." : null;
}

export const LOGO_MISSING_MESSAGE = "Không tìm thấy file logo.";
