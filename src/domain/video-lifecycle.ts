/**
 * One video's place in the queue, in the nine words the operator reads.
 *
 * Pure and derived - never stored - from three facts the database already
 * holds: the project's own status, whether the batch's money is approved, and
 * the preflight's verdict on this video. Storing it would give it a chance to
 * disagree with the rows it summarises.
 */
export const VIDEO_LIFECYCLES = [
  "DRAFT",
  "PREFLIGHT",
  "READY",
  "APPROVED",
  "RUNNING",
  "RENDERING",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  /** A paid request may already have been billed without a settled outcome (QĐ-110). */
  "NEEDS_RECOVERY",
] as const;
export type VideoLifecycle = (typeof VIDEO_LIFECYCLES)[number];

export function videoLifecycle(input: {
  projectStatus: string;
  /** DRAFT, APPROVED, COMPLETED, EXHAUSTED, CANCELLED - or null when none yet. */
  authorizationStatus: string | null;
  /** The preflight's status for this video ("OK" or a blocker), null if not priced. */
  planStatus: string | null;
  /** A paid request of this video is unsettled (paid-recovery.ts). */
  needsRecovery?: boolean;
  /** An execution holds this video's lock right now. */
  active?: boolean;
}): VideoLifecycle {
  const { projectStatus, authorizationStatus, planStatus } = input;
  // Live work first: what is running is running, whatever the row said last.
  if (input.active) return projectStatus === "rendering" ? "RENDERING" : "RUNNING";
  // Then money that may be spent without a result: nothing proceeds past it.
  if (input.needsRecovery && projectStatus !== "completed") return "NEEDS_RECOVERY";
  switch (projectStatus) {
    case "completed":
      return "COMPLETED";
    case "rendering":
      return "RENDERING";
    case "media_generating":
    case "media_ready":
      return "RUNNING";
    case "failed":
    case "cancelled":
      return "FAILED";
    case "needs_review":
    case "budget_exhausted":
      return "BLOCKED";
  }
  if (planStatus !== null && planStatus !== "OK") return "BLOCKED";
  if (authorizationStatus === "APPROVED") return "APPROVED";
  if (planStatus === "OK") return "READY";
  if (authorizationStatus === "DRAFT") return "PREFLIGHT";
  return "DRAFT";
}

export const LIFECYCLE_TONE: Record<VideoLifecycle, "neutral" | "info" | "ok" | "warn" | "danger" | "brand"> = {
  DRAFT: "neutral",
  PREFLIGHT: "neutral",
  READY: "info",
  APPROVED: "brand",
  RUNNING: "warn",
  RENDERING: "warn",
  COMPLETED: "ok",
  BLOCKED: "warn",
  FAILED: "danger",
  NEEDS_RECOVERY: "danger",
};
