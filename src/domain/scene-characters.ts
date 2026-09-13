import { parseJson } from "@/lib/utils";

/**
 * Who is in a scene, read back out of the database.
 *
 * Three lists rather than one, because they answer three different questions
 * and only one of them should drive image generation:
 *
 *   present  - who must be DRAWN, and therefore whose character profile and
 *              reference image have to reach the image provider
 *   speaking - who must be VOICED
 *   primary  - who the shot is ABOUT, which decides who keeps their reference
 *              image when the provider caps how many can be sent
 *
 * Deriving presence from dialogue is the bug this file exists to prevent: a
 * character reacting in the background has no line, and was therefore drawn
 * with no reference at all.
 */

export interface SceneCharacterLists {
  present: string[];
  speaking: string[];
  primary: string[];
}

/** The columns this reads. Accepts any row that carries them. */
export interface SceneCharacterColumns {
  charactersPresentJson: string;
  speakingCharactersJson: string;
  primaryCharactersJson: string;
}

export function sceneCharacters(
  scene: SceneCharacterColumns,
): SceneCharacterLists {
  const present = parseJson<string[]>(scene.charactersPresentJson, []);
  const speaking = parseJson<string[]>(scene.speakingCharactersJson, []);
  const primary = parseJson<string[]>(scene.primaryCharactersJson, []);

  // Anyone who speaks or leads is necessarily visible. Repairing that here
  // rather than trusting the stored rows keeps a hand-edited or part-migrated
  // scene from quietly losing a reference image.
  const merged = dedupe([...present, ...speaking, ...primary]);

  return {
    present: merged,
    speaking: dedupe(speaking).filter((n) => inList(merged, n)),
    primary: dedupe(primary).filter((n) => inList(merged, n)),
  };
}

/**
 * The order characters should be offered a reference image in.
 *
 * Providers cap how many reference images one request may carry, so when a
 * scene has more characters than slots, something has to be dropped. Dropping
 * the focus of the shot would be the worst possible choice, so the order is:
 * primary, then speaking, then everyone else still in frame.
 */
export function referencePriority(lists: SceneCharacterLists): string[] {
  return dedupe([...lists.primary, ...lists.speaking, ...lists.present]);
}

/** Store the three lists on a scene row. */
export function sceneCharacterColumns(
  lists: SceneCharacterLists,
): SceneCharacterColumns {
  return {
    charactersPresentJson: JSON.stringify(lists.present),
    speakingCharactersJson: JSON.stringify(lists.speaking),
    primaryCharactersJson: JSON.stringify(lists.primary),
  };
}

function inList(list: string[], name: string): boolean {
  return list.some((n) => n.toLowerCase() === name.toLowerCase());
}

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
