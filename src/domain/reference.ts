/**
 * UNIVERSAL REFERENCE ASSET (QĐ-124) - pure rules. No database, no provider.
 *
 * One vocabulary for everything that must look the same from scene to scene:
 * a character, a product, a prop, a toy, an animal, a logo, a visual style.
 * Every content type uses it; no template has a system of its own.
 */


export const REFERENCE_TYPES = ["CHARACTER", "PRODUCT", "OBJECT", "TOY", "ANIMAL", "LOGO", "STYLE"] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];

export const REFERENCE_PRIORITIES = ["CRITICAL", "IMPORTANT", "OPTIONAL"] as const;
export type ReferencePriority = (typeof REFERENCE_PRIORITIES)[number];

/** Vietnamese labels: no "reference asset" vocabulary for a person. */
export const VI_REFERENCE_TYPE: Record<ReferenceType, string> = {
  CHARACTER: "Nhân vật",
  PRODUCT: "Sản phẩm",
  OBJECT: "Đồ vật",
  TOY: "Đồ chơi",
  ANIMAL: "Động vật",
  LOGO: "Logo",
  STYLE: "Phong cách",
};

export const VI_REFERENCE_PRIORITY: Record<ReferencePriority, string> = {
  CRITICAL: "Bắt buộc giữ đúng",
  IMPORTANT: "Quan trọng",
  OPTIONAL: "Tuỳ chọn",
};

export function isReferenceType(v: unknown): v is ReferenceType {
  return typeof v === "string" && (REFERENCE_TYPES as readonly string[]).includes(v);
}

/** Default priority by type and content (product review: product is CRITICAL). */
export function defaultPriority(type: ReferenceType, contentType?: string | null): ReferencePriority {
  if (type === "PRODUCT") return "CRITICAL";
  if (type === "LOGO" || type === "STYLE") return "OPTIONAL";
  if ((type === "TOY" && contentType === "TOY_WORLD") || (type === "ANIMAL" && contentType === "ANIMAL_FACT")) return "CRITICAL";
  return "IMPORTANT";
}

/**
 * Logo and style pictures are never handed to a generative model: a model
 * redraws a logo wrong, and a style picture is guidance, not a subject. They
 * shape the prompt instead (and the logo stays a real file).
 */
export function sentAsImage(type: ReferenceType): boolean {
  return type !== "LOGO" && type !== "STYLE";
}

/** Who keeps a slot when a model takes fewer pictures than the scene has. */
export function typeRank(type: ReferenceType, isPrimary: boolean): number {
  if (isPrimary && (type === "PRODUCT" || type === "CHARACTER")) return 0;
  if (type === "PRODUCT") return 1;
  if (type === "CHARACTER") return 2;
  if (type === "OBJECT" || type === "TOY" || type === "ANIMAL") return 3;
  return 4; // LOGO / STYLE
}

const PRIORITY_RANK: Record<ReferencePriority, number> = { CRITICAL: 0, IMPORTANT: 1, OPTIONAL: 2 };

export interface SendCandidate {
  key: string;
  name: string;
  type: ReferenceType;
  priority: ReferencePriority;
  isPrimary: boolean;
  /** Absolute path of the picture to send; null = description only. */
  imagePath: string | null;
  /** Position in the original list (characters keep their own order). */
  order: number;
}

export interface SendPlan {
  sent: SendCandidate[];
  /** Had a picture, did not fit the model's limit - described in words instead. */
  droppedByLimit: SendCandidate[];
  /** A CRITICAL picture that did not fit: the scene must not run on this model. */
  criticalDropped: SendCandidate[];
  limit: number;
}

/**
 * Pick the pictures a model receives: CRITICAL first, then by type rank
 * (primary product/character → character → object/toy/animal → logo/style),
 * then the original order. Nothing is dropped silently: what does not fit is
 * returned, and a CRITICAL one that does not fit is called out.
 */
export function planReferenceSend(candidates: SendCandidate[], limit: number): SendPlan {
  const withImage = candidates.filter((c) => c.imagePath !== null && sentAsImage(c.type));
  const ordered = [...withImage].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      typeRank(a.type, a.isPrimary) - typeRank(b.type, b.isPrimary) ||
      a.order - b.order,
  );
  const cap = Math.max(0, limit);
  const sent = ordered.slice(0, cap);
  const droppedByLimit = ordered.slice(cap);
  return { sent, droppedByLimit, criticalDropped: droppedByLimit.filter((c) => c.priority === "CRITICAL"), limit: cap };
}

/** Friendly message for a model that cannot take every picture a scene needs. */
export function limitMessage(limit: number): string {
  return limit === 0
    ? "Model ảnh này không hỗ trợ ảnh tham chiếu trực tiếp. Tool sẽ dùng mô tả nhất quán thay thế."
    : `Model này chỉ hỗ trợ ${limit} ảnh tham chiếu.`;
}

// ---------------------------------------------------------- auto assignment ---

/** "Máy xay" → "may xay": accents, đ and case never decide a match. */
function removeDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

export function normalizeName(text: string): string {
  return removeDiacritics(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export interface AssignableReference {
  id: string;
  name: string;
  type: ReferenceType;
  enabled: boolean;
  useThroughout: boolean;
  aliases: string[];
}

/**
 * Deterministic assignment from the script: a reference is in a scene when the
 * scene's words name it (whole words, accents ignored), or when it is used
 * throughout the video. STYLE applies to every scene by nature. Same input,
 * same answer - and the result is shown, and editable, on the storyboard.
 */
export function autoAssign(sceneText: string, refs: AssignableReference[]): string[] {
  const text = ` ${normalizeName(sceneText)} `;
  return refs
    .filter((r) => r.enabled)
    .filter((r) => {
      if (r.useThroughout || r.type === "STYLE") return true;
      return [r.name, ...r.aliases]
        .map(normalizeName)
        .filter((n) => n.length >= 2)
        .some((n) => text.includes(` ${n} `));
    })
    .map((r) => r.id);
}
