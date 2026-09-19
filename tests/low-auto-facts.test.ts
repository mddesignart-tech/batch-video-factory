import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "@prisma/client";

import {
  deriveSceneVideoFacts,
  type SceneFactsInput,
} from "@/services/low-auto-facts";
import { routeScene, RoutingError, type RouteContext } from "@/services/ai-router";

/**
 * ONE derivation, shared by the pipeline, the dry-run and the proof script.
 *
 * The regression these tests exist for is not a crash. It is a report that
 * disagrees with the thing it reports on: the dry-run said a scene was
 * ineligible, production said it was eligible, and only one of the two spends
 * money. Both were "correct" against their own hand-written copy of the same
 * derivation, and both passed their own tests.
 */

const LOCKED_PROMPT =
  "A nervous man stands against a plain wall, shoulders tense. " +
  "Locked static camera, no camera movement, no zoom, no pan. " +
  "Keep the character's face and clothing identical to the reference image.";

function scene(over: Partial<SceneFactsInput> = {}): SceneFactsInput {
  return {
    duration: 5,
    camera: "Locked static shot",
    visualDescription: "A man against a plain wall",
    characterAction: "shifts his weight",
    videoPrompt: LOCKED_PROMPT,
    complexity: "LOW",
    spendPriority: "HIGH",
    motionSource: "AI_VIDEO",
    imagePath: "projects/p1/images/keyframe.png",
    videoProvider: null,
    videoModel: null,
    charactersPresentJson: JSON.stringify(["Nam"]),
    speakingCharactersJson: JSON.stringify(["Nam"]),
    primaryCharactersJson: JSON.stringify(["Nam"]),
    ...over,
  };
}

/** The data directory is not present in the suite, so the stat is injected. */
const onDisk = (present: boolean) => () => present;

describe("keyframe: cái ĐANG CÓ trên đĩa, không phải cái cột ghi", () => {
  it("cột có đường dẫn nhưng file đã bị xoá -> KHÔNG có keyframe", () => {
    const d = deriveSceneVideoFacts(scene(), {
      qualityMode: "BALANCED",
      keyframeExists: onDisk(false),
    });
    expect(d.hasKeyframe).toBe(false);
    expect(d.facts.hasKeyframe).toBe(false);
  });

  it("cột có đường dẫn và file có thật -> CÓ keyframe", () => {
    const d = deriveSceneVideoFacts(scene(), {
      qualityMode: "BALANCED",
      keyframeExists: onDisk(true),
    });
    expect(d.hasKeyframe).toBe(true);
  });

  it("cột rỗng thì không đụng tới đĩa", () => {
    let asked = 0;
    const d = deriveSceneVideoFacts(scene({ imagePath: null }), {
      qualityMode: "BALANCED",
      keyframeExists: () => {
        asked += 1;
        return true;
      },
    });
    expect(d.hasKeyframe).toBe(false);
    expect(asked).toBe(0);
  });
});

describe("prompt được dựng MỘT lần, và là prompt sẽ gửi đi", () => {
  it("trả về đúng chuỗi đã qua guardrail, không phải prompt thô", () => {
    const d = deriveSceneVideoFacts(scene(), {
      qualityMode: "BALANCED",
      keyframeExists: onDisk(true),
    });
    expect(d.videoPrompt).toBe(d.guarded.text);
    expect(d.facts.promptGuarded).toBe(true);
  });

  it("mâu thuẫn được tìm trên prompt ĐÃ dựng, không phải bản thô", () => {
    const d = deriveSceneVideoFacts(
      scene({ camera: "slow push in", videoPrompt: "locked static shot, then zoom in fast" }),
      { qualityMode: "BALANCED", keyframeExists: onDisk(true) },
    );
    expect(d.contradictions).toEqual(d.facts.contradictions);
  });
});

describe("motion: cùng một luật với đường chạy thật", () => {
  it("cảnh LOW ưu tiên thấp -> LOCAL_MOTION, và cổng không có gì để mua", () => {
    const d = deriveSceneVideoFacts(scene({ spendPriority: "LOW", motionSource: "LOCAL_MOTION" }), {
      qualityMode: "ECONOMY",
      keyframeExists: onDisk(true),
    });
    expect(d.facts.motionSource).toBe("LOCAL_MOTION");
  });

  it("ghim tay giữ AI_VIDEO kể cả khi luật nói LOCAL_MOTION", () => {
    const pinned = scene({
      spendPriority: "LOW",
      videoProvider: "runway",
      videoModel: "h3_max:768x1280",
      videoModelPinned: true,
    });
    const d = deriveSceneVideoFacts(pinned, {
      qualityMode: "ECONOMY",
      keyframeExists: onDisk(true),
    });
    expect(d.facts.motionSource).toBe("AI_VIDEO");
  });

  // QĐ-069. `generateSceneVideo` writes the model it used back onto the scene,
  // so after one paid clip every scene carries a provider/model pair. Reading
  // that pair as an instruction kept "free wins" switched off on exactly the
  // scenes that had already cost money - the most expensive possible place to
  // be wrong. Without `videoModelPinned` the pair is a RECORD, not a pin.
  it("cặp provider/model do router ghi lại KHÔNG phải ghim tay", () => {
    const writtenBack = scene({
      spendPriority: "LOW",
      videoProvider: "runway",
      videoModel: "h3_max:768x1280",
      videoModelPinned: false,
    });
    const d = deriveSceneVideoFacts(writtenBack, {
      qualityMode: "ECONOMY",
      keyframeExists: onDisk(true),
    });
    expect(d.facts.motionSource).toBe("LOCAL_MOTION");
  });

  // The importer's instruction is written as `motionMode`, not as a model name,
  // and it must keep its weight on its own.
  it("motionMode = VIDEO_AI vẫn là chỉ định, dù không ghim model nào", () => {
    const d = deriveSceneVideoFacts(
      scene({ spendPriority: "LOW", motionMode: "VIDEO_AI" }),
      { qualityMode: "ECONOMY", keyframeExists: onDisk(true) },
    );
    expect(d.facts.motionSource).toBe("AI_VIDEO");
  });

  it("ignoreManualPin CHỈ bỏ ghim khi quyết định motion, không sửa cảnh", () => {
    const pinned = scene({
      spendPriority: "LOW",
      videoProvider: "runway",
      videoModel: "h3_max:768x1280",
      videoModelPinned: true,
    });
    const d = deriveSceneVideoFacts(pinned, {
      qualityMode: "ECONOMY",
      ignoreManualPin: true,
      keyframeExists: onDisk(true),
    });
    expect(d.facts.motionSource).toBe("LOCAL_MOTION");
    // The row itself is untouched - the clone is a clone.
    expect(pinned.videoProvider).toBe("runway");
    expect(pinned.videoModel).toBe("h3_max:768x1280");
  });
});

// ------------------------------------------------------- parity with route ---

function model(over: Partial<ModelRegistry> & { modelId: string }): ModelRegistry {
  return {
    id: over.modelId,
    provider: "runway",
    displayName: over.modelId,
    type: "video",
    enabled: true,
    priceUnit: "per_second",
    price: 0.08,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    supportsCharacterReference: true,
    supportsAudio: false,
    supports1080p: false,
    supportsUpscale: false,
    maxDuration: 15,
    qualityRating: 6,
    speedRating: 6,
    consistencyRating: 6,
    historicalSuccessRate: 1,
    lifecycle: "LOW_AUTO",
    reliability: "OK",
    verification: "BENCHMARK_VERIFIED",
    notes: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ModelRegistry;
}

const H3_MAX = model({ modelId: "h3_max:768x1280" });

/**
 * A caller of `routeScene`, built the way each of the three real callers builds
 * one: scene facts from the shared derivation, environment facts of its own.
 */
function contextFrom(
  s: SceneFactsInput,
  opts: { keyframeOnDisk: boolean; qualityMode?: string },
): RouteContext {
  const d = deriveSceneVideoFacts(s, {
    qualityMode: opts.qualityMode ?? "BALANCED",
    stage: "VIDEO",
    keyframeExists: onDisk(opts.keyframeOnDisk),
  });
  return {
    type: "video",
    qualityMode: "BALANCED",
    strategy: "AUTO",
    complexity: s.complexity as "LOW",
    spendPriority: s.spendPriority as "HIGH",
    durationSeconds: s.duration,
    characterCount: d.characterCount,
    consistencyRequired: true,
    needs1080p: false,
    needsReferenceImage: true,
    keyframeAvailable: d.hasKeyframe,
    budgetRemaining: 5,
    usage: { seconds: s.duration, jobs: 1 },
    availableProviders: ["runway"],
    manualProvider: s.videoProvider,
    manualModel: s.videoModel,
    lowAuto: {
      ...d.facts,
      providerBudgets: { runway: 6.71 },
      perVideoCapRemaining: 1.5,
    },
  };
}

describe("dry-run, proof và đường chạy thật phải ra CÙNG một kết quả", () => {
  it("cùng input -> cùng provider, model, giá và cờ lowAutoRouted", () => {
    const s = scene();
    // Three callers, three separately built contexts, one derivation behind them.
    const a = routeScene([H3_MAX], contextFrom(s, { keyframeOnDisk: true }));
    const b = routeScene([H3_MAX], contextFrom(s, { keyframeOnDisk: true }));
    const c = routeScene([H3_MAX], contextFrom(s, { keyframeOnDisk: true }));

    for (const d of [b, c]) {
      expect(d.provider).toBe(a.provider);
      expect(d.modelId).toBe(a.modelId);
      expect(d.estimatedCost).toBe(a.estimatedCost);
      expect(d.lowAutoRouted).toBe(a.lowAutoRouted);
    }
    expect(a.modelId).toBe("h3_max:768x1280");
    expect(a.lowAutoRouted).toBe(true);
  });

  it("KHÔNG được có chuyện mô phỏng từ chối mà đường chạy thật vẫn mua", () => {
    // This is the exact drift that existed: the dry-run looked on disk and said
    // no; production read the column and said yes. Both callers now ask the same
    // question, so a deleted keyframe refuses in BOTH - which is the only answer
    // that cannot end in paying for an image-to-video call with no image.
    const s = scene(); // the column still names a file
    expect(() => routeScene([H3_MAX], contextFrom(s, { keyframeOnDisk: false }))).toThrow(
      RoutingError,
    );
    expect(() => routeScene([H3_MAX], contextFrom(s, { keyframeOnDisk: false }))).toThrow(
      /keyframe/i,
    );
  });

  it("cảnh LOCAL_MOTION: cổng từ chối ở mọi caller, không ai mua", () => {
    const s = scene({ spendPriority: "LOW", motionSource: "LOCAL_MOTION" });
    expect(() =>
      routeScene([H3_MAX], contextFrom(s, { keyframeOnDisk: true, qualityMode: "ECONOMY" })),
    ).toThrow(RoutingError);
  });

  it("MEDIUM vẫn bị chặn khi facts đến từ derivation chung", () => {
    const s = scene({ complexity: "MEDIUM" });
    expect(() => routeScene([H3_MAX], contextFrom(s, { keyframeOnDisk: true }))).toThrow(
      RoutingError,
    );
  });

  it("ghim tay thắng, và KHÔNG bị đánh dấu là router tự chọn", () => {
    const s = scene({ videoProvider: "runway", videoModel: "h3_max:768x1280" });
    const d = routeScene([H3_MAX], contextFrom(s, { keyframeOnDisk: true }));
    expect(d.modelId).toBe("h3_max:768x1280");
    expect(d.lowAutoRouted).toBe(false);
  });
});
