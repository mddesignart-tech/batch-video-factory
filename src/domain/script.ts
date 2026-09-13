import { z } from "zod";
import { COMPLEXITIES, SPEND_PRIORITIES } from "./enums";

/**
 * The contract every TextProvider must satisfy.
 *
 * A provider that returns malformed JSON is repaired once and re-validated
 * (see src/services/script-service.ts). It is never allowed to fail silently.
 */

export const SceneSchema = z.object({
  sceneNumber: z.number().int().positive(),
  duration: z.number().min(1).max(12),
  visualDescription: z.string().min(1),
  dialogue: z.string().default(""),
  narration: z.string().default(""),
  subtitle: z.string().default(""),
  camera: z.string().default(""),
  characterAction: z.string().default(""),
  soundEffect: z.string().default(""),
  imagePrompt: z.string().default(""),
  videoPrompt: z.string().default(""),
  complexity: z.enum(COMPLEXITIES).default("LOW"),
  spendPriority: z.enum(SPEND_PRIORITIES).default("NORMAL"),
  characters: z.array(z.string()).default([]),
});
export type SceneDoc = z.infer<typeof SceneSchema>;

export const ScriptSchema = z.object({
  idiom: z.string().min(1),
  title: z.string().min(1),
  hook: z.string().min(1),
  literalMisunderstanding: z.string().default(""),
  setup: z.string().default(""),
  escalation: z.string().default(""),
  punchline: z.string().default(""),
  meaning: z.string().min(1),
  exampleSentence: z.string().min(1),
  durationTarget: z.number().min(15).max(60),
  scenes: z.array(SceneSchema).min(3).max(10),
  closingCTA: z.string().default("Follow for more funny English!"),
  angleKey: z.string().default(""),
});
export type ScriptDoc = z.infer<typeof ScriptSchema>;

/** Script quality self-assessment, gate-kept before any money is spent. */
export const ScriptScoreSchema = z.object({
  hook: z.number().min(1).max(10),
  humor: z.number().min(1).max(10),
  clarity: z.number().min(1).max(10),
  learningValue: z.number().min(1).max(10),
  visualFeasibility: z.number().min(1).max(10),
  notes: z.string().default(""),
});
export type ScriptScore = z.infer<typeof ScriptScoreSchema>;

/** Scores below this on a critical axis trigger exactly one rewrite. */
export const SCRIPT_SCORE_THRESHOLD = 7;
export const CRITICAL_SCORE_AXES = ["hook", "humor", "clarity"] as const;

export function scriptNeedsRewrite(score: ScriptScore): boolean {
  return CRITICAL_SCORE_AXES.some((axis) => score[axis] < SCRIPT_SCORE_THRESHOLD);
}

export const YoutubeMetaSchema = z.object({
  title: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()),
  keywords: z.array(z.string()),
});
export type YoutubeMeta = z.infer<typeof YoutubeMetaSchema>;

export const QualityReportSchema = z.object({
  characterConsistency: z.number().min(1).max(10),
  motionQuality: z.number().min(1).max(10),
  visualArtifacts: z.number().min(1).max(10),
  promptAdherence: z.number().min(1).max(10),
  composition: z.number().min(1).max(10),
  subtitleSafeFraming: z.number().min(1).max(10),
  overallUsability: z.number().min(1).max(10),
  notes: z.string().default(""),
});
export type QualityReport = z.infer<typeof QualityReportSchema>;

export function overallQualityScore(report: QualityReport): number {
  return report.overallUsability;
}
