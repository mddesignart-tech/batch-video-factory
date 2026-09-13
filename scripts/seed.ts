import { PrismaClient } from "@prisma/client";
import { SEED_IDIOMS } from "../src/data/seed-idioms";
import {
  SEED_CHARACTERS,
  SEED_MODELS,
  SEED_PROVIDERS,
  SEED_STYLE_PRESETS,
} from "../src/data/seed-config";

/**
 * Idempotent seed. Safe to run repeatedly: everything upserts on a natural key,
 * so re-seeding refreshes the catalogue without touching the operator's own
 * projects, costs or edits.
 */

const prisma = new PrismaClient();

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function main(): Promise<void> {
  console.log("Bắt đầu seed dữ liệu...\n");

  // ------------------------------------------------------------- idioms ---
  let created = 0;
  let skipped = 0;
  for (const idiom of SEED_IDIOMS) {
    const slug = slugify(idiom.phrase);
    const existing = await prisma.idiom.findUnique({ where: { slug } });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.idiom.create({
      data: {
        phrase: idiom.phrase,
        slug,
        meaning: idiom.meaning,
        literalMeaning: idiom.literalMeaning,
        exampleSentence: idiom.exampleSentence,
        category: idiom.category,
        difficulty: idiom.difficulty,
        region: idiom.region,
        status: "unused",
      },
    });
    created++;
  }
  console.log(`Thành ngữ: ${created} mới, ${skipped} đã có.`);

  // --------------------------------------------------------- characters ---
  for (const character of SEED_CHARACTERS) {
    await prisma.character.upsert({
      where: { name: character.name },
      create: {
        name: character.name,
        description: character.description,
        personality: character.personality,
        visualPrompt: character.visualPrompt,
        negativePrompt: character.negativePrompt,
        hair: character.hair,
        facialFeatures: character.facialFeatures,
        outfit: character.outfit,
        bodyProportions: character.bodyProportions,
        accessories: character.accessories,
        colorPalette: character.colorPalette,
        voiceProvider: "mock",
        voiceId: character.voiceId,
        seed: character.seed,
        notes: character.notes,
        enabled: true,
      },
      update: {
        description: character.description,
        personality: character.personality,
        visualPrompt: character.visualPrompt,
        negativePrompt: character.negativePrompt,
        hair: character.hair,
        facialFeatures: character.facialFeatures,
        outfit: character.outfit,
        bodyProportions: character.bodyProportions,
        accessories: character.accessories,
        colorPalette: character.colorPalette,
      },
    });
  }
  console.log(`Nhân vật: ${SEED_CHARACTERS.length}.`);

  // ------------------------------------------------------- style presets ---
  for (const preset of SEED_STYLE_PRESETS) {
    await prisma.stylePreset.upsert({
      where: { slug: preset.slug },
      create: {
        name: preset.name,
        slug: preset.slug,
        positivePrompt: preset.positivePrompt,
        negativePrompt: preset.negativePrompt,
        lightingStyle: preset.lightingStyle,
        cameraLanguage: preset.cameraLanguage,
        visualTone: preset.visualTone,
        aspectRatio: "9:16",
        isDefault: preset.isDefault,
      },
      update: {
        positivePrompt: preset.positivePrompt,
        negativePrompt: preset.negativePrompt,
        isDefault: preset.isDefault,
      },
    });
  }
  console.log(`Phong cách: ${SEED_STYLE_PRESETS.length}.`);

  // ----------------------------------------------------------- providers ---
  for (const provider of SEED_PROVIDERS) {
    await prisma.providerConfig.upsert({
      where: { name: provider.name },
      create: {
        name: provider.name,
        displayName: provider.displayName,
        types: JSON.stringify(provider.types),
        enabled: provider.enabled,
        apiKeyEnvVar: provider.apiKeyEnvVar,
        priority: provider.priority,
        fallbackPriority: provider.fallbackPriority,
        status: provider.enabled ? "connected" : "disabled",
        notes: provider.notes,
      },
      // Never clobber an operator's enable/disable choice or stored key.
      update: {
        displayName: provider.displayName,
        types: JSON.stringify(provider.types),
        apiKeyEnvVar: provider.apiKeyEnvVar,
        notes: provider.notes,
      },
    });
  }
  console.log(`Nhà cung cấp: ${SEED_PROVIDERS.length}.`);

  // -------------------------------------------------------------- models ---
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
        priceOutput: model.priceOutput ?? 0,
        supportsTextToVideo: model.supportsTextToVideo ?? false,
        supportsImageToVideo: model.supportsImageToVideo ?? false,
        supportsReferenceImage: model.supportsReferenceImage ?? false,
        supportsCharacterReference: model.supportsCharacterReference ?? false,
        supportsInputFidelity: model.supportsInputFidelity ?? false,
        lastVerifiedAt: model.lastVerifiedAt
          ? new Date(model.lastVerifiedAt)
          : null,
        supportsAudio: model.supportsAudio ?? false,
        supports1080p: model.supports1080p ?? false,
        supportsUpscale: model.supportsUpscale ?? false,
        maxDuration: model.maxDuration ?? 0,
        qualityRating: model.qualityRating,
        speedRating: model.speedRating,
        consistencyRating: model.consistencyRating,
        notes: model.notes,
      },
      // Capabilities and ratings are ours to maintain. Price and `enabled` are
      // the operator's once a row exists - except for the `mock` tier, whose
      // prices are app-owned simulated values used to demonstrate routing and
      // budgeting. Overwriting a real vendor price here would silently corrupt
      // the operator's rate card.
      update: {
        ...(model.provider === "mock"
          ? {
              price: model.price,
              priceOutput: model.priceOutput ?? 0,
              enabled: model.enabled,
            }
          : {}),
        displayName: model.displayName,
        supportsTextToVideo: model.supportsTextToVideo ?? false,
        supportsImageToVideo: model.supportsImageToVideo ?? false,
        supportsReferenceImage: model.supportsReferenceImage ?? false,
        supportsCharacterReference: model.supportsCharacterReference ?? false,
        supportsInputFidelity: model.supportsInputFidelity ?? false,
        lastVerifiedAt: model.lastVerifiedAt
          ? new Date(model.lastVerifiedAt)
          : null,
        supportsAudio: model.supportsAudio ?? false,
        supports1080p: model.supports1080p ?? false,
        supportsUpscale: model.supportsUpscale ?? false,
        maxDuration: model.maxDuration ?? 0,
        qualityRating: model.qualityRating,
        speedRating: model.speedRating,
        consistencyRating: model.consistencyRating,
        notes: model.notes,
      },
    });
  }
  console.log(`Mô hình AI: ${SEED_MODELS.length}.`);

  const totals = {
    idioms: await prisma.idiom.count(),
    characters: await prisma.character.count(),
    presets: await prisma.stylePreset.count(),
    providers: await prisma.providerConfig.count(),
    models: await prisma.modelRegistry.count(),
  };
  console.log("\nHoàn tất seed:", totals);
}

main()
  .catch((err: unknown) => {
    console.error("Seed thất bại:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
