import { z } from "zod";

/**
 * The storyboard import format, and everything that can be checked about it
 * without touching a disk or a database.
 *
 * ## Why a second input path at all
 *
 * V1 starts from an idiom and asks a text model to invent the scenes. That is
 * the right shape when the idea is the input. It is the wrong shape when the
 * scenes ALREADY EXIST - written by hand, or in a spreadsheet, or storyboarded
 * somewhere else with the keyframes already drawn. Feeding those through V1
 * means paying a text model to rewrite work that was already done, and then
 * paying an image model to redraw pictures that already exist.
 *
 * So: a second INPUT, one shared engine. Everything downstream of "there are
 * scenes in the database" - routing, motion decisions, the spend guard, the
 * batch authorisation, reservations, idempotency, retry, render - is the same
 * code V1 uses. This module only produces rows.
 *
 * ## Nothing here is allowed to be clever
 *
 * A validator that repairs its input quietly is a validator that hides the
 * mistake until it costs money. Missing OPTIONAL fields get documented
 * defaults; anything that changes what gets bought - a scene number, a
 * duration, a motion mode, a pinned model - is either present and valid or it
 * is an error with a line number.
 */

export const MOTION_MODES = ["AUTO", "LOCAL_MOTION", "VIDEO_AI"] as const;
export type MotionMode = (typeof MOTION_MODES)[number];

export const SPEND_PRIORITIES = ["LOW", "NORMAL", "HIGH"] as const;
export type StoryboardPriority = (typeof SPEND_PRIORITIES)[number];

/** Extensions an image model and FFmpeg will both accept as a keyframe. */
export const ALLOWED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;

/** Bounds a scene duration must sit inside to be worth rendering. */
export const MIN_SCENE_DURATION = 0.5;
export const MAX_SCENE_DURATION = 30;

/** Used when a row leaves `duration` out. Documented, not invented per row. */
export const DEFAULT_SCENE_DURATION = 4;

export interface StoryboardScene {
  sceneNumber: number;
  duration: number;
  narration: string;
  dialogue: string;
  visualDescription: string;
  characterAction: string;
  camera: string;
  subtitle: string;
  /** Relative to the storyboard's own folder. Null means "generate one". */
  imageFile: string | null;
  /**
   * How a supplied picture fills the frame. `auto` keeps a near-portrait
   * picture as it is and puts any other shape whole over a blurred copy of
   * itself; `cover` crops to fill; `contain` always fits whole. Never stretched.
   */
  imageFit: "auto" | "cover" | "contain";
  motionMode: MotionMode;
  /** Both null, or both set. A provider without a model is not a pin. */
  videoProvider: string | null;
  videoModel: string | null;
  priority: StoryboardPriority;
  /** Who is in this shot. Empty = fall back to the video-level cast. */
  characterId: string | null;
  /**
   * The video prompt, composed here rather than written by a model.
   *
   * A scene that is going to a video model needs one, and an imported
   * storyboard has everything required to build it: what is in shot, what
   * moves, and what the camera does. Deriving it is free and repeatable;
   * asking a text model to write it would be paying to re-say what the
   * operator already said.
   */
  videoPrompt: string;
}

/** A character declared once for the whole video and referenced by scenes. */
export interface StoryboardCharacter {
  characterId: string;
  name: string;
  /** Relative path to a reference image, same safety rules as a keyframe. */
  referenceImage: string | null;
  /**
   * The Character Bible, as far as the storyboard chose to state it.
   *
   * Every field optional and empty when unstated - a storyboard that says only
   * "Max" is still valid input, it just produces a character the importer will
   * flag as NEEDS_IDENTITY_FIELDS rather than one it quietly invents an
   * appearance for. These are used ONLY when creating a new character: an
   * existing "Max" is reused untouched, because an import that rewrote his
   * canonical description would redraw him in every older video. See QĐ-070.
   */
  bible: StoryboardCharacterBible;
}

export interface StoryboardCharacterBible {
  presentation: string;
  approximateAge: string;
  skinTone: string;
  hair: string;
  face: string;
  distinguishingFeatures: string;
  outfit: string;
  bodyProportions: string;
  accessories: string;
  colorPalette: string;
  negativeIdentity: string;
}

/**
 * Column/key names accepted for each Bible field.
 *
 * Several spellings each, because this file is filled in by hand: a storyboard
 * rejected over `skin_tone` versus `skintone` teaches nothing and costs an
 * afternoon. The FIRST match wins, so the canonical name is listed first.
 */
const BIBLE_KEYS: Record<keyof StoryboardCharacterBible, string[]> = {
  presentation: ["character_presentation", "presentation", "gender"],
  approximateAge: ["character_age", "approximate_age", "age"],
  skinTone: ["character_skin_tone", "skin_tone", "skintone"],
  hair: ["character_hair", "hair"],
  face: ["character_face", "face", "facial_features"],
  distinguishingFeatures: [
    "character_distinguishing_features",
    "distinguishing_features",
    "distinguishing",
  ],
  outfit: ["character_outfit", "outfit", "clothing"],
  bodyProportions: ["character_body", "body_proportions", "body"],
  accessories: ["character_accessories", "accessories"],
  colorPalette: ["character_color_palette", "color_palette", "colour_palette"],
  negativeIdentity: [
    "character_negative_identity",
    "negative_identity",
    "character_negative",
  ],
};

export function emptyCharacterBible(): StoryboardCharacterBible {
  return {
    presentation: "",
    approximateAge: "",
    skinTone: "",
    hair: "",
    face: "",
    distinguishingFeatures: "",
    outfit: "",
    bodyProportions: "",
    accessories: "",
    colorPalette: "",
    negativeIdentity: "",
  };
}

function readCharacterBible(row: Record<string, unknown>): StoryboardCharacterBible {
  const bible = emptyCharacterBible();
  for (const [field, keys] of Object.entries(BIBLE_KEYS)) {
    for (const key of keys) {
      const value = text(row[key]);
      if (value.length > 0) {
        bible[field as keyof StoryboardCharacterBible] = value;
        break;
      }
    }
  }
  return bible;
}

export interface StoryboardVideo {
  videoId: string;
  videoTitle: string;
  scenes: StoryboardScene[];
  /** Cast declared at video level, keyed by `character_id`. */
  characters: StoryboardCharacter[];
  /** Where this came from, for an error message a person can act on. */
  sourceFile: string;
}

export type IssueLevel = "error" | "warning";

export interface ImportIssue {
  level: IssueLevel;
  /** Stable machine code, so a test asserts on the rule rather than the wording. */
  code: string;
  videoId?: string;
  sceneNumber?: number;
  /** 1-based line in the CSV, or index in the JSON array. */
  line?: number;
  sourceFile?: string;
  message: string;
}

export interface ParsedStoryboards {
  videos: StoryboardVideo[];
  issues: ImportIssue[];
}

export function hasErrors(issues: ImportIssue[]): boolean {
  return issues.some((i) => i.level === "error");
}

// --------------------------------------------------------------- helpers ---

function err(
  code: string,
  message: string,
  extra: Partial<ImportIssue> = {},
): ImportIssue {
  return { level: "error", code, message, ...extra };
}

function warn(
  code: string,
  message: string,
  extra: Partial<ImportIssue> = {},
): ImportIssue {
  return { level: "warning", code, message, ...extra };
}

const text = (v: unknown): string =>
  v === null || v === undefined ? "" : String(v).trim();

/**
 * Is this a relative path that stays inside the storyboard's own folder?
 *
 * The rule is deliberately strict rather than clever. A ZIP is untrusted input:
 * it can name `../../../.ssh/id_rsa`, an absolute path, a Windows drive, or a
 * UNC share, and every one of those is a file-write outside the folder the
 * operator thought they were importing. There is no legitimate storyboard that
 * needs any of them.
 */
export function isSafeRelativePath(candidate: string): boolean {
  const p = candidate.trim();
  if (p.length === 0) return false;
  if (p.length > 255) return false;
  if (/^[a-zA-Z]:/.test(p)) return false; // C:\...
  if (p.startsWith("/") || p.startsWith("\\")) return false; // /etc, \\server
  if (/\0/.test(p)) return false;
  const parts = p.split(/[\\/]+/);
  if (parts.some((s) => s === ".." || s === "")) return false;
  return true;
}

export function hasAllowedImageExtension(file: string): boolean {
  const lower = file.toLowerCase();
  return ALLOWED_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Ids become folder names, so they get the same treatment as a path segment. */
export function isSafeVideoId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id);
}

// ------------------------------------------------------------ raw schema ---

/**
 * Every field optional at the schema level on purpose.
 *
 * Requiredness is checked in `normaliseScene`, which can say WHICH scene of
 * WHICH video is missing WHAT. A Zod failure on a 200-row import says "invalid
 * input" and leaves the operator to find it.
 */
const RawSceneSchema = z
  .object({
    video_id: z.unknown().optional(),
    video_title: z.unknown().optional(),
    scene_number: z.unknown().optional(),
    duration: z.unknown().optional(),
    narration: z.unknown().optional(),
    dialogue: z.unknown().optional(),
    visual_description: z.unknown().optional(),
    character_action: z.unknown().optional(),
    camera: z.unknown().optional(),
    subtitle: z.unknown().optional(),
    image_file: z.unknown().optional(),
    image_fit: z.unknown().optional(),
    motion_mode: z.unknown().optional(),
    video_provider: z.unknown().optional(),
    video_model: z.unknown().optional(),
    priority: z.unknown().optional(),
    character_id: z.unknown().optional(),
    character_name: z.unknown().optional(),
    character_reference_image: z.unknown().optional(),
    video_prompt: z.unknown().optional(),
  })
  .passthrough();

export type RawScene = z.infer<typeof RawSceneSchema>;

const StoryboardFileSchema = z.union([
  z.array(RawSceneSchema),
  z
    .object({
      video_id: z.unknown().optional(),
      video_title: z.unknown().optional(),
      scenes: z.array(RawSceneSchema),
    })
    .passthrough(),
  z
    .object({
      videos: z.array(
        z
          .object({
            video_id: z.unknown().optional(),
            video_title: z.unknown().optional(),
            scenes: z.array(RawSceneSchema),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
]);

// ------------------------------------------------------------ normalising ---

export interface NormaliseContext {
  sourceFile: string;
  /** Fallback id when the file itself does not name one, e.g. the folder name. */
  fallbackVideoId: string;
  fallbackVideoTitle: string;
  line?: number;
}

/**
 * Compose the video prompt from what the storyboard already says.
 *
 * Deterministic and free. The order is the order a video model reads best:
 * what is in the frame, then what moves, then what the camera does - the same
 * order `buildScenePrompt` uses for images, and the same order the camera
 * guardrail expects to append its lock block to.
 *
 * Nothing is invented. Every sentence here came from a field the operator
 * filled in, so the same storyboard always produces the same prompt, byte for
 * byte - which it must, because the prompt is hashed into the idempotency key
 * that stops a resumed run paying for the same clip twice.
 */
export function deriveVideoPrompt(input: {
  visualDescription: string;
  characterAction: string;
  camera: string;
  narration?: string;
}): string {
  const visual = input.visualDescription.trim();
  const action = input.characterAction.trim();
  const camera = input.camera.trim();

  const parts: string[] = [];
  if (visual.length > 0) parts.push(visual.endsWith(".") ? visual : `${visual}.`);
  if (action.length > 0) parts.push(`Movement: ${action.endsWith(".") ? action : `${action}.`}`);
  if (camera.length > 0) parts.push(`Camera: ${camera.endsWith(".") ? camera : `${camera}.`}`);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Does this prompt actually describe something a video model can animate?
 *
 * A camera line on its own does not: "Camera: locked static medium shot" tells
 * a model where to stand and nothing about what happens. A scene going to a
 * paid video model with nothing but that would buy five seconds of a still
 * image, which is what LOCAL_MOTION does for free.
 */
export function promptHasMotionContent(input: {
  visualDescription: string;
  characterAction: string;
}): boolean {
  return (
    input.visualDescription.trim().length > 0 || input.characterAction.trim().length > 0
  );
}

export function normaliseScene(
  raw: RawScene,
  ctx: NormaliseContext,
): { scene: StoryboardScene | null; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  const where = { sourceFile: ctx.sourceFile, line: ctx.line };

  const rawNumber = text(raw.scene_number);
  const sceneNumber = Number(rawNumber);
  if (rawNumber.length === 0 || !Number.isInteger(sceneNumber) || sceneNumber < 1) {
    issues.push(
      err("scene_number_invalid", `scene_number không hợp lệ: "${rawNumber}".`, where),
    );
    return { scene: null, issues };
  }
  const at = { ...where, sceneNumber };

  const rawDuration = text(raw.duration);
  let duration = DEFAULT_SCENE_DURATION;
  if (rawDuration.length > 0) {
    duration = Number(rawDuration);
    if (!Number.isFinite(duration) || duration < MIN_SCENE_DURATION || duration > MAX_SCENE_DURATION) {
      issues.push(
        err(
          "duration_invalid",
          `duration "${rawDuration}" nằm ngoài khoảng ${MIN_SCENE_DURATION}–${MAX_SCENE_DURATION} giây.`,
          at,
        ),
      );
      return { scene: null, issues };
    }
  } else {
    issues.push(
      warn("duration_defaulted", `Thiếu duration, dùng mặc định ${DEFAULT_SCENE_DURATION}s.`, at),
    );
  }

  const visualDescription = text(raw.visual_description);
  const narration = text(raw.narration);
  const dialogue = text(raw.dialogue);
  const characterAction = text(raw.character_action);
  if (visualDescription.length === 0 && characterAction.length === 0) {
    issues.push(
      err(
        "scene_has_nothing_to_draw",
        "Cảnh không có visual_description lẫn character_action nên không có gì để vẽ.",
        at,
      ),
    );
    return { scene: null, issues };
  }

  const rawMotion = text(raw.motion_mode).toUpperCase();
  let motionMode: MotionMode = "AUTO";
  if (rawMotion.length > 0) {
    if (!(MOTION_MODES as readonly string[]).includes(rawMotion)) {
      issues.push(
        err(
          "motion_mode_invalid",
          `motion_mode "${rawMotion}" không hợp lệ. Chỉ nhận: ${MOTION_MODES.join(", ")}.`,
          at,
        ),
      );
      return { scene: null, issues };
    }
    motionMode = rawMotion as MotionMode;
  }

  const rawPriority = text(raw.priority).toUpperCase();
  let priority: StoryboardPriority = "NORMAL";
  if (rawPriority.length > 0) {
    if (!(SPEND_PRIORITIES as readonly string[]).includes(rawPriority)) {
      issues.push(
        err(
          "priority_invalid",
          `priority "${rawPriority}" không hợp lệ. Chỉ nhận: ${SPEND_PRIORITIES.join(", ")}.`,
          at,
        ),
      );
      return { scene: null, issues };
    }
    priority = rawPriority as StoryboardPriority;
  }

  let imageFile: string | null = null;
  const rawImage = text(raw.image_file);
  if (rawImage.length > 0) {
    if (!isSafeRelativePath(rawImage)) {
      issues.push(
        err(
          "image_path_unsafe",
          `image_file "${rawImage}" không phải đường dẫn tương đối an toàn. ` +
            "Không nhận đường dẫn tuyệt đối, ổ đĩa, hay '..'.",
          at,
        ),
      );
      return { scene: null, issues };
    }
    if (!hasAllowedImageExtension(rawImage)) {
      issues.push(
        err(
          "image_type_invalid",
          `image_file "${rawImage}" không phải ảnh hợp lệ. Chỉ nhận: ${ALLOWED_IMAGE_EXTENSIONS.join(", ")}.`,
          at,
        ),
      );
      return { scene: null, issues };
    }
    imageFile = rawImage.replace(/\\/g, "/");
  }

  const rawFit = text(raw.image_fit).toLowerCase() || "auto";
  if (!["auto", "cover", "contain"].includes(rawFit)) {
    issues.push(
      err(
        "image_fit_invalid",
        `image_fit "${text(raw.image_fit)}" không hợp lệ. Chỉ nhận: auto, cover, contain.`,
        at,
      ),
    );
    return { scene: null, issues };
  }
  const imageFit = rawFit as "auto" | "cover" | "contain";

  // A provider without a model is not a pin, it is half a sentence - and half a
  // pin resolves to "the router picks", which is not what was written down.
  const videoProvider = text(raw.video_provider) || null;
  const videoModel = text(raw.video_model) || null;
  if ((videoProvider === null) !== (videoModel === null)) {
    issues.push(
      err(
        "pin_incomplete",
        "Ghim model phải có ĐỦ cả video_provider và video_model. " +
          `Hiện có provider="${videoProvider ?? ""}", model="${videoModel ?? ""}".`,
        at,
      ),
    );
    return { scene: null, issues };
  }
  if (videoProvider !== null && motionMode === "LOCAL_MOTION") {
    issues.push(
      err(
        "pin_contradicts_local_motion",
        `Cảnh ghi motion_mode=LOCAL_MOTION (không gọi Video AI) nhưng lại ghim ` +
          `${videoProvider}/${videoModel}. Hai lệnh này không thể cùng đúng.`,
        at,
      ),
    );
    return { scene: null, issues };
  }

  const camera = text(raw.camera);

  // Written by the operator if they wrote one; composed from their own fields
  // if they did not. Never asked of a text model.
  const supplied = text(raw.video_prompt);
  const videoPrompt =
    supplied.length > 0
      ? supplied
      : deriveVideoPrompt({ visualDescription, characterAction, camera, narration });

  // A scene heading for a paid video model must describe something that MOVES.
  // Caught here, at import, and not at the provider: by the time a request is
  // being built the batch is already approved and the money is already
  // committed to being spent on something.
  if (
    motionMode === "VIDEO_AI" &&
    supplied.length === 0 &&
    !promptHasMotionContent({ visualDescription, characterAction })
  ) {
    issues.push(
      err(
        "video_ai_without_motion",
        "Cảnh đặt motion_mode=VIDEO_AI nhưng không có visual_description lẫn " +
          "character_action, nên không dựng được videoPrompt. Hãy mô tả cảnh/hành " +
          "động, ghi video_prompt tường minh, hoặc chuyển sang LOCAL_MOTION.",
        at,
      ),
    );
    return { scene: null, issues };
  }

  return {
    scene: {
      sceneNumber,
      duration,
      narration,
      dialogue,
      visualDescription,
      characterAction,
      camera,
      subtitle: text(raw.subtitle),
      imageFile,
      imageFit,
      motionMode,
      videoProvider,
      videoModel,
      priority,
      characterId: text(raw.character_id) || null,
      videoPrompt,
    },
    issues,
  };
}

/** Checks that only make sense once every scene of a video is in hand. */
export function validateVideo(video: StoryboardVideo): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const base = { videoId: video.videoId, sourceFile: video.sourceFile };

  if (!isSafeVideoId(video.videoId)) {
    issues.push(
      err(
        "video_id_invalid",
        `video_id "${video.videoId}" không hợp lệ. Chỉ nhận chữ, số, '.', '_', '-' ` +
          "và tối đa 64 ký tự, vì nó trở thành tên thư mục.",
        base,
      ),
    );
  }

  if (video.scenes.length === 0) {
    issues.push(err("video_has_no_scenes", "Storyboard không có cảnh nào.", base));
    return issues;
  }

  const seen = new Map<number, number>();
  for (const scene of video.scenes) {
    seen.set(scene.sceneNumber, (seen.get(scene.sceneNumber) ?? 0) + 1);
  }
  for (const [sceneNumber, count] of [...seen.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > 1) {
      issues.push(
        err(
          "scene_number_duplicate",
          `scene_number ${sceneNumber} xuất hiện ${count} lần. Mỗi cảnh phải có số riêng.`,
          { ...base, sceneNumber },
        ),
      );
    }
  }

  // Gaps are legal - a storyboard may be numbered 10, 20, 30 - but they are
  // worth saying out loud, because the usual cause is a row that failed to
  // parse and is now missing from a video nobody noticed had shrunk.
  const numbers = [...seen.keys()].sort((a, b) => a - b);
  if (numbers.length > 1 && numbers[numbers.length - 1]! - numbers[0]! + 1 !== numbers.length) {
    issues.push(
      warn(
        "scene_numbers_not_contiguous",
        `Số cảnh không liên tục: ${numbers.join(", ")}. Thứ tự vẫn theo số tăng dần.`,
        base,
      ),
    );
  }

  return issues;
}

// ----------------------------------------------------------------- JSON ---

/** Cast declared at video level, plus any a scene named inline. */
function collectCharacters(
  declared: unknown,
  rows: RawScene[],
): { characters: StoryboardCharacter[]; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  const byId = new Map<string, StoryboardCharacter>();

  const add = (
    id: string,
    name: string,
    image: string,
    bible: StoryboardCharacterBible,
  ) => {
    if (id.length === 0) return;
    const existing = byId.get(id);
    if (existing) {
      // Same id, two different names is the one thing that must not pass: it is
      // exactly how a video ends up with two versions of the same person.
      if (name.length > 0 && existing.name.length > 0 && existing.name !== name) {
        issues.push(
          err(
            "character_id_conflict",
            `character_id "${id}" được gán hai tên khác nhau: ` +
              `"${existing.name}" và "${name}".`,
          ),
        );
        return;
      }
      if (existing.name.length === 0 && name.length > 0) existing.name = name;
      if (existing.referenceImage === null && image.length > 0) {
        existing.referenceImage = image;
      }
      // FIRST statement of an attribute wins, and a later row may only fill a
      // gap. One character declared twice with two different hair colours is a
      // contradiction, and quietly taking the last one would resolve it in
      // whichever direction the file happened to be ordered.
      for (const key of Object.keys(bible) as (keyof StoryboardCharacterBible)[]) {
        const incoming = bible[key].trim();
        if (incoming.length === 0) continue;
        if (existing.bible[key].trim().length > 0) {
          if (existing.bible[key].trim() !== incoming) {
            issues.push(
              warn(
                "character_attribute_conflict",
                `Nhân vật "${existing.name}" được khai báo hai giá trị khác nhau cho ` +
                  `"${key}": giữ "${existing.bible[key].trim()}", bỏ "${incoming}".`,
              ),
            );
          }
          continue;
        }
        existing.bible[key] = incoming;
      }
      return;
    }
    byId.set(id, {
      characterId: id,
      name: name.length > 0 ? name : id,
      referenceImage: image.length > 0 ? image : null,
      bible,
    });
  };

  if (Array.isArray(declared)) {
    for (const entry of declared) {
      const row = entry as Record<string, unknown>;
      add(
        text(row.character_id) || text(row.id),
        text(row.character_name) || text(row.name),
        text(row.character_reference_image) || text(row.reference_image),
        readCharacterBible(row),
      );
    }
  }
  for (const row of rows) {
    add(
      text(row.character_id),
      text(row.character_name),
      text(row.character_reference_image),
      readCharacterBible(row as unknown as Record<string, unknown>),
    );
  }

  for (const character of byId.values()) {
    if (character.referenceImage === null) continue;
    if (!isSafeRelativePath(character.referenceImage)) {
      issues.push(
        err(
          "character_reference_unsafe",
          `Ảnh tham chiếu của "${character.name}" không phải đường dẫn tương đối an toàn.`,
        ),
      );
      character.referenceImage = null;
    } else if (!hasAllowedImageExtension(character.referenceImage)) {
      issues.push(
        err(
          "character_reference_invalid",
          `Ảnh tham chiếu của "${character.name}" không đúng định dạng ảnh cho phép.`,
        ),
      );
      character.referenceImage = null;
    }
  }

  return { characters: [...byId.values()], issues };
}

export function parseStoryboardJson(
  content: string,
  ctx: Omit<NormaliseContext, "line">,
): ParsedStoryboards {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (e) {
    return {
      videos: [],
      issues: [
        err("json_malformed", `JSON hỏng: ${e instanceof Error ? e.message : String(e)}`, {
          sourceFile: ctx.sourceFile,
        }),
      ],
    };
  }

  const parsed = StoryboardFileSchema.safeParse(data);
  if (!parsed.success) {
    return {
      videos: [],
      issues: [
        err(
          "json_schema_invalid",
          "JSON không đúng cấu trúc. Nhận: một mảng cảnh, một object {scenes: [...]}, " +
            "hoặc {videos: [{scenes: [...]}]}.",
          { sourceFile: ctx.sourceFile },
        ),
      ],
    };
  }

  const groups: {
    videoId: string;
    videoTitle: string;
    scenes: RawScene[];
    declared: unknown;
  }[] = [];
  const value = parsed.data as Record<string, unknown>;
  if (Array.isArray(value)) {
    groups.push({ videoId: "", videoTitle: "", scenes: value, declared: undefined });
  } else if ("videos" in value) {
    const list = value.videos as {
      video_id?: unknown;
      video_title?: unknown;
      characters?: unknown;
      scenes: RawScene[];
    }[];
    for (const v of list) {
      groups.push({
        videoId: text(v.video_id),
        videoTitle: text(v.video_title),
        scenes: v.scenes,
        declared: v.characters,
      });
    }
  } else {
    groups.push({
      videoId: text(value.video_id),
      videoTitle: text(value.video_title),
      scenes: value.scenes as RawScene[],
      declared: value.characters,
    });
  }

  const issues: ImportIssue[] = [];
  const videos: StoryboardVideo[] = [];

  for (const group of groups) {
    // A row may name the video too. That is how one flat array holds several.
    const byVideo = new Map<string, { title: string; scenes: StoryboardScene[] }>();
    group.scenes.forEach((raw, index) => {
      const videoId = text(raw.video_id) || group.videoId || ctx.fallbackVideoId;
      const videoTitle =
        text(raw.video_title) || group.videoTitle || ctx.fallbackVideoTitle || videoId;
      const { scene, issues: sceneIssues } = normaliseScene(raw, {
        ...ctx,
        line: index + 1,
      });
      for (const i of sceneIssues) issues.push({ ...i, videoId });
      if (!scene) return;
      const bucket = byVideo.get(videoId) ?? { title: videoTitle, scenes: [] };
      bucket.scenes.push(scene);
      byVideo.set(videoId, bucket);
    });

    const cast = collectCharacters(group.declared, group.scenes);
    for (const i of cast.issues) issues.push({ ...i, sourceFile: ctx.sourceFile });

    for (const [videoId, bucket] of byVideo) {
      videos.push({
        videoId,
        videoTitle: bucket.title,
        scenes: [...bucket.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber),
        characters: cast.characters,
        sourceFile: ctx.sourceFile,
      });
    }
  }

  for (const video of videos) issues.push(...validateVideo(video));
  return { videos, issues };
}

// ------------------------------------------------------------------ CSV ---

/**
 * A real CSV reader, because a `split(",")` one corrupts the first scene whose
 * dialogue contains a comma - and every line of dialogue contains a comma.
 *
 * Handles quoted fields, doubled quotes inside them, embedded newlines, CRLF
 * and a UTF-8 BOM. An unterminated quote is reported with the line it started
 * on rather than silently swallowing the rest of the file.
 */
export function parseCsvRows(
  content: string,
): { rows: string[][]; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  const src = content.replace(/^\uFEFF/, "");
  const rows: string[][] = [];

  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let line = 1;
  let quoteStartedAt = 1;
  let sawAnything = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      quoteStartedAt = line;
      sawAnything = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      sawAnything = true;
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(field);
      if (sawAnything || row.some((f) => f.length > 0)) rows.push(row);
      row = [];
      field = "";
      sawAnything = false;
      line += 1;
      continue;
    }
    field += ch;
    sawAnything = true;
  }

  if (inQuotes) {
    issues.push(
      err(
        "csv_unterminated_quote",
        `Dấu nháy kép mở ở dòng ${quoteStartedAt} không được đóng. File CSV hỏng.`,
        { line: quoteStartedAt },
      ),
    );
    return { rows: [], issues };
  }
  row.push(field);
  if (sawAnything || row.some((f) => f.length > 0)) rows.push(row);

  return { rows, issues };
}

export function parseStoryboardCsv(
  content: string,
  ctx: Omit<NormaliseContext, "line">,
): ParsedStoryboards {
  const { rows, issues } = parseCsvRows(content);
  for (const i of issues) i.sourceFile = ctx.sourceFile;
  if (issues.length > 0) return { videos: [], issues };

  if (rows.length === 0) {
    return {
      videos: [],
      issues: [err("csv_empty", "File CSV rỗng.", { sourceFile: ctx.sourceFile })],
    };
  }

  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  if (!header.includes("scene_number")) {
    return {
      videos: [],
      issues: [
        err(
          "csv_header_invalid",
          `Dòng tiêu đề thiếu cột bắt buộc "scene_number". Đang có: ${header.join(", ")}.`,
          { sourceFile: ctx.sourceFile, line: 1 },
        ),
      ],
    };
  }

  const byVideo = new Map<string, { title: string; scenes: StoryboardScene[] }>();
  const out: ImportIssue[] = [];

  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r]!;
    const line = r + 1;
    if (cells.length !== header.length) {
      out.push(
        err(
          "csv_column_count",
          `Dòng ${line} có ${cells.length} ô nhưng tiêu đề có ${header.length} cột.`,
          { sourceFile: ctx.sourceFile, line },
        ),
      );
      continue;
    }
    const raw: Record<string, string> = {};
    header.forEach((key, index) => {
      raw[key] = cells[index] ?? "";
    });

    const videoId = text(raw.video_id) || ctx.fallbackVideoId;
    const videoTitle = text(raw.video_title) || ctx.fallbackVideoTitle || videoId;
    const { scene, issues: sceneIssues } = normaliseScene(raw as RawScene, {
      ...ctx,
      line,
    });
    for (const i of sceneIssues) out.push({ ...i, videoId });
    if (!scene) continue;

    const bucket = byVideo.get(videoId) ?? { title: videoTitle, scenes: [] };
    bucket.scenes.push(scene);
    byVideo.set(videoId, bucket);
  }

  const rawByVideo = new Map<string, RawScene[]>();
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r]!;
    if (cells.length !== header.length) continue;
    const raw: Record<string, string> = {};
    header.forEach((key, index) => {
      raw[key] = cells[index] ?? "";
    });
    const id = text(raw.video_id) || ctx.fallbackVideoId;
    rawByVideo.set(id, [...(rawByVideo.get(id) ?? []), raw as RawScene]);
  }

  const videos: StoryboardVideo[] = [...byVideo.entries()].map(([videoId, bucket]) => {
    const cast = collectCharacters(undefined, rawByVideo.get(videoId) ?? []);
    for (const i of cast.issues) out.push({ ...i, videoId, sourceFile: ctx.sourceFile });
    return {
      videoId,
      videoTitle: bucket.title,
      scenes: [...bucket.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber),
      characters: cast.characters,
      sourceFile: ctx.sourceFile,
    };
  });

  for (const video of videos) out.push(...validateVideo(video));
  return { videos, issues: out };
}

/** Pick the parser from the file name. */
export function parseStoryboardFile(
  fileName: string,
  content: string,
  ctx: Omit<NormaliseContext, "line">,
): ParsedStoryboards {
  if (fileName.toLowerCase().endsWith(".csv")) return parseStoryboardCsv(content, ctx);
  if (fileName.toLowerCase().endsWith(".json")) return parseStoryboardJson(content, ctx);
  return {
    videos: [],
    issues: [
      err(
        "unsupported_file",
        `Không hỗ trợ định dạng "${fileName}". Chỉ nhận .json hoặc .csv.`,
        { sourceFile: fileName },
      ),
    ],
  };
}
