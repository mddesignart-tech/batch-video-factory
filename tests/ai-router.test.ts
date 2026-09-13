import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "@prisma/client";
import {
  isCapable,
  qualityFloor,
  routeScene,
  RoutingError,
  type RouteContext,
} from "@/services/ai-router";

/**
 * AIRouter is the component that decides where the money goes, so these tests
 * are written as behavioural claims about cost, not as snapshots.
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
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    supportsCharacterReference: true,
    supportsAudio: false,
    supports1080p: true,
    supportsUpscale: false,
    maxDuration: 10,
    qualityRating: 5,
    speedRating: 5,
    consistencyRating: 5,
    historicalSuccessRate: 1,
    notes: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ModelRegistry;
}

const CHEAP = model({
  modelId: "cheap",
  price: 0.02,
  qualityRating: 4,
  consistencyRating: 4,
  speedRating: 9,
  maxDuration: 6,
});
const MID = model({
  modelId: "mid",
  price: 0.1,
  qualityRating: 7,
  consistencyRating: 7,
  speedRating: 7,
});
const PREMIUM = model({
  modelId: "premium",
  price: 0.4,
  qualityRating: 10,
  consistencyRating: 10,
  speedRating: 4,
});

const ALL = [CHEAP, MID, PREMIUM];

function ctx(over: Partial<RouteContext> = {}): RouteContext {
  return {
    type: "video",
    qualityMode: "BALANCED",
    strategy: "AUTO",
    complexity: "LOW",
    spendPriority: "NORMAL",
    durationSeconds: 4,
    characterCount: 1,
    consistencyRequired: true,
    needs1080p: true,
    needsReferenceImage: false,
    budgetRemaining: 10,
    usage: { seconds: 4, jobs: 1 },
    availableProviders: ["mock"],
    ...over,
  };
}

describe("qualityFloor", () => {
  it("raises the bar for complex and high-priority scenes", () => {
    const simple = qualityFloor("BALANCED", "LOW", "LOW");
    const hard = qualityFloor("BALANCED", "HIGH", "HIGH");
    expect(hard).toBeGreaterThan(simple);
  });

  it("caps ECONOMY so a busy scene cannot drag it into premium tiers", () => {
    expect(qualityFloor("ECONOMY", "HIGH", "HIGH")).toBeLessThanOrEqual(5.5);
  });

  it("keeps QUALITY above BALANCED for the same scene", () => {
    expect(qualityFloor("QUALITY", "MEDIUM", "NORMAL")).toBeGreaterThan(
      qualityFloor("BALANCED", "MEDIUM", "NORMAL"),
    );
  });
});

describe("ECONOMY mode", () => {
  it("picks the cheapest usable model for a simple scene", () => {
    const decision = routeScene(ALL, ctx({ qualityMode: "ECONOMY" }));
    expect(decision.modelId).toBe("cheap");
  });

  it("does not escalate to premium just because the scene is complex", () => {
    const decision = routeScene(
      ALL,
      ctx({
        qualityMode: "ECONOMY",
        complexity: "HIGH",
        spendPriority: "HIGH",
        characterCount: 2,
      }),
    );
    expect(decision.modelId).not.toBe("premium");
  });
});

describe("BALANCED mode", () => {
  it("uses a cheap model for a simple low-priority scene", () => {
    const decision = routeScene(
      ALL,
      ctx({ complexity: "LOW", spendPriority: "LOW" }),
    );
    expect(decision.estimatedCost).toBeLessThanOrEqual(
      routeScene(ALL, ctx({ complexity: "HIGH", spendPriority: "HIGH" }))
        .estimatedCost,
    );
  });

  it("spends more on the hook than on a static explanation scene", () => {
    const hook = routeScene(
      ALL,
      ctx({ complexity: "MEDIUM", spendPriority: "HIGH" }),
    );
    const explain = routeScene(
      ALL,
      ctx({ complexity: "LOW", spendPriority: "LOW" }),
    );
    expect(hook.estimatedCost).toBeGreaterThan(explain.estimatedCost);
  });

  it("mixes models across scenes of one video - the core cost feature", () => {
    const scenes: RouteContext[] = [
      ctx({ complexity: "MEDIUM", spendPriority: "HIGH" }), // hook
      ctx({ complexity: "MEDIUM", spendPriority: "NORMAL" }),
      ctx({ complexity: "HIGH", spendPriority: "NORMAL", characterCount: 2 }),
      ctx({ complexity: "HIGH", spendPriority: "HIGH", characterCount: 2 }), // punchline
      ctx({ complexity: "LOW", spendPriority: "LOW" }), // meaning card
    ];
    const chosen = scenes.map((s) => routeScene(ALL, s).modelId);
    expect(new Set(chosen).size).toBeGreaterThan(1);
  });
});

describe("QUALITY mode", () => {
  it("prefers the strongest model available", () => {
    const decision = routeScene(
      ALL,
      ctx({ qualityMode: "QUALITY", complexity: "HIGH", spendPriority: "HIGH" }),
    );
    expect(decision.modelId).toBe("premium");
  });

  it("still obeys the budget ceiling and downgrades instead of overspending", () => {
    const decision = routeScene(
      ALL,
      ctx({
        qualityMode: "QUALITY",
        complexity: "HIGH",
        spendPriority: "HIGH",
        budgetRemaining: 0.5,
      }),
    );
    expect(decision.estimatedCost).toBeLessThanOrEqual(0.5);
    expect(decision.downgraded).toBe(true);
  });
});

describe("CUSTOM / MANUAL pinning", () => {
  it("honours an explicit model pin", () => {
    const decision = routeScene(
      ALL,
      ctx({
        qualityMode: "CUSTOM",
        strategy: "MANUAL",
        manualProvider: "mock",
        manualModel: "premium",
      }),
    );
    expect(decision.modelId).toBe("premium");
    expect(decision.reason).toContain("thủ công");
  });

  it("rejects a pin the scene cannot actually use", () => {
    expect(() =>
      routeScene(
        ALL,
        ctx({
          strategy: "MANUAL",
          manualProvider: "mock",
          manualModel: "cheap",
          durationSeconds: 9, // exceeds cheap's 6s maxDuration
        }),
      ),
    ).toThrow(RoutingError);
  });

  it("refuses a pin that does not fit the remaining budget", () => {
    expect(() =>
      routeScene(
        ALL,
        ctx({
          strategy: "MANUAL",
          manualProvider: "mock",
          manualModel: "premium",
          budgetRemaining: 0.05,
        }),
      ),
    ).toThrow(/ngân sách/i);
  });
});

describe("strategies", () => {
  it("CHEAPEST always lands on the lowest price", () => {
    const decision = routeScene(
      ALL,
      ctx({ strategy: "CHEAPEST", complexity: "HIGH", spendPriority: "HIGH" }),
    );
    expect(decision.modelId).toBe("cheap");
  });

  it("BEST_QUALITY always lands on the highest quality", () => {
    const decision = routeScene(ALL, ctx({ strategy: "BEST_QUALITY" }));
    expect(decision.modelId).toBe("premium");
  });

  it("BEST_VALUE does not simply pick the most expensive option", () => {
    const decision = routeScene(ALL, ctx({ strategy: "BEST_VALUE" }));
    expect(decision.modelId).not.toBe("premium");
  });
});

describe("capability filtering", () => {
  it("excludes a model whose max duration is too short", () => {
    expect(isCapable(CHEAP, ctx({ durationSeconds: 8 }))).toBe(false);
    expect(isCapable(MID, ctx({ durationSeconds: 8 }))).toBe(true);
  });

  it("excludes a model without image-to-video when a keyframe is required", () => {
    const noI2V = model({ modelId: "t2v-only", supportsImageToVideo: false });
    expect(isCapable(noI2V, ctx({ needsReferenceImage: true }))).toBe(false);
  });

  it("requires character reference support for multi-character scenes", () => {
    const noRef = model({
      modelId: "no-ref",
      supportsReferenceImage: false,
      supportsCharacterReference: false,
    });
    expect(
      isCapable(noRef, ctx({ characterCount: 2, consistencyRequired: true })),
    ).toBe(false);
  });

  it("ignores models from providers that are not currently available", () => {
    const other = model({ modelId: "x", provider: "runway" });
    expect(isCapable(other, ctx({ availableProviders: ["mock"] }))).toBe(false);
  });

  it("throws when nothing can serve the scene", () => {
    expect(() =>
      routeScene([CHEAP], ctx({ durationSeconds: 30 })),
    ).toThrow(RoutingError);
  });

  it("throws when the registry is empty", () => {
    expect(() => routeScene([], ctx())).toThrow(/Chưa có mô hình/);
  });
});

describe("fallbacks", () => {
  it("offers affordable alternates ordered after the primary choice", () => {
    const decision = routeScene(ALL, ctx({ budgetRemaining: 100 }));
    expect(decision.fallbacks.length).toBeGreaterThan(0);
    for (const fallback of decision.fallbacks) {
      expect(
        fallback.provider === decision.provider &&
          fallback.modelId === decision.modelId,
      ).toBe(false);
    }
  });

  it("never offers a fallback that exceeds the remaining budget", () => {
    const decision = routeScene(ALL, ctx({ budgetRemaining: 0.3 }));
    for (const fallback of decision.fallbacks) {
      expect(fallback.estimatedCost).toBeLessThanOrEqual(0.3);
    }
  });
});

describe("budget exhaustion", () => {
  it("fails loudly rather than silently overspending", () => {
    expect(() => routeScene(ALL, ctx({ budgetRemaining: 0.0001 }))).toThrow(
      RoutingError,
    );
  });
});

describe("historical success rate", () => {
  it("penalises an unreliable model against an equally rated one", () => {
    const flaky = model({
      modelId: "flaky",
      price: 0.1,
      qualityRating: 7,
      consistencyRating: 7,
      historicalSuccessRate: 0.4,
    });
    const decision = routeScene(
      [flaky, MID],
      ctx({ strategy: "BEST_QUALITY" }),
    );
    expect(decision.modelId).toBe("mid");
  });
});
