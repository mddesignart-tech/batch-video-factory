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
