import type { RenderTarget } from "./render";
import { platformSafeArea } from "@/domain/output-controls";

/**
 * WHERE each cut-out subject stands in the frame (G2). Pure.
 *
 * Slots are LEFT / CENTER / RIGHT (2-3 separate subjects) or FULL (one cut-out
 * that already holds the whole group, as drawn). Boxes depend on the frame:
 * a 9:16 frame stacks people taller and narrower than 16:9; 1:1 and 4:5 sit
 * between. Every box keeps the subject inside the frame horizontally, its top
 * below the top safe margin, and stands it on the floor line - feet may sit
 * low, faces never fall into the subtitle band (bottom ~22 %).
 */

export const SUBJECT_SLOTS = ["LEFT", "CENTER", "RIGHT", "FULL"] as const;
export type SubjectSlot = (typeof SUBJECT_SLOTS)[number];

export interface SubjectBox {
  /** Centre x of the subject, output pixels. */
  cx: number;
  /** The floor line: the subject's bottom edge, output pixels. */
  bottom: number;
  /** The subject is scaled to fit inside maxW x maxH (aspect kept). */
  maxW: number;
  maxH: number;
}

type Shape = "PORTRAIT" | "SQUARE" | "LANDSCAPE";

export function frameShape(t: Pick<RenderTarget, "width" | "height">): Shape {
  const r = t.width / t.height;
  if (r < 0.9) return "PORTRAIT"; // 9:16, 4:5 (0.8)
  if (r <= 1.1) return "SQUARE";
  return "LANDSCAPE";
}

/** Height share of the tallest subject, by frame shape and how many stand side by side. */
const HEIGHT: Record<Shape, [number, number, number]> = {
  PORTRAIT: [0.7, 0.62, 0.56],
  SQUARE: [0.78, 0.72, 0.66],
  LANDSCAPE: [0.86, 0.82, 0.78],
};

/** Centre x (share of width) for 1, 2, 3 subjects. */
const CENTERS: Record<Shape, [number[], number[], number[]]> = {
  PORTRAIT: [[0.5], [0.3, 0.7], [0.2, 0.5, 0.8]],
  SQUARE: [[0.5], [0.32, 0.68], [0.22, 0.5, 0.78]],
  LANDSCAPE: [[0.5], [0.36, 0.64], [0.27, 0.5, 0.73]],
};

/**
 * The top of the subtitle block (share of height): the platform's bottom safe
 * area plus the ~15 % the subtitle layout may use (QĐ-125/126). A small
 * subject (a bird, a product) stands above it, so the words never cover it.
 */
export function subtitleTopLine(t: Pick<RenderTarget, "width" | "height">): number {
  return Math.round((1 - platformSafeArea(t.width, t.height).bottom - 0.15) * 1000) / 1000;
}

/** Top safe margin (share of height) - heads are never pushed above it. */
export const TOP_SAFE = 0.06;
/** Floor line (share of height). */
const FLOOR = 0.985;

/**
 * One box per subject, in slot order. `slots` lets a conversation keep its
 * screen sides (Leo LEFT, Max RIGHT); absent = spread evenly in order.
 */
export function subjectBoxes(
  count: number,
  target: Pick<RenderTarget, "width" | "height">,
  slots?: (SubjectSlot | undefined)[],
  /** How many of them are person-sized (a product or a bird beside a presenter does not make the presenter shorter). */
  fullSize?: number,
): SubjectBox[] {
  const { width: W, height: H } = target;
  const shape = frameShape(target);
  const n = Math.max(1, Math.min(3, count));
  const tall = HEIGHT[shape][Math.max(1, Math.min(3, fullSize ?? n)) - 1]!;
  if (n === 1 && (slots?.[0] === "FULL" || !slots?.[0] || slots[0] === "CENTER")) {
    // One subject (or a whole group cut out together): centred, as large as the frame allows.
    const full = slots?.[0] === "FULL";
    return [{ cx: W / 2, bottom: H * FLOOR, maxW: W * (full ? 0.96 : 0.8), maxH: H * Math.min(1 - TOP_SAFE - (1 - FLOOR), HEIGHT[shape][0] + (full ? 0.06 : 0)) }];
  }
  const centers = CENTERS[shape][n - 1]!;
  const byName: Record<"LEFT" | "CENTER" | "RIGHT", number> = n === 2 ? { LEFT: centers[0]!, CENTER: 0.5, RIGHT: centers[1]! } : { LEFT: centers[0]!, CENTER: centers[1] ?? 0.5, RIGHT: centers[2] ?? centers[1]! };
  const slotW = (W / n) * 1.1; // a little overlap between neighbours reads as a group
  return Array.from({ length: n }, (_, i) => {
    const slot = slots?.[i];
    const share = slot && slot !== "FULL" ? byName[slot] : centers[i]!;
    const maxW = Math.min(slotW, 2 * Math.min(share, 1 - share) * W); // never past the frame edge
    return { cx: W * share, bottom: H * FLOOR, maxW, maxH: H * tall };
  });
}

/** Slots for a conversation: who the director put on the left stays left. */
export function slotsForNames(names: string[], screenLeft?: string[], screenRight?: string[]): SubjectSlot[] {
  if (names.length <= 1) return names.map(() => "CENTER");
  const lower = (s: string) => s.toLowerCase();
  const left = new Set((screenLeft ?? []).map(lower));
  const right = new Set((screenRight ?? []).map(lower));
  const order: SubjectSlot[] = names.length === 2 ? ["LEFT", "RIGHT"] : ["LEFT", "CENTER", "RIGHT"];
  // The director's sides first (each slot once), then the rest in natural order.
  const out: (SubjectSlot | null)[] = names.map(() => null);
  const taken = new Set<SubjectSlot>();
  names.forEach((n, i) => {
    const side: SubjectSlot | null = left.has(lower(n)) ? "LEFT" : right.has(lower(n)) ? "RIGHT" : null;
    if (side && !taken.has(side)) {
      out[i] = side;
      taken.add(side);
    }
  });
  const free = order.filter((s) => !taken.has(s));
  return out.map((s) => s ?? free.shift() ?? "CENTER");
}
