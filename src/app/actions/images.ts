"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { errorMessage } from "@/lib/utils";
import { sceneCharacters } from "@/domain/scene-characters";
import { buildSceneImageRequest, generateSceneImage } from "@/services/generation";
import { uploadCharacterReference } from "@/services/character-master";
import { spendStatus } from "@/services/spend-guard";
import { estimateImageBatchCost, imagePolicyFor } from "@/services/image-quality";
import { toAbsolute } from "@/lib/paths";
import type { QualityMode } from "@/domain/enums";
import fs from "node:fs";
import type { ActionResult } from "./idioms";

/** Scene image review: inspect the prompt, regenerate, approve, promote. */

export interface SceneImagePreview {
  ok: boolean;
  message?: string;
  prompt?: string;
  negativePrompt?: string;
  referenceCount?: number;
  /** Names of characters whose approved master will be sent with the request. */
  referencedCharacters?: string[];
  /** Characters in the scene that have no approved master yet. */
  missingReferences?: string[];
  /** Everyone visible in frame - the list that decides who gets drawn. */
  charactersPresent?: string[];
  /** Only those with a line. Shown so presence and speech stay visibly apart. */
  speakingCharacters?: string[];
  primaryCharacters?: string[];
  /** Named in the scene text but absent from the list; added back by validation. */
  repairedCharacters?: string[];
  /** In frame, but their reference was dropped by the provider's limit. */
  droppedByLimit?: string[];
  estimatedCost?: number;
  spent?: number;
  cap?: number;
  mockMode?: boolean;
  policy?: string;
}

/**
 * Exactly what would be sent for this scene, and what it would cost.
 *
 * Free and read-only. It exists so the operator can see whether the character
 * references are actually attached *before* paying - a scene that silently
 * generated without them is the failure mode this whole step is guarding.
 */
export async function previewSceneImage(
  sceneId: string,
  modelId?: string,
): Promise<SceneImagePreview> {
  try {
    const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
    if (!scene) return { ok: false, message: "Không tìm thấy cảnh." };

    const project = await prisma.project.findUnique({
      where: { id: scene.projectId },
    });
    if (!project) return { ok: false, message: "Không tìm thấy dự án." };

    const shot = await buildSceneImageRequest(scene, project.stylePresetId);

    const chosen = modelId ?? scene.imageModel ?? "";
    const model = chosen
      ? await prisma.modelRegistry.findFirst({
          where: { modelId: chosen, type: "image" },
        })
      : await prisma.modelRegistry.findFirst({
          where: { type: "image", enabled: true },
          orderBy: { price: "asc" },
        });

    const policy = imagePolicyFor(project.qualityMode as QualityMode);
    const batch = estimateImageBatchCost({
      mode: project.qualityMode as QualityMode,
      imageCount: 1,
      pricePerImage: model?.price ?? 0,
    });
    const status = await spendStatus();

    const lists = sceneCharacters(scene);

    return {
      ok: true,
      prompt: shot.prompt,
      negativePrompt: shot.negativePrompt,
      referenceCount: shot.referenceImages.length,
      referencedCharacters: shot.referencedCharacters,
      missingReferences: shot.unreferencedCharacters,
      charactersPresent: shot.characters.map((c) => c.name),
      speakingCharacters: lists.speaking,
      primaryCharacters: lists.primary,
      repairedCharacters: shot.repairedCharacters,
      droppedByLimit: shot.droppedByLimit,
      estimatedCost: batch.total,
      spent: status.spent,
      cap: status.cap,
      mockMode: isMockMode(),
      policy: `${project.qualityMode}: ${policy.rationale}`,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * Generate this scene's image now, synchronously.
 *
 * Deliberately not queued: the operator is standing in front of the result
 * deciding whether to accept it, and a background job would hide the provider
 * error that explains why it failed.
 */
export async function regenerateSceneImageNow(
  sceneId: string,
  modelId?: string,
): Promise<ActionResult> {
  try {
    if (modelId) {
      const model = await prisma.modelRegistry.findFirst({
        where: { modelId, type: "image" },
      });
      if (!model) return { ok: false, message: "Không tìm thấy model ảnh." };
      // Pin the override on the scene so the router honours it rather than
      // re-deciding, and so the storyboard shows what was actually used.
      await prisma.scene.update({
        where: { id: sceneId },
        data: {
          imageProvider: model.provider,
          imageModel: model.modelId,
          routingMode: "MANUAL",
        },
      });
    }

    // A person pressed the button, so this is a REGENERATE: buy a new image
    // even though one is on disk. QĐ-072.
    const filePath = await generateSceneImage(sceneId, { force: true });
    const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
    revalidatePath(`/projects/${scene?.projectId ?? ""}`);

    if (!filePath) {
      return {
        ok: true,
        message:
          "Chế độ Tiết kiệm bỏ qua ảnh keyframe cho cảnh đơn giản này. Đổi sang Cân bằng nếu muốn có ảnh.",
      };
    }
    return {
      ok: true,
      message: `Đã tạo ảnh bằng ${scene?.imageProvider}/${scene?.imageModel}. Xem lại rồi bấm Duyệt nếu đạt.`,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Mark this scene's image as accepted. Does not start video generation. */
export async function approveSceneImage(
  sceneId: string,
  approved: boolean,
): Promise<ActionResult> {
  try {
    const scene = await prisma.scene.update({
      where: { id: sceneId },
      data: { approved },
    });
    revalidatePath(`/projects/${scene.projectId}`);
    return {
      ok: true,
      message: approved
        ? "Đã duyệt ảnh cảnh này. Video AI chưa chạy — bước đó cần bạn bấm riêng."
        : "Đã bỏ duyệt ảnh cảnh này.",
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * Promote a scene image into a character's reference set.
 *
 * Useful when a scene happens to draw the character better than the master did.
 * It arrives as an ordinary approved reference, not as the primary - promoting
 * it to master stays a separate, deliberate click.
 */
export async function promoteSceneImageToReference(
  sceneId: string,
  characterId: string,
): Promise<ActionResult> {
  try {
    const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
    if (!scene?.imagePath) {
      return { ok: false, message: "Cảnh này chưa có ảnh." };
    }

    const absolute = toAbsolute(scene.imagePath);
    if (!fs.existsSync(absolute)) {
      return { ok: false, message: "Không tìm thấy tệp ảnh trên đĩa." };
    }

    await uploadCharacterReference({
      characterId,
      fileName: "scene-reference.png",
      bytes: fs.readFileSync(absolute),
      notes: `Lấy từ cảnh ${scene.sceneNumber}`,
    });

    revalidatePath("/characters");
    revalidatePath(`/projects/${scene.projectId}`);
    return {
      ok: true,
      message:
        "Đã thêm vào bộ ảnh tham chiếu của nhân vật. Vào trang Nhân vật để đặt làm ảnh chuẩn nếu muốn.",
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export interface ImageCandidate {
  assetId: string;
  filePath: string;
  provider: string;
  model: string;
  actualCost: number;
  createdAt: string;
  /** True when this is the image the scene currently points at. */
  selected: boolean;
}

/**
 * Every image ever drawn for this scene.
 *
 * They are already kept as Asset rows, so "candidates" needs no new storage -
 * and it means an image the operator regenerated away is still recoverable
 * rather than paid for and lost.
 */
export async function listSceneCandidates(
  sceneId: string,
): Promise<ImageCandidate[]> {
  const [scene, assets] = await Promise.all([
    prisma.scene.findUnique({ where: { id: sceneId } }),
    prisma.asset.findMany({
      where: { sceneId, kind: "image" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return assets.map((a) => ({
    assetId: a.id,
    filePath: a.filePath,
    provider: a.provider,
    model: a.model,
    actualCost: a.actualCost,
    createdAt: a.createdAt.toLocaleString("vi-VN"),
    selected: scene?.imagePath === a.filePath,
  }));
}

/** Point the scene at one of its existing candidates. Costs nothing. */
export async function selectSceneCandidate(
  sceneId: string,
  assetId: string,
): Promise<ActionResult> {
  try {
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset || asset.sceneId !== sceneId) {
      return { ok: false, message: "Không tìm thấy ảnh này trong cảnh." };
    }
    const scene = await prisma.scene.update({
      where: { id: sceneId },
      data: {
        imagePath: asset.filePath,
        imageProvider: asset.provider,
        imageModel: asset.model,
        // Choosing a different image is a fresh decision, so the previous
        // approval no longer applies to what the scene now shows.
        approved: false,
      },
    });
    revalidatePath(`/projects/${scene.projectId}`);
    return { ok: true, message: "Đã chọn ảnh này cho cảnh. Không tốn thêm chi phí." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * Draw one more image for this scene, keeping the current one.
 *
 * The difference from regenerate is only in intent and wording: both cost the
 * same and both leave every earlier image in place as an Asset. This exists so
 * QUALITY mode can offer a second option without the system ever deciding on
 * its own to pay twice.
 */
export async function generateAlternative(
  sceneId: string,
  modelId?: string,
): Promise<ActionResult> {
  const result = await regenerateSceneImageNow(sceneId, modelId);
  if (!result.ok) return result;
  return {
    ok: true,
    message:
      "Đã tạo thêm một phương án. Ảnh cũ vẫn được giữ — so sánh rồi bấm chọn ảnh bạn muốn dùng.",
  };
}

/** Image models available for the model-switcher in the review panel. */
export async function listImageModelOptions(): Promise<
  { provider: string; modelId: string; displayName: string; price: number; enabled: boolean }[]
> {
  const models = await prisma.modelRegistry.findMany({
    where: { type: "image" },
    orderBy: [{ enabled: "desc" }, { price: "asc" }],
  });
  return models.map((m) => ({
    provider: m.provider,
    modelId: m.modelId,
    displayName: m.displayName,
    price: m.price,
    enabled: m.enabled,
  }));
}
