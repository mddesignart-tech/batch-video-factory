import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "@prisma/client";
import {
  allowedDurationsFor,
  billedVideoSeconds,
  planDuration,
  SORA_DURATIONS,
} from "@/domain/video-duration";
import { isAutoRoutable, MODEL_LIFECYCLES } from "@/domain/enums";
import { routeScene, RoutingError, type RouteContext } from "@/services/ai-router";
import { costForModel } from "@/services/pricing";

/**
 * Duration capability, and the lifecycle gate.
 *
 * ## The bug
 *
 * `billedVideoSeconds` had no case for OpenAI, so it fell through to
 * `default: return requestedSeconds` - "this vendor bills exactly what you ask
 * for". Sora sells 4, 8 or 12 seconds and rejects everything else, so the
 * estimator was quoting $0.30 for a 3-second request, $0.50 for a 5-second and
 * $0.60 for a 6-second: three prices for three requests the API would refuse.
 *
 * The project's own benchmark table already recorded a 6-second Sora request
 * coming back HTTP 400, filed as "probably not a valid length, unproven without
 * another POST". It was the right reading. This is the confirmation, and it
 * cost nothing to get.
 *
 * ## What must never come back
 *
 * A price computed from `requested x rate` when the vendor cannot be sent that
 * duration. Either the estimate uses the length that WOULD be sent, or there is
 * no honest estimate at all.
 */

const SORA = "sora-2:720x1280";

function model(over: Partial<ModelRegistry> & { modelId: string }): ModelRegistry {
  return {
    id: over.modelId,
    provider: "openai",
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
    supportsInputFidelity: false,
    supportsAudio: false,
    supports1080p: true,
    supportsUpscale: false,
    supportsVoiceInstructions: false,
    maxDuration: 12,
    qualityRating: 8,
    speedRating: 7,
    consistencyRating: 8,
    historicalSuccessRate: 1,
    lifecycle: "ACTIVE",
    deprecationDate: null,
    shutdownDate: null,
    replacementNote: "",
    lastVerifiedAt: null,
    notes: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ModelRegistry;
}

const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({
  type: "video",
  qualityMode: "ECONOMY",
  strategy: "AUTO",
  complexity: "LOW",
  spendPriority: "NORMAL",
  durationSeconds: 4,
  characterCount: 1,
  consistencyRequired: false,
  needs1080p: false,
  needsReferenceImage: false,
  budgetRemaining: 100,
  usage: { seconds: 4, jobs: 1 },
  availableProviders: ["openai", "runway"],
  ...over,
});

// ------------------------------------------------------- allowed durations ---

describe("Sora allowed durations", () => {
  it("sells 4, 8 and 12 seconds and nothing else", () => {
    expect([...SORA_DURATIONS]).toEqual([4, 8, 12]);
    expect(allowedDurationsFor("openai", SORA)).toEqual([4, 8, 12]);
  });

  it("never bills a length the vendor would refuse", () => {
    for (const requested of [1, 2, 3, 5, 6, 7, 9, 10, 11]) {
      const billed = billedVideoSeconds({
        provider: "openai",
        model: SORA,
        size: "720x1280",
        requestedSeconds: requested,
        hasKeyframe: true,
      });
      expect(SORA_DURATIONS).toContain(billed);
      // And never DOWN - quoting short is the one direction a spend estimate
      // must not be wrong in.
      expect(billed).toBeGreaterThanOrEqual(requested);
    }
  });

  it.each([
    { requested: 3, willSend: 4, status: "DURATION_TRANSFORM_REQUIRED", cost: 0.4 },
    { requested: 4, willSend: 4, status: "EXACT", cost: 0.4 },
    { requested: 5, willSend: 8, status: "DURATION_TRANSFORM_REQUIRED", cost: 0.8 },
    { requested: 6, willSend: 8, status: "DURATION_TRANSFORM_REQUIRED", cost: 0.8 },
    { requested: 8, willSend: 8, status: "EXACT", cost: 0.8 },
    { requested: 12, willSend: 12, status: "EXACT", cost: 1.2 },
  ])(
    "$requested s -> sends $willSend s, $status, $cost USD",
    ({ requested, willSend, status, cost }) => {
      const plan = planDuration({
        provider: "openai",
        model: SORA,
        size: "720x1280",
        requestedSeconds: requested,
        hasKeyframe: true,
      });
      expect(plan.willSend).toBe(willSend);
      expect(plan.status).toBe(status);
      expect(plan.allowed).toEqual([4, 8, 12]);

      // The price follows the length that would ACTUALLY be sent.
      expect(
        costForModel(model({ modelId: SORA }), { seconds: plan.willSend, jobs: 1 }),
      ).toBeCloseTo(cost, 6);
    },
  );

  it("says what it would take, rather than silently substituting it", () => {
    const plan = planDuration({
      provider: "openai",
      model: SORA,
      size: "720x1280",
      requestedSeconds: 6,
      hasKeyframe: true,
    });
    // The distinction the whole type exists for: the caller is told the request
    // cannot go out as written, and is given the nearest length - but nothing
    // here decides to shorten or lengthen the scene. That is a content call.
    expect(plan.status).toBe("DURATION_TRANSFORM_REQUIRED");
    expect(plan.requested).toBe(6);
    expect(plan.reason).toContain("4/8/12");
    expect(plan.reason).toContain("KHÔNG gửi được");
  });

  it("leaves a continuous-billing vendor alone", () => {
    // gen4.5 bills whole seconds across 2-10, so 6 seconds is simply 6 seconds.
    const plan = planDuration({
      provider: "runway",
      model: "gen4.5:720x1280",
      size: "720x1280",
      requestedSeconds: 6,
      hasKeyframe: true,
    });
    expect(plan.status).toBe("EXACT");
    expect(plan.willSend).toBe(6);
  });

  it("calls Runway gen4_turbo's 5-second minimum padding, not a rejection", () => {
    // 4 seconds is a legitimate request that is billed as 5 - proven by a real
    // clip that cost $0.25. That is a different situation from a length the API
    // refuses, and conflating them would either block valid work or wave
    // through invalid work.
    const plan = planDuration({
      provider: "runway",
      model: "gen4_turbo:720x1280",
      size: "720x1280",
      requestedSeconds: 4,
      hasKeyframe: true,
    });
    expect(plan.willSend).toBe(5);
    expect(plan.status).toBe("DURATION_TRANSFORM_REQUIRED");
    expect(plan.allowed).toEqual([5, 10]);
  });
});

// ------------------------------------------------------- lifecycle gating ---

describe("provider lifecycle", () => {
  it("lets the router choose only ACTIVE models on its own", () => {
    expect(isAutoRoutable("ACTIVE")).toBe(true);
    for (const state of MODEL_LIFECYCLES.filter((s) => s !== "ACTIVE")) {
      expect(isAutoRoutable(state)).toBe(false);
    }
  });

  it("refuses to auto-route a DEPRECATED model even when it is the only fit", () => {
    const deprecated = model({
      modelId: SORA,
      lifecycle: "DEPRECATED",
      shutdownDate: new Date("2026-09-24"),
      replacementNote: "OpenAI ngung phuc vu Sora API.",
    });

    expect(() => routeScene([deprecated], ctx())).toThrow(RoutingError);
    try {
      routeScene([deprecated], ctx());
    } catch (err) {
      expect((err as RoutingError).code).toBe("needs_explicit_pin");
      // The refusal has to say WHY, with the date - "no model available" would
      // send an operator hunting through the registry for a row that is sitting
      // right there, enabled and working.
      expect((err as Error).message).toContain("NGỪNG DÙNG");
      expect((err as Error).message).toContain("2026-09-24");
    }
  });

  it("still reaches a DEPRECATED model through an explicit manual pin", () => {
    // Deprecating a model must not make old work unreadable or a deliberate
    // one-off impossible. It stops the ROUTER choosing, not a person choosing.
    const deprecated = model({ modelId: SORA, lifecycle: "DEPRECATED" });
    const decision = routeScene(
      [deprecated],
      ctx({
        strategy: "MANUAL",
        manualProvider: "openai",
        manualModel: SORA,
      }),
    );
    expect(decision.modelId).toBe(SORA);
  });

  it("prices a manual Sora pin at the sendable length, not the requested one", () => {
    const deprecated = model({ modelId: SORA, lifecycle: "DEPRECATED" });
    const decision = routeScene(
      [deprecated],
      ctx({
        strategy: "MANUAL",
        manualProvider: "openai",
        manualModel: SORA,
        durationSeconds: 6,
        usage: { seconds: 6, jobs: 1 },
      }),
    );
    // 6 seconds cannot be sent; 8 can. $0.80, not $0.60.
    expect(decision.estimatedCost).toBeCloseTo(0.8, 6);
  });

  it("picks the ACTIVE model when a deprecated one would otherwise win", () => {
    const deprecated = model({
      modelId: SORA,
      lifecycle: "DEPRECATED",
      price: 0.01,
      qualityRating: 10,
    });
    const active = model({
      provider: "runway",
      modelId: "gen4_turbo:720x1280",
      price: 0.05,
      qualityRating: 8,
      lifecycle: "ACTIVE",
    });

    // The deprecated row is cheaper AND higher quality, so every scoring rule
    // would prefer it. The lifecycle gate has to win regardless.
    const decision = routeScene([deprecated, active], ctx({ strategy: "CHEAPEST" }));
    expect(decision.provider).toBe("runway");
  });
});

// --------------------------------------------------- V1 routing by complexity ---

describe("Batch V1 routing policy", () => {
  const gen4turbo = model({
    provider: "runway",
    modelId: "gen4_turbo:720x1280",
    price: 0.05,
    lifecycle: "ACTIVE",
  });
  const gen45 = model({
    provider: "runway",
    modelId: "gen4.5:720x1280",
    price: 0.12,
    lifecycle: "PIN_ONLY",
  });
  const sora = model({ modelId: SORA, lifecycle: "DEPRECATED" });
  const registry = [gen4turbo, gen45, sora];

  it("routes a LOW scene to Runway gen4_turbo", () => {
    const decision = routeScene(
      registry,
      ctx({ complexity: "LOW", characterCount: 1 }),
    );
    expect(decision.provider).toBe("runway");
    expect(decision.modelId).toBe("gen4_turbo:720x1280");
  });

  it("leaves a MEDIUM scene with no auto-routable provider", () => {
    // gen4_turbo is capped at LOW by benchmark evidence, gen4.5 is PIN_ONLY and
    // Sora is DEPRECATED. Nothing is cleared, and the honest answer is to say so
    // rather than reach for whichever is left.
    expect(() =>
      routeScene(registry, ctx({ complexity: "MEDIUM", characterCount: 2 })),
    ).toThrow(RoutingError);
  });

  it("leaves a HIGH scene with no auto-routable provider", () => {
    expect(() =>
      routeScene(registry, ctx({ complexity: "HIGH", characterCount: 2 })),
    ).toThrow(RoutingError);
  });

  it("never substitutes an unapproved model just to complete the scene", () => {
    // The failure mode this guards: a router that would rather finish a batch
    // than stop, quietly spending on a model nobody cleared.
    for (const complexity of ["MEDIUM", "HIGH"] as const) {
      let chosen: string | null = null;
      try {
        chosen = routeScene(registry, ctx({ complexity, characterCount: 2 })).modelId;
      } catch {
        chosen = null;
      }
      expect(chosen).toBeNull();
    }
  });
});
