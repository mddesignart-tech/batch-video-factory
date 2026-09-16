import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "@prisma/client";
import {
  billedVideoSeconds,
  forcedToEightSeconds,
  isDurationPaddedBy,
  nearestFrom,
  splitModelSize,
  RUNWAY_DURATIONS,
  VEO_DURATIONS,
} from "@/domain/video-duration";
import { routeScene, type RouteContext } from "@/services/ai-router";
import { idempotencyKey } from "@/services/generation";

/**
 * Regression tests for three faults found while preparing the Runway benchmark.
 *
 * All three shared one shape: a number that looked right in one place and was
 * wrong in the place that actually guards the money.
 */

function model(
  over: Partial<ModelRegistry> & { modelId: string; provider: string },
): ModelRegistry {
  return {
    id: `${over.provider}/${over.modelId}`,
    displayName: over.modelId,
    type: "video",
    enabled: true,
    priceUnit: "per_second",
    price: 0.05,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    supportsCharacterReference: true,
    supportsAudio: false,
    supports1080p: true,
    supportsUpscale: false,
    maxDuration: 10,
    qualityRating: 8,
    speedRating: 8,
    consistencyRating: 8,
    historicalSuccessRate: 1,
    notes: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ModelRegistry;
}

const RUNWAY = model({
  provider: "runway",
  modelId: "gen4_turbo:720x1280",
  price: 0.05,
});
const VEO = model({
  provider: "google",
  modelId: "veo-3.1-lite-generate-preview:720x1280",
  price: 0.05,
});
const SORA = model({
  provider: "openai",
  modelId: "sora-2:720x1280",
  price: 0.1,
});

function ctx(over: Partial<RouteContext> = {}): RouteContext {
  return {
    type: "video",
    qualityMode: "CUSTOM",
    strategy: "MANUAL",
    complexity: "LOW",
    spendPriority: "NORMAL",
    durationSeconds: 4,
    characterCount: 2,
    consistencyRequired: true,
    needs1080p: false,
    needsReferenceImage: true,
    keyframeAvailable: true,
    budgetRemaining: 10,
    usage: { seconds: 4, jobs: 1 },
    availableProviders: ["runway", "google", "openai"],
    ...over,
  };
}

describe("billedVideoSeconds", () => {
  it("bills a 4 second Runway scene as 5, because Runway sells no 4s clip", () => {
    expect(
      billedVideoSeconds({
        provider: "runway",
        size: "720x1280",
        requestedSeconds: 4,
        hasKeyframe: true,
      }),
    ).toBe(5);
  });

  it("forces Veo to 8 seconds when a keyframe is attached", () => {
    expect(
      billedVideoSeconds({
        provider: "google",
        size: "720x1280",
        requestedSeconds: 4,
        hasKeyframe: true,
      }),
    ).toBe(8);
  });

  it("forces Veo to 8 seconds at 1080p even without a keyframe", () => {
    expect(
      billedVideoSeconds({
        provider: "google",
        size: "1080x1920",
        requestedSeconds: 4,
        hasKeyframe: false,
      }),
    ).toBe(8);
  });

  it("lets Veo keep 4 seconds at 720p with no keyframe", () => {
    expect(
      billedVideoSeconds({
        provider: "google",
        size: "720x1280",
        requestedSeconds: 4,
        hasKeyframe: false,
      }),
    ).toBe(4);
  });

  it("bills OpenAI exactly what was asked for", () => {
    expect(
      billedVideoSeconds({
        provider: "openai",
        size: "720x1280",
        requestedSeconds: 4,
        hasKeyframe: true,
      }),
    ).toBe(4);
  });

  it("invents no rounding rule for a vendor it does not know", () => {
    expect(
      billedVideoSeconds({
        provider: "somebody-new",
        size: "720x1280",
        requestedSeconds: 3,
        hasKeyframe: true,
      }),
    ).toBe(3);
  });

  it("never rounds DOWN inside the range the vendor actually sells", () => {
    for (const seconds of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(nearestFrom(RUNWAY_DURATIONS, seconds)).toBeGreaterThanOrEqual(
        seconds,
      );
    }
    for (const seconds of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(nearestFrom(VEO_DURATIONS, seconds)).toBeGreaterThanOrEqual(
        seconds,
      );
    }
  });

  it("caps at the vendor's longest clip when asked for more than it sells", () => {
    // Veo's longest is 8s. Asking for 9 returns 8 - which IS below the request,
    // but there is no 9-second clip to buy, so this is a price for the longest
    // thing that exists, not an under-quote. The guard against actually
    // ordering an impossible length is `maxDuration` in ModelRegistry, which
    // the router filters on before any of this arithmetic runs.
    expect(nearestFrom(VEO_DURATIONS, 9)).toBe(8);
    expect(nearestFrom(RUNWAY_DURATIONS, 30)).toBe(10);
  });

  it("treats an unparseable size as NOT 720p, so it quotes high not low", () => {
    expect(forcedToEightSeconds("nonsense", false)).toBe(true);
  });

  it("reports how many seconds of padding the operator is paying for", () => {
    const padding = isDurationPaddedBy({
      provider: "runway",
      size: "720x1280",
      requestedSeconds: 4,
      hasKeyframe: true,
    });
    expect(padding).toBe(1);
  });
});

describe("splitModelSize", () => {
  it("reads the size suffix off a registry model id", () => {
    expect(splitModelSize("gen4_turbo:720x1280")).toEqual({
      apiModel: "gen4_turbo",
      size: "720x1280",
    });
  });

  it("falls back to the cheapest size when the suffix is missing", () => {
    expect(splitModelSize("gen4_turbo").size).toBe("720x1280");
  });
});

describe("router estimates match what the vendor will invoice", () => {
  // This is the bug that mattered: the spend guard was being handed
  // `price x seconds requested`, so the cap was checked against a figure below
  // the real charge. Under-quoting is the one direction a cap must never fail.

  it("quotes Runway at 5 billed seconds, not 4 requested", () => {
    const decision = routeScene(
      [RUNWAY],
      ctx({ manualProvider: "runway", manualModel: "gen4_turbo:720x1280" }),
    );
    expect(decision.estimatedCost).toBeCloseTo(0.25, 6);
    expect(decision.estimatedCost).not.toBeCloseTo(0.2, 6);
  });

  it("quotes Veo at 8 billed seconds when a keyframe is attached", () => {
    const decision = routeScene(
      [VEO],
      ctx({
        manualProvider: "google",
        manualModel: "veo-3.1-lite-generate-preview:720x1280",
      }),
    );
    expect(decision.estimatedCost).toBeCloseTo(0.4, 6);
  });

  it("leaves OpenAI alone, which has no padding rule", () => {
    const decision = routeScene(
      [SORA],
      ctx({ manualProvider: "openai", manualModel: "sora-2:720x1280" }),
    );
    expect(decision.estimatedCost).toBeCloseTo(0.4, 6);
  });

  it("uses the keyframe that EXISTS, not the one that is merely wanted", () => {
    const withFile = routeScene(
      [VEO],
      ctx({
        manualProvider: "google",
        manualModel: "veo-3.1-lite-generate-preview:720x1280",
        needsReferenceImage: false,
        keyframeAvailable: true,
      }),
    );
    // A keyframe on disk will be sent, so Veo's 8-second rule applies even
    // though the router did not ask for a reference image.
    expect(withFile.estimatedCost).toBeCloseTo(0.4, 6);
  });

  it("does not let padding change non-video routing", () => {
    const text = routeScene(
      [
        model({
          provider: "groq",
          modelId: "t",
          type: "text",
          priceUnit: "per_1k_tokens",
          price: 0.001,
        }),
      ],
      ctx({
        type: "text",
        consistencyRequired: false,
        needsReferenceImage: false,
        keyframeAvailable: false,
        usage: { tokens: 1000, jobs: 1 },
        availableProviders: ["groq"],
        manualProvider: "groq",
        manualModel: "t",
      }),
    );
    expect(text.estimatedCost).toBeCloseTo(0.001, 6);
  });
});

describe("idempotency key covers every billable parameter", () => {
  const base = {
    sceneId: "scene-1",
    kind: "video",
    provider: "runway",
    model: "gen4_turbo:720x1280",
    prompt: "same prompt",
    generation: 0,
  };

  it("separates a 5 second purchase from a 10 second one", () => {
    // Without the duration in the key, asking for 10s after buying 5s would
    // "resume" the finished 5s job and hand back the short clip.
    expect(idempotencyKey({ ...base, variant: "5s" })).not.toBe(
      idempotencyKey({ ...base, variant: "10s" }),
    );
  });

  it("separates two providers running the same scene", () => {
    expect(idempotencyKey({ ...base, variant: "5s" })).not.toBe(
      idempotencyKey({ ...base, provider: "openai", variant: "5s" }),
    );
  });

  it("separates two resolutions, which ride along in the model id", () => {
    expect(idempotencyKey({ ...base, variant: "5s" })).not.toBe(
      idempotencyKey({
        ...base,
        model: "gen4_turbo:1080x1920",
        variant: "5s",
      }),
    );
  });

  it("still resumes the SAME purchase, so nothing is paid for twice", () => {
    expect(idempotencyKey({ ...base, variant: "5s" })).toBe(
      idempotencyKey({ ...base, variant: "5s" }),
    );
  });
});

// ---------------------------------------------------------------------------

describe("the recorded request describes the request that was actually sent", () => {
  /**
   * `sentRequest.durationSent` once logged 10 seconds for a call that put 6 in
   * the body: the field was computed with the provider's default rule instead
   * of this model's. Nothing failed, and the record was the only evidence of
   * what a $0.72 call had been - so it was evidence of a request nobody made.
   *
   * This test does not check `durationSent` against another calculation of the
   * same thing, which is how the bug survived. It checks it against the JSON
   * body the HTTP client hands to `fetch`.
   */
  async function captureCreate(modelId: string, requestedSeconds: number) {
    const [{ RunwayVideoProvider }, { toAbsolute, ensureProjectDirs }] = await Promise.all([
      import("@/providers/runway/runway-video-provider"),
      import("@/lib/paths"),
    ]);
    const fs = await import("node:fs");
    const path = await import("node:path");

    const projectId = `dur-${modelId.replace(/[^a-z0-9]/gi, "")}`;
    ensureProjectDirs(projectId);
    // A real PNG, because the adapter reads and re-encodes the keyframe.
    const keyframe = path.join(toAbsolute(`projects/${projectId}/images`), "kf.png");
    fs.writeFileSync(
      keyframe,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk" +
          "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    let sentBody: Record<string, unknown> = {};
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "task-1", status: "PENDING" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const provider = new RunwayVideoProvider({
        providerName: "runway",
        model: modelId,
        apiKey: "test-key",
        baseUrl: "https://example.invalid/v1",
        pricePerSecond: 0.12,
        size: "720x1280",
        timeoutMs: 5_000,
      });
      const job = await provider.createVideo({
        projectId,
        sceneId: "scene-1",
        model: modelId,
        prompt: "Animate this image. Locked camera.",
        negativePrompt: "",
        durationSeconds: requestedSeconds,
        width: 720,
        height: 1280,
        fps: 24,
        referenceImagePath: keyframe,
        outputPath: `projects/${projectId}/videos/out.mp4`,
      });
      return { job, sentBody };
    } finally {
      globalThis.fetch = original;
    }
  }

  it("logs the duration gen4.5 was actually asked for, per-second", async () => {
    // 6 seconds is sendable to gen4.5 and is what the scene-3 benchmark used.
    const { job, sentBody } = await captureCreate("gen4.5", 6);
    expect(sentBody.duration).toBe(6);
    expect(job.sentRequest?.durationSent).toBe(6);
    expect(job.sentRequest?.durationRequested).toBe(6);
  });

  it("logs gen4_turbo's quantised duration, not the one we asked for", async () => {
    // Runway bills gen4_turbo at 5 or 10 seconds only. Asking for 4 gets 5, and
    // the record has to show BOTH numbers or the 25% overspend is invisible.
    const { job, sentBody } = await captureCreate("gen4_turbo", 4);
    expect(sentBody.duration).toBe(5);
    expect(job.sentRequest?.durationRequested).toBe(4);
    expect(job.sentRequest?.durationSent).toBe(5);
  });

  it("never records a duration the body does not contain", async () => {
    // The bug in one line: these two must be the same number for every model,
    // whatever rule each one is billed by.
    for (const [modelId, seconds] of [
      ["gen4.5", 2],
      ["gen4.5", 10],
      ["gen4_turbo", 3],
      ["gen4_turbo", 9],
    ] as const) {
      const { job, sentBody } = await captureCreate(modelId, seconds);
      expect(job.sentRequest?.durationSent, `${modelId} @ ${seconds}s`).toBe(
        sentBody.duration,
      );
    }
  });

  it("prices the estimate on the billed duration, not the requested one", async () => {
    const { RunwayVideoProvider } = await import(
      "@/providers/runway/runway-video-provider"
    );
    const provider = new RunwayVideoProvider({
      providerName: "runway",
      model: "gen4_turbo",
      apiKey: "k",
      baseUrl: "https://example.invalid/v1",
      pricePerSecond: 0.05,
      size: "720x1280",
      timeoutMs: 1_000,
    });
    const estimate = await provider.estimateCost({
      projectId: "p",
      sceneId: "s",
      model: "gen4_turbo",
      prompt: "x",
      negativePrompt: "",
      durationSeconds: 4,
      width: 720,
      height: 1280,
      fps: 24,
      outputPath: "projects/p/videos/o.mp4",
    });
    // 5 billed seconds, not 4 requested.
    expect(estimate.amount).toBeCloseTo(0.25, 6);
    expect(estimate.detail).toContain("tính tiền 5s");
  });
});

// ---------------------------------------------------------------------------

describe("routing steps over a model that is under review", () => {
  const GEN45 = model({
    provider: "runway",
    modelId: "gen4.5:720x1280",
    price: 0.12,
    qualityRating: 10,
    consistencyRating: 10,
  });

  it("does not pick gen4.5 by itself, even when it scores best", () => {
    // BEST_QUALITY with gen4.5 rated 10 against gen4_turbo's 8: without the
    // pin rule this is exactly the choice that quietly spends $0.72 a scene.
    const decision = routeScene(
      [RUNWAY, GEN45],
      ctx({ strategy: "BEST_QUALITY", complexity: "LOW", characterCount: 1 }),
    );
    expect(decision.modelId).toBe("gen4_turbo:720x1280");
  });

  it("keeps it out of the fallback list too", () => {
    // A fallback is still an automatic choice; it just happens later.
    const decision = routeScene(
      [RUNWAY, GEN45],
      ctx({ strategy: "BEST_QUALITY", complexity: "LOW", characterCount: 1 }),
    );
    expect(decision.fallbacks.map((f) => f.modelId)).not.toContain("gen4.5:720x1280");
  });

  it("still hands it over when a person asks for it by name", () => {
    // The whole reason this is a separate tier: gen4.5 is the HIGH candidate,
    // and the next benchmark has to be able to reach it.
    const decision = routeScene(
      [RUNWAY, GEN45],
      ctx({
        strategy: "MANUAL",
        manualProvider: "runway",
        manualModel: "gen4.5:720x1280",
        complexity: "HIGH",
        characterCount: 3,
        durationSeconds: 6,
        usage: { seconds: 6, jobs: 1 },
      }),
    );
    expect(decision.modelId).toBe("gen4.5:720x1280");
    // Priced by gen4.5's per-second rule: 6s x $0.12, not quantised to 10.
    expect(decision.estimatedCost).toBeCloseTo(0.72, 6);
  });

  it("refuses rather than falling back to it when nothing else fits", () => {
    // The failure mode worth preventing: a HIGH scene where gen4_turbo is
    // excluded on evidence leaves gen4.5 as the only capable model. Using it
    // silently would defeat the point of marking it.
    //
    // Asserted on the CODE, not on the sentence. This used to match the phrase
    // "chưa được chốt" and broke when the refusal was reworded to name every
    // blocked model separately - a rewording that changed no behaviour at all.
    // The next test covers the wording; this one covers the refusal, and they
    // should not fail together for one reason.
    expect(() =>
      routeScene(
        [RUNWAY, GEN45],
        ctx({ strategy: "AUTO", complexity: "HIGH", characterCount: 3 }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "needs_explicit_pin" }) as unknown as Error,
    );
  });

  it("names the model and the reason when it refuses", () => {
    try {
      routeScene(
        [RUNWAY, GEN45],
        ctx({ strategy: "AUTO", complexity: "HIGH", characterCount: 3 }),
      );
      expect.unreachable("routing should have refused");
    } catch (err) {
      const e = err as { message: string; code: string };
      expect(e.code).toBe("needs_explicit_pin");
      expect(e.message).toContain("runway/gen4.5:720x1280");
      expect(e.message).toMatch(/chọn thủ công/);
    }
  });
});
