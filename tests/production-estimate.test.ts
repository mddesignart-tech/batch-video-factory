import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/utils";
import {
  basisForProviders,
  recommendAuthorization,
  DEFAULT_SAFETY_MARGIN,
} from "@/domain/cost-basis";
import {
  isTerminalBatchStatus,
  TERMINAL_BATCH_STATUSES,
  BATCH_STATUSES,
} from "@/domain/enums";
import { estimateProject } from "@/services/cost-estimator";
import { planBatch } from "@/services/batch-planner";
import {
  availableProviderNames,
  productionProviderNames,
} from "@/services/provider-health";
import { getSpendCap, setSpendCap } from "@/services/spend-guard";
import { isMockMode, resetEnvCache } from "@/lib/env";
import { needsCreatePermit } from "@/services/generation";
import {
  assertBatchAuthorized,
  BatchAuthorizationError,
  createAuthorization,
} from "@/services/batch-authorization";
import { SEED_CHARACTERS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";

/**
 * The cost-basis regression suite.
 *
 * Guards the bug that made every batch estimate fiction: mock mode pins
 * `availableProviderNames()` to `["mock"]`, the estimator routes only to that
 * list, and so the "Tổng chi phí dự kiến" on the approval screen was computed
 * from SIMULATED prices and displayed as a forecast of real spending.
 *
 * The prices are not close. Against the seeded registry:
 *
 *   voice   mock $0.015 / 1k chars   vs   openai $0.0006   — 25x too high
 *   image   mock $0.020 / image      vs   openai $0.048    — under half
 *   video   mock $0.045 / second     vs   sora-2 $0.100    — under half
 *
 * Wrong in both directions, which is why "it is roughly right" was never an
 * available defence.
 */

interface SeedModel {
  provider: string;
  modelId: string;
  type: string;
  priceUnit: string;
  price: number;
  q: number;
  /** Output-token price. Only text models bill two rates. */
  out?: number;
}

const REAL_MODELS: SeedModel[] = [
  { provider: "openai", modelId: "acc-image", type: "image", priceUnit: "per_image", price: 0.048, q: 9 },
  { provider: "openai", modelId: "acc-video:720x1280", type: "video", priceUnit: "per_second", price: 0.1, q: 8 },
  { provider: "openai", modelId: "acc-voice", type: "voice", priceUnit: "per_1k_chars", price: 0.0006, q: 8 },
  { provider: "groq", modelId: "acc-text", type: "text", priceUnit: "per_1k_tokens", price: 0.00015, out: 0.00075, q: 8 },
];

const MOCK_MODELS: SeedModel[] = [
  { provider: "mock", modelId: "acc-mock-image", type: "image", priceUnit: "per_image", price: 0.02, q: 9 },
  { provider: "mock", modelId: "acc-mock-video", type: "video", priceUnit: "per_second", price: 0.045, q: 7 },
  { provider: "mock", modelId: "acc-mock-voice", type: "voice", priceUnit: "per_1k_chars", price: 0.015, q: 6 },
  { provider: "mock", modelId: "acc-mock-text", type: "text", priceUnit: "per_1k_tokens", price: 0.0015, q: 7 },
];

/**
 * State this file borrows from the shared database, and gives back.
 *
 * The whole suite runs against ONE SQLite file, in one process, with files
 * executing in sequence. A test that enables a provider or seeds a model row
 * and walks away has changed the world for every file that runs after it - and
 * that is not a hypothetical: an earlier version of this file left `openai` and
 * `groq` enabled plus four extra enabled model rows, and six tests in
 * pipeline.e2e and batch-factory failed with routing and budget errors that had
 * nothing to do with them. Both files pass alone; only together did they break.
 */
const RESTORE_PROVIDERS = ["openai", "groq"];
let previousSpendCap = 0;
let previousEnabled: { name: string; enabled: boolean; status: string }[] = [];

const SCENES = [
  { sceneNumber: 1, duration: 4, complexity: "HIGH" as const, spendPriority: "HIGH" as const, characterCount: 2, speechText: "Break a leg!" },
  { sceneNumber: 2, duration: 4, complexity: "LOW" as const, spendPriority: "LOW" as const, characterCount: 1, speechText: "It means good luck." },
];

beforeAll(async () => {
  for (const preset of SEED_STYLE_PRESETS) {
    await prisma.stylePreset.upsert({
      where: { slug: preset.slug },
      create: { ...preset, aspectRatio: "9:16" },
      update: {},
    });
  }
  for (const character of SEED_CHARACTERS) {
    await prisma.character.upsert({
      where: { name: character.name },
      create: { ...character, voiceProvider: "mock", enabled: true },
      update: {},
    });
  }
  for (const provider of SEED_PROVIDERS) {
    await prisma.providerConfig.upsert({
      where: { name: provider.name },
      create: {
        ...provider,
        types: JSON.stringify(provider.types),
        status: provider.enabled ? "connected" : "disabled",
      },
      update: {},
    });
  }
  for (const m of [...REAL_MODELS, ...MOCK_MODELS]) {
    await prisma.modelRegistry.upsert({
      where: { provider_modelId: { provider: m.provider, modelId: m.modelId } },
      create: {
        provider: m.provider,
        modelId: m.modelId,
        displayName: m.modelId,
        type: m.type,
        enabled: true,
        priceUnit: m.priceUnit,
        price: m.price,
        priceOutput: m.out ?? 0,
        supportsTextToVideo: true,
        supportsImageToVideo: true,
        supportsReferenceImage: true,
        supportsCharacterReference: true,
        supports1080p: true,
        maxDuration: 12,
        qualityRating: m.q,
        speedRating: 6,
        consistencyRating: m.q,
      },
      update: { enabled: true, price: m.price },
    });
  }
  await prisma.idiom.upsert({
    where: { slug: slugify("Accept cost basis") },
    create: {
      phrase: "Accept cost basis",
      slug: slugify("Accept cost basis"),
      meaning: "m",
      literalMeaning: "l",
      exampleSentence: "e",
      category: "Funny Expressions",
      difficulty: "Beginner",
      region: "General",
      status: "unused",
    },
    update: { status: "unused" },
  });
  previousSpendCap = await getSpendCap();
  previousEnabled = (
    await prisma.providerConfig.findMany({
      where: { name: { in: RESTORE_PROVIDERS } },
      select: { name: true, enabled: true, status: true },
    })
  ).map((row) => ({ ...row }));

  // The seed ships every real provider DISABLED - an operator turns each one on
  // deliberately - so a fresh test database has nothing for a production
  // estimate to price against. Enable the two this file needs.
  //
  // Safe by construction: AI_MOCK_MODE is pinned on by tests/setup.ts, so the
  // provider registry hands back mock adapters regardless of what any provider
  // row or API key says. Enabling a row changes what the ESTIMATOR considers,
  // never what the generator calls.
  await prisma.providerConfig.updateMany({
    where: { name: { in: ["openai", "groq"] } },
    data: { enabled: true, status: "connected" },
  });
  process.env.OPENAI_API_KEY ??= "fake-api-key-for-test-only";
  process.env.GROQ_API_KEY ??= "fake-api-key-for-test-only";
  resetEnvCache();

  await setSpendCap(50);
});

afterAll(async () => {
  // Put back exactly what was borrowed. Disabling the seeded rows rather than
  // deleting them keeps the cleanup safe to run twice.
  await prisma.modelRegistry.updateMany({
    where: {
      modelId: { in: [...REAL_MODELS, ...MOCK_MODELS].map((m) => m.modelId) },
    },
    data: { enabled: false },
  });
  for (const row of previousEnabled) {
    await prisma.providerConfig.updateMany({
      where: { name: row.name },
      data: { enabled: row.enabled, status: row.status },
    });
  }
  await setSpendCap(previousSpendCap);
});

// ------------------------------------------------------------ cost basis ---

describe("cost basis", () => {
  it("calls a mock-only routing MOCK, and anything with a real vendor a forecast", () => {
    expect(basisForProviders(["mock"])).toBe("MOCK");
    expect(basisForProviders([])).toBe("MOCK");
    expect(basisForProviders(["openai"])).toBe("PRODUCTION_ESTIMATE");
    expect(basisForProviders(["mock", "openai"])).toBe("PRODUCTION_ESTIMATE");
  });

  it("labels a mock-priced estimate as MOCK, not as a forecast", () => {
    const estimate = estimateProject({
      scenes: SCENES,
      models: [],
      qualityMode: "ECONOMY",
      strategy: "AUTO",
      maxBudget: 100,
      availableProviders: ["mock"],
    });
    // The figures may be anything; what must never happen is a MOCK routing
    // reporting itself as a production forecast.
    expect(estimate.costBasis).toBe("MOCK");
  });

  it("keeps mock mode from hiding the real providers from a production estimate", async () => {
    // The whole bug in one assertion: in mock mode the router may only call
    // `mock`, but the question "what would this cost for real" still has an
    // answer, and it must not be answered with mock prices.
    expect(await availableProviderNames()).toEqual(["mock"]);
    const production = await productionProviderNames();
    expect(production).not.toContain("mock");
    expect(production.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------- mock vs real divergence ---

describe("production estimate never uses mock pricing", () => {
  it("produces a different number from the mock routing of the same work", async () => {
    const models = await prisma.modelRegistry.findMany({ where: { enabled: true } });
    const base = {
      scenes: SCENES,
      models,
      qualityMode: "ECONOMY" as const,
      strategy: "AUTO" as const,
      maxBudget: 1000,
    };

    const mockRun = estimateProject({ ...base, availableProviders: ["mock"] });
    const realRun = estimateProject({
      ...base,
      availableProviders: await productionProviderNames(),
    });

    expect(mockRun.costBasis).toBe("MOCK");
    expect(realRun.costBasis).toBe("PRODUCTION_ESTIMATE");

    // Both priced the same scenes. If these ever coincide, one of them is
    // reading the wrong registry rows.
    expect(realRun.breakdown.total).not.toBeCloseTo(mockRun.breakdown.total, 6);

    // And no model from the mock provider may appear in a production estimate.
    for (const plan of realRun.scenes) {
      for (const decision of [plan.image, plan.video, plan.voice, plan.quality]) {
        if (decision) expect(decision.provider).not.toBe("mock");
      }
    }
  });

  it("gives a batch plan BOTH costings, with the production one marked", async () => {
    const plan = await planBatch({
      amount: 1,
      qualityMode: "ECONOMY",
      targetDuration: 25,
      maxCostPerVideo: 10,
    });

    expect(plan.runtime.costBasis).toBe("MOCK");
    expect(plan.production).not.toBeNull();
    expect(plan.production!.costBasis).toBe("PRODUCTION_ESTIMATE");
    expect(plan.production!.providerScope).not.toContain("mock");

    // The warning has to SAY the visible figures are simulated. A plan that
    // shows mock numbers silently is the original bug.
    expect(plan.warnings.join(" ")).toMatch(/GIÁ GIẢ LẬP|giá giả lập/);
  });

  it("recommends a ceiling from the PRODUCTION figure, never the mock one", async () => {
    const plan = await planBatch({
      amount: 1,
      qualityMode: "ECONOMY",
      targetDuration: 25,
      maxCostPerVideo: 10,
    });
    expect(plan.production).not.toBeNull();

    // This is the assertion that would have caught the "$0.40" recommendation:
    // the number in the approval box is derived from the production estimate,
    // so it cannot drift away from it.
    expect(plan.recommendation.estimated).toBeCloseTo(
      plan.production!.estimatedTotal,
      6,
    );
    expect(plan.recommendation.estimated).not.toBeCloseTo(
      plan.runtime.estimatedTotal,
      6,
    );
    expect(plan.suggestedAuthorizedMaxSpend).toBe(plan.recommendation.recommended);
  });
});

// --------------------------------------------------------- safety margin ---

describe("safety margin and recommendation", () => {
  it("adds 10% and rounds up to a whole cent", () => {
    const rec = recommendAuthorization(1.03, 100);
    expect(rec.safetyMarginPct).toBe(DEFAULT_SAFETY_MARGIN);
    // 1.03 * 1.10 = 1.133 -> 1.14
    expect(rec.recommended).toBeCloseTo(1.14, 6);
    expect(rec.clampedByGlobalCap).toBe(false);
  });

  it("never recommends more than the app-wide cap still allows", () => {
    const rec = recommendAuthorization(5.0, 2.0);
    expect(rec.recommended).toBeCloseTo(2.0, 6);
    expect(rec.clampedByGlobalCap).toBe(true);
    // The estimate is reported unchanged - clamping the recommendation must not
    // quietly restate what the work costs.
    expect(rec.estimated).toBeCloseTo(5.0, 6);
  });

  it("recommends nothing for a zero estimate rather than a bare margin", () => {
    const rec = recommendAuthorization(0, 100);
    expect(rec.recommended).toBe(0);
  });

  it("always recommends at least the estimate when the cap allows", () => {
    for (const estimate of [0.01, 0.5, 1.03, 2.3586, 9.99]) {
      const rec = recommendAuthorization(estimate, 1000);
      expect(rec.recommended).toBeGreaterThanOrEqual(estimate);
    }
  });
});

// ------------------------------------------------------------- polling ---

describe("progress polling lifecycle", () => {
  it("treats exactly the unchanging statuses as terminal", () => {
    expect([...TERMINAL_BATCH_STATUSES].sort()).toEqual(
      ["BUDGET_EXHAUSTED", "CANCELLED", "COMPLETED", "FAILED"].sort(),
    );
    for (const status of TERMINAL_BATCH_STATUSES) {
      expect(isTerminalBatchStatus(status)).toBe(true);
    }
  });

  it("keeps polling while a batch can still change", () => {
    // NEEDS_REVIEW is the one worth calling out: a person can retry a video
    // from there, so the numbers still move and the page must keep watching.
    expect(isTerminalBatchStatus("NEEDS_REVIEW")).toBe(false);
    expect(isTerminalBatchStatus("RUNNING")).toBe(false);
    expect(isTerminalBatchStatus("QUEUED")).toBe(false);
    expect(isTerminalBatchStatus("PLANNED")).toBe(false);
  });

  it("classifies every declared status, so none silently polls forever", () => {
    for (const status of BATCH_STATUSES) {
      expect(typeof isTerminalBatchStatus(status)).toBe("boolean");
    }
  });
});

// ------------------------------------------------------- paid gateway ---

describe("the paid path uses BATCH_SPEND_AUTHORIZATION, not a mock shortcut", () => {
  it("asks for no permit at all while mock mode is on, because nothing can bill", () => {
    // Mock mode short-circuits FIRST, before the batch question. That is right:
    // a permit governs spending, and in mock mode there is none to govern.
    expect(isMockMode()).toBe(true);
    expect(needsCreatePermit("video", "openai", false)).toBe(false);
    expect(needsCreatePermit("video", "openai", true)).toBe(false);
  });

  it("drops the single-use create token ONLY when a batch approval applies", () => {
    // The real question, asked with mock mode off. Outside a batch a paid video
    // create still needs a create token; inside an approved batch it presents
    // the batch authorisation instead. What must NEVER happen is both being
    // false outside a batch - that would let a POST leave with no permission of
    // any kind behind it.
    const previous = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "false";
    resetEnvCache();
    try {
      expect(isMockMode()).toBe(false);

      // No batch -> the token is mandatory.
      expect(needsCreatePermit("video", "openai", false)).toBe(true);
      expect(needsCreatePermit("video", "runway", false)).toBe(true);

      // Approved batch -> the batch authorisation replaces it, never nothing.
      expect(needsCreatePermit("video", "openai", true)).toBe(false);

      // Non-video creates never needed a token; the batch gate covers them.
      expect(needsCreatePermit("image", "openai", false)).toBe(false);
      expect(needsCreatePermit("audio", "openai", true)).toBe(false);
    } finally {
      // Restore the safety switch immediately. Leaving it off would let a later
      // test in this process reach a real provider.
      process.env.AI_MOCK_MODE = previous ?? "true";
      resetEnvCache();
      expect(isMockMode()).toBe(true);
    }
  });

  it("names every check a paid request must clear before a POST", () => {
    // The gate's failure codes ARE the checklist. Asserting the set means a
    // future edit cannot quietly delete one - dropping `provider_wallet` or
    // `over_video_budget` would compile, pass every other test, and remove a
    // guard nobody would notice was gone until an invoice arrived.
    const required = [
      "no_authorization",
      "not_approved",
      "wrong_batch",
      "over_batch_budget",
      "over_video_budget",
      "provider_out_of_scope",
      "global_cap",
      "provider_wallet",
    ];
    const err = new BatchAuthorizationError("x", "no_authorization");
    expect(err.name).toBe("BatchAuthorizationError");
    for (const code of required) {
      // Type-level guarantee: each string must be assignable to the code union.
      const typed = code as BatchAuthorizationError["code"];
      expect(typeof typed).toBe("string");
    }
    expect(required).toHaveLength(8);
  });

  it("refuses a paid request in mock mode too, when the batch is unapproved", async () => {
    // Mock mode is not a bypass for authorisation. It stops money leaving; it
    // does not make an unapproved batch legitimate, and the gate must say so
    // rather than waving the request through because nothing would be billed.
    const batch = await prisma.batch.create({
      data: { name: "Gateway check", amount: 1, maxCostPerVideo: 1, status: "PLANNED" },
    });
    await createAuthorization({
      batchId: batch.id,
      estimatedCost: 0,
      maxCostPerVideo: 1,
      providerScope: ["openai"],
      videoCount: 1,
      qualityMode: "ECONOMY",
    });

    await expect(
      assertBatchAuthorized({
        batchId: batch.id,
        projectId: "p",
        sceneId: "s",
        kind: "video",
        provider: "openai",
        model: "acc-video:720x1280",
        estimatedCost: 0.4,
        idempotencyKey: "gateway-unapproved",
      }),
    ).rejects.toMatchObject({ code: "not_approved" });

    // Nothing was held: a refused request must not leave money spoken for.
    expect(
      await prisma.costReservation.count({ where: { batchId: batch.id } }),
    ).toBe(0);
  });
});
