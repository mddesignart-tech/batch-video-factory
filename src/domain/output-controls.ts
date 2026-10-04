/**
 * VIDEO OUTPUT controls (QĐ-125): subtitles, narration / music / effect levels
 * and the project's narrator voice. Pure: no database, no FFmpeg.
 *
 * Everything here except the VOICE block is applied by the local render only:
 * changing it re-renders on this machine and buys nothing (no text, image,
 * video or TTS request). The voice block is the one exception - a different
 * voice or speed is different audio - and goes through the usual voice
 * preview / price / confirm path (QĐ-117).
 *
 * A project made before this existed has no stored controls and reads the
 * DEFAULTS: the new, smaller subtitles, and exactly the audio it always had
 * (no effects layer, no fades, voice at 100%).
 */

import { z } from "zod";

export const SUBTITLE_SIZES = ["SMALL", "MEDIUM", "LARGE", "CUSTOM"] as const;
export const SUBTITLE_POSITIONS = ["BOTTOM", "MIDDLE", "TOP"] as const;
export const SUBTITLE_STYLES = ["OUTLINE", "BOX", "MINIMAL", "BOLD"] as const;
export type SubtitleSize = (typeof SUBTITLE_SIZES)[number];
export type SubtitlePosition = (typeof SUBTITLE_POSITIONS)[number];
export type SubtitleStyleId = (typeof SUBTITLE_STYLES)[number];

export const VI_SUBTITLE_SIZE: Record<SubtitleSize, string> = { SMALL: "Nhỏ", MEDIUM: "Vừa", LARGE: "Lớn", CUSTOM: "Tùy chỉnh" };
export const VI_SUBTITLE_POSITION: Record<SubtitlePosition, string> = { BOTTOM: "Dưới", MIDDLE: "Giữa", TOP: "Trên" };
export const VI_SUBTITLE_STYLE: Record<SubtitleStyleId, string> = {
  OUTLINE: "Trắng + viền đen",
  BOX: "Chữ trắng + nền tối",
  MINIMAL: "Tối giản",
  BOLD: "Nổi bật",
};

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const OutputControlsSchema = z.object({
  subtitles: z
    .object({
      enabled: z.boolean().default(true),
      size: z.enum(SUBTITLE_SIZES).default("MEDIUM"),
      /** CUSTOM only: × the MEDIUM size. */
      customScale: z.number().min(0.5).max(1.8).default(1),
      position: z.enum(SUBTITLE_POSITIONS).default("BOTTOM"),
      /** "Dịch lên / xuống", % of height; + = up. Clamped to the platform safe area. */
      offsetPct: z.number().min(-20).max(20).default(0),
      style: z.enum(SUBTITLE_STYLES).default("OUTLINE"),
      autoFit: z.boolean().default(true),
      maxLines: z.number().int().min(1).max(3).default(2),
      advanced: z
        .object({
          font: z.string().max(60).optional(),
          bold: z.boolean().optional(),
          color: hex.optional(),
          /** × the style's own outline thickness. */
          outlineScale: z.number().min(0).max(3).optional(),
          shadow: z.boolean().optional(),
          /** 0..1, BOX style background. */
          backgroundOpacity: z.number().min(0).max(1).optional(),
          /** % of frame width the text may use. */
          maxWidthPct: z.number().min(40).max(95).optional(),
          showSafeArea: z.boolean().optional(),
        })
        .default({}),
    })
    .default({}),
  audio: z
    .object({
      /** 0..2 = 0–200 %. */
      narrationVolume: z.number().min(0).max(2).default(1),
      /** Level every scene's voice to the same loudness (local, loudnorm). */
      normalizeNarration: z.boolean().default(false),
      musicEnabled: z.boolean().default(true),
      /** 0..1 linear. */
      musicVolume: z.number().min(0).max(1).default(0.15),
      duckMusic: z.boolean().default(true),
      sfxEnabled: z.boolean().default(false),
      sfxVolume: z.number().min(0).max(1).default(0.4),
      /** Short fade in / out on the final audio. */
      fades: z.boolean().default(false),
    })
    .default({}),
  /** The project's narrator voice. Null fields = the Narrator character's own settings. */
  voice: z
    .object({
      provider: z.string().nullable().default(null),
      model: z.string().nullable().default(null),
      voiceId: z.string().nullable().default(null),
      speed: z.number().min(0.5).max(2).nullable().default(null),
      instructions: z.string().max(500).nullable().default(null),
    })
    .default({}),
});
export type OutputControls = z.infer<typeof OutputControlsSchema>;

/**
 * Defaults by kind of project. A content-engine project starts with sound
 * effects and soft fades on; a legacy idiom project keeps the audio it always
 * had. Subtitles use the new, smaller defaults for everyone.
 */
export function defaultControls(project: { contentType?: string | null }): OutputControls {
  const base = OutputControlsSchema.parse({});
  return project.contentType ? { ...base, audio: { ...base.audio, sfxEnabled: true, fades: true } } : base;
}

/** The stored controls over the defaults; anything unreadable falls back safely. */
export function controlsOf(project: { contentType?: string | null; outputControlsJson?: string | null }): OutputControls {
  const defaults = defaultControls(project);
  if (!project.outputControlsJson) return defaults;
  try {
    const raw = JSON.parse(project.outputControlsJson) as Partial<OutputControls>;
    return OutputControlsSchema.parse({
      subtitles: { ...defaults.subtitles, ...(raw.subtitles ?? {}), advanced: { ...defaults.subtitles.advanced, ...(raw.subtitles?.advanced ?? {}) } },
      audio: { ...defaults.audio, ...(raw.audio ?? {}) },
      voice: { ...defaults.voice, ...(raw.voice ?? {}) },
    });
  } catch {
    return defaults;
  }
}

/** Merge a partial change (from the UI) and validate. */
export function mergeControls(current: OutputControls, patch: DeepPartial<OutputControls>): OutputControls {
  return OutputControlsSchema.parse({
    subtitles: { ...current.subtitles, ...(patch.subtitles ?? {}), advanced: { ...current.subtitles.advanced, ...(patch.subtitles?.advanced ?? {}) } },
    audio: { ...current.audio, ...(patch.audio ?? {}) },
    voice: { ...current.voice, ...(patch.voice ?? {}) },
  });
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// ------------------------------------------------------------- subtitle layout ---

const SIZE_FACTOR: Record<Exclude<SubtitleSize, "CUSTOM">, number> = { SMALL: 0.05, MEDIUM: 0.06, LARGE: 0.075 };

export interface SubtitleLayout {
  fontSize: number;
  minFontSize: number;
  /** Which fitting rules made the captions; part of the render recipe. */
  fitRules: string;
  outline: number;
  shadow: number;
  /** ASS alignment: 2 bottom, 5 middle, 8 top (all centred). */
  alignment: 2 | 5 | 8;
  marginV: number;
  marginL: number;
  marginR: number;
  maxLines: number;
  /** Characters that fit on one line at `fontSize`. */
  charsPerLine: number;
  autoFit: boolean;
  /** The tallest the text block may get, px (never "most of the screen"). */
  maxBlockHeight: number;
  font: string;
  bold: boolean;
  /** &HAABBGGRR */
  primaryColour: string;
  outlineColour: string;
  backColour: string;
  /** 1 outline + shadow, 3 opaque box. */
  borderStyle: 1 | 3;
}

/** "#RRGGBB" + opacity → ASS &HAABBGGRR (ASS alpha: 00 opaque, FF transparent). */
export function assColour(rgb: string, opacity = 1): string {
  const r = rgb.slice(1, 3);
  const g = rgb.slice(3, 5);
  const b = rgb.slice(5, 7);
  const a = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255)
    .toString(16)
    .padStart(2, "0");
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/**
 * Where the platform's own UI sits, so the text never goes under it. Vertical
 * shorts (TikTok / Shorts / Reels) keep clear of the caption + buttons at the
 * bottom and the action column on the right.
 */
export function platformSafeArea(width: number, height: number): { top: number; bottom: number; left: number; right: number } {
  const r = width / height;
  if (r < 0.7) return { top: 0.12, bottom: 0.2, left: 0.06, right: 0.16 };
  if (r < 0.9) return { top: 0.08, bottom: 0.12, left: 0.07, right: 0.07 };
  if (r < 1.1) return { top: 0.08, bottom: 0.1, left: 0.07, right: 0.07 };
  return { top: 0.07, bottom: 0.08, left: 0.08, right: 0.08 };
}

/**
 * Size, place and style the subtitles for one frame. The font scales with the
 * SHORT side of the frame, so 9:16, 16:9, 1:1 and 4:5 all read the same; the
 * text block never takes more than ~15 % of the frame height.
 */
export function subtitleLayout(c: OutputControls["subtitles"], width: number, height: number, legacyBottomPct: number | null = null): SubtitleLayout {
  const short = Math.min(width, height);
  const factor = c.size === "CUSTOM" ? SIZE_FACTOR.MEDIUM * c.customScale : SIZE_FACTOR[c.size];
  const styleScale = c.style === "MINIMAL" ? 0.92 : c.style === "BOLD" ? 1.06 : 1;
  const fontSize = Math.max(18, Math.round(short * factor * styleScale));
  const safe = platformSafeArea(width, height);
  const offset = (c.offsetPct / 100) * height;

  const maxBlockHeight = Math.round(height * 0.15);
  let alignment: 2 | 5 | 8 = 2;
  let marginV: number;
  if (c.position === "BOTTOM") {
    // An older project's own bottom distance (QĐ-121) is honoured as the base.
    const base = legacyBottomPct !== null ? (legacyBottomPct / 100) * height : safe.bottom * height;
    const min = safe.bottom * height;
    const max = height * 0.5;
    marginV = Math.round(Math.min(max, Math.max(min, base + offset)));
  } else if (c.position === "TOP") {
    alignment = 8;
    const min = safe.top * height;
    marginV = Math.round(Math.min(height * 0.45, Math.max(min, min - offset)));
  } else {
    // Middle: bottom-anchored just below the centre line, so the offset slider
    // moves it the same way as at the bottom (ASS ignores MarginV when centred).
    marginV = Math.round(Math.min(height * 0.6, Math.max(safe.bottom * height, height * 0.42 + offset)));
  }

  const widthPct = (c.advanced.maxWidthPct ?? 100 - (safe.left + safe.right) * 100) / 100;
  const usable = width * widthPct;
  const marginL = Math.round(Math.max(safe.left * width, (width - usable) / 2));
  const marginR = Math.round(Math.max(safe.right * width, (width - usable) / 2));
  const lineWidth = width - marginL - marginR;
  const charWidth = fontSize * 0.55;
  const charsPerLine = Math.max(8, Math.floor(lineWidth / charWidth));

  const outlineBase = c.style === "MINIMAL" ? 0.04 : c.style === "BOLD" ? 0.11 : 0.08;
  const outline = Math.max(1, Math.round(fontSize * outlineBase * (c.advanced.outlineScale ?? 1)));
  const wantShadow = c.advanced.shadow ?? c.style !== "MINIMAL";
  const shadow = wantShadow ? Math.max(1, Math.round(fontSize * 0.04)) : 0;
  const colour = c.advanced.color ?? (c.style === "BOLD" ? "#FFD400" : "#FFFFFF");
  const box = c.style === "BOX";

  return {
    fontSize,
    minFontSize: Math.round(fontSize * MIN_AUTO_FIT_SCALE),
    fitRules: SUBTITLE_FIT_RULES,
    outline: box ? Math.max(4, Math.round(fontSize * 0.18)) : outline,
    shadow: box ? 0 : shadow,
    alignment,
    marginV,
    marginL,
    marginR,
    maxLines: c.maxLines,
    charsPerLine,
    autoFit: c.autoFit,
    maxBlockHeight,
    font: c.advanced.font || "Arial",
    bold: c.advanced.bold ?? c.style !== "MINIMAL",
    primaryColour: assColour(colour),
    outlineColour: box ? assColour("#000000", c.advanced.backgroundOpacity ?? 0.55) : assColour("#000000"),
    backColour: assColour("#000000", box ? (c.advanced.backgroundOpacity ?? 0.55) : 0.6),
    borderStyle: box ? 3 : 1,
  };
}

/**
 * The smallest auto-fit may ever make a caption, × the project's base size.
 * Every caption of a video is within this of every other: auto-fit only stops
 * overflow, it never makes one scene read 50 px and the next 90 px.
 */
export const MIN_AUTO_FIT_SCALE = 0.85;
/** A mild shrink is tried only to keep a caption on one screen instead of splitting it. */
const AVOID_SPLIT_SCALES = [0.95, 0.9] as const;
/** Bump when the fitting rules change, so an unchanged project still re-renders (render recipe). */
export const SUBTITLE_FIT_RULES = "wrap-split-shrink-v2";

function wrapWords(words: string[], perLine: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > perLine && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Greedy wrap, then even the lines out ("long line / one word" reads badly). */
function balancedWrap(words: string[], perLine: number): string[] {
  const greedy = wrapWords(words, perLine);
  if (greedy.length !== 2) return greedy;
  let best = greedy;
  let bestLongest = Math.max(...greedy.map((l) => l.length));
  for (let i = 1; i < words.length; i += 1) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const longest = Math.max(a.length, b.length);
    if (longest <= perLine && longest < bestLongest) {
      best = [a, b];
      bestLongest = longest;
    }
  }
  return best;
}

/** A word that ends a phrase - the natural place to start a new screen. A leading "Max:" label is not one. */
const endsPhrase = (word: string, index: number) => /[.,!?;…:"”)]$/.test(word) && !(index === 0 && /:$/.test(word));

/**
 * Split words into `count` screens of similar length, preferring to break
 * after punctuation. Pure word boundaries, nothing is dropped or reordered.
 */
function splitScreens(words: string[], count: number): string[][] {
  if (count <= 1) return [words];
  const lengths = words.map((w) => w.length + 1);
  const total = lengths.reduce((n, l) => n + l, 0);
  const groups: string[][] = [];
  let start = 0;
  let acc = 0;
  for (let k = 1; k < count; k += 1) {
    const target = (total * k) / count;
    let bestIndex = -1;
    let bestScore = Infinity;
    let running = acc;
    // Leave at least one word for each screen still to come.
    for (let i = start; i < words.length - (count - k); i += 1) {
      running += lengths[i]!;
      const score = Math.abs(running - target) - (endsPhrase(words[i]!, i) ? total / count / 3 : 0);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex < start) bestIndex = start;
    groups.push(words.slice(start, bestIndex + 1));
    for (let i = start; i <= bestIndex; i += 1) acc += lengths[i]!;
    start = bestIndex + 1;
  }
  groups.push(words.slice(start));
  return groups.filter((g) => g.length > 0);
}

/**
 * Break one caption into screens of at most `maxLines` lines, keeping the
 * project's base size. In this order (QĐ-126):
 *   1. wrap onto up to `maxLines` lines at the BASE size;
 *   2. a long caption becomes consecutive screens over the same time, split
 *      at punctuation where possible (only a 5–10 % shrink is tried first, and
 *      only if it keeps the caption on ONE screen);
 *   3. shrink further only for a single word wider than a line - never below
 *      MIN_AUTO_FIT_SCALE.
 * Short and long captions, and "Speaker: line" captions, therefore read at the
 * same size. It is never cut, and never grows into a wall of text.
 */
export function fitCaption(text: string, layout: SubtitleLayout): { fontSize: number; screens: string[][] } {
  const words = text.split(/\s+/).filter(Boolean);
  const minSize = Math.max(layout.minFontSize, Math.round(layout.fontSize * MIN_AUTO_FIT_SCALE));
  const perLineAt = (size: number) => Math.max(1, Math.floor((layout.charsPerLine * layout.fontSize) / size));
  const linesPerScreenAt = (size: number) => Math.max(1, Math.min(layout.maxLines, Math.floor(layout.maxBlockHeight / (size * 1.25)) || 1));

  let fontSize = layout.fontSize;
  if (layout.autoFit) {
    // A single word wider than a line: the one case shrinking is the only way.
    const longestWord = Math.max(0, ...words.map((w) => w.length));
    if (longestWord > perLineAt(fontSize)) {
      fontSize = Math.max(minSize, Math.round((layout.fontSize * layout.charsPerLine) / longestWord));
    }
  }

  const fitsOneScreen = (size: number) => wrapWords(words, perLineAt(size)).length <= linesPerScreenAt(size);
  if (layout.autoFit && !fitsOneScreen(fontSize)) {
    for (const scale of AVOID_SPLIT_SCALES) {
      const size = Math.max(minSize, Math.round(layout.fontSize * scale));
      if (size < fontSize && fitsOneScreen(size)) {
        fontSize = size;
        break;
      }
    }
  }

  const perLine = perLineAt(fontSize);
  const linesPerScreen = linesPerScreenAt(fontSize);
  const lineCount = wrapWords(words, perLine).length;
  let count = Math.max(1, Math.ceil(lineCount / linesPerScreen));
  for (; count <= Math.max(1, words.length); count += 1) {
    const groups = splitScreens(words, count);
    const screens = groups.map((g) => balancedWrap(g, perLine));
    if (screens.every((s) => s.length <= linesPerScreen)) return { fontSize, screens: screens.length ? screens : [[]] };
  }
  // Unreachable in practice (one word per screen always fits); keep a safe answer.
  return { fontSize, screens: words.length ? words.map((w) => [w]) : [[]] };
}

/** True when two controls differ only in what the local render does (always, except voice). */
export function voiceChanged(a: OutputControls, b: OutputControls): boolean {
  return JSON.stringify(a.voice) !== JSON.stringify(b.voice);
}
