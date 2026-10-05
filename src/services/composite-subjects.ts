import fs from "node:fs";
import type { Scene } from "@prisma/client";
import { toAbsolute, toRelative } from "@/lib/paths";
import { cutoutImage } from "@/media/cutout";
import type { UniversalReference } from "./reference-assets";

/**
 * The SUBJECTS of a locally composited scene (G1/G2): who / what stands in the
 * foreground, each as a transparent PNG. Free, local:
 *
 *  1. a reference picture that is already transparent;
 *  2. the scene's own picture, cut out of its plain backdrop - it keeps the
 *     exact poses and grouping the scene was drawn with (2-3 people together);
 *  3. each character / product / animal reference, cut out separately.
 *
 * A picture that cannot be cut cleanly is skipped with its reason; nothing is
 * ever cut "roughly".
 */

export const SUBJECT_REFERENCE_TYPES = new Set(["PRODUCT", "CHARACTER", "ANIMAL", "TOY", "OBJECT"]);

export type SubjectEntity = "CHARACTER" | "PRODUCT" | "ANIMAL" | "OBJECT";

export interface ResolvedSubject {
  name: string;
  entityType: SubjectEntity;
  critical: boolean;
  /** Data-relative path of the transparent PNG. */
  path: string;
  from: "TRANSPARENT_REFERENCE" | "CUTOUT_SCENE" | "CUTOUT_REFERENCE";
  referenceId?: string;
}

export interface SubjectResolution {
  subjects: ResolvedSubject[];
  /** Why a candidate was not used (Vietnamese). */
  skipped: string[];
}

/** PNG with an alpha channel (colour type 4 or 6). */
export function pngHasAlpha(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(26);
    fs.readSync(fd, head, 0, 26, 0);
    fs.closeSync(fd);
    return head.toString("latin1", 1, 4) === "PNG" && (head[25] === 6 || head[25] === 4);
  } catch {
    return false;
  }
}

const entityOf = (type: string): SubjectEntity =>
  type === "CHARACTER" ? "CHARACTER" : type === "PRODUCT" ? "PRODUCT" : type === "ANIMAL" ? "ANIMAL" : "OBJECT";

function firstImage(r: UniversalReference): string | null {
  const img = r.images.find((i) => i.primary && i.exists) ?? r.images.find((i) => i.exists);
  return img ? toAbsolute(img.path) : null;
}

/**
 * Cheap check (no cutting): is there anything that COULD become a subject?
 * Used by the editor for every scene, so it only looks at files.
 */
export function subjectCandidates(scene: Pick<Scene, "imagePath">, refs: UniversalReference[]): { scenePicture: boolean; references: string[] } {
  const picture = scene.imagePath ? toAbsolute(scene.imagePath) : null;
  return {
    scenePicture: Boolean(picture && fs.existsSync(picture)),
    references: refs.filter((r) => SUBJECT_REFERENCE_TYPES.has(r.type) && firstImage(r)).map((r) => r.name),
  };
}

/**
 * Resolve the subjects, cutting where needed (cached by picture content).
 * The scene's own picture wins when it cuts cleanly: one layer that keeps the
 * whole cast's poses. Otherwise each reference becomes its own layer (max 3).
 */
export async function resolveSubjects(scene: Pick<Scene, "imagePath">, refs: UniversalReference[], opts: { preferScenePicture?: boolean } = {}): Promise<SubjectResolution> {
  const skipped: string[] = [];
  const subjectRefs = refs.filter((r) => SUBJECT_REFERENCE_TYPES.has(r.type));
  const critical = subjectRefs.some((r) => r.priority === "CRITICAL");

  // 1. Already-transparent reference pictures.
  const transparent: ResolvedSubject[] = [];
  for (const r of subjectRefs) {
    const img = r.images.filter((i) => i.exists).map((i) => toAbsolute(i.path)).find(pngHasAlpha);
    if (img) transparent.push({ name: r.name, entityType: entityOf(r.type), critical: r.priority === "CRITICAL", path: toRelative(img), from: "TRANSPARENT_REFERENCE", referenceId: r.id });
  }

  // 2. The scene's own picture (all subjects as drawn together).
  if (opts.preferScenePicture !== false && scene.imagePath) {
    const picture = toAbsolute(scene.imagePath);
    if (fs.existsSync(picture)) {
      const cut = await cutoutImage(picture);
      if (cut.ok) {
        const names = subjectRefs.map((r) => r.name);
        return {
          subjects: [
            {
              name: names.length ? names.join(" + ") : "Chủ thể của cảnh",
              entityType: subjectRefs.length === 1 ? entityOf(subjectRefs[0]!.type) : "CHARACTER",
              critical,
              path: toRelative(cut.path),
              from: "CUTOUT_SCENE",
            },
          ],
          skipped,
        };
      }
      skipped.push(`Ảnh cảnh: ${cut.message}`);
    }
  }

  // 3. Each reference on its own.
  const subjects = [...transparent];
  for (const r of subjectRefs) {
    if (subjects.length >= 3) break;
    if (subjects.some((s) => s.referenceId === r.id)) continue;
    const img = firstImage(r);
    if (!img) continue;
    const cut = await cutoutImage(img);
    if (cut.ok) subjects.push({ name: r.name, entityType: entityOf(r.type), critical: r.priority === "CRITICAL", path: toRelative(cut.path), from: "CUTOUT_REFERENCE", referenceId: r.id });
    else skipped.push(`${r.name}: ${cut.message}`);
  }
  return { subjects: subjects.slice(0, 3), skipped };
}
