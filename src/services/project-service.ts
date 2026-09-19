import type { Project } from "@prisma/client";
import type { QualityMode, RouterStrategy } from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { sceneCharacters } from "@/domain/scene-characters";
import { logger } from "@/lib/logger";
import fs from "node:fs";
import { ensureProjectDirs, toAbsolute } from "@/lib/paths";
import { getSettings } from "@/lib/settings";
import { round } from "@/lib/utils";
import { ScriptSchema, type ScriptDoc } from "@/domain/script";
import { enqueue } from "@/jobs/queue";
import { isMockMode } from "@/lib/env";
import { routeScene } from "./ai-router";
import { checkBudget, type BudgetCheck } from "./budget";
import {
  estimateAllModes,
  estimateProject,
  type PlannedSceneInput,
  type ProjectEstimate,
} from "./cost-estimator";
import { generateScript, recordConcept } from "./script-service";
import { availableProviderNames } from "./provider-health";
import { speechTextFor } from "./generation";
import { deriveSceneVideoFacts } from "./low-auto-facts";
import { providerSpendBreakdown } from "./provider-budget";

/**
 * Project lifecycle.
 *
 * The critical design rule from the brief lives here: generating a script is
 * free and automatic, but generating *media* is a separate, explicit, budget
 * checked step. Nothing in this file spends money without the operator having
 * pressed "TẠO MEDIA" (or having opted into it for a whole batch).
 */

export interface CreateProjectInput {
  idiomId: string;
  qualityMode: QualityMode;
  routerStrategy?: RouterStrategy;
  stylePresetId?: string;
  targetDuration?: number;
  maxBudget?: number;
  batchId?: string;
  autoGenerateScript?: boolean;
  /** Batch mode only. Single projects always wait for explicit approval. */
  autoStartMedia?: boolean;
}

export async function createProjectForIdiom(
  input: CreateProjectInput,
): Promise<Project> {
  const idiom = await prisma.idiom.findUnique({ where: { id: input.idiomId } });
  if (!idiom) throw new Error("Không tìm thấy thành ngữ.");

  const settings = await getSettings();
  const preset = input.stylePresetId
    ? await prisma.stylePreset.findUnique({ where: { id: input.stylePresetId } })
    : await prisma.stylePreset.findFirst({ where: { isDefault: true } });

  const project = await prisma.project.create({
    data: {
      idiomId: idiom.id,
      batchId: input.batchId ?? null,
      title: `${idiom.phrase} - Funny Idiom Short`,
      status: "draft",
      qualityMode: input.qualityMode,
      routerStrategy: input.routerStrategy ?? settings.defaultRouterStrategy,
      stylePresetId: preset?.id ?? null,
      targetDuration: input.targetDuration ?? settings.defaultTargetDuration,
      aspectRatio: preset?.aspectRatio ?? "9:16",
      maxBudget: round(input.maxBudget ?? settings.defaultMaxBudget),
    },
  });

  ensureProjectDirs(project.id);
  await prisma.idiom.update({
    where: { id: idiom.id },
    data: { status: idiom.status === "unused" ? "planned" : idiom.status },
  });

  await logger.info({
    event: "project.created",
    projectId: project.id,
    message: `Tạo dự án cho "${idiom.phrase}" (${input.qualityMode}).`,
  });

  if (input.autoGenerateScript) {
    await generateProjectScript(project.id);
    if (input.autoStartMedia) {
      // A batch already had its budget approved as a whole, so individual
      // projects inside it may start without a second confirmation.
      await startMediaGeneration(project.id, { skipBudgetPrompt: true });
    }
  }

  return prisma.project.findUniqueOrThrow({ where: { id: project.id } });
}

// ------------------------------------------------------------------ script ---

/**
 * Pick which text model writes the script.
 *
 * Business logic must not name a provider. The choice comes from the same place
 * every other choice comes from - the enabled rows in ModelRegistry, filtered by
 * which providers are usable right now, ranked by the router.
 *
 * Mock mode short-circuits: the registry may list real text models, but the
 * provider layer would hand back a mock anyway, so naming the mock row here
 * keeps the ledger and the logs honest about what actually ran.
 */
export async function selectTextModel(
  qualityMode: QualityMode,
): Promise<{ provider: string; model: string }> {
  if (isMockMode()) return { provider: "mock", model: "mock-text-1" };

  const [models, availableProviders] = await Promise.all([
    prisma.modelRegistry.findMany({ where: { type: "text", enabled: true } }),
    availableProviderNames(),
  ]);

  const decision = routeScene(models, {
    type: "text",
    qualityMode,
    strategy: "AUTO",
    // A script is one text call; scene-shaped inputs do not apply, but the
    // router still filters by provider availability and price.
    complexity: "LOW",
    spendPriority: "NORMAL",
    durationSeconds: 0,
    characterCount: 1,
    consistencyRequired: false,
    needs1080p: false,
    needsReferenceImage: false,
    // The real ceiling is enforced by the spend guard immediately before the
    // call; here we only need the router to not reject everything.
    budgetRemaining: Number.MAX_SAFE_INTEGER,
    usage: { tokens: 5000, jobs: 1 },
    availableProviders,
  });

  return { provider: decision.provider, model: decision.modelId };
}

export async function generateProjectScript(projectId: string): Promise<ScriptDoc> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { idiom: true, stylePreset: true },
  });
  if (!project) throw new Error("Không tìm thấy dự án.");

  const characters = await prisma.character.findMany({
    where: { enabled: true },
    orderBy: { createdAt: "asc" },
    take: 4,
  });

  const stylePrompt = [
    project.stylePreset?.positivePrompt ?? "",
    project.stylePreset?.lightingStyle ?? "",
    project.stylePreset?.visualTone ?? "",
  ]
    .filter(Boolean)
    .join(", ");

  const { script, score, rewritten, duplicateAvoided } = await generateScript({
    idiomId: project.idiomId,
    idiom: project.idiom.phrase,
    meaning: project.idiom.meaning,
    literalMeaning: project.idiom.literalMeaning,
    exampleSentence: project.idiom.exampleSentence,
    targetDuration: project.targetDuration,
    stylePrompt,
    characters: characters.map((c) => ({
      name: c.name,
      personality: c.personality,
      visualPrompt: c.visualPrompt,
    })),
    ...(await selectTextModel(project.qualityMode as QualityMode)),
    projectId: project.id,
  });

  await persistScript(project.id, script);

  const { angleKeyFor, scriptHashFor } = await import("./script-service");
  await prisma.project.update({
    where: { id: project.id },
    data: {
      title: script.title,
      scriptJson: JSON.stringify(script),
      scriptHash: scriptHashFor(script),
      angleKey: angleKeyFor(script),
      scriptScoreJson: JSON.stringify({ ...score, rewritten, duplicateAvoided }),
      status: "script_ready",
    },
  });
  await recordConcept(project.idiomId, project.id, script);

  return script;
}

/** Replace the project's scenes with the ones in the script document. */
export async function persistScript(
  projectId: string,
  script: ScriptDoc,
): Promise<void> {
  const validated = ScriptSchema.parse(script);

  await prisma.$transaction([
    prisma.scene.deleteMany({ where: { projectId } }),
    prisma.scene.createMany({
      data: validated.scenes.map((scene) => ({
        projectId,
        sceneNumber: scene.sceneNumber,
        duration: scene.duration,
        visualDescription: scene.visualDescription,
        dialogue: scene.dialogue,
        narration: scene.narration,
        subtitle: scene.subtitle,
        camera: scene.camera,
        characterAction: scene.characterAction,
        soundEffect: scene.soundEffect,
        imagePrompt: scene.imagePrompt,
        videoPrompt: scene.videoPrompt,
        complexity: scene.complexity,
        spendPriority: scene.spendPriority,
        charactersPresentJson: JSON.stringify(scene.charactersPresent),
        speakingCharactersJson: JSON.stringify(scene.speakingCharacters),
        primaryCharactersJson: JSON.stringify(scene.primaryCharacters),
      })),
    }),
  ]);
}

// -------------------------------------------------------------- estimating ---

/**
 * A stored path that still points at a real file.
 *
 * The column and the disk disagree more often than they should - a cleanup, a
 * moved data directory, a half-finished run - and every caller here is deciding
 * whether something has to be BOUGHT. `toAbsolute` throws on a path that escapes
 * the data root, and a path we refuse to resolve is not an asset we have.
 */
function fileOnDisk(relative: string | null | undefined): boolean {
  if (!relative) return false;
  try {
    return fs.existsSync(toAbsolute(relative));
  } catch {
    return false;
  }
}

export async function buildPlannedScenes(
  projectId: string,
): Promise<PlannedSceneInput[]> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("Không tìm thấy dự án.");
  const scenes = await prisma.scene.findMany({
    where: { projectId, skipped: false },
    orderBy: { sceneNumber: "asc" },
    include: { dialogueLines: true },
  });
  return scenes.map((scene) => ({
    sceneNumber: scene.sceneNumber,
    duration: scene.duration,
    complexity: scene.complexity as "LOW" | "MEDIUM" | "HIGH",
    spendPriority: scene.spendPriority as "LOW" | "NORMAL" | "HIGH",
    characterCount: sceneCharacters(scene).present.length || 1,
    speechText: speechTextFor(scene),
    manualImageProvider: scene.imageProvider,
    manualImageModel: scene.imageModel,
    // Only an OPERATOR's pin, never the router's write-back. The estimate has
    // to ask the same question the pipeline will ask, and since QĐ-069 the
    // pipeline reads `videoModelPinned`. Passing the pair alone made the
    // forecast re-quote whatever the last run happened to use, and skip the
    // LOW_AUTO gate while doing it.
    manualVideoProvider: scene.videoModelPinned ? scene.videoProvider : null,
    manualVideoModel: scene.videoModelPinned ? scene.videoModel : null,
    manualVoiceProvider: scene.voiceProvider,
    manualVoiceModel: scene.voiceModel,
    // An imported keyframe is already on disk and already paid for - by the
    // operator, before this app ever saw it.
    hasSuppliedKeyframe: scene.imageSource === "IMPORTED" && Boolean(scene.imagePath),
    // Assets a RESUME will hand back rather than buy. Both are checked on disk:
    // a column naming a file that has since been deleted is not an asset, and
    // treating it as one would forecast $0 for a clip the run really does buy -
    // the one direction an estimate must never be wrong in. QĐ-071.
    hasExistingVideo: fileOnDisk(scene.videoPath),
    hasExistingVoice:
      scene.dialogueLines.length > 0 &&
      // EVERY line, not any: a scene with two lines and one file still buys the
      // second, and calling that "reused" under-states the bill.
      scene.dialogueLines.every(
        (line) => line.status === "completed" && fileOnDisk(line.outputPath),
      ),
    // The same derivation `generateSceneVideo` runs. The preview is what the
    // real-run script checks its plan against before spending, so a preview
    // that refuses a scene the generator would route stops a batch that was
    // fine - and one that prices it at $0 waves through a batch that is not.
    lowAutoFacts: deriveSceneVideoFacts(scene, {
      qualityMode: project.qualityMode,
      stage: "VIDEO",
    }).facts,
  }));
}

export interface ProjectCostPreview {
  current: ProjectEstimate;
  modes: Record<"ECONOMY" | "BALANCED" | "QUALITY", ProjectEstimate>;
  budget: BudgetCheck;
}

export async function previewProjectCost(
  projectId: string,
  opts: {
    /**
     * Price the project as if the per-video ceiling were not there.
     *
     * The estimator walks the budget down scene by scene, so a project that
     * runs out stops pricing and reports a TRUNCATED figure - which then reads
     * as the video's cost. It is not: it is the part that fitted. For a video
     * already known to be over its ceiling, the useful number is what it would
     * really cost, because that is what the operator needs in order to decide
     * how much to raise the ceiling by. See QĐ-081.
     */
    ignoreBudget?: boolean;
  } = {},
): Promise<ProjectCostPreview> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("Không tìm thấy dự án.");

  const [scenes, models, availableProviders, wallets] = await Promise.all([
    buildPlannedScenes(projectId),
    prisma.modelRegistry.findMany({ where: { enabled: true } }),
    availableProviderNames(),
    providerSpendBreakdown(),
  ]);

  const base = {
    scenes,
    models,
    maxBudget: opts.ignoreBudget ? Number.MAX_SAFE_INTEGER : project.maxBudget,
    availableProviders,
    // Native 1080p is a QUALITY-mode demand, exactly as services/generation
    // decides it at generation time. Hardcoding `true` here made the PREVIEW
    // disagree with the RUN: gen4_turbo has no native 1080p, so the preview
    // reported "no video model fits this scene" for a scene the generator would
    // have routed to Runway without hesitation.
    //
    // An estimate that refuses work the generator would do is not a cautious
    // estimate - it is a wrong one, and it blocks a video that is fine. The
    // same reasoning is already written out in `routeFor`; this call site was
    // simply left behind when that was fixed.
    needs1080p: project.qualityMode === "QUALITY",
    // The environment half of the LOW_AUTO gate. Real wallets, so the preview
    // cannot promise a clip this account has no money for.
    providerBudgets: Object.fromEntries(wallets.map((w) => [w.provider, w.remainingUsd])),
    // The script is already written - imported, or generated earlier and stored.
    // Either way no text model will be called, so pricing one prices work that
    // will not happen. QĐ-079.
    hasScript: project.scriptJson !== null && project.scriptJson.trim().length > 0,
  };

  const current = estimateProject({
    ...base,
    qualityMode: project.qualityMode as QualityMode,
    strategy: project.routerStrategy as RouterStrategy,
  });

  return {
    current,
    modes: estimateAllModes({ ...base, strategy: "AUTO" }),
    budget: checkBudget(current.breakdown.total, project.maxBudget),
  };
}

// ------------------------------------------------------------- generation ---

export interface StartMediaResult {
  started: boolean;
  jobsQueued: number;
  budget: BudgetCheck;
  errors: string[];
}

/**
 * The paid step. Refuses to start when the estimate exceeds MAX BUDGET, and
 * returns the reason plus concrete ways down rather than a bare failure.
 */
export async function startMediaGeneration(
  projectId: string,
  opts: { skipBudgetPrompt?: boolean } = {},
): Promise<StartMediaResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { scenes: { orderBy: { sceneNumber: "asc" } } },
  });
  if (!project) throw new Error("Không tìm thấy dự án.");
  if (project.scenes.length === 0) {
    throw new Error("Dự án chưa có kịch bản. Hãy tạo kịch bản trước.");
  }

  const preview = await previewProjectCost(projectId);

  if (!preview.budget.allowed) {
    await logger.warn({
      event: "project.budget_blocked",
      projectId,
      estimatedCost: preview.budget.estimatedTotal,
      message: preview.budget.message,
    });
    return {
      started: false,
      jobsQueued: 0,
      budget: preview.budget,
      errors: [preview.budget.message, ...preview.current.errors],
    };
  }

  if (preview.current.errors.length > 0 && !opts.skipBudgetPrompt) {
    return {
      started: false,
      jobsQueued: 0,
      budget: preview.budget,
      errors: preview.current.errors,
    };
  }

  // A scene that wants a video model nobody has approved for it stops the whole
  // project, and it stops it even for a batch that said "do not ask me again".
  //
  // That exception is deliberate. Skipping the prompt means "I approved the
  // budget, stop asking about money" - it does not mean "pick something for me".
  // The two honest alternatives here are both wrong: falling back to a still
  // ships a slideshow labelled as a video, and reaching for an unapproved model
  // spends money on evidence nobody gathered. So say what is missing and wait.
  if (preview.current.needsProvider.length > 0) {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        status: "needs_review",
        errorMessage: preview.current.needsProvider.join(" | ").slice(0, 1000),
      },
    });
    await logger.warn({
      event: "project.needs_provider",
      projectId,
      message: preview.current.needsProvider.join(" | "),
    });
    return {
      started: false,
      jobsQueued: 0,
      budget: preview.budget,
      errors: preview.current.needsProvider,
    };
  }

  // Persist the plan so the storyboard shows exactly what will run.
  for (const plan of preview.current.scenes) {
    const scene = project.scenes.find((s) => s.sceneNumber === plan.sceneNumber);
    if (!scene) continue;
    await prisma.scene.update({
      where: { id: scene.id },
      data: {
        estimatedCost: plan.estimatedCost,
        // Freeze the movement decision. Generation reads this rather than
        // deciding again, so a registry change between approval and execution
        // cannot turn a free scene into a paid one behind the operator.
        motionSource: plan.motionSource,
        imageProvider: plan.image?.provider ?? scene.imageProvider,
        imageModel: plan.image?.modelId ?? scene.imageModel,
        // A locally animated scene has no video model, and must not keep a
        // stale one from an earlier plan - generation would read it as a pin.
        videoProvider:
          plan.motionSource === "LOCAL_MOTION"
            ? null
            : (plan.video?.provider ?? scene.videoProvider),
        videoModel:
          plan.motionSource === "LOCAL_MOTION"
            ? null
            : (plan.video?.modelId ?? scene.videoModel),
        voiceProvider: plan.voice?.provider ?? scene.voiceProvider,
        voiceModel: plan.voice?.modelId ?? scene.voiceModel,
      },
    });
  }

  await prisma.project.update({
    where: { id: projectId },
    data: {
      status: "media_generating",
      estimatedCost: preview.current.breakdown.total,
      errorMessage: null,
    },
  });

  let jobsQueued = 0;
  for (const scene of project.scenes) {
    if (scene.skipped) continue;
    await enqueue({
      type: "generate_scene_media",
      sceneId: scene.id,
      projectId,
      // Earlier scenes first: the hook is what gets reviewed first.
      priority: 100 + scene.sceneNumber,
    });
    jobsQueued++;
  }

  await enqueue({
    type: "render_final",
    projectId,
    priority: 500, // always after the scene jobs
  });
  jobsQueued++;

  await logger.info({
    event: "project.media_started",
    projectId,
    estimatedCost: preview.current.breakdown.total,
    message: `Đưa ${jobsQueued} job vào hàng đợi.`,
  });

  return { started: true, jobsQueued, budget: preview.budget, errors: [] };
}

/** Re-render an existing project without regenerating any paid media. */
export async function requeueRender(projectId: string): Promise<void> {
  await prisma.project.update({
    where: { id: projectId },
    data: { status: "media_ready", errorMessage: null },
  });
  await enqueue({ type: "render_final", projectId, priority: 500 });
}
