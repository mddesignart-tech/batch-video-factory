import type { Transition } from "@/domain/camera-grammar";

/**
 * Scene-to-scene transitions (xfade), local and $0.
 *
 * The scene plan has always stored a `transitionIn` suggestion; until now the
 * renderer joined every scene with a hard cut. This turns the suggestion into
 * an FFmpeg xfade - WITHOUT moving anything on the clock.
 *
 * A plain xfade overlaps two clips, so the video gets shorter by the transition
 * length and every later subtitle and voice line drifts early. Instead the
 * OUTGOING scene's last frame is held for the transition length (tpad clone)
 * and the blend starts exactly where the next scene starts. Each scene still
 * begins at its own planned second; the incoming scene simply fades in over
 * the held frame. Total length = the sum of scene lengths, as with a cut.
 */

export interface TransitionSpec {
  /** FFmpeg xfade transition name. */
  xfade: string;
  /** Preferred length in seconds (clamped to the scenes either side). */
  durationSec: number;
}

/** CUT / NONE (and anything unknown) = no blend: the join stays a hard cut. */
export const TRANSITION_SPEC: Partial<Record<Transition, TransitionSpec>> = {
  CROSSFADE: { xfade: "fade", durationSec: 0.5 },
  WHIP: { xfade: "smoothleft", durationSec: 0.25 },
  ZOOM: { xfade: "zoomin", durationSec: 0.4 },
  MATCH: { xfade: "dissolve", durationSec: 0.3 },
};

/** A transition never takes more than this share of either neighbouring scene. */
const MAX_SHARE = 0.25;

export interface PlannedJoin {
  /** Index of the INCOMING scene (1..n-1). */
  index: number;
  spec: TransitionSpec | null;
  /** Clamped blend length; 0 for a cut. */
  durationSec: number;
}

/**
 * One join per scene boundary. Scene 0's `transitionIn` is ignored (nothing
 * before it). Lengths are clamped so a short scene is never mostly blend.
 */
export function planJoins(transitions: (Transition | null | undefined)[], durations: number[]): PlannedJoin[] {
  const joins: PlannedJoin[] = [];
  for (let i = 1; i < durations.length; i += 1) {
    const t = transitions[i];
    const spec = t ? (TRANSITION_SPEC[t] ?? null) : null;
    if (!spec) {
      joins.push({ index: i, spec: null, durationSec: 0 });
      continue;
    }
    const cap = Math.min(durations[i - 1] ?? 0, durations[i] ?? 0) * MAX_SHARE;
    const d = Math.round(Math.min(spec.durationSec, cap) * 1000) / 1000;
    joins.push(d >= 0.1 ? { index: i, spec, durationSec: d } : { index: i, spec: null, durationSec: 0 });
  }
  return joins;
}

export function hasBlend(joins: PlannedJoin[]): boolean {
  return joins.some((j) => j.spec !== null);
}

/**
 * Join normalised scene files with transitions. All inputs come out of the
 * same normalise pass (same size, fps, pixel format, audio layout), which xfade
 * requires. Audio is joined back to back - it never blends, so speech is never
 * overlapped. Relative names: cwd is the temp folder.
 */
export function buildTransitionJoinArgs(opts: {
  inputs: string[];
  durations: number[];
  transitions: (Transition | null | undefined)[];
  fps: number;
  output: string;
}): string[] {
  const { inputs, durations, fps, output } = opts;
  const joins = planJoins(opts.transitions, durations);
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const input of inputs) args.push("-i", input);

  const parts: string[] = [];
  // Every scene trimmed to its exact length on a common clock, so offsets are exact.
  inputs.forEach((_, i) => {
    const d = Number((durations[i] ?? 0).toFixed(3));
    parts.push(`[${i}:v]trim=duration=${d},setpts=PTS-STARTPTS,fps=${fps},settb=AVTB[s${i}]`);
  });

  let current = "s0";
  let elapsed = Number((durations[0] ?? 0).toFixed(3));
  for (const join of joins) {
    const next = `s${join.index}`;
    const out = `j${join.index}`;
    if (join.spec) {
      const held = `h${join.index}`;
      parts.push(`[${current}]tpad=stop_mode=clone:stop_duration=${join.durationSec}[${held}]`);
      parts.push(
        `[${held}][${next}]xfade=transition=${join.spec.xfade}:duration=${join.durationSec}:offset=${elapsed.toFixed(3)}[${out}]`,
      );
    } else {
      parts.push(`[${current}][${next}]concat=n=2:v=1:a=0[${out}]`);
    }
    current = out;
    elapsed = Number((elapsed + (durations[join.index] ?? 0)).toFixed(3));
  }
  parts.push(`[${current}]format=yuv420p[v]`);
  parts.push(`${inputs.map((_, i) => `[${i}:a]`).join("")}concat=n=${inputs.length}:v=0:a=1[a]`);

  args.push(
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    // Intermediate: the final pass re-encodes once more, so keep it near-lossless.
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    output,
  );
  return args;
}
