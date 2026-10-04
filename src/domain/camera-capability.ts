/**
 * CAMERA × PROVIDER × COST (QĐ-128). Pure.
 *
 *  - `cameraSupport`: can this Video AI model do what the camera plan asks?
 *    Only what a model's profile PROMISES counts; nothing is assumed.
 *  - `cameraFallbacks`: what a person can do instead - never a failed project.
 *  - `sceneMotionCost`: the scene's motion priced per part, so a scene where
 *    only the character's movement is paid is not shown as "all Video AI".
 */

import { localFallbackMove, localSupport, VI_CAMERA_MOVE, type CameraMove, type CameraPlan } from "./camera-grammar";
import type { ScenePlan } from "./scene-plan";
import type { VideoModelProfile } from "./video-model-profile";

type CameraProfile = Pick<VideoModelProfile, "cameraControl" | "cameraMoves" | "focusControl" | "orbit" | "tracking" | "complexCameraPrompt">;

export interface CameraSupport {
  supported: boolean;
  /** What the plan needs that the model does not promise (Vietnamese). */
  missing: string[];
}

const ORBITING: CameraMove[] = ["ORBIT_LEFT", "ORBIT_RIGHT", "ARC"];
const CRANING: CameraMove[] = ["CRANE_UP", "CRANE_DOWN"];
const TRACKING: CameraMove[] = ["TRACK_LEFT", "TRACK_RIGHT", "TRUCK_LEFT", "TRUCK_RIGHT", "GIMBAL"];

/** Does a Video AI model (by its profile) promise the camera this plan needs? */
export function cameraSupport(profile: CameraProfile | null | undefined, camera: CameraPlan): CameraSupport {
  const p = profile ?? {};
  const move = camera.cameraMovement;
  const listed = (p.cameraMoves ?? []).includes(move);
  const missing: string[] = [];
  if (ORBITING.includes(move) && !(p.orbit || listed)) missing.push(VI_CAMERA_MOVE[move]);
  else if (CRANING.includes(move) && !(listed || p.complexCameraPrompt)) missing.push(VI_CAMERA_MOVE[move]);
  else if (TRACKING.includes(move) && localSupport(move) === "NONE" && !(p.tracking || listed)) missing.push(VI_CAMERA_MOVE[move]);
  if (camera.focusStyle === "RACK_FOCUS" && !p.focusControl) missing.push("Chuyển focus");
  return { supported: missing.length === 0, missing };
}

export const CAMERA_FALLBACKS = ["USE_LOCAL_CAMERA", "CHOOSE_OTHER_MODEL", "CHANGE_CAMERA", "REDUCE_MOTION"] as const;
export type CameraFallback = (typeof CAMERA_FALLBACKS)[number];
export const VI_CAMERA_FALLBACK: Record<CameraFallback, string> = {
  USE_LOCAL_CAMERA: "DÙNG CAMERA LOCAL",
  CHOOSE_OTHER_MODEL: "CHỌN MODEL KHÁC",
  CHANGE_CAMERA: "ĐỔI CAMERA",
  REDUCE_MOTION: "GIẢM CHUYỂN ĐỘNG",
};

/** The camera a "GIẢM CHUYỂN ĐỘNG" press produces: the nearest move a still can really do. */
export function reducedCamera(camera: CameraPlan): Pick<CameraPlan, "cameraMovement" | "focusStyle"> {
  return {
    cameraMovement: localFallbackMove(camera.cameraMovement),
    focusStyle: camera.focusStyle === "RACK_FOCUS" ? "SHALLOW_FOCUS" : camera.focusStyle,
  };
}

// --------------------------------------------------------------------- cost ---

export interface MotionCostPart {
  part: "CAMERA" | "SUBJECT" | "BACKGROUND" | "AMBIENT";
  label: string;
  how: string;
  /** USD; 0 = local / free. */
  cost: number;
}

/**
 * Price one scene's motion by part. Exactly one part can carry a Video AI
 * price - the subject's movement - and only when the scene is routed to it.
 */
export function sceneMotionCost(plan: ScenePlan, opts: { paidClip: boolean; videoCost: number }): MotionCostPart[] {
  const move = plan.camera.cameraMovement;
  const cameraHow = opts.paidClip
    ? `Trong clip Video AI (${VI_CAMERA_MOVE[move]})`
    : `Tại máy: ${VI_CAMERA_MOVE[localSupport(move) === "NONE" ? localFallbackMove(move) : move]}`;
  const parts: MotionCostPart[] = [{ part: "CAMERA", label: "Camera", how: cameraHow, cost: 0 }];
  parts.push(
    opts.paidClip
      ? { part: "SUBJECT", label: "Chuyển động chủ thể", how: "Video AI", cost: Math.max(0, opts.videoCost) }
      : { part: "SUBJECT", label: "Chuyển động chủ thể", how: "Tại máy (ảnh + camera)", cost: 0 },
  );
  if (plan.layers.some((l) => l.enabled && l.layerType === "BACKGROUND")) {
    parts.push({ part: "BACKGROUND", label: "Hậu cảnh", how: plan.route === "COMPOSITE" ? "Ghép lớp tại máy" : "Tại máy", cost: 0 });
  }
  const ambient = plan.layers.filter((l) => l.enabled && l.layerType === "AMBIENT");
  if (ambient.length) {
    const local = ambient.filter((l) => l.motionType === "AMBIENT_VIDEO").length;
    parts.push({
      part: "AMBIENT",
      label: "Chuyển động nền",
      how: local ? `Loop tại máy (${ambient.map((l) => l.label).join(", ")})` : `Mô tả trong prompt (${ambient.map((l) => l.label).join(", ")})`,
      cost: 0,
    });
  }
  return parts;
}
