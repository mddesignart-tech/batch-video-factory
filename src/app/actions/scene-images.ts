"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { errorMessage } from "@/lib/utils";
import { planSceneImageMapping } from "@/domain/scene-image-mapping";
import {
  IMAGE_FITS,
  importSceneImage,
  importedAssetsForScene,
  removeSceneImage,
  useExistingImportedAsset,
  type ImageFit,
} from "@/services/imported-image";
import { stageUpload } from "@/services/import-staging";
import type { ActionResult } from "./idioms";

/**
 * Supplying keyframes by hand - per scene, or many at once by file name.
 *
 * None of these can reach an image provider. They store the file, record it as
 * an IMPORTED asset and attach it; the only money a scene can cost afterwards is
 * voice and (for VIDEO_AI) its clip. IMPORTED IMAGE = REUSE = $0 IMAGE API COST.
 *
 * Replacing a picture that already exists needs `confirmReplace`: the page asks
 * first, and the server refuses without it, so a stray click on the wrong scene
 * cannot silently swap an image (or drop the clip made from it).
 */

function fitOf(value: FormDataEntryValue | null): ImageFit {
  const v = String(value ?? "auto");
  return (IMAGE_FITS as readonly string[]).includes(v) ? (v as ImageFit) : "auto";
}

async function fileBytes(entry: FormDataEntryValue | null): Promise<{ name: string; bytes: Buffer } | null> {
  if (!entry || typeof entry === "string") return null;
  return { name: entry.name, bytes: Buffer.from(await entry.arrayBuffer()) };
}

function consequence(r: { clipDropped: boolean; needsRerender: boolean }): string {
  return (
    (r.clipDropped ? " Clip AI cũ (dựng từ ảnh trước) đã bị bỏ — cảnh VIDEO_AI sẽ cần clip mới." : "") +
    (r.needsRerender ? " Video cuối đang dùng ảnh cũ — bấm Render lại MP4." : "")
  );
}

export async function importImageForScene(formData: FormData): Promise<ActionResult> {
  try {
    const sceneId = String(formData.get("sceneId") ?? "");
    const file = await fileBytes(formData.get("file"));
    if (!file) return { ok: false, message: "Chưa chọn ảnh." };
    const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
    if (!scene) return { ok: false, message: "Không tìm thấy cảnh." };
    if (scene.imagePath && formData.get("confirmReplace") !== "yes") {
      return {
        ok: false,
        message: `Cảnh ${scene.sceneNumber} đã có ảnh. Xác nhận "Thay ảnh hiện tại?" để thay.`,
      };
    }
    const result = await importSceneImage({
      sceneId,
      bytes: file.bytes,
      originalFilename: file.name,
      fit: fitOf(formData.get("fit")),
      via: "upload",
    });
    revalidatePath(`/projects/${scene.projectId}`);
    return {
      ok: true,
      message:
        `Cảnh ${scene.sceneNumber} dùng ảnh nhập "${file.name}" ` +
        `(${result.stored.asset.width}x${result.stored.asset.height}, khung: ${result.stored.framing}). ` +
        `Không gọi Image API — $0.` + consequence(result),
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function removeImportedImage(sceneId: string): Promise<ActionResult> {
  try {
    const scene = await removeSceneImage(sceneId);
    revalidatePath(`/projects/${scene.projectId}`);
    return {
      ok: true,
      message:
        `Đã bỏ ảnh khỏi cảnh ${scene.sceneNumber}. Ảnh cũ vẫn được giữ trong lịch sử. ` +
        `Lần chạy tới cảnh này sẽ TẠO ảnh bằng Image AI (có tính phí, sẽ hiện trong dự toán).`,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export interface SceneImageHistoryItem {
  assetId: string;
  originalFilename: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  active: boolean;
  filePath: string;
}

export async function sceneImageHistory(sceneId: string): Promise<SceneImageHistoryItem[]> {
  const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
  const assets = await importedAssetsForScene(sceneId);
  return assets.map((a) => ({
    assetId: a.id,
    originalFilename: a.originalFilename,
    width: a.width,
    height: a.height,
    createdAt: a.createdAt.toISOString(),
    active: scene?.imageAssetId === a.id,
    filePath: a.filePath,
  }));
}

export async function useEarlierImportedImage(
  sceneId: string,
  assetId: string,
): Promise<ActionResult> {
  try {
    const result = await useExistingImportedAsset(sceneId, assetId);
    revalidatePath(`/projects/${result.scene.projectId}`);
    return {
      ok: true,
      message: `Cảnh ${result.scene.sceneNumber} dùng lại ảnh nhập trước đó. $0.` + consequence(result),
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export interface BulkImportResult extends ActionResult {
  applied?: { sceneNumber: number; fileName: string }[];
  skipped?: { fileName: string; reason: string }[];
}

/**
 * Many pictures at once, mapped to scenes by file name (Mode B).
 *
 * The mapping is recomputed here from the names the server actually received,
 * with the same function the page used for its preview - the client never gets
 * to say "put this file on that scene" on its own authority. Scenes that
 * already have a picture are only touched with `confirmReplace`.
 */
export async function importImagesForProject(formData: FormData): Promise<BulkImportResult> {
  try {
    const projectId = String(formData.get("projectId") ?? "");
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { scenes: { where: { skipped: false }, orderBy: { sceneNumber: "asc" } } },
    });
    if (!project) return { ok: false, message: "Không tìm thấy dự án." };

    const entries = formData.getAll("files");
    const files: { name: string; bytes: Buffer }[] = [];
    for (const e of entries) {
      const f = await fileBytes(e);
      if (f) files.push(f);
    }
    if (files.length === 0) return { ok: false, message: "Chưa chọn ảnh nào." };

    const plan = planSceneImageMapping(
      files.map((f) => f.name),
      project.scenes.map((s) => s.sceneNumber),
    );
    const replace = formData.get("confirmReplace") === "yes";
    const fit = fitOf(formData.get("fit"));
    const applied: { sceneNumber: number; fileName: string }[] = [];
    const skipped: { fileName: string; reason: string }[] = plan.files
      .filter((f) => f.status !== "MAPPED")
      .map((f) => ({ fileName: f.fileName, reason: f.reason }));

    for (const [sceneNumber, fileName] of plan.bySceneNumber) {
      const scene = project.scenes.find((s) => s.sceneNumber === sceneNumber)!;
      if (scene.imagePath && !replace) {
        skipped.push({ fileName, reason: `Cảnh ${sceneNumber} đã có ảnh — chưa xác nhận thay.` });
        continue;
      }
      const file = files.find((f) => f.name === fileName)!;
      try {
        await importSceneImage({
          sceneId: scene.id,
          bytes: file.bytes,
          originalFilename: file.name,
          fit,
          via: "upload",
        });
        applied.push({ sceneNumber, fileName });
      } catch (err) {
        // One bad file names itself and stops only itself.
        skipped.push({ fileName, reason: errorMessage(err) });
      }
    }

    revalidatePath(`/projects/${projectId}`);
    return {
      ok: applied.length > 0,
      message:
        `Đã gắn ${applied.length} ảnh nhập, bỏ qua ${skipped.length} file. Không gọi Image API — $0.` +
        (plan.scenesWithoutFile.length > 0
          ? ` Cảnh chưa có file: ${plan.scenesWithoutFile.join(", ")}.`
          : ""),
      applied,
      skipped,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export interface StageResult extends ActionResult {
  source?: string;
  fileCount?: number;
}

/**
 * Upload a storyboard (folder, many files or one ZIP) from the browser into a
 * staging folder under data/, and hand back the path the existing importer
 * reads. Nothing is imported yet - the page runs KIỂM TRA on the result.
 */
export async function stageStoryboardUpload(formData: FormData): Promise<StageResult> {
  try {
    const entries = formData.getAll("files");
    const paths = formData.getAll("paths").map(String);
    const files: { relativePath: string; bytes: Buffer }[] = [];
    for (const [i, e] of entries.entries()) {
      const f = await fileBytes(e);
      if (f) files.push({ relativePath: paths[i] || f.name, bytes: f.bytes });
    }
    const staged = stageUpload(files);
    return {
      ok: true,
      message: `Đã tải lên ${staged.fileCount} file (${(staged.bytes / 1024 / 1024).toFixed(1)} MB).`,
      source: staged.source,
      fileCount: staged.fileCount,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
