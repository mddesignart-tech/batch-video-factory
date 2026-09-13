import { z } from "zod";
import { COMPLEXITIES, SPEND_PRIORITIES } from "./enums";

/**
 * The contract every TextProvider must satisfy.
 *
 * A provider that returns malformed JSON is repaired once and re-validated
 * (see src/services/script-service.ts). It is never allowed to fail silently.
 */

/**
 * Who is in a scene, split three ways.
 *
 * One list could not carry this. A character standing in the background with no
 * line still has to be drawn on-model, so presence has to be stated rather than
 * inferred from dialogue - inferring it is exactly what dropped Leo's reference
 * image from scenes he was visibly in.
 */
const CharacterListsSchema = z.object({
  /** Everyone visible in frame: speaking, reacting, passing through, partly in shot. */
  charactersPresent: z.array(z.string()).default([]),
  /** Only those with a spoken line. */
  speakingCharacters: z.array(z.string()).default([]),
  /** The focus of the shot. First in line for a reference image. */
  primaryCharacters: z.array(z.string()).default([]),
});

const BaseSceneSchema = z
  .object({
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
    /** The old single list. Accepted so an older model reply still parses. */
    characters: z.array(z.string()).optional(),
  })
  .merge(CharacterListsSchema);

/**
 * Fill in whichever lists the model left out.
 *
 * A model that answers with only the old `characters` field, or that fills in
 * `speakingCharacters` but forgets `charactersPresent`, must still produce a
 * usable scene. The rule is one-directional: anyone who speaks or is primary is
 * necessarily present, so presence is the union. Never the reverse - that is
 * the inference that caused the bug.
 */
export const SceneSchema = BaseSceneSchema.transform((scene) => {
  const legacy = scene.characters ?? [];
  const present = dedupe([
    ...scene.charactersPresent,
    ...scene.speakingCharacters,
    ...scene.primaryCharacters,
    ...legacy,
  ]);
  const speaking = dedupe(
    scene.speakingCharacters.length > 0
      ? scene.speakingCharacters
      : // No speaking list and no dialogue means nobody speaks; with dialogue,
        // the legacy list is the best evidence we have of who said it.
        scene.dialogue.trim().length > 0
        ? legacy
        : [],
  ).filter((name) => present.includes(name));

  const primary = dedupe(
    scene.primaryCharacters.length > 0
      ? scene.primaryCharacters
      : speaking.length > 0
        ? speaking
        : present.slice(0, 1),
  ).filter((name) => present.includes(name));

  return {
    ...scene,
    charactersPresent: present,
    speakingCharacters: speaking,
    primaryCharacters: primary,
    characters: present,
  };
});
export type SceneDoc = z.infer<typeof SceneSchema>;

function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

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
