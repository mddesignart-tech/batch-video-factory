import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import {
  SEED_CHARACTERS,
  SEED_MODELS,
  SEED_PROVIDERS,
  SEED_STYLE_PRESETS,
} from "@/data/seed-config";
import { approveAuthorization, createAuthorization } from "@/services/batch-authorization";
import { reservationLedger } from "@/services/cost-reservation";
import { resumeAuthorization } from "@/services/batch-authorization";
import { setSpendCap } from "@/services/spend-guard";
import { setProviderBudget } from "@/services/provider-budget";
import { claimNext, completeJob, enqueue, failJob } from "@/jobs/queue";
import { onJobExhausted, runJob } from "@/jobs/handlers";
import { resetMockJobs } from "@/providers/mock/mock-visual-providers";

/**
 * Three videos in one batch, at three different points, and then a restart.
 *
 * A BATCH IS NOT A UNIT OF WORK. It is a place to approve money once, and the
 * videos inside it live independent lives - which is easy to assert and easy to
 * get wrong, because everything they share (the queue, the ledger, the
 * approval) is global. The failure this guards against is not a crash; it is a
 * resume that quietly re-buys what video A already owns, or lets video C's
 * problem stop videos A and B.
 *
 *   A  COMPLETED       must not run again, must not create a single job
 *   B  half generated  must continue at the step it stopped at, reusing media
 *   C  BLOCKED         no reference image AND no written description, so its
 *                      characters cannot be drawn consistently at any price
 *
 * Everything is mock: no network, no vendor, no money. `AI_MOCK_MODE` is pinned
 * on by tests/setup.ts and the throwaway database lives under data/.test.
 * See QĐ-076.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const CEILING = 3;
let batchId = "";
let videoA = "";
let videoB = "";
let videoC = "";

/** Drain the queue the way the worker does. */
async function drain(maxJobs = 200): Promise<{ completed: number; failed: number }> {
  let completed = 0;
  let failed = 0;
  for (let i = 0; i < maxJobs; i++) {
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
        await onJobExhausted(job, err);
        failed++;
      }
    }
  }
  return { completed, failed };
}

function writeFile(relative: string): string {
  const absolute = toAbsolute(relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, PNG);
  return relative;
}

async function makeProject(opts: {
  title: string;
  slug: string;
  status: string;
  characterName: string;
}): Promise<string> {
  const idiom = await prisma.idiom.upsert({
    where: { slug: opts.slug },
    create: {
      phrase: opts.title,
      slug: opts.slug,
      meaning: "resume test",
      literalMeaning: "resume test",
      exampleSentence: "resume test",
      category: "Funny Expressions",
      difficulty: "Beginner",
      region: "General",
      status: "unused",
    },
    update: {},
  });
  const project = await prisma.project.create({
    data: {
      idiomId: idiom.id,
      batchId,
      title: opts.title,
      status: opts.status,
      qualityMode: "ECONOMY",
      targetDuration: 12,
      maxBudget: 1,
    },
  });
  return project.id;
}

async function makeScene(
  projectId: string,
  sceneNumber: number,
  characterName: string,
  over: Record<string, unknown> = {},
) {
  return prisma.scene.create({
    data: {
      projectId,
      sceneNumber,
      duration: 4,
      visualDescription: `${characterName} stands against a plain wall.`,
      characterAction: `${characterName} blinks once.`,
      camera: "Locked static medium shot, no camera movement.",
      dialogue: `${characterName}: "Line ${sceneNumber}."`,
      subtitle: `Line ${sceneNumber}.`,
      complexity: "LOW",
      spendPriority: "LOW",
      charactersPresentJson: JSON.stringify([characterName]),
      speakingCharactersJson: JSON.stringify([characterName]),
      primaryCharactersJson: JSON.stringify([characterName]),
      motionSource: "LOCAL_MOTION",
      motionMode: "LOCAL_MOTION",
      imageSource: "GENERATED",
      status: "pending",
      ...over,
    },
  });
}

beforeAll(async () => {
  resetMockJobs();
  await setSpendCap(5);
  await setProviderBudget({
    provider: "runway",
    available: 1000,
    unit: "credits",
    usdPerUnit: 0.01,
  });

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

  // C's character: a NAME AND A BLANK. No reference image, and not one word of
  // description. This is the shape that cannot be drawn twice the same way.
  await prisma.character.upsert({
    where: { name: "ResumeGhost" },
    update: {},
    create: {
      name: "ResumeGhost",
      description: "nhân vật chỉ có mỗi cái tên",
      personality: "",
      visualPrompt: "ResumeGhost, consistent character design across every scene",
    },
  });

  const batch = await prisma.batch.create({
    data: {
      name: "Resume ba video",
      amount: 3,
      qualityMode: "ECONOMY",
      targetDuration: 12,
      status: "RUNNING",
      maxBudget: CEILING,
      maxCostPerVideo: 1,
      idiomIdsJson: "[]",
      planJson: "{}",
    },
  });
  batchId = batch.id;

  await createAuthorization({
    batchId,
    estimatedCost: 1,
    videoCount: 3,
    maxCostPerVideo: 1,
    providerScope: ["mock"],
    qualityMode: "ECONOMY",
  });
  await approveAuthorization({
    batchId,
    authorizedMaxSpend: CEILING,
    lowAutoApproved: false,
  });

  // ---- A: finished. Every scene has media and a final MP4 path. ----------
  videoA = await makeProject({
    title: "Resume A hoan thanh",
    slug: "resume-a",
    status: "completed",
    characterName: "Max",
  });
  for (const n of [1, 2]) {
    const scene = await makeScene(videoA, n, "Max", {
      status: "completed",
      imagePath: writeFile(`projects/${videoA}/images/a${n}.png`),
      audioPath: writeFile(`projects/${videoA}/audio/a${n}.mp3`),
      videoProvider: "ffmpeg",
      videoModel: "local-motion",
    });
    await prisma.providerJob.create({
      data: {
        kind: "image",
        provider: "mock",
        model: "mock-image-fast",
        status: "completed",
        idempotencyKey: `a-image-${scene.id}`,
        projectId: videoA,
        sceneId: scene.id,
        estimatedCost: 0.004,
        actualCost: 0.004,
        completedAt: new Date(),
      },
    });
  }
  await prisma.project.update({
    where: { id: videoA },
    data: { finalVideoPath: writeFile(`projects/${videoA}/final/a.mp4`) },
  });

  // ---- B: halfway. Scene 1 has its image; scene 2 has nothing. -----------
  videoB = await makeProject({
    title: "Resume B dang do",
    slug: "resume-b",
    status: "media_generating",
    characterName: "Max",
  });
  const b1 = await makeScene(videoB, 1, "Max", {
    status: "image_ready",
    imagePath: writeFile(`projects/${videoB}/images/b1.png`),
  });
  await prisma.providerJob.create({
    data: {
      kind: "image",
      provider: "mock",
      model: "mock-image-fast",
      status: "completed",
      idempotencyKey: `b-image-${b1.id}`,
      projectId: videoB,
      sceneId: b1.id,
      estimatedCost: 0.004,
      actualCost: 0.004,
      completedAt: new Date(),
    },
  });
  await makeScene(videoB, 2, "Max");

  // ---- C: blocked. Its character is a name and a blank. -----------------
  videoC = await makeProject({
    title: "Resume C bi chan",
    slug: "resume-c",
    status: "media_generating",
    characterName: "ResumeGhost",
  });
  await makeScene(videoC, 1, "ResumeGhost");
});

/** Snapshot of everything a resume must not disturb. */
async function snapshot() {
  const [jobs, reservations, ledger, costs] = await Promise.all([
    prisma.providerJob.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.costReservation.findMany(),
    reservationLedger(batchId, CEILING),
    prisma.costEntry.aggregate({ _sum: { amount: true }, _count: true }),
  ]);
  const scenes = await prisma.scene.findMany({
    where: { project: { batchId } },
    select: { id: true, projectId: true, sceneNumber: true, retryCount: true, imagePath: true, status: true },
  });
  return { jobs, reservations, ledger, costs, scenes };
}

describe("ba video, ba trạng thái, một lần khởi động lại", () => {
  it("chuẩn bị đúng như mô tả: A xong, B dở, C thiếu nhận dạng", async () => {
    const a = await prisma.project.findUniqueOrThrow({ where: { id: videoA } });
    expect(a.status).toBe("completed");
    expect(a.finalVideoPath).toBeTruthy();

    const bScenes = await prisma.scene.findMany({ where: { projectId: videoB } });
    expect(bScenes.filter((s) => s.imagePath !== null)).toHaveLength(1);
    expect(bScenes.filter((s) => s.imagePath === null)).toHaveLength(1);

    const ghost = await prisma.character.findUniqueOrThrow({ where: { name: "ResumeGhost" } });
    expect(await prisma.characterReference.count({ where: { characterId: ghost.id } })).toBe(0);
    expect(ghost.hair).toBe("");
  });

  it("resume KHÔNG cấp thêm quyền chi, chỉ xếp lại hàng đợi", async () => {
    const before = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
    // The executor's resume starts by re-opening the SAME approval.
    await resumeAuthorization(batchId);
    const after = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
    expect(after.authorizedMaxSpend).toBe(before.authorizedMaxSpend);
    expect(after.status).toBe("APPROVED");
  });

  it("chạy hết hàng đợi: A đứng yên, B chạy tiếp, C hỏng riêng nó", async () => {
    const before = await snapshot();
    const aJobsBefore = before.jobs.filter((j) => j.projectId === videoA).length;

    // Enqueue the two unfinished videos the way `batch_expand` does.
    for (const projectId of [videoB, videoC]) {
      const scenes = await prisma.scene.findMany({
        where: { projectId, skipped: false },
        orderBy: { sceneNumber: "asc" },
      });
      for (const scene of scenes) {
        await enqueue({
          type: "generate_scene_media",
          projectId,
          sceneId: scene.id,
          priority: 100,
        });
      }
    }

    await drain();
    const after = await snapshot();

    // ---- A: untouched. Not one new job, not one changed row. ------------
    const aJobsAfter = after.jobs.filter((j) => j.projectId === videoA).length;
    expect(aJobsAfter).toBe(aJobsBefore);
    const aScenesBefore = before.scenes.filter((s) => s.projectId === videoA);
    const aScenesAfter = after.scenes.filter((s) => s.projectId === videoA);
    expect(aScenesAfter).toEqual(aScenesBefore);
    const aProject = await prisma.project.findUniqueOrThrow({ where: { id: videoA } });
    expect(aProject.status).toBe("completed");

    // ---- B: continued, and scene 1's image was REUSED not re-bought -----
    const bScenes = await prisma.scene.findMany({
      where: { projectId: videoB },
      orderBy: { sceneNumber: "asc" },
    });
    const b1Before = before.scenes.find(
      (s) => s.projectId === videoB && s.sceneNumber === 1,
    )!;
    expect(bScenes[0]!.imagePath).toBe(b1Before.imagePath);
    const b1ImageJobs = after.jobs.filter(
      (j) => j.sceneId === bScenes[0]!.id && j.kind === "image",
    );
    expect(b1ImageJobs).toHaveLength(1);
    // Scene 2 had nothing, so it really did buy an image.
    expect(bScenes[1]!.imagePath).toBeTruthy();

    // ---- C: failed on its own, and said why ------------------------------
    const cScene = await prisma.scene.findFirstOrThrow({ where: { projectId: videoC } });
    expect(cScene.imagePath).toBeNull();
    expect(cScene.errorMessage ?? "").toContain("ResumeGhost");
    expect(await prisma.providerJob.count({ where: { projectId: videoC } })).toBe(0);
  });

  it("một video hỏng KHÔNG chặn hai video kia", async () => {
    const bScenes = await prisma.scene.findMany({ where: { projectId: videoB } });
    // B got its work done despite C failing in the same drain.
    expect(bScenes.every((s) => s.imagePath !== null)).toBe(true);
    const aProject = await prisma.project.findUniqueOrThrow({ where: { id: videoA } });
    expect(aProject.status).toBe("completed");
  });

  it("retryCount không bị thổi lên, và không có ProviderJob trùng", async () => {
    const scenes = await prisma.scene.findMany({ where: { project: { batchId } } });
    // Nothing here was a deliberate regenerate, so every counter stays at 0.
    expect(scenes.map((s) => s.retryCount)).toEqual(scenes.map(() => 0));

    const projectIds = [videoA, videoB, videoC];
    const jobs = await prisma.providerJob.findMany({
      where: { projectId: { in: projectIds } },
    });
    const keys = jobs.map((j) => j.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);

    // One image job per scene that owns an image - no scene bought twice.
    const imageJobsByScene = new Map<string, number>();
    for (const j of jobs.filter((j) => j.kind === "image")) {
      imageJobsByScene.set(j.sceneId ?? "", (imageJobsByScene.get(j.sceneId ?? "") ?? 0) + 1);
    }
    for (const [, count] of imageJobsByScene) expect(count).toBe(1);
  });

  it("sổ giữ chỗ không trùng, và không có khoản nào treo", async () => {
    const reservations = await prisma.costReservation.findMany({ where: { batchId } });
    const keys = reservations.map((r) => r.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);

    const ledger = await reservationLedger(batchId, CEILING);
    // RESERVED means money promised to a request still in flight. The queue is
    // drained, so nothing may still be holding any.
    expect(ledger.reserved).toBe(0);
    expect(ledger.committed).toBeLessThanOrEqual(CEILING);
    expect(ledger.available).toBe(
      Math.round((CEILING - ledger.committed - ledger.reserved) * 1e6) / 1e6,
    );
  });

  it("KHÔNG có request trả phí nào rời máy trong cả bài test", async () => {
    // Mock mode is pinned on by the suite; this asserts the consequence rather
    // than the setting, which is the part that would actually cost money.
    const real = await prisma.costEntry.count({ where: { estimated: false, provider: { not: "mock" } } });
    expect(real).toBe(0);
  });
});

// ------------------------------------------------ after C's problem is fixed ---

describe("bổ sung ảnh tham chiếu cho C: chỉ C chạy tiếp", () => {
  it("thêm ảnh -> C vẽ được, A và B KHÔNG chạy lại", async () => {
    const before = await snapshot();
    const aJobsBefore = before.jobs.filter((j) => j.projectId === videoA).length;
    const bJobsBefore = before.jobs.filter((j) => j.projectId === videoB).length;

    const ghost = await prisma.character.findUniqueOrThrow({ where: { name: "ResumeGhost" } });
    await prisma.characterReference.create({
      data: {
        characterId: ghost.id,
        filePath: writeFile("characters/resume-ghost.png"),
        source: "upload",
        isPrimary: true,
        approved: true,
        notes: "người vận hành tải lên sau khi thấy cảnh báo",
      },
    });

    const cScene = await prisma.scene.findFirstOrThrow({ where: { projectId: videoC } });
    await prisma.scene.update({
      where: { id: cScene.id },
      data: { status: "pending", errorMessage: null },
    });
    await enqueue({
      type: "generate_scene_media",
      projectId: videoC,
      sceneId: cScene.id,
      priority: 100,
    });
    await drain();

    // C now has its media.
    const cAfter = await prisma.scene.findUniqueOrThrow({ where: { id: cScene.id } });
    expect(cAfter.imagePath).toBeTruthy();
    expect(cAfter.errorMessage).toBeNull();

    // ...and nothing else moved.
    const after = await snapshot();
    expect(after.jobs.filter((j) => j.projectId === videoA).length).toBe(aJobsBefore);
    expect(after.jobs.filter((j) => j.projectId === videoB).length).toBe(bJobsBefore);
    expect(after.scenes.filter((s) => s.projectId === videoA)).toEqual(
      before.scenes.filter((s) => s.projectId === videoA),
    );
    expect(after.scenes.filter((s) => s.projectId === videoB)).toEqual(
      before.scenes.filter((s) => s.projectId === videoB),
    );
  });
});

// ---------------------------------------- a refusal is not worth repeating ---

describe("lỗi đã nói rõ là KHÔNG thử lại thì không đốt lượt thử", () => {
  it("GenerationError retryable=false -> hỏng ngay, không xếp lại", async () => {
    const scene = await prisma.scene.findFirstOrThrow({ where: { projectId: videoA } });
    const job = await enqueue({
      type: "generate_scene_media",
      projectId: videoA,
      sceneId: scene.id,
      priority: 900,
    });

    const { GenerationError } = await import("@/services/generation");
    const willRetry = await failJob(
      job.id,
      new GenerationError("không thể sửa bằng cách thử lại", "image", "identity", false),
    );

    expect(willRetry).toBe(false);
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("failed");
    // The retry budget is untouched: nothing was spent proving the same point.
    expect(after.attempts).toBeLessThan(after.maxAttempts);
  });

  // ONE retry policy (QĐ-103): a job that can send a PAID request is never
  // retried by the queue - the person retries it, and the same idempotency key
  // reuses whatever was bought. Local work still retries.
  it("job trả phí + lỗi không khai báo -> KHÔNG tự thử lại", async () => {
    const scene = await prisma.scene.findFirstOrThrow({ where: { projectId: videoA } });
    const job = await enqueue({
      type: "generate_scene_media",
      projectId: videoA,
      sceneId: scene.id,
      priority: 901,
    });
    const willRetry = await failJob(job.id, new Error("mạng chập chờn"));
    expect(willRetry).toBe(false);
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("failed");
  });

  it("job tại máy (render) + lỗi không khai báo -> vẫn thử lại như cũ", async () => {
    const job = await enqueue({ type: "render_final", projectId: videoA, priority: 903 });
    const willRetry = await failJob(job.id, new Error("ổ đĩa bận"));
    expect(willRetry).toBe(true);
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("queued");
    await prisma.job.delete({ where: { id: job.id } });
  });

  it("job trả phí + retryable=true -> VẪN không tự thử lại (sẽ là lần mua thứ hai)", async () => {
    const scene = await prisma.scene.findFirstOrThrow({ where: { projectId: videoA } });
    const job = await enqueue({
      type: "generate_scene_media",
      projectId: videoA,
      sceneId: scene.id,
      priority: 902,
    });
    const { GenerationError } = await import("@/services/generation");
    const willRetry = await failJob(
      job.id,
      new GenerationError("nhà cung cấp quá tải", "image", "mock", true),
    );
    expect(willRetry).toBe(false);
  });
});
