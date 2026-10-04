import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Project } from "@prisma/client";
import { generationAspectFor, type OutputProfile } from "@/domain/platform-profile";
import type { QualityMode } from "@/domain/enums";
import {
  audienceOf,
  clampDuration,
  languageOf,
  toneOf,
  BILINGUAL_MODES,
  VOICE_MODES,
  type FactOrigin,
} from "@/domain/content-options";
import {
  formatOf,
  isContentType,
  templateIdFor,
  templateOf,
  type ContentType,
} from "@/domain/content-templates";
import { projectContent } from "@/domain/content-legacy";
import {
  TONE_HINTS,
  applyCreativeStructure,
  creativeStylePrompt,
  paceFactor,
  storedCreativeJson,
  type StoredCreativeStyle,
} from "@/domain/creative-style";
import { planScenes } from "@/domain/scene-planner";
import { NARRATOR_NAME } from "@/domain/scene-characters";
import type { ScriptDoc } from "@/domain/script";
import { ensureProjectDirs, toAbsolute } from "@/lib/paths";
import { buildPrompt } from "@/lib/prompts";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { getSettings } from "@/lib/settings";
import { parseJson, round } from "@/lib/utils";
import { getTextProvider } from "@/providers/registry";
import type { ContentScriptRequest, ScriptRequest } from "@/providers/types";
import { resolveContentSource, type ContentSourceInput } from "./content-source";
import { importSceneImage, storeImportedImage } from "./imported-image";
import { autoAssignReferences, createReference, projectReferenceAssets, setSceneReferences } from "./reference-assets";
import type { ReferenceType } from "@/domain/reference";
import { persistScript, selectTextModel } from "./project-service";
import { planProjectScenes } from "./scene-plan-service";
import { guardedTextCall, scriptHashFor, textCallContext, withDerivedRouting } from "./script-service";

/**
 * MULTI-CONTENT ENGINE - create a project from an idea, pasted text or the
 * person's own pictures, for any content template.
 *
 *   source -> template -> script engine -> scene planner -> Scene rows
 *
 * From the Scene rows on, everything is the pipeline every video already uses
 * (storyboard, voice, subtitles, routing, reuse, preflight, render). Nothing
 * here buys media: the only possible paid call is the TEXT call that writes the
 * script (free in Mock Mode), and it goes through the same spend gate and
 * ledger as the idiom writer. Image / voice / video wait for DUYỆT KỊCH BẢN and
 * then the usual preflight + DUYỆT & CHẠY.
 *
 * `Project.idiomId` stays required: every content project gets one Content
 * Library row (an `Idiom` row with its own `contentType`), so the ~100 places
 * that read `project.idiom` keep working unchanged.
 */

export class ContentProjectError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContentProjectError";
  }
}

export interface CreateContentProjectInput extends ContentSourceInput {
  contentType: string;
  formatId?: string;
  sourceType: "PROMPT" | "TEXT" | "ASSETS" | "URL";
  language?: string;
  audience?: string;
  tone?: string;
  voiceMode?: string;
  bilingualMode?: string;
  durationSeconds?: number;
  outputProfile?: OutputProfile;
  stylePresetId?: string;
  qualityMode?: QualityMode;
  maxBudget?: number;
  /** Product / brand name (review, ads). */
  subjectName?: string;
  cta?: string;
  /** The person's own pictures. Stored in the Asset Library, cost $0. */
  uploads?: { bytes: Buffer; filename: string }[];
  /**
   * QĐ-124: the uploaded pictures are ONE thing to keep identical across scenes
   * (the reviewed product, Ben's yellow truck, the cat). Name shown to the
   * person; defaults to the subject name / topic.
   */
  referenceName?: string;
  /** "Dùng … này xuyên suốt video" - default ON for a product. */
  useReferenceThroughout?: boolean;
  /** Write the script right away (default). Tests can create first, write later. */
  writeScript?: boolean;
  /** QĐ-127 PHONG CÁCH SÁNG TẠO. Absent / all "Tự động" = the template's creative defaults. */
  creativeStyle?: Partial<StoredCreativeStyle> | null;
}

/** The voice-only narrator, created once with the voice of an existing character. */
export async function ensureNarrator(): Promise<void> {
  const existing = await prisma.character.findUnique({ where: { name: NARRATOR_NAME } });
  if (existing) return;
  const cast = await prisma.character.findMany({ where: { enabled: true }, orderBy: { createdAt: "asc" } });
  const voice = cast.find((c) => c.voiceGender === "female") ?? cast[0];
  await prisma.character.create({
    data: {
      name: NARRATOR_NAME,
      description: "Người dẫn chuyện - chỉ có giọng, không bao giờ xuất hiện trong hình.",
      personality: "warm, clear narrator",
      visualPrompt: "",
      // Disabled: never offered as cast, never drawn. Its voice is still
      // editable on the Characters page like anyone's.
      enabled: false,
      voiceProvider: voice?.voiceProvider ?? "mock",
      voiceModel: voice?.voiceModel ?? "mock-voice-std",
      voiceId: voice?.voiceId ?? "mock-female-us",
      voiceGender: voice?.voiceGender ?? "female",
      voiceAccent: voice?.voiceAccent ?? "US",
      voiceInstructions: "Warm, clear narrator. Speak naturally in the language of the text.",
      notes: "Tạo tự động cho video đa nội dung (multi-content).",
    },
  });
}

function shortTopic(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export async function createContentProject(input: CreateContentProjectInput): Promise<Project> {
  if (!isContentType(input.contentType)) {
    throw new ContentProjectError("UNKNOWN_CONTENT_TYPE", `Loại video không hợp lệ: ${input.contentType}`);
  }
  const template = templateOf(input.contentType);
  if (template.engine === "LEGACY_IDIOM") {
    throw new ContentProjectError("USE_IDIOM_LIBRARY", "Video thành ngữ được tạo từ thư viện thành ngữ (giữ nguyên bộ viết cũ).");
  }
  const format = formatOf(template, input.formatId);
  const resolved = await resolveContentSource(input.sourceType, { ...input, uploadCount: input.uploads?.length ?? 0 });

  const settings = await getSettings();
  const preset = input.stylePresetId
    ? await prisma.stylePreset.findUnique({ where: { id: input.stylePresetId } })
    : ((await prisma.stylePreset.findUnique({ where: { slug: template.defaultStyleSlug } })) ??
      (await prisma.stylePreset.findFirst({ where: { isDefault: true } })));

  const language = languageOf(input.language ?? template.defaultLanguage).code;
  const voiceMode = VOICE_MODES.some((v) => v.id === input.voiceMode) ? input.voiceMode! : template.defaultVoiceMode;
  const bilingualMode =
    language === "vi-en" ? (BILINGUAL_MODES.find((b) => b.id === input.bilingualMode)?.id ?? "VI_EXPLAIN_EN_EXAMPLE") : null;
  const topic = shortTopic(input.subjectName || resolved.idea || resolved.sourceText) || template.name;

  // One Content Library row per content project (see the file comment).
  const item = await prisma.idiom.create({
    data: {
      phrase: topic,
      slug: `content-${randomUUID()}`,
      meaning: (resolved.idea || resolved.sourceText).slice(0, 500),
      literalMeaning: "",
      exampleSentence: "",
      category: template.category,
      contentType: template.id,
      status: "content",
      notes: `Tạo từ ${input.sourceType} (${template.name}).`,
    },
  });

  const project = await prisma.project.create({
    data: {
      idiomId: item.id,
      title: topic,
      status: "draft",
      qualityMode: input.qualityMode ?? "BALANCED",
      routerStrategy: settings.defaultRouterStrategy,
      stylePresetId: preset?.id ?? null,
      targetDuration: clampDuration(input.durationSeconds ?? template.defaultDuration),
      aspectRatio: input.outputProfile
        ? generationAspectFor(input.outputProfile.width, input.outputProfile.height)
        : (preset?.aspectRatio ?? "9:16"),
      outputProfileJson: input.outputProfile ? JSON.stringify(input.outputProfile) : null,
      maxBudget: round(input.maxBudget ?? settings.defaultMaxBudget),
      language,
      contentType: template.id,
      contentTemplateId: templateIdFor(template, format),
      templateVersion: template.promptVersion,
      contentSourceType: input.sourceType,
      sourceText: resolved.sourceText || null,
      sourceUrl: resolved.sourceUrl,
      audience: audienceOf(input.audience ?? template.defaultAudience).id,
      tone: toneOf(input.creativeStyle?.tone ?? input.tone ?? template.defaultTone).id,
      creativeStyleJson: storedCreativeJson(input.creativeStyle),
      voiceMode,
      bilingualMode,
      contentBriefJson: JSON.stringify({ idea: resolved.idea, facts: resolved.facts, cta: input.cta?.trim() ?? "", subjectName: input.subjectName?.trim() ?? "", assetIds: [] }),
    },
  });
  ensureProjectDirs(project.id);

  // The person's pictures go into the Asset Library first ($0), then the
  // writer is told they exist so it can put them in the right scenes.
  const assetIds: string[] = [];
  for (const upload of input.uploads ?? []) {
    const stored = await storeImportedImage({
      projectId: project.id,
      sceneId: null,
      bytes: upload.bytes,
      originalFilename: upload.filename,
      via: "content-upload",
    });
    assetIds.push(stored.asset.id);
  }
  if (assetIds.length > 0) await updateBrief(project.id, { assetIds });

  // The uploads are pictures of ONE thing that must stay the same in every
  // scene: a Universal Reference ($0, no provider). Which kind follows the
  // template; a template without a natural subject keeps them as plain photos.
  const refType = REFERENCE_TYPE_FOR[template.id];
  if (assetIds.length > 0 && refType) {
    await createReference({
      projectId: project.id,
      type: refType,
      name: (input.referenceName?.trim() || input.subjectName?.trim() || topic).slice(0, 120),
      description: input.facts?.map((f) => f.text).join("; ").slice(0, 500) ?? "",
      isPrimary: true,
      useThroughout: input.useReferenceThroughout ?? refType === "PRODUCT",
      assetIds,
    });
  }

  await logger.info({
    event: "project.content_created",
    projectId: project.id,
    message: `Tạo dự án ${template.name} (${input.sourceType}, ${language}, ${project.targetDuration}s, ${assetIds.length} ảnh).`,
  });

  if (input.writeScript !== false) await generateContentProjectScript(project.id);
  return prisma.project.findUniqueOrThrow({ where: { id: project.id } });
}

/** Which reference the uploads become, by template. Absent = plain photos only. */
const REFERENCE_TYPE_FOR: Partial<Record<string, ReferenceType>> = {
  PRODUCT_REVIEW: "PRODUCT",
  ADVERTISEMENT: "PRODUCT",
  TOY_WORLD: "TOY",
  ANIMAL_FACT: "ANIMAL",
  STORY: "OBJECT",
  CUSTOM: "OBJECT",
};

interface ContentBrief {
  idea: string;
  facts: { text: string; origin: FactOrigin }[];
  cta: string;
  subjectName: string;
  assetIds: string[];
}

export function contentBriefOf(project: Pick<Project, "contentBriefJson">): ContentBrief {
  return { idea: "", facts: [], cta: "", subjectName: "", assetIds: [], ...parseJson<Partial<ContentBrief>>(project.contentBriefJson, {}) };
}

async function updateBrief(projectId: string, patch: Partial<ContentBrief>): Promise<void> {
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { contentBriefJson: true } });
  await prisma.project.update({ where: { id: projectId }, data: { contentBriefJson: JSON.stringify({ ...contentBriefOf(p), ...patch }) } });
}

const BILINGUAL_RULE: Record<string, string> = {
  EN_VOICE_VI_SUB: "Spoken lines in English; subtitles in Vietnamese.",
  VI_EXPLAIN_EN_EXAMPLE: "Explain in Vietnamese; every example sentence is in English.",
  ALTERNATING: "Alternate English and Vietnamese lines.",
  BILINGUAL_SUB: "Spoken lines in English; subtitle shows English then Vietnamese.",
};

const VOICE_MODE_RULE: Record<string, string> = {
  NARRATION: "one narrator reads every scene (narration field).",
  DIALOGUE: "characters speak to each other; dialogue lines are 'Name: line'.",
  MIXED: "narration carries the video; characters may say short lines 'Name: line'.",
  NO_VOICE: "no spoken words at all: leave dialogue and narration empty, put the text in subtitle.",
};

/**
 * Write (or rewrite) the script of a content project and turn it into Scene
 * rows. Any earlier DUYỆT KỊCH BẢN is cleared - a new script needs a new look.
 */
export async function generateContentProjectScript(projectId: string): Promise<ScriptDoc> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { stylePreset: true },
  });
  if (!project) throw new ContentProjectError("NOT_FOUND", "Không tìm thấy dự án.");
  if (!project.contentType) throw new ContentProjectError("LEGACY_PROJECT", "Dự án thành ngữ dùng bộ viết kịch bản cũ.");
  if (!["draft", "script_ready", "needs_review", "failed"].includes(project.status)) {
    throw new ContentProjectError(
      "MEDIA_STARTED",
      "Dự án đã bắt đầu tạo media - không viết lại kịch bản để tránh bỏ phí media đã có. Hãy sửa từng cảnh trong Storyboard.",
    );
  }
  const content = projectContent(project);
  const template = content.template;
  const brief = contentBriefOf(project);
  const audience = audienceOf(content.audience);
  const lang = languageOf(content.language);
  // QĐ-127 Creative Style: the structure (reaction, escalation, payoff,
  // emotional moment...), the pace and the writer's instructions all follow it.
  const style = content.creative;
  const styledFormat = { ...content.format, beats: applyCreativeStructure(content.format.beats, style, template.creative, template.factual) };
  const beats = planScenes({ format: styledFormat, durationSeconds: project.targetDuration, audience: audience.id, paceFactor: paceFactor(style) });
  // The version that writes THIS script (a rewrite of an older project moves it forward).
  const templateVersion = template.promptVersion;
  const creativeBlock = creativeStylePrompt(style, { factual: template.factual, storyGags: template.creative.storyGags });
  const maxSentenceWords = Math.max(5, Math.round(audience.maxSentenceWords * Math.min(1.15, paceFactor(style))));

  await ensureNarrator();
  const wantsCast =
    content.voiceMode === "DIALOGUE" ||
    content.voiceMode === "MIXED" ||
    ["STORY", "TOY_WORLD", "ENGLISH_CONVERSATION", "ENGLISH_MINI_STORY", "ENGLISH_IDIOM"].includes(content.contentType);
  const cast = wantsCast
    ? await prisma.character.findMany({ where: { enabled: true }, orderBy: { createdAt: "asc" }, take: 4 })
    : [];
  const assets = brief.assetIds.length
    ? await prisma.asset.findMany({ where: { id: { in: brief.assetIds }, projectId, source: "IMPORTED" } })
    : [];
  const userAssets = assets.map((a) => ({ id: a.id, label: a.originalFilename ?? a.id.slice(0, 8) }));
  const references = (await projectReferenceAssets(projectId)).filter((r) => r.enabled);

  const stylePrompt = [project.stylePreset?.positivePrompt, project.stylePreset?.lightingStyle, project.stylePreset?.visualTone]
    .filter(Boolean)
    .join(", ");

  const rules = [...template.sceneRules, ...template.visualRules, ...template.voiceRules, ...template.ctaRules, ...template.safetyRules];
  let systemPrompt = await buildPrompt("content-script", {
    templateName: template.name,
    templateId: project.contentTemplateId ?? template.id,
    templateVersion,
    durationSeconds: project.targetDuration,
    languageName: lang.promptName,
    bilingualRule: project.bilingualMode ? (BILINGUAL_RULE[project.bilingualMode] ?? "") : "",
    audienceHint: audience.promptHint,
    maxSentenceWords,
    toneHint: TONE_HINTS[style.tone]?.hint || toneOf(content.tone).promptHint || template.tone,
    creativeStyle: creativeBlock,
    voiceModeRule: VOICE_MODE_RULE[content.voiceMode] ?? VOICE_MODE_RULE.NARRATION,
    subject: brief.subjectName || "(none)",
    idea: brief.idea || "(none)",
    sourceText: project.sourceText || "(none)",
    facts: brief.facts.length ? brief.facts.map((f) => `- [${f.origin}] ${f.text}`).join("\n") : "(none given)",
    cta: brief.cta || (template.ctaRules.length ? "(none given - follow the CTA rule)" : "(none - do not add a call to action)"),
    userAssets: userAssets.length ? userAssets.map((a) => `- ${a.id}: ${a.label}`).join("\n") : "(none)",
    characters: cast.length ? cast.map((c) => `- ${c.name} (${c.personality}): ${c.visualPrompt}`).join("\n") : "(no on-screen characters needed)",
    narrator: NARRATOR_NAME,
    references: references.length
      ? references.map((r) => `- ${r.id}: ${r.type} "${r.name}"${r.useThroughout ? " (in every scene)" : ""}`).join("\n")
      : "(none)",
    stylePrompt,
    sceneCount: beats.length,
    structure: beats
      .map((b) => `  ${b.index}. [${b.role}] ${b.displayLabel} (~${b.durationSeconds}s, ${b.motion}${b.prefersUserAsset ? ", show the person's picture if any" : ""}): ${b.purpose}`)
      .join("\n"),
    rules: rules.map((r) => `- ${r}`).join("\n"),
    factRule: template.factual
      ? "- Any fact you add that is NOT in the source or the facts list: list it in \"facts\" with origin AI_GENERATED and set \"needsFactReview\": true. Never present it as a specification."
      : "",
  });
  // An operator's edited prompt without {{creativeStyle}} still gets the block.
  if (!systemPrompt.includes(creativeBlock)) systemPrompt = `${systemPrompt}\n\n${creativeBlock}`;

  const request: ContentScriptRequest = {
    contentType: content.contentType,
    templateId: project.contentTemplateId ?? template.id,
    templateVersion,
    templateName: template.name,
    language: lang.code,
    audience: audience.id,
    tone: style.tone,
    voiceMode: content.voiceMode,
    bilingualMode: project.bilingualMode,
    durationSeconds: project.targetDuration,
    beats: beats.map((b) => ({
      role: b.role,
      label: b.displayLabel,
      purpose: b.purpose,
      durationSeconds: b.durationSeconds,
      motion: b.motion,
      prefersUserAsset: b.prefersUserAsset === true,
    })),
    subjectName: brief.subjectName,
    idea: brief.idea,
    sourceText: project.sourceText ?? "",
    facts: brief.facts,
    cta: brief.cta,
    userAssets,
    references: references.map((r) => ({ id: r.id, type: r.type, name: r.name, useThroughout: r.useThroughout })),
    characters: cast.map((c) => ({ name: c.name, personality: c.personality, visualPrompt: c.visualPrompt })),
    narrator: NARRATOR_NAME,
    stylePrompt,
    factual: template.factual,
    creative: style,
    model: "",
    systemPrompt,
  };

  // The one possible paid call: guarded, ledgered, free in Mock Mode.
  const choice = await selectTextModel(project.qualityMode as QualityMode);
  const provider = await getTextProvider(choice.provider, choice.model);
  request.model = choice.model;
  const estimate = (await provider.estimateScriptCost({ idiom: project.title, systemPrompt } as ScriptRequest)).amount;
  const ctx = await textCallContext({
    provider: choice.provider,
    model: choice.model,
    projectId,
    subjectKey: project.idiomId,
    requestInfo: { contentType: content.contentType, template: request.templateId },
  });
  const { script: raw } = await guardedTextCall(ctx, "content-script", estimate, () => provider.generateContentScript(request));

  const script = withDerivedRouting(normaliseContentScript(raw, request));
  await persistScript(projectId, script);
  await applyContentScenePlan(projectId, script, request);
  // Reference intent the writer returned, then deterministic auto-assignment
  // for every scene it left empty. Visible and editable on the storyboard.
  await autoAssignReferences(projectId, { onlyEmpty: true });
  // QĐ-128: AI Camera Director + layers for the new script ($0, no media).
  await planProjectScenes(projectId);

  await prisma.project.update({
    where: { id: projectId },
    data: {
      title: script.title,
      scriptJson: JSON.stringify(script),
      scriptHash: scriptHashFor(script),
      status: "script_ready",
      scriptApprovedAt: null,
      errorMessage: null,
      templateVersion,
    },
  });
  await prisma.idiom.update({ where: { id: project.idiomId }, data: { phrase: script.idiom.slice(0, 200) } });
  await logger.info({
    event: "script.content_generated",
    projectId,
    provider: choice.provider,
    model: choice.model,
    message: `${template.name}: ${script.scenes.length} cảnh, ${project.targetDuration}s, ${lang.label}.`,
  });
  return script;
}

/**
 * Make whatever the writer returned fit the plan the person chose: the
 * template's metadata, unknown asset ids dropped, and - when a real model
 * forgot - the person's pictures placed on the beats that prefer them.
 */
export function normaliseContentScript(script: ScriptDoc, req: ContentScriptRequest): ScriptDoc {
  const known = new Set(req.userAssets.map((a) => a.id));
  let scenes = script.scenes.map((s, i) => ({
    ...s,
    sceneRole: s.sceneRole ?? req.beats[i]?.role,
    beatLabel: s.beatLabel ?? req.beats[i]?.label,
    motionHint: s.motionHint ?? req.beats[i]?.motion ?? "AUTO",
    assetIds: (s.assetIds ?? []).filter((id) => known.has(id)),
    referenceIds: (s.referenceIds ?? []).filter((id) => (req.references ?? []).some((r) => r.id === id)),
  }));
  if (known.size > 0 && scenes.every((s) => s.assetIds.length === 0)) {
    const ids = [...known];
    let turn = 0;
    const preferred = scenes.map((_, i) => req.beats[i]?.prefersUserAsset === true);
    const targets = preferred.some(Boolean) ? preferred : scenes.map((s) => s.sceneRole !== "hook");
    scenes = scenes.map((s, i) => (targets[i] ? { ...s, assetIds: [ids[turn++ % ids.length]!] } : s));
  }
  // Every picture the person uploaded is shown at least once: one left over
  // goes to a still scene that has none yet (never the hook, never a scene
  // meant for generated motion).
  const unused = [...known].filter((id) => !scenes.some((s) => s.assetIds.includes(id)));
  for (const id of unused) {
    const at = scenes.findIndex((s) => s.assetIds.length === 0 && s.sceneRole !== "hook" && s.motionHint !== "VIDEO_AI");
    if (at < 0) break;
    scenes[at] = { ...scenes[at]!, assetIds: [id], motionHint: "LOCAL_MOTION" };
  }
  return {
    ...script,
    scenes,
    contentType: req.contentType,
    templateId: req.templateId,
    templateVersion: req.templateVersion,
    language: req.language,
    ...(req.creative ? { creativeStyle: { ...req.creative } } : {}),
  };
}

/**
 * The parts of the plan the Scene columns carry beyond the script text:
 *  - a scene showing the person's own picture uses THAT picture (IMPORTED,
 *    $0, never redrawn) and is animated locally;
 *  - a LOCAL_MOTION hint becomes the scene's motion instruction ($0);
 *  - a VIDEO_AI hint stays AUTO: the router, the LOW_AUTO gate and the
 *    person's approval decide whether a clip is bought - a template never does.
 */
async function applyContentScenePlan(projectId: string, script: ScriptDoc, req: ContentScriptRequest): Promise<void> {
  const scenes = await prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } });
  for (const doc of script.scenes) {
    const scene = scenes.find((s) => s.sceneNumber === doc.sceneNumber);
    if (!scene) continue;
    const assetId = doc.assetIds?.[0];
    const local = Boolean(assetId) || doc.motionHint === "LOCAL_MOTION";
    // Instruction AND stored decision together (as the storyboard editor
    // writes them): the pipeline and the estimate read motionSource.
    await prisma.scene.update({
      where: { id: scene.id },
      data: local ? { motionMode: "LOCAL_MOTION", motionSource: "LOCAL_MOTION" } : { motionMode: "AUTO" },
    });
    if (assetId && req.userAssets.some((a) => a.id === assetId)) {
      const asset = await prisma.asset.findUnique({ where: { id: assetId } });
      if (!asset || !fs.existsSync(toAbsolute(asset.filePath))) continue;
      await importSceneImage({
        sceneId: scene.id,
        bytes: fs.readFileSync(toAbsolute(asset.filePath)),
        originalFilename: asset.originalFilename ?? "upload.png",
        via: "content-upload",
      });
    }
    // Reference intent from the writer (ids already checked in normalise).
    if (doc.referenceIds?.length) await setSceneReferences(scene.id, doc.referenceIds);
  }
}

/** DUYỆT KỊCH BẢN: the person read the script; media may now be planned. */
export async function approveContentScript(projectId: string): Promise<Project> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { _count: { select: { scenes: true } } } });
  if (!project) throw new ContentProjectError("NOT_FOUND", "Không tìm thấy dự án.");
  if (project._count.scenes === 0) throw new ContentProjectError("NO_SCENES", "Kịch bản chưa có cảnh nào.");
  const updated = await prisma.project.update({ where: { id: projectId }, data: { scriptApprovedAt: new Date() } });
  await logger.info({ event: "script.approved", projectId, message: "Đã DUYỆT KỊCH BẢN. Chưa tạo media nào." });
  return updated;
}

/** Template / content summary for a project page. Never writes. */
export function contentSummary(project: Project) {
  const c = projectContent(project);
  return {
    ...c,
    templateName: c.template.name,
    formatLabel: c.format.label,
    brief: contentBriefOf(project),
    approved: project.scriptApprovedAt !== null,
  };
}

export type { ContentType };
