"use server";

import path from "node:path";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { hasErrors, type ImportIssue } from "@/domain/storyboard";
import {
  materialiseImport,
  scanImportSource,
  validateImport,
} from "@/services/storyboard-import";
import { preflightImportedBatch, type ImportPreflight } from "@/services/import-preflight";

/**
 * Server actions for the storyboard import screen.
 *
 * ## Why a path rather than an upload
 *
 * This app runs on the operator's own machine, beside the folders the
 * storyboards and keyframes already live in. Asking the browser to upload a
 * 200MB folder so the server can write it back to disk two directories away
 * would add a copy, a temp-file lifecycle and an upload limit, and buy nothing.
 * A path is read directly - and every unsafe entry inside it is still refused
 * by `scanImportSource`, because the danger was never the transport.
 *
 * ## None of these can spend
 *
 * Validate and estimate are reads. Create writes rows and leaves the batch
 * `PLANNED` with a `DRAFT` authorisation, which permits nothing. Approving an
 * amount happens on the batch page, through the same gate a V1 batch uses -
 * there is deliberately no "import and run" button.
 */

export interface ImportValidationView {
  ok: boolean;
  sourceKind: string;
  sourceLabel: string;
  videos: {
    videoId: string;
    title: string;
    sceneCount: number;
    suppliedImages: number;
    missingImages: number;
    localMotion: number;
    videoAi: number;
    auto: number;
    scenes: {
      sceneNumber: number;
      duration: number;
      motionMode: string;
      complexity: string;
      priority: string;
      keyframe: string;
      pin: string | null;
      visual: string;
      dialogue: string;
    }[];
  }[];
  issues: ImportIssue[];
  errorCount: number;
  warningCount: number;
}

export async function validateStoryboardSource(
  source: string,
): Promise<ImportValidationView> {
  const scan = scanImportSource(path.resolve(source.trim()));
  const validated = await validateImport(scan);

  return {
    ok: !hasErrors(validated.issues) && validated.videos.length > 0,
    sourceKind: scan.sourceKind,
    sourceLabel: scan.sourceLabel,
    videos: validated.videos.map((v) => ({
      videoId: v.videoId,
      title: v.title,
      sceneCount: v.scenes.length,
      suppliedImages: v.suppliedImages,
      missingImages: v.missingImages,
      localMotion: v.localMotionScenes,
      videoAi: v.videoAiScenes,
      auto: v.autoScenes,
      scenes: v.scenes.map((s) => ({
        sceneNumber: s.scene.sceneNumber,
        duration: s.scene.duration,
        motionMode: s.scene.motionMode,
        complexity: s.complexity,
        priority: s.priority,
        keyframe: s.asset ? "có sẵn" : "sẽ tạo",
        pin:
          s.scene.videoProvider && s.scene.videoModel
            ? `${s.scene.videoProvider}/${s.scene.videoModel}`
            : null,
        visual: s.scene.visualDescription,
        dialogue: s.scene.dialogue,
      })),
    })),
    issues: validated.issues,
    errorCount: validated.issues.filter((i) => i.level === "error").length,
    warningCount: validated.issues.filter((i) => i.level === "warning").length,
  };
}

export interface CreateImportResult {
  ok: boolean;
  message: string;
  batchId?: string;
  preflight?: ImportPreflight;
}

/**
 * Create the batch and price it. Still authorises nothing.
 *
 * The two halves are one call because a batch with rows but no plan is a state
 * the batch page cannot show honestly - it would display a video list beside an
 * empty estimate, which reads as "free".
 */
export async function createImportBatch(input: {
  source: string;
  name: string;
  maxCostPerVideo: number;
  maxCostForBatch: number;
}): Promise<CreateImportResult> {
  try {
    const scan = scanImportSource(path.resolve(input.source.trim()));
    const validated = await validateImport(scan);
    if (hasErrors(validated.issues)) {
      return {
        ok: false,
        message:
          `Còn ${validated.issues.filter((i) => i.level === "error").length} lỗi trong bản nhập. ` +
          "Hãy sửa hết rồi nhập lại — không tạo lô từ dữ liệu sai.",
      };
    }
    if (validated.videos.length === 0) {
      return { ok: false, message: "Không tìm thấy storyboard nào trong nguồn nhập." };
    }
    if (!(input.maxCostPerVideo > 0) || !(input.maxCostForBatch > 0)) {
      return {
        ok: false,
        message: "Phải nhập trần chi cho mỗi video và cho cả lô, cả hai đều lớn hơn 0.",
      };
    }

    const created = await materialiseImport(validated, {
      batchName: input.name.trim() || "Lô nhập storyboard",
      maxCostPerVideo: input.maxCostPerVideo,
      maxCostForBatch: input.maxCostForBatch,
    });
    const preflight = await preflightImportedBatch(created.batchId);

    revalidatePath("/batches");
    revalidatePath("/import");
    return {
      ok: true,
      batchId: created.batchId,
      preflight,
      message:
        `Đã tạo lô ${created.projects.length} video, chép ${created.copiedImages} ảnh có sẵn. ` +
        "Quyền chi đang DRAFT — chưa tiêu được gì. Mở trang lô để duyệt.",
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Re-price an imported batch after the operator edited a scene. */
export async function reestimateImportBatch(
  batchId: string,
): Promise<{ ok: boolean; message: string; preflight?: ImportPreflight }> {
  try {
    const preflight = await preflightImportedBatch(batchId);
    revalidatePath(`/batches/${batchId}`);
    return { ok: true, message: "Đã dự toán lại.", preflight };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Edit one imported scene before anything is bought.
 *
 * Deliberately narrow: duration, motion mode and the pin. Those are the fields
 * that change what gets PAID for, they are the ones an operator wants to adjust
 * after seeing the estimate, and every one of them is re-validated by the
 * preflight afterwards. Text edits belong on the project page, which already
 * has an editor for them.
 */
export async function updateImportedScene(input: {
  sceneId: string;
  duration?: number;
  motionMode?: "AUTO" | "LOCAL_MOTION" | "VIDEO_AI";
  videoProvider?: string | null;
  videoModel?: string | null;
}): Promise<{ ok: boolean; message: string }> {
  const scene = await prisma.scene.findUnique({
    where: { id: input.sceneId },
    include: { project: { include: { batch: { include: { authorization: true } } } } },
  });
  if (!scene) return { ok: false, message: "Không tìm thấy cảnh." };

  // Once money has been authorised, the plan is what was approved. Editing it
  // here would move the goalposts under an approval already given.
  const auth = scene.project.batch?.authorization;
  if (auth && auth.status !== "DRAFT") {
    return {
      ok: false,
      message:
        `Lô đã ở trạng thái quyền chi ${auth.status}, không sửa được kế hoạch nữa. ` +
        "Hãy huỷ lô rồi nhập lại nếu cần đổi.",
    };
  }

  const data: Record<string, unknown> = {};
  if (input.duration !== undefined) {
    if (!(input.duration >= 0.5 && input.duration <= 30)) {
      return { ok: false, message: "Thời lượng phải nằm trong khoảng 0,5–30 giây." };
    }
    data.duration = input.duration;
  }
  if (input.motionMode !== undefined) {
    data.motionMode = input.motionMode;
    data.motionSource = input.motionMode === "LOCAL_MOTION" ? "LOCAL_MOTION" : "AI_VIDEO";
    if (input.motionMode === "LOCAL_MOTION") {
      data.videoProvider = null;
      data.videoModel = null;
    }
  }
  if (input.videoProvider !== undefined) data.videoProvider = input.videoProvider || null;
  if (input.videoModel !== undefined) data.videoModel = input.videoModel || null;

  await prisma.scene.update({ where: { id: input.sceneId }, data });
  revalidatePath(`/batches/${scene.project.batchId ?? ""}`);
  return { ok: true, message: "Đã lưu. Hãy dự toán lại để thấy chi phí mới." };
}
