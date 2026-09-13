"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { MODEL_TYPES, PRICE_UNITS, QUALITY_MODES } from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { encryptionAvailable, encryptSecret, maskSecret } from "@/lib/crypto";
import { saveSettings } from "@/lib/settings";
import { errorMessage, slugify } from "@/lib/utils";
import { enqueue } from "@/jobs/queue";
import { canEnableModel } from "@/services/spend-guard";
import type { ActionResult } from "./idioms";

/** Characters, style presets, model registry, providers, settings, batches. */

// ------------------------------------------------------------- characters ---

const CharacterInput = z.object({
  name: z.string().min(1, "Cần tên nhân vật").max(60),
  description: z.string().default(""),
  personality: z.string().default(""),
  visualPrompt: z.string().min(10, "Mô tả ngoại hình quá ngắn"),
  negativePrompt: z.string().default(""),
  voiceId: z.string().default("mock-male-us"),
  notes: z.string().default(""),
});

export async function saveCharacter(
  id: string | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = CharacterInput.safeParse(
    Object.fromEntries(formData.entries()),
  );
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ.",
    };
  }
  try {
    if (id) {
      await prisma.character.update({ where: { id }, data: parsed.data });
    } else {
      await prisma.character.create({
        data: { ...parsed.data, voiceProvider: "mock" },
      });
    }
    revalidatePath("/characters");
    return { ok: true, message: "Đã lưu nhân vật." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function toggleCharacter(
  id: string,
  enabled: boolean,
): Promise<ActionResult> {
  await prisma.character.update({ where: { id }, data: { enabled } });
  revalidatePath("/characters");
  return { ok: true, message: enabled ? "Đã bật nhân vật." : "Đã tắt nhân vật." };
}

export async function deleteCharacter(id: string): Promise<ActionResult> {
  await prisma.character.delete({ where: { id } });
  revalidatePath("/characters");
  return { ok: true, message: "Đã xoá nhân vật." };
}

// ----------------------------------------------------------- style presets ---

const PresetInput = z.object({
  name: z.string().min(1).max(60),
  positivePrompt: z.string().min(5),
  negativePrompt: z.string().default(""),
  lightingStyle: z.string().default(""),
  cameraLanguage: z.string().default(""),
  visualTone: z.string().default(""),
  aspectRatio: z.string().default("9:16"),
});

export async function saveStylePreset(
  id: string | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = PresetInput.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ.",
    };
  }
  try {
    if (id) {
      await prisma.stylePreset.update({ where: { id }, data: parsed.data });
    } else {
      await prisma.stylePreset.create({
        data: { ...parsed.data, slug: slugify(parsed.data.name) },
      });
    }
    revalidatePath("/styles");
    return { ok: true, message: "Đã lưu phong cách." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function setDefaultPreset(id: string): Promise<ActionResult> {
  await prisma.$transaction([
    prisma.stylePreset.updateMany({ data: { isDefault: false } }),
    prisma.stylePreset.update({ where: { id }, data: { isDefault: true } }),
  ]);
  revalidatePath("/styles");
  return { ok: true, message: "Đã đặt làm phong cách mặc định." };
}

export async function deleteStylePreset(id: string): Promise<ActionResult> {
  const used = await prisma.project.count({ where: { stylePresetId: id } });
  if (used > 0) {
    return {
      ok: false,
      message: `Không thể xoá: ${used} dự án đang dùng phong cách này.`,
    };
  }
  await prisma.stylePreset.delete({ where: { id } });
  revalidatePath("/styles");
  return { ok: true, message: "Đã xoá phong cách." };
}

// ---------------------------------------------------------- model registry ---

const ModelInput = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  type: z.enum(MODEL_TYPES),
  priceUnit: z.enum(PRICE_UNITS),
  price: z.coerce.number().min(0).max(1000),
  priceOutput: z.coerce.number().min(0).max(1000).default(0),
  enabled: z.coerce.boolean().default(false),
  maxDuration: z.coerce.number().min(0).max(120).default(0),
  qualityRating: z.coerce.number().min(1).max(10).default(5),
  speedRating: z.coerce.number().min(1).max(10).default(5),
  consistencyRating: z.coerce.number().min(1).max(10).default(5),
  notes: z.string().default(""),
});

/**
 * Prices are operator data, not code. This is the only way a price ever changes.
 */
export async function saveModel(
  id: string | null,
  formData: FormData,
): Promise<ActionResult> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = ModelInput.safeParse({
    ...raw,
    enabled: raw.enabled === "on" || raw.enabled === "true",
  });
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ.",
    };
  }

  const flags = {
    supportsTextToVideo: raw.supportsTextToVideo === "on",
    supportsImageToVideo: raw.supportsImageToVideo === "on",
    supportsReferenceImage: raw.supportsReferenceImage === "on",
    supportsCharacterReference: raw.supportsCharacterReference === "on",
    supports1080p: raw.supports1080p === "on",
    supportsUpscale: raw.supportsUpscale === "on",
  };

  try {
    if (id) {
      await prisma.modelRegistry.update({
        where: { id },
        data: { ...parsed.data, ...flags },
      });
    } else {
      await prisma.modelRegistry.create({
        data: { ...parsed.data, ...flags },
      });
    }
    revalidatePath("/models");
    return { ok: true, message: "Đã lưu mô hình AI." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function toggleModel(
  id: string,
  enabled: boolean,
): Promise<ActionResult> {
  const model = await prisma.modelRegistry.findUnique({ where: { id } });
  if (!model) return { ok: false, message: "Không tìm thấy mô hình." };

  // Enabling a model with no price is how a "free" video quietly becomes an
  // expensive one. The rule itself lives in spend-guard so it is unit tested.
  if (enabled) {
    const verdict = canEnableModel(model);
    if (!verdict.allowed) return { ok: false, message: verdict.reason };
  }

  await prisma.modelRegistry.update({ where: { id }, data: { enabled } });
  revalidatePath("/models");
  return { ok: true, message: enabled ? "Đã bật mô hình." : "Đã tắt mô hình." };
}

export async function deleteModel(id: string): Promise<ActionResult> {
  await prisma.modelRegistry.delete({ where: { id } });
  revalidatePath("/models");
  return { ok: true, message: "Đã xoá mô hình." };
}

// --------------------------------------------------------------- providers ---

export async function saveProviderKey(
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const key = String(formData.get("apiKey") ?? "").trim();
  if (key.length === 0) {
    return { ok: false, message: "Chưa nhập API key." };
  }
  if (!encryptionAvailable()) {
    return {
      ok: false,
      message:
        "Chưa cấu hình SECRET_ENCRYPTION_KEY trong .env nên không thể lưu API key an toàn. " +
        "Hãy dùng biến môi trường của từng nhà cung cấp thay thế.",
    };
  }
  await prisma.providerConfig.update({
    where: { id },
    data: {
      // Encrypted at rest; only the mask is ever read back by the UI.
      apiKeyEnc: encryptSecret(key),
      apiKeyMask: maskSecret(key),
      lastCheckedAt: new Date(),
    },
  });
  revalidatePath("/providers");
  return { ok: true, message: "Đã lưu API key (đã mã hoá)." };
}

export async function clearProviderKey(id: string): Promise<ActionResult> {
  await prisma.providerConfig.update({
    where: { id },
    data: { apiKeyEnc: null, apiKeyMask: null },
  });
  revalidatePath("/providers");
  return { ok: true, message: "Đã xoá API key đã lưu." };
}

export async function toggleProvider(
  id: string,
  enabled: boolean,
): Promise<ActionResult> {
  await prisma.providerConfig.update({
    where: { id },
    data: { enabled, status: enabled ? "connected" : "disabled" },
  });
  revalidatePath("/providers");
  return {
    ok: true,
    message: enabled ? "Đã bật nhà cung cấp." : "Đã tắt nhà cung cấp.",
  };
}

export async function setProviderPriority(
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const schema = z.object({
    priority: z.coerce.number().min(1).max(999),
    fallbackPriority: z.coerce.number().min(1).max(999),
  });
  const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { ok: false, message: "Giá trị không hợp lệ." };
  await prisma.providerConfig.update({ where: { id }, data: parsed.data });
  revalidatePath("/providers");
  return { ok: true, message: "Đã cập nhật thứ tự ưu tiên." };
}

// ---------------------------------------------------------------- settings ---

export async function updateSettings(formData: FormData): Promise<ActionResult> {
  const schema = z.object({
    defaultQualityMode: z.enum(QUALITY_MODES).optional(),
    defaultTargetDuration: z.coerce.number().min(15).max(60).optional(),
    defaultMaxBudget: z.coerce.number().min(0).max(1000).optional(),
    jobConcurrency: z.coerce.number().min(1).max(8).optional(),
    cleanupTempDays: z.coerce.number().min(1).max(365).optional(),
    cleanupFailedDays: z.coerce.number().min(1).max(365).optional(),
    maxRetries: z.coerce.number().min(1).max(10).optional(),
  });
  const raw = Object.fromEntries(formData.entries());
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ.",
    };
  }
  await saveSettings({
    ...parsed.data,
    burnSubtitles: raw.burnSubtitles === "on",
  });
  revalidatePath("/settings");
  return { ok: true, message: "Đã lưu cài đặt." };
}

// ----------------------------------------------------------------- batches ---

const BatchInput = z.object({
  name: z.string().min(1, "Cần tên lô"),
  amount: z.coerce.number().min(1).max(200),
  category: z.string().optional(),
  difficulty: z.string().optional(),
  stylePresetId: z.string().optional(),
  qualityMode: z.enum(QUALITY_MODES).default("BALANCED"),
  targetDuration: z.coerce.number().min(15).max(60).default(25),
  maxBudget: z.coerce.number().min(0).max(10000).default(40),
  concurrency: z.coerce.number().min(1).max(8).default(2),
});

export async function createBatch(
  formData: FormData,
): Promise<ActionResult & { batchId?: string }> {
  const parsed = BatchInput.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ.",
    };
  }

  const batch = await prisma.batch.create({
    data: {
      name: parsed.data.name,
      amount: parsed.data.amount,
      category: parsed.data.category || null,
      difficulty: parsed.data.difficulty || null,
      stylePresetId: parsed.data.stylePresetId || null,
      qualityMode: parsed.data.qualityMode,
      targetDuration: parsed.data.targetDuration,
      maxBudget: parsed.data.maxBudget,
      concurrency: parsed.data.concurrency,
      status: "queued",
    },
  });

  // Expanding a 50-video batch into projects can take a while, so it happens in
  // the queue rather than in the request.
  await enqueue({ type: "batch_expand", batchId: batch.id, priority: 10 });

  revalidatePath("/batches");
  return {
    ok: true,
    message: `Đã tạo lô "${batch.name}" với ${batch.amount} video. Đang chuẩn bị dự án...`,
    batchId: batch.id,
  };
}

export async function deleteBatch(id: string): Promise<ActionResult> {
  await prisma.batch.delete({ where: { id } });
  revalidatePath("/batches");
  return { ok: true, message: "Đã xoá lô." };
}
