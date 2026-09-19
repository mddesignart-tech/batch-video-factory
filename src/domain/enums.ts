/**
 * Enum-like unions for the whole app.
 *
 * These are plain string unions rather than Prisma enums because SQLite has no
 * native enum support. Every value that reaches the database is validated here
 * first, so the DB layer stays portable to PostgreSQL without a code change.
 */

export const IDIOM_CATEGORIES = [
  "Animals",
  "Food",
  "Work",
  "School",
  "Money",
  "Relationships",
  "Daily Life",
  "Body",
  "Weather",
  "Travel",
  "American English",
  "British English",
  "Funny Expressions",
] as const;
export type IdiomCategory = (typeof IDIOM_CATEGORIES)[number];

export const DIFFICULTIES = ["Beginner", "Intermediate", "Advanced"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const REGIONS = ["General", "US", "UK", "Australia", "Other"] as const;
export type Region = (typeof REGIONS)[number];

export const IDIOM_STATUSES = [
  "unused",
  "planned",
  "generated",
  "published",
  "archived",
] as const;
export type IdiomStatus = (typeof IDIOM_STATUSES)[number];

export const PROJECT_STATUSES = [
  "draft",
  "script_ready",
  "media_generating",
  "media_ready",
  "rendering",
  "completed",
  "failed",
  /** Stopped for a human decision rather than by an error. */
  "needs_review",
  /** The batch this project belongs to ran out of authorised money. */
  "budget_exhausted",
  "cancelled",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const SCENE_STATUSES = [
  "pending",
  "image_ready",
  "video_ready",
  "audio_ready",
  "completed",
  "failed",
  "skipped",
] as const;
export type SceneStatus = (typeof SCENE_STATUSES)[number];

export const QUALITY_MODES = [
  "ECONOMY",
  "BALANCED",
  "QUALITY",
  "CUSTOM",
] as const;
export type QualityMode = (typeof QUALITY_MODES)[number];

export const ROUTER_STRATEGIES = [
  "AUTO",
  "CHEAPEST",
  "BEST_VALUE",
  "BEST_QUALITY",
  "MANUAL",
] as const;
export type RouterStrategy = (typeof ROUTER_STRATEGIES)[number];

export const COMPLEXITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export const SPEND_PRIORITIES = ["LOW", "NORMAL", "HIGH"] as const;
export type SpendPriority = (typeof SPEND_PRIORITIES)[number];

/**
 * Where a model is in its life, as the operator controls it.
 *
 * Distinct from `enabled`, which only says whether the row is switched on. A
 * model can be enabled, priced, working today, and still be something the
 * router must never reach for by itself - a vendor with a published shutdown
 * date is the clearest case.
 */
export const MODEL_LIFECYCLES = [
  /** The router may choose it automatically. */
  "ACTIVE",
  /** Usable, but only when a person names it by hand. */
  "PIN_ONLY",
  /**
   * Nominated for automatic LOW routing, NOT yet granted it.
   *
   * A record that the evidence has been gathered and reviewed, kept distinct
   * from the switch being thrown. `isAutoRoutable` still says no: a candidate
   * is a proposal awaiting a person, and a state that quietly started routing
   * the moment it was written would make the review it exists for impossible.
   */
  "LOW_AUTO_CANDIDATE",
  /**
   * Granted automatic routing for LOW scenes ONLY.
   *
   * The narrowest grant in this list, and the only one whose answer depends on
   * the scene rather than on the model alone. `ACTIVE` would have been the easy
   * way to express "the router may now pick h3_max", and it would have been
   * wrong: nothing in this registry limits an ACTIVE model by complexity, so
   * the same edit that let it take a one-character locked-camera LOW scene
   * would have let it take a three-character HIGH action beat it has never been
   * measured on. The grant has to carry its own limit or it is not the grant
   * anyone reviewed.
   */
  "LOW_AUTO",
  /** The vendor is retiring it. Never auto-routed. */
  "DEPRECATED",
  /** Off entirely. */
  "DISABLED",
] as const;
export type ModelLifecycle = (typeof MODEL_LIFECYCLES)[number];

/** What `isAutoRoutable` needs to know about the scene, when it needs anything. */
export interface AutoRouteScope {
  /**
   * The scene's complexity, or null when the caller does not have one.
   *
   * Null is not a wildcard. A LOW_AUTO model asked "may you be auto-routed?"
   * with no scene in hand gets NO, because the grant is conditional and an
   * unanswered condition has not been met.
   */
  complexity?: Complexity | string | null;
}

/**
 * May the router pick this model on its own, for THIS scene?
 *
 * The scene half of the signature is new, and it is the point. A function that
 * reads only the lifecycle can answer for ACTIVE and PIN_ONLY, because those
 * are properties of the model. It cannot answer for LOW_AUTO, which is a
 * property of the pairing - and an earlier build that tried anyway had exactly
 * one way to express the grant, `ACTIVE`, which silently granted every scene.
 *
 * Two different absences, deliberately treated differently:
 *
 *   null / undefined / ""   ACTIVE. The column is non-nullable with a default
 *                           of "ACTIVE", so a missing value never comes from
 *                           the database - it comes from an object built in
 *                           memory by a script or a test. Blocking those turned
 *                           one absent optional field into a total routing
 *                           outage: every model in every fixture became
 *                           unroutable at once, and the error said
 *                           "(undefined)".
 *
 *                           It reads as ACTIVE and NEVER as LOW_AUTO. Inferring
 *                           the conditional grant from an absent field would
 *                           hand the narrowest permission in the system to
 *                           every object that forgot to set one.
 *
 *   an unrecognised string  BLOCKED. A value that is really there and is not
 *                           one we know is a state this build cannot reason
 *                           about, and guessing it is safe to spend on would be
 *                           the wrong way to be wrong.
 *
 * This is a NECESSARY condition, never a sufficient one. `lowAutoRouteBlock` in
 * domain/low-auto holds the rest of the gate - keyframe, cast size, camera,
 * budgets - and the router must pass both.
 */
export function isAutoRoutable(
  lifecycle: string | null | undefined,
  scope: AutoRouteScope = {},
): boolean {
  if (lifecycle === null || lifecycle === undefined || lifecycle === "") {
    return true;
  }
  if (lifecycle === "ACTIVE") return true;
  if (lifecycle === "LOW_AUTO") return scope.complexity === "LOW";
  return false;
}

export const VI_MODEL_LIFECYCLE: Record<ModelLifecycle, string> = {
  ACTIVE: "Đang dùng",
  PIN_ONLY: "Chỉ chọn tay",
  LOW_AUTO_CANDIDATE: "Ứng viên LOW — chờ duyệt, chưa tự định tuyến",
  LOW_AUTO: "Tự định tuyến CHỈ cho cảnh LOW",
  DEPRECATED: "Sắp ngừng — không tự định tuyến",
  DISABLED: "Đã tắt",
};

export const MODEL_TYPES = [
  "text",
  "image",
  "video",
  "voice",
  "upscale",
  "quality",
] as const;
export type ModelType = (typeof MODEL_TYPES)[number];

export const PRICE_UNITS = [
  "per_second",
  "per_image",
  "per_1k_chars",
  "per_1k_tokens",
  "per_job",
] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export const PROVIDER_STATUSES = [
  "connected",
  "missing_key",
  "unavailable",
  "rate_limited",
  "disabled",
] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

/**
 * Batch lifecycle, as the operator sees it.
 *
 * Wider than a project's because a batch can end for reasons a single project
 * cannot: it can run out of the money it was authorised for while every video
 * in it is still perfectly healthy.
 */
export const BATCH_STATUSES = [
  /** Planned and costed, but nobody has approved spending yet. */
  "PLANNED",
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  /** Stopped for a decision - over per-video budget, or needs a provider. */
  "NEEDS_REVIEW",
  /** The authorised ceiling is reached. Not a failure; a limit working. */
  "BUDGET_EXHAUSTED",
  "CANCELLED",
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/**
 * Statuses a batch never leaves on its own.
 *
 * The progress page polls while a batch can still change and stops when it
 * cannot. Without this list the page would keep asking every 2.5 seconds, for
 * ever, about a run that finished hours ago.
 *
 * NEEDS_REVIEW is deliberately NOT here: a person can retry a video from that
 * state, so the numbers can still move.
 */
export const TERMINAL_BATCH_STATUSES: readonly BatchStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "BUDGET_EXHAUSTED",
];

export function isTerminalBatchStatus(status: BatchStatus): boolean {
  return TERMINAL_BATCH_STATUSES.includes(status);
}

/** State of the one approval that lets a batch spend. */
export const BATCH_AUTH_STATUSES = [
  "DRAFT",
  "APPROVED",
  "EXHAUSTED",
  "CANCELLED",
  "COMPLETED",
] as const;
export type BatchAuthStatus = (typeof BATCH_AUTH_STATUSES)[number];

/** Life of one held-then-settled amount of money. */
export const RESERVATION_STATUSES = ["RESERVED", "COMMITTED", "RELEASED"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * Where a scene's movement comes from.
 *
 * Not every scene needs a generative video model. A reaction shot or an
 * explanation card is served just as well by a keyframe with a slow push-in,
 * which FFmpeg does locally for nothing and cannot fail at a vendor. Treating
 * that as a first-class routing outcome rather than a fallback is what makes a
 * six-scene video affordable.
 */
export const MOTION_SOURCES = ["AI_VIDEO", "LOCAL_MOTION"] as const;
export type MotionSource = (typeof MOTION_SOURCES)[number];

/** Why one video inside a batch cannot be started as planned. */
export const VIDEO_PLAN_STATUSES = [
  "OK",
  /** Estimate exceeds the per-video ceiling. Never auto-started. */
  "OVER_VIDEO_BUDGET",
  /** A scene wants AI video but no approved model can serve it. */
  "NEEDS_PROVIDER",
  /**
   * A character in this video cannot be drawn consistently at any price.
   *
   * No reference image AND no written description: the image step refuses it
   * outright, so the video is not runnable and its estimate must not be counted
   * among the work being approved. The one plan status money cannot fix. QĐ-076.
   */
  "NEEDS_CHARACTER_REFERENCE",
  /**
   * A model this video would pay has not had its price confirmed by a person.
   *
   * The second money lock, and the one batch `a690a290` died on mid-run: the
   * approval says how much may be spent, confirmation says a human has looked
   * at THIS model's price and agreed. Nothing checked it at plan time, so the
   * plan read OK until the first request was refused. See QĐ-078.
   */
  "NEEDS_PROVIDER_CONFIRMATION",
] as const;
export type VideoPlanStatus = (typeof VIDEO_PLAN_STATUSES)[number];

export const JOB_STATUSES = [
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TYPES = [
  "generate_script",
  /** Full image -> video -> voice -> quality chain for one scene. */
  "generate_scene_media",
  "generate_scene_image",
  "generate_scene_video",
  "generate_scene_voice",
  "evaluate_scene_quality",
  "render_final",
  "batch_expand",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const ASSET_KINDS = [
  "image",
  "video",
  "audio",
  "subtitle",
  "final",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const COST_CATEGORIES = [
  "text",
  "image",
  "video",
  "voice",
  "upscale",
  "quality",
  "retry",
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

/** Vietnamese labels for the admin UI. The generated videos stay in English. */
export const VI_QUALITY_MODE: Record<QualityMode, string> = {
  ECONOMY: "Tiết kiệm",
  BALANCED: "Cân bằng",
  QUALITY: "Chất lượng cao",
  CUSTOM: "Tự chọn",
};

export const VI_PROJECT_STATUS: Record<ProjectStatus, string> = {
  draft: "Bản nháp",
  script_ready: "Đã có kịch bản",
  media_generating: "Đang tạo media",
  media_ready: "Media sẵn sàng",
  rendering: "Đang render",
  completed: "Hoàn thành",
  failed: "Thất bại",
  needs_review: "Chờ duyệt",
  budget_exhausted: "Hết ngân sách",
  cancelled: "Đã huỷ",
};

export const VI_BATCH_STATUS: Record<BatchStatus, string> = {
  PLANNED: "Đã dự toán, chờ duyệt",
  QUEUED: "Đã duyệt, chờ chạy",
  RUNNING: "Đang chạy",
  COMPLETED: "Hoàn thành",
  FAILED: "Thất bại",
  NEEDS_REVIEW: "Cần xem lại",
  BUDGET_EXHAUSTED: "Hết ngân sách đã duyệt",
  CANCELLED: "Đã dừng",
};

export const VI_BATCH_AUTH_STATUS: Record<BatchAuthStatus, string> = {
  DRAFT: "Chưa duyệt",
  APPROVED: "Đã duyệt chi",
  EXHAUSTED: "Đã dùng hết hạn mức",
  CANCELLED: "Đã thu hồi",
  COMPLETED: "Đã đóng",
};

export const VI_MOTION_SOURCE: Record<MotionSource, string> = {
  AI_VIDEO: "Video AI",
  LOCAL_MOTION: "FFmpeg tại máy ($0)",
};

export const VI_VIDEO_PLAN_STATUS: Record<VideoPlanStatus, string> = {
  OK: "Sẵn sàng",
  OVER_VIDEO_BUDGET: "Vượt hạn mức/video",
  NEEDS_PROVIDER: "Thiếu provider được duyệt",
  NEEDS_CHARACTER_REFERENCE: "Thiếu nhận dạng nhân vật",
  NEEDS_PROVIDER_CONFIRMATION: "Chưa xác nhận giá model",
};

export const VI_JOB_STATUS: Record<JobStatus, string> = {
  queued: "Chờ xử lý",
  processing: "Đang xử lý",
  completed: "Hoàn thành",
  failed: "Thất bại",
  cancelled: "Đã huỷ",
};

export const VI_PROVIDER_STATUS: Record<ProviderStatus, string> = {
  connected: "Đã kết nối",
  missing_key: "Thiếu API key",
  unavailable: "Không khả dụng",
  rate_limited: "Bị giới hạn tần suất",
  disabled: "Đã tắt",
};

export const VI_COMPLEXITY: Record<Complexity, string> = {
  LOW: "Đơn giản",
  MEDIUM: "Trung bình",
  HIGH: "Phức tạp",
};

export const VI_ROUTER_STRATEGY: Record<RouterStrategy, string> = {
  AUTO: "Tự động",
  CHEAPEST: "Rẻ nhất",
  BEST_VALUE: "Giá trị tốt nhất",
  BEST_QUALITY: "Chất lượng tốt nhất",
  MANUAL: "Thủ công",
};
