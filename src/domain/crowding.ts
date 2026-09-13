import type { ScriptDoc } from "./script";

/**
 * Detects characters padded into scenes they add nothing to.
 *
 * The text model, once told to list everyone visible, over-corrected: it put
 * the third character into every single scene of every script, silent and
 * off to one side. That costs a reference image per scene, crowds the frame
 * so the 9:16 crop clips people, and adds nothing to the joke.
 *
 * This is a check on the script, not a rewrite of it. It reports; a human or a
 * regeneration decides. A character genuinely used - one who speaks, leads, or
 * appears selectively - is never flagged.
 */

export interface CrowdingWarning {
  character: string;
  /** Scenes this character is visible in. */
  appearances: number;
  /** Of those, how many they neither speak in nor lead. */
  passive: number;
  message: string;
}

export interface CrowdingReport {
  warnings: CrowdingWarning[];
  /** Scenes holding three or more characters. */
  crowdedScenes: number[];
  /** Mean characters visible per scene. */
  averageCast: number;
  ok: boolean;
}

/**
 * A character must appear in at least this share of scenes before "in every
 * scene" is a fair description. Below it, appearing silently is just staging.
 */
const UBIQUITY = 0.8;
/** Casts above this per scene tend to lose people to the 9:16 crop. */
export const COMFORTABLE_CAST = 2;

export function analyseCrowding(script: ScriptDoc): CrowdingReport {
  const scenes = script.scenes;
  const total = scenes.length || 1;

  const appearances = new Map<string, number>();
  const passive = new Map<string, number>();

  for (const scene of scenes) {
    const speaks = new Set(scene.speakingCharacters.map(lower));
    const leads = new Set(scene.primaryCharacters.map(lower));

    for (const name of scene.charactersPresent) {
      const key = lower(name);
      appearances.set(key, (appearances.get(key) ?? 0) + 1);
      if (!speaks.has(key) && !leads.has(key)) {
        passive.set(key, (passive.get(key) ?? 0) + 1);
      }
    }
  }

  // Keep the first spelling seen, so the warning names the character the way
  // the script does rather than lower-cased.
  const display = new Map<string, string>();
  for (const scene of scenes) {
    for (const name of scene.charactersPresent) {
      if (!display.has(lower(name))) display.set(lower(name), name);
    }
  }

  const warnings: CrowdingWarning[] = [];
  for (const [key, seen] of appearances) {
    const idle = passive.get(key) ?? 0;
    if (seen / total < UBIQUITY) continue;
    // Passive in EVERY appearance, not merely most of them. A share-based
    // threshold flagged a lead who speaks in one scene out of five - which is
    // a real contribution, not padding. Speaking or leading even once is the
    // line between a character the story uses and one it carries.
    if (idle < seen) continue;

    const name = display.get(key) ?? key;
    warnings.push({
      character: name,
      appearances: seen,
      passive: idle,
      message:
        `${name} xuất hiện ở ${seen}/${total} cảnh nhưng im lặng và không phải ` +
        `trọng tâm ở ${idle} cảnh. Nhiều khả năng bị thêm vào cho đủ, không phục ` +
        `vụ câu chuyện — mỗi lần như vậy tốn thêm một ảnh tham chiếu và làm chật khung hình.`,
    });
  }

  const crowdedScenes = scenes
    .filter((s) => s.charactersPresent.length > COMFORTABLE_CAST)
    .map((s) => s.sceneNumber);

  const cast =
    scenes.reduce((sum, s) => sum + s.charactersPresent.length, 0) / total;

  return {
    warnings,
    crowdedScenes,
    averageCast: Math.round(cast * 100) / 100,
    ok: warnings.length === 0,
  };
}

function lower(name: string): string {
  return name.trim().toLowerCase();
}
