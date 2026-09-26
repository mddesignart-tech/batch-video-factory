import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { parseJson, slugify } from "@/lib/utils";
import { ScriptSchema } from "@/domain/script";
import {
  SEED_CHARACTERS,
  SEED_MODELS,
  SEED_PROVIDERS,
  SEED_STYLE_PRESETS,
} from "@/data/seed-config";
import {
  createProjectForIdiom,
  previewProjectCost,
  startMediaGeneration,
} from "@/services/project-service";
import {
  approveAuthorization,
  createAuthorization,
} from "@/services/batch-authorization";
import { planBatch } from "@/services/batch-planner";
import { savePlan } from "@/services/batch-runner";
import { approveAndRun, preflightForApproval } from "@/services/batch-executor";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { queueStats } from "@/jobs/queue";
import { runJob } from "@/jobs/handlers";
import { probeDuration } from "@/media/ffmpeg";
import { resetMockJobs } from "@/providers/mock/mock-visual-providers";

/**
 * The Milestone 1 acceptance test, executed end to end.
 *
 * Idiom -> project -> script -> storyboard -> routing -> cost estimate ->
 * mock image -> mock video -> mock voice -> subtitles -> FFmpeg -> MP4.
 *
 * Everything runs in mock mode against a throwaway database and data directory,
 * so it costs nothing and needs no network. The MP4 it produces is a real file
 * that is probed for duration and stream layout before the test passes.
 */

const IDIOM = "Break a leg";
let idiomId = "";
let projectId = "";

beforeAll(async () => {
  resetMockJobs();
  // Mock mode spends $0, but the approval gate compares the ESTIMATE with the
  // global remaining - exactly as it would with real money.
  await setSpendCap(50);

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
  for (const model of SEED_MODELS) {
    await prisma.modelRegistry.upsert({
      where: {
        provider_modelId: { provider: model.provider, modelId: model.modelId },
      },
      create: {
        provider: model.provider,
        modelId: model.modelId,
        displayName: model.displayName,
        type: model.type,
        enabled: model.enabled,
        priceUnit: model.priceUnit,
        price: model.price,
        supportsTextToVideo: model.supportsTextToVideo ?? false,
        supportsImageToVideo: model.supportsImageToVideo ?? false,
        supportsReferenceImage: model.supportsReferenceImage ?? false,
        supportsCharacterReference: model.supportsCharacterReference ?? false,
        supportsAudio: model.supportsAudio ?? false,
        supports1080p: model.supports1080p ?? false,
        supportsUpscale: model.supportsUpscale ?? false,
        maxDuration: model.maxDuration ?? 0,
        qualityRating: model.qualityRating,
        speedRating: model.speedRating,
        consistencyRating: model.consistencyRating,
        notes: model.notes,
      },
      update: {},
    });
  }

  const idiom = await prisma.idiom.upsert({
    where: { slug: slugify(`${IDIOM} e2e`) },
    create: {
      phrase: IDIOM,
      slug: slugify(`${IDIOM} e2e`),
      meaning: "Good luck",
      literalMeaning:
        "He thinks he must break his own leg, so he wraps it in a giant cartoon bandage.",
      exampleSentence: "Break a leg on your interview!",
      category: "Funny Expressions",
      difficulty: "Beginner",
      region: "General",
    },
    update: {},
  });
  idiomId = idiom.id;
});

describe("Milestone 1 acceptance: idiom to MP4", () => {
  it("creates a project in BALANCED mode and generates a script", async () => {
    const project = await createProjectForIdiom({
      idiomId,
      qualityMode: "BALANCED",
      targetDuration: 27,
      maxBudget: 10,
      autoGenerateScript: true,
      autoStartMedia: false,
    });
    projectId = project.id;

    expect(project.status).toBe("script_ready");
    expect(project.scriptJson).toBeTruthy();

    const script = ScriptSchema.parse(JSON.parse(project.scriptJson!));
    expect(script.idiom).toBe(IDIOM);
    expect(script.meaning).toBe("Good luck");
  });

  it("produces 4 to 6 scenes persisted to SQLite", async () => {
    const scenes = await prisma.scene.findMany({
      where: { projectId },
      orderBy: { sceneNumber: "asc" },
    });
    expect(scenes.length).toBeGreaterThanOrEqual(4);
    expect(scenes.length).toBeLessThanOrEqual(6);
    expect(scenes[0]!.sceneNumber).toBe(1);
  });

  it("classifies scene complexity rather than defaulting everything to LOW", async () => {
    const scenes = await prisma.scene.findMany({ where: { projectId } });
    const complexities = new Set(scenes.map((s) => s.complexity));
    expect(complexities.size).toBeGreaterThan(1);
    for (const scene of scenes) {
      expect(["LOW", "MEDIUM", "HIGH"]).toContain(scene.complexity);
    }
  });

  it("marks the hook and the punchline as high spend priority", async () => {
    const scenes = await prisma.scene.findMany({
      where: { projectId },
      orderBy: { sceneNumber: "asc" },
    });
    expect(scenes[0]!.spendPriority).toBe("HIGH");
    expect(scenes.some((s) => s.spendPriority === "HIGH" && s.sceneNumber > 1)).toBe(
      true,
    );
  });

  it("recommends a model per scene and shows a cost estimate for all three modes", async () => {
    const preview = await previewProjectCost(projectId);

    expect(preview.current.scenes.length).toBeGreaterThanOrEqual(4);
    for (const plan of preview.current.scenes) {
      // Every scene gets an answer, but there are now two kinds of answer: a
      // video model, or an explicit decision to animate the keyframe locally.
      if (plan.motionSource === "AI_VIDEO") {
        expect(plan.video).not.toBeNull();
        expect(plan.video!.provider).toBe("mock");
        expect(plan.video!.reason.length).toBeGreaterThan(10);
      } else {
        expect(plan.video).toBeNull();
        expect(plan.motionReason.length).toBeGreaterThan(10);
      }
    }
    // A BALANCED video must still buy movement somewhere - routing everything
    // to stills would be a slideshow, not a saving.
    expect(preview.current.aiVideoScenes).toBeGreaterThan(0);

    for (const mode of ["ECONOMY", "BALANCED", "QUALITY"] as const) {
      expect(preview.modes[mode].breakdown.total).toBeGreaterThanOrEqual(0);
    }
    expect(preview.budget.allowed).toBe(true);
  });

  it("routes different scenes to different video models", async () => {
    const preview = await previewProjectCost(projectId);
    const chosen = preview.current.scenes
      .filter((s) => s.video !== null)
      .map((s) => s.video!.modelId);
    // The mock registry has three video tiers; a 5-6 scene video with a mix of
    // LOW/MEDIUM/HIGH complexity must not collapse onto a single tier.
    expect(new Set(chosen).size).toBeGreaterThan(1);
  });

  it("lets the operator edit a scene before spending anything", async () => {
    const scene = await prisma.scene.findFirst({
      where: { projectId, sceneNumber: 1 },
    });
    await prisma.scene.update({
      where: { id: scene!.id },
      data: { subtitle: "BREAK A LEG?!", dialogue: "Leo: \"Break a leg!\"" },
    });
    const updated = await prisma.scene.findUnique({ where: { id: scene!.id } });
    expect(updated?.subtitle).toBe("BREAK A LEG?!");
  });

  it("hands the project to the SAME approval + executor every batch uses", async () => {
    // ONE ENGINE (QĐ-103): "TẠO MEDIA" spends nothing and queues nothing - the
    // project becomes a batch of one, approved and run like any batch.
    const jobsBefore = (await queueStats()).queued ?? 0;
    const result = await startMediaGeneration(projectId);
    expect(result.needsApproval).toBe(true);
    expect(result.batchId).toBeTruthy();
    expect((await queueStats()).queued ?? 0).toBe(jobsBefore);

    const pre = await preflightForApproval(result.batchId!);
    expect(pre.checks.filter((c) => !c.ok)).toEqual([]);
    expect(pre.ready).toBe(true);
    const cap = await spendStatus();
    const maxBatch = Math.min(cap.remaining, Math.max(0.01, pre.estimatedTotal * 1.5));
    const { run } = await approveAndRun({ batchId: result.batchId!, maxBatch, lowAutoApproved: false, wait: true });
    expect(run!.outcomes[0]!.stopped).toBe("");
  }, 900_000);

  it("gives every scene usable media, whether from a video model or a keyframe", async () => {

    const scenes = await prisma.scene.findMany({
      where: { projectId, skipped: false },
      orderBy: { sceneNumber: "asc" },
    });

    for (const scene of scenes) {
      // The image is the one thing EVERY scene needs now. A LOCAL_MOTION scene
      // has nothing to animate without it, and a scene with neither clip nor
      // image is silently dropped by the renderer - a missing scene in a
      // finished video, with no error anywhere to explain it.
      expect(scene.imagePath, `scene ${scene.sceneNumber} image`).toBeTruthy();
      expect(fs.existsSync(toAbsolute(scene.imagePath!))).toBe(true);

      if (scene.motionSource === "LOCAL_MOTION") {
        // No clip and no video spend, by design.
        expect(scene.videoPath).toBeNull();
        expect(scene.videoModel).toBe("local-motion");
      } else {
        expect(scene.videoPath, `scene ${scene.sceneNumber} video`).toBeTruthy();
        expect(fs.existsSync(toAbsolute(scene.videoPath!))).toBe(true);
        expect(fs.statSync(toAbsolute(scene.videoPath!)).size).toBeGreaterThan(1000);
        expect(scene.videoModel).toBeTruthy();
      }

      expect(scene.audioPath, `scene ${scene.sceneNumber} audio`).toBeTruthy();
      expect(fs.existsSync(toAbsolute(scene.audioPath!))).toBe(true);

      expect(scene.status).toBe("completed");
    }
  });

  it("records which model actually produced each scene", async () => {
    const assets = await prisma.asset.findMany({ where: { projectId } });
    expect(assets.length).toBeGreaterThan(0);

    // Generated media carries the provider/model that produced it. The final
    // MP4 is assembled locally, so it is attributed to ffmpeg, not a provider.
    const generated = assets.filter((a) => a.kind !== "final");
    expect(generated.length).toBeGreaterThan(0);
    for (const asset of generated) {
      expect(asset.provider).toBe("mock");
      expect(asset.model.length).toBeGreaterThan(0);
    }
    expect(assets.find((a) => a.kind === "final")?.provider).toBe("ffmpeg");
  });

  it("writes SRT and ASS subtitle files", async () => {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    expect(project?.subtitlePath).toBeTruthy();

    const srtPath = toAbsolute(project!.subtitlePath!);
    expect(fs.existsSync(srtPath)).toBe(true);

    const srt = fs.readFileSync(srtPath, "utf8");
    expect(srt).toContain("-->");
    expect(srt).toContain("BREAK A LEG");

    const assPath = srtPath.replace(/\.srt$/, ".ass");
    expect(fs.existsSync(assPath)).toBe(true);
    expect(fs.readFileSync(assPath, "utf8")).toContain("[V4+ Styles]");
  });

  it("renders a real 1080x1920 H.264 MP4 with FFmpeg", async () => {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    expect(project?.status).toBe("completed");
    expect(project?.finalVideoPath).toBeTruthy();

    const finalPath = toAbsolute(project!.finalVideoPath!);
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(fs.statSync(finalPath).size).toBeGreaterThan(20_000);

    const duration = await probeDuration(finalPath);
    // Voice-aware timing (V1.2): scenes last as long as their speech plus a
    // little padding, so the video is SHORTER than the scripted ~27s - and
    // exactly as long as the per-scene lengths the render recorded.
    const scenes = await prisma.scene.findMany({ where: { projectId, skipped: false } });
    const planned = scenes.reduce((n, s) => n + s.duration, 0);
    const timed = scenes.reduce((n, s) => n + (s.finalDuration ?? s.duration), 0);
    expect(scenes.every((s) => s.finalDuration !== null && s.timingReason !== null)).toBe(true);
    expect(duration).toBeCloseTo(timed, 0);
    expect(duration).toBeGreaterThan(8);
    expect(duration).toBeLessThanOrEqual(planned + 1);
  });

  it("marks the idiom as used so it is not picked again", async () => {
    const idiom = await prisma.idiom.findUnique({ where: { id: idiomId } });
    expect(idiom?.status).toBe("generated");
    expect(idiom?.timesUsed).toBe(1);
    expect(idiom?.lastUsedAt).toBeTruthy();
  });

  it("records the concept so a second project picks a different joke", async () => {
    const history = await prisma.conceptHistory.findMany({ where: { idiomId } });
    expect(history.length).toBe(1);

    const second = await createProjectForIdiom({
      idiomId,
      qualityMode: "ECONOMY",
      targetDuration: 25,
      maxBudget: 5,
      autoGenerateScript: true,
      autoStartMedia: false,
    });

    const first = await prisma.project.findUnique({ where: { id: projectId } });
    expect(second.angleKey).not.toBe(first?.angleKey);
    expect(second.scriptHash).not.toBe(first?.scriptHash);

    await prisma.project.delete({ where: { id: second.id } });
  });

  it("tracks cost for every stage", async () => {
    const entries = await prisma.costEntry.findMany({ where: { projectId } });
    const categories = new Set(entries.map((e) => e.category));
    expect(categories.has("image")).toBe(true);
    expect(categories.has("video")).toBe(true);
    expect(categories.has("voice")).toBe(true);
    // Mock mode must be genuinely free, not merely cheap.
    for (const entry of entries) expect(entry.amount).toBe(0);
  });

  it("logs the run without leaking anything secret", async () => {
    const logs = await prisma.logEntry.findMany({ where: { projectId } });
    expect(logs.length).toBeGreaterThan(0);
    const blob = JSON.stringify(logs);
    expect(blob).not.toMatch(/sk-live|Bearer /);
  });
});

describe("budget enforcement blocks generation", () => {
  it("refuses to start when the estimate exceeds MAX BUDGET", async () => {
    // Give the registry a priced model so the estimate is non-zero.
    await prisma.modelRegistry.updateMany({
      where: { provider: "mock", modelId: "mock-video-pro" },
      data: { price: 2.5 },
    });
    await prisma.modelRegistry.updateMany({
      where: { provider: "mock", type: "video", modelId: { not: "mock-video-pro" } },
      data: { enabled: false },
    });

    const project = await createProjectForIdiom({
      idiomId,
      qualityMode: "QUALITY",
      targetDuration: 27,
      maxBudget: 0.5,
      autoGenerateScript: true,
      autoStartMedia: false,
    });

    const result = await startMediaGeneration(project.id);
    expect(result.started).toBe(false);
    expect(result.jobsQueued).toBe(0);
    expect(result.errors.join(" ")).toMatch(/ngân sách/i);

    const after = await prisma.project.findUnique({ where: { id: project.id } });
    expect(after?.status).not.toBe("media_generating");

    // Nothing may have been queued, and no MEDIA may have been charged for.
    // Script generation already ran (it is free and happens before the budget
    // gate), so its $0 ledger rows are expected - what must not exist is any
    // paid media work.
    expect(await prisma.job.count({ where: { projectId: project.id } })).toBe(0);

    const charged = await prisma.costEntry.aggregate({
      where: { projectId: project.id },
      _sum: { amount: true },
    });
    expect(charged._sum.amount ?? 0).toBe(0);

    const mediaCosts = await prisma.costEntry.count({
      where: {
        projectId: project.id,
        category: { in: ["image", "video", "voice"] },
      },
    });
    expect(mediaCosts).toBe(0);

    await prisma.project.delete({ where: { id: project.id } });
    await restoreMockPrices();
  });
});

/** Put the mock registry back exactly as seeded after a price experiment. */
async function restoreMockPrices(): Promise<void> {
  for (const model of SEED_MODELS.filter((m) => m.provider === "mock")) {
    await prisma.modelRegistry.updateMany({
      where: { provider: "mock", modelId: model.modelId },
      data: { enabled: model.enabled, price: model.price },
    });
  }
}

describe("batch generation", () => {
  /** A batch row plus a costed plan, with no approval attached yet. */
  async function planOnlyBatch(amount: number, maxCostPerVideo: number) {
    const idioms = await prisma.idiom.findMany({ take: amount + 1 });
    expect(idioms.length).toBeGreaterThan(0);
    await prisma.idiom.updateMany({
      where: { id: { in: idioms.map((i) => i.id) } },
      data: { status: "unused" },
    });

    const batch = await prisma.batch.create({
      data: {
        name: "E2E Batch",
        amount,
        qualityMode: "ECONOMY",
        targetDuration: 25,
        maxCostPerVideo,
        maxBudget: 0,
        concurrency: 2,
        status: "PLANNED",
      },
    });

    const plan = await planBatch(
      {
        amount,
        qualityMode: "ECONOMY",
        targetDuration: 25,
        maxCostPerVideo,
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
      qualityMode: "ECONOMY",
    });
    return { batch, plan };
  }

  async function runExpand(batchId: string) {
    const job = await prisma.job.create({
      data: { type: "batch_expand", batchId, status: "processing" },
    });
    return runJob(job);
  }

  async function cleanup(batchId: string) {
    const projects = await prisma.project.findMany({ where: { batchId } });
    for (const project of projects) {
      await prisma.project.delete({ where: { id: project.id } });
    }
    await prisma.batch.delete({ where: { id: batchId } });
  }

  it("refuses to expand a batch nobody has approved", async () => {
    const { batch } = await planOnlyBatch(2, 0.2);

    // The authorisation exists but is still DRAFT. This is the whole point of
    // the two-step flow: a plan on its own must not be able to spend, or
    // "press the button" and "agree to the money" collapse back into one act.
    const outcome = await runExpand(batch.id);
    expect(outcome.deferred).toBe(false);

    const projects = await prisma.project.findMany({ where: { batchId: batch.id } });
    expect(projects).toHaveLength(0);

    await cleanup(batch.id);
  });

  it("expands an APPROVED batch into projects, each capped at the per-video ceiling", async () => {
    const { batch } = await planOnlyBatch(2, 0.2);
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 0.4 });

    const outcome = await runExpand(batch.id);
    expect(outcome.deferred).toBe(false);

    const projects = await prisma.project.findMany({ where: { batchId: batch.id } });
    expect(projects.length).toBeGreaterThan(0);

    for (const project of projects) {
      expect(project.scriptJson).toBeTruthy();
      // Each video gets the PER-VIDEO ceiling, not a slice of the batch. The
      // old even split let one video quietly take a share sized for several.
      expect(project.maxBudget).toBeCloseTo(0.2, 2);
      const scenes = await prisma.scene.count({ where: { projectId: project.id } });
      expect(scenes).toBeGreaterThanOrEqual(4);
    }

    const queued = await prisma.job.count({
      where: { projectId: { in: projects.map((p) => p.id) } },
    });
    expect(queued).toBeGreaterThan(0);

    // The batch queued real generation work. Drop it here rather than leaving
    // it for a later test to drain, which would make that test's timing depend
    // on this one.
    await cleanup(batch.id);
  });

  it("does not create a second project for an idiom it already expanded", async () => {
    const { batch } = await planOnlyBatch(2, 0.2);
    await approveAuthorization({ batchId: batch.id, authorizedMaxSpend: 0.4 });

    await runExpand(batch.id);
    const first = await prisma.project.findMany({ where: { batchId: batch.id } });
    expect(first.length).toBeGreaterThan(0);

    // Resuming re-runs expansion. A second script per idiom would be a second
    // paid text call for work already done.
    await runExpand(batch.id);
    const second = await prisma.project.findMany({ where: { batchId: batch.id } });
    expect(second.map((p) => p.id).sort()).toEqual(first.map((p) => p.id).sort());

    await cleanup(batch.id);
  });
});

describe("provider failure handling", () => {
  it("one paid attempt per asset: fails, stops that video, surfaces it, charges nothing", async () => {
    // Every mock generation fails. The ONE retry policy (QĐ-103): no paid
    // request is retried automatically - the video stops at the scene that
    // failed, says why, and the person decides (Thử lại / TIẾP TỤC).
    process.env.MOCK_FAILURE_RATE = "1";
    resetMockJobs();

    let projectIdUnderTest = "";
    try {
      const project = await createProjectForIdiom({
        idiomId,
        qualityMode: "ECONOMY",
        targetDuration: 25,
        maxBudget: 10,
        autoGenerateScript: true,
        autoStartMedia: false,
      });
      projectIdUnderTest = project.id;

      const started = await startMediaGeneration(project.id);
      expect(started.needsApproval).toBe(true);
      const cap = await spendStatus();
      const pre = await preflightForApproval(started.batchId!);
      await approveAndRun({
        batchId: started.batchId!,
        maxBatch: Math.min(cap.remaining, Math.max(0.01, pre.estimatedTotal * 1.5)),
        lowAutoApproved: false,
        wait: true,
      });

      // Every provider attempt is on record, and none was attempted twice.
      const providerJobs = await prisma.providerJob.findMany({
        where: { projectId: project.id, kind: { not: "text" } },
      });
      expect(providerJobs.length).toBeGreaterThan(0);
      expect(providerJobs.every((p) => p.status === "failed")).toBe(true);
      expect(providerJobs.every((p) => p.attempts <= 1)).toBe(true);
      expect(new Set(providerJobs.map((p) => p.idempotencyKey)).size).toBe(providerJobs.length);

      // The failure is visible on the scene and the project, in Vietnamese.
      const scenes = await prisma.scene.findMany({ where: { projectId: project.id } });
      expect(scenes.some((s) => s.status === "failed")).toBe(true);
      const after = await prisma.project.findUnique({ where: { id: project.id } });
      expect(after?.status).toBe("failed");
      expect(after?.errorMessage).toBeTruthy();

      // Nothing was charged for the failed work, and nothing is left held.
      const costs = await prisma.costEntry.aggregate({
        where: { projectId: project.id },
        _sum: { amount: true },
      });
      expect(costs._sum.amount ?? 0).toBe(0);
      expect(await prisma.costReservation.count({ where: { batchId: started.batchId!, status: "RESERVED" } })).toBe(0);
    } finally {
      delete process.env.MOCK_FAILURE_RATE;
      resetMockJobs();
      if (projectIdUnderTest) {
        await prisma.project.delete({ where: { id: projectIdUnderTest } }).catch(() => undefined);
      }
    }
  }, 900_000);

  it("refuses to render a project whose scenes failed, with actionable advice", async () => {
    const project = await createProjectForIdiom({
      idiomId,
      qualityMode: "ECONOMY",
      targetDuration: 25,
      maxBudget: 10,
      autoGenerateScript: true,
      autoStartMedia: false,
    });
    await prisma.scene.updateMany({
      where: { projectId: project.id },
      data: { status: "failed" },
    });

    const job = await prisma.job.create({
      data: { type: "render_final", projectId: project.id, status: "processing" },
    });

    await expect(runJob(job)).rejects.toThrow(/Bỏ qua cảnh/);
    await prisma.project.delete({ where: { id: project.id } });
  });
});

describe("skipped scenes", () => {
  it("excludes a skipped scene from the rendered video", async () => {
    const scenes = await prisma.scene.findMany({
      where: { projectId },
      orderBy: { sceneNumber: "asc" },
    });
    const before = await probeDuration(
      toAbsolute(
        (await prisma.project.findUnique({ where: { id: projectId } }))!
          .finalVideoPath!,
      ),
    );

    const last = scenes.at(-1)!;
    await prisma.scene.update({
      where: { id: last.id },
      data: { skipped: true, status: "skipped" },
    });

    const job = await prisma.job.create({
      data: { type: "render_final", projectId, status: "processing" },
    });
    const outcome = await runJob(job);
    expect(outcome.deferred).toBe(false);

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    const after = await probeDuration(toAbsolute(project!.finalVideoPath!));
    expect(after).toBeLessThan(before);

    const scriptJson = parseJson<{ scenes?: unknown[] }>(project!.scriptJson, {});
    expect(Array.isArray(scriptJson.scenes)).toBe(true);
  });
});
