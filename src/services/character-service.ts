import { sha256 } from "@/lib/crypto";
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

/**
 * Attributes a scene must never be allowed to change on its own.
 *
 * THE FULL VOCABULARY, not the clause. Which of these actually reaches a prompt
 * is decided per character by `lockedAttributesFor`, because a lock is only
 * meaningful over a value somebody stated.
 *
 * This list was pasted verbatim into every prompt until QĐ-072, including
 * "apparent age" and "skin tone" for characters whose rows said nothing about
 * either. That is a FAKE LOCK: it reads as an instruction, and what it actually
 * pins is whatever the model improvised on the first frame it drew - a
 * different answer each run, defended with the authority of a rule.
 */
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
 * Words an operator writes to mean "deliberately not specified".
 *
 * Distinct from an empty field only in TONE: both are unstated and neither may
 * be locked. The sentinel says a person looked at the box and decided to leave
 * it, so the interface stops nudging - which is the whole point of allowing it.
 * Never written into a prompt: "apparent age: unknown" is worse than silence,
 * because it hands the model a word to interpret.
 */
const NOT_SPECIFIED = new Set([
  "unknown",
  "not_specified",
  "not specified",
  "unspecified",
  "n/a",
  "na",
  "none",
  "-",
  "chưa rõ",
  "không rõ",
  "không xác định",
  "chưa xác định",
]);

/** Did somebody actually state a value here? */
export function isStated(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return v.length > 0 && !NOT_SPECIFIED.has(v.toLowerCase());
}

/** Stated as "we are not saying", as opposed to simply left blank. */
export function isDeliberatelyUnspecified(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return v.length > 0 && NOT_SPECIFIED.has(v.toLowerCase());
}

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
  /** Core descriptive fields not stated, as labels. Advice, not a blocker. */
  missingFields: string[];
  /**
   * Lockable attributes with no stated value, as labels.
   *
   * These are the attributes the prompt will NOT claim to protect. Surfaced so
   * a person can see the consequence of leaving a box empty rather than
   * discovering it in the fourth scene.
   */
  unlockedAttributes: string[];
  /** The lock clause this character's prompts will actually carry. */
  lockedAttributes: string[];
  /** READY / NEEDS_CHARACTER_REFERENCE / NEEDS_IDENTITY_FIELDS. */
  readiness: CharacterReadiness;
  /** Plain-language notes about the identity. Never blocks anything. */
  warnings: string[];
  /** Hash over the appearance fields only. Moves when the look changes. */
  fingerprint: string;
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
  { key: "presentation", label: "presentation", lock: null },
  { key: "approximateAge", label: "apparent age", lock: "apparent age" },
  { key: "skinTone", label: "skin tone", lock: "skin tone" },
  { key: "hair", label: "hair", lock: "hair colour and hairstyle" },
  { key: "facialFeatures", label: "face", lock: "face shape and facial features" },
  {
    key: "distinguishingFeatures",
    label: "distinguishing features",
    lock: "distinguishing features",
  },
  { key: "outfit", label: "outfit", lock: "signature outfit and its colours" },
  { key: "bodyProportions", label: "body", lock: "body proportions" },
  { key: "accessories", label: "accessories", lock: "accessories" },
  { key: "colorPalette", label: "colour palette", lock: null },
] as const satisfies ReadonlyArray<{
  key: keyof CharacterRow;
  label: string;
  /** Wording used in the lock clause, or null for a field that is not lockable. */
  lock: string | null;
}>;

/**
 * Written attributes that describe what a character LOOKS like.
 *
 * The distinction that matters is against `presentation` and `colorPalette`,
 * which are framing rather than features, and against age and skin tone, which
 * are genuinely often unknown. One of these stated is enough for a prompt to
 * have something to hold on to when the reference image cannot be sent.
 */
export const DESCRIPTIVE_BIBLE_FIELDS = [
  "hair",
  "facialFeatures",
  "outfit",
  "bodyProportions",
  "distinguishingFeatures",
] as const;

/**
 * Attributes worth nudging about, when a character has none of them.
 *
 * `approximateAge` and `skinTone` are deliberately ABSENT. They were required
 * until QĐ-072, which made three fully-specified characters read as incomplete
 * and - far worse - put both into the lock clause of every prompt with no value
 * behind either. An attribute nobody has stated is not a fact being protected;
 * it is a word the model gets to fill in, once, and then be held to.
 *
 * They remain in `BIBLE_FIELDS`: an operator who DOES know may still say so, and
 * saying so is what turns them into a real lock.
 */
export const CORE_BIBLE_FIELDS = [
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
    // Skip anything unstated rather than emitting "hair: " - a dangling label
    // invites the model to invent a value for it, and "apparent age: unknown"
    // is worse still, because that is a word the model will interpret.
    //
    // This is also what keeps QĐ-070 free: a row created before the four new
    // columns existed has "" in each of them, contributes nothing here, and so
    // produces the identical string - and the identical idempotency hash - it
    // produced before.
    if (isStated(value)) parts.push(`${field.label}: ${value}`);
  }

  return parts.join(". ").replace(/\.\.+/g, ".").trim();
}

const LABEL_FOR = new Map(BIBLE_FIELDS.map((f) => [f.key as string, f.label]));

/**
 * Core descriptive fields this character has not stated, as labels.
 *
 * "Missing" here means worth mentioning, NOT blocking. Age and skin tone are
 * outside this list on purpose - see `CORE_BIBLE_FIELDS`.
 */
export function missingBibleFields(char: CharacterRow): string[] {
  return CORE_BIBLE_FIELDS.filter((key) => !isStated(char[key])).map(
    (key) => LABEL_FOR.get(key) ?? key,
  );
}

/**
 * Lockable attributes this character has NO value for, as labels.
 *
 * Reported rather than hidden, because their absence has a consequence a person
 * should be able to see: those attributes are not being protected, and whatever
 * the model draws for them the first time is what the reference image will make
 * permanent.
 */
export function unlockedAttributes(char: CharacterRow): string[] {
  return BIBLE_FIELDS.filter((f) => f.lock !== null && !isStated(char[f.key])).map(
    (f) => f.label,
  );
}

/**
 * The lock clause for ONE character, built from what that character states.
 *
 * Only attributes with a real value are named. Anything unstated is handed to
 * the reference image instead - which is the honest instruction, because the
 * image is the only place that information exists.
 *
 * With no reference image and nothing stated there is nothing to say, and this
 * returns an empty list rather than a sentence asserting a lock over nothing.
 * See QĐ-072.
 */
export function lockedAttributesFor(char: CharacterRow): string[] {
  return BIBLE_FIELDS.filter((f) => f.lock !== null && isStated(char[f.key])).map(
    (f) => f.lock as string,
  );
}

/**
 * How ready a character is to be drawn consistently.
 *
 *   NEEDS_CHARACTER_REFERENCE  no reference image at all. Words alone drift,
 *                              and nothing in this codebase generates one -
 *                              that is a paid call and it belongs to a person.
 *   NEEDS_IDENTITY_FIELDS      there is a picture and not one descriptive word.
 *                              A scene the picture cannot be attached to has
 *                              nothing whatsoever to hold on to.
 *   READY                      a reference image, plus at least one stated
 *                              feature.
 *
 * READY does NOT mean complete. A character with a reference image and only
 * `hair` filled in is ready to produce consistent work, and `warnings` says
 * what would make it sturdier. Requiring a full sheet before letting an import
 * proceed was the wrong trade: it blocked work that would have come out fine,
 * and pushed whoever was blocked into inventing values to get past the gate.
 */
export type CharacterReadiness =
  | "READY"
  | "NEEDS_CHARACTER_REFERENCE"
  | "NEEDS_IDENTITY_FIELDS";

export function characterReadiness(input: {
  hasReference: boolean;
  /** Any stated descriptive feature at all - hair, face, outfit, body, marks. */
  hasAnyDescriptiveField: boolean;
}): CharacterReadiness {
  if (!input.hasReference) return "NEEDS_CHARACTER_REFERENCE";
  if (!input.hasAnyDescriptiveField) return "NEEDS_IDENTITY_FIELDS";
  return "READY";
}

export function hasAnyDescriptiveField(char: CharacterRow): boolean {
  return DESCRIPTIVE_BIBLE_FIELDS.some((key) => isStated(char[key]));
}

/**
 * A hash over the IDENTITY of a character, and nothing else.
 *
 * `description`, `personality`, `notes` and every voice setting are excluded on
 * purpose: none of them changes what the character looks like, so none of them
 * should invalidate a reference image that was approved against the old row.
 * Bumping the version for a typo fix in a note is how an approved master starts
 * reading as stale.
 *
 * Built from `BIBLE_FIELDS` in list order plus the free-text visual prompt and
 * the identity negatives, so it moves exactly when the appearance does.
 */
export function identityFingerprint(char: CharacterRow): string {
  const parts = [
    char.visualPrompt.trim(),
    (char.negativeIdentity ?? "").trim(),
    ...BIBLE_FIELDS.map((f) => `${f.key}=${(char[f.key] ?? "").trim()}`),
  ];
  return sha256(parts.join("\u0000")).slice(0, 16);
}

/** Every Bible column an edit form may write. */
export const EDITABLE_BIBLE_KEYS = [
  "presentation",
  "approximateAge",
  "skinTone",
  "hair",
  "facialFeatures",
  "distinguishingFeatures",
  "outfit",
  "bodyProportions",
  "accessories",
  "colorPalette",
  "negativeIdentity",
] as const;

export type EditableBibleKey = (typeof EDITABLE_BIBLE_KEYS)[number];

export interface SheetEdit {
  /** Trimmed values to write. Only the keys the caller actually supplied. */
  data: Record<string, string>;
  /** The version to store: bumped only when the APPEARANCE moved. */
  version: number;
  /** Did the identity fingerprint change? */
  changed: boolean;
  /** Fingerprint before and after, so a caller can log or show the reason. */
  before: string;
  after: string;
}

/**
 * Decide what an edit to a character's Bible actually changes.
 *
 * Pure, and shared by both edit paths - the Nhân vật page and the inline editor
 * on the import screen. They had a copy each, which is two chances to disagree
 * about when a version bumps, on the flag that decides whether an approved
 * reference image still describes this character.
 *
 * ## What "changed" means, and what it does not
 *
 * The identity fingerprint covers the appearance fields and nothing else.
 * Editing `notes`, `description`, `seed` or the generic negative prompt leaves
 * the version alone: bumping it for a typo fix is how a master image somebody
 * approved starts reading as stale, and how an operator learns to ignore the
 * version number. Whitespace-only edits are no edits - values are trimmed
 * before the comparison, so re-saving an untouched form is a no-op.
 *
 * NOTHING here writes an image, and nothing here touches a reference row. A
 * character can be re-described as often as anyone likes for free; drawing the
 * new description is a separate, paid, deliberate act. See QĐ-072.
 */
export function applySheetEdit(
  current: CharacterRow,
  input: Partial<Record<EditableBibleKey | "name", string>>,
): SheetEdit {
  const data: Record<string, string> = {};
  for (const key of EDITABLE_BIBLE_KEYS) {
    const value = input[key];
    if (value !== undefined) data[key] = value.trim();
  }
  const name = input.name?.trim();
  if (name !== undefined && name.length > 0 && name !== current.name) {
    data.name = name;
  }

  const before = identityFingerprint(current);
  const after = identityFingerprint({ ...current, ...data } as CharacterRow);
  const changed = before !== after;
  return {
    data,
    version: changed ? current.version + 1 : current.version,
    changed,
    before,
    after,
  };
}

/**
 * Find a character by name, ignoring case.
 *
 * `Character.name` is unique, and SQLite compares strings with a BINARY
 * collation - so `findUnique({ name: "max" })` misses a stored "Max" and the
 * caller happily creates a SECOND person with the same name in different
 * capitals. Two rows, two faces, one character as far as the viewer is
 * concerned. See QĐ-072.
 *
 * The exact match is tried first so the common path stays one indexed lookup;
 * the scan only runs when that misses, and the table is small by construction.
 */
export async function findCharacterByName(name: string) {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const exact = await prisma.character.findUnique({ where: { name: trimmed } });
  if (exact) return exact;
  const folded = trimmed.toLowerCase();
  const all = await prisma.character.findMany({ select: { id: true, name: true } });
  const hit = all.find((c) => c.name.trim().toLowerCase() === folded);
  return hit ? prisma.character.findUnique({ where: { id: hit.id } }) : null;
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
  // Every character, then matched case-insensitively in memory. Filtering in
  // SQL would use SQLite's BINARY collation, so a scene that says "max" would
  // silently get no sheet for a character stored as "Max" - and a prompt with
  // no identity block is exactly the failure this module exists to prevent.
  // The table holds a handful of rows by construction. See QĐ-072.
  const rows = await prisma.character.findMany({
    include: {
      references: {
        where: { approved: true },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      },
    },
  });
  const byFoldedName = new Map(rows.map((r) => [r.name.trim().toLowerCase(), r]));
  const seen = new Set<string>();
  return names
    .map((n) => byFoldedName.get(n.trim().toLowerCase()))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    // Two spellings of one name in one scene must not produce two sheets - the
    // prompt would then describe the same person twice and the reference cap
    // would spend one of its slots on a duplicate.
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
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
  const unlocked = unlockedAttributes(char);
  // A reference image is a reference image. Requiring the PRIMARY flag as well
  // made a character with a perfectly good approved picture read as having
  // none, purely because nobody had pressed "đặt làm ảnh chính".
  const hasReference = char.references.length > 0;

  const warnings: string[] = [];
  if (missingFields.length > 0) {
    warnings.push(
      `Hồ sơ nhận dạng chưa đầy đủ — chưa khai báo: ${missingFields.join(", ")}. ` +
        `Vẫn chạy được (ảnh tham chiếu đang gánh phần này), nhưng cảnh nào không ` +
        `gửi kèm được ảnh sẽ dựa vào ít chữ hơn.`,
    );
  }
  if (unlocked.length > 0) {
    warnings.push(
      `Không khoá: ${unlocked.join(", ")} — chưa có giá trị nào để khoá, nên ` +
        `prompt sẽ giao những thứ này cho ảnh tham chiếu thay vì tuyên bố suông.`,
    );
  }
  if (hasReference && primary === undefined) {
    warnings.push(
      "Có ảnh tham chiếu nhưng chưa ảnh nào được đặt làm ảnh CHÍNH. " +
        "Ảnh chính là ảnh được gửi kèm trước nhất khi nhà cung cấp giới hạn số ảnh.",
    );
  }

  return {
    id: char.id,
    name: char.name,
    version: char.version,
    canonical: buildCanonicalDescription(char),
    negative: char.negativePrompt.trim(),
    negativeIdentity: (char.negativeIdentity ?? "").trim(),
    seed: char.seed,
    primaryReference: primary?.filePath ?? char.references[0]?.filePath ?? null,
    references: char.references.map((r) => r.filePath),
    missingFields,
    unlockedAttributes: unlocked,
    lockedAttributes: lockedAttributesFor(char),
    readiness: characterReadiness({
      hasReference,
      hasAnyDescriptiveField: hasAnyDescriptiveField(char),
    }),
    warnings,
    fingerprint: identityFingerprint(char),
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
  // Folded, to agree with the lookup. Comparing exact spellings here would
  // report "max" as missing on the very call that just resolved it to "Max".
  const found = new Set(sheets.map((s) => s.name.trim().toLowerCase()));
  const missing = names.filter((n) => !found.has(n.trim().toLowerCase()));
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
    // THE LOCK CLAUSE NAMES ONLY WHAT SOMEBODY STATED.
    //
    // Until QĐ-072 this pasted the whole `LOCKED_ATTRIBUTES` vocabulary into
    // every prompt, so a character whose row said nothing about apparent age
    // was nonetheless told that its apparent age must not change. There was
    // nothing for that to mean: the model picked an age, and the sentence then
    // lent authority to the pick. Attributes with no value now go to the
    // reference image, which is the only place that information exists.
    // ONE LINE PER CHARACTER, because they do not state the same things.
    //
    // A union across the cast would put "signature outfit and its colours" in
    // front of a character whose row says nothing about an outfit - the same
    // fake lock, rebuilt at the level of the group. Two characters in a shot is
    // the normal case here, so this stays short.
    const anyReference = input.characters.some((c) => c.primaryReference);
    let saidSomething = false;
    for (const c of input.characters) {
      const locked = c.lockedAttributes ?? [];
      if (locked.length > 0) {
        lines.push(
          `Keep ${c.name} identical to the reference: ${locked.join(", ")} must not change.`,
        );
        saidSomething = true;
      } else if (c.primaryReference) {
        lines.push(
          `Keep ${c.name} identical to the reference image in every respect.`,
        );
        saidSomething = true;
      }
    }
    if (saidSomething) {
      lines.push("Only pose, expression and camera angle may differ.");
      // Everything the sheets do not pin down, pinned to the picture instead -
      // which is the only place that information actually exists.
      if (anyReference) {
        lines.push(
          "Every other aspect of their appearance must match the reference " +
            "image exactly, whether or not it is described above.",
        );
      }
    }
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
