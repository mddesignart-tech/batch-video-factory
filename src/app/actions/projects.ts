"use server";

import { revalidatePath } from "next/cache";
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
  maxBudget: z.coerce.number().min(0).max(1000).default(10),
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
    maxBudget: z.coerce.number().min(0).max(1000).optional(),
    targetDuration: z.coerce.number().min(15).max(60).optional(),
  });
  const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { ok: false, message: "Dữ liệu không hợp lệ." };
  }
  await prisma.project.update({ where: { id: projectId }, data: parsed.data });
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
