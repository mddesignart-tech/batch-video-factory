"use server";

import { revalidatePath } from "next/cache";
import { MOTION_MODES } from "@/domain/storyboard";
import { z } from "zod";
import { COMPLEXITIES, QUALITY_MODES, ROUTER_STRATEGIES } from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { errorMessage } from "@/lib/utils";
import { enqueue, cancelProjectJobs } from "@/jobs/queue";
import {
  createProjectForIdiom,
  generateProjectScript,
  requeueRender,
  startMediaGeneration,
} from "@/services/project-service";
import type { ActionResult } from "./idioms";
import { makeSceneVoice, sceneVoiceStatus, type SceneVoiceResult } from "@/services/scene-voice";
import type { SceneVoicePlan } from "@/services/generation";
import { setVideoBudget, videoBudget, type VideoBudget } from "@/services/video-budget";

/**
 * Project and storyboard actions.
 *
 * Note the split the brief calls for: `createProject` and `generateScript` are
 * free and safe to press; `startMedia` is the one that can cost money and is
 * gated behind the budget check inside the service.
 */

const CreateInput = z.object({
  idiomId: z.string().min(1, "Hãy chọn một thành ngữ"),
  qualityMode: z.enum(QUALITY_MODES).default("BALANCED"),
  routerStrategy: z.enum(ROUTER_STRATEGIES).default("AUTO"),
  stylePresetId: z.string().optional(),
  targetDuration: z.coerce.number().min(15).max(60).default(25),
  maxBudget: z.coerce.number().positive("Ngân sách video phải lớn hơn $0.").max(1000).default(10),
  generateScript: z.coerce.boolean().default(true),
});

export async function createProject(
  formData: FormData,
): Promise<ActionResult & { projectId?: string }> {
  const parsed = CreateInput.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ.",
    };
  }

  try {
    const project = await createProjectForIdiom({
      idiomId: parsed.data.idiomId,
      qualityMode: parsed.data.qualityMode,
      routerStrategy: parsed.data.routerStrategy,
      stylePresetId: parsed.data.stylePresetId || undefined,
      targetDuration: parsed.data.targetDuration,
      maxBudget: parsed.data.maxBudget,
      autoGenerateScript: parsed.data.generateScript,
      // Never for a single project: media is always an explicit second step.
      autoStartMedia: false,
    });
    revalidatePath("/projects");
    return {
      ok: true,
      message: "Đã tạo dự án và sinh kịch bản mẫu.",
      projectId: project.id,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function regenerateScript(projectId: string): Promise<ActionResult> {
  try {
    const script = await generateProjectScript(projectId);
    revalidatePath(`/projects/${projectId}`);
    return {
      ok: true,
      message: `Đã tạo kịch bản mới với ${script.scenes.length} cảnh.`,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** The paid step. Blocked by MAX BUDGET inside startMediaGeneration. */
export async function startMedia(projectId: string): Promise<ActionResult> {
  try {
    const result = await startMediaGeneration(projectId);
    revalidatePath(`/projects/${projectId}`);
    revalidatePath("/projects");
    if (result.needsApproval && result.batchId) {
      // One engine: the project runs as a batch of one, after PREFLIGHT and
      // DUYỆT & CHẠY on the batch page. Nothing was spent or queued here.
      revalidatePath(`/batches/${result.batchId}`);
      return {
        ok: true,
        message:
          `Dự toán $${result.budget.estimatedTotal.toFixed(4)}. Mở trang lô để PREFLIGHT và ` +
          `DUYỆT & CHẠY: /batches/${result.batchId}`,
        redirectTo: `/batches/${result.batchId}`,
      };
    }
    if (!result.started) {
      return {
        ok: false,
        message: result.budget.allowed
          ? "Không thể bắt đầu tạo media."
          : result.budget.message,
        details: [...result.errors, ...result.budget.suggestions],
      };
    }
    return {
      ok: true,
      message: `Đã đưa ${result.jobsQueued} job vào hàng đợi. Chi phí ước tính $${result.budget.estimatedTotal.toFixed(
        2,
      )}.`,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function renderFinal(projectId: string): Promise<ActionResult> {
  try {
    await requeueRender(projectId);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: "Đã đưa job render vào hàng đợi." };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function cancelProject(projectId: string): Promise<ActionResult> {
  const count = await cancelProjectJobs(projectId);
  await prisma.project.update({
    where: { id: projectId },
    data: { status: "draft" },
  });
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: `Đã huỷ ${count} job đang chờ.` };
}

export async function deleteProject(projectId: string): Promise<ActionResult> {
  await cancelProjectJobs(projectId);
  await prisma.project.delete({ where: { id: projectId } });
  revalidatePath("/projects");
  return { ok: true, message: "Đã xoá dự án." };
}

export async function updateProjectSettings(
  projectId: string,
  formData: FormData,
): Promise<ActionResult> {
  const schema = z.object({
    title: z.string().min(1).optional(),
    qualityMode: z.enum(QUALITY_MODES).optional(),
    routerStrategy: z.enum(ROUTER_STRATEGIES).optional(),
    maxBudget: z.coerce.number().positive("Ngân sách video phải lớn hơn $0.").max(1000).optional(),
    targetDuration: z.coerce.number().min(15).max(60).optional(),
  });
  const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ." };
  }
  const { maxBudget, ...rest } = parsed.data;
  await prisma.project.update({ where: { id: projectId }, data: rest });
  // The same path as "Đổi ngân sách", so a batch of one made for this project follows.
  if (maxBudget !== undefined) await setVideoBudget(projectId, maxBudget);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: "Đã lưu cài đặt dự án." };
}

// ---------------------------------------------------------------- scenes ---

const SceneInput = z.object({
  dialogue: z.string().optional(),
  narration: z.string().optional(),
  subtitle: z.string().optional(),
  visualDescription: z.string().optional(),
  imagePrompt: z.string().optional(),
  videoPrompt: z.string().optional(),
  camera: z.string().optional(),
  soundEffect: z.string().optional(),
  duration: z.coerce.number().min(1).max(12).optional(),
  complexity: z.enum(COMPLEXITIES).optional(),
  routingMode: z.enum(ROUTER_STRATEGIES).optional(),
  videoProvider: z.string().optional(),
  videoModel: z.string().optional(),
  /** The person's instruction for this scene's motion. See QĐ-066. */
  motionMode: z.enum(MOTION_MODES).optional(),
});

export async function updateScene(
  sceneId: string,
  formData: FormData,
): Promise<ActionResult> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = SceneInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Dữ liệu cảnh không hợp lệ.",
    };
  }

  const data = { ...parsed.data };
  // An empty model pin means "let the router decide", not "use a model called
  // empty string".
  if (data.videoProvider === "") data.videoProvider = undefined;
  if (data.videoModel === "") data.videoModel = undefined;

  // Naming both halves here IS the pin, and clearing them retracts it. The flag
  // has to be written alongside, because `generateSceneVideo` later writes the
  // model it used into the same two columns - after which nothing else in the
  // row can tell an instruction from a record. See QĐ-069.
  const videoModelPinned = Boolean(data.videoProvider && data.videoModel);

  const scene = await prisma.scene.update({
    where: { id: sceneId },
    data: {
      ...data,
      videoProvider: data.videoProvider ?? null,
      videoModel: data.videoModel ?? null,
      videoModelPinned,
    },
  });
  revalidatePath(`/projects/${scene.projectId}`);
  return { ok: true, message: `Đã lưu cảnh ${scene.sceneNumber}.` };
}

export async function approveScene(
  sceneId: string,
  approved: boolean,
): Promise<ActionResult> {
  const scene = await prisma.scene.update({
    where: { id: sceneId },
    data: { approved },
  });
  revalidatePath(`/projects/${scene.projectId}`);
  return {
    ok: true,
    message: approved ? "Đã duyệt cảnh." : "Đã bỏ duyệt cảnh.",
  };
}

export async function skipScene(
  sceneId: string,
  skipped: boolean,
): Promise<ActionResult> {
  const scene = await prisma.scene.update({
    where: { id: sceneId },
    data: { skipped, status: skipped ? "skipped" : "pending" },
  });
  revalidatePath(`/projects/${scene.projectId}`);
  return {
    ok: true,
    message: skipped
      ? `Đã bỏ qua cảnh ${scene.sceneNumber}. Cảnh này sẽ không được tạo hay ghép vào video.`
      : `Đã khôi phục cảnh ${scene.sceneNumber}.`,
  };
}

/**
 * Regenerate one asset of one scene.
 *
 * Bumping retryCount is what makes this a genuinely new generation: the
 * idempotency key includes that counter, so we do not resume the old job.
 */
export async function regenerateSceneAsset(
  sceneId: string,
  kind: "image" | "video" | "voice",
): Promise<ActionResult> {
  const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
  if (!scene) return { ok: false, message: "Không tìm thấy cảnh." };

  // A supplied picture is never redrawn behind the person's back. "Regenerate"
  // would only have bumped retryCount - which changes the CLIP's key too, so the
  // next run would re-buy a clip for nothing - while handing back the same
  // imported file. Removing the import is the explicit way to ask for AI.
  if (kind === "image" && scene.imageSource === "IMPORTED") {
    return {
      ok: false,
      message:
        `Cảnh ${scene.sceneNumber} đang dùng ảnh nhập, không tạo lại bằng AI. ` +
        `Muốn ảnh AI: bấm "Bỏ ảnh nhập" trước (lần chạy sau sẽ tạo và tính phí).`,
    };
  }

  // Voice never goes through the queue blind: the same words in the same voice
  // are the same audio (reused, $0), and anything to buy is shown with its
  // price first. retryCount is not touched - it is not part of a voice's key.
  if (kind === "voice") {
    const r = await makeSceneVoice(sceneId);
    revalidatePath(`/projects/${scene.projectId}`);
    return { ok: r.status === "DONE", message: r.message };
  }

  await prisma.scene.update({
    where: { id: sceneId },
    data: { retryCount: { increment: 1 }, errorMessage: null },
  });

  const type =
    kind === "image"
      ? "generate_scene_image"
      : kind === "video"
        ? "generate_scene_video"
        : "generate_scene_voice";

  await enqueue({
    type,
    sceneId,
    projectId: scene.projectId,
    priority: 50, // operator-initiated work jumps the batch queue
  });

  await logger.info({
    event: "scene.regenerate_requested",
    sceneId,
    projectId: scene.projectId,
    message: kind,
  });

  revalidatePath(`/projects/${scene.projectId}`);
  const labels = { image: "ảnh", video: "video", voice: "giọng đọc" } as const;
  return {
    ok: true,
    message: `Đã thêm job tạo lại ${labels[kind]} cho cảnh ${scene.sceneNumber}.`,
  };
}

/** Voice state of one scene, line by line. Read-only: never a paid call. */
export async function getSceneVoicePlan(sceneId: string): Promise<{ ok: boolean; message: string; plan?: SceneVoicePlan }> {
  try {
    return { ok: true, message: "", plan: await sceneVoiceStatus(sceneId) };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * NGHE THỬ GIỌNG: make (or reuse) this scene's voice now. Paid lines are only
 * sent with `confirmPaid` and the cost the person saw (`expectedCost`).
 */
export async function makeSceneVoiceAction(
  sceneId: string,
  opts: { confirmPaid?: boolean; expectedCost?: number } = {},
): Promise<SceneVoiceResult> {
  try {
    const r = await makeSceneVoice(sceneId, opts);
    const scene = await prisma.scene.findUnique({ where: { id: sceneId }, select: { projectId: true } });
    if (scene) revalidatePath(`/projects/${scene.projectId}`);
    return r;
  } catch (err) {
    return { status: "FAILED", message: errorMessage(err), plan: null, postsMade: 0 };
  }
}

/** NGÂN SÁCH VIDEO of one project. Read-only. */
export async function getVideoBudget(projectId: string): Promise<{ ok: boolean; message: string; budget?: VideoBudget }> {
  try {
    return { ok: true, message: "", budget: await videoBudget(projectId) };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** "Đổi ngân sách": the one number a person sets for a video (> $0). */
export async function updateVideoBudget(
  projectId: string,
  amount: number,
): Promise<{ ok: boolean; message: string; budget?: VideoBudget }> {
  try {
    const budget = await setVideoBudget(projectId, amount);
    await logger.info({ event: "project.budget_changed", projectId, message: `Ngân sách video: $${amount.toFixed(2)}` });
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: `Đã đặt ngân sách video $${budget.videoLimit?.toFixed(2)}.`, budget };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
