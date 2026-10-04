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
 * (voice-aware), eased in and out, with a short hold at the end - never a zoom
 * that finishes in one second and then stands still for four.
 */

import { localFallbackMove, localSupport, type CameraMove, type CameraSpeed } from "@/domain/camera-grammar";
import type { RenderTarget } from "./render";

export interface LocalCameraSpec {
  move: CameraMove;
  speed: CameraSpeed;
  /** A CRITICAL product / animal / character is in frame: gentler, never cropped hard. */
  critical?: boolean;
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

/**
 * The `zoompan` part of the chain for one still: `,scale=...,zoompan=...`.
 * Empty string for STATIC (the picture simply holds). The picture is
 * upscaled first so slow moves do not stair-step.
 */
export function cameraZoompan(spec: LocalCameraSpec, opts: { durationSec: number; target: RenderTarget; amplitudeScale?: number }): string {
  const move = renderableMove(spec.move);
  if (move === "STATIC") return "";
  const { width, height, fps } = opts.target;
  const frames = Math.max(1, Math.round(opts.durationSec * fps));
  const scale = opts.amplitudeScale ?? 1;
  const cap = spec.critical ? 0.08 : 1;
  const A = Math.min(AMPLITUDE[spec.speed] * scale, cap, MAX_LOCAL_ZOOM - 1);
  const O = Math.min(OVERSCAN[spec.speed] * scale, spec.critical ? 0.06 : 1);
  // Progress 0..1 over ~92 % of the scene (intro ease → action → short hold), smoothstep-eased.
  const hold = Math.max(1, Math.round(frames * 0.92) - 1);
  const P = `min(1,on/${hold})`;
  const E = `(${P}*${P}*(3-2*${P}))`;
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
  return `,scale=${width * 2}:${height * 2},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${width}x${height}:fps=${fps}`;
}

// --------------------------------------------------------------- layered ---

export interface LayerInputs {
  /** Background still (or the scene's own picture when there is no separate background). */
  background: string;
  /** Transparent PNG of the subject(s), drawn over the background. */
  foreground?: string | null;
  /** Ambient loop clips, screen-blended subtly over the background. */
  ambient?: { path: string; opacity?: number }[];
}

/**
 * One scene from separate layers, in ONE FFmpeg graph:
 *   background (+ camera, parallax 0.2-0.4) → ambient loops (subtle) →
 *   foreground PNG (moves with the camera at full parallax) → fps / format.
 * Audio is mapped exactly as in the single-picture chain.
 */
export function buildLayeredSceneArgs(opts: {
  layers: LayerInputs;
  audioInput: string | null;
  duration: number;
  target: RenderTarget;
  camera: LocalCameraSpec;
  output: string;
}): string[] {
  const { layers, target, camera } = opts;
  const { width, height, fps } = target;
  const dur = Math.max(0.5, Number(opts.duration.toFixed(3)));
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-t", String(dur), "-i", layers.background];
  let idx = 1;
  const fgIdx = layers.foreground ? idx++ : -1;
  if (layers.foreground) args.push("-loop", "1", "-t", String(dur), "-i", layers.foreground);
  const ambIdx: number[] = [];
  for (const a of layers.ambient ?? []) {
    args.push("-stream_loop", "-1", "-t", String(dur), "-i", a.path);
    ambIdx.push(idx++);
  }
  const audioIdx = idx;
  if (opts.audioInput) args.push("-i", opts.audioInput);
  else args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");

  const chains: string[] = [];
  // Background: far away, so it moves less (parallax).
  chains.push(
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}` +
      `${cameraZoompan({ ...camera, critical: false }, { durationSec: dur, target, amplitudeScale: layers.foreground ? 0.4 : 1 })},fps=${fps},format=yuv420p[bg0]`,
  );
  let last = "bg0";
  (layers.ambient ?? []).forEach((a, i) => {
    const op = Math.min(0.6, Math.max(0.1, a.opacity ?? 0.35));
    chains.push(`[${ambIdx[i]}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},format=yuv420p[amb${i}]`);
    chains.push(`[${last}][amb${i}]blend=all_mode=screen:all_opacity=${op.toFixed(2)}[mix${i}]`);
    last = `mix${i}`;
  });
  if (layers.foreground) {
    // The subject: full parallax. A lateral camera move slides it a little more than the background.
    const lateral = /LEFT|RIGHT|PARALLAX|TRUCK|TRACK/.test(renderableMove(camera.move));
    const dir = /LEFT/.test(camera.move) ? 1 : -1;
    const shift = lateral && !camera.critical ? `${dir}*W*0.03*(t/${dur.toFixed(3)}-0.5)` : "0";
    chains.push(`[${fgIdx}:v]scale=-2:${Math.round(height * 0.82)},format=rgba[fg]`);
    chains.push(`[${last}][fg]overlay=x='(W-w)/2+${shift}':y='H-h-H*0.04':format=auto[comp]`);
    last = "comp";
  }
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
