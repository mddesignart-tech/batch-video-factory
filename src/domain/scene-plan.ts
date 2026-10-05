/**
 * SCENE PLAN (QĐ-128) - what a scene is made of and how it is shot:
 *
 *   SCENE
 *   ├── FOREGROUND   main characters / presenter / product / main animal
 *   ├── MIDGROUND    furniture, props, secondary characters, a car mid-distance
 *   ├── BACKGROUND   street, kitchen, forest, classroom, sky
 *   ├── AMBIENT      passers-by, traffic, birds, clouds, leaves, steam
 *   ├── OVERLAY      (optional) graphics on top
 *   └── CAMERA       one CameraPlan (camera-grammar.ts)
 *
 * Stored as `Scene.scenePlanJson`. NULL = a scene from before this existed:
 * it renders EXACTLY as before (one picture, slow push-in) and nothing is
 * regenerated. A layer is only an entity + references + motion + depth - there
 * is no separate engine for people, animals, products, cars or toys.
 *
 * Pure: no database, no provider.
 */

import { z } from "zod";
import { CameraPlanSchema, type CameraPlan } from "./camera-grammar";
import { classifyCameraIntent } from "./camera-intent";

export const SCENE_PLAN_VERSION = "scene-plan-v1";

export const LAYER_TYPES = ["FOREGROUND", "MIDGROUND", "BACKGROUND", "AMBIENT", "OVERLAY"] as const;
export type LayerType = (typeof LAYER_TYPES)[number];
export const VI_LAYER_TYPE: Record<LayerType, string> = {
  FOREGROUND: "Tiền cảnh",
  MIDGROUND: "Trung cảnh",
  BACKGROUND: "Hậu cảnh",
  AMBIENT: "Chuyển động nền",
  OVERLAY: "Lớp phủ",
};

export const ENTITY_TYPES = ["CHARACTER", "PRODUCT", "ANIMAL", "OBJECT", "VEHICLE", "PERSON", "ENVIRONMENT", "NATURE", "EFFECT"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** How a layer moves. AI_MOTION = only a generative video model can do it well. */
export const LAYER_MOTIONS = [
  "STATIC",
  "IDLE",
  "TALKING",
  "SLOW_PAN",
  "PARALLAX",
  "LOOP",
  "DRIFT",
  "CROSS",
  "SWAY",
  "FLICKER",
  "RISE",
  "AMBIENT_VIDEO",
  "AI_MOTION",
] as const;
export type LayerMotion = (typeof LAYER_MOTIONS)[number];

/** Internal parallax defaults (never shown in Simple Mode). */
export const PARALLAX_FACTOR: Record<LayerType, number> = { FOREGROUND: 1, MIDGROUND: 0.5, BACKGROUND: 0.2, AMBIENT: 0.35, OVERLAY: 0 };

export const LayerSchema = z.object({
  id: z.string().max(40),
  layerType: z.enum(LAYER_TYPES),
  /** Higher = nearer the viewer. */
  zIndex: z.number().int().min(0).max(99),
  /** What it is, in words (Vietnamese for the editor; the prompt phrase is separate). */
  label: z.string().max(120),
  /** English phrase used in Image / Video prompts. */
  promptPhrase: z.string().max(240).default(""),
  entityType: z.enum(ENTITY_TYPES),
  /** Character name / reference id when the layer is one. */
  entityId: z.string().max(80).optional(),
  referenceAssetIds: z.array(z.string().max(80)).max(8).default([]),
  motionType: z.enum(LAYER_MOTIONS).default("STATIC"),
  motionDirection: z.enum(["NONE", "LEFT", "RIGHT", "UP", "DOWN", "IN", "OUT"]).default("NONE"),
  motionSpeed: z.enum(["VERY_SLOW", "SLOW", "MEDIUM", "FAST"]).default("SLOW"),
  /** 0 nearest .. 1 farthest. */
  depth: z.number().min(0).max(1),
  parallaxFactor: z.number().min(0).max(1).optional(),
  /** Seconds within the scene; null = whole scene. */
  startTime: z.number().min(0).nullable().default(null),
  endTime: z.number().min(0).nullable().default(null),
  enabled: z.boolean().default(true),
  /** CRITICAL reference: shown exactly, moved only gently. */
  critical: z.boolean().default(false),
  /** A local file for this layer (cut-out PNG, background picture, ambient loop). Data-relative. */
  assetPath: z.string().max(400).optional(),
  /** G8: size of a cut-out within its layout box (1 = a standing person); a bird or a product is smaller. */
  scale: z.number().min(0.1).max(1.5).optional(),
  /** G8: where a cut-out stands (its bottom edge, share of the frame height): a product on a counter top. */
  floorY: z.number().min(0.2).max(1).optional(),
  /** G8: on a BACKGROUND layer, where its far ground line is (share of height) - distant cars / passers-by stand there. */
  horizonY: z.number().min(0.2).max(0.95).optional(),
});
export type SceneLayer = z.infer<typeof LayerSchema>;

export const MOTION_ROUTES = ["STATIC", "LOCAL_MOTION", "VIDEO_AI", "IMAGE_TO_VIDEO", "COMPOSITE"] as const;
export type MotionRoute = (typeof MOTION_ROUTES)[number];
export const VI_MOTION_ROUTE: Record<MotionRoute, string> = {
  STATIC: "Ảnh tĩnh",
  LOCAL_MOTION: "Chuyển động tại máy",
  VIDEO_AI: "Video AI",
  IMAGE_TO_VIDEO: "Ảnh → Video AI",
  COMPOSITE: "Ghép lớp tại máy",
};

export const ScenePlanSchema = z.object({
  version: z.string().default(SCENE_PLAN_VERSION),
  /** AUTO = the Camera Director's; USER = a person changed it (never overwritten by AUTO). */
  source: z.enum(["AUTO", "USER", "LEGACY"]).default("AUTO"),
  camera: CameraPlanSchema,
  layers: z.array(LayerSchema).max(12).default([]),
  complexity: z.enum(["LOW", "MEDIUM", "HIGH"]).default("LOW"),
  /** What the scene's movement needs; the paid decision itself stays with the router + approval. */
  route: z.enum(MOTION_ROUTES).default("LOCAL_MOTION"),
  /** The camera asks for something only a generative model does (orbit, crane, rack focus...). */
  cameraNeedsVideoAi: z.boolean().default(false),
  /** Ambient wanted but no local loop available: described in prompts only. */
  notes: z.array(z.string().max(200)).max(10).default([]),
  /** G5: how strongly local ambient loops show (the motion preset's choice); absent = full. */
  ambientIntensity: z.number().min(0).max(1).optional(),
});
export type ScenePlan = z.infer<typeof ScenePlanSchema>;

export function parseScenePlan(json: string | null | undefined): ScenePlan | null {
  if (!json) return null;
  try {
    const parsed = ScenePlanSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * A scene from before scene plans existed, described in the new vocabulary -
 * for DISPLAY only. Rendering a legacy scene does not read this: it keeps the
 * exact FFmpeg chain it always had (a slow push-in on the picture).
 */
export function legacyScenePlan(scene: { camera?: string | null; visualDescription?: string | null; charactersPresent?: string[]; motionSource?: string | null }): ScenePlan {
  const intent = classifyCameraIntent({ camera: scene.camera, visualDescription: scene.visualDescription });
  const camera: CameraPlan = CameraPlanSchema.parse({
    shotSize: guessShot(scene.camera ?? ""),
    cameraAngle: "EYE_LEVEL",
    cameraMovement: "SLOW_ZOOM_IN",
    cameraSpeed: "SLOW",
    focusStyle: "AUTO",
    subjectFocus: (scene.charactersPresent ?? []).slice(0, 2).join(" + "),
    reason: `Cảnh cũ: giữ chuyển động như trước (zoom vào chậm). ${intent.reason}`,
  });
  return ScenePlanSchema.parse({
    source: "LEGACY",
    camera,
    layers: [
      {
        id: "fg",
        layerType: "FOREGROUND",
        zIndex: 10,
        label: (scene.charactersPresent ?? []).join(" + ") || "Ảnh cảnh hiện có",
        entityType: "CHARACTER",
        depth: 0.2,
      },
    ],
    route: scene.motionSource === "AI_VIDEO" ? "VIDEO_AI" : "LOCAL_MOTION",
  });
}

function guessShot(camera: string): CameraPlan["shotSize"] {
  const c = camera.toLowerCase();
  if (/extreme close/.test(c)) return "EXTREME_CLOSE_UP";
  if (/medium close/.test(c)) return "MEDIUM_CLOSE_UP";
  if (/close/.test(c)) return "CLOSE_UP";
  if (/establish/.test(c)) return "ESTABLISHING";
  if (/full/.test(c)) return "FULL_SHOT";
  if (/wide/.test(c)) return "WIDE";
  return "MEDIUM";
}
