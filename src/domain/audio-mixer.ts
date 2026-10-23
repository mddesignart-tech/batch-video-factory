/**
 * AUDIO MIXER (QĐ-150): one continuous music bed under the whole video, ducked
 * from the dialogue TIMELINE rather than by a compressor listening to the voice.
 * Pure: no database, no FFmpeg.
 *
 * Why not the old sidechain (QĐ-149): with attack 20 ms / release 350 ms and a
 * 12 dB target (measured ~20 dB) the bed rose in every ~0.6 s pause at a scene
 * change and was slammed down when the next line began - heard as the music
 * "jumping". Here the duck is a volume curve drawn from where the lines are:
 *
 *   - the music starts falling `attackMs` BEFORE a line, so the first word is clean;
 *   - it rises over `releaseMs` after the line;
 *   - a pause shorter than attack + release is bridged, so a scene gap never
 *     lets the bed swell and drop again (no pumping);
 *   - the depth is exactly `duckDb`, whatever the voice level.
 *
 * 100 % music = the level the person approved on the AIVietLab test (2026-10-23,
 * "+2 dB" render): the track is first measured and brought to MUSIC_REF_LUFS,
 * so 100 % sounds the same with any song. Percent is amplitude, like the voice
 * slider: 200 % = +6 dB, 50 % = -6 dB.
 *
 * A project without a stored mixer (`audio.mixer` null) renders exactly as it
 * always did - the old graph, untouched.
 */

import { z } from "zod";

/**
 * Pre-duck loudness of the bed at 100 %. The approved render played
 * data/music/aivietlab-tech-bg.mp3 (whole file -13.1 LUFS) at -6.2 dB.
 */
export const MUSIC_REF_LUFS = -19.3;
/** A near-silent or very quiet track is not boosted beyond this to reach the reference. */
export const MAX_MUSIC_MAKEUP_DB = 20;
/** Final safety limiter ceiling (linear, ~-1 dBFS). A normal mix never reaches it. */
export const LIMITER_CEILING = 0.891;

export const AudioMixerSchema = z.object({
  /** The preset these values came from (copied, never linked). Null = custom. */
  presetId: z.string().nullable().default(null),
  /** 0..2 = 0–200 %, 1 = MUSIC_REF_LUFS. */
  musicPct: z.number().min(0).max(2).default(1),
  /** dB the music drops under speech, 0–24 (the on/off switch is audio.duckMusic). */
  duckDb: z.number().min(0).max(24).default(6),
  attackMs: z.number().min(20).max(1000).default(200),
  releaseMs: z.number().min(50).max(3000).default(800),
  /** Music only - the voice is never faded. 0 = none. */
  fadeInSec: z.number().min(0).max(10).default(1),
  fadeOutSec: z.number().min(0).max(10).default(1.5),
});
export type AudioMixer = z.infer<typeof AudioMixerSchema>;

/** What a preset sets. Voice / effects go to the project's existing knobs. */
export const AudioPresetValuesSchema = AudioMixerSchema.omit({ presetId: true }).extend({
  /** 0..2, the narration slider (audio.narrationVolume). */
  voicePct: z.number().min(0).max(2).default(1),
  /** audio.duckMusic. */
  duck: z.boolean().default(true),
  /** 0..1, audio.sfxVolume. */
  sfxPct: z.number().min(0).max(1).default(0.4),
});
export type AudioPresetValues = z.infer<typeof AudioPresetValuesSchema>;

export interface AudioPreset {
  id: string;
  name: string;
  description: string;
  /** System presets cannot be edited or deleted. */
  system: boolean;
  values: AudioPresetValues;
}

export const CustomAudioPresetSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(60),
  values: AudioPresetValuesSchema,
});
export type CustomAudioPreset = z.infer<typeof CustomAudioPresetSchema>;

/**
 * Built-in presets. REVIEW_AI is the one a person listened to and approved
 * (AIVietLab, Thục Đoan, 2026-10-23). The others are derived from it with
 * modest, deliberate offsets - never loud for the sake of "energy" - and are
 * marked so in their description until someone has listened to them.
 */
export const SYSTEM_AUDIO_PRESETS: readonly AudioPreset[] = [
  {
    id: "REVIEW_AI",
    name: "Review AI",
    description: "Giọng rõ, nhạc nhẹ, hạ nhạc vừa phải khi thuyết minh. Đã nghe duyệt (AIVietLab).",
    system: true,
    values: { musicPct: 1, voicePct: 1, duck: true, duckDb: 6, attackMs: 200, releaseMs: 800, fadeInSec: 1, fadeOutSec: 1.5, sfxPct: 0.4 },
  },
  {
    id: "FUNNY",
    name: "Video hài hước",
    description: "Nhạc sôi động hơn (+1,2 dB), hiệu ứng rõ, hạ/hồi nhạc nhanh theo nhịp. Suy ra từ Review AI, chưa nghe duyệt.",
    system: true,
    values: { musicPct: 1.15, voicePct: 1, duck: true, duckDb: 5, attackMs: 120, releaseMs: 500, fadeInSec: 0.5, fadeOutSec: 1, sfxPct: 0.7 },
  },
  {
    id: "STORY",
    name: "Kể chuyện",
    description: "Giọng ấm tự nhiên, nhạc cảm xúc nhưng lùi sau lời, chuyển âm lượng rất mềm. Suy ra từ Review AI, chưa nghe duyệt.",
    system: true,
    values: { musicPct: 0.9, voicePct: 1, duck: true, duckDb: 8, attackMs: 300, releaseMs: 1200, fadeInSec: 2, fadeOutSec: 3, sfxPct: 0.3 },
  },
  {
    id: "PRODUCT",
    name: "Review sản phẩm",
    description: "Giọng rõ, nhạc năng lượng vừa, không lấn lời giới thiệu sản phẩm. Suy ra từ Review AI, chưa nghe duyệt.",
    system: true,
    values: { musicPct: 0.85, voicePct: 1, duck: true, duckDb: 8, attackMs: 200, releaseMs: 900, fadeInSec: 1, fadeOutSec: 1.5, sfxPct: 0.4 },
  },
  {
    id: "NO_VOICE",
    name: "Video không lời",
    description: "Nhạc và hiệu ứng là chính (~-16 LUFS), không hạ nhạc vì không có giọng. Suy ra từ Review AI, chưa nghe duyệt.",
    system: true,
    values: { musicPct: 1.4, voicePct: 1, duck: false, duckDb: 0, attackMs: 200, releaseMs: 800, fadeInSec: 1, fadeOutSec: 2, sfxPct: 0.7 },
  },
];

export const DEFAULT_AUDIO_PRESET_ID = "REVIEW_AI";

export function systemPreset(id: string): AudioPreset | null {
  return SYSTEM_AUDIO_PRESETS.find((p) => p.id === id) ?? null;
}

/** System first, then the person's own (custom ids never shadow a system id). */
export function allPresets(custom: readonly CustomAudioPreset[]): AudioPreset[] {
  const ids = new Set(SYSTEM_AUDIO_PRESETS.map((p) => p.id));
  return [
    ...SYSTEM_AUDIO_PRESETS,
    ...custom
      .filter((p) => !ids.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, description: "Preset tự tạo", system: false, values: AudioPresetValuesSchema.parse(p.values) })),
  ];
}

/**
 * The project's audio patch for a preset. Values are COPIED: editing or deleting
 * the preset later never changes a project that already used it.
 */
export function presetToAudioPatch(preset: AudioPreset): {
  narrationVolume: number;
  duckMusic: boolean;
  sfxVolume: number;
  mixer: AudioMixer;
} {
  const v = preset.values;
  return {
    narrationVolume: v.voicePct,
    duckMusic: v.duck,
    sfxVolume: v.sfxPct,
    mixer: AudioMixerSchema.parse({
      presetId: preset.id,
      musicPct: v.musicPct,
      duckDb: v.duckDb,
      attackMs: v.attackMs,
      releaseMs: v.releaseMs,
      fadeInSec: v.fadeInSec,
      fadeOutSec: v.fadeOutSec,
    }),
  };
}

/** The values a project currently has, in preset form (for "Lưu preset"). */
export function audioToPresetValues(audio: { narrationVolume: number; duckMusic: boolean; sfxVolume: number; mixer: AudioMixer }): AudioPresetValues {
  const { presetId: _presetId, ...m } = audio.mixer;
  return AudioPresetValuesSchema.parse({ ...m, voicePct: audio.narrationVolume, duck: audio.duckMusic, sfxPct: audio.sfxVolume });
}

// --------------------------------------------------------------- music level ---

/** Gain (dB) that brings a track measured at `measuredLufs` to `pct` of the reference. */
export function musicGainDb(measuredLufs: number | null, pct: number): number | null {
  if (!(pct > 0)) return null; // muted
  const toRef = measuredLufs !== null && Number.isFinite(measuredLufs) ? MUSIC_REF_LUFS - measuredLufs : 0;
  const db = Math.min(MAX_MUSIC_MAKEUP_DB, toRef) + 20 * Math.log10(pct);
  return Math.round(db * 100) / 100;
}

// -------------------------------------------------------------- speech regions ---

export interface SpeechRegion {
  startSec: number;
  endSec: number;
}

/**
 * Sort, drop empty ones and merge overlapping regions plus any pause shorter
 * than `bridgeSec` - inside such a pause the music stays down instead of
 * swelling for a fraction of a second.
 */
export function mergeSpeechRegions(regions: readonly SpeechRegion[], bridgeSec: number): SpeechRegion[] {
  const sorted = regions
    .filter((r) => Number.isFinite(r.startSec) && Number.isFinite(r.endSec) && r.endSec > r.startSec)
    .map((r) => ({ startSec: Math.max(0, r.startSec), endSec: r.endSec }))
    .sort((a, b) => a.startSec - b.startSec);
  const out: SpeechRegion[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startSec - last.endSec < bridgeSec) last.endSec = Math.max(last.endSec, r.endSec);
    else out.push({ ...r });
  }
  return out;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * FFmpeg `volume` expression (per frame, `t` in seconds) for the duck curve:
 * 0 dB away from speech, -duckDb under it, linear-in-dB ramps of attack before
 * and release after each (merged) region. Merged regions are at least
 * attack + release apart, so the ramps never overlap and a plain sum is exact.
 * Null = nothing to duck (no speech, or depth 0).
 */
export function duckVolumeExpression(
  regions: readonly SpeechRegion[],
  opts: { duckDb: number; attackMs: number; releaseMs: number },
): string | null {
  if (!(opts.duckDb > 0)) return null;
  const a = Math.max(0.001, opts.attackMs / 1000);
  const r = Math.max(0.001, opts.releaseMs / 1000);
  const merged = mergeSpeechRegions(regions, a + r);
  if (merged.length === 0) return null;
  const terms = merged.map((m) => `clip((t-${r3(m.startSec - a)})/${r3(a)},0,1)*clip((${r3(m.endSec + r)}-t)/${r3(r)},0,1)`);
  return `pow(10,-${r3(opts.duckDb)}*(${terms.join("+")})/20)`;
}

/** The duck curve's gain in dB at `t` - the same maths as the expression, for tests and the UI. */
export function duckGainDbAt(
  t: number,
  regions: readonly SpeechRegion[],
  opts: { duckDb: number; attackMs: number; releaseMs: number },
): number {
  if (!(opts.duckDb > 0)) return 0;
  const a = Math.max(0.001, opts.attackMs / 1000);
  const r = Math.max(0.001, opts.releaseMs / 1000);
  const clip = (x: number) => Math.min(1, Math.max(0, x));
  let env = 0;
  for (const m of mergeSpeechRegions(regions, a + r)) {
    env += clip((t - (m.startSec - a)) / a) * clip((m.endSec + r - t) / r);
  }
  return env > 0 ? -opts.duckDb * Math.min(1, env) : 0;
}

// ------------------------------------------------------------- preview windows ---

export const PREVIEW_KINDS = ["SPEECH", "GAP", "TRANSITION"] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];
export const VI_PREVIEW_KIND: Record<PreviewKind, string> = {
  SPEECH: "Đoạn có lời",
  GAP: "Đoạn không lời",
  TRANSITION: "Đoạn chuyển cảnh",
};

/**
 * Which ~`lengthSec` of the video a preview plays: the first line (SPEECH),
 * the longest pause or the intro/outro (GAP), or the scene change nearest the
 * middle (TRANSITION). Null when the video has no such moment.
 */
export function previewWindow(
  kind: PreviewKind,
  input: { totalSec: number; regions: readonly SpeechRegion[]; sceneStartsSec: readonly number[] },
  lengthSec = 8,
): { startSec: number; endSec: number } | null {
  const total = input.totalSec;
  if (!(total > 0)) return null;
  const len = Math.min(lengthSec, total);
  const at = (centre: number) => {
    const start = Math.min(Math.max(0, centre - len / 2), Math.max(0, total - len));
    return { startSec: r3(start), endSec: r3(start + len) };
  };
  const regions = mergeSpeechRegions(input.regions, 0);
  if (kind === "SPEECH") {
    const first = regions[0];
    if (!first) return null;
    // From just before the first line, so the duck going down is heard too.
    const start = Math.min(Math.max(0, first.startSec - 1), Math.max(0, total - len));
    return { startSec: r3(start), endSec: r3(start + len) };
  }
  if (kind === "GAP") {
    if (regions.length === 0) return at(total / 2);
    const gaps: { s: number; e: number }[] = [{ s: 0, e: regions[0]!.startSec }];
    for (let i = 1; i < regions.length; i += 1) gaps.push({ s: regions[i - 1]!.endSec, e: regions[i]!.startSec });
    gaps.push({ s: regions[regions.length - 1]!.endSec, e: total });
    const best = gaps.sort((x, y) => y.e - y.s - (x.e - x.s))[0]!;
    if (best.e - best.s < 0.5) return null;
    return at((best.s + best.e) / 2);
  }
  const cuts = input.sceneStartsSec.filter((s) => s > 0.5 && s < total - 0.5);
  if (cuts.length === 0) return null;
  const mid = total / 2;
  const cut = cuts.reduce((best, s) => (Math.abs(s - mid) < Math.abs(best - mid) ? s : best), cuts[0]!);
  return at(cut);
}
