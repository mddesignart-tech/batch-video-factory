import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { slugify } from "@/lib/utils";
import {
  SEED_CHARACTERS,
  SEED_PROVIDERS,
  SEED_STYLE_PRESETS,
} from "@/data/seed-config";
import {
  approveAuthorization,
  assertBatchAuthorized,
  createAuthorization,
  resumeAuthorization,
} from "@/services/batch-authorization";
import { reservationLedger } from "@/services/cost-reservation";
import { planBatch, type BatchPlan } from "@/services/batch-planner";
import {
  batchProgress,
  cancelBatch,
  retryScene,
  savePlan,
} from "@/services/batch-runner";
import { setSpendCap, totalRealSpend } from "@/services/spend-guard";
import { setProviderBudget } from "@/services/provider-budget";
import { costSummary } from "@/services/cost-tracker";
import { executeScene, runBatch } from "@/services/batch-executor";
import { materializeIdiomVideos } from "@/services/batch-sources";
import { probeDuration } from "@/media/ffmpeg";
import { resetMockJobs, MOCK_FAILURE_ENV } from "@/providers/mock/mock-visual-providers";

/**
 * Batch Video Factory V1 - the acceptance run.
 *
 * One batch of three videos, taken all the way from a free plan to three MP4s,
 * with the failures deliberately injected along the way:
 *
 *   plan -> preview -> approve -> reserve -> queue -> process
 *        -> a scene fails -> retry -> cancel -> resume
 *        -> simulated restart -> render -> settle
 *
 * Everything is mock. No network, no vendor, no money. `AI_MOCK_MODE` is pinned
 * on by tests/setup.ts and the throwaway database lives under data/.test, so the
 * production ledger is never touched.
 *
 * ## Why the "vendors" are two mock model rows and not "runway" and "openai"
 *
 * The obvious way to exercise vendor routing would be to register real provider
 * names and let mock mode hand back mock adapters. That would have written
 * ledger rows saying `provider=runway, calls=1` for a call Runway never
 * received - a fake vendor with a fake call count sitting in the same table the
 * real spend breakdown is read from.
 *
 * So the two tiers are model rows under the `mock` provider, priced to mirror
 * the real ones: a cheap tier at Runway's $0.05/s and a premium tier at Sora's
 * $0.10/s. The router still has to choose between them per scene, which is the
 * behaviour under test - and every ledger row still says `mock`, which is the
 * truth. Wallet separation between REAL providers is asserted at the gate,
 * where it can be checked without writing anything.
 */

const IDIOMS = [
  "Acceptance batch one",
  "Acceptance batch two",
  "Acceptance batch three",
];

/** Priced to mirror the real vendors, so the budget maths is representative. */
const MODELS = [
  {
    modelId: "mock-text-tier",
    type: "text",
    priceUnit: "per_1k_tokens",
    price: 0.00015,
    priceOutput: 0.00075,
    quality: 6,
  },
  {
    modelId: "mock-image-tier",
    type: "image",
    priceUnit: "per_image",
    price: 0.041,
    quality: 7,
  },
  // Stands in for runway/gen4_turbo: cheap, lower quality ceiling.
  {
    modelId: "mock-runway-gen4turbo:720x1280",
    type: "video",
    priceUnit: "per_second",
    price: 0.05,
    quality: 5,
  },
  // Stands in for openai/sora-2: dearer, higher quality.
  {
    modelId: "mock-sora2:720x1280",
    type: "video",
    priceUnit: "per_second",
    price: 0.1,
    quality: 9,
  },
  {
    modelId: "mock-voice-tier",
    type: "voice",
    priceUnit: "per_1k_chars",
    price: 0.015,
    quality: 6,
  },
  {
    modelId: "mock-quality-tier",
    type: "quality",
    priceUnit: "per_job",
    price: 0.004,
    quality: 6,
  },
];

let idiomIds: string[] = [];
let batchId = "";
let plan: BatchPlan | null = null;
/** The scene deliberately failed, so later steps can talk about the same one. */
let failedSceneId = "";

/**
 * ECONOMY, not BALANCED, and the reason matters.
 *
 * Measured on this registry, a six-scene video comes out:
 *
 *   ECONOMY   $1.03  4 local + 2 AI, using BOTH video tiers
 *   BALANCED  $2.22  2 local + 4 AI, premium tier only
 *   QUALITY   $2.32  2 local + 4 AI, premium tier only
 *
 * Only ECONOMY exercises everything this run is meant to prove at once: local
 * motion on the majority of scenes, and the router genuinely choosing between a
 * cheap and a premium tier rather than collapsing onto one. The dearer modes
 * route every paid scene to the premium tier, which would leave the cheap tier
 * untested.
 */
const AUTHORIZED = 3.5;
const MAX_PER_VIDEO = 1.5;

beforeAll(async () => {
  resetMockJobs();
  delete process.env[MOCK_FAILURE_ENV];

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

  // Added, never exclusive.
  //
  // The tempting line here is `modelRegistry.updateMany({ enabled: false })` to
  // make this file's plan deterministic. It would also disable the rows every
  // other test file depends on - and pipeline.e2e seeds its models with an empty
  // `update`, so an existing row it finds disabled STAYS disabled and that file
  // fails for a reason with nothing to do with it. The suite shares one
  // database; a test that quietly switches off shared state is a test that
  // breaks whichever file happens to run next.
  for (const model of MODELS) {
    await prisma.modelRegistry.upsert({
      where: { provider_modelId: { provider: "mock", modelId: model.modelId } },
      create: {
        provider: "mock",
        modelId: model.modelId,
        displayName: model.modelId,
        type: model.type,
        enabled: true,
        priceUnit: model.priceUnit,
        price: model.price,
        priceOutput: model.priceOutput ?? 0,
        supportsTextToVideo: true,
        supportsImageToVideo: true,
        supportsReferenceImage: true,
        supportsCharacterReference: true,
        supports1080p: true,
        maxDuration: 12,
        qualityRating: model.quality,
        speedRating: 6,
        consistencyRating: model.quality,
      },
      update: { enabled: true, price: model.price, qualityRating: model.quality },
    });
  }

  idiomIds = [];
  for (const phrase of IDIOMS) {
    const idiom = await prisma.idiom.upsert({
      where: { slug: slugify(phrase) },
      create: {
        phrase,
        slug: slugify(phrase),
        meaning: "A test idiom for the acceptance run",
        literalMeaning: "Something harmlessly absurd happens on screen.",
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

  await setSpendCap(5);
  await setProviderBudget({
    provider: "runway",
    available: 1000,
    unit: "credits",
    usdPerUnit: 0.01,
  });
});

// ------------------------------------------------------------------ PLAN ---

describe("1. PLAN - free, and provably free", () => {
  it("prices three videos without writing a single ledger row", async () => {
    const spendBefore = await totalRealSpend();
    const entriesBefore = await prisma.costEntry.count();
    const reservationsBefore = await prisma.costReservation.count();

    const batch = await prisma.batch.create({
      data: {
        name: "Acceptance batch",
        amount: 3,
        qualityMode: "ECONOMY",
        targetDuration: 25,
        maxCostPerVideo: MAX_PER_VIDEO,
        maxBudget: 0,
        status: "PLANNED",
      },
    });
    batchId = batch.id;

    plan = await planBatch(
      {
        idiomIds,
        amount: 3,
        qualityMode: "ECONOMY",
        targetDuration: 25,
        maxCostPerVideo: MAX_PER_VIDEO,
      },
      batch.id,
    );
    await savePlan(batch.id, plan);

    expect(plan.videos).toHaveLength(3);
    expect(plan.runnableCount).toBe(3);

    // Planning contacted nobody and changed no money.
    expect(await totalRealSpend()).toBe(spendBefore);
    expect(await prisma.costEntry.count()).toBe(entriesBefore);
    expect(await prisma.costReservation.count()).toBe(reservationsBefore);
  });

  it("shows a per-video cost preview split into stages", () => {
    for (const video of plan!.videos) {
      expect(video.sceneCount).toBeGreaterThanOrEqual(4);
      expect(video.breakdown.image).toBeGreaterThan(0);
      expect(video.breakdown.voice).toBeGreaterThan(0);
      expect(video.estimatedCost).toBeGreaterThan(0);
      expect(video.estimatedCost).toBeLessThanOrEqual(MAX_PER_VIDEO);
      expect(video.status).toBe("OK");
      // Every video says which vendor tier each of its scenes would use.
      expect(video.scenes.length).toBe(video.sceneCount);
    }
  });

  it("routes some scenes to a video model and some to local motion", () => {
    const local = plan!.videos.reduce((n, v) => n + v.localMotionScenes, 0);
    const ai = plan!.videos.reduce((n, v) => n + v.aiVideoScenes, 0);
    expect(local).toBeGreaterThan(0);
    expect(ai).toBeGreaterThan(0);

    // A locally animated scene carries no model and no video cost at all.
    for (const video of plan!.videos) {
      for (const scene of video.scenes) {
        if (scene.motionSource === "LOCAL_MOTION") {
          expect(scene.videoModel).toBeNull();
          expect(scene.videoProvider).toBeNull();
        }
      }
    }
  });

  it("names a real registry model for every scene that will call a video API", async () => {
    const used = new Set(
      plan!.videos
        .flatMap((v) => v.scenes)
        .filter((s) => s.motionSource === "AI_VIDEO")
        .map((s) => s.videoModel)
        .filter((m): m is string => m !== null),
    );
    expect(used.size).toBeGreaterThan(0);

    // Every model in the plan exists and is enabled. A plan naming a model the
    // registry does not have would fail at generation time, after approval.
    for (const modelId of used) {
      const row = await prisma.modelRegistry.findFirst({
        where: { modelId, type: "video", enabled: true },
      });
      expect(row, `model ${modelId} missing from registry`).not.toBeNull();
      expect(row!.price).toBeGreaterThan(0);
    }

    // Which tier wins is the router's business and is covered by
    // tests/ai-router.test.ts against a controlled model list. Asserting a
    // particular tier here would only test which rows other test files happened
    // to leave in the shared registry.
  });
});

// --------------------------------------------------------------- APPROVE ---

describe("2. APPROVE - the only step that authorises money", () => {
  it("refuses every paid request while the plan is unapproved", async () => {
    await createAuthorization({
      batchId,
      estimatedCost: plan!.estimatedTotal,
      maxCostPerVideo: plan!.maxCostPerVideo,
      providerScope: plan!.providerScope,
      videoCount: plan!.runnableCount,
      qualityMode: "ECONOMY",
    });

    await expect(
      assertBatchAuthorized({
        batchId,
        projectId: "nobody",
        sceneId: "nobody",
        kind: "video",
        provider: "mock",
        model: "mock-sora2:720x1280",
        estimatedCost: 0.1,
        idempotencyKey: "pre-approval",
      }),
    ).rejects.toMatchObject({ code: "not_approved" });
  });

  it("accepts a ceiling the operator names and starts the run", async () => {
    await approveAuthorization({ batchId, authorizedMaxSpend: AUTHORIZED });
    const auth = await prisma.batchAuthorization.findUniqueOrThrow({
      where: { batchId },
    });
    expect(auth.status).toBe("APPROVED");
    expect(auth.authorizedMaxSpend).toBeCloseTo(AUTHORIZED, 6);
    expect(auth.maxCostPerVideo).toBeCloseTo(MAX_PER_VIDEO, 6);
  });
});

// -------------------------------------------- QUEUE / PROCESS / FAILURE ---

describe("3. RUN through the one production executor, with one scene deliberately broken", () => {
  it("expands the approved plan into three projects", async () => {
    // IDIOM_GENERATED: the executor's source step writes the scripts. Nothing
    // is enqueued - the same executor runs imported storyboards. QĐ-103.
    await materializeIdiomVideos(batchId);

    const projects = await prisma.project.findMany({ where: { batchId } });
    expect(projects).toHaveLength(3);
    for (const project of projects) {
      expect(project.scriptJson).toBeTruthy();
      expect(project.maxBudget).toBeCloseTo(MAX_PER_VIDEO, 6);
    }

    // Every scene carries the frozen motion decision from the plan.
    const scenes = await prisma.scene.findMany({
      where: { projectId: { in: projects.map((p) => p.id) } },
    });
    expect(scenes.length).toBeGreaterThanOrEqual(12);
    expect(scenes.some((s) => s.motionSource === "LOCAL_MOTION")).toBe(true);
    expect(scenes.some((s) => s.motionSource === "AI_VIDEO")).toBe(true);
  });

  it("fails exactly the scene we broke, and only that one", async () => {
    // Pick an AI_VIDEO scene: a LOCAL_MOTION one never calls a provider, so
    // there is nothing there for the mock failure switch to break.
    const projects = await prisma.project.findMany({
      where: { batchId },
      orderBy: { createdAt: "asc" },
    });
    const target = await prisma.scene.findFirstOrThrow({
      where: { projectId: projects[0]!.id, motionSource: "AI_VIDEO", skipped: false },
      orderBy: { sceneNumber: "asc" },
    });
    failedSceneId = target.id;

    // The broken scene goes through the executor's own scene step, with the
    // vendor failing. ONE attempt - the executor never retries a paid request.
    process.env[MOCK_FAILURE_ENV] = "1";
    try {
      await expect(executeScene(failedSceneId)).rejects.toBeTruthy();
    } finally {
      delete process.env[MOCK_FAILURE_ENV];
    }
    // What the executor records when a scene stops its video.
    await prisma.scene.update({ where: { id: failedSceneId }, data: { status: "failed", errorMessage: "injected" } });
    await prisma.project.update({ where: { id: projects[0]!.id }, data: { status: "failed", errorMessage: "injected" } });

    // The other two videos run to the end through the SAME executor; the broken
    // one does not stop them.
    await runBatch(batchId, { resume: true, onlyProjectIds: [projects[1]!.id, projects[2]!.id] });

    const failedElsewhere = await prisma.scene.count({
      where: { projectId: { in: projects.map((p) => p.id) }, status: "failed", id: { not: failedSceneId } },
    });
    expect(failedElsewhere).toBe(0);
    for (const p of projects.slice(1)) {
      expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("completed");
    }
    // It stops at its FIRST paid step, whichever kind that is.
    const providerJobs = await prisma.providerJob.findMany({ where: { sceneId: failedSceneId } });
    expect(providerJobs.length).toBeGreaterThan(0);
    expect(providerJobs.some((j) => j.status === "failed")).toBe(true);
    // No automatic paid retry: one attempt, recorded once.
    expect(providerJobs.every((j) => j.attempts <= 1)).toBe(true);
  }, 900_000);

  it("never records a failed request as a second purchase", async () => {
    const rows = await prisma.providerJob.findMany({
      where: { sceneId: failedSceneId },
    });
    const keys = new Set(rows.map((r) => r.idempotencyKey));
    expect(keys.size).toBe(rows.length);

    const reservations = await prisma.costReservation.findMany({
      where: { sceneId: failedSceneId },
    });
    expect(reservations.length).toBeLessThanOrEqual(rows.length);
    const resKeys = new Set(reservations.map((r) => r.idempotencyKey));
    expect(resKeys.size).toBe(reservations.length);
  });
});

// ------------------------------------------------------------- RETRY ---

describe("4. RETRY - one scene, without re-buying the rest", () => {
  it("retries that scene through the executor and re-buys nothing already done", async () => {
    // Every asset that was already bought, by scene and kind, before the retry.
    const batchProjects = (await prisma.project.findMany({ where: { batchId }, select: { id: true } })).map((p) => p.id);
    const done = await prisma.providerJob.findMany({
      where: { status: "completed", projectId: { in: batchProjects } },
      select: { sceneId: true, kind: true },
    });
    const doneBefore = new Map<string, number>();
    for (const j of done) doneBefore.set(`${j.sceneId}|${j.kind}`, (doneBefore.get(`${j.sceneId}|${j.kind}`) ?? 0) + 1);

    await retryScene(failedSceneId);

    const scene = await prisma.scene.findUniqueOrThrow({ where: { id: failedSceneId } });
    expect(scene.retryCount).toBeGreaterThan(0);
    expect(scene.status).toBe("completed");

    // The operator asked for THIS scene again, so it may be bought again. No
    // asset that was already completed anywhere else is bought a second time.
    const after = await prisma.providerJob.findMany({
      where: { status: "completed", projectId: { in: batchProjects } },
      select: { sceneId: true, kind: true },
    });
    const doneAfter = new Map<string, number>();
    for (const j of after) doneAfter.set(`${j.sceneId}|${j.kind}`, (doneAfter.get(`${j.sceneId}|${j.kind}`) ?? 0) + 1);
    for (const [key, n] of doneBefore) {
      if (key.startsWith(`${failedSceneId}|`)) continue;
      expect(doneAfter.get(key)).toBe(n);
    }
  }, 900_000);

  it("keeps every reservation settled - none left holding money", async () => {
    const stuck = await prisma.costReservation.count({
      where: { batchId, status: "RESERVED" },
    });
    expect(stuck).toBe(0);
  });
});

// ------------------------------------------------------- CANCEL / RESUME ---

describe("5. CANCEL and RESUME", () => {
  it("sends no further paid request after a cancel", async () => {
    await cancelBatch(batchId, "acceptance test cancel");

    await expect(
      assertBatchAuthorized({
        batchId,
        projectId: "any",
        sceneId: "any",
        kind: "video",
        provider: "mock",
        model: "mock-sora2:720x1280",
        estimatedCost: 0.1,
        idempotencyKey: "after-cancel",
      }),
    ).rejects.toMatchObject({ code: "not_approved" });

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("CANCELLED");
  });

  it("leaves a request already sent to the vendor alone", async () => {
    const inFlight = await prisma.job.create({
      data: { type: "generate_scene_media", batchId, status: "processing" },
    });
    const result = await cancelBatch(batchId, "second cancel");
    expect(result.inFlight).toBeGreaterThanOrEqual(1);
    expect(
      (await prisma.job.findUniqueOrThrow({ where: { id: inFlight.id } })).status,
    ).toBe("processing");
    await prisma.job.delete({ where: { id: inFlight.id } });
  });

  it("resumes on the same ceiling and the same tally", async () => {
    const before = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
    // TIẾP TỤC re-opens the SAME approval - exactly what the executor's resume
    // does before it runs. No new permission, no reset tally.
    await resumeAuthorization(batchId);
    const after = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
    expect(after.status).toBe("APPROVED");
    expect(after.authorizedMaxSpend).toBeCloseTo(before.authorizedMaxSpend, 6);
    expect(after.actualSpend).toBeCloseTo(before.actualSpend, 6);
  });

  it("repairs a video whose script generation died, instead of stranding it", async () => {
    const victim = await prisma.project.findFirstOrThrow({
      where: { batchId },
      orderBy: { createdAt: "desc" },
    });
    await prisma.scene.deleteMany({ where: { projectId: victim.id } });
    await prisma.project.update({
      where: { id: victim.id },
      data: { status: "draft", scriptJson: null, finalVideoPath: null },
    });

    await runBatch(batchId, { resume: true });

    const repaired = await prisma.project.findUniqueOrThrow({ where: { id: victim.id } });
    expect(repaired.scriptJson).toBeTruthy();
    expect(repaired.status).not.toBe("draft");
    expect(await prisma.scene.count({ where: { projectId: victim.id } })).toBeGreaterThanOrEqual(4);
  }, 900_000);

  it("creates no second project for an idiom it already expanded", async () => {
    const before = await prisma.project.findMany({ where: { batchId }, select: { id: true } });
    await runBatch(batchId, { resume: true });
    const after = await prisma.project.findMany({ where: { batchId }, select: { id: true } });
    expect(after.map((p) => p.id).sort()).toEqual(before.map((p) => p.id).sort());
  }, 900_000);
});

// ------------------------------------------------------------- RESTART ---

describe("6. RESTART simulation", () => {
  it("recovers a video interrupted mid-run and buys nothing a second time", async () => {
    // Pretend the process died while this video was generating: the row says
    // media_generating and the MP4 is not recorded. Resume runs it again.
    const project = await prisma.project.findFirstOrThrow({
      where: { batchId, status: "completed" },
      orderBy: { createdAt: "asc" },
    });
    await prisma.project.update({
      where: { id: project.id },
      data: { status: "media_generating", finalVideoPath: null },
    });

    const providerJobsBefore = await prisma.providerJob.count();
    const reservationsBefore = await prisma.costReservation.count({ where: { batchId } });

    await runBatch(batchId, { resume: true, onlyProjectIds: [project.id] });

    // Every idempotency key found its own finished ProviderJob and reservation.
    expect(await prisma.providerJob.count()).toBe(providerJobsBefore);
    expect(await prisma.costReservation.count({ where: { batchId } })).toBe(reservationsBefore);
    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.status).toBe("completed");
    expect(after.finalVideoPath).toBeTruthy();
  }, 600_000);
});

// ------------------------------------------------------ BUDGET PRESSURE ---

describe("7. Budget pressure", () => {
  it("refuses a request that would breach the batch ceiling", async () => {
    // Its own batch, with a per-video ceiling deliberately set HIGHER than the
    // batch ceiling. On the acceptance batch the per-video limit is the tighter
    // of the two, so an oversized request trips that check first and this test
    // would be asserting the wrong refusal - passing while proving nothing about
    // the batch ceiling at all.
    const tight = await prisma.batch.create({
      data: { name: "Batch ceiling", amount: 1, maxCostPerVideo: 5, status: "PLANNED" },
    });
    await createAuthorization({
      batchId: tight.id,
      estimatedCost: 0,
      maxCostPerVideo: 5,
      providerScope: [],
      videoCount: 1,
      qualityMode: "ECONOMY",
    });
    await approveAuthorization({ batchId: tight.id, authorizedMaxSpend: 0.5 });

    // Fits the per-video ceiling ($5) but not the batch ceiling ($0.50).
    await expect(
      assertBatchAuthorized({
        batchId: tight.id,
        projectId: "greedy-video",
        sceneId: "greedy-scene",
        kind: "video",
        provider: "mock",
        model: "mock-sora2:720x1280",
        estimatedCost: 0.9,
        idempotencyKey: "greedy-1",
      }),
    ).rejects.toMatchObject({ code: "over_batch_budget" });

    // Refusing closed the approval, so the remaining jobs stop asking instead
    // of each discovering the same thing and logging an error apiece.
    const auth = await prisma.batchAuthorization.findUniqueOrThrow({
      where: { batchId: tight.id },
    });
    expect(auth.status).toBe("EXHAUSTED");
    expect((await reservationLedger(tight.id, 0.5)).used).toBe(0);
  });

  it("keeps each provider's wallet separate from the others", async () => {
    // A fresh batch, because the one above is now EXHAUSTED by design.
    const other = await prisma.batch.create({
      data: { name: "Wallet check", amount: 1, maxCostPerVideo: 1, status: "PLANNED" },
    });
    await createAuthorization({
      batchId: other.id,
      estimatedCost: 0,
      maxCostPerVideo: 1,
      providerScope: ["mock", "runway"],
      videoCount: 1,
      qualityMode: "ECONOMY",
    });
    await approveAuthorization({ batchId: other.id, authorizedMaxSpend: 1 });

    await setProviderBudget({
      provider: "runway",
      available: 0,
      unit: "credits",
      usdPerUnit: 0.01,
    });

    // The batch ceiling has room and the app-wide cap has room. Neither of those
    // is money at Runway, and treating every balance as one pot would wave this
    // through for the vendor to refuse with a 402.
    await expect(
      assertBatchAuthorized({
        batchId: other.id,
        projectId: "p",
        sceneId: "s",
        kind: "video",
        provider: "runway",
        model: "gen4_turbo:720x1280",
        estimatedCost: 0.25,
        idempotencyKey: "wallet-acceptance",
      }),
    ).rejects.toThrow(/runway/i);

    await setProviderBudget({
      provider: "runway",
      available: 1000,
      unit: "credits",
      usdPerUnit: 0.01,
    });
  });

  it("stops two concurrent jobs from promising the same last dollar", async () => {
    const race = await prisma.batch.create({
      data: { name: "Race", amount: 1, maxCostPerVideo: 5, status: "PLANNED" },
    });
    await createAuthorization({
      batchId: race.id,
      estimatedCost: 0,
      maxCostPerVideo: 5,
      providerScope: [],
      videoCount: 1,
      qualityMode: "ECONOMY",
    });
    await approveAuthorization({ batchId: race.id, authorizedMaxSpend: 1 });

    // Two requests of $0.60 against $1.00, fired together. Reading committed
    // spend would say $0.00 for both and let both through.
    const [a, b] = await Promise.all([
      assertBatchAuthorized({
        batchId: race.id,
        projectId: "va",
        sceneId: "sa",
        kind: "video",
        provider: "mock",
        model: "mock-sora2:720x1280",
        estimatedCost: 0.6,
        idempotencyKey: "race-a",
      }).then(() => "ok" as const, () => "refused" as const),
      assertBatchAuthorized({
        batchId: race.id,
        projectId: "vb",
        sceneId: "sb",
        kind: "video",
        provider: "mock",
        model: "mock-sora2:720x1280",
        estimatedCost: 0.6,
        idempotencyKey: "race-b",
      }).then(() => "ok" as const, () => "refused" as const),
    ]);

    expect([a, b].filter((r) => r === "ok")).toHaveLength(1);
    expect([a, b].filter((r) => r === "refused")).toHaveLength(1);
    expect((await reservationLedger(race.id, 1)).used).toBeCloseTo(0.6, 6);
  });
});

// -------------------------------------------------------- RENDER / STATE ---

describe("8. RENDER and final state", () => {
  it("produced a real MP4 for the videos that completed", async () => {
    const projects = await prisma.project.findMany({
      where: { batchId, finalVideoPath: { not: null } },
    });
    expect(projects.length).toBeGreaterThan(0);

    for (const project of projects) {
      const file = toAbsolute(project.finalVideoPath!);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.statSync(file).size).toBeGreaterThan(10_000);
      const duration = await probeDuration(file);
      expect(duration).toBeGreaterThan(5);

      // Subtitles were written alongside it.
      expect(project.subtitlePath).toBeTruthy();
      expect(fs.existsSync(toAbsolute(project.subtitlePath!))).toBe(true);
    }
  });

  it("charged nothing for video on the locally animated scenes", async () => {
    const projects = await prisma.project.findMany({
      where: { batchId },
      select: { id: true },
    });
    const localScenes = await prisma.scene.findMany({
      where: {
        projectId: { in: projects.map((p) => p.id) },
        motionSource: "LOCAL_MOTION",
      },
      select: { id: true, videoPath: true, videoModel: true },
    });
    expect(localScenes.length).toBeGreaterThan(0);

    for (const scene of localScenes) {
      expect(scene.videoPath).toBeNull();
      expect(scene.videoModel).toBe("local-motion");
      // No provider job, no reservation, no cost entry of kind video.
      const jobs = await prisma.providerJob.count({
        where: { sceneId: scene.id, kind: "video" },
      });
      expect(jobs).toBe(0);
      const reservations = await prisma.costReservation.count({
        where: { sceneId: scene.id, kind: "video" },
      });
      expect(reservations).toBe(0);
      const costs = await prisma.costEntry.aggregate({
        where: { sceneId: scene.id, category: "video" },
        _sum: { amount: true },
      });
      expect(costs._sum.amount ?? 0).toBe(0);
    }
  });

  it("never exceeded the authorised ceiling or a per-video ceiling", async () => {
    const auth = await prisma.batchAuthorization.findUniqueOrThrow({
      where: { batchId },
    });
    const ledger = await reservationLedger(batchId, auth.authorizedMaxSpend);

    expect(ledger.used).toBeLessThanOrEqual(AUTHORIZED);
    expect(ledger.reserved).toBe(0);

    const projects = await prisma.project.findMany({ where: { batchId } });
    for (const project of projects) {
      const spent = await prisma.costReservation.aggregate({
        where: { projectId: project.id, status: "COMMITTED" },
        _sum: { actualCost: true },
      });
      expect(spent._sum.actualCost ?? 0).toBeLessThanOrEqual(MAX_PER_VIDEO);
    }
  });

  it("recorded every mock charge as mock, and no real money at all", async () => {
    // The point of point 8 in the brief: a simulated price must never look like
    // spending. Mock rows are $0 AND are attributed to `mock`, so they are
    // excluded from the real-spend total by provider as well as by amount.
    const projects = await prisma.project.findMany({
      where: { batchId },
      select: { id: true },
    });
    const entries = await prisma.costEntry.findMany({
      where: { projectId: { in: projects.map((p) => p.id) } },
    });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.provider).toBe("mock");
      expect(entry.amount).toBe(0);
    }

    expect(await totalRealSpend()).toBe(0);

    const summary = await costSummary("all");
    expect(summary.actualApiCost).toBe(0);
    // Mock activity is reported separately so a reader can see it happened
    // without mistaking it for money.
    expect(summary.mockCalls).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------- UI ---

describe("9. What the UI reads", () => {
  it("supplies every figure the batch page shows", async () => {
    const progress = await batchProgress(batchId);
    expect(progress).not.toBeNull();

    const p = progress!;
    // Header
    expect(p.counts.total).toBe(3);
    expect(
      p.counts.completed +
        p.counts.running +
        p.counts.queued +
        p.counts.failed +
        p.counts.needsReview,
    ).toBe(p.counts.total);

    // Money tiles: spent / reserved / authorized, all present and coherent.
    expect(p.ledger).not.toBeNull();
    expect(p.ledger!.committed).toBeGreaterThanOrEqual(0);
    expect(p.ledger!.reserved).toBeGreaterThanOrEqual(0);
    expect(p.ledger!.ceiling).toBeCloseTo(AUTHORIZED, 6);
    expect(p.ledger!.available).toBeCloseTo(
      Math.max(0, p.ledger!.ceiling - p.ledger!.used),
      6,
    );

    // Authorisation panel
    expect(p.authorization).not.toBeNull();
    expect(p.authorization!.maxCostPerVideo).toBeCloseTo(MAX_PER_VIDEO, 6);
    expect(Array.isArray(p.authorization!.providerScope)).toBe(true);

    // Per-video rows
    expect(p.videos).toHaveLength(3);
    for (const video of p.videos) {
      expect(video.phrase.length).toBeGreaterThan(0);
      expect(video.sceneCount).toBeGreaterThan(0);
      expect(video.scenesCompleted).toBeLessThanOrEqual(video.sceneCount);
      expect(video.localMotionScenes + video.aiVideoScenes).toBe(video.sceneCount);
      expect(typeof video.status).toBe("string");
    }
    // At least one row can show the local-vs-AI split as a non-zero pair.
    expect(p.videos.some((v) => v.localMotionScenes > 0)).toBe(true);
  });

  it("tells the page whether stop, resume and retry should be offered", async () => {
    const progress = await batchProgress(batchId);
    const status = progress!.authorization!.status;
    // The page derives its buttons from exactly this field, so the field has to
    // be one the page knows: a status outside this set would silently render a
    // batch with no controls at all.
    expect(["DRAFT", "APPROVED", "EXHAUSTED", "CANCELLED", "COMPLETED"]).toContain(
      status,
    );
  });
});
