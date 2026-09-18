import fs from "node:fs";

import { classifyCameraIntent, type CameraIntent } from "@/domain/camera-intent";
import {
  applyCameraGuardrails,
  findPromptContradictions,
  RUNWAY_MAX_PROMPT_CHARS,
  type GuardedPrompt,
} from "@/domain/video-prompt";
import { decideMotion, effectiveMotionSource, type MotionResolution } from "@/domain/local-motion";
import { sceneCharacters } from "@/domain/scene-characters";
import { extractSignals } from "./complexity";
import { toAbsolute } from "@/lib/paths";
import type { Complexity, QualityMode, SpendPriority } from "@/domain/enums";
import type { LowAutoSceneFacts } from "./ai-router";
import type { LowAutoStage } from "@/domain/low-auto";

/**
 * ONE derivation of the facts the LOW_AUTO gate is judged against.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The gate's inputs were being assembled by hand in three places - the real
 * video path in `generation.ts`, the dry-run in `scripts/dry-run-low-auto.ts`
 * and the proof in `scripts/prove-low-auto.ts`. Three hand-written copies of
 * one derivation is not duplication in the tidiness sense; it is a way for the
 * simulation and the thing being simulated to disagree about money, silently,
 * while both keep passing their own tests.
 *
 * They HAD already drifted. The dry-run answered `hasKeyframe` by looking on
 * disk; production answered it from the `imagePath` COLUMN. A scene whose row
 * still named an image that had been deleted was therefore ineligible in the
 * report and eligible in the pipeline - and the pipeline is the one that pays.
 * The disk check is the correct reading of the question the gate is asking,
 * because h3_max is image-to-video and a filename is not an image.
 *
 * So the derivation lives here, once, and the three callers pass it the same
 * scene. What a caller still supplies itself is everything that is about the
 * ENVIRONMENT rather than the scene - the vendor wallets and the per-video cap -
 * because those are read from different places at different times and pretending
 * they come from the scene would put a database read inside a pure function.
 */

/** The scene columns this derivation reads. A Prisma `Scene` satisfies it. */
export interface SceneFactsInput {
  duration: number;
  camera: string;
  visualDescription: string;
  characterAction: string;
  videoPrompt: string;
  complexity: string;
  spendPriority: string;
  motionSource: string;
  /**
   * AUTO | LOCAL_MOTION | VIDEO_AI - what a person asked for, if they did.
   *
   * Optional so every existing caller and fixture keeps working: a row without
   * it has no instruction to honour, which is exactly what AUTO means.
   */
  motionMode?: string;
  imagePath: string | null;
  videoProvider: string | null;
  videoModel: string | null;
  charactersPresentJson: string;
  speakingCharactersJson: string;
  primaryCharactersJson: string;
}

export interface SceneFactsResult {
  /** Ready to hand to `routeScene` as `ctx.lowAuto`, minus the environment half. */
  facts: Omit<LowAutoSceneFacts, "providerBudgets" | "perVideoCapRemaining">;
  /**
   * The prompt as it will actually be SENT, guardrails applied.
   *
   * Returned rather than recomputed by the caller so that the text the gate
   * judged and the text in the request body are the same string. Composing it
   * twice is how `promptGuarded: true` ends up describing a prompt other than
   * the one that left the machine.
   */
  videoPrompt: string;
  guarded: GuardedPrompt;
  cameraIntent: CameraIntent;
  motion: MotionResolution;
  characterCount: number;
  /** True when the row names an image AND that image is on disk. */
  hasKeyframe: boolean;
  contradictions: string[];
}

export interface SceneFactsOptions {
  qualityMode: string;
  /** VIDEO (the stricter reading) unless a planner says otherwise. */
  stage?: LowAutoStage;
  /**
   * Ignore the manual pin when resolving motion.
   *
   * Only `prove-low-auto` sets this, and only on an in-memory COPY of a scene:
   * every LOW scene that still wants a paid clip is pinned, and a pin
   * short-circuits routing, so proving the grant works at all needs one scene
   * with the pin lifted. It is never set against a row that will be billed.
   */
  ignoreManualPin?: boolean;
  /** Injected by tests that have no data directory. Defaults to a real stat. */
  keyframeExists?: (relativePath: string) => boolean;
}

function defaultKeyframeExists(relativePath: string): boolean {
  try {
    return fs.existsSync(toAbsolute(relativePath));
  } catch {
    // `toAbsolute` throws on a path that escapes the data root. A stored path
    // we refuse to resolve is not a keyframe we can send.
    return false;
  }
}

export function deriveSceneVideoFacts(
  scene: SceneFactsInput,
  opts: SceneFactsOptions,
): SceneFactsResult {
  const characterCount = sceneCharacters(scene).present.length || 1;
  const cameraIntent = classifyCameraIntent(scene);
  const guarded = applyCameraGuardrails(scene.videoPrompt, cameraIntent, RUNWAY_MAX_PROMPT_CHARS);
  const contradictions = findPromptContradictions(guarded.text);

  const exists = opts.keyframeExists ?? defaultKeyframeExists;
  const hasKeyframe = Boolean(scene.imagePath) && exists(scene.imagePath ?? "");

  // An explicit instruction, however it was written down.
  //
  // Naming a provider and a model is one way to say "buy a clip for this
  // scene". An imported storyboard says it by writing motion_mode=VIDEO_AI,
  // and that is the same decision by a person - so it gets the same weight.
  // Without this, "free wins" would silently downgrade a scene the operator
  // explicitly asked to send to a video model, which is the mirror image of
  // the silent override that rule exists to prevent.
  const pinned =
    opts.ignoreManualPin === true
      ? false
      : Boolean(scene.videoProvider && scene.videoModel) ||
        scene.motionMode === "VIDEO_AI";
  const motion = effectiveMotionSource(
    scene.motionSource,
    decideMotion({
      qualityMode: opts.qualityMode as QualityMode,
      complexity: scene.complexity as Complexity,
      spendPriority: scene.spendPriority as SpendPriority,
      characterCount,
    }),
    { manuallyPinned: pinned },
  );

  return {
    facts: {
      stage: opts.stage ?? "VIDEO",
      motionSource: motion.source,
      hasKeyframe,
      cameraMode: cameraIntent.mode,
      repeatedSmallObjects: extractSignals(scene).repeatedSmallObjects,
      // `skipped` counts as guarded: the composer looked at the prompt and
      // found the guardrail already present. Treating that as ungoverned would
      // refuse the very prompts that were written correctly to begin with.
      promptGuarded: guarded.added.length > 0 || guarded.skipped.length > 0,
      contradictions,
    },
    videoPrompt: guarded.text,
    guarded,
    cameraIntent,
    motion,
    characterCount,
    hasKeyframe,
    contradictions,
  };
}
