import type { QualityMode } from "@/domain/enums";

/**
 * What each quality mode is willing to spend on one image.
 *
 * V1 behaviour, decided deliberately: **every mode draws exactly one image.**
 * No mode quietly pays for a second one. QUALITY differs by using a better
 * model and by offering the operator a button to draw an alternative - a
 * choice they make, and see the price of, rather than one made for them.
 *
 * Drawing several candidates and having an AI pick the winner is a later step.
 * Until that exists, nothing here may estimate or bill for more than one image,
 * because an estimate that forecasts two while the code draws one makes the
 * remaining budget read smaller than it really is.
 */

export interface ImageQualityPolicy {
  /** Images drawn per scene automatically. One, in every mode, in V1. */
  candidates: number;
  /**
   * Extra attempts allowed after a *clear* failure - a refusal, a blank image.
   * Not a retry for "I don't like it"; that is the operator's regenerate button
   * and it is their decision to pay again.
   */
  maxAutoRegenerate: number;
  /**
   * Whether the UI offers "draw an alternative", which keeps the current image
   * as a candidate beside the new one for the operator to choose between.
   */
  allowsManualAlternative: boolean;
  /** Quality floor the router applies when picking an image model. */
  minQualityRating: number;
  /** Human-readable reason, shown in the UI next to the estimate. */
  rationale: string;
}

export const IMAGE_QUALITY_POLICIES: Record<QualityMode, ImageQualityPolicy> = {
  ECONOMY: {
    candidates: 1,
    maxAutoRegenerate: 0,
    allowsManualAlternative: false,
    minQualityRating: 0,
    rationale:
      "Một ảnh, model tiết kiệm, không tự vẽ lại. Ưu tiên chi phí thấp nhất.",
  },
  BALANCED: {
    candidates: 1,
    maxAutoRegenerate: 1,
    allowsManualAlternative: false,
    minQualityRating: 7,
    rationale:
      "Một ảnh từ model tốt, giá hợp lý. Chỉ tự vẽ lại tối đa một lần khi ảnh hỏng rõ ràng.",
  },
  QUALITY: {
    candidates: 1,
    maxAutoRegenerate: 1,
    allowsManualAlternative: true,
    minQualityRating: 9,
    rationale:
      "Một ảnh từ model chất lượng cao. Bạn có thể bấm “Tạo phương án khác” để " +
      "vẽ thêm một ảnh rồi tự chọn — hệ thống không tự ý tạo ảnh thứ hai.",
  },
  CUSTOM: {
    candidates: 1,
    maxAutoRegenerate: 0,
    allowsManualAlternative: true,
    minQualityRating: 0,
    rationale: "Người dùng tự chọn nhà cung cấp và model cho từng cảnh.",
  },
};

export function imagePolicyFor(mode: QualityMode): ImageQualityPolicy {
  return IMAGE_QUALITY_POLICIES[mode];
}

/**
 * Cost of a batch before anything is sent.
 *
 * Counts only the images the system draws on its own. An alternative the
 * operator asks for later is a separate, visible decision and is deliberately
 * not forecast here.
 */
export function estimateImageBatchCost(input: {
  mode: QualityMode;
  imageCount: number;
  pricePerImage: number;
}): { images: number; total: number } {
  const images = input.imageCount * imagePolicyFor(input.mode).candidates;
  return {
    images,
    total: Math.round(images * input.pricePerImage * 1e6) / 1e6,
  };
}
