import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { slugify } from "@/lib/utils";
import {
  SEED_CHARACTERS,
  SEED_MODELS,
  SEED_PROVIDERS,
  SEED_STYLE_PRESETS,
} from "@/data/seed-config";
import { generateSceneImage } from "@/services/generation";
import { setSpendCap } from "@/services/spend-guard";
import { buildPlannedScenes } from "@/services/project-service";

/**
 * A RESUME must not re-buy an image; a REGENERATE must.
 *
 * Reuse used to be decided entirely by the prompt hash: `runProviderJob` looked
 * for a settled job under the same idempotency key, and that key contains the
 * composed prompt. Which means every improvement to the prompt text - QĐ-065's
 * contradiction guard, QĐ-072's lock clause - quietly marked every finished
 * scene as unbought. The next resume would then pay for its images a second
 * time, and nothing in the system would call that a mistake: from inside, a new
 * key IS a new purchase.
 *
 * The fix is not a cleverer hash. It is the caller saying which of the two
 * things it is doing. A worker picking up an unfinished batch reuses; a person
 * pressing "tạo lại ảnh" forces. Neither has to know what the prompt looked
 * like the first time. See QĐ-072.
 *
 * Mock mode, throwaway database, no network, no money.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let projectId = "";

beforeAll(async () => {
  await setSpendCap(5);
  // Only the mock rows, and only the ones the production seed already defines -
  // so this file adds no model id the rest of the suite has not seen.
  for (const provider of SEED_PROVIDERS.filter((p) => p.name === "mock")) {
    await prisma.providerConfig.upsert({
      where: { name: provider.name },
      create: {
        ...provider,
        types: JSON.stringify(provider.types),
        status: "connected",
      },
      update: { enabled: true, status: "connected" },
    });
  }
  for (const model of SEED_MODELS.filter(
    (m) => m.provider === "mock" && m.type === "image",
  )) {
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
  const phrase = "Image reuse";
  const idiom = await prisma.idiom.upsert({
    where: { slug: slugify(phrase) },
    create: {
      phrase,
      slug: slugify(phrase),
      meaning: "Do not pay twice for the same picture",
      literalMeaning: "A prompt changed; the picture did not.",
      exampleSentence: `${phrase} matters on every resume.`,
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
      title: "Image reuse",
      status: "script_ready",
      qualityMode: "BALANCED",
      targetDuration: 20,
    },
  });
  projectId = project.id;
});

/**
 * A scene that already owns a paid image.
 *
 * Built by hand rather than by running the generator, so the test states its
 * own premise: there is a file, and there is a completed image job that paid
 * for it.
 */
async function sceneWithBoughtImage(sceneNumber: number) {
  const relative = path.posix.join(`projects/${projectId}/images`, `s${sceneNumber}.png`);
  const absolute = toAbsolute(relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, PNG);

  const scene = await prisma.scene.create({
    data: {
      projectId,
      sceneNumber,
      duration: 4,
      visualDescription: "Max stands against a plain wall.",
      characterAction: "Max blinks once.",
      camera: "Locked static medium shot, no camera movement.",
      imagePrompt: "Max against a plain wall",
      complexity: "LOW",
      spendPriority: "NORMAL",
      charactersPresentJson: JSON.stringify(["Max"]),
      speakingCharactersJson: JSON.stringify([]),
      primaryCharactersJson: JSON.stringify(["Max"]),
      imageSource: "GENERATED",
      imagePath: relative,
      imageProvider: "mock",
      imageModel: "mock-image-fast",
      status: "image_ready",
    },
  });

  await prisma.providerJob.create({
    data: {
      kind: "image",
      provider: "mock",
      model: "mock-image-fast",
      status: "completed",
      // Deliberately NOT the key today's prompt would produce. That is the
      // whole point: the prompt has moved since this was bought.
      idempotencyKey: `stale-prompt-${scene.id}`,
      projectId,
      sceneId: scene.id,
      estimatedCost: 0.04,
      actualCost: 0.04,
      completedAt: new Date(),
    },
  });

  return scene;
}

describe("ảnh đã mua rồi thì chạy lại KHÔNG mua nữa", () => {
  it("prompt đã đổi, khoá idempotency không còn khớp — vẫn dùng lại ảnh cũ", async () => {
    const scene = await sceneWithBoughtImage(1);
    const jobsBefore = await prisma.providerJob.count();
    const costsBefore = await prisma.costEntry.count();

    const out = await generateSceneImage(scene.id);

    expect(out).toBe(toAbsolute(scene.imagePath!));
    // The strongest evidence: nothing was bought and nothing was billed.
    expect(await prisma.providerJob.count()).toBe(jobsBefore);
    expect(await prisma.costEntry.count()).toBe(costsBefore);

    const after = await prisma.scene.findUniqueOrThrow({ where: { id: scene.id } });
    expect(after.imagePath).toBe(scene.imagePath);
  });

  it("force: true là một lần TẠO LẠI có chủ ý — được phép mua", async () => {
    const scene = await sceneWithBoughtImage(2);
    const jobsBefore = await prisma.providerJob.count();

    const out = await generateSceneImage(scene.id, { force: true });

    expect(out).toBeTruthy();
    expect(await prisma.providerJob.count()).toBeGreaterThan(jobsBefore);
    const after = await prisma.scene.findUniqueOrThrow({ where: { id: scene.id } });
    expect(after.imagePath).not.toBe(scene.imagePath);
  });

  // A column naming a file that is gone is not an asset. Reusing it would hand
  // the renderer a path to nothing.
  it("cột có đường dẫn nhưng file đã bị xoá -> KHÔNG dùng lại, tạo ảnh mới", async () => {
    const scene = await sceneWithBoughtImage(3);
    fs.rmSync(toAbsolute(scene.imagePath!), { force: true });
    const jobsBefore = await prisma.providerJob.count();

    const out = await generateSceneImage(scene.id);

    expect(out).toBeTruthy();
    expect(await prisma.providerJob.count()).toBeGreaterThan(jobsBefore);
  });

  // Reuse requires evidence that somebody PAID. A path with no completed job
  // behind it - an imported keyframe is handled earlier and separately - is not
  // proof of a purchase.
  it("có file nhưng KHÔNG có ProviderJob đã hoàn tất -> không coi là đã mua", async () => {
    const scene = await sceneWithBoughtImage(4);
    await prisma.providerJob.deleteMany({ where: { sceneId: scene.id, kind: "image" } });
    const jobsBefore = await prisma.providerJob.count();

    const out = await generateSceneImage(scene.id);

    expect(out).toBeTruthy();
    expect(await prisma.providerJob.count()).toBeGreaterThan(jobsBefore);
  });
});

/**
 * The ESTIMATE must answer the same question `generateSceneImage` answers.
 *
 * Found by re-running the first real two-video batch: the run would have bought
 * nothing, yet the preflight quoted all ten keyframes again ($0.48) and the
 * resume gate refused a run that could not spend. Same predicate on both sides:
 * the file, plus a completed image job for the scene.
 */
describe("dự toán: ảnh đã mua là REUSE, không phải WILL_CREATE", () => {
  it("file + ProviderJob completed -> hasExistingImage", async () => {
    const scene = await sceneWithBoughtImage(11);
    const planned = await buildPlannedScenes(projectId);
    expect(planned.find((p) => p.sceneNumber === scene.sceneNumber)?.hasExistingImage).toBe(true);
  });

  it("file đã bị xoá -> KHÔNG phải ảnh đã có", async () => {
    const scene = await sceneWithBoughtImage(12);
    fs.rmSync(toAbsolute(scene.imagePath!), { force: true });
    const planned = await buildPlannedScenes(projectId);
    expect(planned.find((p) => p.sceneNumber === scene.sceneNumber)?.hasExistingImage).toBe(false);
  });

  it("có file nhưng không ai trả tiền -> KHÔNG phải ảnh đã có", async () => {
    const scene = await sceneWithBoughtImage(13);
    await prisma.providerJob.deleteMany({ where: { sceneId: scene.id, kind: "image" } });
    const planned = await buildPlannedScenes(projectId);
    expect(planned.find((p) => p.sceneNumber === scene.sceneNumber)?.hasExistingImage).toBe(false);
  });
});
