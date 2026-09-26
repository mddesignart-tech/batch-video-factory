import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/utils";
import { ffmpeg } from "@/media/ffmpeg";
import {
  SEED_CHARACTERS,
  SEED_MODELS,
  SEED_PROVIDERS,
  SEED_STYLE_PRESETS,
} from "@/data/seed-config";
import { setSpendCap } from "@/services/spend-guard";
import { createAuthorization } from "@/services/batch-authorization";
import { planBatch } from "@/services/batch-planner";
import { savePlan } from "@/services/batch-runner";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { batchSource } from "@/services/batch-sources";
import { approveAndRun, preflightForApproval } from "@/services/batch-executor";
import { runJob } from "@/jobs/handlers";

/**
 * ONE production executor (QĐ-103). A batch planned from idioms and a batch
 * imported from storyboards differ only in where the videos come from; after
 * that they share the same approval checks, the same run, the same ledger and
 * the same resume. The job queue only schedules - a queued batch job calls the
 * same executor and buys nothing the executor already bought. Mock mode, $0.
 */

let tmp = "";
let idiomBatchId = "";
let storyBatchId = "";

async function seedMock() {
  for (const provider of SEED_PROVIDERS.filter((p) => p.name === "mock")) {
    await prisma.providerConfig.upsert({
      where: { name: provider.name },
      create: { ...provider, types: JSON.stringify(provider.types), status: "connected" },
      update: { enabled: true, status: "connected" },
    });
  }
  for (const model of SEED_MODELS.filter((m) => m.provider === "mock")) {
    await prisma.modelRegistry.upsert({
      where: { provider_modelId: { provider: model.provider, modelId: model.modelId } },
      create: model,
      update: { enabled: true },
    });
  }
  for (const preset of SEED_STYLE_PRESETS) {
    await prisma.stylePreset.upsert({ where: { slug: preset.slug }, create: { ...preset, aspectRatio: "9:16" }, update: {} });
  }
  for (const character of SEED_CHARACTERS) {
    await prisma.character.upsert({
      where: { name: character.name },
      create: { ...character, voiceProvider: "mock", enabled: true },
      update: {},
    });
  }
}

async function makeIdiomBatch(): Promise<string> {
  const idiomIds: string[] = [];
  for (const phrase of ["Unified alpha", "Unified beta"]) {
    const idiom = await prisma.idiom.upsert({
      where: { slug: slugify(phrase) },
      create: {
        phrase,
        slug: slugify(phrase),
        meaning: "A test idiom",
        literalMeaning: "Something absurd happens on screen.",
        exampleSentence: `${phrase} at work!`,
        category: "Funny Expressions",
        difficulty: "Beginner",
        region: "General",
        status: "unused",
      },
      update: { status: "unused" },
    });
    idiomIds.push(idiom.id);
  }
  const batch = await prisma.batch.create({
    data: { name: "unified-idiom", amount: 2, qualityMode: "ECONOMY", targetDuration: 25, maxCostPerVideo: 2, maxBudget: 0, status: "PLANNED" },
  });
  const plan = await planBatch(
    { idiomIds, amount: 2, qualityMode: "ECONOMY", targetDuration: 25, maxCostPerVideo: 2 },
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
  return batch.id;
}

async function makeStoryboardBatch(): Promise<string> {
  const png = path.join(tmp, "k.png");
  await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=1080x1920", "-frames:v", "1", png]);
  const dir = path.join(tmp, "story", "s1");
  fs.mkdirSync(dir, { recursive: true });
  const scenes = [1, 2, 3].map((n) => {
    fs.copyFileSync(png, path.join(dir, `s${n}.png`));
    return {
      scene_number: n,
      duration: 4,
      visual_description: `Max against a plain wall, shot ${n}.`,
      character_action: "Max blinks once and holds still.",
      camera: "Locked static medium shot, no camera movement.",
      dialogue: `Max: "Line ${n}."`,
      subtitle: `Line ${n}.`,
      motion_mode: n === 3 ? "VIDEO_AI" : "LOCAL_MOTION",
      priority: n === 3 ? "HIGH" : "LOW",
      image_file: `s${n}.png`,
    };
  });
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({ video_id: "s1", video_title: "Unified story", characters: [{ character_id: "max", character_name: "Max" }], scenes }),
  );
  const validated = await validateImport(scanImportSource(path.join(tmp, "story")));
  const created = await materialiseImport(validated, { batchName: "unified-story", maxCostPerVideo: 2, maxCostForBatch: 5 });
  return created.batchId;
}

async function ledger(batchId: string) {
  const projects = await prisma.project.findMany({ where: { batchId }, select: { id: true } });
  const projectIds = projects.map((p) => p.id);
  const jobs = await prisma.providerJob.findMany({ where: { projectId: { in: projectIds } } });
  const costs = await prisma.costEntry.findMany({ where: { projectId: { in: projectIds } } });
  return { projectIds, jobs, costs };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "unified-"));
  await setSpendCap(50);
  await seedMock();
  idiomBatchId = await makeIdiomBatch();
  storyBatchId = await makeStoryboardBatch();
}, 180_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("one approval logic for both sources", () => {
  it("names each source, and runs the SAME gate checks on both", async () => {
    expect(await batchSource(idiomBatchId)).toBe("IDIOM_GENERATED");
    expect(await batchSource(storyBatchId)).toBe("STORYBOARD_IMPORTED");

    const idiom = await preflightForApproval(idiomBatchId);
    const story = await preflightForApproval(storyBatchId);
    expect(idiom.source).toBe("IDIOM_GENERATED");
    expect(story.source).toBe("STORYBOARD_IMPORTED");
    expect(idiom.ready).toBe(true);
    expect(story.ready).toBe(true);
    // Same checks, in the same order - one gateChecks, not two copies. Rows
    // named after a model or a video ("key: ...") depend on the plan itself.
    const fixed = (labels: { label: string }[]) => labels.map((c) => c.label).filter((l) => !l.includes(":"));
    expect(fixed(idiom.checks)).toEqual(fixed(story.checks));
    expect(fixed(idiom.checks).length).toBeGreaterThanOrEqual(3);
    // Imported pictures are reused: no image POST for the storyboard.
    expect(story.imagePosts).toBe(0);
  });

  it("refuses a ceiling below the estimate for either source, the same way", async () => {
    for (const batchId of [idiomBatchId, storyBatchId]) {
      await expect(approveAndRun({ batchId, maxBatch: 0.0001, lowAutoApproved: false })).rejects.toThrow(/Chưa duyệt được/);
      const auth = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
      expect(auth.status).toBe("DRAFT");
    }
  });
});

describe("idiom source -> production executor", () => {
  it("DUYỆT & CHẠY writes the scripts and runs every video to an MP4, through the executor", async () => {
    const pre = await preflightForApproval(idiomBatchId);
    const { run } = await approveAndRun({
      batchId: idiomBatchId,
      maxBatch: Math.max(0.01, pre.estimatedTotal * 1.5),
      lowAutoApproved: false,
      wait: true,
    });
    expect(run!.outcomes).toHaveLength(2);
    for (const outcome of run!.outcomes) {
      expect(outcome.stopped).toBe("");
      expect(outcome.outputDir).toBeTruthy();
      expect(fs.existsSync(path.join(outcome.outputDir!, "final.mp4"))).toBe(true);
    }
    // No per-scene jobs were queued: the executor ran it, the queue did not.
    expect(await prisma.job.count({ where: { batchId: idiomBatchId, type: { startsWith: "generate_" } } })).toBe(0);
  }, 900_000);
});

describe("storyboard source -> production executor", () => {
  it("DUYỆT & CHẠY runs the imported storyboard through the same executor", async () => {
    const pre = await preflightForApproval(storyBatchId);
    const { run } = await approveAndRun({
      batchId: storyBatchId,
      maxBatch: Math.max(0.01, pre.estimatedTotal * 1.5),
      lowAutoApproved: false,
      wait: true,
    });
    expect(run!.outcomes).toHaveLength(1);
    expect(run!.outcomes[0]!.stopped).toBe("");
    const { jobs } = await ledger(storyBatchId);
    expect(jobs.filter((j) => j.kind === "image")).toHaveLength(0);
    expect(jobs.filter((j) => j.kind === "video")).toHaveLength(1);
  }, 900_000);
});

describe("no duplicate purchase, whichever way the run is started", () => {
  it("no ProviderJob or CostEntry is recorded twice", async () => {
    for (const batchId of [idiomBatchId, storyBatchId]) {
      const { jobs, costs } = await ledger(batchId);
      expect(new Set(jobs.map((j) => j.idempotencyKey)).size).toBe(jobs.length);
      // Never more charges for a scene's asset than purchases that completed.
      const bought = new Map<string, number>();
      for (const j of jobs.filter((j) => j.status === "completed")) {
        // A voice purchase is an "audio" ProviderJob and a "voice" CostEntry.
        const key = `${j.sceneId}|${j.kind === "audio" ? "voice" : j.kind}`;
        bought.set(key, (bought.get(key) ?? 0) + 1);
      }
      const charged = new Map<string, number>();
      for (const c of costs.filter((c) => c.sceneId && !c.estimated)) {
        charged.set(`${c.sceneId}|${c.category}`, (charged.get(`${c.sceneId}|${c.category}`) ?? 0) + 1);
      }
      for (const [key, n] of charged) expect({ key, n }).toEqual({ key, n: Math.min(n, bought.get(key) ?? 0) });
      expect(charged.size).toBeGreaterThan(0);
    }
  });

  it("a queued batch job only schedules: it calls the same executor and buys nothing again", async () => {
    for (const batchId of [idiomBatchId, storyBatchId]) {
      const before = await ledger(batchId);
      const job = await prisma.job.create({ data: { type: "batch_expand", batchId, status: "processing" } });
      await runJob(job);
      const after = await ledger(batchId);
      expect(after.projectIds.sort()).toEqual(before.projectIds.sort());
      expect(after.jobs).toHaveLength(before.jobs.length);
      expect(after.costs).toHaveLength(before.costs.length);
      await prisma.job.delete({ where: { id: job.id } });
    }
  }, 900_000);

  it("the queue handlers route media through the executor, not straight to a vendor", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/jobs/handlers.ts"), "utf8");
    expect(source).toContain("executeScene");
    expect(source).toContain("executeSceneAsset");
    expect(source).not.toMatch(/import\s*\{[^}]*\bgenerate(Scene)?(Image|Video|Voice)\b[^}]*\}/);
  });
});
