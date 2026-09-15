import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/utils";
import { decideMotion, keyframeRequired } from "@/domain/local-motion";
import {
  SEED_CHARACTERS,
  SEED_PROVIDERS,
  SEED_STYLE_PRESETS,
} from "@/data/seed-config";
import {
  approveAuthorization,
  assertBatchAuthorized,
  BatchAuthorizationError,
  closeAuthorization,
  createAuthorization,
  resumeAuthorization,
} from "@/services/batch-authorization";
import {
  commit,
  release,
  reservationLedger,
  reserve,
  ReservationError,
} from "@/services/cost-reservation";
import { planBatch } from "@/services/batch-planner";
import {
  batchProgress,
  cancelBatch,
  resumeBatch,
  savePlan,
  settleBatchIfDone,
  storedPlan,
} from "@/services/batch-runner";
import { setSpendCap } from "@/services/spend-guard";
import { setProviderBudget } from "@/services/provider-budget";
import { runJob } from "@/jobs/handlers";
import { claimNext, completeJob, failJob } from "@/jobs/queue";

/**
 * Batch Video Factory V1 - the acceptance test.
 *
 * Everything here runs in mock mode against a throwaway database, so it costs
 * nothing and contacts nobody. What it proves is the part that is expensive to
 * get wrong:
 *
 *   - a plan on its own cannot spend
 *   - the batch ceiling holds, including against CONCURRENT requests
 *   - the per-video ceiling holds, and stops one video rather than the batch
 *   - each provider's wallet is checked separately
 *   - the same request never reserves or buys twice
 *   - cancel sends nothing further; resume repeats nothing
 *
 * The concurrency case is the one worth stating out loud. Two jobs that each
 * check "is there room?" and then spend will both be right and the batch will
 * still overspend, because they were right about the same money. That is why
 * reservations exist, and why it is tested by running the checks interleaved
 * rather than one after the other.
 */

const BATCH_IDIOMS = [
  "Batch factory alpha",
  "Batch factory beta",
  "Batch factory gamma",
];

let idiomIds: string[] = [];

/** A priced mock registry, so budgets have something to bite on. */
async function seedPricedModels(): Promise<void> {
  const rows = [
    { modelId: "bf-text", type: "text", priceUnit: "per_1k_tokens", price: 0.001, priceOutput: 0.002 },
    { modelId: "bf-image", type: "image", priceUnit: "per_image", price: 0.02 },
    { modelId: "bf-video", type: "video", priceUnit: "per_second", price: 0.05 },
    { modelId: "bf-voice", type: "voice", priceUnit: "per_1k_chars", price: 0.01 },
    // BALANCED scores the scenes a viewer judges the video on, so the registry
    // needs a quality model or those scenes fail to route for a reason that has
    // nothing to do with what this file is testing.
    { modelId: "bf-quality", type: "quality", priceUnit: "per_job", price: 0.004 },
  ];
  for (const row of rows) {
    await prisma.modelRegistry.upsert({
      where: { provider_modelId: { provider: "mock", modelId: row.modelId } },
      create: {
        provider: "mock",
        modelId: row.modelId,
        displayName: row.modelId,
        type: row.type,
        enabled: true,
        priceUnit: row.priceUnit,
        price: row.price,
        priceOutput: row.priceOutput ?? 0,
        supportsTextToVideo: true,
        supportsImageToVideo: true,
        supportsReferenceImage: true,
        supportsCharacterReference: true,
        supports1080p: true,
        maxDuration: 10,
        qualityRating: 6,
        speedRating: 6,
        consistencyRating: 6,
      },
      update: { enabled: true, price: row.price },
    });
  }
}

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
  await seedPricedModels();

  idiomIds = [];
  for (const phrase of BATCH_IDIOMS) {
    const idiom = await prisma.idiom.upsert({
      where: { slug: slugify(phrase) },
      create: {
        phrase,
        slug: slugify(phrase),
        meaning: "A test idiom",
        literalMeaning: "Something absurd happens on screen.",
        exampleSentence: `${phrase} on your interview!`,
        category: "Funny Expressions",
        difficulty: "Beginner",
        region: "General",
        status: "unused",
      },
      update: { status: "unused" },
    });
    idiomIds.push(idiom.id);
  }

  // A cap the batch ceilings below fit inside, so these tests exercise the
  // BATCH limit rather than tripping the app-wide one first.
  await setSpendCap(5);
});

/** A batch with a stored plan and a DRAFT (non-spending) authorisation. */
async function makePlannedBatch(opts: {
  name: string;
  maxCostPerVideo: number;
  amount?: number;
}) {
  const batch = await prisma.batch.create({
    data: {
      name: opts.name,
      amount: opts.amount ?? 3,
      qualityMode: "BALANCED",
      targetDuration: 25,
      maxCostPerVideo: opts.maxCostPerVideo,
      maxBudget: 0,
      status: "PLANNED",
    },
  });

  const plan = await planBatch(
    {
      idiomIds,
      amount: opts.amount ?? 3,
      qualityMode: "BALANCED",
      targetDuration: 25,
      maxCostPerVideo: opts.maxCostPerVideo,
    },
    batch.id,
  );
  await savePlan(batch.id, plan);
  await createAuthorization({
    batchId: batch.id,
    estimatedCost: plan.estimatedTotal,
    maxCostPerVideo: plan.maxCostPerVideo,
    providerScope: plan.providerScope,
    videoCount: plan.runnableCount,
    qualityMode: "BALANCED",
  });
  return { batch, plan };
}

function gateInput(over: Partial<Parameters<typeof assertBatchAuthorized>[0]>) {
  return {
    batchId: "",
    projectId: "p1",
    sceneId: "s1",
    kind: "video",
    provider: "mock",
    model: "bf-video",
    estimatedCost: 0.1,
    idempotencyKey: "key-1",
    ...over,
  } as Parameters<typeof assertBatchAuthorized>[0];
}

// ---------------------------------------------------------- local motion ---

describe("local motion vs video AI", () => {
  it("animates simple low-priority scenes locally instead of buying a clip", () => {
    const decision = decideMotion({
      qualityMode: "BALANCED",
      complexity: "LOW",
      spendPriority: "LOW",
      characterCount: 1,
    });
    expect(decision.source).toBe("LOCAL_MOTION");
    expect(decision.reason.length).toBeGreaterThan(10);
  });

  it("saves on the explanation beat even though it scores MEDIUM", () => {
    // The case that decides whether this feature does anything at all. Real
    // scripts never produce a LOW-complexity scene - two characters in frame
    // clears MEDIUM on its own - so a rule keyed on complexity would fire on
    // nothing. The explanation and outro beats are marked LOW spend priority,
    // and that is the signal that actually separates them.
    expect(
      decideMotion({
        qualityMode: "BALANCED",
        complexity: "MEDIUM",
        spendPriority: "LOW",
        characterCount: 2,
      }).source,
    ).toBe("LOCAL_MOTION");
  });

  it("always buys a clip for the hook and the punchline in BALANCED", () => {
    expect(
      decideMotion({
        qualityMode: "BALANCED",
        complexity: "LOW",
        spendPriority: "HIGH",
        characterCount: 1,
      }).source,
    ).toBe("AI_VIDEO");
  });

  it("buys a clip for a busy action scene even in ECONOMY", () => {
    // The mode may not overrule the scene. A two-character HIGH beat cannot be
    // faked with a push-in, and economising there is how a cheap video becomes
    // an unusable one.
    expect(
      decideMotion({
        qualityMode: "ECONOMY",
        complexity: "HIGH",
        spendPriority: "LOW",
        characterCount: 2,
      }).source,
    ).toBe("AI_VIDEO");
  });

  it("keeps ECONOMY off video models for everything else", () => {
    expect(
      decideMotion({
        qualityMode: "ECONOMY",
        complexity: "MEDIUM",
        spendPriority: "HIGH",
        characterCount: 1,
      }).source,
    ).toBe("LOCAL_MOTION");
  });

  it("makes the keyframe mandatory whenever motion comes from a still", () => {
    // The trap: ECONOMY skips keyframes for simple scenes, and those are
    // exactly the scenes routed to LOCAL_MOTION. Both rules are right alone and
    // together they would leave the scene with no media at all.
    expect(keyframeRequired("LOCAL_MOTION", false)).toBe(true);
    expect(keyframeRequired("AI_VIDEO", false)).toBe(false);
    expect(keyframeRequired("AI_VIDEO", true)).toBe(true);
  });
});

// ------------------------------------------------------------- the plan ---

describe("batch plan", () => {
  it("prices three videos without spending anything", async () => {
    const before = await prisma.costEntry.count();
    const { plan } = await makePlannedBatch({
      name: "Plan only",
      maxCostPerVideo: 2.5,
    });

    expect(plan.videos).toHaveLength(3);
    expect(plan.runnableCount).toBe(3);
    for (const video of plan.videos) {
      expect(video.sceneCount).toBeGreaterThanOrEqual(4);
      expect(video.localMotionScenes + video.aiVideoScenes).toBe(video.sceneCount);
      expect(video.estimatedCost).toBeGreaterThan(0);
    }
    expect(plan.estimatedTotal).toBeGreaterThan(0);

    // Planning writes no ledger rows. If it did, "free to plan" would be false.
    expect(await prisma.costEntry.count()).toBe(before);
  });

  it("marks a video over the per-video ceiling instead of hiding it", async () => {
    const { plan } = await makePlannedBatch({
      name: "Tight per-video",
      maxCostPerVideo: 0.01,
    });
    expect(plan.runnableCount).toBe(0);
    expect(plan.blockedCount).toBe(3);
    for (const video of plan.videos) {
      expect(video.status).toBe("OVER_VIDEO_BUDGET");
    }
  });

  it("suggests a ceiling with headroom but never above the app-wide remainder", async () => {
    const { plan } = await makePlannedBatch({
      name: "Ceiling suggestion",
      maxCostPerVideo: 2.5,
    });

    // The app-wide remainder is the hard part of the contract: the suggestion
    // may never exceed it, because authorising more than the app has left would
    // create a permission that cannot be honoured.
    expect(plan.suggestedAuthorizedMaxSpend).toBeLessThanOrEqual(
      plan.globalCap.remaining,
    );

    if (plan.estimatedTotal <= plan.globalCap.remaining) {
      // Room to spare: the suggestion carries headroom over the forecast, so a
      // batch does not halt on the last scene over a few cents of rounding.
      expect(plan.suggestedAuthorizedMaxSpend).toBeGreaterThanOrEqual(
        plan.estimatedTotal,
      );
    } else {
      // The forecast already exceeds what is left. The suggestion is then the
      // remainder itself - NOT the forecast - and the plan says so in its
      // warnings rather than quietly proposing money that does not exist.
      expect(plan.suggestedAuthorizedMaxSpend).toBeCloseTo(
        plan.globalCap.remaining,
        6,
      );
      expect(plan.warnings.join(" ")).toContain("hạn mức toàn");
    }
  });

  it("stores the approved plan verbatim so it cannot drift", async () => {
    const { batch, plan } = await makePlannedBatch({
      name: "Frozen plan",
      maxCostPerVideo: 2.5,
    });
    const reloaded = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });
    const stored = storedPlan(reloaded);
    expect(stored?.videos).toHaveLength(plan.videos.length);
    expect(stored?.estimatedTotal).toBeCloseTo(plan.estimatedTotal, 6);
  });
});

// ------------------------------------------------------- authorisation ---

describe("batch spend authorization", () => {
  it("refuses every paid request while the approval is only a DRAFT", async () => {
    const { batch } = await makePlannedBatch({
      name: "Draft gate",
      maxCostPerVideo: 2.5,
    });

    await expect(
      assertBatchAuthorized(gateInput({ batchId: batch.id })),
    ).rejects.toThrow(BatchAuthorizationError);

    expect(await prisma.costReservation.count({ where: { batchId: batch.id } })).toBe(0);
  });

  it("refuses a batch with no authorization at all", async () => {
    const orphan = await prisma.batch.create({
      data: { name: "No auth", amount: 1, status: "PLANNED" },
    });
    await expect(
      assertBatchAuthorized(gateInput({ batchId: orphan.id })),
    ).rejects.toMatchObject({ code: "no_authorization" });
  });

  it("will not authorise more than the app-wide cap still allows", async () => {
    const { batch } = await makePlannedBatch({
      name: "Over global cap",
      maxCostPerVideo: 2.5,
    });
    await expect(
      approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 9999 }),
    ).rejects.toMatchObject({ code: "global_cap" });
  });

  it("refuses a provider that was not in the approved scope", async () => {
    const { batch } = await makePlannedBatch({
      name: "Scope",
      maxCostPerVideo: 2.5,
    });
    // Approve a scope that names only "mock".
    await prisma.batchAuthorization.update({
      where: { batchId: batch.id },
      data: { providerScopeJson: JSON.stringify(["mock"]) },
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 1 });

    await expect(
      assertBatchAuthorized(
        gateInput({ batchId: batch.id, provider: "runway", model: "gen4_turbo" }),
      ),
    ).rejects.toMatchObject({ code: "provider_out_of_scope" });
  });

  it("checks each provider's own wallet rather than one pooled balance", async () => {
    const { batch } = await makePlannedBatch({
      name: "Wallets",
      maxCostPerVideo: 2.5,
    });
    await prisma.batchAuthorization.update({
      where: { batchId: batch.id },
      data: { providerScopeJson: JSON.stringify(["mock", "runway"]) },
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 2 });

    // Runway's own wallet is empty. The batch ceiling has plenty left, and the
    // app-wide cap has plenty left - neither of those is money at Runway.
    await setProviderBudget({
      provider: "runway",
      available: 0,
      unit: "credits",
      usdPerUnit: 0.01,
    });

    await expect(
      assertBatchAuthorized(
        gateInput({
          batchId: batch.id,
          provider: "runway",
          model: "gen4_turbo",
          estimatedCost: 0.25,
          idempotencyKey: "wallet-key",
        }),
      ),
    ).rejects.toThrow(/runway/i);

    // Restore, so later tests are not affected by this one.
    await setProviderBudget({
      provider: "runway",
      available: 1000,
      unit: "credits",
      usdPerUnit: 0.01,
    });
  });
});

// ------------------------------------------------- reservation and money ---

describe("cost reservation", () => {
  it("stops a second request from promising money the first already promised", async () => {
    const { batch } = await makePlannedBatch({
      name: "Concurrency",
      maxCostPerVideo: 2.5,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 1 });

    // Job A holds $0.60 of a $1.00 ceiling.
    await reserve(
      {
        batchId: batch.id,
        idempotencyKey: "job-a",
        kind: "video",
        provider: "mock",
        model: "bf-video",
        estimatedCost: 0.6,
      },
      1,
    );

    // Job B asks while job A is still in flight. Reading committed spend would
    // say $0.00 and wave it through; reading the RESERVATION says $0.60 is
    // already spoken for, and $0.60 + $0.60 does not fit in $1.00.
    await expect(
      reserve(
        {
          batchId: batch.id,
          idempotencyKey: "job-b",
          kind: "video",
          provider: "mock",
          model: "bf-video",
          estimatedCost: 0.6,
        },
        1,
      ),
    ).rejects.toThrow(ReservationError);

    const ledger = await reservationLedger(batch.id, 1);
    expect(ledger.reserved).toBeCloseTo(0.6, 6);
    expect(ledger.committed).toBe(0);
    expect(ledger.available).toBeCloseTo(0.4, 6);
  });

  it("holds the ceiling when many requests arrive at once, not one after another", async () => {
    const { batch } = await makePlannedBatch({
      name: "Parallel reserve",
      maxCostPerVideo: 2.5,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 1 });

    // Ten requests of $0.15 against a $1.00 ceiling, fired WITHOUT awaiting in
    // between. Six fit. Checking them one at a time would pass even with a
    // read-then-write race, because the race needs two checks in flight at the
    // same moment - which is exactly what Promise.all produces.
    const attempts = Array.from({ length: 10 }, (_, i) =>
      reserve(
        {
          batchId: batch.id,
          idempotencyKey: `par-${i}`,
          kind: "video",
          provider: "mock",
          model: "bf-video",
          estimatedCost: 0.15,
        },
        1,
      ).then(
        () => "ok" as const,
        () => "refused" as const,
      ),
    );
    const outcomes = await Promise.all(attempts);

    const accepted = outcomes.filter((o) => o === "ok").length;
    expect(accepted).toBe(6);

    const ledger = await reservationLedger(batch.id, 1);
    expect(ledger.used).toBeLessThanOrEqual(1);
    expect(ledger.used).toBeCloseTo(0.9, 6);
  });

  it("reserves once for one request, however many times it is asked", async () => {
    const { batch } = await makePlannedBatch({
      name: "Idempotent reserve",
      maxCostPerVideo: 2.5,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 1 });

    const key = "repeat-key";
    const first = await reserve(
      {
        batchId: batch.id,
        idempotencyKey: key,
        kind: "video",
        provider: "mock",
        model: "bf-video",
        estimatedCost: 0.3,
      },
      1,
    );
    expect(first.reused).toBe(false);

    // A restart, a refresh, a resume: all recompute the same key.
    for (let i = 0; i < 3; i++) {
      const again = await reserve(
        {
          batchId: batch.id,
          idempotencyKey: key,
          kind: "video",
          provider: "mock",
          model: "bf-video",
          estimatedCost: 0.3,
        },
        1,
      );
      expect(again.reused).toBe(true);
    }

    expect(
      await prisma.costReservation.count({ where: { batchId: batch.id } }),
    ).toBe(1);
    expect((await reservationLedger(batch.id, 1)).reserved).toBeCloseTo(0.3, 6);
  });

  it("replaces the held estimate with the real invoice on commit", async () => {
    const { batch } = await makePlannedBatch({
      name: "Commit",
      maxCostPerVideo: 2.5,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 1 });

    await reserve(
      {
        batchId: batch.id,
        idempotencyKey: "commit-key",
        kind: "video",
        provider: "mock",
        model: "bf-video",
        estimatedCost: 0.4,
      },
      1,
    );
    await commit("commit-key", 0.31);

    const ledger = await reservationLedger(batch.id, 1);
    expect(ledger.committed).toBeCloseTo(0.31, 6);
    expect(ledger.reserved).toBe(0);
    expect(ledger.available).toBeCloseTo(0.69, 6);

    const auth = await prisma.batchAuthorization.findUniqueOrThrow({
      where: { batchId: batch.id },
    });
    expect(auth.actualSpend).toBeCloseTo(0.31, 6);
  });

  it("gives the money back only when the request never left the machine", async () => {
    const { batch } = await makePlannedBatch({
      name: "Release",
      maxCostPerVideo: 2.5,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 1 });

    await reserve(
      {
        batchId: batch.id,
        idempotencyKey: "unsent",
        kind: "video",
        provider: "mock",
        model: "bf-video",
        estimatedCost: 0.2,
      },
      1,
    );
    await release("unsent", { billed: false });
    expect((await reservationLedger(batch.id, 1)).used).toBe(0);

    // A request that DID leave is kept, not refunded. Handing back budget for a
    // clip the vendor billed is how a batch overspends while every number on
    // screen still adds up.
    await reserve(
      {
        batchId: batch.id,
        idempotencyKey: "sent-then-failed",
        kind: "video",
        provider: "mock",
        model: "bf-video",
        estimatedCost: 0.2,
      },
      1,
    );
    await release("sent-then-failed", { billed: true });

    const ledger = await reservationLedger(batch.id, 1);
    expect(ledger.committed).toBeCloseTo(0.2, 6);
    const row = await prisma.costReservation.findUniqueOrThrow({
      where: { idempotencyKey: "sent-then-failed" },
    });
    expect(row.status).toBe("COMMITTED");
    // Flagged, because 0.2 is the forecast rather than an invoice.
    expect(row.possiblyBilled).toBe(true);
  });
});

// ------------------------------------------------------------- the gate ---

describe("the six-question gate", () => {
  it("lets an approved request through and holds its money", async () => {
    const { batch } = await makePlannedBatch({
      name: "Gate pass",
      maxCostPerVideo: 2.5,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 1 });

    const result = await assertBatchAuthorized(
      gateInput({ batchId: batch.id, estimatedCost: 0.2, idempotencyKey: "gp-1" }),
    );
    expect(result.reused).toBe(false);
    expect(result.ledger.reserved).toBeCloseTo(0.2, 6);
  });

  it("stops one video at its own ceiling without touching the others", async () => {
    const { batch } = await makePlannedBatch({
      name: "Per-video ceiling",
      maxCostPerVideo: 0.3,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 2 });

    // Video A spends up to its ceiling.
    await assertBatchAuthorized(
      gateInput({
        batchId: batch.id,
        projectId: "video-a",
        estimatedCost: 0.25,
        idempotencyKey: "a-1",
      }),
    );
    // The next request on the SAME video would exceed $0.30.
    await expect(
      assertBatchAuthorized(
        gateInput({
          batchId: batch.id,
          projectId: "video-a",
          estimatedCost: 0.25,
          idempotencyKey: "a-2",
        }),
      ),
    ).rejects.toMatchObject({ code: "over_video_budget" });

    // A DIFFERENT video is unaffected - the batch still has room, and the
    // per-video limit is per video.
    const other = await assertBatchAuthorized(
      gateInput({
        batchId: batch.id,
        projectId: "video-b",
        estimatedCost: 0.25,
        idempotencyKey: "b-1",
      }),
    );
    expect(other.reused).toBe(false);
  });

  it("closes the approval when the batch ceiling is reached", async () => {
    const { batch } = await makePlannedBatch({
      name: "Exhaustion",
      maxCostPerVideo: 2.5,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 0.5 });

    await assertBatchAuthorized(
      gateInput({ batchId: batch.id, estimatedCost: 0.4, idempotencyKey: "e-1" }),
    );
    await expect(
      assertBatchAuthorized(
        gateInput({ batchId: batch.id, estimatedCost: 0.4, idempotencyKey: "e-2" }),
      ),
    ).rejects.toMatchObject({ code: "over_batch_budget" });

    // Closed, so the remaining jobs stop asking rather than each discovering it
    // in turn and logging an error apiece.
    const auth = await prisma.batchAuthorization.findUniqueOrThrow({
      where: { batchId: batch.id },
    });
    expect(auth.status).toBe("EXHAUSTED");
  });

  it("never lets total reservations exceed the ceiling, across many requests", async () => {
    const { batch } = await makePlannedBatch({
      name: "Ceiling holds",
      maxCostPerVideo: 2.5,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 0.5 });

    let accepted = 0;
    for (let i = 0; i < 20; i++) {
      try {
        await assertBatchAuthorized(
          gateInput({
            batchId: batch.id,
            projectId: `v-${i}`,
            estimatedCost: 0.09,
            idempotencyKey: `hold-${i}`,
          }),
        );
        accepted++;
      } catch {
        // Expected once the ceiling is reached.
      }
    }

    const ledger = await reservationLedger(batch.id, 0.5);
    expect(accepted).toBeGreaterThan(0);
    expect(ledger.used).toBeLessThanOrEqual(0.5);
  });
});

// ------------------------------------------------------ cancel / resume ---

describe("cancel and resume", () => {
  it("sends no further paid request after a cancel", async () => {
    const { batch } = await makePlannedBatch({
      name: "Cancel",
      maxCostPerVideo: 2.5,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 1 });

    await assertBatchAuthorized(
      gateInput({ batchId: batch.id, estimatedCost: 0.1, idempotencyKey: "c-1" }),
    );

    await cancelBatch(batch.id, "test cancel");

    await expect(
      assertBatchAuthorized(
        gateInput({ batchId: batch.id, estimatedCost: 0.1, idempotencyKey: "c-2" }),
      ),
    ).rejects.toMatchObject({ code: "not_approved" });

    const reloaded = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(reloaded.status).toBe("CANCELLED");
  });

  it("cancels queued jobs but leaves in-flight ones to finish", async () => {
    const { batch } = await makePlannedBatch({
      name: "Cancel jobs",
      maxCostPerVideo: 2.5,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 1 });

    const queued = await prisma.job.create({
      data: { type: "batch_expand", batchId: batch.id, status: "queued" },
    });
    const inFlight = await prisma.job.create({
      data: { type: "batch_expand", batchId: batch.id, status: "processing" },
    });

    const result = await cancelBatch(batch.id);
    expect(result.cancelledJobs).toBeGreaterThanOrEqual(1);
    expect(result.inFlight).toBeGreaterThanOrEqual(1);

    expect((await prisma.job.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe(
      "cancelled",
    );
    // Still processing. The vendor has it; pretending otherwise would throw
    // away a clip that was already paid for.
    expect(
      (await prisma.job.findUniqueOrThrow({ where: { id: inFlight.id } })).status,
    ).toBe("processing");
  });

  it("resumes without resetting the spend already recorded", async () => {
    const { batch } = await makePlannedBatch({
      name: "Resume spend",
      maxCostPerVideo: 2.5,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 1 });

    await assertBatchAuthorized(
      gateInput({ batchId: batch.id, estimatedCost: 0.3, idempotencyKey: "r-1" }),
    );
    await commit("r-1", 0.3);
    await cancelBatch(batch.id, "test");

    await resumeBatch(batch.id);
    const auth = await prisma.batchAuthorization.findUniqueOrThrow({
      where: { batchId: batch.id },
    });
    expect(auth.status).toBe("APPROVED");
    // The ceiling and the tally both survive. A resume that zeroed the tally
    // would let one batch spend its ceiling twice, looking well-behaved both
    // times.
    expect(auth.authorizedMaxSpend).toBeCloseTo(1, 6);
    expect(auth.actualSpend).toBeCloseTo(0.3, 6);

    const ledger = await reservationLedger(batch.id, auth.authorizedMaxSpend);
    expect(ledger.available).toBeCloseTo(0.7, 6);
  });

  it("settles a batch that ran out of money mid-expansion instead of hanging on RUNNING", async () => {
    const { batch } = await makePlannedBatch({
      name: "Exhausted mid-expansion",
      maxCostPerVideo: 2.5,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 0.1 });
    await prisma.batch.update({
      where: { id: batch.id },
      data: { status: "RUNNING" },
    });

    // The money is gone and no project was ever created, so the plan still has
    // three videos "not started". Those will never start - waiting for them
    // would leave the batch reading RUNNING with nothing running, which is the
    // one status a person cannot act on.
    await closeAuthorization(batch.id, "EXHAUSTED", "test exhaustion");

    const settled = await settleBatchIfDone(batch.id);
    expect(settled).toBe("BUDGET_EXHAUSTED");

    const reloaded = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(reloaded.status).toBe("BUDGET_EXHAUSTED");
  });

  it("refuses to resume a batch that has no money left", async () => {
    const { batch } = await makePlannedBatch({
      name: "Resume exhausted",
      maxCostPerVideo: 2.5,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 0.2 });
    await assertBatchAuthorized(
      gateInput({ batchId: batch.id, estimatedCost: 0.2, idempotencyKey: "rx-1" }),
    );
    await commit("rx-1", 0.2);
    await closeAuthorization(batch.id, "EXHAUSTED", "test");

    await expect(resumeAuthorization(batch.id)).rejects.toMatchObject({
      code: "over_batch_budget",
    });
  });

  it("lets a resume through even when the video is at its ceiling", async () => {
    // The failure this guards against is subtle and would only show up on a
    // retry: `projectReservedAndSpent` already counts this request's OWN hold,
    // so adding the cost again charges it to the per-video ceiling twice and
    // refuses a resume that is about to spend nothing. That breaks the single
    // property the idempotency key exists to provide.
    const { batch } = await makePlannedBatch({
      name: "Resume at ceiling",
      maxCostPerVideo: 0.3,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 2 });

    const first = await assertBatchAuthorized(
      gateInput({
        batchId: batch.id,
        projectId: "tight-video",
        estimatedCost: 0.28,
        idempotencyKey: "tight-1",
      }),
    );
    expect(first.reused).toBe(false);

    // Same request again: 0.28 is already held, and 0.28 + 0.28 would exceed
    // the $0.30 ceiling if the hold were counted twice.
    const resumed = await assertBatchAuthorized(
      gateInput({
        batchId: batch.id,
        projectId: "tight-video",
        estimatedCost: 0.28,
        idempotencyKey: "tight-1",
      }),
    );
    expect(resumed.reused).toBe(true);

    // A genuinely NEW request on the same video is still refused.
    await expect(
      assertBatchAuthorized(
        gateInput({
          batchId: batch.id,
          projectId: "tight-video",
          estimatedCost: 0.28,
          idempotencyKey: "tight-2",
        }),
      ),
    ).rejects.toMatchObject({ code: "over_video_budget" });
  });

  it("does not buy the same generation twice when a resume repeats the request", async () => {
    const { batch } = await makePlannedBatch({
      name: "Resume idempotent",
      maxCostPerVideo: 2.5,
    });
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 1 });

    const first = await assertBatchAuthorized(
      gateInput({ batchId: batch.id, estimatedCost: 0.2, idempotencyKey: "ri-1" }),
    );
    expect(first.reused).toBe(false);

    const second = await assertBatchAuthorized(
      gateInput({ batchId: batch.id, estimatedCost: 0.2, idempotencyKey: "ri-1" }),
    );
    expect(second.reused).toBe(true);

    const ledger = await reservationLedger(batch.id, 1);
    expect(ledger.used).toBeCloseTo(0.2, 6);
    expect(
      await prisma.costReservation.count({
        where: { batchId: batch.id, idempotencyKey: "ri-1" },
      }),
    ).toBe(1);
  });
});

// -------------------------------------------------- full three-video run ---

describe("three-video mock batch, end to end", () => {
  it("plans, approves, runs, renders and settles", async () => {
    const { batch, plan } = await makePlannedBatch({
      name: "Full run",
      maxCostPerVideo: 2.5,
    });
    expect(plan.runnableCount).toBe(3);

    // Nothing has been spent, and nothing can be, until this call.
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 4 });

    // Expand into projects.
    const expandJob = await prisma.job.create({
      data: { type: "batch_expand", batchId: batch.id, status: "processing" },
    });
    await runJob(expandJob);
    await completeJob(expandJob.id);

    const projects = await prisma.project.findMany({ where: { batchId: batch.id } });
    expect(projects).toHaveLength(3);
    for (const project of projects) {
      expect(project.scriptJson).toBeTruthy();
      expect(project.maxBudget).toBeCloseTo(2.5, 2);
    }

    // Every scene carries a frozen motion decision, and at least some of them
    // avoid a video model entirely.
    const scenes = await prisma.scene.findMany({
      where: { projectId: { in: projects.map((p) => p.id) } },
    });
    expect(scenes.length).toBeGreaterThanOrEqual(12);
    for (const scene of scenes) {
      expect(["AI_VIDEO", "LOCAL_MOTION"]).toContain(scene.motionSource);
    }
    expect(scenes.some((s) => s.motionSource === "LOCAL_MOTION")).toBe(true);

    // Drain the queue the way the worker would.
    for (let i = 0; i < 400; i++) {
      await prisma.job.updateMany({
        where: { status: "queued", nextRunAt: { gt: new Date() } },
        data: { nextRunAt: new Date() },
      });
      const job = await claimNext();
      if (!job) break;
      try {
        const outcome = await runJob(job);
        if (!outcome.deferred) await completeJob(job.id, outcome.result);
      } catch (err) {
        await failJob(job.id, err);
      }
    }

    const progress = await batchProgress(batch.id);
    expect(progress).not.toBeNull();
    expect(progress!.counts.total).toBe(3);
    expect(progress!.counts.completed).toBe(3);

    // Every video produced a real MP4.
    for (const video of progress!.videos) {
      expect(video.finalVideoPath).toBeTruthy();
    }

    // The ceiling was never breached. Mock providers bill $0, so the assertion
    // that matters is that the accounting stayed inside the authorised figure
    // and nothing was left dangling as "reserved" after the run.
    expect(progress!.ledger!.used).toBeLessThanOrEqual(4);
    expect(progress!.ledger!.reserved).toBe(0);

    // Writing the script is a paid text call, and it has to be counted against
    // the batch like everything else. It is cheap enough to be easy to forget,
    // which is exactly why a ceiling that excluded it would not mean what the
    // operator was told it means.
    const kinds = await prisma.costReservation.groupBy({
      by: ["kind"],
      where: { batchId: batch.id },
      _count: { _all: true },
    });
    const kindNames = kinds.map((k) => k.kind);
    expect(kindNames).toContain("text");
    expect(kindNames).toContain("image");
    // Every reservation settled; none left holding money.
    const unsettled = await prisma.costReservation.count({
      where: { batchId: batch.id, status: "RESERVED" },
    });
    expect(unsettled).toBe(0);

    const settled = await settleBatchIfDone(batch.id);
    expect(settled).toBe("COMPLETED");
    // Three mock videos means three FFmpeg renders plus ~18 scene jobs, which
    // genuinely takes several minutes on the reference machine. The generous
    // ceiling is about wall-clock cost, not about waiting out a hang.
  }, 900_000);

  it("stops the one video that busts its ceiling and finishes the rest", async () => {
    // A ceiling low enough that the real script cannot fit, but a batch budget
    // with plenty in it. The video must stop; the batch must not.
    const { batch } = await makePlannedBatch({
      name: "One bad video",
      maxCostPerVideo: 0.001,
    });
    await prisma.batchAuthorization.update({
      where: { batchId: batch.id },
      data: { maxCostPerVideo: 0.001 },
    });
    // Force the plan to consider the videos runnable so expansion reaches the
    // REAL-script check, which is the check under test here.
    const stored = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });
    const plan = storedPlan(stored)!;
    for (const video of plan.videos) video.status = "OK";
    plan.runnableCount = plan.videos.length;
    await prisma.batch.update({
      where: { id: batch.id },
      data: { planJson: JSON.stringify(plan) },
    });

    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 4 });

    const expandJob = await prisma.job.create({
      data: { type: "batch_expand", batchId: batch.id, status: "processing" },
    });
    await runJob(expandJob);

    const projects = await prisma.project.findMany({ where: { batchId: batch.id } });
    expect(projects.length).toBeGreaterThan(0);
    for (const project of projects) {
      expect(project.status).toBe("needs_review");

      // Either refusal is correct, and which one fires depends on how tight the
      // ceiling is. At $0.001 nothing can be routed at all, so the plan comes
      // back incomplete and is refused for THAT - which is the more accurate
      // reason of the two. A looser ceiling routes fine and is refused on the
      // total. Asserting one exact string would pin the test to a threshold it
      // is not testing.
      expect(project.errorMessage).toMatch(
        /OVER_VIDEO_BUDGET|Không định tuyến được/,
      );
    }

    // Refused, not crashed: the approval is still live and the batch is intact.
    const auth = await prisma.batchAuthorization.findUniqueOrThrow({
      where: { batchId: batch.id },
    });
    expect(auth.status).toBe("APPROVED");
    expect(auth.actualSpend).toBe(0);
  });
});
