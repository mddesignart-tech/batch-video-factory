/**
 * VIDEO MODEL PROFILE - what a video model can do, what it costs and how the
 * router may use it, as DATA (ModelRegistry.capabilityProfileJson).
 *
 * Adding a model or provider later = one registry row + this profile (+ one
 * adapter if the API is new). Storyboard, voice, subtitles, the smooth pass and
 * the final render never change for it.
 *
 * NULL profile = everything is inferred from the existing columns and the size
 * suffix in the model id, exactly as before: no routing changes for any model
 * that has no profile. Pure: no database.
 */

import { z } from "zod";

/** The four routing states a person sees (mapped onto the existing lifecycle). */
export const ROUTING_MODES = ["AUTO_OK", "PIN_ONLY", "DEPRECATED", "DISABLED"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export const VI_ROUTING_MODE: Record<RoutingMode, string> = {
  AUTO_OK: "Tự định tuyến",
  PIN_ONLY: "Chỉ chọn tay",
  DEPRECATED: "Ngừng dùng",
  DISABLED: "Đã tắt",
};

/** Quality axes a benchmark can fill in, 1-10. */
export const QUALITY_AXES = [
  "motionQuality",
  "characterConsistency",
  "productFidelity",
  "cartoon",
  "animals",
  "peopleAction",
  "cameraMotion",
  "promptFollowing",
  "speed",
  "costEfficiency",
] as const;
export type QualityAxis = (typeof QUALITY_AXES)[number];

export const VideoModelProfileSchema = z.object({
  /** "9:16", "16:9", "1:1"... Empty = inferred from the size in the model id. */
  supportedAspectRatios: z.array(z.string().regex(/^\d+:\d+$/)).default([]),
  /** Lengths the vendor accepts, seconds. Empty = maxDuration column. */
  supportedDurations: z.array(z.number().positive()).default([]),
  resolutions: z.array(z.string()).default([]),
  textToVideo: z.boolean().optional(),
  imageToVideo: z.boolean().optional(),
  referenceImage: z.boolean().optional(),
  characterReference: z.boolean().optional(),
  /** QĐ-124: several reference pictures in one request. */
  multipleReferences: z.boolean().optional(),
  /** QĐ-124: keeps a product's shape / label from a reference picture. */
  productReference: z.boolean().optional(),
  /** QĐ-124: how many reference pictures one request may carry. */
  maxReferenceImages: z.number().int().min(0).max(16).optional(),
  /** QĐ-124, video: the adapter can send reference pictures besides the keyframe. */
  directReference: z.boolean().optional(),
  /** QĐ-128 camera control. Absent = not promised (the router never assumes it). */
  cameraControl: z.boolean().optional(),
  /** Camera Grammar moves the vendor follows reliably (e.g. "ORBIT_LEFT", "DOLLY_IN"). */
  cameraMoves: z.array(z.string()).optional(),
  focusControl: z.boolean().optional(),
  orbit: z.boolean().optional(),
  tracking: z.boolean().optional(),
  complexCameraPrompt: z.boolean().optional(),
  /** Price as the vendor states it (credits), next to the $ price column. */
  credits: z.number().nonnegative().optional(),
  billingUnit: z.string().optional(),
  quality: z.record(z.enum(QUALITY_AXES), z.number().min(1).max(10)).default({}),
  /** Suggested first when a scene NEEDS a person to choose a model. */
  isDefault: z.boolean().default(false),
});
export type VideoModelProfile = z.infer<typeof VideoModelProfileSchema>;

export interface ProfileColumns {
  modelId: string;
  capabilityProfileJson?: string | null;
  supportsTextToVideo: boolean;
  supportsImageToVideo: boolean;
  supportsReferenceImage: boolean;
  supportsCharacterReference: boolean;
  supports1080p: boolean;
  maxDuration: number;
  lifecycle: string;
  enabled: boolean;
}

/** Default when nothing says otherwise: the cap the image client has always used. */
export const DEFAULT_REFERENCE_LIMIT = 3;

/**
 * How many reference pictures this model takes (image or video row). An explicit
 * profile wins; otherwise a model that supports references takes the long
 * standing default, and one that does not takes none. Never assumed equal for
 * every model.
 */
export function referenceLimitFor(model: {
  capabilityProfileJson?: string | null;
  supportsReferenceImage: boolean;
  supportsCharacterReference: boolean;
}): number {
  const stored = storedProfile(model.capabilityProfileJson);
  if (stored?.maxReferenceImages !== undefined) return stored.maxReferenceImages;
  if (stored?.referenceImage === false && stored?.characterReference === false) return 0;
  return model.supportsReferenceImage || model.supportsCharacterReference ? DEFAULT_REFERENCE_LIMIT : 0;
}

/** Video only: may this adapter send references besides the keyframe? */
export function supportsDirectVideoReference(model: { capabilityProfileJson?: string | null }): boolean {
  return storedProfile(model.capabilityProfileJson)?.directReference === true;
}

/** The stored profile, or null when none / unreadable (never throws on a page). */
export function storedProfile(json: string | null | undefined): VideoModelProfile | null {
  if (!json) return null;
  try {
    const parsed = VideoModelProfileSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function aspectOfSize(w: number, h: number): string {
  const g = (a: number, b: number): number => (b === 0 ? a : g(b, a % b));
  const d = g(w, h) || 1;
  return `${w / d}:${h / d}`;
}

/** The effective profile: stored values first, then what the columns already say. */
export function effectiveProfile(model: ProfileColumns): VideoModelProfile & { inferred: boolean } {
  const stored = storedProfile(model.capabilityProfileJson);
  const size = /:(\d+)x(\d+)$/.exec(model.modelId);
  const inferredAspects = size ? [aspectOfSize(Number(size[1]), Number(size[2]))] : [];
  return {
    supportedAspectRatios: stored?.supportedAspectRatios.length ? stored.supportedAspectRatios : inferredAspects,
    supportedDurations: stored?.supportedDurations.length ? stored.supportedDurations : model.maxDuration > 0 ? [model.maxDuration] : [],
    resolutions: stored?.resolutions.length ? stored.resolutions : size ? [`${size[1]}x${size[2]}`] : model.supports1080p ? ["1080p"] : [],
    textToVideo: stored?.textToVideo ?? model.supportsTextToVideo,
    imageToVideo: stored?.imageToVideo ?? model.supportsImageToVideo,
    referenceImage: stored?.referenceImage ?? model.supportsReferenceImage,
    characterReference: stored?.characterReference ?? model.supportsCharacterReference,
    multipleReferences: stored?.multipleReferences,
    productReference: stored?.productReference,
    maxReferenceImages: referenceLimitFor(model),
    directReference: stored?.directReference,
    credits: stored?.credits,
    billingUnit: stored?.billingUnit,
    quality: stored?.quality ?? {},
    isDefault: stored?.isDefault ?? false,
    inferred: stored === null,
  };
}

/**
 * Does the STORED profile rule this frame out? Only an explicit list can: a
 * model with no profile is judged by the size in its id, as before (the
 * router's `videoShapeMismatch`).
 */
export function profileAspectMismatch(model: Pick<ProfileColumns, "capabilityProfileJson">, frameAspect: string | undefined): string | null {
  if (!frameAspect) return null;
  const stored = storedProfile(model.capabilityProfileJson);
  if (!stored || stored.supportedAspectRatios.length === 0) return null;
  if (stored.supportedAspectRatios.includes(frameAspect)) return null;
  return `Model video này chưa hỗ trợ tỷ lệ ${frameAspect} (hỗ trợ: ${stored.supportedAspectRatios.join(", ")}).`;
}

/** Same rule for length: only an explicit list of accepted durations limits it. */
export function profileDurationMismatch(model: Pick<ProfileColumns, "capabilityProfileJson">, seconds: number): string | null {
  const stored = storedProfile(model.capabilityProfileJson);
  if (!stored || stored.supportedDurations.length === 0) return null;
  const longest = Math.max(...stored.supportedDurations);
  return seconds > longest ? `cảnh dài ${seconds}s nhưng model chỉ nhận tối đa ${longest}s` : null;
}

/**
 * Which quality axis matters for a content type. Used only when a benchmark
 * filled it in; a model without that score keeps its ordinary quality index.
 */
export function axisForContent(contentType: string | null | undefined): QualityAxis | null {
  switch (contentType) {
    case "PRODUCT_REVIEW":
    case "ADVERTISEMENT":
      return "productFidelity";
    case "ANIMAL_FACT":
      return "animals";
    case "TOY_WORLD":
    case "STORY":
    case "ENGLISH_IDIOM":
      return "cartoon";
    default:
      return null;
  }
}

export function contentQuality(model: Pick<ProfileColumns, "capabilityProfileJson">, contentType: string | null | undefined): number | null {
  const axis = axisForContent(contentType);
  if (!axis) return null;
  return storedProfile(model.capabilityProfileJson)?.quality[axis] ?? null;
}

/** The lifecycle, as one of the four routing states a person sees. */
export function routingModeOf(lifecycle: string, enabled: boolean): RoutingMode {
  if (!enabled || lifecycle === "DISABLED") return "DISABLED";
  if (lifecycle === "DEPRECATED") return "DEPRECATED";
  if (lifecycle === "ACTIVE" || lifecycle === "LOW_AUTO") return "AUTO_OK";
  return "PIN_ONLY";
}

/**
 * What a routing-mode change writes. AUTO_OK needs BENCHMARK evidence and a
 * real price, and never WIDENS a narrower grant (LOW_AUTO stays LOW_AUTO: the
 * evidence covered LOW scenes only).
 */
export function routingModeChange(
  model: { lifecycle: string; enabled: boolean; verification: string; price: number },
  mode: RoutingMode,
): { ok: true; lifecycle: string; enabled: boolean } | { ok: false; reason: string } {
  switch (mode) {
    case "AUTO_OK":
      if (model.lifecycle === "LOW_AUTO" || model.lifecycle === "ACTIVE") {
        return { ok: true, lifecycle: model.lifecycle, enabled: true };
      }
      if (model.verification !== "BENCHMARK_VERIFIED") {
        return { ok: false, reason: "Chỉ bật Tự định tuyến sau khi model có benchmark đạt (BENCHMARK_VERIFIED)." };
      }
      if (!(model.price > 0)) return { ok: false, reason: "Model chưa có giá - không thể cho tự định tuyến." };
      return { ok: true, lifecycle: "ACTIVE", enabled: true };
    case "PIN_ONLY":
      return { ok: true, lifecycle: "PIN_ONLY", enabled: true };
    case "DEPRECATED":
      return { ok: true, lifecycle: "DEPRECATED", enabled: model.enabled };
    case "DISABLED":
      return { ok: true, lifecycle: "DISABLED", enabled: false };
  }
}
