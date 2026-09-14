"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { errorMessage } from "@/lib/utils";
import { isMockMode } from "@/lib/env";
import {
  approveCharacterReference,
  deleteCharacterReference,
  generateCharacterMaster,
  uploadCharacterReference,
} from "@/services/character-master";
import {
  buildMasterPrompt,
  getCharacterSheet,
} from "@/services/character-service";
import { spendStatus } from "@/services/spend-guard";
import { discoverImageModels } from "@/services/model-discovery";
import type { ActionResult } from "./idioms";

/** Character reference images: upload, generate, approve, delete. */

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function uploadReference(formData: FormData): Promise<ActionResult> {
  const characterId = String(formData.get("characterId") ?? "");
  const file = formData.get("file");

  if (!characterId) return { ok: false, message: "Thiếu nhân vật." };
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Chưa chọn tệp ảnh." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      message: `Tệp ${(file.size / 1024 / 1024).toFixed(1)} MB vượt giới hạn 10 MB.`,
    };
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    await uploadCharacterReference({
      characterId,
      fileName: file.name,
      bytes,
      notes: String(formData.get("notes") ?? ""),
    });
    revalidatePath("/characters");
    return {
      ok: true,
      message: "Đã tải ảnh lên. Bấm “Đặt làm ảnh chuẩn” nếu muốn dùng làm mốc nhất quán.",
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * What a master generation will cost, before anything is sent.
 *
 * Read-only and free: it builds the prompt and reads the registry price so the
 * operator sees the figure and the exact text before approving the spend.
 */
export async function previewMaster(
  characterId: string,
  provider: string,
  modelId: string,
): Promise<{
  ok: boolean;
  message?: string;
  prompt?: string;
  estimatedCost?: number;
  spent?: number;
  cap?: number;
  mockMode?: boolean;
}> {
  try {
    const sheet = await getCharacterSheet(characterId);
    if (!sheet) return { ok: false, message: "Không tìm thấy nhân vật." };

    const [model, preset, status] = await Promise.all([
      prisma.modelRegistry.findUnique({
        where: { provider_modelId: { provider, modelId } },
      }),
      prisma.stylePreset.findFirst({ where: { isDefault: true } }),
      spendStatus(),
    ]);
    if (!model) return { ok: false, message: "Không tìm thấy model trong bảng Mô hình AI." };

    const stylePrompt = preset
      ? [preset.positivePrompt, preset.lightingStyle, preset.visualTone]
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .join(", ")
      : "consistent 3D cartoon style, bright colours, soft even lighting";

    return {
      ok: true,
      prompt: buildMasterPrompt(sheet, stylePrompt),
      estimatedCost: model.price,
      spent: status.spent,
      cap: status.cap,
      mockMode: isMockMode(),
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function generateMaster(formData: FormData): Promise<ActionResult> {
  const characterId = String(formData.get("characterId") ?? "");
  const provider = String(formData.get("provider") ?? "");
  const modelId = String(formData.get("model") ?? "");
  const promptOverride = String(formData.get("prompt") ?? "").trim();

  if (!characterId || !provider || !modelId) {
    return { ok: false, message: "Thiếu nhân vật, nhà cung cấp hoặc model." };
  }

  try {
    const result = await generateCharacterMaster({
      characterId,
      provider,
      model: modelId,
      promptOverride: promptOverride.length > 0 ? promptOverride : undefined,
    });
    revalidatePath("/characters");
    return {
      ok: true,
      message:
        `Đã tạo ảnh ứng viên bằng ${provider}/${modelId}. ` +
        `Chi phí thật: $${result.actualCost.toFixed(6)}. ` +
        (result.keptExistingPrimary
          ? "Ảnh chuẩn cũ được giữ nguyên — duyệt thủ công nếu muốn thay."
          : "Bấm “Duyệt làm ảnh chuẩn” để dùng cho mọi cảnh."),
    };
  } catch (err) {
    // The message already names the provider, the model and the reason; do not
    // flatten it into something generic.
    return { ok: false, message: errorMessage(err) };
  }
}

export async function approveReference(referenceId: string): Promise<ActionResult> {
  try {
    await approveCharacterReference(referenceId);
    revalidatePath("/characters");
    return { ok: true, message: "Đã đặt làm ảnh chuẩn. Mọi cảnh sau sẽ khớp theo ảnh này." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function removeReference(referenceId: string): Promise<ActionResult> {
  try {
    const reference = await prisma.characterReference.findUnique({
      where: { id: referenceId },
    });
    if (reference?.isPrimary) {
      return {
        ok: false,
        message:
          "Đây là ảnh chuẩn đang dùng. Hãy đặt ảnh khác làm chuẩn trước khi xoá ảnh này.",
      };
    }
    await deleteCharacterReference(referenceId);
    revalidatePath("/characters");
    return { ok: true, message: "Đã xoá ảnh tham chiếu." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Ask the provider which image models it actually serves right now. */
export async function listImageModels(provider: string) {
  return discoverImageModels(provider);
}

const SheetInput = z.object({
  facialFeatures: z.string().default(""),
  hair: z.string().default(""),
  outfit: z.string().default(""),
  bodyProportions: z.string().default(""),
  accessories: z.string().default(""),
  colorPalette: z.string().default(""),
});

/**
 * Save the detailed appearance fields.
 *
 * Bumps `version` whenever any of them actually changed, so images generated
 * against the old description stay distinguishable from current ones - and so
 * the idempotency key changes, allowing a legitimate regeneration.
 */
export async function saveCharacterSheet(
  characterId: string,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = SheetInput.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ." };
  }

  try {
    const current = await prisma.character.findUnique({ where: { id: characterId } });
    if (!current) return { ok: false, message: "Không tìm thấy nhân vật." };

    const changed = (Object.keys(parsed.data) as (keyof typeof parsed.data)[]).some(
      (key) => (current[key] ?? "") !== parsed.data[key],
    );

    await prisma.character.update({
      where: { id: characterId },
      data: {
        ...parsed.data,
        version: changed ? current.version + 1 : current.version,
      },
    });

    revalidatePath("/characters");
    return {
      ok: true,
      message: changed
        ? `Đã lưu. Phiên bản nhân vật tăng lên v${current.version + 1} — ảnh chuẩn cũ vẫn được giữ, tạo ảnh mới nếu muốn cập nhật.`
        : "Đã lưu (không có thay đổi).",
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

// ------------------------------------------------------------------ voice ---

/**
 * Voice settings, all editable, none hard-coded.
 *
 * Provider and model are free text rather than an enum on purpose: adding
 * ElevenLabs or Deepgram later must be a data change, not a schema migration
 * plus a deploy. The validation that matters - does this provider exist, is
 * this model priced and enabled - happens in buildVoiceConfig, which is the
 * one place that can answer it against the database.
 */
const VoiceInput = z.object({
  voiceProvider: z.string().trim().min(1, "Chọn nhà cung cấp."),
  voiceModel: z.string().trim().min(1, "Chọn model."),
  voiceId: z.string().trim().min(1, "Chọn giọng."),
  voiceInstructions: z.string().trim().max(2000, "Hướng dẫn quá dài."),
  voiceSpeed: z.coerce
    .number()
    .min(0.25, "Tốc độ tối thiểu 0.25.")
    .max(4, "Tốc độ tối đa 4."),
  voiceGender: z.enum(["male", "female"]),
  voiceAccent: z.enum(["US", "UK"]),
});

export async function saveCharacterVoice(
  characterId: string,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = VoiceInput.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ.",
    };
  }
  try {
    await prisma.character.update({
      where: { id: characterId },
      // Voice does NOT bump the character version. Version tracks appearance,
      // so that images generated against an older description can be told
      // apart from current ones; a new voice invalidates no image.
      data: parsed.data,
    });
    revalidatePath("/characters");
    return { ok: true, message: "Đã lưu cấu hình giọng." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Voices this provider offers, for the dropdown. Never a paid call. */
export async function listVoices(provider: string, model: string) {
  try {
    const { getVoiceProvider } = await import("@/providers/registry");
    const p = await getVoiceProvider(provider, model);
    return { ok: true as const, voices: await p.listVoices() };
  } catch (err) {
    return { ok: false as const, message: errorMessage(err), voices: [] };
  }
}

/**
 * Speak one short line so the operator can hear the settings before committing
 * them to a whole project.
 *
 * This IS a paid call, so it says what it will cost, checks the cap, and writes
 * the charge to the ledger like everything else. A preview that quietly skips
 * the books is how a cap stops matching reality.
 */
export async function previewVoice(
  characterId: string,
  text: string,
): Promise<ActionResult & { audioPath?: string; cost?: number }> {
  const line = text.trim();
  if (line.length === 0) return { ok: false, message: "Nhập câu muốn nghe thử." };
  if (line.length > 300) {
    return { ok: false, message: "Câu nghe thử tối đa 300 ký tự." };
  }

  try {
    const character = await prisma.character.findUnique({ where: { id: characterId } });
    if (!character) return { ok: false, message: "Không tìm thấy nhân vật." };

    const { getVoiceProvider } = await import("@/providers/registry");
    const { assertCanSpend } = await import("@/services/spend-guard");
    const { recordCost } = await import("@/services/cost-tracker");
    const { toAbsolute, toRelative, uuidFilename } = await import("@/lib/paths");
    const path = await import("node:path");

    const provider = await getVoiceProvider(character.voiceProvider, character.voiceModel);
    const outputPath = toAbsolute(
      path.join("voice-preview", uuidFilename(".wav")),
    );

    const estimate = await provider.estimateCost({
      projectId: "preview",
      sceneId: "preview",
      model: character.voiceModel,
      text: line,
      voiceId: character.voiceId,
      instructions: character.voiceInstructions,
      accent: character.voiceAccent === "UK" ? "UK" : "US",
      gender: character.voiceGender === "female" ? "female" : "male",
      speed: character.voiceSpeed,
      targetDuration: 5,
      outputPath,
    });

    if (!isMockMode()) {
      await assertCanSpend({
        provider: character.voiceProvider,
        model: character.voiceModel,
        estimatedCost: estimate.amount,
      });
    }

    const job = await provider.createVoice({
      projectId: "preview",
      sceneId: "preview",
      model: character.voiceModel,
      text: line,
      voiceId: character.voiceId,
      instructions: character.voiceInstructions,
      accent: character.voiceAccent === "UK" ? "UK" : "US",
      gender: character.voiceGender === "female" ? "female" : "male",
      speed: character.voiceSpeed,
      targetDuration: 5,
      outputPath,
    });
    const asset = await provider.downloadResult(job.externalId);

    await recordCost({
      category: "voice",
      provider: character.voiceProvider,
      model: character.voiceModel,
      amount: asset.actualCost,
      note: `nghe thử giọng ${character.name}`,
    });

    revalidatePath("/characters");
    return {
      ok: true,
      message: `Đã tạo bản nghe thử (${asset.actualCost.toFixed(6)} USD).`,
      audioPath: toRelative(asset.filePath),
      cost: asset.actualCost,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
