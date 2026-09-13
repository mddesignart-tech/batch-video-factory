import type { Project } from "@prisma/client";
import type { QualityMode, RouterStrategy } from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { ensureProjectDirs } from "@/lib/paths";
import { getSettings } from "@/lib/settings";
import { parseJson, round } from "@/lib/utils";
import { ScriptSchema, type ScriptDoc } from "@/domain/script";
import { enqueue } from "@/jobs/queue";
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
    provider: "mock",
    model: "mock-text-1",
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
        characterIdsJson: JSON.stringify(scene.characters),
      })),
    }),
  ]);
}

// -------------------------------------------------------------- estimating ---

export async function buildPlannedScenes(
  projectId: string,
): Promise<PlannedSceneInput[]> {
  const scenes = await prisma.scene.findMany({
    where: { projectId, skipped: false },
    orderBy: { sceneNumber: "asc" },
  });
  return scenes.map((scene) => ({
    sceneNumber: scene.sceneNumber,
    duration: scene.duration,
    complexity: scene.complexity as "LOW" | "MEDIUM" | "HIGH",
    spendPriority: scene.spendPriority as "LOW" | "NORMAL" | "HIGH",
    characterCount: parseJson<string[]>(scene.characterIdsJson, []).length || 1,
    speechText: speechTextFor(scene),
    manualImageProvider: scene.imageProvider,
    manualImageModel: scene.imageModel,
    manualVideoProvider: scene.videoProvider,
    manualVideoModel: scene.videoModel,
    manualVoiceProvider: scene.voiceProvider,
    manualVoiceModel: scene.voiceModel,
  }));
}

export interface ProjectCostPreview {
  current: ProjectEstimate;
  modes: Record<"ECONOMY" | "BALANCED" | "QUALITY", ProjectEstimate>;
  budget: BudgetCheck;
}

export async function previewProjectCost(
  projectId: string,
): Promise<ProjectCostPreview> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("Không tìm thấy dự án.");

  const [scenes, models, availableProviders] = await Promise.all([
    buildPlannedScenes(projectId),
    prisma.modelRegistry.findMany({ where: { enabled: true } }),
    availableProviderNames(),
  ]);

  const base = {
    scenes,
    models,
    maxBudget: project.maxBudget,
    availableProviders,
    needs1080p: true,
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

  // Persist the plan so the storyboard shows exactly what will run.
  for (const plan of preview.current.scenes) {
    const scene = project.scenes.find((s) => s.sceneNumber === plan.sceneNumber);
    if (!scene) continue;
    await prisma.scene.update({
      where: { id: scene.id },
      data: {
        estimatedCost: plan.estimatedCost,
        imageProvider: plan.image?.provider ?? scene.imageProvider,
        imageModel: plan.image?.modelId ?? scene.imageModel,
        videoProvider: plan.video?.provider ?? scene.videoProvider,
        videoModel: plan.video?.modelId ?? scene.videoModel,
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
