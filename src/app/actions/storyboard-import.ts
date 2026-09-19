"use server";

import path from "node:path";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
  deriveVideoPrompt,
  hasErrors,
  promptHasMotionContent,
  MAX_SCENE_DURATION,
  MIN_SCENE_DURATION,
  type ImportIssue,
} from "@/domain/storyboard";
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

/** Every field of an imported scene the editor can show and change. */
export interface ImportedSceneRow {
  sceneId: string;
  sceneNumber: number;
  duration: number;
  narration: string;
  dialogue: string;
  visualDescription: string;
  characterAction: string;
  camera: string;
  subtitle: string;
  motionMode: string;
  priority: string;
  videoProvider: string | null;
  videoModel: string | null;
  videoPrompt: string;
  keyframe: string;
  /** True once a provider request exists for it, which freezes the row. */
  locked: boolean;
}

export async function importedScenes(batchId: string): Promise<
  { projectId: string; title: string; scenes: ImportedSceneRow[] }[]
> {
  const projects = await prisma.project.findMany({
    where: { batchId },
    orderBy: { createdAt: "asc" },
    include: { scenes: { where: { skipped: false }, orderBy: { sceneNumber: "asc" } } },
  });
  const out = [];
  for (const project of projects) {
    const rows: ImportedSceneRow[] = [];
    for (const scene of project.scenes) {
      rows.push({
        sceneId: scene.id,
        sceneNumber: scene.sceneNumber,
        duration: scene.duration,
        narration: scene.narration,
        dialogue: scene.dialogue,
        visualDescription: scene.visualDescription,
        characterAction: scene.characterAction,
        camera: scene.camera,
        subtitle: scene.subtitle,
        motionMode: scene.motionMode,
        priority: scene.spendPriority,
        videoProvider: scene.videoProvider,
        videoModel: scene.videoModel,
        videoPrompt: scene.videoPrompt,
        keyframe: scene.imageSource === "IMPORTED" ? "có sẵn" : "sẽ tạo",
        locked: (await prisma.providerJob.count({ where: { sceneId: scene.id } })) > 0,
      });
    }
    out.push({ projectId: project.id, title: project.title, scenes: rows });
  }
  return out;
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
 * Edit one imported scene, before anything has been bought.
 *
 * Covers everything a storyboard row carries: the text, the timing, the motion
 * mode, the pin and the priority. An import is the one flow where the operator
 * is expected to arrive with the content already written, look at what it will
 * cost, and change their mind about it - so the editor has to reach the same
 * fields the file does, or the answer to "that scene is too long" becomes
 * "re-export the spreadsheet and import it again".
 *
 * Two things are re-derived rather than asked for, because they are derived
 * everywhere else too: the video prompt (from the visual, the action and the
 * camera) and who speaks (from whether there are any words). And the frozen
 * estimate is thrown away, so the next approval is signed against the video
 * that now exists rather than the one that was imported.
 */
export async function updateImportedScene(input: {
  sceneId: string;
  duration?: number;
  narration?: string;
  dialogue?: string;
  visualDescription?: string;
  characterAction?: string;
  camera?: string;
  subtitle?: string;
  motionMode?: "AUTO" | "LOCAL_MOTION" | "VIDEO_AI";
  videoProvider?: string | null;
  videoModel?: string | null;
  priority?: "LOW" | "NORMAL" | "HIGH";
}): Promise<{ ok: boolean; message: string }> {
  const scene = await prisma.scene.findUnique({
    where: { id: input.sceneId },
    include: { project: { include: { batch: { include: { authorization: true } } } } },
  });
  if (!scene) return { ok: false, message: "Không tìm thấy cảnh." };

  // Two locks, and they answer different questions.
  //
  // The authorisation lock asks "has money been promised against this plan?".
  // Editing after an approval would move the goalposts under a yes that was
  // given to a different plan.
  const auth = scene.project.batch?.authorization;
  if (auth && auth.status !== "DRAFT") {
    return {
      ok: false,
      message:
        `Lô đã ở trạng thái quyền chi ${auth.status}, không sửa được kế hoạch nữa. ` +
        "Hãy huỷ lô rồi nhập lại nếu cần đổi.",
    };
  }
  // The scene lock asks "has this scene already been bought?". A scene with a
  // provider job behind it has had real work done on it, and rewriting its
  // prompt would orphan that work while leaving the bill.
  const bought = await prisma.providerJob.count({ where: { sceneId: scene.id } });
  if (bought > 0) {
    return {
      ok: false,
      message:
        `Cảnh này đã bắt đầu tạo media (${bought} request đã gửi tới nhà cung cấp), ` +
        "nên không sửa được nữa. Hãy dùng nút thử lại cảnh nếu muốn tạo lại.",
    };
  }

  const data: Record<string, unknown> = {};
  if (input.duration !== undefined) {
    if (!(input.duration >= MIN_SCENE_DURATION && input.duration <= MAX_SCENE_DURATION)) {
      return {
        ok: false,
        message: `Thời lượng phải nằm trong khoảng ${MIN_SCENE_DURATION}–${MAX_SCENE_DURATION} giây.`,
      };
    }
    data.duration = input.duration;
  }
  if (input.narration !== undefined) data.narration = input.narration.trim();
  if (input.dialogue !== undefined) data.dialogue = input.dialogue.trim();
  if (input.visualDescription !== undefined) {
    data.visualDescription = input.visualDescription.trim();
  }
  if (input.characterAction !== undefined) data.characterAction = input.characterAction.trim();
  if (input.camera !== undefined) data.camera = input.camera.trim();
  if (input.subtitle !== undefined) data.subtitle = input.subtitle.trim();
  if (input.priority !== undefined) data.spendPriority = input.priority;
  if (input.motionMode !== undefined) {
    data.motionMode = input.motionMode;
    data.motionSource = input.motionMode === "LOCAL_MOTION" ? "LOCAL_MOTION" : "AI_VIDEO";
    if (input.motionMode === "LOCAL_MOTION") {
      data.videoProvider = null;
      data.videoModel = null;
      data.videoModelPinned = false;
    }
  }
  if (input.videoProvider !== undefined) data.videoProvider = input.videoProvider || null;
  if (input.videoModel !== undefined) data.videoModel = input.videoModel || null;

  // Whoever edited this form is a person, so whatever they left in the two model
  // fields is an instruction - including leaving them empty, which retracts the
  // pin. Recomputed from the values that will actually be stored, not from the
  // input alone, since `motionMode = LOCAL_MOTION` clears them above. QĐ-069.
  if (data.videoProvider !== undefined || data.videoModel !== undefined) {
    const provider = (data.videoProvider as string | null) ?? scene.videoProvider;
    const model = (data.videoModel as string | null) ?? scene.videoModel;
    data.videoModelPinned = Boolean(provider && model);
  }

  // The prompt is DERIVED, so it has to be re-derived whenever one of the three
  // fields it is derived from moves. Leaving the old one would send a video
  // model a description of a scene that no longer exists.
  const visualDescription = (data.visualDescription as string) ?? scene.visualDescription;
  const characterAction = (data.characterAction as string) ?? scene.characterAction;
  const camera = (data.camera as string) ?? scene.camera;
  const narration = (data.narration as string) ?? scene.narration;
  const motionMode = (data.motionMode as string) ?? scene.motionMode;

  if (
    motionMode === "VIDEO_AI" &&
    !promptHasMotionContent({ visualDescription, characterAction })
  ) {
    return {
      ok: false,
      message:
        "Cảnh đặt VIDEO_AI thì phải có mô tả cảnh hoặc hành động, nếu không sẽ không " +
        "dựng được prompt video. Hãy điền một trong hai, hoặc chuyển sang LOCAL_MOTION.",
    };
  }
  data.videoPrompt = deriveVideoPrompt({
    visualDescription,
    characterAction,
    camera,
    narration,
  });

  // Speech follows the words, and narration counts: an empty speaking list is
  // what makes `parseDialogueLines` drop narration on the floor.
  const dialogue = (data.dialogue as string) ?? scene.dialogue;
  if (input.dialogue !== undefined || input.narration !== undefined) {
    const present = JSON.parse(scene.charactersPresentJson) as string[];
    const hasWords = dialogue.trim().length > 0 || narration.trim().length > 0;
    data.speakingCharactersJson = JSON.stringify(hasWords ? present.slice(0, 1) : []);
  }

  await prisma.$transaction([
    prisma.scene.update({ where: { id: input.sceneId }, data }),
    // Invalidating the estimate is the point, not a side effect. The frozen
    // plan is what `batch_expand` runs and what the approval is checked
    // against; leaving a stale one next to edited scenes is how an operator
    // approves a number that describes a video they just changed.
    ...(scene.project.batchId
      ? [
          prisma.batch.update({
            where: { id: scene.project.batchId },
            data: { planJson: "{}", estimatedCost: 0 },
          }),
        ]
      : []),
  ]);

  revalidatePath(`/batches/${scene.project.batchId ?? ""}`);
  revalidatePath("/import");
  return {
    ok: true,
    message: "Đã lưu. Bản dự toán cũ đã bị huỷ — hãy DỰ TOÁN LẠI trước khi duyệt.",
  };
}
