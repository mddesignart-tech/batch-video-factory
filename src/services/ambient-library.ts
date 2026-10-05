import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DATA_ROOT } from "@/lib/paths";
import { AMBIENT_KINDS, type AmbientBand } from "@/domain/scene-layers";
import { resolveFfmpeg } from "@/media/ffmpeg";

/**
 * AMBIENT LIBRARY (QĐ-128, G3): short loop clips for background life - traffic,
 * passers-by, birds, clouds, leaves, steam... - kept at data/ambient/<kind>.<ext>.
 * Local files, $0, no provider. A kind without a file is still planned, but
 * only DESCRIBED in the image / video prompt.
 *
 * Two kinds of loop, told apart by the FILE, not by the name:
 *  - TRANSPARENT (.webm VP9 with alpha, .mov qtrle / png / ProRes 4444): drawn
 *    OVER the background - cars, people, birds, leaves. Preferred.
 *  - Light on black (.mp4, no alpha): SCREEN-blended (black = no change) -
 *    clouds, smoke, steam, glints, lights.
 *
 * `npm run ambient:generate` writes procedural loops of both kinds; a real
 * stock loop with the same name replaces one (a transparent file wins).
 */

export const AMBIENT_DIR = path.join(DATA_ROOT, "ambient");
/** Transparent formats first: when both exist, the one that can be drawn over wins. */
const EXTENSIONS = [".webm", ".mov", ".mp4"];

export interface AmbientLoop {
  path: string;
  /** Has an alpha channel: overlaid. Without: screen-blended. */
  alpha: boolean;
  /** Where the compositor places it. */
  band: AmbientBand;
}

const alphaCache = new Map<string, boolean>();

/**
 * Does this video carry transparency? Read from FFmpeg's stream description
 * (cached per file + modification time). VP9 keeps alpha in a side stream
 * flagged `alpha_mode: 1`; other codecs show an alpha pixel format.
 */
export function videoHasAlpha(file: string): boolean {
  let key = file;
  try {
    key = `${file}:${fs.statSync(file).mtimeMs}`;
  } catch {
    return false;
  }
  const hit = alphaCache.get(key);
  if (hit !== undefined) return hit;
  const bin = resolveFfmpeg();
  let alpha = false;
  if (bin) {
    const r = spawnSync(bin, ["-hide_banner", "-i", file], { encoding: "utf8", windowsHide: true });
    const info = `${r.stderr ?? ""}`;
    alpha = /alpha_mode\s*:\s*1/i.test(info) || /Video:.*\b(rgba|argb|bgra|abgr|yuva\w*|gbrap\w*|ya8|ya16\w*|rgb32|bgr32|rgba64\w*)\b/.test(info);
  }
  alphaCache.set(key, alpha);
  return alpha;
}

/** The loop for an ambient kind (transparent preferred), or null. */
export function ambientLoopFor(kind: string): AmbientLoop | null {
  const band = AMBIENT_KINDS.find((k) => k.id === kind)?.band ?? "FULL";
  for (const ext of EXTENSIONS) {
    const file = path.join(AMBIENT_DIR, `${kind}${ext}`);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return { path: file, alpha: videoHasAlpha(file), band };
  }
  return null;
}

/** Absolute path of the loop for an ambient kind, or null. */
export function ambientFileFor(kind: string): string | null {
  return ambientLoopFor(kind)?.path ?? null;
}

/** Ambient kinds that have a local loop right now. */
export function availableAmbientKinds(): string[] {
  return AMBIENT_KINDS.map((k) => k.id).filter((id) => ambientFileFor(id) !== null);
}
