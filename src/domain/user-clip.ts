/**
 * UPLOADED VIDEO CLIP INPUT - the pure half (no database, no FFmpeg).
 *
 * A clip a person supplied (a presenter holding the product, water being
 * poured, a handshake, a real animal, B-roll, an AI clip made elsewhere) is the
 * scene's visual as it is: REUSED, never routed, never bought, never replaced
 * by Video AI. Its own movement is kept (PRESERVE_NATIVE_MOTION) - no local
 * zoom / pan / parallax is laid over it.
 */

export const VIDEO_SOURCES = ["GENERATED", "UPLOADED"] as const;
export type VideoSource = (typeof VIDEO_SOURCES)[number];

export const CLIP_AUDIO_MODES = ["OFF", "ON"] as const;
export type ClipAudioMode = (typeof CLIP_AUDIO_MODES)[number];

/** A clip SHORTER than its scene. AUTO = hold the last frame up to 1 s, else stop and ask. */
export const CLIP_SHORT_MODES = ["AUTO", "HOLD", "LOOP", "SLOW"] as const;
export type ClipShortMode = (typeof CLIP_SHORT_MODES)[number];

export const CLIP_FRAMES = ["AUTO", "COVER", "CONTAIN"] as const;
export type ClipFrame = (typeof CLIP_FRAMES)[number];

export const VI_CLIP_SHORT_MODE: Record<ClipShortMode, string> = {
  AUTO: "Tự động (giữ khung cuối tối đa 1 giây, dài hơn thì hỏi)",
  HOLD: "Giữ khung cuối",
  LOOP: "Lặp lại clip",
  SLOW: "Phát chậm cho vừa cảnh",
};

export const VI_CLIP_FRAME: Record<ClipFrame, string> = {
  AUTO: "Theo định dạng đầu ra",
  COVER: "Lấp đầy khung (cắt mép)",
  CONTAIN: "Giữ trọn hình (nền mờ)",
};

/** The pipeline never trusts a name: these are the containers it accepts, by content. */
export type ClipContainer = "mp4" | "mov" | "webm";
export const CLIP_EXTENSION: Record<ClipContainer, ".mp4" | ".mov" | ".webm"> = { mp4: ".mp4", mov: ".mov", webm: ".webm" };
export const CLIP_MIME: Record<ClipContainer, string> = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
export const ALLOWED_CLIP_EXTENSIONS = [".mp4", ".mov", ".webm", ".m4v"] as const;
/** The upload limit for one clip. */
export const CLIP_MAX_BYTES = 400 * 1024 * 1024;
/** ffprobe format names that may carry a clip this pipeline can play. */
const FORMAT_FAMILY: { match: RegExp; container: ClipContainer }[] = [
  { match: /(^|,)(mov|mp4|m4a|3gp|3g2|mj2)(,|$)/, container: "mp4" },
  { match: /(^|,)(matroska|webm)(,|$)/, container: "webm" },
];

export function allowedClipName(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_CLIP_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * The container the BYTES say. MP4 and QuickTime share the ISO box layout: a
 * `ftyp` box (brand `qt  ` = QuickTime) or, in older .mov files, a bare
 * `moov` / `mdat` / `wide` / `free` box. WebM is Matroska (EBML header) whose
 * doc type says "webm".
 */
export function sniffClipContainer(bytes: Buffer): ClipContainer | null {
  if (bytes.length < 16) return null;
  const box = bytes.toString("latin1", 4, 8);
  if (box === "ftyp") return bytes.toString("latin1", 8, 12) === "qt  " ? "mov" : "mp4";
  if (["moov", "mdat", "wide", "free", "skip"].includes(box)) return "mov";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return bytes.toString("latin1", 0, Math.min(bytes.length, 64)).includes("webm") ? "webm" : null;
  }
  return null;
}

/** ffprobe's own reading of the container agrees with the bytes. */
export function formatMatches(formatName: string, container: ClipContainer): boolean {
  const family = FORMAT_FAMILY.find((f) => f.match.test(formatName));
  if (!family) return false;
  return container === "webm" ? family.container === "webm" : family.container === "mp4";
}

/** What ffprobe measured, as stored on the Asset (`mediaInfoJson`). */
export interface ClipMediaInfo {
  container: ClipContainer;
  durationSec: number;
  /** Displayed size (rotation applied). */
  width: number;
  height: number;
  fps: number;
  codec: string;
  pixelFormat: string | null;
  hasAudio: boolean;
  audioCodec: string | null;
  /** Rotation the file asks the player to apply (phones): 0, 90, 180, 270. */
  rotation: number;
  orientation: "PORTRAIT" | "LANDSCAPE" | "SQUARE";
  /** Nearest common shape, "16:9", "9:16", "1:1", "4:5"... or the exact ratio. */
  aspectRatio: string;
  bytes: number;
  /** The still shown as thumbnail / used as the scene's keyframe (relative path). */
  posterPath?: string | null;
}

export function parseClipInfo(json: string | null | undefined): ClipMediaInfo | null {
  try {
    const v = JSON.parse(json ?? "{}") as Partial<ClipMediaInfo>;
    return typeof v.durationSec === "number" && typeof v.width === "number" ? (v as ClipMediaInfo) : null;
  } catch {
    return null;
  }
}

/** "30000/1001" → 29.97. */
export function parseRate(rate: string | undefined | null): number {
  if (!rate) return 0;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !Number.isFinite(n)) return 0;
  const value = d ? n / d : n;
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

const SHAPES: { label: string; ratio: number }[] = [
  { label: "16:9", ratio: 16 / 9 },
  { label: "9:16", ratio: 9 / 16 },
  { label: "1:1", ratio: 1 },
  { label: "4:5", ratio: 4 / 5 },
  { label: "5:4", ratio: 5 / 4 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "3:4", ratio: 3 / 4 },
  { label: "21:9", ratio: 21 / 9 },
];

export function describeShape(width: number, height: number): Pick<ClipMediaInfo, "orientation" | "aspectRatio"> {
  const r = width / height;
  const near = SHAPES.find((s) => Math.abs(s.ratio - r) / s.ratio < 0.03);
  return {
    orientation: Math.abs(r - 1) < 0.03 ? "SQUARE" : r > 1 ? "LANDSCAPE" : "PORTRAIT",
    aspectRatio: near?.label ?? `${(Math.round(r * 100) / 100).toFixed(2)}:1`,
  };
}

/** The scene-level settings of a clip, as stored on the Scene row. */
export interface ClipSettings {
  clipStartSec: number | null;
  clipEndSec: number | null;
  clipAudio: string;
  clipAudioGain: number;
  clipShortMode: string;
  clipFrame: string;
}

export interface ClipWindow {
  startSec: number;
  endSec: number;
  lengthSec: number;
}

/** The part of the clip the scene plays, clamped to what the file holds. */
export function clipWindow(settings: Pick<ClipSettings, "clipStartSec" | "clipEndSec">, durationSec: number): ClipWindow {
  const total = Math.max(0, durationSec);
  const start = Math.min(Math.max(0, settings.clipStartSec ?? 0), total);
  const rawEnd = settings.clipEndSec ?? total;
  const end = Math.min(Math.max(start, rawEnd), total);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return { startSec: r3(start), endSec: r3(end), lengthSec: r3(end - start) };
}

/** Problems with a trim a person typed, in Vietnamese; null = fine. */
export function trimProblem(start: number | null, end: number | null, durationSec: number): string | null {
  if (start !== null && (!Number.isFinite(start) || start < 0)) return "Điểm bắt đầu phải là số giây ≥ 0.";
  if (end !== null && (!Number.isFinite(end) || end <= 0)) return "Điểm kết thúc phải là số giây > 0.";
  if (start !== null && start >= durationSec) return `Điểm bắt đầu vượt quá độ dài clip (${durationSec.toFixed(2)} giây).`;
  if (start !== null && end !== null && end - start < 0.5) return "Đoạn dùng phải dài ít nhất 0,5 giây.";
  return null;
}

export function isClipShortMode(v: unknown): v is ClipShortMode {
  return typeof v === "string" && (CLIP_SHORT_MODES as readonly string[]).includes(v);
}
export function isClipFrame(v: unknown): v is ClipFrame {
  return typeof v === "string" && (CLIP_FRAMES as readonly string[]).includes(v);
}
export function asClipShortMode(v: unknown): ClipShortMode {
  return isClipShortMode(v) ? v : "AUTO";
}
export function asClipFrame(v: unknown): ClipFrame {
  return isClipFrame(v) ? v : "AUTO";
}

/** The scene's visual is a person's clip (and only then). */
export function usesUserClip(scene: { videoSource?: string | null }): boolean {
  return scene.videoSource === "UPLOADED";
}

/** Shown wherever a scene's motion source is named, so a user clip is never mistaken for a paid AI clip. */
export const USER_CLIP_LABEL = "Video của bạn";
export const USER_CLIP_REASON = "Video của bạn: dùng clip đã tải lên, không gọi Video AI ($0)";
export const MISSING_CLIP_MESSAGE = "Không tìm thấy video nguồn.";
