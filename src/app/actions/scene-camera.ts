"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CAMERA_ANGLES, CAMERA_EASINGS, CAMERA_MOVES, CAMERA_SPEEDS, FOCUS_STYLES, SHOT_SIZES, TRANSITIONS } from "@/domain/camera-grammar";
import { reducedCamera } from "@/domain/camera-capability";
import { parseScenePlan } from "@/domain/scene-plan";
import { prisma } from "@/lib/prisma";
import { errorMessage } from "@/lib/utils";
import {
  applySuggestedPlan,
  dropInteraction,
  enableComposite,
  resetSceneCameraAuto,
  setSceneAmbient,
  setSceneCamera,
  setSceneLayout,
  useLocalCamera,
} from "@/services/scene-plan-service";
import type { ActionResult } from "./idioms";

/**
 * CAMERA & LỚP CẢNH (QĐ-128). Every action here is local and free: it changes
 * how a scene is framed and moved, or switches a scene to local motion. None
 * of them buys a picture, a clip or a voice.
 */

const CameraChange = z.object({
  shotSize: z.enum(SHOT_SIZES).optional(),
  cameraAngle: z.enum(CAMERA_ANGLES).optional(),
  cameraMovement: z.enum(CAMERA_MOVES).optional(),
  cameraSpeed: z.enum(CAMERA_SPEEDS).optional(),
  focusStyle: z.enum(FOCUS_STYLES).optional(),
  transitionIn: z.enum(TRANSITIONS).optional(),
  cameraEasing: z.enum(CAMERA_EASINGS).optional(),
});

async function done(sceneId: string, message: string): Promise<ActionResult> {
  const scene = await prisma.scene.findUnique({ where: { id: sceneId }, select: { projectId: true } });
  if (scene) revalidatePath(`/projects/${scene.projectId}`);
  return { ok: true, message };
}

export async function applySuggestedCameraAction(sceneId: string): Promise<ActionResult> {
  try {
    await applySuggestedPlan(sceneId);
    return done(sceneId, "Đã dùng camera gợi ý (tự động) · $0.");
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function setSceneCameraAction(sceneId: string, change: z.infer<typeof CameraChange>): Promise<ActionResult> {
  const parsed = CameraChange.safeParse(change);
  if (!parsed.success) return { ok: false, message: "Lựa chọn camera không hợp lệ." };
  try {
    await setSceneCamera(sceneId, parsed.data);
    return done(sceneId, "Đã đổi camera. AI sẽ không tự ghi đè cảnh này cho tới khi bạn chọn Đặt lại tự động.");
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function resetSceneCameraAction(sceneId: string): Promise<ActionResult> {
  try {
    await resetSceneCameraAuto(sceneId);
    return done(sceneId, "Đã đặt lại camera về tự động.");
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function setSceneAmbientAction(sceneId: string, enabled: boolean): Promise<ActionResult> {
  try {
    await setSceneAmbient(sceneId, enabled);
    return done(sceneId, enabled ? "Đã bật chuyển động nền." : "Đã tắt chuyển động nền.");
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Fallback: DÙNG CAMERA LOCAL - the scene moves on this machine, $0. */
export async function useLocalCameraAction(sceneId: string): Promise<ActionResult> {
  try {
    await useLocalCamera(sceneId);
    return done(sceneId, "Cảnh này dùng camera tại máy · $0 (không mua clip Video AI).");
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Fallback: GIẢM CHUYỂN ĐỘNG - the nearest camera a still can really do. */
export async function reduceCameraMotionAction(sceneId: string): Promise<ActionResult> {
  try {
    const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
    const plan = parseScenePlan(scene.scenePlanJson);
    if (!plan) return { ok: false, message: "Cảnh chưa có kế hoạch camera." };
    await setSceneCamera(sceneId, reducedCamera(plan.camera));
    return done(sceneId, "Đã giảm chuyển động camera về mức làm được tại máy · $0.");
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

const Share = z.number().min(0.1).max(1.5).nullable().optional();
const LayoutChange = z.object({
  subjects: z.array(z.object({ id: z.string().max(40), scale: Share, floorY: z.number().min(0.2).max(1).nullable().optional() })).max(3).optional(),
  horizonY: z.number().min(0.2).max(0.95).nullable().optional(),
});

/** VỊ TRÍ TRONG KHUNG: size / standing line of each cut-out and the location's horizon. Local, $0. */
export async function setSceneLayoutAction(sceneId: string, change: z.infer<typeof LayoutChange>): Promise<ActionResult> {
  const parsed = LayoutChange.safeParse(change);
  if (!parsed.success) return { ok: false, message: "Giá trị vị trí không hợp lệ." };
  try {
    await setSceneLayout(sceneId, parsed.data);
    return done(sceneId, "Đã đổi vị trí trong khung. Bấm RENDER LẠI · $0 API để xem - không tạo lại ảnh, giọng hay clip.");
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** BỎ TƯƠNG TÁC: stage the subjects apart; local layers stay. $0. */
export async function dropInteractionAction(sceneId: string): Promise<ActionResult> {
  try {
    await dropInteraction(sceneId);
    return done(sceneId, "Đã bỏ tương tác: các chủ thể đứng tách rời, ghép lớp tại máy · $0.");
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

export async function enableCompositeAction(sceneId: string): Promise<ActionResult> {
  try {
    await enableComposite(sceneId);
    return done(sceneId, "Đã bật ghép lớp tại máy: ảnh bối cảnh + chủ thể tách nền · $0.");
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
