"use server";

import path from "node:path";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
  deriveVideoPrompt,
  hasErrors,
  promptHasMotionContent,
  MAX_SCENE_DURATION,
  MIN_SCENE_DURATION,
  type ImportIssue,
} from "@/domain/storyboard";
import {
  materialiseImport,
  scanImportSource,
  validateImport,
} from "@/services/storyboard-import";
import { preflightImportedBatch, type ImportPreflight } from "@/services/import-preflight";
import {
  applySheetEdit,
  findCharacterByName,
  getCharacterSheet,
} from "@/services/character-service";
import {
  approveCharacterReference,
  uploadCharacterReference,
} from "@/services/character-master";
import { sceneCharacters } from "@/domain/scene-characters";

/**
 * Server actions for the storyboard import screen.
 *
 * ## Why a path rather than an upload
 *
 * This app runs on the operator's own machine, beside the folders the
 * storyboards and keyframes already live in. Asking the browser to upload a
 * 200MB folder so the server can write it back to disk two directories away
 * would add a copy, a temp-file lifecycle and an upload limit, and buy nothing.
 * A path is read directly - and every unsafe entry inside it is still refused
 * by `scanImportSource`, because the danger was never the transport.
 *
 * ## None of these can spend
 *
 * Validate and estimate are reads. Create writes rows and leaves the batch
 * `PLANNED` with a `DRAFT` authorisation, which permits nothing. Approving an
 * amount happens on the batch page, through the same gate a V1 batch uses -
 * there is deliberately no "import and run" button.
 */

export interface ImportValidationView {
  ok: boolean;
  sourceKind: string;
  sourceLabel: string;
  videos: {
    videoId: string;
    title: string;
    sceneCount: number;
    suppliedImages: number;
    missingImages: number;
    localMotion: number;
    videoAi: number;
    auto: number;
    scenes: {
      sceneNumber: number;
      duration: number;
      motionMode: string;
      complexity: string;
      priority: string;
      keyframe: string;
      pin: string | null;
      visual: string;
      dialogue: string;
    }[];
  }[];
  issues: ImportIssue[];
  errorCount: number;
  warningCount: number;
}

export async function validateStoryboardSource(
  source: string,
): Promise<ImportValidationView> {
  const scan = scanImportSource(path.resolve(source.trim()));
  const validated = await validateImport(scan);

  return {
    ok: !hasErrors(validated.issues) && validated.videos.length > 0,
    sourceKind: scan.sourceKind,
    sourceLabel: scan.sourceLabel,
    videos: validated.videos.map((v) => ({
      videoId: v.videoId,
      title: v.title,
      sceneCount: v.scenes.length,
      suppliedImages: v.suppliedImages,
      missingImages: v.missingImages,
      localMotion: v.localMotionScenes,
      videoAi: v.videoAiScenes,
      auto: v.autoScenes,
      scenes: v.scenes.map((s) => ({
        sceneNumber: s.scene.sceneNumber,
        duration: s.scene.duration,
        motionMode: s.scene.motionMode,
        complexity: s.complexity,
        priority: s.priority,
        keyframe: s.asset ? "có sẵn" : "sẽ tạo",
        pin:
          s.scene.videoProvider && s.scene.videoModel
            ? `${s.scene.videoProvider}/${s.scene.videoModel}`
            : null,
        visual: s.scene.visualDescription,
        dialogue: s.scene.dialogue,
      })),
    })),
    issues: validated.issues,
    errorCount: validated.issues.filter((i) => i.level === "error").length,
    warningCount: validated.issues.filter((i) => i.level === "warning").length,
  };
}

export interface CreateImportResult {
  ok: boolean;
  message: string;
  batchId?: string;
  preflight?: ImportPreflight;
  /** Videos left out because they still had errors. Named, never silent. */
  skipped?: { videoId: string; title: string; reasons: string[] }[];
}

/**
 * Create the batch and price it. Still authorises nothing.
 *
 * The two halves are one call because a batch with rows but no plan is a state
 * the batch page cannot show honestly - it would display a video list beside an
 * empty estimate, which reads as "free".
 */
export async function createImportBatch(input: {
  source: string;
  name: string;
  maxCostPerVideo: number;
  maxCostForBatch: number;
  /** Import the clean videos and skip the broken ones, naming each skip. */
  allowPartial?: boolean;
}): Promise<CreateImportResult> {
  try {
    const scan = scanImportSource(path.resolve(input.source.trim()));
    const validated = await validateImport(scan);
    if (hasErrors(validated.issues) && !input.allowPartial) {
      return {
        ok: false,
        message:
          `Còn ${validated.issues.filter((i) => i.level === "error").length} lỗi trong bản nhập. ` +
          "Hãy sửa hết rồi nhập lại — hoặc bật “nhập phần chạy được” để bỏ qua video hỏng.",
      };
    }
    if (validated.videos.length === 0) {
      return { ok: false, message: "Không tìm thấy storyboard nào trong nguồn nhập." };
    }
    if (!(input.maxCostPerVideo > 0) || !(input.maxCostForBatch > 0)) {
      return {
        ok: false,
        message: "Phải nhập trần chi cho mỗi video và cho cả lô, cả hai đều lớn hơn 0.",
      };
    }

    const created = await materialiseImport(validated, {
      batchName: input.name.trim() || "Lô nhập storyboard",
      maxCostPerVideo: input.maxCostPerVideo,
      maxCostForBatch: input.maxCostForBatch,
      allowPartial: input.allowPartial === true,
    });
    const preflight = await preflightImportedBatch(created.batchId);

    revalidatePath("/batches");
    revalidatePath("/import");
    return {
      ok: true,
      batchId: created.batchId,
      preflight,
      skipped: created.skipped,
      message:
        `Đã tạo lô ${created.projects.length} video, chép ${created.copiedImages} ảnh có sẵn` +
        (created.reusedCharacterImages > 0
          ? `, dùng lại ${created.reusedCharacterImages} ảnh nhân vật`
          : "") +
        (created.skipped.length > 0
          ? `. BỎ QUA ${created.skipped.length} video còn lỗi: ` +
            created.skipped.map((v) => `${v.title} (${v.reasons[0]})`).join("; ")
          : "") +
        ". Quyền chi đang DRAFT — chưa tiêu được gì. Mở trang lô để duyệt.",
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Every field of an imported scene the editor can show and change. */
export interface ImportedSceneRow {
  sceneId: string;
  sceneNumber: number;
  duration: number;
  narration: string;
  dialogue: string;
  visualDescription: string;
  characterAction: string;
  camera: string;
  subtitle: string;
  motionMode: string;
  priority: string;
  videoProvider: string | null;
  videoModel: string | null;
  videoPrompt: string;
  keyframe: string;
  /** True once a provider request exists for it, which freezes the row. */
  locked: boolean;
}

export async function importedScenes(batchId: string): Promise<
  { projectId: string; title: string; scenes: ImportedSceneRow[] }[]
> {
  const projects = await prisma.project.findMany({
    where: { batchId },
    orderBy: { createdAt: "asc" },
    include: { scenes: { where: { skipped: false }, orderBy: { sceneNumber: "asc" } } },
  });
  const out = [];
  for (const project of projects) {
    const rows: ImportedSceneRow[] = [];
    for (const scene of project.scenes) {
      rows.push({
        sceneId: scene.id,
        sceneNumber: scene.sceneNumber,
        duration: scene.duration,
        narration: scene.narration,
        dialogue: scene.dialogue,
        visualDescription: scene.visualDescription,
        characterAction: scene.characterAction,
        camera: scene.camera,
        subtitle: scene.subtitle,
        motionMode: scene.motionMode,
        priority: scene.spendPriority,
        videoProvider: scene.videoProvider,
        videoModel: scene.videoModel,
        videoPrompt: scene.videoPrompt,
        keyframe: scene.imageSource === "IMPORTED" ? "có sẵn" : "sẽ tạo",
        locked: (await prisma.providerJob.count({ where: { sceneId: scene.id } })) > 0,
      });
    }
    out.push({ projectId: project.id, title: project.title, scenes: rows });
  }
  return out;
}

/** Re-price an imported batch after the operator edited a scene. */
export async function reestimateImportBatch(
  batchId: string,
): Promise<{ ok: boolean; message: string; preflight?: ImportPreflight }> {
  try {
    const preflight = await preflightImportedBatch(batchId);
    revalidatePath(`/batches/${batchId}`);
    return { ok: true, message: "Đã dự toán lại.", preflight };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Edit one imported scene, before anything has been bought.
 *
 * Covers everything a storyboard row carries: the text, the timing, the motion
 * mode, the pin and the priority. An import is the one flow where the operator
 * is expected to arrive with the content already written, look at what it will
 * cost, and change their mind about it - so the editor has to reach the same
 * fields the file does, or the answer to "that scene is too long" becomes
 * "re-export the spreadsheet and import it again".
 *
 * Two things are re-derived rather than asked for, because they are derived
 * everywhere else too: the video prompt (from the visual, the action and the
 * camera) and who speaks (from whether there are any words). And the frozen
 * estimate is thrown away, so the next approval is signed against the video
 * that now exists rather than the one that was imported.
 */
export async function updateImportedScene(input: {
  sceneId: string;
  duration?: number;
  narration?: string;
  dialogue?: string;
  visualDescription?: string;
  characterAction?: string;
  camera?: string;
  subtitle?: string;
  motionMode?: "AUTO" | "LOCAL_MOTION" | "VIDEO_AI";
  videoProvider?: string | null;
  videoModel?: string | null;
  priority?: "LOW" | "NORMAL" | "HIGH";
}): Promise<{ ok: boolean; message: string }> {
  const scene = await prisma.scene.findUnique({
    where: { id: input.sceneId },
    include: { project: { include: { batch: { include: { authorization: true } } } } },
  });
  if (!scene) return { ok: false, message: "Không tìm thấy cảnh." };

  // Two locks, and they answer different questions.
  //
  // The authorisation lock asks "has money been promised against this plan?".
  // Editing after an approval would move the goalposts under a yes that was
  // given to a different plan.
  const auth = scene.project.batch?.authorization;
  if (auth && auth.status !== "DRAFT") {
    return {
      ok: false,
      message:
        `Lô đã ở trạng thái quyền chi ${auth.status}, không sửa được kế hoạch nữa. ` +
        "Hãy huỷ lô rồi nhập lại nếu cần đổi.",
    };
  }
  // The scene lock asks "has this scene already been bought?". A scene with a
  // provider job behind it has had real work done on it, and rewriting its
  // prompt would orphan that work while leaving the bill.
  const bought = await prisma.providerJob.count({ where: { sceneId: scene.id } });
  if (bought > 0) {
    return {
      ok: false,
      message:
        `Cảnh này đã bắt đầu tạo media (${bought} request đã gửi tới nhà cung cấp), ` +
        "nên không sửa được nữa. Hãy dùng nút thử lại cảnh nếu muốn tạo lại.",
    };
  }

  const data: Record<string, unknown> = {};
  if (input.duration !== undefined) {
    if (!(input.duration >= MIN_SCENE_DURATION && input.duration <= MAX_SCENE_DURATION)) {
      return {
        ok: false,
        message: `Thời lượng phải nằm trong khoảng ${MIN_SCENE_DURATION}–${MAX_SCENE_DURATION} giây.`,
      };
    }
    data.duration = input.duration;
  }
  if (input.narration !== undefined) data.narration = input.narration.trim();
  if (input.dialogue !== undefined) data.dialogue = input.dialogue.trim();
  if (input.visualDescription !== undefined) {
    data.visualDescription = input.visualDescription.trim();
  }
  if (input.characterAction !== undefined) data.characterAction = input.characterAction.trim();
  if (input.camera !== undefined) data.camera = input.camera.trim();
  if (input.subtitle !== undefined) data.subtitle = input.subtitle.trim();
  if (input.priority !== undefined) data.spendPriority = input.priority;
  if (input.motionMode !== undefined) {
    data.motionMode = input.motionMode;
    data.motionSource = input.motionMode === "LOCAL_MOTION" ? "LOCAL_MOTION" : "AI_VIDEO";
    if (input.motionMode === "LOCAL_MOTION") {
      data.videoProvider = null;
      data.videoModel = null;
      data.videoModelPinned = false;
    }
  }
  if (input.videoProvider !== undefined) data.videoProvider = input.videoProvider || null;
  if (input.videoModel !== undefined) data.videoModel = input.videoModel || null;

  // Whoever edited this form is a person, so whatever they left in the two model
  // fields is an instruction - including leaving them empty, which retracts the
  // pin. Recomputed from the values that will actually be stored, not from the
  // input alone, since `motionMode = LOCAL_MOTION` clears them above. QĐ-069.
  if (data.videoProvider !== undefined || data.videoModel !== undefined) {
    const provider = (data.videoProvider as string | null) ?? scene.videoProvider;
    const model = (data.videoModel as string | null) ?? scene.videoModel;
    data.videoModelPinned = Boolean(provider && model);
  }

  // The prompt is DERIVED, so it has to be re-derived whenever one of the three
  // fields it is derived from moves. Leaving the old one would send a video
  // model a description of a scene that no longer exists.
  const visualDescription = (data.visualDescription as string) ?? scene.visualDescription;
  const characterAction = (data.characterAction as string) ?? scene.characterAction;
  const camera = (data.camera as string) ?? scene.camera;
  const narration = (data.narration as string) ?? scene.narration;
  const motionMode = (data.motionMode as string) ?? scene.motionMode;

  if (
    motionMode === "VIDEO_AI" &&
    !promptHasMotionContent({ visualDescription, characterAction })
  ) {
    return {
      ok: false,
      message:
        "Cảnh đặt VIDEO_AI thì phải có mô tả cảnh hoặc hành động, nếu không sẽ không " +
        "dựng được prompt video. Hãy điền một trong hai, hoặc chuyển sang LOCAL_MOTION.",
    };
  }
  data.videoPrompt = deriveVideoPrompt({
    visualDescription,
    characterAction,
    camera,
    narration,
  });

  // Speech follows the words, and narration counts: an empty speaking list is
  // what makes `parseDialogueLines` drop narration on the floor.
  const dialogue = (data.dialogue as string) ?? scene.dialogue;
  if (input.dialogue !== undefined || input.narration !== undefined) {
    const present = JSON.parse(scene.charactersPresentJson) as string[];
    const hasWords = dialogue.trim().length > 0 || narration.trim().length > 0;
    data.speakingCharactersJson = JSON.stringify(hasWords ? present.slice(0, 1) : []);
  }

  await prisma.$transaction([
    prisma.scene.update({ where: { id: input.sceneId }, data }),
    // Invalidating the estimate is the point, not a side effect. The frozen
    // plan is what `batch_expand` runs and what the approval is checked
    // against; leaving a stale one next to edited scenes is how an operator
    // approves a number that describes a video they just changed.
    ...(scene.project.batchId
      ? [
          prisma.batch.update({
            where: { id: scene.project.batchId },
            data: { planJson: "{}", estimatedCost: 0 },
          }),
        ]
      : []),
  ]);

  revalidatePath(`/batches/${scene.project.batchId ?? ""}`);
  revalidatePath("/import");
  return {
    ok: true,
    message: "Đã lưu. Bản dự toán cũ đã bị huỷ — hãy DỰ TOÁN LẠI trước khi duyệt.",
  };
}

// ------------------------------------------------- character bible, inline ---

/** One character as the import screen shows and edits it. */
export interface ImportCharacterRow {
  characterId: string | null;
  name: string;
  readiness: string;
  referenceCount: number;
  missingFields: string[];
  unlockedAttributes: string[];
  lockedAttributes: string[];
  warnings: string[];
  presentation: string;
  approximateAge: string;
  skinTone: string;
  hair: string;
  facialFeatures: string;
  distinguishingFeatures: string;
  outfit: string;
  bodyProportions: string;
  accessories: string;
  colorPalette: string;
  negativeIdentity: string;
  /** Every reference image, newest last, with which one is primary. */
  references: { id: string; filePath: string; isPrimary: boolean; approved: boolean }[];
}

/**
 * Load the cast of an imported batch, ready to edit.
 *
 * Reads the CHARACTER TABLE, keyed by the names the scenes actually carry -
 * which is what the pipeline will resolve, and which a storyboard file stops
 * being the authority on the moment somebody edits a scene.
 */
export async function importedCharacters(batchId: string): Promise<ImportCharacterRow[]> {
  const projects = await prisma.project.findMany({
    where: { batchId },
    include: { scenes: { where: { skipped: false } } },
  });

  const names = new Set<string>();
  for (const project of projects) {
    for (const scene of project.scenes) {
      for (const name of sceneCharacters(scene).present) names.add(name);
    }
  }

  const rows: ImportCharacterRow[] = [];
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const row = await findCharacterByName(name);
    if (!row) {
      // A name no character row answers to. Shown rather than hidden: the image
      // step refuses it outright, and finding that out here costs nothing.
      rows.push({
        characterId: null,
        name,
        readiness: "NEEDS_CHARACTER_REFERENCE",
        referenceCount: 0,
        missingFields: [],
        unlockedAttributes: [],
        lockedAttributes: [],
        warnings: [
          `Chưa có nhân vật nào tên "${name}" trong bảng Nhân vật. ` +
            "Bước tạo ảnh sẽ từ chối cảnh này chứ không vẽ đại một người.",
        ],
        presentation: "",
        approximateAge: "",
        skinTone: "",
        hair: "",
        facialFeatures: "",
        distinguishingFeatures: "",
        outfit: "",
        bodyProportions: "",
        accessories: "",
        colorPalette: "",
        negativeIdentity: "",
        references: [],
      });
      continue;
    }
    const references = await prisma.characterReference.findMany({
      where: { characterId: row.id },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    });
    const sheet = await getCharacterSheet(row.id);
    rows.push({
      characterId: row.id,
      name: row.name,
      readiness: sheet?.readiness ?? "NEEDS_CHARACTER_REFERENCE",
      referenceCount: references.length,
      missingFields: sheet?.missingFields ?? [],
      unlockedAttributes: sheet?.unlockedAttributes ?? [],
      lockedAttributes: sheet?.lockedAttributes ?? [],
      warnings: sheet?.warnings ?? [],
      presentation: row.presentation,
      approximateAge: row.approximateAge,
      skinTone: row.skinTone,
      hair: row.hair,
      facialFeatures: row.facialFeatures,
      distinguishingFeatures: row.distinguishingFeatures,
      outfit: row.outfit,
      bodyProportions: row.bodyProportions,
      accessories: row.accessories,
      colorPalette: row.colorPalette,
      negativeIdentity: row.negativeIdentity,
      references: references.map((r) => ({
        id: r.id,
        filePath: r.filePath,
        isPrimary: r.isPrimary,
        approved: r.approved,
      })),
    });
  }
  return rows;
}

/**
 * Edit one character's Bible from the import screen.
 *
 * NOTHING HERE IS REQUIRED, and `approximateAge` / `skinTone` least of all: an
 * operator who does not know how old a character looks must be able to say so,
 * or leave the box alone, without being stopped. An unstated attribute is
 * simply not locked - see QĐ-072 - and the screen shows which ones those are.
 *
 * Free and offline. It writes a row and re-prices the batch; no provider is
 * contacted, no media is made, and the batch's frozen estimate is discarded so
 * the next approval is signed against the character that now exists.
 */
export async function updateImportedCharacter(input: {
  characterId: string;
  batchId: string;
  name?: string;
  presentation?: string;
  approximateAge?: string;
  skinTone?: string;
  hair?: string;
  facialFeatures?: string;
  distinguishingFeatures?: string;
  outfit?: string;
  bodyProportions?: string;
  accessories?: string;
  colorPalette?: string;
  negativeIdentity?: string;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const current = await prisma.character.findUnique({
      where: { id: input.characterId },
    });
    if (!current) return { ok: false, message: "Không tìm thấy nhân vật." };

    // Renaming has to carry the SCENES with it, or the scenes go on naming
    // somebody who no longer exists and the image step refuses every one of
    // them. Checked before the write for that reason.
    const newName = input.name?.trim();
    const renaming = newName !== undefined && newName.length > 0 && newName !== current.name;
    if (renaming) {
      const clash = await findCharacterByName(newName);
      if (clash && clash.id !== current.id) {
        return {
          ok: false,
          message:
            `Đã có nhân vật tên "${clash.name}". Đổi sang tên đó sẽ trộn hai người ` +
            "làm một — hãy chọn tên khác, hoặc sửa các cảnh để dùng thẳng nhân vật kia.",
        };
      }
    }

    // The same rule the Nhân vật page uses: the version follows the LOOK, not
    // the paperwork, and no image is created either way. QĐ-072.
    const edit = applySheetEdit(current, input);
    const changed = edit.changed;

    await prisma.character.update({
      where: { id: input.characterId },
      data: { ...edit.data, version: edit.version },
    });

    if (renaming) {
      const scenes = await prisma.scene.findMany({
        where: { project: { batchId: input.batchId } },
      });
      for (const scene of scenes) {
        const swap = (json: string) =>
          JSON.stringify(
            (JSON.parse(json) as string[]).map((n) =>
              n.trim().toLowerCase() === current.name.trim().toLowerCase() ? newName! : n,
            ),
          );
        const next = {
          charactersPresentJson: swap(scene.charactersPresentJson),
          speakingCharactersJson: swap(scene.speakingCharactersJson),
          primaryCharactersJson: swap(scene.primaryCharactersJson),
        };
        if (
          next.charactersPresentJson !== scene.charactersPresentJson ||
          next.speakingCharactersJson !== scene.speakingCharactersJson ||
          next.primaryCharactersJson !== scene.primaryCharactersJson
        ) {
          await prisma.scene.update({ where: { id: scene.id }, data: next });
        }
      }
    }

    // Same rule as editing a scene: the frozen plan describes the batch as it
    // was, so it is thrown away rather than left beside the thing it no longer
    // describes.
    await prisma.batch.update({
      where: { id: input.batchId },
      data: { planJson: "{}", estimatedCost: 0 },
    });

    revalidatePath("/import");
    revalidatePath("/characters");
    revalidatePath(`/batches/${input.batchId}`);
    return {
      ok: true,
      message: changed
        ? `Đã lưu. Ngoại hình đổi nên phiên bản lên v${current.version + 1}; ` +
          "ảnh tham chiếu cũ vẫn giữ nguyên. Hãy DỰ TOÁN LẠI."
        : "Đã lưu (ngoại hình không đổi, giữ nguyên phiên bản).",
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Attach a reference image to a character from the import screen.
 *
 * An UPLOAD, never a generation. The system has no path from here to an image
 * model on purpose: making a character's master costs money and is a decision
 * for a person to take deliberately on the Nhân vật page, not a side effect of
 * tidying up an import.
 */
export async function uploadImportedCharacterReference(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const characterId = String(formData.get("characterId") ?? "");
  const batchId = String(formData.get("batchId") ?? "");
  const file = formData.get("file");

  if (!characterId) return { ok: false, message: "Thiếu nhân vật." };
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Chưa chọn tệp ảnh." };
  }
  if (file.size > 10 * 1024 * 1024) {
    return {
      ok: false,
      message: `Tệp ${(file.size / 1024 / 1024).toFixed(1)} MB vượt giới hạn 10 MB.`,
    };
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    await uploadCharacterReference({
      characterId,
      fileName: file.name,
      bytes,
      notes: "Tải lên từ trang Nhập storyboard",
    });
    revalidatePath("/import");
    revalidatePath("/characters");
    if (batchId) revalidatePath(`/batches/${batchId}`);
    return {
      ok: true,
      message:
        "Đã tải ảnh lên. Bấm “Đặt làm ảnh chính” nếu muốn dùng ảnh này làm mốc nhất quán.",
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Promote one reference image to the character's master, from the import screen. */
export async function setImportedCharacterPrimary(
  referenceId: string,
  batchId: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    await approveCharacterReference(referenceId);
    revalidatePath("/import");
    revalidatePath("/characters");
    if (batchId) revalidatePath(`/batches/${batchId}`);
    return { ok: true, message: "Đã đặt làm ảnh chính. Mọi cảnh sau sẽ khớp theo ảnh này." };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
