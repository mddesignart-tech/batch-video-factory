import type { Scene } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cameraSummaryVi, localFallbackMove, localSupport, VI_CAMERA_MOVE } from "@/domain/camera-grammar";
import { cameraSupport, sceneMotionCost } from "@/domain/camera-capability";
import { legacyScenePlan, VI_LAYER_TYPE, VI_MOTION_ROUTE, type LayerMotion, type ScenePlan } from "@/domain/scene-plan";
import { sceneCharacters } from "@/domain/scene-characters";
import { storedProfile } from "@/domain/video-model-profile";
import type { SceneCameraView } from "@/app/projects/[id]/scene-camera-panel";
import { compositeOption, suggestedPlans } from "./scene-plan-service";

/**
 * The "Camera & lớp cảnh" panel for every scene of a project, in plain words:
 * layers, camera, the director's suggestion and why, what each part of the
 * motion costs, and a warning (with fallbacks) when the camera asks for more
 * than the scene's Video AI model promises. Read only, $0.
 */

const VI_MOTION: Partial<Record<LayerMotion, string>> = {
  TALKING: "đang nói",
  IDLE: "cử động nhẹ",
  STATIC: "",
  CROSS: "đi ngang",
  DRIFT: "trôi chậm",
  SWAY: "lay nhẹ",
  FLICKER: "nhấp nháy",
  RISE: "bốc lên",
  LOOP: "lặp nhẹ",
  AMBIENT_VIDEO: "loop tại máy",
  AI_MOTION: "chuyển động mạnh (Video AI)",
  PARALLAX: "parallax",
  SLOW_PAN: "lia chậm",
};

const core = (p: ScenePlan) => JSON.stringify([p.camera.shotSize, p.camera.cameraAngle, p.camera.cameraMovement, p.camera.focusStyle]);

export async function sceneCameraViews(projectId: string, videoCostBySceneNumber: Map<number, number>): Promise<Record<string, SceneCameraView>> {
  const scenes = await prisma.scene.findMany({ where: { projectId, skipped: false }, orderBy: { sceneNumber: "asc" } });
  if (scenes.length === 0) return {};
  const [plans, models] = await Promise.all([
    suggestedPlans(projectId),
    prisma.modelRegistry.findMany({ where: { type: "video", enabled: true }, select: { provider: true, modelId: true, capabilityProfileJson: true } }),
  ]);
  const out: Record<string, SceneCameraView> = {};
  for (const scene of scenes) {
    const entry = plans.get(scene.id);
    if (!entry) continue;
    const current = entry.current;
    const plan: ScenePlan = current ?? legacyScenePlan({ camera: scene.camera, visualDescription: scene.visualDescription, charactersPresent: sceneCharacters(scene).present, motionSource: scene.motionSource });
    const paidClip = scene.motionSource === "AI_VIDEO" && !scene.videoPath;
    const composite = current?.route === "COMPOSITE";
    out[scene.id] = {
      sceneId: scene.id,
      source: current ? (current.source === "LEGACY" ? "LEGACY" : current.source) : "LEGACY",
      summary: current ? cameraSummaryVi(plan.camera) : "Như trước: zoom vào chậm",
      reason: plan.camera.reason,
      camera: {
        shotSize: (current ?? entry.suggestion).camera.shotSize,
        cameraAngle: (current ?? entry.suggestion).camera.cameraAngle,
        cameraMovement: (current ?? entry.suggestion).camera.cameraMovement,
        cameraSpeed: (current ?? entry.suggestion).camera.cameraSpeed,
        focusStyle: (current ?? entry.suggestion).camera.focusStyle,
      },
      layers: (current ?? entry.suggestion).layers.map((l) => ({ type: VI_LAYER_TYPE[l.layerType], label: l.label, motion: VI_MOTION[l.motionType] ?? "", enabled: l.enabled })),
      suggestion: { summary: cameraSummaryVi(entry.suggestion.camera), reason: entry.suggestion.camera.reason, differs: !current || core(current) !== core(entry.suggestion) },
      route: `${VI_MOTION_ROUTE[(current ?? entry.suggestion).route]}${paidClip ? " · cảnh này đã duyệt Video AI" : ""}`,
      cost: sceneMotionCost(current ?? entry.suggestion, { paidClip, videoCost: videoCostBySceneNumber.get(scene.sceneNumber) ?? 0 }),
      warning: cameraWarning(scene, current ?? entry.suggestion, models),
      hasAmbient: (current ?? entry.suggestion).layers.some((l) => l.layerType === "AMBIENT"),
      ambientOn: (current ?? entry.suggestion).layers.some((l) => l.layerType === "AMBIENT" && l.enabled),
      composite: composite ? { available: true, reason: "", active: true } : { ...(await compositeOption(scene.id)), active: false },
      notes: (current ?? entry.suggestion).notes.filter((n) => n !== "ambient-off"),
    };
  }
  return out;
}

/**
 * A scene routed to Video AI whose camera needs a real 3-D move: is there a
 * model (the pinned one, or any enabled) that promises it? If not, say so and
 * offer the fallbacks - never fail the project.
 */
function cameraWarning(scene: Scene, plan: ScenePlan, models: { provider: string; modelId: string; capabilityProfileJson: string | null }[]): string | null {
  if (!plan.cameraNeedsVideoAi) return null;
  const move = VI_CAMERA_MOVE[plan.camera.cameraMovement];
  if (scene.motionSource !== "AI_VIDEO" || scene.videoPath) {
    return localSupport(plan.camera.cameraMovement) === "NONE"
      ? `"${move}" cần Video AI; tại máy sẽ dùng phương án gần nhất: ${VI_CAMERA_MOVE[localFallbackMove(plan.camera.cameraMovement)]} · $0.`
      : null;
  }
  const pool = scene.videoModelPinned && scene.videoModel ? models.filter((m) => m.modelId === scene.videoModel) : models;
  const ok = pool.some((m) => cameraSupport(storedProfile(m.capabilityProfileJson), plan.camera).supported);
  if (ok) return null;
  return scene.videoModelPinned
    ? `Model ${scene.videoModel} không hỗ trợ camera "${move}". Không tính phí cho đến khi bạn chọn.`
    : `Chưa có model Video AI nào hỗ trợ camera "${move}". Không tính phí cho đến khi bạn chọn.`;
}
