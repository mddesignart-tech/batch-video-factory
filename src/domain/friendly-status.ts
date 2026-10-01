import type { VideoLifecycle } from "./video-lifecycle";

/**
 * The nine words a person reads for one video (V1.2 Phase 6, QĐ-114).
 *
 * Derived, never stored, from the lifecycle the engine already computes plus
 * two facts it does not carry: an interrupted run, and a voice file that is
 * present but broken. Internal enums stay available in the Advanced view; the
 * daily screens show only these.
 */
export const FRIENDLY_STATUSES = [
  "NHÁP",
  "CẦN KIỂM TRA",
  "SẴN SÀNG",
  "ĐANG CHỜ",
  "ĐANG TẠO",
  "ĐANG RENDER",
  "HOÀN THÀNH",
  "CẦN XỬ LÝ",
  "BỊ CHẶN",
] as const;
export type FriendlyStatus = (typeof FRIENDLY_STATUSES)[number];

export const FRIENDLY_TONE: Record<FriendlyStatus, "neutral" | "info" | "ok" | "warn" | "danger" | "brand"> = {
  "NHÁP": "neutral",
  "CẦN KIỂM TRA": "neutral",
  "SẴN SÀNG": "info",
  "ĐANG CHỜ": "brand",
  "ĐANG TẠO": "warn",
  "ĐANG RENDER": "warn",
  "HOÀN THÀNH": "ok",
  "CẦN XỬ LÝ": "danger",
  "BỊ CHẶN": "warn",
};

export function friendlyStatus(input: {
  lifecycle: VideoLifecycle;
  /** The run stopped because the app restarted / the process died (INTERRUPTED). */
  interrupted?: boolean;
  /** A voice line the video depends on is a broken file (INVALID). */
  invalidVoice?: boolean;
}): FriendlyStatus {
  const { lifecycle } = input;
  if (lifecycle === "RUNNING") return "ĐANG TẠO";
  if (lifecycle === "RENDERING") return "ĐANG RENDER";
  // A broken voice file needs a person even on a finished video: its MP4 may
  // stand, but it cannot be rendered again without a new (paid) voice.
  if (input.invalidVoice) return "CẦN XỬ LÝ";
  if (lifecycle === "COMPLETED") return "HOÀN THÀNH";
  if (input.interrupted) return "CẦN XỬ LÝ";
  switch (lifecycle) {
    case "DRAFT":
      return "NHÁP";
    case "PREFLIGHT":
      return "CẦN KIỂM TRA";
    case "READY":
      return "SẴN SÀNG";
    case "APPROVED":
      return "ĐANG CHỜ";
    case "BLOCKED":
      return "BỊ CHẶN";
    case "FAILED":
    case "NEEDS_RECOVERY":
      return "CẦN XỬ LÝ";
  }
  return "NHÁP";
}

/** Batch status as a person reads it. */
export const FRIENDLY_BATCH_STATUS: Record<string, string> = {
  PLANNED: "Chưa duyệt",
  QUEUED: "Đang chờ",
  RUNNING: "Đang chạy",
  COMPLETED: "Hoàn thành",
  COMPLETED_WITH_ERRORS: "Hoàn thành (có video lỗi)",
  FAILED: "Thất bại",
  NEEDS_REVIEW: "Cần xem lại",
  BUDGET_EXHAUSTED: "Hết hạn mức đã duyệt",
  CANCELLED: "Đã dừng",
};

/** The pipeline stages the daily workspace shows, in order. */
export const WORKFLOW_STEPS = ["IMPORT", "REVIEW", "PREFLIGHT", "APPROVE", "QUEUE", "GENERATE", "RENDER", "EXPORT"] as const;
export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

export const VI_WORKFLOW_STEP: Record<WorkflowStep, string> = {
  IMPORT: "Nhập",
  REVIEW: "Xem lại",
  PREFLIGHT: "Kiểm tra & dự toán",
  APPROVE: "Duyệt",
  QUEUE: "Hàng đợi",
  GENERATE: "Tạo media",
  RENDER: "Render",
  EXPORT: "Xuất file",
};

/**
 * Where a batch is in the workflow, from its own facts. REVIEW is reached as
 * soon as rows exist; PREFLIGHT once it has been priced; APPROVE while money is
 * approved but nothing has started; then the furthest stage any video reached.
 */
export function batchWorkflowStep(input: {
  videos: number;
  priced: boolean;
  approved: boolean;
  running: number;
  rendering: number;
  completed: number;
  exported: number;
}): WorkflowStep {
  if (input.videos === 0) return "IMPORT";
  if (input.exported > 0 && input.exported >= input.completed && input.completed > 0 && input.running === 0 && input.rendering === 0) {
    return "EXPORT";
  }
  if (input.rendering > 0) return "RENDER";
  if (input.running > 0) return "GENERATE";
  if (input.completed > 0) return "EXPORT";
  if (input.approved) return "QUEUE";
  if (input.priced) return "PREFLIGHT";
  return "REVIEW";
}
