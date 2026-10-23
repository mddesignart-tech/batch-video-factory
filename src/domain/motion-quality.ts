/**
 * MOTION QUALITY (QĐ-151) - how a still with a camera plan is moved by the
 * local renderer. Pure: no FFmpeg here (see media/camera-motion.ts).
 *
 *   LEGACY     zoompan, exactly as before. Every project made before QĐ-151.
 *   SMOOTH_V2  same camera path, sub-pixel `perspective` sampling at output size.
 *              Measured: camera wobble 34.9 % -> 6.2 % of its speed, ~28 % faster.
 *   HQ_V2      the same at 2x then a Lanczos down-scale: sharper, ~3x slower.
 *              Only when a person picks it for one project - never a batch default.
 *
 * Everything is local FFmpeg, $0. A project switched to V2 can always go back.
 */

export const MOTION_QUALITIES = ["LEGACY", "SMOOTH_V2", "HQ_V2"] as const;
export type MotionQuality = (typeof MOTION_QUALITIES)[number];

export const MOTION_QUALITY_INFO: Record<MotionQuality, { label: string; hint: string }> = {
  LEGACY: { label: "Legacy", hint: "Tương thích cũ (renderer trước QĐ-151)." },
  SMOOTH_V2: { label: "Smooth V2", hint: "Mượt và nhanh — khuyên dùng, kể cả sản xuất hàng loạt." },
  HQ_V2: { label: "High Quality V2", hint: "Ưu tiên độ nét — render lâu hơn đáng kể (~3 lần Smooth V2). Chỉ chọn cho từng video." },
};

/** What a NEW project may start with (Settings). HQ_V2 is never a default. */
export const NEW_PROJECT_MOTION_QUALITIES = ["LEGACY", "SMOOTH_V2"] as const;
export type NewProjectMotionQuality = (typeof NEW_PROJECT_MOTION_QUALITIES)[number];
export const DEFAULT_NEW_PROJECT_MOTION_QUALITY: NewProjectMotionQuality = "SMOOTH_V2";
