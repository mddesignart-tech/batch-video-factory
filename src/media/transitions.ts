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
 * OUTGOING scene is rendered a little longer (its "tail": the camera keeps
 * moving on the same curve) and the blend starts exactly where the next scene
 * starts. Each scene still begins at its own planned second, and the outgoing
 * picture is still in motion under the blend - never a frozen frame (the old
 * tpad clone froze it for the whole blend). Total length = the sum of scene
 * lengths, as with a cut. Without a tail the last frame is held, as before.
 *
 * Short on purpose (0.2 s crossfade): a long dissolve between two shots of the
 * same character shows two faces at once. A blend that overlays the pictures
 * is therefore turned into a cut when both scenes show the same character.
 */

export interface TransitionSpec {
  /** FFmpeg xfade transition name. */
  xfade: string;
  /** Preferred length in seconds (clamped to the scenes either side). */
  durationSec: number;
}

/** CUT / NONE (and anything unknown) = no blend: the join stays a hard cut. */
export const TRANSITION_SPEC: Partial<Record<Transition, TransitionSpec>> = {
  CROSSFADE: { xfade: "fade", durationSec: 0.2 },
  WHIP: { xfade: "smoothleft", durationSec: 0.2 },
  ZOOM: { xfade: "zoomin", durationSec: 0.25 },
  // MATCH is a cut on matching content (shape, motion, framing) - never a blend.
};

/** Blends that lay one picture over the other (ghosting risk); a slide (WHIP) does not. */
const OVERLAYS = new Set<Transition>(["CROSSFADE", "ZOOM"]);

/** A transition never takes more than this share of either neighbouring scene. */
const MAX_SHARE = 0.25;

export interface PlannedJoin {
  /** Index of the INCOMING scene (1..n-1). */
  index: number;
  spec: TransitionSpec | null;
  /** Clamped blend length; 0 for a cut. */
  durationSec: number;
  /** Why a requested blend became a cut. */
  guard?: "SAME_SUBJECT" | "TOO_SHORT";
}

/**
 * One join per scene boundary. Scene 0's `transitionIn` is ignored (nothing
 * before it). Lengths are clamped so a short scene is never mostly blend.
 * `subjects` (characters on screen per scene): an overlaying blend between two
 * scenes that share a character becomes a cut - no double faces.
 */
export function planJoins(
  transitions: (Transition | null | undefined)[],
  durations: number[],
  subjects?: (string[] | null | undefined)[],
): PlannedJoin[] {
  const joins: PlannedJoin[] = [];
  for (let i = 1; i < durations.length; i += 1) {
    const t = transitions[i];
    const spec = t ? (TRANSITION_SPEC[t] ?? null) : null;
    if (!spec) {
      joins.push({ index: i, spec: null, durationSec: 0 });
      continue;
    }
    const before = new Set((subjects?.[i - 1] ?? []).map((n) => n.toLowerCase()));
    if (t && OVERLAYS.has(t) && (subjects?.[i] ?? []).some((n) => before.has(n.toLowerCase()))) {
      joins.push({ index: i, spec: null, durationSec: 0, guard: "SAME_SUBJECT" });
      continue;
    }
    const cap = Math.min(durations[i - 1] ?? 0, durations[i] ?? 0) * MAX_SHARE;
    const d = Math.round(Math.min(spec.durationSec, cap) * 1000) / 1000;
    joins.push(d >= 0.1 ? { index: i, spec, durationSec: d } : { index: i, spec: null, durationSec: 0, guard: "TOO_SHORT" });
  }
  return joins;
}

/** Extra seconds each scene is rendered past its end: the blend into the NEXT scene. */
export function blendTails(joins: PlannedJoin[], sceneCount: number): number[] {
  const tails = new Array<number>(sceneCount).fill(0);
  for (const j of joins) if (j.spec) tails[j.index - 1] = j.durationSec;
  return tails;
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
  /** Each scene's length on the clock (not counting its tail). */
  durations: number[];
  transitions: (Transition | null | undefined)[];
  subjects?: (string[] | null | undefined)[];
  /** Seconds each input runs past its scene (see blendTails); absent = 0 (last frame held under a blend). */
  tails?: number[];
  fps: number;
  output: string;
}): string[] {
  const { inputs, durations, fps, output } = opts;
  const joins = planJoins(opts.transitions, durations, opts.subjects);
  const tail = (i: number) => opts.tails?.[i] ?? 0;
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const input of inputs) args.push("-i", input);

  const parts: string[] = [];
  // Every scene trimmed to its exact length (+ tail) on a common clock, so offsets are exact.
  inputs.forEach((_, i) => {
    const d = Number(((durations[i] ?? 0) + tail(i)).toFixed(3));
    parts.push(`[${i}:v]trim=duration=${d},setpts=PTS-STARTPTS,fps=${fps},settb=AVTB[s${i}]`);
  });

  let current = "s0";
  let elapsed = Number((durations[0] ?? 0).toFixed(3));
  for (const join of joins) {
    const next = `s${join.index}`;
    const out = `j${join.index}`;
    if (join.spec) {
      // The outgoing scene's own tail covers the blend; only a missing part is held.
      const missing = Number((join.durationSec - tail(join.index - 1)).toFixed(3));
      let from = current;
      if (missing > 0.0005) {
        from = `h${join.index}`;
        parts.push(`[${current}]tpad=stop_mode=clone:stop_duration=${missing}[${from}]`);
      }
      parts.push(
        `[${from}][${next}]xfade=transition=${join.spec.xfade}:duration=${join.durationSec}:offset=${elapsed.toFixed(3)}[${out}]`,
      );
    } else {
      parts.push(`[${current}][${next}]concat=n=2:v=1:a=0[${out}]`);
    }
    current = out;
    elapsed = Number((elapsed + (durations[join.index] ?? 0)).toFixed(3));
  }
  parts.push(`[${current}]format=yuv420p[v]`);
  // Audio never carries a tail: each scene's sound is exactly its own length.
  inputs.forEach((_, i) => parts.push(`[${i}:a]atrim=duration=${Number((durations[i] ?? 0).toFixed(3))},asetpts=PTS-STARTPTS[a${i}]`));
  parts.push(`${inputs.map((_, i) => `[a${i}]`).join("")}concat=n=${inputs.length}:v=0:a=1[a]`);

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
