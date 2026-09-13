import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "@prisma/client";
import {
  estimateAllModes,
  estimateProject,
  shouldEvaluateQuality,
  shouldGenerateKeyframe,
  type EstimateInput,
  type PlannedSceneInput,
} from "@/services/cost-estimator";
import { checkBudget, planBatchBudget } from "@/services/budget";
import { costForModel, expectedRetryMultiplier, valueIndex } from "@/services/pricing";

function model(over: Partial<ModelRegistry> & { modelId: string; type: string }) {
  return {
    id: over.modelId,
    provider: "mock",
    displayName: over.modelId,
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

const MODELS: ModelRegistry[] = [
  model({ modelId: "text-1", type: "text", priceUnit: "per_1k_tokens", price: 0.002 }),
  model({
    modelId: "img-cheap",
    type: "image",
    priceUnit: "per_image",
    price: 0.01,
    qualityRating: 4,
    consistencyRating: 4,
  }),
  model({
    modelId: "img-pro",
    type: "image",
    priceUnit: "per_image",
    price: 0.06,
    qualityRating: 9,
    consistencyRating: 9,
  }),
  model({
    modelId: "vid-cheap",
    type: "video",
    price: 0.02,
    qualityRating: 4,
    consistencyRating: 4,
    maxDuration: 8,
  }),
  model({
    modelId: "vid-std",
    type: "video",
    price: 0.08,
    qualityRating: 7,
    consistencyRating: 7,
  }),
  model({
    modelId: "vid-pro",
    type: "video",
    price: 0.25,
    qualityRating: 10,
    consistencyRating: 10,
  }),
  model({
    modelId: "voice-1",
    type: "voice",
    priceUnit: "per_1k_chars",
    price: 0.02,
  }),
  model({
    modelId: "qual-1",
    type: "quality",
    priceUnit: "per_job",
    price: 0.004,
  }),
];

const SCENES: PlannedSceneInput[] = [
  { sceneNumber: 1, duration: 3, complexity: "MEDIUM", spendPriority: "HIGH", characterCount: 1, speechText: "Break a leg!" },
  { sceneNumber: 2, duration: 5.5, complexity: "MEDIUM", spendPriority: "NORMAL", characterCount: 1, speechText: "Wait, you want me to do THAT?" },
  { sceneNumber: 3, duration: 5.5, complexity: "HIGH", spendPriority: "NORMAL", characterCount: 2, speechText: "I am VERY prepared." },
  { sceneNumber: 4, duration: 5, complexity: "HIGH", spendPriority: "HIGH", characterCount: 2, speechText: "That is NOT what I meant." },
  { sceneNumber: 5, duration: 3.5, complexity: "LOW", spendPriority: "LOW", characterCount: 2, speechText: "It just means good luck." },
  { sceneNumber: 6, duration: 3, complexity: "LOW", spendPriority: "LOW", characterCount: 2, speechText: "Break a leg on your interview!" },
];

const base: Omit<EstimateInput, "qualityMode"> = {
  scenes: SCENES,
  models: MODELS,
  strategy: "AUTO",
  maxBudget: 100,
  availableProviders: ["mock"],
  needs1080p: true,
};

describe("price maths", () => {
  it("prices per second", () => {
    expect(costForModel(MODELS[3]!, { seconds: 5 })).toBeCloseTo(0.1, 4);
  });

  it("prices per 1k characters", () => {
    const voice = MODELS.find((m) => m.type === "voice")!;
    expect(costForModel(voice, { characters: 500 })).toBeCloseTo(0.01, 4);
  });

  it("treats a free model as infinitely good value rather than dividing by zero", () => {
    const free = model({ modelId: "free", type: "video", price: 0 });
    expect(Number.isFinite(valueIndex(free, 0))).toBe(true);
    expect(valueIndex(free, 0)).toBeGreaterThan(0);
  });

  it("budgets more retry headroom in QUALITY than in ECONOMY", () => {
    expect(expectedRetryMultiplier("QUALITY", 0.9)).toBeGreaterThan(
      expectedRetryMultiplier("ECONOMY", 0.9),
    );
  });
});

describe("stage planning", () => {
  it("skips keyframes for simple single-character scenes in ECONOMY only", () => {
    expect(shouldGenerateKeyframe("ECONOMY", "LOW", 1)).toBe(false);
    expect(shouldGenerateKeyframe("ECONOMY", "HIGH", 1)).toBe(true);
    expect(shouldGenerateKeyframe("ECONOMY", "LOW", 2)).toBe(true);
    expect(shouldGenerateKeyframe("BALANCED", "LOW", 1)).toBe(true);
  });

  it("never runs quality evaluation in ECONOMY, always in QUALITY", () => {
    expect(shouldEvaluateQuality("ECONOMY", "HIGH")).toBe(false);
    expect(shouldEvaluateQuality("QUALITY", "LOW")).toBe(true);
    expect(shouldEvaluateQuality("BALANCED", "HIGH")).toBe(true);
    expect(shouldEvaluateQuality("BALANCED", "LOW")).toBe(false);
  });
});

describe("project estimation", () => {
  it("produces a full per-stage breakdown that sums to the total", () => {
    const estimate = estimateProject({ ...base, qualityMode: "BALANCED" });
    const { breakdown } = estimate;
    const sum =
      breakdown.text +
      breakdown.image +
      breakdown.video +
      breakdown.voice +
      breakdown.upscale +
      breakdown.quality +
      breakdown.retries;
    expect(breakdown.total).toBeCloseTo(sum, 3);
    expect(breakdown.total).toBeGreaterThan(0);
  });

  it("includes a retry allowance rather than quoting a best case", () => {
    const estimate = estimateProject({ ...base, qualityMode: "BALANCED" });
    expect(estimate.breakdown.retries).toBeGreaterThan(0);
  });

  it("plans every scene", () => {
    const estimate = estimateProject({ ...base, qualityMode: "BALANCED" });
    expect(estimate.scenes).toHaveLength(SCENES.length);
    for (const scene of estimate.scenes) expect(scene.video).not.toBeNull();
  });

  it("orders the three modes cheapest to most expensive", () => {
    const modes = estimateAllModes(base);
    expect(modes.ECONOMY.breakdown.total).toBeLessThan(
      modes.BALANCED.breakdown.total,
    );
    expect(modes.BALANCED.breakdown.total).toBeLessThan(
      modes.QUALITY.breakdown.total,
    );
  });

  it("spends more on the punchline scene than on the explanation scene", () => {
    const estimate = estimateProject({ ...base, qualityMode: "BALANCED" });
    const punchline = estimate.scenes.find((s) => s.sceneNumber === 4)!;
    const explanation = estimate.scenes.find((s) => s.sceneNumber === 5)!;
    expect(punchline.estimatedCost).toBeGreaterThan(explanation.estimatedCost);
  });

  it("reports withinBudget=false when the ceiling is too low", () => {
    const estimate = estimateProject({
      ...base,
      qualityMode: "QUALITY",
      maxBudget: 0.05,
    });
    expect(estimate.withinBudget).toBe(false);
  });
});

describe("checkBudget", () => {
  it("allows an estimate at or under the ceiling", () => {
    expect(checkBudget(9.99, 10).allowed).toBe(true);
    expect(checkBudget(10, 10).allowed).toBe(true);
  });

  it("blocks and explains when over, with concrete ways down", () => {
    const check = checkBudget(14.5, 10);
    expect(check.allowed).toBe(false);
    expect(check.overBy).toBeCloseTo(4.5, 2);
    expect(check.message).toContain("vượt ngân sách");
    expect(check.suggestions.length).toBeGreaterThan(2);
  });
});

describe("batch budget optimisation", () => {
  const costPerVideo = {
    ECONOMY: 0.4,
    BALANCED: 0.8,
    QUALITY: 2.0,
    CUSTOM: 0.8,
  };

  it("does not simply run everything in the cheapest mode", () => {
    const plan = planBatchBudget({
      videoCount: 50,
      totalBudget: 40,
      costPerVideo,
    });
    expect(plan.assignments.ECONOMY).toBe(0);
    expect(plan.feasibleCount).toBe(50);
  });

  it("spends leftover budget upgrading videos to QUALITY", () => {
    const plan = planBatchBudget({
      videoCount: 10,
      totalBudget: 20,
      costPerVideo,
    });
    expect(plan.assignments.QUALITY).toBeGreaterThan(0);
    expect(plan.estimatedTotal).toBeLessThanOrEqual(20);
  });

  it("never exceeds the total budget", () => {
    for (const budget of [1, 5, 12, 40, 100]) {
      const plan = planBatchBudget({
        videoCount: 50,
        totalBudget: budget,
        costPerVideo,
      });
      expect(plan.estimatedTotal).toBeLessThanOrEqual(budget + 1e-6);
    }
  });

  it("says plainly how many videos a too-small budget can cover", () => {
    const plan = planBatchBudget({
      videoCount: 50,
      totalBudget: 4,
      costPerVideo,
    });
    expect(plan.feasibleCount).toBeLessThan(50);
    expect(plan.message).toContain("Ngân sách");
  });

  it("runs the whole batch at BALANCED when everything is free (mock mode)", () => {
    const plan = planBatchBudget({
      videoCount: 25,
      totalBudget: 0,
      costPerVideo: { ECONOMY: 0, BALANCED: 0, QUALITY: 0, CUSTOM: 0 },
    });
    expect(plan.assignments.BALANCED).toBe(25);
    expect(plan.estimatedTotal).toBe(0);
  });
});
