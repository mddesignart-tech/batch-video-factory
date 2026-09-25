/**
 * Which picked file belongs to which scene - decided from file NAMES, shown to
 * the person, and never applied until they confirm.
 *
 * Pure: the page runs it the moment files are chosen, to draw the preview, and
 * the server runs it again on confirm, so the two can never disagree.
 *
 * Recognised names (case-insensitive, any of .png .jpg .jpeg .webp):
 *
 *   scene-01.png  scene_1.png  scene 001.png  Scene01.png
 *   s01.png  shot-3.png  frame_07.png  cảnh-2.png  canh2.png
 *   01.png  1.png  001.jpg  03-dentist.png  (a leading number)
 *
 * A name with no number, or with two different numbers and no scene-like
 * prefix, is UNMAPPED - it is shown as such rather than guessed. Two files
 * claiming one scene is a CONFLICT and neither is used. "Không map mù."
 */

export interface MappedFile {
  fileName: string;
  /** Null when the name says nothing usable about a scene. */
  sceneNumber: number | null;
  status: "MAPPED" | "UNMAPPED" | "NO_SUCH_SCENE" | "CONFLICT" | "NOT_AN_IMAGE";
  reason: string;
}

export interface MappingPlan {
  files: MappedFile[];
  /** Scene number -> file name, only for files that are safe to apply. */
  bySceneNumber: Map<number, string>;
  /** Scenes of the project that no file maps to. */
  scenesWithoutFile: number[];
  /** True when every file maps cleanly AND every scene got exactly one file. */
  complete: boolean;
}

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const PREFIXED_RE = /(?:^|[^a-z])(?:scene|sc|shot|frame|canh|cảnh|s)[\s_\-.]*0*(\d{1,4})(?!\d)/i;
const LEADING_RE = /^0*(\d{1,4})(?!\d)/;

/** The scene number a file NAME states, or null. Folders are ignored. */
export function sceneNumberFromFileName(fileName: string): number | null {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const stem = base.replace(/\.[^.]+$/, "").trim();
  const prefixed = stem.match(PREFIXED_RE);
  if (prefixed) return Number(prefixed[1]);
  const leading = stem.match(LEADING_RE);
  if (leading) return Number(leading[1]);
  return null;
}

export function planSceneImageMapping(
  fileNames: string[],
  sceneNumbers: number[],
): MappingPlan {
  const scenes = new Set(sceneNumbers);
  const files: MappedFile[] = fileNames.map((fileName) => {
    if (!IMAGE_RE.test(fileName)) {
      return {
        fileName,
        sceneNumber: null,
        status: "NOT_AN_IMAGE",
        reason: "Không phải .png / .jpg / .jpeg / .webp.",
      };
    }
    const n = sceneNumberFromFileName(fileName);
    if (n === null) {
      return {
        fileName,
        sceneNumber: null,
        status: "UNMAPPED",
        reason: "Tên file không nêu số cảnh. Đổi tên (vd. scene-01.png) hoặc chọn ảnh cho cảnh thủ công.",
      };
    }
    if (!scenes.has(n)) {
      return {
        fileName,
        sceneNumber: n,
        status: "NO_SUCH_SCENE",
        reason: `Dự án không có cảnh ${n}.`,
      };
    }
    return { fileName, sceneNumber: n, status: "MAPPED", reason: `→ Cảnh ${n}` };
  });

  // Two files for one scene: refuse both. Picking one would be a guess.
  const claims = new Map<number, number>();
  for (const f of files) {
    if (f.status === "MAPPED") claims.set(f.sceneNumber!, (claims.get(f.sceneNumber!) ?? 0) + 1);
  }
  for (const f of files) {
    if (f.status === "MAPPED" && (claims.get(f.sceneNumber!) ?? 0) > 1) {
      f.status = "CONFLICT";
      f.reason = `Có nhiều file cùng trỏ vào cảnh ${f.sceneNumber}. Không dùng file nào cho cảnh này.`;
    }
  }

  // Stable order whatever order the files were picked in: by scene, then the
  // rest by name. Sorted BEFORE the map is built, so the map is ordered too.
  files.sort((a, b) => {
    const an = a.sceneNumber ?? Number.MAX_SAFE_INTEGER;
    const bn = b.sceneNumber ?? Number.MAX_SAFE_INTEGER;
    return an - bn || a.fileName.localeCompare(b.fileName);
  });

  const bySceneNumber = new Map<number, string>();
  for (const f of files) if (f.status === "MAPPED") bySceneNumber.set(f.sceneNumber!, f.fileName);
  const scenesWithoutFile = [...scenes].filter((n) => !bySceneNumber.has(n)).sort((a, b) => a - b);

  return {
    files,
    bySceneNumber,
    scenesWithoutFile,
    complete: files.every((f) => f.status === "MAPPED") && scenesWithoutFile.length === 0,
  };
}
