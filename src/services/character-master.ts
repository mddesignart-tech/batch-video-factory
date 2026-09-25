import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { sha256 } from "@/lib/crypto";
import { sniffImageType } from "@/lib/image-sniff";

export { sniffImageType };
import {
  DIRS,
  ensureDir,
  safeExtension,
  toAbsolute,
  toRelative,
  uuidFilename,
} from "@/lib/paths";
import { getImageProvider } from "@/providers/registry";
import { ProviderError } from "@/providers/types";
import { buildMasterPrompt, getCharacterSheet } from "./character-service";
import { recordCost } from "./cost-tracker";
import { assertCanSpend } from "./spend-guard";

/**
 * Character master images: generation, upload, approval.
 *
 * One rule governs this whole file, and it is the reason approval exists at
 * all: **an approved master is never replaced automatically.** Every later
 * scene is matched against that image, so silently swapping it would redraw
 * the character across every video that has not been rendered yet. New
 * generations always land as unapproved candidates; only a human promotes one.
 */

export interface MasterGenerationResult {
  referenceId: string;
  filePath: string;
  relativePath: string;
  bytes: number;
  actualCost: number;
  provider: string;
  model: string;
  prompt: string;
  /** True when an approved master already existed and was left untouched. */
  keptExistingPrimary: boolean;
}

/** Portrait keyframe shape. Masters are generated at the video's aspect ratio. */
const MASTER_WIDTH = 1024;
const MASTER_HEIGHT = 1536;

export async function generateCharacterMaster(input: {
  characterId: string;
  provider: string;
  model: string;
  stylePresetId?: string | null;
  /** Overrides the assembled prompt. Used by the "edit prompt" control. */
  promptOverride?: string;
}): Promise<MasterGenerationResult> {
  const sheet = await getCharacterSheet(input.characterId);
  if (!sheet) {
    throw new Error(`Không tìm thấy nhân vật ${input.characterId}`);
  }

  const stylePrompt = await resolveStylePrompt(input.stylePresetId ?? null);
  const prompt =
    input.promptOverride?.trim() || buildMasterPrompt(sheet, stylePrompt);

  const provider = await getImageProvider(input.provider, input.model);
  const outputPath = path.join(
    ensureDir(path.join(DIRS.characters, safeSegmentName(sheet.name))),
    uuidFilename(".png"),
  );

  const estimate = await provider.estimateCost({
    projectId: "",
    sceneId: "",
    model: input.model,
    prompt,
    negativePrompt: sheet.negative,
    width: MASTER_WIDTH,
    height: MASTER_HEIGHT,
    referenceImages: [],
    outputPath,
  });

  // Every safety layer runs before the call, never after: mock gate, app-wide
  // cap, then this provider/model having been confirmed by a human.
  await assertCanSpend({
    provider: input.provider,
    model: input.model,
    estimatedCost: estimate.amount,
  });

  const key = masterIdempotencyKey({
    characterId: sheet.id,
    version: sheet.version,
    provider: input.provider,
    model: input.model,
    prompt,
  });

  // A row already carrying this key means the identical master - same
  // character, same version, same model, same prompt - was already paid for.
  // Refusing here is the duplicate-payment guard doing its job, and it must say
  // so in words rather than surfacing a raw unique-constraint error.
  const duplicate = await prisma.providerJob.findUnique({
    where: { idempotencyKey: key },
  });
  if (duplicate) {
    throw new Error(
      `Ảnh chuẩn với đúng prompt này đã được tạo rồi (phiên bản v${sheet.version} ` +
        `của ${sheet.name}, model ${input.model}), nên không gọi API lần nữa để ` +
        `khỏi trả tiền hai lần. Hãy dùng ảnh ứng viên đã có, hoặc sửa mô tả ` +
        `ngoại hình / prompt để tạo một ảnh khác.`,
    );
  }

  const job = await prisma.providerJob.create({
    data: {
      kind: "image",
      provider: input.provider,
      model: input.model,
      status: "processing",
      idempotencyKey: key,
      requestJson: JSON.stringify({ promptHash: sha256(prompt) }),
      estimatedCost: estimate.amount,
    },
  });

  try {
    const created = await provider.createImage({
      projectId: "",
      sceneId: "",
      model: input.model,
      prompt,
      negativePrompt: sheet.negative,
      width: MASTER_WIDTH,
      height: MASTER_HEIGHT,
      seed: sheet.seed ?? undefined,
      referenceImages: [],
      outputPath,
    });
    const asset = await provider.downloadResult(created.externalId);

    await prisma.providerJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        externalId: created.externalId,
        actualCost: asset.actualCost,
        durationMs: asset.generationTimeMs,
        completedAt: new Date(),
      },
    });

    await recordCost({
      category: "image",
      provider: input.provider,
      model: input.model,
      amount: asset.actualCost,
      note: `Character Master: ${sheet.name} (v${sheet.version})`,
    });

    const existingPrimary = await prisma.characterReference.findFirst({
      where: { characterId: sheet.id, isPrimary: true, approved: true },
    });

    const reference = await prisma.characterReference.create({
      data: {
        characterId: sheet.id,
        filePath: toRelative(asset.filePath),
        source: "generated",
        // Never approved on creation, and never primary while an approved
        // master exists. A human decides what the character looks like.
        approved: false,
        isPrimary: false,
        provider: input.provider,
        model: input.model,
        prompt,
        characterVersion: sheet.version,
        width: MASTER_WIDTH,
        height: MASTER_HEIGHT,
        bytes: asset.bytes,
        notes: existingPrimary
          ? "Ứng viên mới. Ảnh chuẩn hiện tại vẫn được giữ nguyên."
          : "Ứng viên đầu tiên. Cần duyệt trước khi dùng làm ảnh chuẩn.",
      },
    });

    await logger.info({
      event: "character.master_generated",
      provider: input.provider,
      model: input.model,
      message:
        `Đã tạo ứng viên ảnh chuẩn cho ${sheet.name}` +
        (existingPrimary ? " (giữ nguyên ảnh chuẩn cũ)" : ""),
      data: { characterId: sheet.id, referenceId: reference.id },
    });

    return {
      referenceId: reference.id,
      filePath: asset.filePath,
      relativePath: reference.filePath,
      bytes: asset.bytes,
      actualCost: asset.actualCost,
      provider: input.provider,
      model: input.model,
      prompt,
      keptExistingPrimary: existingPrimary !== null,
    };
  } catch (err) {
    // A call that failed after the provider billed still has to reach the
    // ledger, or the spend cap quietly refunds itself.
    const charged =
      err instanceof ProviderError && err.usage ? err.usage.actualCost : 0;

    await prisma.providerJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        actualCost: charged,
        error: err instanceof Error ? err.message.slice(0, 500) : "unknown",
      },
    });

    if (charged > 0) {
      await recordCost({
        category: "image",
        provider: input.provider,
        model: input.model,
        amount: charged,
        note: `Character Master thất bại nhưng đã bị tính phí: ${sheet.name}`,
      });
    }
    throw err;
  }
}

/** Store an uploaded reference image. The file goes to disk, never to SQLite. */
export async function uploadCharacterReference(input: {
  characterId: string;
  fileName: string;
  bytes: Buffer;
  notes?: string;
}): Promise<{ referenceId: string; relativePath: string }> {
  const character = await prisma.character.findUnique({
    where: { id: input.characterId },
  });
  if (!character) {
    throw new Error(`Không tìm thấy nhân vật ${input.characterId}`);
  }
  if (input.bytes.byteLength === 0) {
    throw new Error("Tệp rỗng.");
  }

  // safeExtension falls back silently by design, which is right for building a
  // path but wrong for validation - it would turn "virus.exe" into a .png and
  // accept it. So the real extension is checked first, then the bytes, because
  // a filename is a claim and the file's own header is evidence.
  const claimed = path.extname(input.fileName).toLowerCase();
  const sniffed = sniffImageType(input.bytes);

  if (!IMAGE_EXTENSIONS.has(claimed)) {
    throw new Error(
      `Định dạng ${claimed || "(không rõ)"} không được hỗ trợ. Dùng PNG, JPG hoặc WEBP.`,
    );
  }
  if (sniffed === null) {
    throw new Error(
      "Nội dung tệp không phải ảnh PNG, JPG hay WEBP dù tên tệp nói vậy.",
    );
  }
  const ext = safeExtension(sniffed, ".png");

  const dir = ensureDir(path.join(DIRS.characters, safeSegmentName(character.name)));
  const absolute = path.join(dir, uuidFilename(ext));
  fs.writeFileSync(absolute, input.bytes);

  const reference = await prisma.characterReference.create({
    data: {
      characterId: character.id,
      filePath: toRelative(absolute),
      source: "upload",
      // A human chose this file, so it is trusted on arrival - but it still
      // does not become primary without an explicit promotion.
      approved: true,
      isPrimary: false,
      characterVersion: character.version,
      bytes: input.bytes.byteLength,
      notes: input.notes ?? "",
    },
  });

  return { referenceId: reference.id, relativePath: reference.filePath };
}

/**
 * Approve a reference and make it the character's master.
 *
 * This is the only way a primary reference ever changes. Demoting the previous
 * one in the same transaction keeps "exactly one primary" true at all times.
 */
export async function approveCharacterReference(referenceId: string): Promise<void> {
  const reference = await prisma.characterReference.findUnique({
    where: { id: referenceId },
  });
  if (!reference) throw new Error("Không tìm thấy ảnh tham chiếu.");

  await prisma.$transaction([
    prisma.characterReference.updateMany({
      where: { characterId: reference.characterId, isPrimary: true },
      data: { isPrimary: false },
    }),
    prisma.characterReference.update({
      where: { id: referenceId },
      data: { approved: true, isPrimary: true },
    }),
  ]);

  await logger.info({
    event: "character.master_approved",
    message: "Đã duyệt ảnh chuẩn mới cho nhân vật.",
    data: { characterId: reference.characterId, referenceId },
  });
}

/** Remove a reference and its file. */
export async function deleteCharacterReference(referenceId: string): Promise<void> {
  const reference = await prisma.characterReference.findUnique({
    where: { id: referenceId },
  });
  if (!reference) return;

  await prisma.characterReference.delete({ where: { id: referenceId } });

  try {
    const absolute = toAbsolute(reference.filePath);
    if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
  } catch (err) {
    // The row is gone either way; a stranded file is cleaned up by the media
    // cleanup job rather than failing the user's delete.
    await logger.warn({
      event: "character.reference_file_orphaned",
      message: `Không xoá được tệp ảnh tham chiếu: ${
        err instanceof Error ? err.message : "unknown"
      }`,
      data: { referenceId },
    });
  }
}

/**
 * Idempotency key for a master generation.
 *
 * Includes the character version, so editing the description legitimately
 * allows a fresh generation, while pressing the button twice on an unchanged
 * character does not pay twice.
 */
export function masterIdempotencyKey(input: {
  characterId: string;
  version: number;
  provider: string;
  model: string;
  prompt: string;
}): string {
  return sha256(
    [
      input.characterId,
      "master",
      String(input.version),
      input.provider,
      input.model,
      sha256(input.prompt),
    ].join("|"),
  );
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function safeSegmentName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "character";
}

async function resolveStylePrompt(stylePresetId: string | null): Promise<string> {
  const preset = stylePresetId
    ? await prisma.stylePreset.findUnique({ where: { id: stylePresetId } })
    : await prisma.stylePreset.findFirst({ where: { isDefault: true } });

  if (!preset) return "consistent 3D cartoon style, bright colours, soft even lighting";
  return [
    preset.positivePrompt,
    preset.lightingStyle,
    preset.visualTone,
  ]
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join(", ");
}
