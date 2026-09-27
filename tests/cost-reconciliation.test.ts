import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "@prisma/client";
import { estimateProject, type EstimateInput, type PlannedSceneInput } from "@/services/cost-estimator";
import { reconcileCosts, type ImportVideoPreview } from "@/services/import-preflight";
import { defaultSettings } from "@/lib/settings";

/**
 * V1.2 Phase 5 - QA cost separation and cost reconciliation (QĐ-113). Pure: no
 * DB, no provider. Paid AI quality scoring is OFF by default and then never
 * part of what a run needs.
 */

function model(over: Partial<ModelRegistry> & { modelId: string; type: string }) {
  return {
    id: over.modelId, provider: "mock", displayName: over.modelId, enabled: true, priceUnit: "per_second", price: 0.1,
    supportsTextToVideo: true, supportsImageToVideo: true, supportsReferenceImage: true, supportsCharacterReference: true,
    supportsAudio: false, supports1080p: true, supportsUpscale: false, maxDuration: 10, qualityRating: 5, speedRating: 5,
    consistencyRating: 5, historicalSuccessRate: 1, notes: "", createdAt: new Date(), updatedAt: new Date(), ...over,
  } as ModelRegistry;
}

const MODELS = [
  model({ modelId: "img", type: "image", priceUnit: "per_image", price: 0.04 }),
  model({ modelId: "vid", type: "video", price: 0.05 }),
  model({ modelId: "voice", type: "voice", priceUnit: "per_1k_chars", price: 0.02 }),
  model({ modelId: "qa", type: "quality", priceUnit: "per_job", price: 0.002 }),
];

const SCENES: PlannedSceneInput[] = [
  { sceneNumber: 1, duration: 3, complexity: "HIGH", spendPriority: "HIGH", characterCount: 1, speechText: "Break a leg!" },
  { sceneNumber: 2, duration: 3, complexity: "MEDIUM", spendPriority: "HIGH", characterCount: 1, speechText: "What?" },
];

const base: EstimateInput = {
  scenes: SCENES, models: MODELS, qualityMode: "BALANCED", strategy: "AUTO", maxBudget: 100,
  availableProviders: ["mock"], needs1080p: false, hasScript: true,
};

describe("QĐ-113 — tách chi phí QA", () => {
  it("mặc định AI_PAID_QA = OFF", () => {
    expect(defaultSettings().aiPaidQa).toBe(false);
  });

  it("QA tắt: chấm chất lượng là TUỲ CHỌN — hiện giá, không cộng vào bắt buộc/tổng", () => {
    const e = estimateProject(base);
    expect(e.breakdown.quality).toBe(0);
    expect(e.breakdown.optionalQa).toBeCloseTo(0.004, 6); // 2 HIGH scenes x $0.002
    expect(e.breakdown.required).toBeCloseTo(e.breakdown.text + e.breakdown.image + e.breakdown.video + e.breakdown.voice + e.breakdown.upscale, 6);
    expect(e.breakdown.total).toBeCloseTo(e.breakdown.required + e.breakdown.retries, 4);
  });

  it("QA bật: chấm chất lượng thành chi phí sẽ chạy, cộng vào tổng", () => {
    const off = estimateProject(base);
    const on = estimateProject({ ...base, paidQa: true });
    expect(on.breakdown.quality).toBeCloseTo(0.004, 6);
    expect(on.breakdown.required).toBeCloseTo(off.breakdown.required, 6);
    expect(on.breakdown.total).toBeCloseTo(on.breakdown.required + on.breakdown.quality + on.breakdown.retries, 4);
    expect(on.breakdown.total).toBeGreaterThan(off.breakdown.total);
  });
});

describe("QĐ-113 — đối soát chi phí", () => {
  const video = (e: ReturnType<typeof estimateProject>, over: Partial<ImportVideoPreview> = {}) =>
    ({
      breakdown: {
        text: e.breakdown.text, image: e.breakdown.image, video: e.breakdown.video, voice: e.breakdown.voice,
        quality: e.breakdown.quality, retries: e.breakdown.retries, required: e.breakdown.required,
        optionalQa: e.breakdown.optionalQa, render: 0,
      },
      estimatedCost: e.breakdown.total,
      localMotionCount: e.localMotionScenes,
      scenes: [],
      ...over,
    }) as unknown as ImportVideoPreview;

  it("recommended = required + QA đã bật + retry reserve, và khớp dự toán", () => {
    const off = estimateProject(base);
    const on = estimateProject({ ...base, paidQa: true });
    const r1 = reconcileCosts([video(off), video(off)], false);
    expect(r1.requiredTotal).toBeCloseTo(2 * off.breakdown.required, 6);
    expect(r1.enabledQa).toBe(0);
    expect(r1.optionalQa).toBeCloseTo(0.008, 6);
    expect(r1.recommendedAuthorization).toBeCloseTo(r1.requiredTotal + r1.retryReserve, 6);
    expect(r1.reconciles).toBe(true);
    const r2 = reconcileCosts([video(on)], true);
    expect(r2.enabledQa).toBeCloseTo(0.004, 6);
    expect(r2.recommendedAuthorization).toBeCloseTo(r2.requiredTotal + r2.enabledQa + r2.retryReserve, 6);
    expect(r2.reconciles).toBe(true);
  });

  it("giá trị dùng lại / nhập KHÔNG cộng vào tổng; tách riêng ảnh nhập", () => {
    const e = estimateProject(base);
    const scenes = [
      { reuseFrom: { image: "IMPORTED", video: null, voice: null }, saved: { image: 0.04, video: 0, voice: 0 } },
      { reuseFrom: { image: "CACHE", video: "CACHE", voice: null }, saved: { image: 0.04, video: 0.15, voice: 0 } },
    ];
    const r = reconcileCosts([video(e, { scenes } as unknown as Partial<ImportVideoPreview>)], false);
    expect(r.importedValue).toBeCloseTo(0.04, 6);
    expect(r.reusedValue).toBeCloseTo(0.19, 6);
    expect(r.requiredTotal).toBeCloseTo(e.breakdown.required, 6);
    expect(r.reconciles).toBe(true);
  });

  it("một dự toán không khớp bị gắn cờ", () => {
    const e = estimateProject(base);
    const r = reconcileCosts([video(e, { estimatedCost: e.breakdown.total + 1 })], false);
    expect(r.reconciles).toBe(false);
  });
});
