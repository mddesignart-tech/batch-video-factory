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
  applySheetEdit,
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
  // The Character Bible fields. NONE of them is required - in particular not
  // age or skin tone, which are often genuinely unknown and which an operator
  // may leave blank or write "unknown" in. QĐ-072.
  presentation: z.string().default(""),
  approximateAge: z.string().default(""),
  skinTone: z.string().default(""),
  distinguishingFeatures: z.string().default(""),
  negativeIdentity: z.string().default(""),
});

/**
 * Save the detailed appearance fields.
 *
 * Bumps `version` when the IDENTITY FINGERPRINT moves, so images generated
 * against the old description stay distinguishable from current ones - and so
 * the idempotency key changes, allowing a legitimate regeneration.
 *
 * The fingerprint rather than a field-by-field diff, because the question being
 * asked is "does this character look different now?" and only the appearance
 * fields answer it. A version bumped for an edit that changed nothing visible
 * is how an approved reference image starts reading as stale. QĐ-072.
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

    // One rule, shared with the import screen's inline editor. Nothing here
    // writes an image and nothing here touches a reference row.
    const edit = applySheetEdit(current, parsed.data);

    await prisma.character.update({
      where: { id: characterId },
      data: { ...edit.data, version: edit.version },
    });
    const changed = edit.changed;

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
 * CHARACTER VOICE MANAGER (QĐ-158): a voice is chosen per language, from the
 * voices the engine really has.
 *
 * Provider, model and voice still come in as strings - but a save is checked
 * against the Voice Catalog (the running Mind Voice's own list, OpenAI's fixed
 * list) and a voice that model does not have is refused, never stored. Gender
 * comes from the catalog when the source states it.
 */
const VoiceInput = z.object({
  locale: z.enum(["vi-VN", "en", "en-US", "en-GB"], { message: "Chọn ngôn ngữ." }),
  voiceProvider: z.string().trim().min(1, "Chọn nhà cung cấp."),
  voiceModel: z.string().trim().min(1, "Chọn model."),
  voiceId: z.string().trim().min(1, "Chọn giọng."),
  voiceInstructions: z.string().trim().max(2000, "Hướng dẫn quá dài.").default(""),
  voiceSpeed: z.coerce
    .number()
    .min(0.25, "Tốc độ tối thiểu 0.25.")
    .max(4, "Tốc độ tối đa 4."),
  voiceGender: z.enum(["male", "female"]).default("male"),
  /** "on" = this language becomes the character's main voice. */
  makeMain: z.string().optional(),
});

/** The voices a character can have in one language. Free: at most a question to the local Mind Voice. */
export async function voiceCatalogAction(locale: string, refresh = false) {
  const { isVoiceLocale } = await import("@/domain/voice-locale");
  if (!isVoiceLocale(locale)) return { ok: false as const, message: "Ngôn ngữ không hợp lệ." };
  try {
    const { voiceCatalogFor } = await import("@/services/voice-catalog");
    return { ok: true as const, message: "", catalog: await voiceCatalogFor(locale, { refresh }) };
  } catch (err) {
    return { ok: false as const, message: errorMessage(err) };
  }
}

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
  const input = parsed.data;
  try {
    const character = await prisma.character.findUnique({ where: { id: characterId } });
    if (!character) return { ok: false, message: "Không tìm thấy nhân vật." };
    const { voiceCatalogFor, checkVoiceChoice } = await import("@/services/voice-catalog");
    const { withProfile, voiceLocaleOf } = await import("@/domain/voice-locale");
    const check = checkVoiceChoice(await voiceCatalogFor(input.locale), input.voiceProvider, input.voiceModel, input.voiceId);
    if (!check.ok) return { ok: false, message: `Chưa lưu: ${check.message}` };
    if (input.voiceProvider === "mindvoice") await (await import("@/services/mind-voice-catalog")).ensureMindRegistry();
    const speed = Math.min(check.model.speed.max, Math.max(check.model.speed.min, input.voiceSpeed));
    const data = withProfile(
      character,
      input.locale,
      {
        provider: input.voiceProvider,
        model: input.voiceModel,
        voiceId: input.voiceId,
        speed,
        // Kept as typed even when this model ignores it: switching back must not lose it.
        instructions: input.voiceInstructions,
        gender: check.voice.gender ?? input.voiceGender,
      },
      input.makeMain === "on",
    );
    await prisma.character.update({
      where: { id: characterId },
      // Voice does NOT bump the character version. Version tracks appearance,
      // so that images generated against an older description can be told
      // apart from current ones; a new voice invalidates no image.
      data,
    });
    revalidatePath("/characters");
    const main = data.voiceLanguage === input.locale ? " (ngôn ngữ chính)" : "";
    const clamped = speed !== input.voiceSpeed ? ` Tốc độ đưa về ${speed} (giới hạn của model).` : "";
    return { ok: true, message: `Đã lưu giọng ${check.voice.label} cho ${voiceLocaleOf(input.locale).label}${main}.${clamped}` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Remove the voice of one of the character's OTHER languages. No audio is deleted. */
export async function removeCharacterVoiceProfile(characterId: string, locale: string): Promise<ActionResult> {
  try {
    const { isVoiceLocale, withoutProfile } = await import("@/domain/voice-locale");
    if (!isVoiceLocale(locale)) return { ok: false, message: "Ngôn ngữ không hợp lệ." };
    const character = await prisma.character.findUnique({ where: { id: characterId } });
    if (!character) return { ok: false, message: "Không tìm thấy nhân vật." };
    const data = withoutProfile(character, locale);
    if (!data) return { ok: false, message: "Đây là giọng chính - hãy chọn giọng khác thay vì xoá." };
    await prisma.character.update({ where: { id: characterId }, data });
    revalidatePath("/characters");
    return { ok: true, message: `Đã bỏ giọng ${locale}. File âm thanh đã tạo không bị xoá.` };
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

interface PreviewSettings {
  provider: string;
  model: string;
  voiceId: string;
  instructions: string;
  speed: number;
  gender: "male" | "female";
  accent: "US" | "UK";
  /** Language sent to an engine that takes one (Mind Voice). */
  language?: "vi" | "en";
}

type PreviewResult = ActionResult & { audioPath?: string; cost?: number; needsConfirmation?: boolean };

/**
 * Speak one short line so the operator can hear the settings before committing
 * them to a whole project.
 *
 * A paid voice says what it will cost, checks the cap, and writes the charge to
 * the ledger like everything else. A preview that quietly skips the books is
 * how a cap stops matching reality. With `requireConfirm`, a paid line is not
 * sent until the caller passes back the exact price it was shown (QĐ-158).
 */
async function speakPreview(
  characterName: string,
  line: string,
  voice: PreviewSettings,
  opts: { requireConfirm?: boolean; confirmedCost?: number } = {},
): Promise<PreviewResult> {
  const { getVoiceProvider } = await import("@/providers/registry");
  const { assertCanSpend } = await import("@/services/spend-guard");
  const { recordCost } = await import("@/services/cost-tracker");
  const { toAbsolute, toRelative, uuidFilename } = await import("@/lib/paths");
  const path = await import("node:path");

  const fs = await import("node:fs");
  const { voiceReuseKey } = await import("@/services/asset-keys");
  const { acquireAssetCreationLock, findReusableAsset } = await import("@/services/asset-reuse");
  const { isFreeVoiceProvider } = await import("@/providers/voice-config");

  // In Mock Mode the registry speaks with the mock voice whatever the
  // character says; the key and the ledger name what really spoke.
  const free = isFreeVoiceProvider(voice.provider);
  const spokenBy = isMockMode() && !free ? "mock" : voice.provider;
  const settings = {
    model: voice.model,
    text: line,
    voiceId: voice.voiceId,
    instructions: voice.instructions,
    accent: voice.accent,
    gender: voice.gender,
    speed: voice.speed,
    targetDuration: 5,
    ...(voice.language ? { language: voice.language } : {}),
  };
  const key = voiceReuseKey({ provider: spokenBy, ...settings });

  // The same sentence in the same voice is the same audio: play it again at
  // $0. Held across the purchase, so a double click buys it once.
  const release = await acquireAssetCreationLock(`preview:${key}`);
  try {
    const indexPath = toAbsolute(path.join("voice-preview", "index.json"));
    const index = readPreviewIndex(fs, indexPath);
    const known = index[key];
    if (known && fs.existsSync(toAbsolute(known))) {
      return { ok: true, message: "Dùng lại bản nghe thử đã có (cùng câu, cùng giọng) - 0 TTS POST, $0.", audioPath: known, cost: 0 };
    }
    const library = await findReusableAsset({ reuseKey: key });
    if (library.status === "REUSE") {
      return { ok: true, message: "Câu này đã có trong thư viện - phát lại, 0 TTS POST, $0.", audioPath: library.asset.filePath, cost: 0 };
    }

    const provider = await getVoiceProvider(voice.provider, voice.model);
    const outputPath = toAbsolute(path.join("voice-preview", uuidFilename(".wav")));
    const request = { projectId: "preview", sceneId: "preview", ...settings, outputPath };
    const estimate = await provider.estimateCost(request);

    // A free local voice (CIT, Mind Voice) spends nothing: no cap, no
    // confirmation - the same rule generation.ts applies to a scene line.
    if (!isMockMode() && !free) {
      if (opts.requireConfirm && (opts.confirmedCost === undefined || Math.abs(opts.confirmedCost - estimate.amount) > 1e-9)) {
        return {
          ok: false,
          needsConfirmation: true,
          cost: estimate.amount,
          message: `Nghe thử bằng ${voice.provider}/${voice.model} là lệnh gọi API TRẢ PHÍ: ~$${estimate.amount.toFixed(6)}. Bấm xác nhận để gửi.`,
        };
      }
      await assertCanSpend({
        provider: voice.provider,
        model: voice.model,
        estimatedCost: estimate.amount,
      });
    }

    const job = await provider.createVoice(request);
    const asset = await provider.downloadResult(job.externalId);

    // Local generation is not a purchase: no ledger line (as in generation.ts).
    if (!free) await recordCost({
      category: "voice",
      provider: spokenBy,
      model: isMockMode() ? "mock-voice" : voice.model,
      amount: asset.actualCost,
      note: `nghe thử giọng ${characterName}`,
    });
    index[key] = toRelative(asset.filePath);
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

    revalidatePath("/characters");
    return {
      ok: true,
      message: free
        ? "Đã tạo bản nghe thử tại máy - $0 API."
        : `Đã tạo bản nghe thử (${asset.actualCost.toFixed(6)} USD${isMockMode() ? ", Mock Mode - giá giả lập" : ""}).`,
      audioPath: toRelative(asset.filePath),
      cost: asset.actualCost,
    };
  } finally {
    release();
  }
}

function checkLine(text: string): string | null {
  const line = text.trim();
  if (line.length === 0) return "Nhập câu muốn nghe thử.";
  if (line.length > 300) return "Câu nghe thử tối đa 300 ký tự.";
  return null;
}

/** Preview the character's SAVED main voice (kept for older callers). */
export async function previewVoice(characterId: string, text: string): Promise<PreviewResult> {
  const bad = checkLine(text);
  if (bad) return { ok: false, message: bad };
  try {
    const character = await prisma.character.findUnique({ where: { id: characterId } });
    if (!character) return { ok: false, message: "Không tìm thấy nhân vật." };
    return await speakPreview(character.name, text.trim(), {
      provider: character.voiceProvider,
      model: character.voiceModel,
      voiceId: character.voiceId,
      instructions: character.voiceInstructions,
      accent: character.voiceAccent === "UK" ? "UK" : "US",
      gender: character.voiceGender === "female" ? "female" : "male",
      speed: character.voiceSpeed,
    });
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * Preview the voice being CHOSEN, before it is saved (QĐ-158). The choice is
 * checked against the catalog first; a paid voice is sent only with the exact
 * price the person confirmed. A stopped Mind Voice answers with its guide -
 * never with another provider.
 */
export async function previewVoiceChoice(
  characterId: string,
  choice: { locale: string; provider: string; model: string; voiceId: string; speed: number; instructions: string; text: string },
  confirmedCost?: number,
): Promise<PreviewResult> {
  const bad = checkLine(choice.text);
  if (bad) return { ok: false, message: bad };
  try {
    const { isVoiceLocale, voiceLocaleOf } = await import("@/domain/voice-locale");
    if (!isVoiceLocale(choice.locale)) return { ok: false, message: "Chọn ngôn ngữ." };
    const character = await prisma.character.findUnique({ where: { id: characterId } });
    if (!character) return { ok: false, message: "Không tìm thấy nhân vật." };
    const { voiceCatalogFor, checkVoiceChoice } = await import("@/services/voice-catalog");
    const check = checkVoiceChoice(await voiceCatalogFor(choice.locale), choice.provider, choice.model, choice.voiceId);
    if (!check.ok) return { ok: false, message: check.message };
    const locale = voiceLocaleOf(choice.locale);
    const speed = Math.min(check.model.speed.max, Math.max(check.model.speed.min, Number(choice.speed) || 1));
    return await speakPreview(
      character.name,
      choice.text.trim(),
      {
        provider: choice.provider,
        model: choice.model,
        voiceId: choice.voiceId,
        // A model without free-text direction is not sent one (it would be ignored, or read).
        instructions: check.model.supportsInstructions ? choice.instructions : "",
        accent: locale.accent ?? "US",
        gender: check.voice.gender ?? "male",
        speed,
        language: locale.family,
      },
      { requireConfirm: true, confirmedCost },
    );
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Preview index: reuse key -> relative file. A broken index is an empty one. */
function readPreviewIndex(fs: typeof import("node:fs"), file: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
