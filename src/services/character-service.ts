import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";

/**
 * Character identity.
 *
 * Character consistency is the hardest constraint in this format. A viewer
 * forgives a clumsy joke; they do not forgive Max having different hair in
 * scene 3. Every prompt that draws a character is assembled here, from stored
 * fields, in a fixed order - never improvised per scene and never rewritten by
 * the text model.
 */

/** Attributes a scene must never be allowed to change on its own. */
export const LOCKED_ATTRIBUTES = [
  "hair colour and hairstyle",
  "face shape and facial features",
  "apparent age",
  "skin tone",
  "height relative to the other characters",
  "body proportions",
  "signature outfit and its colours",
  "accessories",
] as const;

/**
 * How much of a 2:3 image survives the crop to 9:16.
 *
 * The renderer scales to cover and centre-crops (`scale=...:increase, crop`).
 * A 1024x1536 source is WIDER than 9:16 (0.667 vs 0.563), so covering
 * 1080x1920 scales it to 1280x1920 and the crop then takes 100px off each
 * side. The full height survives; the sides do not.
 *
 * This is the opposite of the intuitive guess, and getting it backwards would
 * have put the safe margin on the wrong axis.
 */
export const CROP_SAFE_WIDTH_FRACTION = 1080 / 1280; // 0.84

/**
 * Framing instruction appended to every scene prompt.
 *
 * Roughly 16% of the width is cropped away, 8% from each side. Asking for
 * margin there costs nothing; discovering a character's arm or a prop sliced
 * off after paying for the image costs the price of a second one.
 */
export const SAFE_AREA_INSTRUCTION =
  "Vertical portrait composition, framed for a 9:16 video. The left and right " +
  "edges will be cropped away, so keep every character, face, hand and " +
  "important prop inside the middle 84% of the width, away from the left and " +
  "right edges. " +
  // Added after a real loss: Max's outstretched hand sat in the 8% strip and
  // was cut off in the finished video. A general "keep things inside" was not
  // enough - gestures reach further than the body that makes them, so they
  // need naming.
  "This includes outstretched arms, open palms, pointing fingers and raised " +
  "hands: a whole gesture must fit inside the frame, not just the body making " +
  "it. Bring arms in closer to the body rather than letting a hand reach the " +
  "edge. Also leave a little headroom above the head and space below the feet " +
  "rather than letting them touch the frame. " +
  "No text, no captions, no watermark.";

/**
 * Extra framing pressure whenever more than one character shares the frame.
 *
 * First applied at three characters, on the evidence that three-character
 * shots spread across the full width. Two-character shots then did the same:
 * Max on the left, Leo on the right, a gap between them, and Max's hand in the
 * cropped strip. Any time the model has two subjects to place, it reaches for
 * the edges unless told not to.
 */
export const GROUPING_INSTRUCTION =
  "Place the characters close together as a tight group near the centre, " +
  "slightly overlapping, staggered in depth rather than lined up edge to edge. " +
  "Do not spread them across the full width of the frame.";

export interface CharacterSheet {
  id: string;
  name: string;
  version: number;
  /** The full description pasted verbatim into every prompt. */
  canonical: string;
  negative: string;
  seed: number | null;
  /** Relative path of the approved master image, if there is one. */
  primaryReference: string | null;
  /** Relative paths of every approved reference, primary first. */
  references: string[];
}

type CharacterRow = {
  id: string;
  name: string;
  version: number;
  visualPrompt: string;
  negativePrompt: string;
  facialFeatures: string;
  hair: string;
  outfit: string;
  bodyProportions: string;
  accessories: string;
  colorPalette: string;
  seed: number | null;
};

/**
 * Assemble the canonical description.
 *
 * Order is fixed and the output is deterministic: the same row always yields
 * the same string, byte for byte. That matters because the string is hashed
 * into the idempotency key - a description that wobbled between calls would
 * defeat duplicate-payment protection.
 */
export function buildCanonicalDescription(char: CharacterRow): string {
  // Seeded sheets start with the character's own name ("Max: young adult..."),
  // and the scene prompt already prefixes each entry with the name, which read
  // as "Max: Max: young adult...". Harmless but it wastes tokens and makes the
  // prompt look careless to anyone reviewing it.
  const visual = char.visualPrompt
    .trim()
    .replace(new RegExp(`^${char.name}\\s*:\\s*`, "i"), "");
  const parts: string[] = [visual];

  const attribute = (label: string, value: string) => {
    const v = value.trim();
    // Skip empties rather than emitting "hair: " - a dangling label invites the
    // model to invent a value for it.
    if (v.length > 0) parts.push(`${label}: ${v}`);
  };

  attribute("hair", char.hair);
  attribute("face", char.facialFeatures);
  attribute("outfit", char.outfit);
  attribute("body", char.bodyProportions);
  attribute("accessories", char.accessories);
  attribute("colour palette", char.colorPalette);

  return parts.join(". ").replace(/\.\.+/g, ".").trim();
}

/** Load one character as a prompt-ready sheet. */
export async function getCharacterSheet(
  characterId: string,
): Promise<CharacterSheet | null> {
  const char = await prisma.character.findUnique({
    where: { id: characterId },
    include: {
      references: {
        where: { approved: true },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      },
    },
  });
  if (!char) return null;
  return toSheet(char);
}

/** Load several sheets by name, preserving the order asked for. */
export async function getCharacterSheetsByName(
  names: string[],
): Promise<CharacterSheet[]> {
  if (names.length === 0) return [];
  const rows = await prisma.character.findMany({
    where: { name: { in: names } },
    include: {
      references: {
        where: { approved: true },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      },
    },
  });
  const byName = new Map(rows.map((r) => [r.name, r]));
  return names
    .map((n) => byName.get(n))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map(toSheet);
}

function toSheet(
  char: CharacterRow & {
    references: { filePath: string; isPrimary: boolean }[];
  },
): CharacterSheet {
  const primary = char.references.find((r) => r.isPrimary);
  return {
    id: char.id,
    name: char.name,
    version: char.version,
    canonical: buildCanonicalDescription(char),
    negative: char.negativePrompt.trim(),
    seed: char.seed,
    primaryReference: primary?.filePath ?? null,
    references: char.references.map((r) => r.filePath),
  };
}

/** Absolute path of a reference image, for reading the bytes off disk. */
export function referenceAbsolutePath(relative: string): string {
  return toAbsolute(relative);
}

/**
 * The prompt for a character's master reference image.
 *
 * Deliberately plain: neutral pose, plain background, full body. This image
 * becomes the visual source of truth every later scene is matched against, so
 * it must show the character clearly rather than attractively.
 */
export function buildMasterPrompt(
  sheet: Pick<CharacterSheet, "canonical">,
  stylePrompt: string,
): string {
  return [
    "Full-body character reference sheet, single character, front view, neutral standing pose,",
    "arms relaxed at the sides, neutral friendly expression, even lighting,",
    "plain flat light-grey background, no props, no text, no logo.",
    "",
    `Character: ${sheet.canonical}.`,
    "",
    `Art style: ${stylePrompt}`,
  ].join("\n");
}

/**
 * The prompt for one scene.
 *
 * Structure matters as much as content. The scene action comes first so the
 * model treats it as the subject, then each character sheet is restated in
 * full, then the lock clause. Putting the lock last makes it the most recent
 * instruction the model reads, which is where it carries the most weight.
 */
export function buildScenePrompt(input: {
  sceneDescription: string;
  characters: CharacterSheet[];
  stylePrompt: string;
  camera?: string;
  location?: string;
  mood?: string;
  /**
   * Set only when a character sheet's mood wording was overruled by the scene.
   *
   * Deleting the words is half a fix: the reference IMAGE still shows the
   * character's default face, and that pull is what drew a smiling Max over a
   * scene that called for wide eyes. This says which one wins, and it goes
   * immediately after the lock clause so it is read as part of it.
   */
  expressionOverride?: string | null;
}): string {
  const lines: string[] = [input.sceneDescription.trim()];

  if (input.location?.trim()) lines.push(`Location: ${input.location.trim()}.`);
  if (input.camera?.trim()) lines.push(`Camera: ${input.camera.trim()}.`);
  if (input.mood?.trim()) lines.push(`Mood: ${input.mood.trim()}.`);

  if (input.characters.length > 0) {
    lines.push("");
    lines.push("Characters in this shot, drawn exactly as described:");
    for (const c of input.characters) {
      lines.push(`- ${c.name}: ${c.canonical}.`);
    }
    lines.push("");
    lines.push(
      `Keep ${listNames(input.characters)} identical to the reference: ` +
        `${LOCKED_ATTRIBUTES.join(", ")} must not change. ` +
        "Only pose, expression and camera angle may differ.",
    );
    if (input.expressionOverride) lines.push(input.expressionOverride);
  }

  lines.push("");
  lines.push(`Art style: ${input.stylePrompt}`);
  lines.push(SAFE_AREA_INSTRUCTION);
  // Not for a solo shot: asking the model to group one character with nobody
  // is noise.
  if (input.characters.length >= 2) {
    lines.push(GROUPING_INSTRUCTION);
  }

  return lines.join("\n");
}

function listNames(characters: CharacterSheet[]): string {
  const names = characters.map((c) => c.name);
  if (names.length <= 1) return names[0] ?? "the character";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Merge each character's negative prompt with the shared image negatives. */
export function buildNegativePrompt(
  characters: CharacterSheet[],
  extra = "",
): string {
  const seen = new Set<string>();
  const push = (text: string) => {
    for (const term of text.split(",")) {
      const t = term.trim().toLowerCase();
      if (t.length > 0) seen.add(t);
    }
  };
  for (const c of characters) push(c.negative);
  push(extra);
  push("text, watermark, signature, extra limbs, deformed hands, blurry");
  return [...seen].join(", ");
}
