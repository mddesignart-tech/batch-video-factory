import type { ModelRegistry, Project, Scene } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { parseDialogueLines } from "@/domain/dialogue-lines";
import { sceneCharacters } from "@/domain/scene-characters";
import { targetForAspect } from "@/media/render";
import { fileSha256OrNull } from "./asset-content";
import { imageReuseKey, videoReuseKey, voiceReuseKey } from "./asset-keys";
import { reusableKeys } from "./asset-reuse";
import { buildSceneImageRequest, voiceSettingsFor } from "./generation";
import { deriveSceneVideoFacts } from "./low-auto-facts";

/**
 * What the reuse engine already holds for one scene, BEFORE routing (QĐ-112).
 *
 * The estimator is pure and routes afterwards; it is handed, per asset kind,
 * the set of models for which an identical asset already exists. After it has
 * picked a model it only has to ask "is that one in the set?" - the same key,
 * built by the same functions generation uses, so preflight and execution can
 * not disagree about what is reused.
 *
 * Read-only: nothing is attached, marked or written.
 */
export interface SceneReuseFacts {
  /** image model key -> content hash of the identical image that exists. */
  imageModels: Record<string, string>;
  /** Hash of the keyframe the scene already OWNS (imported, or bought and on disk). */
  ownedKeyframeHash: string | null;
  /** keyframe hash ("none" = text-to-video) -> video model keys with an identical clip. */
  videoByKeyframe: Record<string, string[]>;
  /** Voice model keys for which EVERY spoken line of the scene already exists. */
  voiceModels: string[];
}

const mk = (m: Pick<ModelRegistry, "provider" | "modelId">) => `${m.provider}/${m.modelId}`;

export async function sceneReuseFacts(
  scenes: Scene[],
  project: Project,
  opts: { ownedKeyframe: (scene: Scene) => boolean },
): Promise<Map<string, SceneReuseFacts>> {
  const models = await prisma.modelRegistry.findMany({
    where: { enabled: true, type: { in: ["image", "video", "voice"] } },
    select: { provider: true, modelId: true, type: true },
  });
  const imageModels = models.filter((m) => m.type === "image");
  const videoModels = models.filter((m) => m.type === "video");
  const voiceModels = models.filter((m) => m.type === "voice");
  const target = targetForAspect(project.aspectRatio);

  // Pass 1: image + voice keys (they do not depend on anything else).
  const imageKeys = new Map<string, { scene: string; model: string }>();
  const voiceKeys = new Map<string, string[]>(); // scene -> keys per (model,line) encoded "model|line|key"
  const owned = new Map<string, string | null>();
  for (const scene of scenes) {
    owned.set(scene.id, opts.ownedKeyframe(scene) && scene.imagePath ? fileSha256OrNull(safeAbs(scene.imagePath)) : null);
    if (!opts.ownedKeyframe(scene)) {
      const shot = await buildSceneImageRequest(scene, project.stylePresetId);
      const seed = shot.characters.length === 1 ? (shot.characters[0]?.seed ?? undefined) : undefined;
      for (const m of imageModels) {
        const key = imageReuseKey({
          provider: m.provider,
          model: m.modelId,
          prompt: shot.prompt,
          negativePrompt: shot.negativePrompt,
          target,
          seed,
          referenceImages: shot.referenceImages,
          characters: shot.characters,
        });
        imageKeys.set(key, { scene: scene.id, model: mk(m) });
      }
    }
    const lines = parseDialogueLines(scene.dialogue, scene.narration, sceneCharacters(scene).speaking);
    const entries: string[] = [];
    for (const line of lines) {
      const settings = await voiceSettingsFor(line.speaker);
      for (const m of voiceModels) {
        entries.push(
          `${mk(m)}|${line.lineNumber}|${voiceReuseKey({
            provider: m.provider,
            model: m.modelId,
            text: line.text,
            voiceId: settings.voiceId,
            instructions: settings.instructions,
            speed: settings.speed,
            accent: settings.accent,
            targetDuration: scene.duration,
          })}`,
        );
      }
    }
    voiceKeys.set(scene.id, entries);
  }
  const out = new Map<string, SceneReuseFacts>();
  for (const scene of scenes) {
    // Per scene, so the scope policy (GLOBAL / PROJECT / SCENE) is judged from
    // THIS scene's point of view - the same judgement execution makes.
    const mine = [...imageKeys].filter(([, w]) => w.scene === scene.id).map(([k]) => k);
    const voiceMine = (voiceKeys.get(scene.id) ?? []).map((e) => e.split("|")[2]!);
    const found = await reusableKeys([...mine, ...voiceMine], { sceneId: scene.id, projectId: project.id });
    const facts: SceneReuseFacts = { imageModels: {}, ownedKeyframeHash: owned.get(scene.id) ?? null, videoByKeyframe: {}, voiceModels: [] };
    for (const [key, where] of imageKeys) {
      if (where.scene !== scene.id) continue;
      const asset = found.get(key);
      if (asset?.sha256) facts.imageModels[where.model] = asset.sha256;
    }
    const entries = voiceKeys.get(scene.id) ?? [];
    const lineCount = new Set(entries.map((e) => e.split("|")[1])).size;
    for (const m of voiceModels) {
      const perModel = entries.filter((e) => e.startsWith(`${mk(m)}|`));
      if (lineCount > 0 && perModel.length === lineCount && perModel.every((e) => found.has(e.split("|")[2]!))) {
        facts.voiceModels.push(mk(m));
      }
    }
    out.set(scene.id, facts);
  }

  // Pass 2: clips, for every keyframe the scene could end up with.
  const videoKeys = new Map<string, { scene: string; keyframe: string; model: string }>();
  for (const scene of scenes) {
    const facts = out.get(scene.id)!;
    const keyframes = new Set<string | null>([null, facts.ownedKeyframeHash, ...Object.values(facts.imageModels)]);
    const { videoPrompt } = deriveSceneVideoFacts(scene, { qualityMode: project.qualityMode, stage: "VIDEO" });
    for (const hash of keyframes) {
      if (hash === undefined) continue;
      for (const m of videoModels) {
        const key = videoReuseKey({
          provider: m.provider,
          model: m.modelId,
          prompt: videoPrompt,
          durationSeconds: scene.duration,
          target,
          keyframe: { hash },
        });
        videoKeys.set(key, { scene: scene.id, keyframe: hash ?? "none", model: mk(m) });
      }
    }
  }
  for (const scene of scenes) {
    const mine = [...videoKeys].filter(([, w]) => w.scene === scene.id);
    const clips = await reusableKeys(mine.map(([k]) => k), { sceneId: scene.id, projectId: project.id });
    for (const [key, where] of mine) {
      if (!clips.has(key)) continue;
      (out.get(scene.id)!.videoByKeyframe[where.keyframe] ??= []).push(where.model);
    }
  }
  return out;
}

function safeAbs(relative: string): string | null {
  try {
    return toAbsolute(relative);
  } catch {
    return null;
  }
}
