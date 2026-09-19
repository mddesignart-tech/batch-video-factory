import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { DIRS, projectSubdir, toRelative, uuidFilename } from "@/lib/paths";
import { readZipFile, ZipError, type ZipEntry } from "@/lib/zip";
import {
  hasAllowedImageExtension,
  isSafeRelativePath,
  parseStoryboardFile,
  type ImportIssue,
  type StoryboardCharacter,
  type StoryboardScene,
  type StoryboardVideo,
} from "@/domain/storyboard";
import { sha256Bytes } from "@/lib/crypto";
import { toAbsolute } from "@/lib/paths";
import { classifyScene, assignSpendPriority } from "./complexity";
import {
  characterReadiness,
  findCharacterByName,
  hasAnyDescriptiveField,
  missingBibleFields,
  unlockedAttributes,
  type CharacterReadiness,
} from "./character-service";
import type { Complexity } from "@/domain/enums";

/**
 * Turning a folder, a ZIP or a single storyboard file into projects and scenes.
 *
 * ## The one architectural rule
 *
 * This module produces ROWS. It does not generate, route, price or spend.
 * Everything after "there are scenes in the database" is the engine V1 already
 * uses - `previewProjectCost` for the estimate, `BatchAuthorization` for the
 * approval, `batch_expand` to start each video, `generate_scene_media` for the
 * work, the spend guard and reservations for the money. Import is an INPUT
 * path, not a second pipeline, and there is deliberately no way to reach a
 * provider from this file.
 *
 * ## What is skipped, and how the skip is recorded
 *
 * A storyboard that carries its own text must not be rewritten by a text model,
 * and a scene that ships its own keyframe must not be redrawn by an image
 * model. The first is free: the project is created with `scriptJson` already
 * set and `status: "script_ready"`, so nothing ever asks for a script. The
 * second needs a fact in the database - `Scene.imageSource = "IMPORTED"` -
 * because `generateSceneImage` cannot otherwise tell a supplied keyframe from
 * one it is about to be asked to make. Inferring it from "there is a path but
 * no ProviderJob" would be a guess, and a wrong guess buys an image.
 */

// ------------------------------------------------------------- scanning ---

/** A file that may become a keyframe, from a folder or from inside a ZIP. */
export interface AssetSource {
  /** Path as written in the archive/folder, for error messages. */
  label: string;
  read: () => Buffer;
}

export interface ScannedVideo {
  video: StoryboardVideo;
  /** Keyed by relative path AND by bare filename, both lowercased. */
  assets: Map<string, AssetSource>;
}

export interface ScanResult {
  videos: ScannedVideo[];
  issues: ImportIssue[];
  /** What the source looked like, for the report. */
  sourceKind: "folder" | "zip" | "file";
  sourceLabel: string;
}

const STORYBOARD_NAMES = /^storyboard\.(json|csv)$/i;

function isStoryboardFile(name: string): boolean {
  return STORYBOARD_NAMES.test(path.basename(name)) || /\.(json|csv)$/i.test(name);
}

function issue(
  level: "error" | "warning",
  code: string,
  message: string,
  extra: Partial<ImportIssue> = {},
): ImportIssue {
  return { level, code, message, ...extra };
}

/**
 * Group a flat list of files into one bucket per storyboard.
 *
 * A "video folder" is simply the directory a storyboard file sits in; every
 * image at or below that directory belongs to it. That supports both shapes
 * the operator asked for - images beside the storyboard, and images in an
 * `images/` subfolder - without either being a special case.
 */
function groupByStoryboard(
  files: { path: string; source: AssetSource }[],
): Map<string, { storyboards: string[]; assets: Map<string, AssetSource> }> {
  const storyboardDirs = new Set<string>();
  for (const f of files) {
    if (isStoryboardFile(f.path)) storyboardDirs.add(path.posix.dirname(f.path));
  }

  const groups = new Map<
    string,
    { storyboards: string[]; assets: Map<string, AssetSource> }
  >();
  for (const dir of storyboardDirs) {
    groups.set(dir, { storyboards: [], assets: new Map() });
  }

  for (const f of files) {
    // The deepest storyboard directory that contains this file owns it, so a
    // nested video folder does not steal its parent's images.
    let owner = "";
    for (const dir of storyboardDirs) {
      const prefix = dir === "." ? "" : `${dir}/`;
      if ((dir === "." || f.path.startsWith(prefix)) && dir.length >= owner.length) {
        owner = dir;
      }
    }
    if (!groups.has(owner)) continue;
    const group = groups.get(owner)!;
    if (isStoryboardFile(f.path)) {
      group.storyboards.push(f.path);
      continue;
    }
    if (!hasAllowedImageExtension(f.path)) continue;
    const prefix = owner === "." ? "" : `${owner}/`;
    const relative = f.path.slice(prefix.length).toLowerCase();
    group.assets.set(relative, f.source);
    // Also by bare name, so `image_file: 01.png` finds `images/01.png`.
    const bare = path.posix.basename(relative);
    if (!group.assets.has(bare)) group.assets.set(bare, f.source);
  }

  return groups;
}

/** Read every file under a directory, as forward-slash relative paths. */
function walkFolder(root: string): { path: string; source: AssetSource }[] {
  const out: { path: string; source: AssetSource }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push({
        path: relative,
        source: { label: relative, read: () => fs.readFileSync(absolute) },
      });
    }
  };
  walk(root, "");
  return out;
}

/** "Max: \"Hello.\"" -> "Hello." A speaker label is not an example sentence. */
function stripSpeaker(dialogue: string): string {
  return dialogue
    .replace(/^\s*[A-Za-zÀ-ỹ][\w .'-]{0,40}:\s*/, "")
    .replace(/^"|"$/g, "")
    .trim();
}

function zipToFiles(entries: ZipEntry[]): { path: string; source: AssetSource }[] {
  return entries
    .filter((e) => !e.isDirectory)
    .map((e) => ({ path: e.path, source: { label: e.path, read: e.read } }));
}

/**
 * Read an import source without creating anything.
 *
 * Free, side-effect free and safe to run on a file the operator has not looked
 * at yet: nothing is written, nothing is extracted to disk, and an unsafe entry
 * is refused while it is still just a name in a table.
 */
export function scanImportSource(target: string): ScanResult {
  const label = path.basename(target);
  if (!fs.existsSync(target)) {
    return {
      videos: [],
      issues: [issue("error", "source_missing", `Không tìm thấy "${target}".`)],
      sourceKind: "file",
      sourceLabel: label,
    };
  }

  const stat = fs.statSync(target);
  let files: { path: string; source: AssetSource }[];
  let sourceKind: ScanResult["sourceKind"];
  const issues: ImportIssue[] = [];

  if (stat.isDirectory()) {
    sourceKind = "folder";
    files = walkFolder(target);
  } else if (target.toLowerCase().endsWith(".zip")) {
    sourceKind = "zip";
    try {
      const listing = readZipFile(target);
      for (const r of listing.rejected) {
        issues.push(
          issue("error", "zip_entry_rejected", `ZIP: bỏ "${r.path}" — ${r.reason}.`, {
            sourceFile: r.path,
          }),
        );
      }
      files = zipToFiles(listing.entries);
    } catch (e) {
      const code = e instanceof ZipError ? e.code : "zip_unreadable";
      return {
        videos: [],
        issues: [issue("error", code, e instanceof Error ? e.message : String(e))],
        sourceKind: "zip",
        sourceLabel: label,
      };
    }
  } else {
    sourceKind = "file";
    files = [
      {
        path: path.basename(target),
        source: { label: path.basename(target), read: () => fs.readFileSync(target) },
      },
    ];
    // A lone storyboard may still have its images beside it.
    for (const sibling of walkFolder(path.dirname(target))) {
      if (sibling.path !== path.basename(target) && hasAllowedImageExtension(sibling.path)) {
        files.push(sibling);
      }
    }
  }

  const byPath = new Map(files.map((f) => [f.path, f.source]));
  const storyboardPaths = files.map((f) => f.path).filter(isStoryboardFile);
  if (storyboardPaths.length === 0) {
    issues.push(
      issue(
        "error",
        "no_storyboard_found",
        "Không tìm thấy file storyboard (.json hoặc .csv) nào trong nguồn nhập.",
      ),
    );
    return { videos: [], issues, sourceKind, sourceLabel: label };
  }

  const groups = groupByStoryboard(files);
  const videos: ScannedVideo[] = [];

  for (const [dir, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (group.storyboards.length === 0) continue;
    if (group.storyboards.length > 1) {
      issues.push(
        issue(
          "error",
          "multiple_storyboards",
          `Thư mục "${dir}" có ${group.storyboards.length} file storyboard. Mỗi thư mục chỉ được một.`,
          { sourceFile: dir },
        ),
      );
      continue;
    }
    const file = group.storyboards[0]!;
    const folderName = dir === "." || dir === "" ? path.parse(label).name : path.posix.basename(dir);
    let content: string;
    try {
      content = byPath.get(file)!.read().toString("utf8");
    } catch (e) {
      issues.push(
        issue("error", "storyboard_unreadable", `Không đọc được "${file}": ${String(e)}`, {
          sourceFile: file,
        }),
      );
      continue;
    }

    const parsed = parseStoryboardFile(path.posix.basename(file), content, {
      sourceFile: file,
      fallbackVideoId: folderName,
      fallbackVideoTitle: folderName,
    });
    issues.push(...parsed.issues);
    for (const video of parsed.videos) {
      videos.push({ video, assets: group.assets });
    }
  }

  // Two folders naming the same video_id would collide on one project.
  const seen = new Map<string, number>();
  for (const v of videos) seen.set(v.video.videoId, (seen.get(v.video.videoId) ?? 0) + 1);
  for (const [id, count] of seen) {
    if (count > 1) {
      issues.push(
        issue("error", "video_id_duplicate", `video_id "${id}" xuất hiện ở ${count} storyboard khác nhau.`, {
          videoId: id,
        }),
      );
    }
  }

  return { videos, issues, sourceKind, sourceLabel: label };
}

// ----------------------------------------------------------- validation ---

export interface ResolvedScene {
  scene: StoryboardScene;
  /** Set when the storyboard supplied a keyframe that was found. */
  asset: AssetSource | null;
  complexity: Complexity;
  priority: "LOW" | "NORMAL" | "HIGH";
}

export interface ResolvedCharacter extends StoryboardCharacter {
  /** The reference image, once found in the folder or archive. */
  asset: AssetSource | null;
  /**
   * Identity readiness AFTER this import would land, not before it.
   *
   * The question an operator needs answered is "will this person be drawable
   * consistently once I press go", and the storyboard's own reference image
   * counts towards that. Reporting the character table's state alone would say
   * NEEDS_CHARACTER_REFERENCE about a character whose reference is sitting in
   * the folder being imported. See QĐ-070.
   */
  readiness: CharacterReadiness;
  /** Core descriptive fields still unstated, as labels. Advice, not a blocker. */
  missingFields: string[];
  /** Lockable attributes with no value, so the prompt will not claim to lock them. */
  unlockedAttributes: string[];
  /** True when this name already existed in the character table. */
  existing: boolean;
  /** The existing row's id, so the UI can edit it without a second lookup. */
  characterRowId: string | null;
  /** Reference images this character will have once the import lands. */
  referenceCount: number;
}

export interface ResolvedVideo {
  videoId: string;
  title: string;
  sourceFile: string;
  characters: ResolvedCharacter[];
  scenes: ResolvedScene[];
  suppliedImages: number;
  missingImages: number;
  localMotionScenes: number;
  videoAiScenes: number;
  autoScenes: number;
}

export interface ValidationResult {
  videos: ResolvedVideo[];
  issues: ImportIssue[];
}

/**
 * Everything that needs the database or the asset list to answer.
 *
 * Pins are checked here rather than at parse time because "does this model
 * exist and may it be used" is a question about the registry, and the registry
 * moves. A pin to a DEPRECATED or DISABLED model is refused outright: the
 * routing rules already say the router will not choose one, and an import that
 * quietly pinned past that would be a way around a rule this project paid to
 * learn.
 */
export async function validateImport(scan: ScanResult): Promise<ValidationResult> {
  const issues: ImportIssue[] = [...scan.issues];
  const videos: ResolvedVideo[] = [];

  const models = await prisma.modelRegistry.findMany({ where: { type: "video" } });
  const byKey = new Map(models.map((m) => [`${m.provider}/${m.modelId}`, m]));

  for (const { video, assets } of scan.videos) {
    const resolved: ResolvedScene[] = [];
    let supplied = 0;
    let missing = 0;

    const cast: ResolvedCharacter[] = [];
    for (const character of video.characters) {
      let asset: AssetSource | null = null;
      if (character.referenceImage !== null) {
        const key = character.referenceImage.toLowerCase();
        asset = assets.get(key) ?? assets.get(path.posix.basename(key)) ?? null;
        if (asset === null) {
          issues.push(
            issue(
              "error",
              "character_reference_missing",
              `Không tìm thấy ảnh tham chiếu "${character.referenceImage}" của nhân vật ` +
                `"${character.name}".`,
              { videoId: video.videoId, sourceFile: video.sourceFile },
            ),
          );
        }
      }

      // A name is not an identity. `Character` rows are matched by name and
      // reused, so this reports the row that will actually be used - including
      // one a previous import created with nothing but a name in it.
      //
      // Matched case-insensitively, because "max" and "Max" are one person and
      // a second row would give them two different faces. SQLite compares
      // strings with a BINARY collation, so `findUnique({ name })` does not do
      // this on its own.
      const existing = await findCharacterByName(character.name);
      if (existing && existing.name !== character.name) {
        issues.push(
          issue(
            "warning",
            "character_name_case",
            `Storyboard viết "${character.name}", bảng Nhân vật đang có ` +
              `"${existing.name}". Dùng lại nhân vật đã có chứ KHÔNG tạo người thứ hai.`,
            { videoId: video.videoId, sourceFile: video.sourceFile },
          ),
        );
      }
      const references = existing
        ? await prisma.characterReference.count({ where: { characterId: existing.id } })
        : 0;

      // For a character that does not exist yet, the row that WILL exist is the
      // one built from the storyboard's Bible below - so that is what gets
      // checked. Judging a new character against an empty row would report
      // every field missing on a storyboard that in fact stated them all.
      const row = existing ?? {
        id: "",
        name: character.name,
        version: 1,
        visualPrompt: "",
        negativePrompt: "",
        seed: null,
        presentation: character.bible.presentation,
        approximateAge: character.bible.approximateAge,
        skinTone: character.bible.skinTone,
        hair: character.bible.hair,
        facialFeatures: character.bible.face,
        distinguishingFeatures: character.bible.distinguishingFeatures,
        outfit: character.bible.outfit,
        bodyProportions: character.bible.bodyProportions,
        accessories: character.bible.accessories,
        colorPalette: character.bible.colorPalette,
        negativeIdentity: character.bible.negativeIdentity,
      };
      const missingFields = missingBibleFields(row);
      const readiness = characterReadiness({
        // The storyboard's own image counts: after `materialiseImport` it
        // becomes the reference for a character that had none.
        hasReference: references > 0 || asset !== null,
        hasAnyDescriptiveField: hasAnyDescriptiveField(row),
      });

      if (readiness === "NEEDS_CHARACTER_REFERENCE") {
        issues.push(
          issue(
            "warning",
            "character_needs_reference",
            `Nhân vật "${character.name}" chưa có ảnh tham chiếu và storyboard cũng ` +
              `không kèm ảnh. Hệ thống KHÔNG tự tạo ảnh nhân vật: hãy tải ảnh lên ở ` +
              `trang Nhân vật (hoặc ngay trên trang Nhập), hoặc thêm ` +
              `character_reference_image vào storyboard. Thiếu ảnh thì mỗi cảnh sẽ vẽ ` +
              `một người khác nhau.`,
            { videoId: video.videoId, sourceFile: video.sourceFile },
          ),
        );
      } else if (readiness === "NEEDS_IDENTITY_FIELDS") {
        issues.push(
          issue(
            "warning",
            "character_identity_thin",
            `Nhân vật "${character.name}" có ảnh tham chiếu nhưng KHÔNG có một chữ nào ` +
              `mô tả ngoại hình. Cảnh nào không gửi kèm được ảnh sẽ không còn gì để ` +
              `bám. Điền ít nhất một trong: tóc, khuôn mặt, trang phục, dáng người.`,
            { videoId: video.videoId, sourceFile: video.sourceFile },
          ),
        );
      } else if (missingFields.length > 0) {
        // READY, and still worth saying. Never an error and never a blocker:
        // "chưa đầy đủ" is advice about robustness, not a refusal to proceed.
        issues.push(
          issue(
            "warning",
            "character_identity_incomplete",
            `Nhân vật "${character.name}" chạy được, nhưng hồ sơ nhận dạng chưa đầy ` +
              `đủ — chưa khai: ${missingFields.join(", ")}. Ảnh tham chiếu đang gánh ` +
              `phần còn thiếu.`,
            { videoId: video.videoId, sourceFile: video.sourceFile },
          ),
        );
      }

      cast.push({
        ...character,
        asset,
        readiness,
        missingFields,
        unlockedAttributes: unlockedAttributes(row),
        existing: existing !== null,
        characterRowId: existing?.id ?? null,
        referenceCount: references + (asset !== null && references === 0 ? 1 : 0),
      });
    }
    // A scene may name a character the video never declared at the top. That is
    // an IMPLICIT declaration, not an error: `collectCharacters` has already
    // folded those ids into the cast, so the same id in six scenes is still one
    // character with one reference - which is the only property that matters.

    for (const scene of video.scenes) {
      const at = {
        videoId: video.videoId,
        sceneNumber: scene.sceneNumber,
        sourceFile: video.sourceFile,
      };

      let asset: AssetSource | null = null;
      if (scene.imageFile) {
        // Re-checked here even though the parser checked it: this is the layer
        // that turns a name into a file, so it is the layer that must refuse.
        if (!isSafeRelativePath(scene.imageFile)) {
          issues.push(
            issue("error", "image_path_unsafe", `image_file "${scene.imageFile}" không an toàn.`, at),
          );
          continue;
        }
        const key = scene.imageFile.toLowerCase();
        asset = assets.get(key) ?? assets.get(path.posix.basename(key)) ?? null;
        if (asset === null) {
          missing += 1;
          issues.push(
            issue(
              "error",
              "image_missing",
              `Không tìm thấy ảnh "${scene.imageFile}" trong nguồn nhập.`,
              at,
            ),
          );
        } else {
          supplied += 1;
        }
      } else {
        missing += 1;
        issues.push(
          issue(
            "warning",
            "image_will_be_generated",
            "Cảnh không có image_file nên keyframe sẽ được tạo bằng Image AI (có tính phí) sau khi bạn duyệt.",
            at,
          ),
        );
      }

      if (scene.videoProvider && scene.videoModel) {
        const key = `${scene.videoProvider}/${scene.videoModel}`;
        const model = byKey.get(key);
        if (!model) {
          issues.push(
            issue("error", "pin_model_unknown", `Không có model video "${key}" trong bảng Mô hình AI.`, at),
          );
          continue;
        }
        if (!model.enabled || model.lifecycle === "DISABLED") {
          issues.push(
            issue("error", "pin_model_disabled", `Model "${key}" đang bị TẮT, không thể ghim.`, at),
          );
          continue;
        }
        if (model.lifecycle === "DEPRECATED") {
          issues.push(
            issue(
              "error",
              "pin_model_deprecated",
              `Model "${key}" đang NGỪNG DÙNG${model.shutdownDate ? ` (nhà cung cấp tắt ${model.shutdownDate.toISOString().slice(0, 10)})` : ""}. ` +
                "Không nhận ghim vào model này.",
              at,
            ),
          );
          continue;
        }
        if (model.reliability && model.reliability !== "OK") {
          issues.push(
            issue(
              "warning",
              "pin_model_degraded",
              `Model "${key}" đang ở trạng thái ${model.reliability}. Ghim vẫn được tôn trọng, nhưng nó đã từng hỏng.`,
              at,
            ),
          );
        }
      }

      const classified = classifyScene({
        duration: scene.duration,
        visualDescription: scene.visualDescription,
        characterAction: scene.characterAction,
        camera: scene.camera,
        characters: [],
      });
      resolved.push({
        scene,
        asset,
        complexity: classified.complexity,
        priority: scene.priority,
      });
    }

    videos.push({
      videoId: video.videoId,
      title: video.videoTitle || video.videoId,
      sourceFile: video.sourceFile,
      characters: cast,
      scenes: resolved,
      suppliedImages: supplied,
      missingImages: missing,
      localMotionScenes: resolved.filter((s) => s.scene.motionMode === "LOCAL_MOTION").length,
      videoAiScenes: resolved.filter((s) => s.scene.motionMode === "VIDEO_AI").length,
      autoScenes: resolved.filter((s) => s.scene.motionMode === "AUTO").length,
    });
  }

  return { videos, issues };
}

// --------------------------------------------------------- materialising ---

export interface MaterialiseOptions {
  batchName: string;
  qualityMode?: string;
  stylePresetId?: string | null;
  targetDuration?: number;
  /** Per-video ceiling. Enforced by the existing batch machinery, not here. */
  maxCostPerVideo: number;
  /** Ceiling for the whole import. Written onto the batch, approved later. */
  maxCostForBatch: number;
  /**
   * Import the videos that are clean and skip the ones that are not.
   *
   * Off by default, so nothing starts importing a subset of what it was given
   * without a caller having asked for that.
   */
  allowPartial?: boolean;
}

export interface MaterialiseResult {
  batchId: string;
  projects: { projectId: string; videoId: string; title: string; scenes: number }[];
  copiedImages: number;
  /**
   * Character reference images that were already held, byte for byte.
   *
   * Counted separately from `copiedImages` so re-importing the same storyboard
   * shows as reuse rather than silently growing the reference list. QĐ-072.
   */
  reusedCharacterImages: number;
  /** Videos left out because they still had errors, each with its reasons. */
  skipped: { videoId: string; title: string; reasons: string[] }[];
}

/**
 * Create the rows: one Batch, one Project per video, one Scene per row.
 *
 * Costs nothing and authorises nothing. The batch is left `PLANNED` with a
 * `DRAFT` authorisation, which is the state V1 uses for exactly the same
 * reason: DRAFT permits no spending at all, so an import can be inspected,
 * re-priced and thrown away without a single paid call being possible.
 */
export async function materialiseImport(
  validated: ValidationResult,
  opts: MaterialiseOptions,
): Promise<MaterialiseResult> {
  // ONE BAD VIDEO IS ONE BAD VIDEO, not a bad batch.
  //
  // This used to refuse the whole import if any video had an error, which is
  // the wrong shape for the thing being imported: a folder of three storyboards
  // is three pieces of work that happen to be approved together, and a typo in
  // the third is no reason to throw away the first two. The operator then has
  // to fix the typo and re-import everything, and re-importing is exactly when
  // duplicates get made.
  //
  // Skipped, never silent: every skipped video is named, with its own errors,
  // in `skipped`. `allowPartial` is off by default so no existing caller starts
  // importing less than it asked for without saying so. See QĐ-073.
  const errorsByVideo = new Map<string, ImportIssue[]>();
  for (const issue of validated.issues) {
    if (issue.level !== "error") continue;
    const key = issue.videoId ?? "";
    errorsByVideo.set(key, [...(errorsByVideo.get(key) ?? []), issue]);
  }
  // An error with no video attached belongs to the SOURCE - an unreadable ZIP
  // entry, a missing folder - and there is no subset of the import that
  // survives it.
  const sourceErrors = errorsByVideo.get("") ?? [];
  if (sourceErrors.length > 0) {
    throw new Error(
      `Không thể tạo lô: nguồn nhập có lỗi không thuộc về video nào — ` +
        `${sourceErrors[0]!.message}`,
    );
  }

  const skipped: MaterialiseResult["skipped"] = [];
  const importable = validated.videos.filter((v) => {
    const errors = errorsByVideo.get(v.videoId) ?? [];
    if (errors.length === 0) return true;
    skipped.push({
      videoId: v.videoId,
      title: v.title,
      reasons: errors.map((e) => e.message),
    });
    return false;
  });

  if (skipped.length > 0 && !opts.allowPartial) {
    throw new Error(
      `Không thể tạo lô: ${skipped.length} video còn lỗi ` +
        `(${skipped.map((v) => v.title).join(", ")}). Hãy sửa hết lỗi rồi nhập lại, ` +
        `hoặc bật "nhập phần chạy được" để bỏ qua các video hỏng.`,
    );
  }
  if (importable.length === 0) {
    throw new Error("Không có video nào để nhập.");
  }

  const batch = await prisma.batch.create({
    data: {
      name: opts.batchName,
      amount: importable.length,
      qualityMode: opts.qualityMode ?? "BALANCED",
      stylePresetId: opts.stylePresetId ?? null,
      targetDuration: opts.targetDuration ?? 25,
      status: "PLANNED",
      maxBudget: opts.maxCostForBatch,
      maxCostPerVideo: opts.maxCostPerVideo,
      idiomIdsJson: "[]",
      planJson: "{}",
    },
  });

  const projects: MaterialiseResult["projects"] = [];
  let copiedImages = 0;
  let reusedCharacterImages = 0;

  for (const video of importable) {
    // An imported video is not an idiom, but `Project.idiomId` is required and
    // the library is what gives a project a title everywhere else in the app.
    // One row per imported video, keyed by a slug that makes re-importing the
    // same storyboard reuse it rather than pile up duplicates.
    //
    // ## Why these fields are filled rather than left empty
    //
    // The first version wrote empty strings here, on the reasoning that an
    // imported video never needs a script so nobody would read them. That was
    // wrong, and the e2e suite caught it: the idiom LIBRARY is shared, any V1
    // flow may pick a row out of it, and `ScriptSchema` requires `meaning` and
    // `exampleSentence` to be non-empty. An imported row with blanks is a mine
    // in a table other code walks through - it does not fail at import, it
    // fails later, in a V1 batch that has nothing to do with the import.
    //
    // So: a row this module writes must be a row the rest of the app can use.
    // The text is derived from the storyboard rather than invented, and
    // `status` keeps it out of the library picker in the ordinary case.
    const slug = `import-${video.videoId}`.toLowerCase().slice(0, 120);
    const firstLine =
      video.scenes.map((s) => stripSpeaker(s.scene.dialogue)).find((t) => t.length > 0) ??
      video.scenes.map((s) => s.scene.subtitle.trim()).find((t) => t.length > 0) ??
      video.title;
    const idiom = await prisma.idiom.upsert({
      where: { slug },
      update: { phrase: video.title },
      create: {
        phrase: video.title,
        slug,
        meaning: `Storyboard nhập sẵn: ${video.title}`,
        literalMeaning: video.title,
        exampleSentence: firstLine.slice(0, 500),
        category: "Imported",
        notes: `Nhập từ storyboard ${video.sourceFile}`,
        // Not "unused" and not "planned": those are the two states the V1
        // library picker selects from, and an imported storyboard is not a
        // prompt for a new video - it IS the video.
        status: "imported",
      },
    });

    const project = await prisma.project.create({
      data: {
        idiomId: idiom.id,
        batchId: batch.id,
        title: video.title,
        // The script already exists, so the project starts where V1's project
        // arrives AFTER paying a text model. Nothing will ask for one.
        status: "script_ready",
        qualityMode: opts.qualityMode ?? "BALANCED",
        stylePresetId: opts.stylePresetId ?? null,
        targetDuration: opts.targetDuration ?? 25,
        maxBudget: opts.maxCostPerVideo,
        scriptJson: JSON.stringify({
          source: "IMPORT",
          videoId: video.videoId,
          sourceFile: video.sourceFile,
          scenes: video.scenes.map((s) => s.scene),
        }),
      },
    });

    // ---- cast, before any scene refers to one ----
    //
    // The app already has the whole character-consistency machine: canonical
    // sheets, LOCKED_ATTRIBUTES, approved master references, the "keep X
    // identical to the reference" clause. Import does not rebuild any of it -
    // it fills in `charactersPresentJson` so that machine engages, and creates
    // a Character row only when the name is new.
    //
    // An existing character is REUSED, never overwritten. A storyboard naming
    // "Max" means the Max this project already has; letting an import rewrite
    // his canonical description would silently redraw him in every older video
    // that is regenerated afterwards.
    const castByStoryboardId = new Map<string, string>();
    for (const character of video.characters) {
      // Case-insensitive, so importing "max" twice does not end up as two
      // people with two faces. QĐ-072.
      const existing = await findCharacterByName(character.name);
      const row =
        existing ??
        (await prisma.character.create({
          data: {
            name: character.name,
            description: `Nhân vật nhập từ storyboard ${video.videoId}.`,
            personality: "",
            // Minimal but never empty: an empty visualPrompt would put a blank
            // where every image prompt expects the canonical description.
            visualPrompt: `${character.name}, consistent character design across every scene`,
            // The Bible, exactly as the storyboard stated it - and no further.
            // Anything the file left blank stays blank rather than being filled
            // with a plausible guess: a guess here is pasted into every prompt
            // for the rest of this character's life, and nobody would know it
            // was invented. The blanks are what `character_identity_thin`
            // reports. See QĐ-070.
            presentation: character.bible.presentation,
            approximateAge: character.bible.approximateAge,
            skinTone: character.bible.skinTone,
            hair: character.bible.hair,
            facialFeatures: character.bible.face,
            distinguishingFeatures: character.bible.distinguishingFeatures,
            outfit: character.bible.outfit,
            bodyProportions: character.bible.bodyProportions,
            accessories: character.bible.accessories,
            colorPalette: character.bible.colorPalette,
            negativeIdentity: character.bible.negativeIdentity,
            notes: `Nhập từ ${video.sourceFile}`,
            enabled: true,
          },
        }));
      castByStoryboardId.set(character.characterId, row.name);

      if (character.asset) {
        const bytes = character.asset.read();
        // THE SAME PICTURE IS THE SAME REFERENCE.
        //
        // Re-importing a storyboard used to copy its reference image again and
        // write a second row pointing at a byte-identical file. Harmless-looking
        // and not: the reference list grows on every import, the provider's
        // reference cap starts spending slots on duplicates of one picture, and
        // "which image is this character?" stops having one answer. Keyed on the
        // CONTENT, because the filename inside an archive is not an identity.
        // See QĐ-072.
        const digest = sha256Bytes(bytes);
        const existingRefs = await prisma.characterReference.findMany({
          where: { characterId: row.id },
        });
        const duplicate = existingRefs.find((r) => {
          try {
            return sha256Bytes(fs.readFileSync(toAbsolute(r.filePath))) === digest;
          } catch {
            // A row whose file is gone cannot be the duplicate we would reuse.
            return false;
          }
        });

        if (duplicate) {
          reusedCharacterImages += 1;
        } else {
          const destination = path.join(
            DIRS.characters,
            `${row.id}-${uuidFilename(path.extname(character.asset.label) || ".png")}`,
          );
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, bytes);
          await prisma.characterReference.create({
            data: {
              characterId: row.id,
              filePath: toRelative(destination),
              source: "upload",
              // Only promoted to the master when the character has none. An
              // import must not demote a reference a human already approved.
              isPrimary: existingRefs.length === 0,
              approved: existingRefs.length === 0,
              notes: `Ảnh tham chiếu nhập từ storyboard ${video.videoId}`,
            },
          });
          copiedImages += 1;
        }
      }
    }
    const castNames = [...new Set(castByStoryboardId.values())];

    const totalScenes = video.scenes.length;
    let startSeconds = 0;
    for (const resolved of video.scenes) {
      const { scene } = resolved;
      const priority =
        scene.priority ??
        assignSpendPriority({
          sceneNumber: scene.sceneNumber,
          totalScenes,
          startSeconds,
          complexity: resolved.complexity,
        }).priority;

      let imagePath: string | null = null;
      if (resolved.asset) {
        const destination = path.join(
          projectSubdir(project.id, "images"),
          uuidFilename(path.extname(resolved.asset.label) || ".png"),
        );
        fs.writeFileSync(destination, resolved.asset.read());
        imagePath = toRelative(destination);
        copiedImages += 1;
      }

      await prisma.scene.create({
        data: {
          projectId: project.id,
          sceneNumber: scene.sceneNumber,
          duration: scene.duration,
          visualDescription: scene.visualDescription,
          dialogue: scene.dialogue,
          narration: scene.narration,
          subtitle: scene.subtitle,
          camera: scene.camera,
          characterAction: scene.characterAction,
          // Composed from the storyboard's own fields; see `deriveVideoPrompt`.
          videoPrompt: scene.videoPrompt,
          // Who is in frame drives the image prompt and the reference images.
          // A scene naming a character uses that one; a scene naming none uses
          // the video's whole declared cast, which is what keeps a six-scene
          // video from quietly changing who it is about.
          charactersPresentJson: JSON.stringify(
            scene.characterId !== null
              ? [castByStoryboardId.get(scene.characterId)].filter(Boolean)
              : castNames,
          ),
          primaryCharactersJson: JSON.stringify(
            scene.characterId !== null
              ? [castByStoryboardId.get(scene.characterId)].filter(Boolean)
              : castNames.slice(0, 1),
          ),
          // Narration counts as speech.
          //
          // `parseDialogueLines` reads narration only when the scene has a
          // speaking character to read it - "narration has no speaker, and the
          // first speaking character reads it only because someone has to". An
          // empty list therefore does not mean "narrate anonymously", it means
          // the narration is silently dropped, and a scene that had words in it
          // renders mute.
          speakingCharactersJson: JSON.stringify(
            scene.dialogue.trim().length > 0 || scene.narration.trim().length > 0
              ? scene.characterId !== null
                ? [castByStoryboardId.get(scene.characterId)].filter(Boolean)
                : castNames.slice(0, 1)
              : [],
          ),
          complexity: resolved.complexity,
          spendPriority: priority,
          // AUTO leaves the decision to the planner, exactly as V1 does. The
          // other two are instructions and are written down as such.
          motionMode: scene.motionMode,
          motionSource: scene.motionMode === "LOCAL_MOTION" ? "LOCAL_MOTION" : "AI_VIDEO",
          videoProvider: scene.videoProvider,
          videoModel: scene.videoModel,
          // A model named in the storyboard file is a person's instruction, and
          // the importer is the only moment it can be recorded as one: after the
          // first clip, these two columns hold whatever the router used. See
          // QĐ-069.
          videoModelPinned: Boolean(scene.videoProvider && scene.videoModel),
          imagePath,
          imageSource: imagePath ? "IMPORTED" : "GENERATED",
          status: imagePath ? "image_ready" : "pending",
        },
      });
      startSeconds += scene.duration;
    }

    projects.push({
      projectId: project.id,
      videoId: video.videoId,
      title: video.title,
      scenes: video.scenes.length,
    });
  }

  // DRAFT: the authorisation exists so the batch page has something to show,
  // and it permits nothing until the operator approves an amount.
  await prisma.batchAuthorization.create({
    data: {
      batchId: batch.id,
      status: "DRAFT",
      authorizedMaxSpend: 0,
      estimatedCost: 0,
    },
  });

  await logger.info({
    event: "import.materialised",
    message:
      `Đã nhập ${projects.length} video (${projects.reduce((n, p) => n + p.scenes, 0)} cảnh, ` +
      `${copiedImages} ảnh có sẵn, ${reusedCharacterImages} ảnh nhân vật dùng lại) ` +
      `vào lô ${batch.id}. Chưa cấp phép chi gì.`,
  });

  return { batchId: batch.id, projects, copiedImages, reusedCharacterImages, skipped };
}
