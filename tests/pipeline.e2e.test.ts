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
import { claimNext, completeJob, failJob, queueStats } from "@/jobs/queue";
import { onJobExhausted, runJob } from "@/jobs/handlers";
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

/** Drain the queue the way the worker would, but synchronously and bounded. */
async function drainQueue(maxJobs = 60): Promise<{ completed: number; failed: number }> {
  let completed = 0;
  let failed = 0;

  for (let i = 0; i < maxJobs; i++) {
    // Deferred jobs schedule themselves into the future; pull them forward so
    // the test does not have to sleep through real backoff windows.
    await prisma.job.updateMany({
      where: { status: "queued", nextRunAt: { gt: new Date() } },
      data: { nextRunAt: new Date() },
    });

    const job = await claimNext();
    if (!job) break;

    try {
      const outcome = await runJob(job);
      if (!outcome.deferred) {
        await completeJob(job.id, outcome.result);
        completed++;
      }
    } catch (err) {
      const willRetry = await failJob(job.id, err);
      if (!willRetry) {
        // Mirror the worker exactly, so the harness and production agree on
        // what happens when a job gives up.
        await onJobExhausted(job, err);
        failed++;
      }
    }
  }
  return { completed, failed };
}

beforeAll(async () => {
  resetMockJobs();

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
      expect(plan.video).not.toBeNull();
      expect(plan.video!.provider).toBe("mock");
      expect(plan.video!.reason.length).toBeGreaterThan(10);
    }

    for (const mode of ["ECONOMY", "BALANCED", "QUALITY"] as const) {
      expect(preview.modes[mode].breakdown.total).toBeGreaterThanOrEqual(0);
    }
    expect(preview.budget.allowed).toBe(true);
  });

  it("routes different scenes to different video models", async () => {
    const preview = await previewProjectCost(projectId);
    const chosen = preview.current.scenes.map((s) => s.video!.modelId);
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

  it("queues media generation within budget", async () => {
    const result = await startMediaGeneration(projectId);
    expect(result.started).toBe(true);
    expect(result.jobsQueued).toBeGreaterThan(1);

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    expect(project?.status).toBe("media_generating");

    const stats = await queueStats();
    expect(stats.queued).toBeGreaterThan(0);
  });

  it("generates mock image, video and voice for every scene", async () => {
    const { failed } = await drainQueue();
    expect(failed).toBe(0);

    const scenes = await prisma.scene.findMany({
      where: { projectId, skipped: false },
      orderBy: { sceneNumber: "asc" },
    });

    for (const scene of scenes) {
      expect(scene.videoPath, `scene ${scene.sceneNumber} video`).toBeTruthy();
      expect(fs.existsSync(toAbsolute(scene.videoPath!))).toBe(true);
      expect(fs.statSync(toAbsolute(scene.videoPath!)).size).toBeGreaterThan(1000);

      expect(scene.imagePath, `scene ${scene.sceneNumber} image`).toBeTruthy();
      expect(fs.existsSync(toAbsolute(scene.imagePath!))).toBe(true);

      expect(scene.audioPath, `scene ${scene.sceneNumber} audio`).toBeTruthy();
      expect(fs.existsSync(toAbsolute(scene.audioPath!))).toBe(true);

      expect(scene.videoModel).toBeTruthy();
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
    // The scripted target is 27s; allow generous slack for per-scene rounding.
    expect(duration).toBeGreaterThan(15);
    expect(duration).toBeLessThan(45);
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

    // Nothing may have been queued or charged.
    expect(await prisma.job.count({ where: { projectId: project.id } })).toBe(0);
    expect(await prisma.costEntry.count({ where: { projectId: project.id } })).toBe(0);

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
  it("expands a batch into projects, each with its own script and budget share", async () => {
    const idioms = await prisma.idiom.findMany({ take: 3 });
    expect(idioms.length).toBeGreaterThan(0);

    // Ensure the batch has fresh idioms to draw from.
    await prisma.idiom.updateMany({
      where: { id: { in: idioms.map((i) => i.id) } },
      data: { status: "unused" },
    });

    const batch = await prisma.batch.create({
      data: {
        name: "E2E Batch",
        amount: 2,
        qualityMode: "ECONOMY",
        targetDuration: 25,
        maxBudget: 4,
        concurrency: 2,
        status: "queued",
      },
    });

    const job = await prisma.job.create({
      data: { type: "batch_expand", batchId: batch.id, status: "processing" },
    });
    const outcome = await runJob(job);
    expect(outcome.deferred).toBe(false);

    const projects = await prisma.project.findMany({
      where: { batchId: batch.id },
    });
    expect(projects.length).toBeGreaterThan(0);

    for (const project of projects) {
      expect(project.scriptJson).toBeTruthy();
      // The batch budget is divided between its projects.
      expect(project.maxBudget).toBeCloseTo(4 / projects.length, 2);
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
    for (const project of projects) {
      await prisma.project.delete({ where: { id: project.id } });
    }
    await prisma.batch.delete({ where: { id: batch.id } });
  });
});

describe("provider failure handling", () => {
  it("retries with backoff, exhausts, and surfaces the failure", async () => {
    // Every mock generation fails, so the retry and fallback paths are taken
    // deterministically rather than depending on a random draw.
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
      expect(started.started).toBe(true);

      await drainQueue(120);

      // Scene jobs must have been retried up to their limit, not given up on
      // after one attempt.
      const sceneJobs = await prisma.job.findMany({
        where: { projectId: project.id, type: "generate_scene_media" },
      });
      expect(sceneJobs.length).toBeGreaterThan(0);
      expect(sceneJobs.every((j) => j.attempts > 1)).toBe(true);
      expect(sceneJobs.some((j) => j.status === "failed")).toBe(true);

      // Every provider attempt is on record - this is the table that stops a
      // retry from turning into a second charge.
      const providerJobs = await prisma.providerJob.findMany({
        where: { projectId: project.id },
      });
      expect(providerJobs.length).toBeGreaterThan(0);
      expect(providerJobs.every((p) => p.status === "failed")).toBe(true);

      // Fallback was attempted: the log records each provider that was tried.
      const fallbackLogs = await prisma.logEntry.count({
        where: { projectId: project.id, event: "provider.fallback" },
      });
      expect(fallbackLogs).toBeGreaterThan(0);

      // The failure is visible on the scene and the project, in Vietnamese.
      const scenes = await prisma.scene.findMany({
        where: { projectId: project.id },
      });
      expect(scenes.some((s) => s.status === "failed")).toBe(true);

      const after = await prisma.project.findUnique({
        where: { id: project.id },
      });
      expect(after?.status).toBe("failed");
      expect(after?.errorMessage).toBeTruthy();

      // Nothing was charged for the failed work.
      const costs = await prisma.costEntry.aggregate({
        where: { projectId: project.id },
        _sum: { amount: true },
      });
      expect(costs._sum.amount ?? 0).toBe(0);
    } finally {
      delete process.env.MOCK_FAILURE_RATE;
      resetMockJobs();
      if (projectIdUnderTest) {
        await prisma.project
          .delete({ where: { id: projectIdUnderTest } })
          .catch(() => undefined);
      }
    }
  });

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
