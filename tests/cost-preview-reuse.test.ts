import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "@prisma/client";
import { planScene, type PlannedSceneInput } from "@/services/cost-estimator";

/**
 * "Cần tạo" versus "dùng lại", in the number an operator approves.
 *
 * A resume hands back assets that were already bought: `generateSceneVideo`
 * checks the settled idempotency key BEFORE routing, precisely so a project with
 * no budget left can still finish work it has paid for. The estimate did not
 * know that, so resuming a finished video quoted its clips a second time.
 *
 * Over-stating is the safe direction for a CEILING and the wrong answer to the
 * question actually being asked, which is "what will this run cost me". It also
 * makes the saving invisible - the whole point of importing a storyboard with
 * its own assets is not paying for them twice, and a preview that cannot show
 * that is a preview nobody can check the pipeline against.
 *
 * The rule these tests pin down is the three-way one: BUY, REUSE and NONE are
 * distinct. A LOCAL_MOTION scene costs $0 of video and reuses nothing. See
 * QĐ-071.
 */

function model(over: Partial<ModelRegistry> & { modelId: string }): ModelRegistry {
  return {
    id: over.modelId,
    provider: "mock",
    displayName: over.modelId,
    type: "video",
    enabled: true,
    priceUnit: "per_second",
    price: 0.1,
    priceOutput: 0,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    supportsCharacterReference: true,
    supportsAudio: false,
    supports1080p: true,
    supportsUpscale: false,
    maxDuration: 12,
    qualityRating: 7,
    speedRating: 7,
    consistencyRating: 7,
    historicalSuccessRate: 1,
    notes: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ModelRegistry;
}

const MODELS = [
  model({ modelId: "v", type: "video", price: 0.08 }),
  model({ modelId: "i", type: "image", priceUnit: "per_image", price: 0.04 }),
  model({ modelId: "s", type: "voice", priceUnit: "per_1k_chars", price: 0.015 }),
];

function scene(over: Partial<PlannedSceneInput> = {}): PlannedSceneInput {
  return {
    sceneNumber: 1,
    duration: 5,
    complexity: "LOW",
    // HIGH priority keeps `decideMotion` on AI_VIDEO, so the video stage is
    // genuinely on the table and REUSE is distinguishable from NONE.
    spendPriority: "HIGH",
    characterCount: 1,
    speechText: "It is very cold up here.",
    ...over,
  };
}

const OPTS = {
  models: MODELS,
  qualityMode: "BALANCED" as const,
  strategy: "AUTO" as const,
  availableProviders: ["mock"],
  budgetRemaining: 100,
  needs1080p: false,
};

describe("dự toán: cần mua, dùng lại, hay không cần", () => {
  it("cảnh mới hoàn toàn -> mua cả ba, không dùng lại gì", () => {
    const plan = planScene({ scene: scene(), ...OPTS });
    expect(plan.needs).toEqual({ image: true, video: true, voice: true });
    expect(plan.reuse).toEqual({ image: false, video: false, voice: false });
    expect(plan.estimatedCost).toBeGreaterThan(0);
  });

  it("clip đã có -> KHÔNG tính tiền video nữa, và đánh dấu dùng lại", () => {
    const fresh = planScene({ scene: scene(), ...OPTS });
    const resumed = planScene({ scene: scene({ hasExistingVideo: true }), ...OPTS });

    expect(resumed.video).toBeNull();
    expect(resumed.needs.video).toBe(false);
    expect(resumed.reuse.video).toBe(true);
    expect(resumed.estimatedCost).toBeLessThan(fresh.estimatedCost);
    // ...and the saving is exactly the clip, not a little of everything else.
    expect(round(fresh.estimatedCost - resumed.estimatedCost)).toBe(
      round(fresh.video!.estimatedCost),
    );
  });

  it("giọng đã có -> không tính tiền voice nữa", () => {
    const resumed = planScene({ scene: scene({ hasExistingVoice: true }), ...OPTS });
    expect(resumed.voice).toBeNull();
    expect(resumed.needs.voice).toBe(false);
    expect(resumed.reuse.voice).toBe(true);
  });

  it("ảnh nhập sẵn -> dùng lại, không phải 'không cần'", () => {
    const supplied = planScene({ scene: scene({ hasSuppliedKeyframe: true }), ...OPTS });
    expect(supplied.image).toBeNull();
    expect(supplied.needs.image).toBe(false);
    expect(supplied.reuse.image).toBe(true);
  });

  // The generated twin of the case above. Missing until the first real
  // two-video batch was re-run: every bought keyframe was quoted again.
  it("ảnh ĐÃ MUA và còn trên đĩa -> dùng lại, $0 tiền ảnh", () => {
    const owned = planScene({ scene: scene({ hasExistingImage: true }), ...OPTS });
    expect(owned.image).toBeNull();
    expect(owned.needs.image).toBe(false);
    expect(owned.reuse.image).toBe(true);
  });

  // The distinction the whole three-way split exists for. A free scene saves
  // nothing, because nothing was ever going to be bought for it.
  it("LOCAL_MOTION: không cần clip, và KHÔNG được tính là dùng lại", () => {
    const free = planScene({
      scene: scene({ spendPriority: "LOW" }),
      ...OPTS,
      qualityMode: "ECONOMY",
    });
    expect(free.motionSource).toBe("LOCAL_MOTION");
    expect(free.needs.video).toBe(false);
    expect(free.reuse.video).toBe(false);
  });

  it("cảnh không có lời thoại: không cần voice, cũng không phải dùng lại", () => {
    const silent = planScene({ scene: scene({ speechText: "  " }), ...OPTS });
    expect(silent.needs.voice).toBe(false);
    expect(silent.reuse.voice).toBe(false);
  });

  // A clip already on disk must not be re-read as "this scene has no provider".
  // The two look identical from outside - both produce `video: null` - and one
  // of them blocks a whole video from running.
  it("clip dùng lại KHÔNG bị báo là thiếu nhà cung cấp", () => {
    const resumed = planScene({ scene: scene({ hasExistingVideo: true }), ...OPTS });
    expect(resumed.needsProvider).toBeUndefined();
    expect(resumed.error).toBeUndefined();
  });

  it("đã có hết -> chạy lại không tốn gì", () => {
    const all = planScene({
      scene: scene({
        hasSuppliedKeyframe: true,
        hasExistingVideo: true,
        hasExistingVoice: true,
      }),
      ...OPTS,
    });
    expect(all.estimatedCost).toBe(0);
    expect(all.reuse).toEqual({ image: true, video: true, voice: true });
  });
});

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
