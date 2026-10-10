/**
 * LOCAL CAMERA + LAYER COMPOSITOR (QĐ-128) - FFmpeg, $0.
 *
 * Turns a scene's Camera Plan into real movement on a still picture, and - when
 * the scene has separate layer files - stacks background, ambient loops and a
 * transparent foreground with parallax. Pure argument builders: no FFmpeg is
 * run here, so everything is unit-testable.
 *
 * Honest limits (see camera-grammar `localSupport`):
 *  - pan / tilt / zoom / crash zoom are exact on a still;
 *  - push / dolly / track / truck / parallax / handheld / whip are
 *    convincing approximations (no real perspective change);
 *  - orbit / arc / crane are never faked - the plan carries a local fallback;
 *  - focus is never rendered (no depth data) - it lives in the prompts.
 *
 * Timing follows the voice: the move is spread over the FINAL scene length
 * (voice-aware, plus any blend tail), eased softly in and out and STILL MOVING
 * on the last frame - no hold, so a cut or blend never follows a freeze.
 *
 * Smoothness: zoompan crops on whole (and, in YUV, even) source pixels. The
 * picture is therefore upscaled 3x and converted to RGB first, so one source
 * step is a third of an output pixel and slow moves glide instead of stepping.
 */

import { localFallbackMove, localSupport, type CameraEasing, type CameraMove, type CameraSpeed } from "@/domain/camera-grammar";
import type { RenderTarget } from "./render";
import { PARALLAX_FACTOR } from "@/domain/scene-plan";
import { frameShape, subjectBoxes, subtitleTopLine, TOP_SAFE, type SubjectSlot } from "./layer-layout";
import type { SubjectKind } from "@/domain/subject-grounding";
import type { AmbientBand } from "@/domain/scene-layers";
import { SPEAKER_FOCUS, type BiasKey } from "@/domain/speaker-focus";

export interface LocalCameraSpec {
  move: CameraMove;
  speed: CameraSpeed;
  /** A CRITICAL product / animal / character is in frame: gentler, never cropped hard. */
  critical?: boolean;
  /** Absent = EASE_IN_OUT. */
  easing?: CameraEasing;
  /**
   * G4: lean keyframes towards the current speaker (see domain/speaker-focus).
   * Absent / empty = no lean (the plain move).
   */
  speakerBias?: BiasKey[];
  /** Lean size, share of the frame width (default 0.015). */
  speakerAmp?: number;
}

/**
 * The lean as an expression of the output frame `on`: a sum of eased steps,
 * one per change of speaker side. Never jumps: each change eases over ~1.2 s.
 */
export function speakerBiasExpr(keys: BiasKey[], fps: number): string {
  const D = SPEAKER_FOCUS.easeSec;
  const steps: string[] = [];
  for (let k = 1; k < keys.length; k += 1) {
    const delta = keys[k]!.side - keys[k - 1]!.side;
    if (delta === 0) continue;
    const p = `min(1,max(0,(on/${fps}-${keys[k]!.atSec.toFixed(3)})/${D}))`;
    steps.push(`${delta}*${p}*${p}*(3-2*${p})`);
  }
  return steps.length ? `(${steps.join("+")})` : "";
}

/** Zoom amplitude by speed (× the frame). Small on purpose: the subject must stay whole. */
const AMPLITUDE: Record<CameraSpeed, number> = { VERY_SLOW: 0.05, SLOW: 0.08, MEDIUM: 0.12, FAST: 0.18 };
/** Overscan that a pan travels across. */
const OVERSCAN: Record<CameraSpeed, number> = { VERY_SLOW: 0.06, SLOW: 0.08, MEDIUM: 0.1, FAST: 0.14 };
/** The tightest any local move may frame (safe area: faces / products stay in the picture). */
export const MAX_LOCAL_ZOOM = 1.2;
export const MAX_CRASH_ZOOM = 1.3;

/** The move a still can actually perform (orbit → truck, crane → tilt...). */
export function renderableMove(move: CameraMove): CameraMove {
  return localSupport(move) === "NONE" ? localFallbackMove(move) : move === "AUTO" ? "SLOW_ZOOM_IN" : move;
}

/** Linear share kept in every eased curve: the camera never reaches zero speed mid-scene. */
const EASE_FLOOR = 0.4;

/**
 * Progress 0..1 of a move, as an FFmpeg expression of the linear progress `L`.
 * Eased curves mix in a linear share, so the speed at either end is 40 % of the
 * average instead of 0 - soft, but never a stop.
 */
export function easingExpr(easing: CameraEasing, L: string): string {
  const k = EASE_FLOOR;
  switch (easing) {
    case "LINEAR":
      return L;
    case "EASE_IN":
      return `(${k}*${L}+${1 - k}*(1-cos(PI/2*${L})))`;
    case "EASE_OUT":
      return `(${k}*${L}+${1 - k}*sin(PI/2*${L}))`;
    default:
      return `(${k}*${L}+${1 - k}*(0.5-0.5*cos(PI*${L})))`;
  }
}

/**
 * Source upscale before zoompan (see header): the picture's long side becomes
 * ~5760 px whatever the output size (3x for 1080x1920), so one source step is
 * the same tiny fraction of the frame at every size. Bounded for 4K / thumbnails.
 */
export function zoompanUpscale(target: RenderTarget): number {
  return Math.min(9, Math.max(1.5, 5760 / Math.max(target.width, target.height)));
}

/**
 * The `zoompan` part of the chain for one still: `,scale=...,zoompan=...`.
 * Empty string for STATIC (the picture simply holds).
 */
export function cameraZoompan(spec: LocalCameraSpec, opts: { durationSec: number; target: RenderTarget; amplitudeScale?: number; alpha?: boolean }): string {
  const lean = spec.speakerBias?.length ? speakerBiasExpr(spec.speakerBias, opts.target.fps) : "";
  const move0 = renderableMove(spec.move);
  if (move0 === "STATIC" && !lean) return "";
  const move = move0;
  const { width, height, fps } = opts.target;
  const frames = Math.max(1, Math.round(opts.durationSec * fps));
  // A short scene gets a smaller move (it has less time to travel); 3 s and up is full size.
  const scale = (opts.amplitudeScale ?? 1) * Math.min(1, Math.max(0.6, opts.durationSec / 3));
  const cap = spec.critical ? 0.08 : 1;
  const A = Math.min(AMPLITUDE[spec.speed] * scale, cap, MAX_LOCAL_ZOOM - 1);
  const O = Math.min(OVERSCAN[spec.speed] * scale, spec.critical ? 0.06 : 1);
  // Progress over EVERY output frame, first to last: no hold at the end.
  const L = `min(1,on/${Math.max(1, frames - 1)})`;
  const E = easingExpr(spec.easing ?? "EASE_IN_OUT", L);
  const cx = "iw/2-(iw/zoom/2)";
  const cy = "ih/2-(ih/zoom/2)";
  const rangeX = "(iw-iw/zoom)";
  const rangeY = "(ih-ih/zoom)";
  const quick = Math.max(1, Math.round(fps * 0.35));
  const n = (v: number) => v.toFixed(4);

  let z: string;
  let x = cx;
  let y = cy;
  switch (move) {
    case "SLOW_ZOOM_IN":
      z = `1+${n(A)}*${E}`;
      break;
    case "SLOW_ZOOM_OUT":
      z = `1+${n(A)}*(1-${E})`;
      break;
    case "PUSH_IN":
    case "DOLLY_IN":
      // Approximation: zoom plus a slight rise, as a camera moving forward reads.
      z = `1+${n(A * 1.25)}*${E}`;
      y = `max(0,${cy}-ih*0.008*${E})`;
      break;
    case "PULL_BACK":
    case "DOLLY_OUT":
      z = `1+${n(A * 1.25)}*(1-${E})`;
      y = `max(0,${cy}-ih*0.008*(1-${E}))`;
      break;
    case "PAN_RIGHT":
    case "TRUCK_RIGHT":
      z = `${n(1 + O)}`;
      x = `${rangeX}*${E}`;
      break;
    case "PAN_LEFT":
    case "TRUCK_LEFT":
      z = `${n(1 + O)}`;
      x = `${rangeX}*(1-${E})`;
      break;
    case "TRACK_RIGHT":
      z = `${n(1 + O)}+0.03*${E}`;
      x = `${rangeX}*${E}`;
      break;
    case "TRACK_LEFT":
      z = `${n(1 + O)}+0.03*${E}`;
      x = `${rangeX}*(1-${E})`;
      break;
    case "PAN_UP":
    case "TILT_UP":
      z = `${n(1 + O)}`;
      y = `${rangeY}*(1-${E})`;
      break;
    case "PAN_DOWN":
    case "TILT_DOWN":
      z = `${n(1 + O)}`;
      y = `${rangeY}*${E}`;
      break;
    case "PARALLAX":
      z = `${n(1 + O)}+0.04*${E}`;
      x = `${rangeX}*(0.35+0.3*${E})`;
      break;
    case "HANDHELD_SOFT":
      // A breathing, hand-held drift: two slow sines, tiny amplitude.
      z = "1.06";
      x = `${rangeX}/2*(1+0.35*sin(on/${fps}*1.7))`;
      y = `${rangeY}/2*(1+0.35*cos(on/${fps}*1.3))`;
      break;
    case "GIMBAL":
      z = `1.06+0.03*${E}`;
      x = `${rangeX}*(0.4+0.2*${E})`;
      break;
    case "CRASH_ZOOM":
      z = `1+${n(Math.min(spec.critical ? 0.08 : 0.3, MAX_CRASH_ZOOM - 1))}*min(1,on/${quick})`;
      break;
    case "WHIP_PAN":
      z = "1.12";
      x = `${rangeX}*0.5*min(1,on/${quick})`;
      break;
    default:
      z = `1+${n(A)}*${E}`;
  }
  if (lean) {
    // Room for the lean: a touch of extra zoom, then the horizontal offset on
    // top of the planned move (same frames, same easing - no new judder).
    const amp = (spec.speakerAmp ?? 0.015) * (opts.amplitudeScale ?? 1);
    if (move === "STATIC") {
      z = "1";
      x = cx;
      y = cy;
    }
    z = `(${z})+${n(amp * 2.2)}`;
    x = `(${x})+${n(amp)}*iw*${lean}`;
  }
  const up = zoompanUpscale(opts.target);
  // d = frames + 1: the fps filter after zoompan drops its last frame, and the
  // pad would then repeat the one before it - a one-frame freeze at the end.
  const even = (v: number) => Math.round((v * up) / 2) * 2;
  // A transparent layer plate keeps its alpha through the move (gbrap).
  return `,scale=${even(width)}:${even(height)}:flags=lanczos,format=${opts.alpha ? "gbrap" : "gbrp"},zoompan=z='${z}':x='${x}':y='${y}':d=${frames + 1}:s=${width}x${height}:fps=${fps}`;
}

// --------------------------------------------------------------- layered ---

/** A cut-out (transparent PNG) placed in the frame. */
export interface PlacedSubject {
  path: string;
  /** LEFT / CENTER / RIGHT for separate subjects; FULL = one cut-out holding the whole group. */
  slot?: SubjectSlot;
  /** A CRITICAL reference (product / character): its layer moves gently. */
  critical?: boolean;
  /** Size within its layout box (1 = a standing person). */
  scale?: number;
  /** Bottom edge of the subject, share of the frame height (default: the floor line). */
  floorY?: number;
  /** G10: what it is - sets the depth rules and the contact shadow. Absent = OBJECT. */
  kind?: SubjectKind;
  /** G10: flies (no contact shadow, not stood on the ground). */
  airborne?: boolean;
}

export interface LayerInputs {
  /** Background still (or the scene's own picture when there is no separate background). */
  background: string;
  /** Legacy: ONE transparent PNG of the subject(s) (= `foregrounds: [{ path, slot: "FULL" }]`). */
  foreground?: string | null;
  /** 1-3 cut-out subjects in front (characters, presenter, product, main animal). */
  foregrounds?: PlacedSubject[];
  /** Cut-outs between the subjects and the background (props, a branch, a secondary animal). */
  midground?: PlacedSubject[];
  /**
   * Ambient loop clips, screen-blended subtly over the background. TOP = only
   * the upper band of the frame (sky: clouds, far birds, smoke) - used when
   * there is no separate foreground, so nothing is drawn over a face.
   */
  ambient?: AmbientInput[];
  /** The background's far ground line (share of height); absent = the frame shape's default. */
  horizonY?: number;
  /** G10: very light depth of field behind the subjects (Gaussian sigma at 1080 px wide). */
  backgroundSoftness?: number;
}

export interface AmbientInput {
  path: string;
  opacity?: number;
  /** Screen-blended loops (no alpha): TOP = sky band only, FULL = whole frame. */
  region?: "FULL" | "TOP";
  /** A transparent loop (G3): overlaid in its band instead of screen-blended. */
  alpha?: boolean;
  /** Where a transparent loop is placed. */
  band?: AmbientBand;
}

/** A far (HORIZON) loop is drawn at this share of the frame width (tiled twice) ... */
const HORIZON_SCALE = 0.6;
/** ... and this much fainter than the preset's level. */
const HORIZON_FADE = 0.75;

/** The far ground line (share of height) where distant cars / passers-by stand. */
export const HORIZON_LINE: Record<"PORTRAIT" | "SQUARE" | "LANDSCAPE", number> = { PORTRAIT: 0.6, SQUARE: 0.62, LANDSCAPE: 0.66 };

/** Foreground subjects, the legacy single `foreground` included. */
export function foregroundsOf(layers: LayerInputs): PlacedSubject[] {
  if (layers.foregrounds?.length) return layers.foregrounds.slice(0, 3);
  return layers.foreground ? [{ path: layers.foreground, slot: "FULL" }] : [];
}

/** Every file a layered scene reads (segment cache inputs). */
export function layerFiles(layers: LayerInputs): string[] {
  return [layers.background, ...(layers.midground ?? []).map((m) => m.path), ...foregroundsOf(layers).map((f) => f.path), ...(layers.ambient ?? []).map((a) => a.path)];
}

/** Below this size (of a person's box) a cut-out is a "small subject": a product, a bird. */
const SMALL_SUBJECT = 0.7;

/** Draw order inside one depth group: the sides first, the centre in front. */
const SLOT_ORDER: Record<SubjectSlot, number> = { LEFT: 0, RIGHT: 1, CENTER: 2, FULL: 3 };

/**
 * G10 grounding constants.
 *  - EYE_LINE: share of a standing person's height above the eyes. At eye level
 *    the horizon passes through the eyes, so people sized from the horizon sit
 *    IN the picture instead of towering over it (never below MIN_PERSON of the box).
 *  - Contact shadow: the subject's own silhouette squashed flat, black, soft and
 *    faint, under its standing point. Never under a flying subject.
 *  - Edge: alpha only, eroded by at most EDGE_ERODE levels and softened a hair -
 *    takes a light halo off without eating hair, fingers or a logo.
 */
const EYE_LINE = 0.12;
const MIN_PERSON = 0.75;
const SHADOW: Record<SubjectKind, { opacity: number; width: number }> = {
  PERSON: { opacity: 0.32, width: 0.75 },
  PRODUCT: { opacity: 0.38, width: 1.05 },
  ANIMAL: { opacity: 0.3, width: 0.85 },
  OBJECT: { opacity: 0.3, width: 0.95 },
};
const SHADOW_HEIGHT = 0.12;
const EDGE_ERODE = 80;
const EDGE_SOFT = 0.5;

/** Where a subject's bottom edge stands (share of height), from its kind, the horizon and the subtitles. */
export function standingLine(subject: PlacedSubject, opts: { box: number; horizon?: number; subtitleTop: number; size: number }): number {
  const small = (subject.scale ?? 1) < SMALL_SUBJECT;
  // A small subject (a bird, a product) never stands under the words, even when told to.
  if (subject.floorY !== undefined) return small ? Math.min(subject.floorY, opts.subtitleTop) : subject.floorY;
  if (subject.airborne) {
    // In the air: above the far ground line (or the upper middle), never under the words.
    const h = opts.horizon ?? 0.55;
    return Math.max(TOP_SAFE + opts.size, Math.min(h - 0.12, opts.subtitleTop));
  }
  if (small && opts.horizon !== undefined && opts.horizon < opts.subtitleTop) {
    // A small grounded subject (a bird on the grass): on the near ground, between
    // the far ground line and the subtitles - not on the horizon, not under the words.
    return opts.horizon + 0.6 * (opts.subtitleTop - opts.horizon);
  }
  // A small subject stands above the subtitle block, never under the words.
  return small ? Math.min(opts.box, opts.subtitleTop) : opts.box;
}

/** Person size from the horizon (eye level), as a factor of the box (MIN_PERSON..1). */
export function personScale(floor: number, horizon: number, boxShare: number): number {
  const tall = (floor - horizon) / (1 - EYE_LINE);
  return Math.min(1, Math.max(MIN_PERSON, tall / boxShare));
}

/**
 * One depth group (midground or foreground) as a transparent full-frame
 * PLATE: each cut-out scaled into its box and stood on its standing line,
 * with a faint contact shadow when it touches the ground. The plate then
 * takes the camera move scaled by its parallax, so near things move more than
 * far ones - real depth on a push-in, not just a slide.
 */
function plateChain(opts: {
  inputs: { idx: number; subject: PlacedSubject }[];
  target: RenderTarget;
  label: string;
  /** Floor line / size scale for the group (midground stands a little higher and smaller). */
  floor?: number;
  size?: number;
  /** The background's far ground line, when known. */
  horizon?: number;
}): { chains: string[]; out: string } {
  const { width: W, height: H } = opts.target;
  const L = opts.label;
  const items = [...opts.inputs].sort((a, b) => SLOT_ORDER[a.subject.slot ?? "CENTER"] - SLOT_ORDER[b.subject.slot ?? "CENTER"]);
  // Person-sized subjects set the height; a product / bird beside them is extra.
  const fullSize = items.filter((i) => (i.subject.scale ?? 1) >= SMALL_SUBJECT).length || 1;
  const boxes = subjectBoxes(items.length, opts.target, items.map((i) => i.subject.slot), fullSize);
  const subtitleTop = subtitleTopLine(opts.target);
  const size = opts.size ?? 1;
  const chains: string[] = [];
  // A transparent full-frame canvas (made from the first input - no extra
  // source): subjects and shadows are overlaid on it and may hang past its edges.
  chains.push(`[${items[0]!.idx}:v]format=rgba,split=2[${L}i0][${L}cv]`);
  chains.push(`[${L}cv]scale=${W}:${H},colorchannelmixer=aa=0[${L}p]`);
  let plate = `${L}p`;
  items.forEach((item, k) => {
    const b = boxes[k]!;
    const subject = item.subject;
    const kind = subject.kind ?? "OBJECT";
    const boxShare = b.maxH / H;
    let s = size * (subject.scale ?? 1);
    let floor =
      opts.floor !== undefined && subject.floorY === undefined
        ? opts.floor
        : standingLine(subject, { box: b.bottom / H, horizon: opts.horizon, subtitleTop, size: boxShare * s });
    if (kind === "PERSON" && subject.scale === undefined && !subject.airborne && opts.horizon !== undefined && opts.horizon < floor) {
      s *= personScale(floor, opts.horizon, boxShare * size);
    }
    floor = Math.min(1, floor);
    const bw = Math.max(2, Math.round((b.maxW * s) / 2) * 2);
    const bh = Math.max(2, Math.round((b.maxH * s) / 2) * 2);
    const bottom = Math.round(H * floor);
    const cx = Math.round(b.cx);
    const sub = `${L}s${k}`;
    // Fit (aspect kept), then the light edge clean-up on the alpha plane only.
    const fit =
      `${k === 0 ? `[${L}i0]` : `[${item.idx}:v]format=rgba,`}scale=${bw}:${bh}:force_original_aspect_ratio=decrease:flags=lanczos,format=gbrap,` +
      `erosion=threshold0=0:threshold1=0:threshold2=0:threshold3=${EDGE_ERODE},gblur=sigma=${EDGE_SOFT}:planes=8,format=rgba`;
    if (subject.airborne) {
      chains.push(`${fit}[${sub}]`);
    } else {
      // Contact shadow: the silhouette squashed flat under the standing point.
      const sh = SHADOW[kind];
      const sigma = Math.max(2, Math.round(bw * 0.2) / 10);
      const pad = Math.ceil(sigma * 3);
      chains.push(`${fit},split=2[${sub}][${L}k${k}]`);
      chains.push(
        `[${L}k${k}]scale=w='trunc(iw*${sh.width}/2)*2':h='max(4,trunc(iw*${SHADOW_HEIGHT}/2)*2)',` +
          `colorchannelmixer=rr=0:rg=0:rb=0:gr=0:gg=0:gb=0:br=0:bg=0:bb=0:aa=${sh.opacity},` +
          `pad=w='iw+${pad * 2}':h='ih+${pad * 2}':x=${pad}:y=${pad}:color=black@0,format=gbrap,gblur=sigma=${sigma}:planes=8,format=rgba[${L}h${k}]`,
      );
      chains.push(`[${plate}][${L}h${k}]overlay=x='${cx}-w/2':y='${bottom}-h*0.85':format=rgb[${L}q${k}]`);
      plate = `${L}q${k}`;
    }
    chains.push(`[${plate}][${sub}]overlay=x='${cx}-w/2':y='${bottom}-h':format=rgb[${L}p${k}]`);
    plate = `${L}p${k}`;
  });
  return { chains, out: plate };
}

/**
 * G10: a scene that shows ONLY products stands them on the counter / table
 * line. When that line is high in the frame the product would have to be tiny
 * (or poke out of the top): the background is framed closer instead - scaled
 * up from its top so the counter lands just above the subtitles. Standing
 * lines given in the picture's coordinates move with it.
 */
export function productFraming(layers: LayerInputs, target: Pick<RenderTarget, "width" | "height">): number {
  const fgs = foregroundsOf(layers);
  if (!fgs.length || !fgs.every((f) => f.kind === "PRODUCT") || layers.horizonY === undefined) return 1;
  const k = (subtitleTopLine(target) - 0.04) / layers.horizonY;
  return k > 1.02 ? Math.min(1.6, Math.round(k * 100) / 100) : 1;
}

/**
 * One scene from separate layers, in ONE FFmpeg graph:
 *   background (camera x parallax 0.2 when something stands in front)
 *   → ambient loops (subtle) → midground plate (x 0.5) → foreground plate (x 1.0)
 *   → fps / format.
 * Every plate moves on the same smooth camera curve (same easing, same
 * frames), only scaled - so depth never introduces judder. Audio is mapped
 * exactly as in the single-picture chain.
 */
export function buildLayeredSceneArgs(opts: {
  layers: LayerInputs;
  audioInput: string | null;
  duration: number;
  target: RenderTarget;
  camera: LocalCameraSpec;
  output: string;
}): string[] {
  const { target, camera } = opts;
  const { width, height, fps } = target;
  // G10: a products-only scene frames its background closer (see productFraming).
  const zoom = productFraming(opts.layers, target);
  const layers: LayerInputs =
    zoom === 1
      ? opts.layers
      : {
          ...opts.layers,
          horizonY: opts.layers.horizonY! * zoom,
          foregrounds: foregroundsOf(opts.layers).map((f) => (f.floorY !== undefined ? { ...f, floorY: Math.min(1, f.floorY * zoom) } : f)),
        };
  const dur = Math.max(0.5, Number(opts.duration.toFixed(3)));
  const fgs = foregroundsOf(layers);
  const mids = (layers.midground ?? []).slice(0, 3);
  const inFront = fgs.length + mids.length > 0;
  // Every still goes in as ONE frame (zoompan makes the scene's frames from it).
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", layers.background];
  let idx = 1;
  const midIdx = mids.map((m) => {
    args.push("-i", m.path);
    return { idx: idx++, subject: m };
  });
  const fgIdx = fgs.map((f) => {
    args.push("-i", f.path);
    return { idx: idx++, subject: f };
  });
  const ambIdx: number[] = [];
  for (const a of layers.ambient ?? []) {
    // FFmpeg's built-in VP9 decoder drops the alpha plane; libvpx keeps it.
    const vp9Alpha = a.alpha && /\.webm$/i.test(a.path) ? ["-c:v", "libvpx-vp9"] : [];
    args.push("-stream_loop", "-1", "-t", String(dur), ...vp9Alpha, "-i", a.path);
    ambIdx.push(idx++);
  }
  const audioIdx = idx;
  if (opts.audioInput) args.push("-i", opts.audioInput);
  else args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");

  const chains: string[] = [];
  // Background: far away, so it moves least.
  chains.push(
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}` +
      (zoom > 1 ? `,scale=${Math.round((width * zoom) / 2) * 2}:${Math.round((height * zoom) / 2) * 2}:flags=lanczos,crop=${width}:${height}:(iw-${width})/2:0` : "") +
      (inFront && layers.backgroundSoftness ? `,gblur=sigma=${((layers.backgroundSoftness * width) / 1080).toFixed(2)}` : "") +
      `${cameraZoompan({ ...camera, critical: false }, { durationSec: dur, target, amplitudeScale: inFront ? PARALLAX_FACTOR.BACKGROUND : 1 })},fps=${fps},` +
      `tpad=stop_mode=clone:stop_duration=${dur},format=yuv420p[bg0]`,
  );
  let last = "bg0";
  (layers.ambient ?? []).forEach((a, i) => {
    if (a.alpha) {
      // Transparent loop: drawn over the background in its band, behind any
      // midground / foreground plate (those come later in the graph).
      const op = Math.min(1, Math.max(0.1, a.opacity ?? 0.9));
      const band = a.band ?? "FULL";
      const shape = frameShape(target);
      const fit =
        band === "FULL"
          ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
          : `scale=${width}:-2`;
      const y =
        band === "SKY"
          ? `${Math.round(height * 0.06)}`
          : band === "HORIZON"
            ? `${Math.round(height * (layers.horizonY ?? HORIZON_LINE[shape]))}-h`
            : band === "GROUND"
              ? `${Math.round(height * 0.92)}-h`
              : "0";
      if (band === "HORIZON") {
        // Far away: smaller (tiled twice across the width so the road stays
        // busy), a little soft and fainter - distant movement, not cut-out
        // shapes the size of the people in front.
        const far = Math.round((width * HORIZON_SCALE) / 2) * 2;
        chains.push(`[${ambIdx[i]}:v]format=rgba,scale=${far}:-2,fps=${fps},split=2[ha${i}][hb${i}]`);
        chains.push(
          `[ha${i}][hb${i}]hstack=2,crop=${width}:ih:0:0,gblur=sigma=${(width / 900).toFixed(2)}:planes=15,colorchannelmixer=aa=${(op * HORIZON_FADE).toFixed(2)}[amb${i}]`,
        );
      } else {
        chains.push(`[${ambIdx[i]}:v]format=rgba,${fit},fps=${fps},colorchannelmixer=aa=${op.toFixed(2)}[amb${i}]`);
      }
      chains.push(`[${last}][amb${i}]overlay=x=0:y='${y}':format=auto[mix${i}]`);
      last = `mix${i}`;
      return;
    }
    const op = Math.min(0.6, Math.max(0.1, a.opacity ?? 0.35));
    if (a.region === "TOP") {
      const band = Math.round(height * 0.3);
      // Screen-blended into the sky band only: black in the loop leaves the
      // picture untouched (a plain alpha overlay used to darken the whole band).
      // Blends run in RGB: in YUV, video black is Y=16 (still lightens) and
      // screening the 128 chroma planes shifts every colour.
      chains.push(`[${ambIdx[i]}:v]scale=${width}:${band}:force_original_aspect_ratio=increase,crop=${width}:${band},fps=${fps},format=gbrp[amb${i}]`);
      chains.push(`[${last}]split=2[base${i}][cut${i}]`);
      chains.push(`[cut${i}]crop=${width}:${band}:0:0,format=gbrp[top${i}]`);
      chains.push(`[top${i}][amb${i}]blend=all_mode=screen:all_opacity=${op.toFixed(2)},format=yuv420p[lit${i}]`);
      chains.push(`[base${i}][lit${i}]overlay=0:0[mix${i}]`);
    } else {
      chains.push(`[${ambIdx[i]}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},format=gbrp[amb${i}]`);
      chains.push(`[${last}]format=gbrp[rgb${i}]`);
      chains.push(`[rgb${i}][amb${i}]blend=all_mode=screen:all_opacity=${op.toFixed(2)},format=yuv420p[mix${i}]`);
    }
    last = `mix${i}`;
  });
  const group = (inputs: { idx: number; subject: PlacedSubject }[], label: string, factor: number, place: { floor?: number; size?: number; horizon?: number }) => {
    if (inputs.length === 0) return;
    const plate = plateChain({ inputs, target, label, ...place });
    chains.push(...plate.chains);
    const critical = camera.critical || inputs.some((i) => i.subject.critical);
    const move = cameraZoompan({ ...camera, critical }, { durationSec: dur, target, amplitudeScale: factor, alpha: true });
    chains.push(`[${plate.out}]${move ? move.slice(1) + "," : ""}format=rgba[${label}m]`);
    chains.push(`[${last}][${label}m]overlay=0:0:format=auto[${label}c]`);
    last = `${label}c`;
  };
  group(midIdx, "mid", PARALLAX_FACTOR.MIDGROUND, { floor: 0.9, size: 0.6, horizon: layers.horizonY });
  group(fgIdx, "fg", PARALLAX_FACTOR.FOREGROUND, { horizon: layers.horizonY });
  chains.push(`[${last}]fps=${fps},tpad=stop_mode=clone:stop_duration=10,setsar=1,format=yuv420p[v]`);
  chains.push(`[${audioIdx}:a]aresample=48000,apad[a]`);

  args.push(
    "-filter_complex",
    chains.join(";"),
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-t",
    String(dur),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    opts.output,
  );
  return args;
}
