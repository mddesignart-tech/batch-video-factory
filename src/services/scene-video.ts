import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { isMockMode } from "@/lib/env";
import { round } from "@/lib/utils";
import { budgetProblem, type BudgetProblem } from "@/domain/budget-message";
import { NEEDS_SELECTION_STATUS } from "@/domain/video-selection";
import { videoModelChoices, type VideoModelChoice } from "./generation";
import { budgetShortfall, videoBudget } from "./video-budget";

/**
 * A scene whose video needs a person's choice (QĐ-120).
 *
 *   chooseVideoModel   pin a model the router will not pick by itself. Free.
 *   useLocalMotion     animate the keyframe on this machine instead. Free.
 *   skipVideoAi        no AI clip; the scene uses its still. Free.
 *   makeSceneVideo     the ONE paid step: price shown, budget checked, explicit
 *                      confirmation, per-scene lock, one POST.
 *
 * Nothing here relaxes the router: a PIN_ONLY model still runs only on a pin,
 * a DEPRECATED / disabled / shut-down one cannot be chosen, and nothing is
 * swapped in on anyone's behalf.
 */

export type SceneVideoStatus = "DONE" | "NEEDS_CONFIRMATION" | "NEEDS_BUDGET" | "NEEDS_SELECTION" | "BLOCKED" | "ALREADY_RUNNING" | "FAILED";

export interface SceneVideoResult {
  status: SceneVideoStatus;
  message: string;
  choice: VideoModelChoice | null;
  /** Video ProviderJobs this call created. */
  postsMade: number;
  budget?: BudgetProblem & { projectId: string; videoLimit: number | null };
}

const running = new Set<string>();

/** Clear a waiting selection: the scene goes back to where its media stands. */
async function clearSelection(sceneId: string, data: Record<string, unknown>): Promise<void> {
  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId }, select: { imagePath: true, status: true } });
  await prisma.scene.update({
    where: { id: sceneId },
    data: {
      ...data,
      errorMessage: null,
      ...(scene.status === NEEDS_SELECTION_STATUS || scene.status === "failed" ? { status: scene.imagePath ? "image_ready" : "pending" } : {}),
    },
  });
}

export async function chooseVideoModel(sceneId: string, provider: string, model: string): Promise<VideoModelChoice> {
  const { choices } = await videoModelChoices(sceneId);
  const choice = choices.find((c) => c.provider === provider && c.model === model);
  if (!choice) throw new Error(`Không có model ${provider}/${model}.`);
  if (!choice.selectable) throw new Error(`Không chọn được ${provider}/${model}: ${choice.unavailableReason ?? "không khả dụng"}`);
  await clearSelection(sceneId, { videoProvider: provider, videoModel: model, videoModelPinned: true, motionMode: "VIDEO_AI", motionSource: "AI_VIDEO" });
  await logger.info({ event: "scene.video_model_chosen", sceneId, provider, model, message: `Người dùng chọn ${provider}/${model} (chưa gửi request).` });
  return choice;
}

export async function useLocalMotion(sceneId: string): Promise<void> {
  await clearSelection(sceneId, { motionMode: "LOCAL_MOTION", motionSource: "LOCAL_MOTION", videoModelPinned: false, videoProvider: null, videoModel: null });
  await logger.info({ event: "scene.local_motion_chosen", sceneId, message: "Người dùng chọn LOCAL MOTION: $0, không gọi Video AI." });
}

/**
 * "Bỏ qua Video AI": no clip is bought for this scene. With the motion modes
 * this app has, that is LOCAL_MOTION over the still - the same $0 path - kept
 * as its own button because it answers a different question ("I don't want
 * AI video here") than "animate it locally".
 */
export async function skipVideoAi(sceneId: string): Promise<void> {
  await useLocalMotion(sceneId);
  await logger.info({ event: "scene.video_ai_skipped", sceneId, message: "Bỏ qua Video AI cho cảnh này." });
}

/** The paid step for a pinned scene. A second press while running answers ALREADY_RUNNING. */
export async function makeSceneVideo(
  sceneId: string,
  opts: { confirmPaid?: boolean; expectedCost?: number } = {},
): Promise<SceneVideoResult> {
  if (running.has(sceneId)) {
    return { status: "ALREADY_RUNNING", message: "Video của cảnh này đang được tạo - không gửi request thứ hai.", choice: null, postsMade: 0 };
  }
  running.add(sceneId);
  try {
    const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
    const { choices, pinned } = await videoModelChoices(sceneId);
    const choice = pinned ? (choices.find((c) => `${c.provider}/${c.model}` === pinned) ?? null) : null;
    if (!choice) {
      return { status: "NEEDS_SELECTION", message: "Chưa chọn model video cho cảnh này.", choice: null, postsMade: 0 };
    }
    if (!choice.selectable || choice.estimatedCost === null) {
      return {
        status: "NEEDS_SELECTION",
        message: `Model cũ ${pinned} không còn khả dụng. Chọn model thay thế. (${choice.unavailableReason ?? ""})`.trim(),
        choice,
        postsMade: 0,
      };
    }
    const cost = choice.estimatedCost;
    const mock = isMockMode();
    const shortfall = await budgetShortfall(scene.projectId, cost, mock);
    if (shortfall) return { status: "NEEDS_BUDGET", message: shortfall.detail, choice, postsMade: 0, budget: shortfall };
    if (!opts.confirmPaid) {
      return {
        status: "NEEDS_CONFIRMATION",
        message: `Tạo 1 clip bằng ${pinned}, ước tính $${cost.toFixed(4)}${mock ? " (giá giả lập Mock Mode)" : ""}. Cần xác nhận.`,
        choice,
        postsMade: 0,
      };
    }
    if (opts.expectedCost === undefined || Math.abs(round(opts.expectedCost) - round(cost)) > 1e-9) {
      return { status: "BLOCKED", message: "PLAN_CHANGED: giá đã đổi từ lúc bạn xem. KHÔNG gửi request - hãy xem lại rồi xác nhận.", choice, postsMade: 0 };
    }

    const before = await prisma.providerJob.count({ where: { sceneId, kind: "video" } });
    const { needsCreatePermit } = await import("./generation");
    const { batchApprovalFor } = await import("./batch-authorization");
    const project = await prisma.project.findUniqueOrThrow({ where: { id: scene.projectId }, select: { batchId: true } });
    // Outside a live batch approval a paid clip needs the single-use create
    // token. THIS confirmation is what the token stands for - one person, one
    // price, one POST - so it is issued for exactly this scene, model and
    // price, and taken back if the request never consumed it.
    const permit = needsCreatePermit("video", choice.provider, Boolean(await batchApprovalFor(project.batchId)));
    const tokens = permit ? await import("./create-token") : null;
    if (tokens) {
      if (await tokens.peekCreateToken()) {
        return { status: "BLOCKED", message: "Đang có một quyền tạo video khác chưa dùng. KHÔNG gửi request.", choice, postsMade: 0 };
      }
      await tokens.grantCreateToken({ provider: choice.provider, model: choice.model, sceneId, kind: "video", maxCost: cost, note: "Người dùng xác nhận giá ở Storyboard (chọn model thủ công)." });
    }
    try {
      const { executeSceneAsset } = await import("./batch-executor");
      await executeSceneAsset(sceneId, "video");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const problem = budgetProblem(message);
      if (problem) {
        const vb = await videoBudget(scene.projectId);
        return { status: "NEEDS_BUDGET", message, choice, postsMade: 0, budget: { ...problem, needed: problem.needed ?? cost, projectId: scene.projectId, videoLimit: vb.videoLimit } };
      }
      return { status: "FAILED", message, choice, postsMade: (await prisma.providerJob.count({ where: { sceneId, kind: "video" } })) - before };
    } finally {
      if (tokens) {
        const left = await tokens.peekCreateToken();
        if (left && left.sceneId === sceneId) await tokens.revokeCreateToken();
      }
    }
    const postsMade = (await prisma.providerJob.count({ where: { sceneId, kind: "video" } })) - before;
    return {
      status: "DONE",
      message: postsMade === 0 ? "Clip đã có sẵn - dùng lại, 0 request, $0." : `Đã tạo clip bằng ${pinned}.`,
      choice,
      postsMade,
    };
  } finally {
    running.delete(sceneId);
  }
}
