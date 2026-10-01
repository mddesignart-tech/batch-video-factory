/**
 * The order a batch's videos are run in (V1.2 Phase 6, QĐ-114).
 *
 *   0  FREE        everything exists; at most a render / export ($0, fast)
 *   1  LOCAL       LOCAL_MOTION segments to draw, still $0
 *   2  PAID_LIGHT  buys images and/or voices, no Video AI
 *   3  PAID_VIDEO  buys at least one Video AI clip
 *
 * Cheap and certain first: a video that costs nothing never waits behind a
 * clip that may take minutes and may fail, and money is spent last, after the
 * free work has proven the pipeline is healthy. Ties keep the import order.
 *
 * Dependencies are unaffected: inside a video the executor still walks
 * image -> clip -> voice per scene and renders only after every scene is done.
 * Routing is unaffected: this only orders whole videos.
 */
export const COST_CLASSES = ["FREE", "LOCAL", "PAID_LIGHT", "PAID_VIDEO"] as const;
export type CostClass = (typeof COST_CLASSES)[number];

export const VI_COST_CLASS: Record<CostClass, string> = {
  FREE: "$0 · dùng lại",
  LOCAL: "$0 · xử lý tại máy",
  PAID_LIGHT: "Trả phí · ảnh/giọng",
  PAID_VIDEO: "Trả phí · Video AI",
};

export interface CostClassInput {
  buyImages: number;
  buyVideos: number;
  buyVoices: number;
  localMotion: number;
  /** Incremental cost of the video as priced now. */
  incrementalCost: number;
}

export function costClass(v: CostClassInput): CostClass {
  if (v.buyVideos > 0) return "PAID_VIDEO";
  if (v.buyImages > 0 || v.buyVoices > 0 || v.incrementalCost > 1e-9) return "PAID_LIGHT";
  if (v.localMotion > 0) return "LOCAL";
  return "FREE";
}

/** A video that can run without spending anything. */
export function isZeroCost(v: CostClassInput): boolean {
  const c = costClass(v);
  return c === "FREE" || c === "LOCAL";
}

/** Stable sort by class, then by the original order. */
export function orderForRun<T extends { order: number; cls: CostClass }>(items: readonly T[]): T[] {
  const rank = (c: CostClass) => COST_CLASSES.indexOf(c);
  return [...items].sort((a, b) => rank(a.cls) - rank(b.cls) || a.order - b.order);
}
