import fs from "node:fs";
import type { Project, Scene } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { toAbsolute } from "@/lib/paths";
import { parseJson } from "@/lib/utils";
import { projectContent } from "@/domain/content-legacy";
import { sceneCharacters } from "@/domain/scene-characters";
import { directVideo, type DirectorContext, type SceneSemantics } from "@/domain/camera-director";
import { CameraPlanSchema, cameraPromptPhrase, localSupport, type CameraPlan, type Transition } from "@/domain/camera-grammar";
import { inferLayers, layersPromptPhrase, sceneComplexity } from "@/domain/scene-layers";
import { parseScenePlan, ScenePlanSchema, type MotionRoute, type ScenePlan, type SceneLayer } from "@/domain/scene-plan";
import type { ScriptDoc } from "@/domain/script";
import { ambientFileFor, availableAmbientKinds } from "./ambient-library";
import type { LayerInputs, LocalCameraSpec } from "@/media/camera-motion";
import { projectReferenceAssets, sceneReferenceIds, type UniversalReference } from "./reference-assets";
import { projectFormat } from "./output-profile";

/**
 * SCENE PLANS for a project (QĐ-128): the AI Camera Director + the layer
 * model, run over the whole video at once so continuity holds.
 *
 *  - AUTO plans are (re)written; a USER plan is never overwritten - only
 *    "Đặt lại tự động" turns it back into AUTO.
 *  - A scene with no media yet also gets the plan in its own words: the camera
 *    line (`Scene.camera`, which both the image and the video prompt already
 *    treat as the authority on framing) and a "Scene depth:" sentence in its
 *    prompts. A scene that already has a picture or clip keeps its prompts, so
 *    nothing already bought is invalidated.
 *  - Never buys anything. Never changes `motionSource` (what was approved).
 */

const DEPTH_MARK = /\s*Scene depth: [^\n]*$/;

interface Loaded {
  project: Project;
  scenes: Scene[];
  refs: UniversalReference[];
  ctx: DirectorContext;
  roles: Map<number, string>;
}

async function load(projectId: string): Promise<Loaded> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const scenes = await prisma.scene.findMany({ where: { projectId, skipped: false }, orderBy: { sceneNumber: "asc" } });
  const refs = (await projectReferenceAssets(projectId)).filter((r) => r.enabled);
  const format = await projectFormat(projectId);
  const content = projectContent(project);
  const style = content.creative;
  const doc = parseJson<ScriptDoc | null>(project.scriptJson, null);
  const roles = new Map<number, string>((doc?.scenes ?? []).map((s) => [s.sceneNumber, s.sceneRole ?? ""]));
  return {
    project,
    scenes,
    refs,
    roles,
    ctx: {
      contentType: content.legacy ? null : content.contentType,
      comedyLevel: style.comedyLevel,
      tone: style.tone,
      emotion: style.emotionStyle,
      pacing: style.pacingStyle,
      creativePreset: style.preset,
      cameraPreset: style.cameraPreset,
      width: format.profile.width,
      height: format.profile.height,
    },
  };
}

function sceneRefs(scene: Scene, refs: UniversalReference[]) {
  const ids = new Set(sceneReferenceIds(scene));
  return refs
    .filter((r) => ids.has(r.id) || r.useThroughout)
    .map((r) => ({ id: r.id, type: r.type, name: r.name, critical: r.priority === "CRITICAL" }));
}

function semanticsOf(scene: Scene, l: Loaded): SceneSemantics {
  const cast = sceneCharacters(scene);
  return {
    sceneNumber: scene.sceneNumber,
    sceneRole: l.roles.get(scene.sceneNumber) ?? null,
    dialogue: scene.dialogue,
    narration: scene.narration,
    visualDescription: scene.visualDescription,
    characterAction: scene.characterAction,
    charactersPresent: cast.present,
    speakingCharacters: cast.speaking,
    references: sceneRefs(scene, l.refs).map(({ type, name, critical }) => ({ type, name, critical })),
    duration: scene.finalDuration ?? scene.duration,
    nativeClip: Boolean(scene.videoPath),
  };
}

/** What the scene's movement needs. A recommendation: paid motion still needs the router + approval. */
export function recommendedRoute(layers: SceneLayer[], camera: CameraPlan, composite: boolean): MotionRoute {
  if (layers.some((l) => l.enabled && l.layerType === "FOREGROUND" && l.motionType === "AI_MOTION")) return "VIDEO_AI";
  if (composite) return "COMPOSITE";
  if (camera.cameraMovement === "STATIC" && !layers.some((l) => l.enabled && l.layerType === "AMBIENT")) return "STATIC";
  return "LOCAL_MOTION";
}

function buildPlan(scene: Scene, l: Loaded, camera: CameraPlan, kept: ScenePlan | null): ScenePlan {
  const ambientOff = kept?.notes.includes("ambient-off") ?? false;
  const layers = inferLayers({
    visualDescription: scene.visualDescription,
    characterAction: scene.characterAction,
    charactersPresent: sceneCharacters(scene).present,
    speakingCharacters: sceneCharacters(scene).speaking,
    references: sceneRefs(scene, l.refs),
    ambientAvailable: availableAmbientKinds(),
    ambientEnabled: !ambientOff,
  });
  const notes = [
    ...(ambientOff ? ["ambient-off"] : []),
    ...layers
      .filter((x) => x.layerType === "AMBIENT" && x.motionType !== "AMBIENT_VIDEO")
      .map((x) => `${x.label}: chưa có file loop tại máy - chỉ mô tả trong prompt ảnh/video.`),
  ].slice(0, 10);
  const composite = kept?.route === "COMPOSITE";
  return ScenePlanSchema.parse({
    source: "AUTO",
    camera,
    layers,
    complexity: sceneComplexity(layers, camera.cameraMovement),
    route: recommendedRoute(layers, camera, composite),
    cameraNeedsVideoAi: localSupport(camera.cameraMovement) === "NONE" || camera.focusStyle === "RACK_FOCUS",
    notes,
  });
}

/** Write the plan's words into a scene that has no media yet (never into one that has). */
function promptUpdates(scene: Scene, plan: ScenePlan): Partial<Scene> {
  if (scene.imagePath || scene.videoPath) return {};
  const depth = layersPromptPhrase(plan.layers);
  const withDepth = (p: string) => (p.replace(DEPTH_MARK, "") + (depth ? ` Scene depth: ${depth}` : "")).trim();
  return {
    camera: cameraPromptPhrase(plan.camera),
    imagePrompt: withDepth(scene.imagePrompt),
    videoPrompt: withDepth(scene.videoPrompt),
  };
}

/**
 * Plan every scene of a project. USER plans are kept as they are; AUTO (and
 * missing) plans are rewritten. Returns how many scenes got a new AUTO plan.
 */
export async function planProjectScenes(
  projectId: string,
  opts: {
    /** Only scenes that already have an AUTO plan (a style change on an older project never adds plans to its scenes). */
    onlyPlanned?: boolean;
  } = {},
): Promise<{ planned: number; keptUser: number }> {
  const l = await load(projectId);
  if (l.scenes.length === 0) return { planned: 0, keptUser: 0 };
  const directed = directVideo(l.scenes.map((s) => semanticsOf(s, l)), l.ctx);
  let planned = 0;
  let keptUser = 0;
  for (let i = 0; i < l.scenes.length; i += 1) {
    const scene = l.scenes[i]!;
    const existing = parseScenePlan(scene.scenePlanJson);
    if (existing?.source === "USER") {
      keptUser += 1;
      continue;
    }
    if (opts.onlyPlanned && !existing) continue;
    const plan = buildPlan(scene, l, directed[i]!.plan, existing);
    await prisma.scene.update({ where: { id: scene.id }, data: { scenePlanJson: JSON.stringify(plan), ...promptUpdates(scene, plan) } });
    planned += 1;
  }
  await logger.info({ event: "scene_plan.directed", projectId, message: `AI Camera Director: ${planned} cảnh tự động, ${keptUser} cảnh người dùng chỉnh giữ nguyên ($0).` });
  return { planned, keptUser };
}

/** The plan to SHOW for a scene: its own, or (legacy / not planned yet) a fresh suggestion. */
export async function suggestedPlans(projectId: string): Promise<Map<string, { suggestion: ScenePlan; current: ScenePlan | null }>> {
  const l = await load(projectId);
  const directed = directVideo(l.scenes.map((s) => semanticsOf(s, l)), l.ctx);
  const out = new Map<string, { suggestion: ScenePlan; current: ScenePlan | null }>();
  l.scenes.forEach((scene, i) => {
    const current = parseScenePlan(scene.scenePlanJson);
    out.set(scene.id, { suggestion: buildPlan(scene, l, directed[i]!.plan, current), current });
  });
  return out;
}

/** DÙNG GỢI Ý: take the director's suggestion for this scene (AUTO). */
export async function applySuggestedPlan(sceneId: string): Promise<ScenePlan> {
  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  const all = await suggestedPlans(scene.projectId);
  const s = all.get(sceneId);
  if (!s) throw new Error("Cảnh đã bị bỏ qua - không có gợi ý camera.");
  await prisma.scene.update({ where: { id: sceneId }, data: { scenePlanJson: JSON.stringify(s.suggestion), ...promptUpdates(scene, s.suggestion) } });
  return s.suggestion;
}

/**
 * ĐỔI CAMERA: a person's choice. Becomes a USER plan that no automatic pass
 * overwrites, until "Đặt lại tự động".
 */
export async function setSceneCamera(
  sceneId: string,
  change: Partial<Pick<CameraPlan, "shotSize" | "cameraAngle" | "cameraMovement" | "cameraSpeed" | "focusStyle" | "transitionIn" | "cameraEasing">>,
): Promise<ScenePlan> {
  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  const base = parseScenePlan(scene.scenePlanJson) ?? (await suggestedPlans(scene.projectId)).get(sceneId)?.suggestion;
  if (!base) throw new Error("Không tìm thấy cảnh.");
  const camera = CameraPlanSchema.parse({ ...base.camera, ...change, reason: "Bạn đã chỉnh camera cho cảnh này." });
  const plan = ScenePlanSchema.parse({
    ...base,
    source: "USER",
    camera,
    cameraNeedsVideoAi: localSupport(camera.cameraMovement) === "NONE" || camera.focusStyle === "RACK_FOCUS",
    route: recommendedRoute(base.layers, camera, base.route === "COMPOSITE"),
  });
  await prisma.scene.update({ where: { id: sceneId }, data: { scenePlanJson: JSON.stringify(plan), ...promptUpdates(scene, plan) } });
  return plan;
}

/** Đặt lại tự động: the scene goes back to the director (re-planned with the whole video). */
export async function resetSceneCameraAuto(sceneId: string): Promise<void> {
  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  const current = parseScenePlan(scene.scenePlanJson);
  if (current) await prisma.scene.update({ where: { id: sceneId }, data: { scenePlanJson: JSON.stringify({ ...current, source: "AUTO" }) } });
  await planProjectScenes(scene.projectId);
}

/** Ambient on / off for a scene (kept across re-plans). */
export async function setSceneAmbient(sceneId: string, enabled: boolean): Promise<ScenePlan> {
  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  const base = parseScenePlan(scene.scenePlanJson) ?? (await suggestedPlans(scene.projectId)).get(sceneId)?.suggestion;
  if (!base) throw new Error("Không tìm thấy cảnh.");
  const notes = enabled ? base.notes.filter((n) => n !== "ambient-off") : [...new Set([...base.notes, "ambient-off"])];
  const layers = base.layers.map((x) => (x.layerType === "AMBIENT" ? { ...x, enabled } : x));
  const plan = ScenePlanSchema.parse({ ...base, layers, notes, route: recommendedRoute(layers, base.camera, base.route === "COMPOSITE") });
  await prisma.scene.update({ where: { id: sceneId }, data: { scenePlanJson: JSON.stringify(plan), ...promptUpdates(scene, plan) } });
  return plan;
}

/** PNG with an alpha channel (colour type 4 or 6) - usable as a cut-out foreground. */
export function pngHasAlpha(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(26);
    fs.readSync(fd, head, 0, 26, 0);
    fs.closeSync(fd);
    return head.toString("latin1", 1, 4) === "PNG" && (head[25] === 6 || head[25] === 4);
  } catch {
    return false;
  }
}

/** Data-relative path → absolute, when the file is there. */
export function existingAbsolute(p: string | null | undefined): string | null {
  if (!p) return null;
  const abs = toAbsolute(p);
  return fs.existsSync(abs) ? abs : null;
}

/** Sky-band ambient that may play over a single picture (never over the subject). */
const SKY_AMBIENT = new Set(["clouds", "birds", "smoke"]);

/**
 * What the renderer needs from a scene's plan. A scene WITHOUT a plan (every
 * scene made before scene plans) returns nothing, so it renders exactly as it
 * always did. A Video AI clip is never moved locally.
 */
export function renderInputsFor(scene: Pick<Scene, "scenePlanJson" | "imagePath" | "videoPath">): {
  localCamera?: LocalCameraSpec;
  layers?: LayerInputs | null;
  transitionIn?: Transition;
} {
  const plan = parseScenePlan(scene.scenePlanJson);
  if (!plan || plan.source === "LEGACY") return {};
  // A blend into this scene (cut / none stay absent, so the join and the recipe are V1's).
  const t = plan.camera.transitionIn;
  const blend = t !== "CUT" && t !== "NONE" ? { transitionIn: t } : {};
  return { ...renderStill(scene, plan), ...blend };
}

function renderStill(
  scene: Pick<Scene, "imagePath" | "videoPath">,
  plan: ScenePlan,
): { localCamera?: LocalCameraSpec; layers?: LayerInputs | null } {
  // PRESERVE_NATIVE_MOTION: a clip already moves; no local camera is laid over it.
  if (scene.videoPath) return {};
  const critical = plan.layers.some((x) => x.enabled && x.layerType === "FOREGROUND" && x.critical);
  const localCamera: LocalCameraSpec = {
    move: plan.camera.cameraMovement,
    speed: plan.camera.cameraSpeed,
    critical,
    easing: plan.camera.cameraEasing,
  };
  const picture = existingAbsolute(scene.imagePath);
  if (!picture) return { localCamera };
  const ambientLayers = plan.layers.filter((x) => x.enabled && x.layerType === "AMBIENT" && x.motionType === "AMBIENT_VIDEO");
  const foreground =
    plan.route === "COMPOSITE"
      ? (plan.layers
          .filter((x) => x.enabled && x.layerType === "FOREGROUND" && x.assetPath)
          .map((x) => existingAbsolute(x.assetPath))
          .find((p): p is string => Boolean(p) && pngHasAlpha(p!)) ?? null)
      : null;
  const ambient = ambientLayers
    .map((x) => {
      const kind = x.id.replace(/^amb-/, "");
      const file = ambientFileFor(kind);
      if (!file) return null;
      // Without a separate foreground, only sky-band ambient is allowed (nothing over a face).
      if (!foreground && !SKY_AMBIENT.has(kind)) return null;
      return { path: file, opacity: 0.3, region: foreground ? ("FULL" as const) : ("TOP" as const) };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);
  if (!foreground && ambient.length === 0) return { localCamera };
  return { localCamera, layers: { background: picture, foreground, ambient } };
}

// ------------------------------------------------------------- composite ---

const SUBJECT_TYPES = new Set(["PRODUCT", "CHARACTER", "ANIMAL", "TOY", "OBJECT"]);

/** A scene can be composited locally when it has a location picture AND a cut-out (transparent) subject picture. */
export async function compositeOption(sceneId: string): Promise<{ available: boolean; environment?: string; subject?: string; reason: string }> {
  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  const refs = (await projectReferenceAssets(scene.projectId)).filter((r) => r.enabled);
  const ids = new Set(sceneReferenceIds(scene));
  const inScene = refs.filter((r) => ids.has(r.id) || r.useThroughout);
  const env = inScene.find((r) => r.type === "ENVIRONMENT" && r.images.some((i) => i.exists));
  const subject = inScene
    .filter((r) => SUBJECT_TYPES.has(r.type))
    .flatMap((r) => r.images.filter((i) => i.exists).map((i) => ({ r, i })))
    .find(({ i }) => pngHasAlpha(toAbsolute(i.path)));
  if (!env) return { available: false, reason: "Cần ảnh Bối cảnh (tham chiếu ENVIRONMENT) cho cảnh này." };
  if (!subject) return { available: false, environment: env.name, reason: "Cần ảnh chủ thể đã tách nền (PNG trong suốt)." };
  return { available: true, environment: env.name, subject: subject.r.name, reason: `Ghép "${subject.r.name}" lên "${env.name}" tại máy · $0.` };
}

/**
 * GHÉP LỚP TẠI MÁY: the location picture becomes the scene's picture (imported,
 * $0 - no image is generated) and the transparent subject is drawn over it with
 * the camera's parallax. Motion is local. A USER plan.
 */
export async function enableComposite(sceneId: string): Promise<ScenePlan> {
  const option = await compositeOption(sceneId);
  if (!option.available) throw new Error(option.reason);
  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  const refs = (await projectReferenceAssets(scene.projectId)).filter((r) => r.enabled);
  const env = refs.find((r) => r.name === option.environment && r.type === "ENVIRONMENT")!;
  const envImage = env.images.find((i) => i.primary && i.exists) ?? env.images.find((i) => i.exists)!;
  const subjectRef = refs.find((r) => r.name === option.subject && SUBJECT_TYPES.has(r.type))!;
  const subjectImage = subjectRef.images.find((i) => i.exists && pngHasAlpha(toAbsolute(i.path)))!;
  const { importSceneImage } = await import("./imported-image");
  await importSceneImage({ sceneId, bytes: fs.readFileSync(toAbsolute(envImage.path)), originalFilename: envImage.filename, via: "scene-composite" });
  const base = parseScenePlan(scene.scenePlanJson) ?? (await suggestedPlans(scene.projectId)).get(sceneId)!.suggestion;
  const layers = base.layers.map((x) =>
    x.layerType === "FOREGROUND" && (x.entityId === subjectRef.id || x.label === subjectRef.name || x.entityType === "PRODUCT" || x.entityType === "CHARACTER")
      ? { ...x, assetPath: subjectImage.path }
      : x,
  );
  if (!layers.some((x) => x.assetPath === subjectImage.path)) {
    layers.unshift({ ...layers[0]!, id: "fg-cutout", label: subjectRef.name, assetPath: subjectImage.path, layerType: "FOREGROUND" });
  }
  const plan = ScenePlanSchema.parse({ ...base, source: "USER", layers, route: "COMPOSITE" });
  await prisma.scene.update({
    where: { id: sceneId },
    data: { scenePlanJson: JSON.stringify(plan), motionMode: "LOCAL_MOTION", motionSource: "LOCAL_MOTION" },
  });
  await logger.info({ event: "scene_plan.composite", projectId: scene.projectId, message: `Cảnh ${scene.sceneNumber}: ghép lớp tại máy (${option.reason})` });
  return plan;
}

/** DÙNG CAMERA LOCAL: this scene moves on this machine ($0); free always wins. */
export async function useLocalCamera(sceneId: string): Promise<void> {
  await prisma.scene.update({ where: { id: sceneId }, data: { motionMode: "LOCAL_MOTION", motionSource: "LOCAL_MOTION" } });
}
