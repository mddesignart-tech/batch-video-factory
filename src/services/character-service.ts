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
  /**
   * The full description pasted verbatim into every prompt.
   *
   * This IS the `promptIdentityBlock`: derived, never stored. Storing it would
   * create a second copy of the identity that can disagree with the columns it
   * came from, and the copy is the one that would reach the model.
   */
  canonical: string;
  negative: string;
  /** Identity-specific negatives, kept apart from generic image hygiene. */
  negativeIdentity: string;
  seed: number | null;
  /** Relative path of the approved master image, if there is one. */
  primaryReference: string | null;
  /** Relative paths of every approved reference, primary first. */
  references: string[];
  /** Required Bible fields this character has not stated, as labels. */
  missingFields: string[];
  /** READY / NEEDS_CHARACTER_REFERENCE / NEEDS_IDENTITY_FIELDS. */
  readiness: CharacterReadiness;
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
  // The Character Bible fields. Optional on the type so a fixture or an older
  // caller that selects only the original columns still compiles; absent reads
  // as empty, which is how every pre-QĐ-070 row behaves.
  presentation?: string;
  approximateAge?: string;
  skinTone?: string;
  distinguishingFeatures?: string;
  negativeIdentity?: string;
};

/**
 * The Character Bible, in the order it is written into a prompt.
 *
 * ORDER IS THE SPEC, not a formatting preference. `buildCanonicalDescription`
 * walks this list, so the string it produces is a pure function of the row -
 * which is what lets it be hashed into the master-image idempotency key. A list
 * that reordered itself would re-buy every master image.
 *
 * The first four are new in QĐ-070 and sit at the front deliberately: they are
 * the attributes `LOCKED_ATTRIBUTES` has always claimed to protect, and a lock
 * reads as empty words until the thing being locked has been stated.
 */
export const BIBLE_FIELDS = [
  { key: "presentation", label: "presentation" },
  { key: "approximateAge", label: "apparent age" },
  { key: "skinTone", label: "skin tone" },
  { key: "hair", label: "hair" },
  { key: "facialFeatures", label: "face" },
  { key: "distinguishingFeatures", label: "distinguishing features" },
  { key: "outfit", label: "outfit" },
  { key: "bodyProportions", label: "body" },
  { key: "accessories", label: "accessories" },
  { key: "colorPalette", label: "colour palette" },
] as const satisfies ReadonlyArray<{ key: keyof CharacterRow; label: string }>;

/**
 * Bible fields without which a name is not an identity.
 *
 * A storyboard that says "Max" and nothing else gives the model nothing to hold
 * steady, and it will draw a different Max in every scene - the exact failure
 * this whole subsystem exists to prevent. These five are the minimum: what he
 * looks like from the neck up, what he is wearing, and how big he is.
 *
 * `presentation` and `distinguishingFeatures` are deliberately NOT required:
 * plenty of characters legitimately have neither, and demanding a value would
 * push whoever fills the form into inventing one.
 */
export const REQUIRED_BIBLE_FIELDS = [
  "approximateAge",
  "skinTone",
  "hair",
  "facialFeatures",
  "outfit",
  "bodyProportions",
] as const;

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

  for (const field of BIBLE_FIELDS) {
    const value = (char[field.key] ?? "").trim();
    // Skip empties rather than emitting "hair: " - a dangling label invites the
    // model to invent a value for it.
    //
    // This is also what keeps QĐ-070 free: a row created before the four new
    // columns existed has "" in each of them, contributes nothing here, and so
    // produces the identical string - and the identical idempotency hash - it
    // produced before.
    if (value.length > 0) parts.push(`${field.label}: ${value}`);
  }

  return parts.join(". ").replace(/\.\.+/g, ".").trim();
}

/**
 * Which required Bible fields this character has not stated.
 *
 * Returns the LABELS rather than the column names, because the only person who
 * acts on this is filling in a form that shows labels.
 */
export function missingBibleFields(char: CharacterRow): string[] {
  const labelFor = new Map(BIBLE_FIELDS.map((f) => [f.key as string, f.label]));
  return REQUIRED_BIBLE_FIELDS.filter(
    (key) => ((char[key] ?? "") as string).trim().length === 0,
  ).map((key) => labelFor.get(key) ?? key);
}

/**
 * How ready a character is to be drawn consistently.
 *
 * Three states, and the order of the checks is the order in which they hurt:
 *
 *   NEEDS_CHARACTER_REFERENCE  no approved master image. The model has only
 *                              words to go on. Nothing here generates one -
 *                              that is a paid call and it belongs to a person.
 *   NEEDS_IDENTITY_FIELDS      an image exists, but the written identity is too
 *                              thin to restate in a prompt, so any scene that
 *                              cannot send the image drifts.
 *   READY                      both halves present.
 *
 * A character can be BOTH, and the reference is reported first because it is
 * the one an operator has to supply rather than type.
 */
export type CharacterReadiness =
  | "READY"
  | "NEEDS_CHARACTER_REFERENCE"
  | "NEEDS_IDENTITY_FIELDS";

export function characterReadiness(input: {
  hasApprovedReference: boolean;
  missingFields: string[];
}): CharacterReadiness {
  if (!input.hasApprovedReference) return "NEEDS_CHARACTER_REFERENCE";
  if (input.missingFields.length > 0) return "NEEDS_IDENTITY_FIELDS";
  return "READY";
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
  // The caller filters to approved references, so a primary found here is an
  // APPROVED primary - which is the only kind that counts as a master.
  const primary = char.references.find((r) => r.isPrimary);
  const missingFields = missingBibleFields(char);
  return {
    id: char.id,
    name: char.name,
    version: char.version,
    canonical: buildCanonicalDescription(char),
    negative: char.negativePrompt.trim(),
    negativeIdentity: (char.negativeIdentity ?? "").trim(),
    seed: char.seed,
    primaryReference: primary?.filePath ?? null,
    references: char.references.map((r) => r.filePath),
    missingFields,
    readiness: characterReadiness({
      hasApprovedReference: primary !== undefined,
      missingFields,
    }),
  };
}

/** Thrown when a scene names somebody the character table has never heard of. */
export class UnknownCharacterError extends Error {
  constructor(readonly names: string[]) {
    super(
      `Cảnh nhắc tới nhân vật chưa có trong bảng Nhân vật: ${names.join(", ")}. ` +
        `Hãy tạo nhân vật (hoặc sửa tên trong cảnh) trước khi tạo ảnh — nếu không, ` +
        `mỗi cảnh sẽ vẽ ra một người khác nhau.`,
    );
    this.name = "UnknownCharacterError";
  }
}

/**
 * The same lookup, but a name with no row is an ERROR rather than a silence.
 *
 * `getCharacterSheetsByName` drops what it cannot find. That is the right shape
 * for a report and exactly the wrong shape before an image is bought: the name
 * disappears from the cast list, the prompt is composed without any identity
 * block for that person, and the model invents one - differently in every
 * scene. That is how a pipeline "silently creates a new character per scene"
 * while every individual step looks like it worked. See QĐ-070.
 */
export async function requireCharacterSheetsByName(
  names: string[],
): Promise<CharacterSheet[]> {
  const sheets = await getCharacterSheetsByName(names);
  const found = new Set(sheets.map((s) => s.name));
  const missing = names.filter((n) => !found.has(n));
  if (missing.length > 0) throw new UnknownCharacterError(missing);
  return sheets;
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
  for (const c of characters) {
    push(c.negative);
    // Identity negatives go in FIRST, alongside the character's own negatives
    // and ahead of the generic hygiene list. The set is insertion-ordered, so a
    // provider that truncates a long negative prompt drops boilerplate rather
    // than "never add glasses". See QĐ-070.
    push(c.negativeIdentity);
  }
  push(extra);
  push("text, watermark, signature, extra limbs, deformed hands, blurry");
  return [...seen].join(", ");
}
