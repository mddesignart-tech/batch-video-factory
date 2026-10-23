/**
 * QĐ-151 LOCAL_MOTION V2 - PROTOTYPE ONLY (not imported by src/, not used by
 * the app). A camera path on a still, rendered with SUB-PIXEL precision.
 *
 * Why (see docs/QD151_MOTION_RESEARCH.md): production `zoompan` crops whole
 * source pixels, and the crop SIZE (iw/zoom) is rounded too, so the scale and
 * the position step independently - on a slow move each frame lands a little
 * early or late. Here the camera window is described in normalised, real-valued
 * coordinates per frame and FFmpeg's `perspective` filter samples it with cubic
 * interpolation (no rounding), at `supersample` x the output size, then a
 * Lanczos down-scale anti-aliases fine detail.
 *
 * Paths: start/end state (zoom, window centre) eased by a curve; intensities
 * are fixed numbers (reproducible, no randomness).
 */

export type V2Easing = "LINEAR" | "SINE" | "SMOOTHSTEP" | "SMOOTHERSTEP" | "PROD_EASE_IN_OUT";
export type V2Intensity = "SUBTLE" | "NORMAL" | "DYNAMIC" | "CINEMATIC";
export type V2Move =
  | "PAN_LEFT" | "PAN_RIGHT" | "ZOOM_IN" | "ZOOM_OUT" | "DOLLY_IN" | "DOLLY_OUT"
  | "TILT_UP" | "TILT_DOWN" | "DIAGONAL" | "SUBTLE_CINEMATIC";

/** Zoom amplitude (share of the frame) and pan overscan per intensity. */
export const V2_INTENSITY: Record<V2Intensity, { zoom: number; pan: number; endSpeed: number }> = {
  // endSpeed = linear share kept at both ends (0 = full stop, like a hand-operated move;
  // >0 = still moving at a cut). Production keeps 0.4.
  SUBTLE: { zoom: 0.05, pan: 0.05, endSpeed: 0.3 },
  NORMAL: { zoom: 0.08, pan: 0.08, endSpeed: 0.3 },
  DYNAMIC: { zoom: 0.14, pan: 0.12, endSpeed: 0.4 },
  CINEMATIC: { zoom: 0.1, pan: 0.07, endSpeed: 0.15 },
};

/** Progress curve as an FFmpeg expression of `L` (0..1), mixed with `v` linear share. */
export function curveExpr(easing: V2Easing, L: string, v: number): string {
  const c = (() => {
    switch (easing) {
      case "LINEAR":
        return L;
      case "SINE":
        return `(0.5-0.5*cos(PI*${L}))`;
      case "SMOOTHSTEP":
        return `(${L}*${L}*(3-2*${L}))`;
      case "SMOOTHERSTEP":
        return `(${L}*${L}*${L}*(${L}*(${L}*6-15)+10))`;
      case "PROD_EASE_IN_OUT":
        // Production's curve (camera-motion.ts easingExpr), for a like-for-like path.
        return `(0.4*${L}+0.6*(0.5-0.5*cos(PI*${L})))`;
    }
  })();
  return easing === "LINEAR" || easing === "PROD_EASE_IN_OUT" || v <= 0 ? c : `(${v}*${L}+${1 - v}*${c})`;
}

/**
 * A move as three expressions of the eased progress E (stored in ld(1)):
 * zoom z (>= 1), and the window's top-left corner (left, top) in normalised
 * frame units (window size = 1/z). ld(2) holds z.
 */
export interface V2PathExprs {
  z: string;
  left: string;
  top: string;
}

const E = "ld(1)";
const Z = "ld(2)";
const centred = { left: `(1-1/${Z})/2`, top: `(1-1/${Z})/2` };

export function v2Path(move: V2Move, intensity: V2Intensity): V2PathExprs {
  const { zoom: A, pan: O } = V2_INTENSITY[intensity];
  const n = (x: number) => x.toFixed(4);
  switch (move) {
    case "ZOOM_IN":
      return { z: `1+${n(A)}*${E}`, ...centred };
    case "ZOOM_OUT":
      return { z: `1+${n(A)}*(1-${E})`, ...centred };
    case "DOLLY_IN":
      // Forward move: zoom plus a slight rise of the horizon (no real perspective without depth).
      return { z: `1+${n(A * 1.25)}*${E}`, left: centred.left, top: `max(0,(1-1/${Z})/2-0.008*${E})` };
    case "DOLLY_OUT":
      return { z: `1+${n(A * 1.25)}*(1-${E})`, left: centred.left, top: `max(0,(1-1/${Z})/2-0.008*(1-${E}))` };
    case "PAN_RIGHT":
      return { z: n(1 + O), left: `(1-1/${Z})*${E}`, top: centred.top };
    case "PAN_LEFT":
      return { z: n(1 + O), left: `(1-1/${Z})*(1-${E})`, top: centred.top };
    case "TILT_UP":
      return { z: n(1 + O), left: centred.left, top: `(1-1/${Z})*(1-${E})` };
    case "TILT_DOWN":
      return { z: n(1 + O), left: centred.left, top: `(1-1/${Z})*${E}` };
    case "DIAGONAL":
      return { z: `${n(1 + O)}+${n(A / 2)}*${E}`, left: `(1-1/${Z})*${E}`, top: `(1-1/${Z})*(1-${E})` };
    case "SUBTLE_CINEMATIC":
      // Slow push with a gentle lateral drift: the "breathing" establishing shot.
      return { z: `1.02+${n(A * 0.6)}*${E}`, left: `(1-1/${Z})*(0.35+0.3*${E})`, top: `(1-1/${Z})*0.5` };
  }
}

/** Production's own path for the moves we compare like for like (camera-motion.ts, SLOW, >= 3 s). */
export function productionPath(move: "ZOOM_IN" | "PAN_RIGHT" | "TILT_UP" | "DOLLY_IN"): V2PathExprs {
  switch (move) {
    case "ZOOM_IN":
      return { z: `1+0.0800*${E}`, ...centred };
    case "DOLLY_IN":
      return { z: `1+0.1000*${E}`, left: centred.left, top: `max(0,(1-1/${Z})/2-0.008*${E})` };
    case "PAN_RIGHT":
      return { z: "1.0800", left: `(1-1/${Z})*${E}`, top: centred.top };
    case "TILT_UP":
      return { z: "1.0800", left: centred.left, top: `(1-1/${Z})*(1-${E})` };
  }
}

/**
 * The video filter for one still: cover-crop at `supersample` x the output,
 * the camera window sampled per frame with sub-pixel precision, down-scale.
 */
export function v2Filter(opts: {
  path: V2PathExprs;
  easing: V2Easing;
  endSpeed: number;
  frames: number;
  width: number;
  height: number;
  supersample?: number;
}): string {
  const k = opts.supersample ?? 2;
  const W2 = Math.round((opts.width * k) / 2) * 2;
  const H2 = Math.round((opts.height * k) / 2) * 2;
  // perspective's `on` counts from 1 (first frame = 1): measured, see the research doc.
  const L = `min(1,(on-1)/${Math.max(1, opts.frames - 1)})`;
  const pre = `st(0,${L});st(1,${curveExpr(opts.easing, "ld(0)", opts.endSpeed)});st(2,${opts.path.z})`;
  const left = `(${opts.path.left})`;
  const top = `(${opts.path.top})`;
  const right = `(${left}+1/${Z})`;
  const bottom = `(${top}+1/${Z})`;
  const ex = (body: string) => `'${pre};${body}'`;
  const corners = [
    `x0=${ex(`W*${left}`)}`, `y0=${ex(`H*${top}`)}`,
    `x1=${ex(`W*${right}`)}`, `y1=${ex(`H*${top}`)}`,
    `x2=${ex(`W*${left}`)}`, `y2=${ex(`H*${bottom}`)}`,
    `x3=${ex(`W*${right}`)}`, `y3=${ex(`H*${bottom}`)}`,
  ].join(":");
  return (
    `scale=${W2}:${H2}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W2}:${H2},format=gbrp,` +
    `perspective=${corners}:interpolation=cubic:eval=frame,` +
    `scale=${opts.width}:${opts.height}:flags=lanczos,setsar=1,format=yuv420p`
  );
}

/** FFmpeg args: one still -> one silent CFR clip. */
export function v2Args(opts: {
  image: string;
  output: string;
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  path: V2PathExprs;
  easing: V2Easing;
  endSpeed: number;
  supersample?: number;
}): string[] {
  const frames = Math.round(opts.durationSec * opts.fps);
  return [
    "-y", "-hide_banner", "-loglevel", "error",
    "-loop", "1", "-framerate", String(opts.fps), "-t", String(opts.durationSec), "-i", opts.image,
    "-vf", v2Filter({ ...opts, frames }),
    "-frames:v", String(frames),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(opts.fps),
    opts.output,
  ];
}

/**
 * Integration probe: take the EXACT `zoompan` expressions production builds
 * (camera-motion.ts cameraZoompan) and re-express them for `perspective`:
 * source pixels -> normalised units (iw, ih -> 1), `zoom` -> ld(2), and
 * `on` -> (on-1) because perspective counts frames from 1. Same path, every
 * move, no second definition to keep in sync. Returns null when the chain has
 * no zoompan (STATIC) or uses something perspective cannot express.
 */
export function fromProductionZoompan(chain: string): V2PathExprs | null {
  const m = /zoompan=z='([^']*)':x='([^']*)':y='([^']*)'/.exec(chain);
  if (!m) return null;
  const norm = (e: string) =>
    e
      .replace(/\bon\b/g, "(on-1)")
      .replace(/\biw\b/g, "1")
      .replace(/\bih\b/g, "1")
      .replace(/\bzoom\b/g, Z);
  // zoompan clamps the window inside the picture (av_clipd); do the same.
  const z = `max(1,${norm(m[1]!)})`;
  const left = `max(0,min(1-1/${Z},${norm(m[2]!)}))`;
  const top = `max(0,min(1-1/${Z},${norm(m[3]!)}))`;
  return { z, left, top };
}

/** v2Filter for a path whose expressions already contain the frame counter (no easing wrapper). */
export function v2FilterRaw(opts: { path: V2PathExprs; width: number; height: number; supersample?: number }): string {
  const k = opts.supersample ?? 1;
  const W2 = Math.round((opts.width * k) / 2) * 2;
  const H2 = Math.round((opts.height * k) / 2) * 2;
  const pre = `st(2,${opts.path.z})`;
  const left = `(${opts.path.left})`;
  const top = `(${opts.path.top})`;
  const right = `(${left}+1/${Z})`;
  const bottom = `(${top}+1/${Z})`;
  const ex = (body: string) => `'${pre};${body}'`;
  return (
    `scale=${W2}:${H2}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W2}:${H2},format=gbrp,` +
    `perspective=x0=${ex(`W*${left}`)}:y0=${ex(`H*${top}`)}:x1=${ex(`W*${right}`)}:y1=${ex(`H*${top}`)}:` +
    `x2=${ex(`W*${left}`)}:y2=${ex(`H*${bottom}`)}:x3=${ex(`W*${right}`)}:y3=${ex(`H*${bottom}`)}:interpolation=cubic:eval=frame,` +
    (k === 1 ? "" : `scale=${opts.width}:${opts.height}:flags=lanczos,`) +
    "setsar=1,format=yuv420p"
  );
}
