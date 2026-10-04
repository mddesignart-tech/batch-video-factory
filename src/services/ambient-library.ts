import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "@/lib/paths";
import { AMBIENT_KINDS } from "@/domain/scene-layers";

/**
 * AMBIENT LIBRARY (QĐ-128): short loop clips for background life - traffic,
 * passers-by, birds, clouds, leaves, steam... - kept at data/ambient/<kind>.mp4
 * (or .webm / .mov). Local files, $0, no provider. A kind without a file is
 * still planned, but only DESCRIBED in the image / video prompt.
 */

export const AMBIENT_DIR = path.join(DATA_ROOT, "ambient");
const EXTENSIONS = [".mp4", ".webm", ".mov"];

/** Absolute path of the loop for an ambient kind, or null. */
export function ambientFileFor(kind: string): string | null {
  for (const ext of EXTENSIONS) {
    const file = path.join(AMBIENT_DIR, `${kind}${ext}`);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  }
  return null;
}

/** Ambient kinds that have a local loop right now. */
export function availableAmbientKinds(): string[] {
  return AMBIENT_KINDS.map((k) => k.id).filter((id) => ambientFileFor(id) !== null);
}
