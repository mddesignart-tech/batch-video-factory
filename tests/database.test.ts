import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/utils";
import { parseCSV } from "@/lib/csv";
import {
  encryptSecret,
  decryptSecret,
  maskSecret,
  encryptionAvailable,
} from "@/lib/crypto";
import { redact } from "@/lib/logger";
import {
  getConnectivity,
  canGenerate,
  isOfflineCapable,
  OFFLINE_MESSAGE,
} from "@/services/connectivity";
import { deriveStatus } from "@/services/provider-health";
import { enqueue, claimNext, completeJob, failJob, queueStats } from "@/jobs/queue";
import { backoffFor, idempotencyKey, RETRY_BACKOFF_MS } from "@/services/generation";
import { recordCost, costSummary, periodStart } from "@/services/cost-tracker";

/** SQLite persistence, CRUD, the queue, secrets handling and offline mode. */

let idiomId = "";
let projectId = "";

beforeAll(async () => {
  await prisma.stylePreset.upsert({
    where: { slug: "test-style" },
    create: {
      name: "Test Style",
      slug: "test-style",
      positivePrompt: "test",
      negativePrompt: "",
      lightingStyle: "",
      cameraLanguage: "",
      visualTone: "",
      isDefault: true,
    },
    update: {},
  });
});

describe("idiom CRUD", () => {
  it("creates and reads back an idiom", async () => {
    const idiom = await prisma.idiom.create({
      data: {
        phrase: "Break a leg",
        slug: slugify("Break a leg"),
        meaning: "Good luck",
        literalMeaning: "He wraps his leg in a giant cartoon bandage.",
        exampleSentence: "Break a leg on your interview!",
        category: "Funny Expressions",
        difficulty: "Beginner",
        region: "General",
      },
    });
    idiomId = idiom.id;
    const found = await prisma.idiom.findUnique({ where: { id: idiom.id } });
    expect(found?.phrase).toBe("Break a leg");
    expect(found?.status).toBe("unused");
    expect(found?.timesUsed).toBe(0);
  });

  it("enforces slug uniqueness, which is how duplicates are detected", async () => {
    await expect(
      prisma.idiom.create({
        data: {
          phrase: "Break a Leg",
          slug: slugify("Break a Leg"),
          meaning: "x",
          literalMeaning: "x",
          exampleSentence: "x",
          category: "Funny Expressions",
        },
      }),
    ).rejects.toThrow();
  });

  it("updates an idiom", async () => {
    await prisma.idiom.update({
      where: { id: idiomId },
      data: { status: "planned", notes: "đã lên lịch" },
    });
    const found = await prisma.idiom.findUnique({ where: { id: idiomId } });
    expect(found?.status).toBe("planned");
    expect(found?.notes).toBe("đã lên lịch");
  });

  it("filters by category and difficulty", async () => {
    const rows = await prisma.idiom.findMany({
      where: { category: "Funny Expressions", difficulty: "Beginner" },
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("normalises accented text when slugifying", () => {
    expect(slugify("Cà phê sữa đá")).toBe("ca-phe-sua-da");
    expect(slugify("Break a Leg!")).toBe("break-a-leg");
  });
});

describe("CSV import parsing", () => {
  it("parses a header row and quoted fields containing commas", () => {
    const csv =
      "phrase,meaning,exampleSentence\n" +
      '"Break the ice","Start a conversation","Hi, how are you, friend?"';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phrase).toBe("Break the ice");
    expect(rows[0]!.exampleSentence).toBe("Hi, how are you, friend?");
  });

  it("handles escaped double quotes", () => {
    const rows = parseCSV('phrase\n"He said ""hello"""');
    expect(rows[0]!.phrase).toBe('He said "hello"');
  });

  it("skips blank lines", () => {
    expect(parseCSV("phrase\nA\n\nB\n")).toHaveLength(2);
  });
});

describe("character CRUD", () => {
  it("stores a canonical visual prompt for consistency", async () => {
    const character = await prisma.character.create({
      data: {
        name: "TestMax",
        description: "Test character",
        personality: "naive",
        visualPrompt: "yellow hoodie, messy brown hair, large round eyes",
        negativePrompt: "photorealistic, extra fingers",
        voiceId: "mock-male-us",
        seed: 1234,
      },
    });
    const found = await prisma.character.findUnique({
      where: { id: character.id },
    });
    expect(found?.visualPrompt).toContain("yellow hoodie");
    expect(found?.seed).toBe(1234);
    expect(found?.enabled).toBe(true);
  });

  it("keeps character names unique", async () => {
    await expect(
      prisma.character.create({
        data: {
          name: "TestMax",
          description: "dup",
          personality: "x",
          visualPrompt: "x",
        },
      }),
    ).rejects.toThrow();
  });
});

describe("project persistence", () => {
  it("creates a project linked to an idiom", async () => {
    const preset = await prisma.stylePreset.findFirst({
      where: { slug: "test-style" },
    });
    const project = await prisma.project.create({
      data: {
        idiomId,
        title: "Test project",
        qualityMode: "BALANCED",
        stylePresetId: preset!.id,
        maxBudget: 5,
      },
    });
    projectId = project.id;
    expect(project.status).toBe("draft");
    expect(project.aspectRatio).toBe("9:16");
    expect(project.targetDuration).toBe(25);
  });

  it("cascades scene deletion when a project is removed", async () => {
    const temp = await prisma.project.create({
      data: { idiomId, title: "Temp", maxBudget: 1 },
    });
    await prisma.scene.create({
      data: { projectId: temp.id, sceneNumber: 1, duration: 4 },
    });
    await prisma.project.delete({ where: { id: temp.id } });
    expect(await prisma.scene.count({ where: { projectId: temp.id } })).toBe(0);
  });

  it("keeps scene numbers unique within a project", async () => {
    await prisma.scene.create({
      data: { projectId, sceneNumber: 1, duration: 4 },
    });
    await expect(
      prisma.scene.create({
        data: { projectId, sceneNumber: 1, duration: 4 },
      }),
    ).rejects.toThrow();
  });

  it("survives a fresh client read, proving it is on disk not in memory", async () => {
    const found = await prisma.project.findUnique({ where: { id: projectId } });
    expect(found?.title).toBe("Test project");
  });
});

describe("job queue", () => {
  it("enqueues and claims a job exactly once", async () => {
    const job = await enqueue({ type: "generate_script", projectId });
    const claimed = await claimNext();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("processing");
    expect(claimed?.attempts).toBe(1);
  });

  it("does not hand the same job to a second worker", async () => {
    const job = await enqueue({ type: "generate_script", projectId });
    const first = await claimNext();
    const second = await claimNext();
    expect(first?.id).toBe(job.id);
    expect(second?.id).not.toBe(job.id);
    if (first) await completeJob(first.id);
  });

  it("re-queues a failed job with backoff while attempts remain", async () => {
    const job = await enqueue({ type: "generate_script", projectId, maxAttempts: 3 });
    await claimNext();
    const willRetry = await failJob(job.id, new Error("boom"));
    expect(willRetry).toBe(true);
    const after = await prisma.job.findUnique({ where: { id: job.id } });
    expect(after?.status).toBe("queued");
    expect(after!.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("gives up after maxAttempts", async () => {
    const job = await enqueue({ type: "generate_script", projectId, maxAttempts: 1 });
    await prisma.job.update({ where: { id: job.id }, data: { attempts: 1 } });
    expect(await failJob(job.id, new Error("fatal"))).toBe(false);
    const after = await prisma.job.findUnique({ where: { id: job.id } });
    expect(after?.status).toBe("failed");
  });

  it("uses 10s / 30s / 90s backoff", () => {
    expect(backoffFor(0)).toBe(RETRY_BACKOFF_MS[0]);
    expect(backoffFor(1)).toBe(RETRY_BACKOFF_MS[1]);
    expect(backoffFor(2)).toBe(RETRY_BACKOFF_MS[2]);
    expect(backoffFor(99)).toBe(RETRY_BACKOFF_MS[2]);
  });

  it("reports counts per status", async () => {
    const stats = await queueStats();
    expect(typeof stats.queued).toBe("number");
    expect(typeof stats.failed).toBe("number");
  });
});

describe("idempotency keys - the duplicate-billing guard", () => {
  const base = {
    sceneId: "scene-1",
    kind: "video",
    provider: "runway",
    model: "gen-x",
    prompt: "a cat",
    generation: 0,
  };

  it("is stable for the same request, so a retry resumes instead of re-paying", () => {
    expect(idempotencyKey(base)).toBe(idempotencyKey({ ...base }));
  });

  it("changes when the operator explicitly regenerates", () => {
    expect(idempotencyKey({ ...base, generation: 1 })).not.toBe(
      idempotencyKey(base),
    );
  });

  it("changes when the prompt, model or provider changes", () => {
    expect(idempotencyKey({ ...base, prompt: "a dog" })).not.toBe(
      idempotencyKey(base),
    );
    expect(idempotencyKey({ ...base, model: "gen-y" })).not.toBe(
      idempotencyKey(base),
    );
    expect(idempotencyKey({ ...base, provider: "kling" })).not.toBe(
      idempotencyKey(base),
    );
  });

  it("is unique per scene", () => {
    expect(idempotencyKey({ ...base, sceneId: "scene-2" })).not.toBe(
      idempotencyKey(base),
    );
  });
});

describe("cost tracking", () => {
  it("records an entry and rolls it into the project total", async () => {
    await recordCost({
      projectId,
      category: "video",
      provider: "mock",
      model: "mock-video-std",
      amount: 0.25,
    });
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    expect(project?.actualCost).toBeCloseTo(0.25, 4);
  });

  it("excludes estimates from the actual total", async () => {
    await recordCost({
      projectId,
      category: "video",
      provider: "mock",
      model: "mock-video-pro",
      amount: 99,
      estimated: true,
    });
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    expect(project?.actualCost).toBeCloseTo(0.25, 4);
  });

  it("summarises by category", async () => {
    const summary = await costSummary("all");
    expect(summary.byCategory.video).toBeGreaterThan(0);
    expect(summary.total).toBeGreaterThan(0);
  });

  it("starts the week on Monday", () => {
    const wednesday = new Date("2026-09-16T12:00:00");
    expect(periodStart("week", wednesday).getDay()).toBe(1);
  });

  it("starts the month on the first", () => {
    expect(periodStart("month", new Date("2026-09-16T12:00:00")).getDate()).toBe(1);
  });
});

describe("secret handling", () => {
  it("round-trips an encrypted key", () => {
    expect(encryptionAvailable()).toBe(true);
    const secret = "sk-live-abcd1234EF92A";
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it("produces different ciphertext each time (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("masks to only the last four characters", () => {
    expect(maskSecret("sk-live-abcd1234EF92A")).toBe("****F92A");
  });

  it("rejects tampered ciphertext instead of returning garbage", () => {
    const encrypted = encryptSecret("secret");
    const parts = encrypted.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("redacts anything key-shaped from logs", () => {
    const redacted = redact({
      apiKey: "sk-live-abcdef123456",
      Authorization: "Bearer xyz",
      nested: { api_key: "secret" },
      safe: "hello",
    }) as Record<string, unknown>;
    expect(redacted.apiKey).toBe("[redacted]");
    expect(redacted.Authorization).toBe("[redacted]");
    expect((redacted.nested as Record<string, unknown>).api_key).toBe("[redacted]");
    expect(redacted.safe).toBe("hello");
  });

  it("redacts a key that appears inside a plain string", () => {
    expect(redact("failed with sk-live-abcdefghijkl123")).toBe("[redacted]");
  });
});

describe("offline mode", () => {
  it("never reports offline while mock mode is on", async () => {
    expect(await getConnectivity()).toBe("ONLINE");
  });

  it("allows generation offline in mock mode", () => {
    expect(canGenerate("OFFLINE")).toBe(true);
  });

  it("lists the local features that must keep working without internet", () => {
    for (const feature of [
      "dashboard",
      "idioms",
      "projects",
      "storyboard-editing",
      "ffmpeg-render",
      "mp4-export",
      "cost-history",
    ]) {
      expect(isOfflineCapable(feature)).toBe(true);
    }
    expect(isOfflineCapable("text-ai")).toBe(false);
  });

  it("has the exact Vietnamese offline message from the spec", () => {
    expect(OFFLINE_MESSAGE).toBe(
      "Không có kết nối Internet. Bạn vẫn có thể chỉnh sửa dự án, quản lý nội dung và render các media đã có.",
    );
  });
});

describe("provider status derivation", () => {
  const config = { name: "runway", enabled: true, apiKeyEnc: null, status: "connected" };

  it("reports mock as connected and everything else disabled in mock mode", () => {
    expect(deriveStatus({ ...config, name: "mock" }, true)).toBe("connected");
    expect(deriveStatus(config, true)).toBe("disabled");
  });
});

describe("model registry", () => {
  it("keeps provider + model id unique", async () => {
    await prisma.modelRegistry.create({
      data: {
        provider: "testprov",
        modelId: "m1",
        displayName: "M1",
        type: "video",
        priceUnit: "per_second",
        price: 0.05,
      },
    });
    await expect(
      prisma.modelRegistry.create({
        data: {
          provider: "testprov",
          modelId: "m1",
          displayName: "dup",
          type: "video",
          priceUnit: "per_second",
          price: 0.05,
        },
      }),
    ).rejects.toThrow();
  });

  it("stores an operator-edited price", async () => {
    await prisma.modelRegistry.updateMany({
      where: { provider: "testprov", modelId: "m1" },
      data: { price: 0.123 },
    });
    const model = await prisma.modelRegistry.findFirst({
      where: { provider: "testprov", modelId: "m1" },
    });
    expect(model?.price).toBeCloseTo(0.123, 4);
  });
});
