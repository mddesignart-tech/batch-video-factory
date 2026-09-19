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

// ------------------------------------------- LOW_AUTO wired into routing ---

/**
 * The gate is only worth anything if the ROUTER calls it.
 *
 * `lowAutoEligibility` was written, covered by seventeen tests, and reached by
 * nothing in production: `routeScene` knew one lever, `isAutoRoutable`, and that
 * lever could only say ACTIVE. Every test below fails if that regression comes
 * back, because each one drives the real `routeScene` rather than the gate.
 */

const LOW_AUTO_MODEL = model({
  modelId: "granted",
  provider: "mock",
  price: 0.08,
  qualityRating: 6,
  lifecycle: "LOW_AUTO",
  reliability: "OK",
  verification: "BENCHMARK_VERIFIED",
} as Partial<ModelRegistry> & { modelId: string });

/** Scene facts that pass every condition, so each test can spoil exactly one. */
function facts(over: Record<string, unknown> = {}) {
  return {
    stage: "VIDEO" as const,
    motionSource: "AI_VIDEO" as const,
    hasKeyframe: true,
    cameraMode: "LOCKED_CAMERA" as const,
    repeatedSmallObjects: false,
    motionScale: "SUBTLE" as const,
    multiCharacterInteraction: false,
    promptGuarded: true,
    contradictions: [] as string[],
    providerBudgets: { mock: 10 } as Record<string, number | null>,
    perVideoCapRemaining: 5,
    ...over,
  };
}

function lowAutoCtx(over: Partial<RouteContext> = {}): RouteContext {
  return ctx({ complexity: "LOW", lowAuto: facts(), ...over });
}

describe("LOW_AUTO: router phải tự gọi cổng", () => {
  it("cảnh LOW đủ điều kiện -> chọn được, và đánh dấu lowAutoRouted", () => {
    const d = routeScene([LOW_AUTO_MODEL], lowAutoCtx());
    expect(d.modelId).toBe("granted");
    expect(d.lowAutoRouted).toBe(true);
  });

  // QĐ-069. A fallback is bought with the same money as the first choice, so it
  // has to face the same question at the batch gate. `withFallback` cloned the
  // decision, so a fallback ONTO a LOW_AUTO model inherited `lowAutoRouted:
  // false` from a first choice that was not one - and gate 2b, whose whole job
  // is to stop an approval of named clips funding a clip the router picked, had
  // nothing to fire on. Each candidate now carries its own answer.
  it("mỗi phương án dự phòng mang cờ LOW_AUTO của CHÍNH nó", () => {
    // MID is the better value at quality 7 for $0.10 vs 6 for $0.08, so the
    // LOW_AUTO model lands in the fallback list rather than winning.
    const d = routeScene([MID, LOW_AUTO_MODEL], lowAutoCtx());
    expect(d.modelId).toBe("mid");
    expect(d.lowAutoRouted).toBe(false);

    const granted = d.fallbacks.find((f) => f.modelId === "granted");
    expect(granted).toBeDefined();
    expect(granted!.lowAuto).toBe(true);
    // ...and the ordinary model beside it still says no.
    expect(d.fallbacks.every((f) => f.modelId === "granted" || f.lowAuto === false)).toBe(true);
  });

  it("cảnh MEDIUM/HIGH -> KHÔNG chọn, dù model là ứng viên duy nhất", () => {
    for (const complexity of ["MEDIUM", "HIGH"] as const) {
      expect(() => routeScene([LOW_AUTO_MODEL], lowAutoCtx({ complexity }))).toThrow(RoutingError);
    }
  });

  it("thiếu keyframe ở bước VIDEO -> KHÔNG chọn", () => {
    expect(() =>
      routeScene([LOW_AUTO_MODEL], lowAutoCtx({ lowAuto: facts({ hasKeyframe: false }) })),
    ).toThrow(/keyframe/i);
  });

  it("quá 2 nhân vật -> KHÔNG chọn", () => {
    expect(() =>
      routeScene([LOW_AUTO_MODEL], lowAutoCtx({ characterCount: 3 })),
    ).toThrow(RoutingError);
  });

  it("camera chuyển động -> KHÔNG chọn", () => {
    expect(() =>
      routeScene(
        [LOW_AUTO_MODEL],
        lowAutoCtx({ lowAuto: facts({ cameraMode: "DIRECTED_CAMERA" }) }),
      ),
    ).toThrow(RoutingError);
  });

  it("cảnh LOCAL_MOTION -> KHÔNG chọn, không có gì để mua", () => {
    expect(() =>
      routeScene(
        [LOW_AUTO_MODEL],
        lowAutoCtx({ lowAuto: facts({ motionSource: "LOCAL_MOTION" }) }),
      ),
    ).toThrow(RoutingError);
  });

  it("ví nhà cung cấp không đủ -> KHÔNG chọn, dù hạn mức chung còn nhiều", () => {
    expect(() =>
      routeScene(
        [LOW_AUTO_MODEL],
        lowAutoCtx({ budgetRemaining: 100, lowAuto: facts({ providerBudgets: { mock: 0.01 } }) }),
      ),
    ).toThrow(RoutingError);
  });

  it("vượt trần mỗi video -> KHÔNG chọn", () => {
    expect(() =>
      routeScene(
        [LOW_AUTO_MODEL],
        lowAutoCtx({ lowAuto: facts({ perVideoCapRemaining: 0.01 }) }),
      ),
    ).toThrow(RoutingError);
  });

  it("model DEGRADED -> KHÔNG chọn dù đã được cấp LOW_AUTO", () => {
    const degraded = { ...LOW_AUTO_MODEL, reliability: "DEGRADED" } as ModelRegistry;
    expect(() => routeScene([degraded], lowAutoCtx())).toThrow(RoutingError);
  });

  it("model chưa BENCHMARK_VERIFIED -> KHÔNG chọn", () => {
    const unverified = { ...LOW_AUTO_MODEL, verification: "UNVERIFIED" } as ModelRegistry;
    expect(() => routeScene([unverified], lowAutoCtx())).toThrow(RoutingError);
  });

  it("KHÔNG có dữ liệu cảnh -> từ chối, không mặc định cho qua", () => {
    // Fail closed. A conditional grant whose conditions nobody evaluated has
    // not been satisfied, and an absent fact is not a favourable fact.
    expect(() => routeScene([LOW_AUTO_MODEL], ctx({ complexity: "LOW" }))).toThrow(RoutingError);
  });

  it("LOW_AUTO_CANDIDATE vẫn bị chặn ở đúng cảnh LOW", () => {
    const candidate = { ...LOW_AUTO_MODEL, lifecycle: "LOW_AUTO_CANDIDATE" } as ModelRegistry;
    expect(() => routeScene([candidate], lowAutoCtx())).toThrow(RoutingError);
  });

  it("KHÔNG âm thầm rơi sang model trả phí khác khi cổng từ chối", () => {
    // The refusal must be a refusal, not a redirection. gen4_turbo is DEGRADED,
    // gen4.5 is PIN_ONLY and Sora is DEPRECATED for reasons someone wrote down;
    // rescuing a scene with one of them would undo all three at once.
    const blocked = { ...MID, lifecycle: "PIN_ONLY" } as ModelRegistry;
    expect(() =>
      routeScene([LOW_AUTO_MODEL, blocked], lowAutoCtx({ characterCount: 3 })),
    ).toThrow(RoutingError);
  });
});

describe("LOW_AUTO không được đè lên lệnh ghim tay", () => {
  it("ghim model khác thì dùng model đó, và KHÔNG đánh dấu lowAutoRouted", () => {
    const d = routeScene(
      [LOW_AUTO_MODEL, MID],
      lowAutoCtx({ manualProvider: "mock", manualModel: "mid" }),
    );
    expect(d.modelId).toBe("mid");
    expect(d.lowAutoRouted).toBe(false);
  });

  it("ghim đúng model LOW_AUTO vẫn là lệnh của người, không phải của router", () => {
    const d = routeScene(
      [LOW_AUTO_MODEL],
      lowAutoCtx({ manualProvider: "mock", manualModel: "granted" }),
    );
    expect(d.modelId).toBe("granted");
    expect(d.lowAutoRouted).toBe(false);
  });

  it("ghim model KHÔNG dùng được thì báo lỗi rõ, không tự đổi sang cái khác", () => {
    const deprecated = {
      ...MID,
      modelId: "retired",
      lifecycle: "DEPRECATED",
      enabled: false,
    } as ModelRegistry;
    expect(() =>
      routeScene(
        [LOW_AUTO_MODEL, deprecated],
        lowAutoCtx({ manualProvider: "mock", manualModel: "retired" }),
      ),
    ).toThrow(RoutingError);
  });

  it("ghim tay tới được model DEPRECATED, nhưng KHÔNG im lặng", () => {
    // QĐ-028: deprecating blocks the ROUTER, not a person - removing that path
    // would make a deliberate one-off impossible and old work unreproducible.
    // "Must not bypass AUTOMATICALLY" is satisfied by saying so out loud, and
    // the warning rides in `reason` where the operator actually reads it.
    const retiring = {
      ...MID,
      modelId: "sunset",
      lifecycle: "DEPRECATED",
      enabled: true,
      shutdownDate: new Date("2099-01-01"),
      replacementNote: "Dùng model khác thay thế.",
    } as ModelRegistry;
    const d = routeScene(
      [retiring],
      lowAutoCtx({ manualProvider: "mock", manualModel: "sunset" }),
    );
    expect(d.modelId).toBe("sunset");
    expect(d.reason).toContain("NGỪNG DÙNG");
    expect(d.reason).toContain("2099-01-01");
    expect(d.reason).toContain("Dùng model khác thay thế.");
  });

  it("ghim tay KHÔNG vượt qua được model đang bị TẮT", () => {
    const off = {
      ...MID,
      modelId: "off",
      lifecycle: "DISABLED",
      enabled: true,
    } as ModelRegistry;
    expect(() =>
      routeScene([off], lowAutoCtx({ manualProvider: "mock", manualModel: "off" })),
    ).toThrow(/TẮT/);
  });

  it("ghim tay KHÔNG vượt qua được ngày nhà cung cấp ĐÃ tắt model", () => {
    // QĐ-038: the label is only as recent as the last person to edit it; the
    // DATE is the fact. A model that is already off will not run because an
    // operator typed its name, and the request is bought before it is refused.
    const shutdown = {
      ...MID,
      modelId: "gone",
      lifecycle: "ACTIVE",
      enabled: true,
      shutdownDate: new Date("2020-01-01"),
    } as ModelRegistry;
    expect(() =>
      routeScene([shutdown], lowAutoCtx({ manualProvider: "mock", manualModel: "gone" })),
    ).toThrow(/tắt/i);
  });

  it("ghim tay VẪN được phép chọn model DEGRADED — đó là ý kiến, không phải sự thật", () => {
    // The distinction that keeps the rule honest. "The vendor turned it off" is
    // a fact a person cannot overrule; "it went wrong for us twice" is a
    // judgement, and a person may decide to try again with their eyes open.
    const degraded = {
      ...MID,
      modelId: "shaky",
      lifecycle: "ACTIVE",
      reliability: "DEGRADED",
    } as ModelRegistry;
    const d = routeScene(
      [degraded],
      lowAutoCtx({ manualProvider: "mock", manualModel: "shaky" }),
    );
    expect(d.modelId).toBe("shaky");
    expect(d.lowAutoRouted).toBe(false);
  });
});

describe("lời từ chối phải nói về ĐÚNG model bị chặn", () => {
  /**
   * The bug this guards: the refusal used to describe `pinOnly[0]` - whichever
   * row the registry happened to return first - and nothing else. Asking why
   * h3_max did not run on a MEDIUM scene was answered with Sora-2's shutdown
   * date: a model nobody had mentioned, blocked for an unrelated reason, while
   * the model actually under discussion was not named at all.
   *
   * An error that names the wrong model is worse than a vague one, because it
   * sends someone to fix something that was never broken.
   */
  const RETIRED = {
    ...MID,
    provider: "openai",
    modelId: "sora-2:720x1280",
    lifecycle: "DEPRECATED",
    shutdownDate: new Date("2026-09-24"),
    replacementNote: "OpenAI ngừng phục vụ Sora API.",
  } as ModelRegistry;

  it("nêu tên TỪNG model bị chặn kèm lý do riêng, không chỉ cái đầu tiên", () => {
    try {
      routeScene(
        [RETIRED, LOW_AUTO_MODEL],
        lowAutoCtx({
          availableProviders: ["mock", "openai"],
          lowAuto: facts({ hasKeyframe: false }),
        }),
      );
      throw new Error("đáng lẽ phải ném lỗi");
    } catch (err) {
      const msg = (err as Error).message;
      // Both models named...
      expect(msg).toContain("openai/sora-2:720x1280");
      expect(msg).toContain("mock/granted");
      // ...each with its OWN reason, not one reason borrowed for both.
      expect(msg).toContain("NGỪNG DÙNG");
      expect(msg).toContain("keyframe");
    }
  });

  it("model bị TRẦN ĐỘ KHÓ loại vẫn phải được nêu tên", () => {
    // These never reach the pin-only list at all: `isCapable` drops them
    // earlier, so without explicit handling they vanish from the explanation -
    // which is exactly how the hard ceiling did its job in silence while the
    // error talked about something else.
    const ceilinged = {
      ...MID,
      provider: "runway",
      modelId: "h3_max:768x1280",
      lifecycle: "LOW_AUTO",
      reliability: "OK",
      verification: "BENCHMARK_VERIFIED",
    } as ModelRegistry;
    try {
      routeScene(
        [ceilinged],
        lowAutoCtx({ complexity: "MEDIUM", availableProviders: ["runway"] }),
      );
      throw new Error("đáng lẽ phải ném lỗi");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("runway/h3_max:768x1280");
      expect(msg).toContain("vượt mức LOW");
    }
  });
});
