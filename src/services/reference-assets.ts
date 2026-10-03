import fs from "node:fs";
import type { Asset, ReferenceAsset, Scene } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { toAbsolute } from "@/lib/paths";
import { parseJson } from "@/lib/utils";
import {
  autoAssign,
  defaultPriority,
  isReferenceType,
  REFERENCE_PRIORITIES,
  type ReferencePriority,
  type ReferenceType,
} from "@/domain/reference";
import { sceneCharacters } from "@/domain/scene-characters";
import { importSceneImage, storeImportedImage } from "./imported-image";

/**
 * UNIVERSAL REFERENCE ASSET SYSTEM (QĐ-124).
 *
 * A ReferenceAsset is one THING that must look the same in every scene it is
 * in. Its pictures are ordinary Asset rows (IMPORTED, $0) linked by
 * `Asset.referenceAssetId`. Characters keep their Character Bible and
 * CharacterReference rows and are only MAPPED into this view - nothing is
 * copied or migrated.
 *
 * Nothing in this file calls a provider: upload, assign, reuse are $0. Changing
 * a picture marks only the scenes that show that reference as needing a new
 * picture; voice, subtitles and every other scene are untouched, and nothing is
 * bought until the usual preflight + approval.
 */

export class ReferenceError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID" | "REFERENCE_MISSING_LOCAL_FILE" | "WRONG_PROJECT",
    message: string,
  ) {
    super(message);
    this.name = "ReferenceError";
  }
}

export interface ReferenceImage {
  assetId: string;
  path: string;
  filename: string;
  primary: boolean;
  exists: boolean;
}

export interface UniversalReference {
  /** ReferenceAsset id, or "character:<id>" for a mapped Character. */
  id: string;
  type: ReferenceType;
  name: string;
  description: string;
  priority: ReferencePriority;
  isPrimary: boolean;
  enabled: boolean;
  useThroughout: boolean;
  version: number;
  source: "REFERENCE" | "CHARACTER_BIBLE";
  images: ReferenceImage[];
  aliases: string[];
}

function imageOf(a: Asset, primaryId: string | null): ReferenceImage {
  let exists = false;
  try {
    exists = fs.existsSync(toAbsolute(a.filePath));
  } catch {
    exists = false;
  }
  return { assetId: a.id, path: a.filePath, filename: a.originalFilename ?? a.id.slice(0, 8), primary: a.id === primaryId, exists };
}

function toUniversal(r: ReferenceAsset, images: Asset[]): UniversalReference {
  const primaryId = r.assetId ?? images[0]?.id ?? null;
  return {
    id: r.id,
    type: isReferenceType(r.referenceType) ? r.referenceType : "OBJECT",
    name: r.name,
    description: r.description,
    priority: (REFERENCE_PRIORITIES as readonly string[]).includes(r.priority) ? (r.priority as ReferencePriority) : "IMPORTANT",
    isPrimary: r.isPrimary,
    enabled: r.enabled,
    useThroughout: r.useThroughout,
    version: r.version,
    source: "REFERENCE",
    images: images
      .map((a) => imageOf(a, primaryId))
      .sort((a, b) => Number(b.primary) - Number(a.primary)),
    aliases: parseJson<string[]>(r.tagsJson, []),
  };
}

/** The project's own references (products, toys, logos…), with their pictures. */
export async function projectReferenceAssets(projectId: string): Promise<UniversalReference[]> {
  const refs = await prisma.referenceAsset.findMany({ where: { projectId }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] });
  if (refs.length === 0) return [];
  const images = await prisma.asset.findMany({ where: { referenceAssetId: { in: refs.map((r) => r.id) } }, orderBy: { createdAt: "asc" } });
  return refs.map((r) => toUniversal(r, images.filter((a) => a.referenceAssetId === r.id)));
}

/**
 * Everything the "Tài sản tham chiếu" panel shows: the project's references
 * plus every character its scenes draw, mapped from the Character Bible (read
 * only - the Characters page stays where a character is edited).
 */
export async function listProjectReferences(projectId: string): Promise<UniversalReference[]> {
  const [own, scenes] = await Promise.all([
    projectReferenceAssets(projectId),
    prisma.scene.findMany({ where: { projectId }, select: { charactersPresentJson: true, speakingCharactersJson: true, primaryCharactersJson: true } }),
  ]);
  const names = [...new Set(scenes.flatMap((s) => sceneCharacters(s).present))];
  const characters = names.length
    ? await prisma.character.findMany({ where: { name: { in: names } }, include: { references: true } })
    : [];
  const mapped: UniversalReference[] = characters.map((c) => {
    const approved = c.references.filter((r) => r.approved);
    return {
      id: `character:${c.id}`,
      type: "CHARACTER",
      name: c.name,
      description: c.visualPrompt,
      priority: "IMPORTANT",
      isPrimary: false,
      enabled: c.enabled || c.references.length > 0,
      useThroughout: false,
      version: c.version,
      source: "CHARACTER_BIBLE",
      images: approved.map((r) => ({
        assetId: r.id,
        path: r.filePath,
        filename: r.filePath.split(/[\\/]/).pop() ?? r.id,
        primary: r.isPrimary,
        exists: (() => {
          try {
            return fs.existsSync(toAbsolute(r.filePath));
          } catch {
            return false;
          }
        })(),
      })),
      aliases: [],
    };
  });
  return [...mapped, ...own];
}

// ---------------------------------------------------------------- create ---

export interface CreateReferenceInput {
  projectId: string;
  type: ReferenceType;
  name: string;
  description?: string;
  priority?: ReferencePriority;
  isPrimary?: boolean;
  useThroughout?: boolean;
  aliases?: string[];
  notes?: string;
  /** New pictures (stored in the Asset Library, $0). */
  uploads?: { bytes: Buffer; filename: string }[];
  /** Pictures already in this project's Asset Library. */
  assetIds?: string[];
}

export async function createReference(input: CreateReferenceInput): Promise<UniversalReference> {
  if (!isReferenceType(input.type)) throw new ReferenceError("INVALID", `Loại tham chiếu không hợp lệ: ${input.type}`);
  const name = input.name.trim();
  if (!name) throw new ReferenceError("INVALID", "Hãy đặt tên cho tham chiếu.");
  const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true, contentType: true } });
  if (!project) throw new ReferenceError("NOT_FOUND", "Không tìm thấy dự án.");

  const ref = await prisma.referenceAsset.create({
    data: {
      projectId: project.id,
      referenceType: input.type,
      name,
      description: input.description?.trim() ?? "",
      priority: input.priority ?? defaultPriority(input.type, project.contentType),
      isPrimary: input.isPrimary ?? false,
      useThroughout: input.useThroughout ?? false,
      tagsJson: JSON.stringify(input.aliases ?? []),
      notes: input.notes ?? "",
    },
  });
  await attachPictures(ref.id, project.id, input.uploads ?? [], input.assetIds ?? []);
  await logger.info({
    event: "reference.created",
    projectId: project.id,
    message: `Thêm tham chiếu ${input.type} "${name}" (${(input.uploads?.length ?? 0) + (input.assetIds?.length ?? 0)} ảnh). Chi phí $0.`,
  });
  return (await projectReferenceAssets(project.id)).find((r) => r.id === ref.id)!;
}

async function attachPictures(refId: string, projectId: string, uploads: { bytes: Buffer; filename: string }[], assetIds: string[]): Promise<string[]> {
  const linked: string[] = [];
  for (const u of uploads) {
    const stored = await storeImportedImage({ projectId, sceneId: null, bytes: u.bytes, originalFilename: u.filename, via: "reference" });
    linked.push(stored.asset.id);
  }
  if (assetIds.length) {
    const own = await prisma.asset.findMany({ where: { id: { in: assetIds }, projectId, kind: "image" } });
    if (own.length !== assetIds.length) throw new ReferenceError("WRONG_PROJECT", "Có ảnh không thuộc dự án này.");
    linked.push(...assetIds);
  }
  if (linked.length) {
    await prisma.asset.updateMany({ where: { id: { in: linked } }, data: { referenceAssetId: refId } });
    const ref = await prisma.referenceAsset.findUniqueOrThrow({ where: { id: refId } });
    if (!ref.assetId) await prisma.referenceAsset.update({ where: { id: refId }, data: { assetId: linked[0] } });
  }
  return linked;
}

// ------------------------------------------------------------ assignment ---

export function sceneReferenceIds(scene: Pick<Scene, "referenceIdsJson">): string[] {
  return parseJson<string[]>(scene.referenceIdsJson, []).filter((x) => typeof x === "string");
}

/**
 * A scene showing a reference whose picture must be exact (CRITICAL product or
 * logo) is animated locally by default: Video AI is the step that tends to
 * redraw a label. Only applies to a scene still on AUTO; a person's own choice
 * (VIDEO_AI / LOCAL_MOTION) is never overridden.
 */
function fidelityMotion(scene: Pick<Scene, "motionMode">, refs: UniversalReference[]): { motionMode?: string; motionSource?: string } {
  if (scene.motionMode !== "AUTO") return {};
  const exact = refs.some((r) => r.priority === "CRITICAL" && (r.type === "PRODUCT" || r.type === "LOGO"));
  // The instruction AND the stored decision, as the storyboard editor writes
  // them: the pipeline and the estimate read motionSource.
  return exact ? { motionMode: "LOCAL_MOTION", motionSource: "LOCAL_MOTION" } : {};
}

/** Set exactly which references a scene shows. $0; only THIS scene's generated picture is invalidated. */
export async function setSceneReferences(sceneId: string, ids: string[]): Promise<{ changed: boolean; invalidated: boolean }> {
  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  const own = await projectReferenceAssets(scene.projectId);
  const unknown = ids.filter((id) => !own.some((r) => r.id === id));
  if (unknown.length) throw new ReferenceError("WRONG_PROJECT", "Tham chiếu không thuộc dự án này.");
  const next = own.filter((r) => ids.includes(r.id)).map((r) => r.id); // stable order
  const before = sceneReferenceIds(scene);
  const changed = before.join("|") !== next.join("|");
  if (!changed) return { changed: false, invalidated: false };
  await prisma.scene.update({
    where: { id: sceneId },
    data: { referenceIdsJson: JSON.stringify(next), ...fidelityMotion(scene, own.filter((r) => next.includes(r.id))) },
  });
  const invalidated = await invalidateGeneratedPicture(sceneId, "danh sách tham chiếu của cảnh đã đổi");
  return { changed, invalidated };
}

/**
 * Deterministic auto-assignment from each scene's words (and "dùng xuyên suốt
 * video"). `onlyEmpty` keeps every list a person has already set.
 */
export async function autoAssignReferences(projectId: string, opts: { onlyEmpty?: boolean } = {}): Promise<Record<number, string[]>> {
  const [refs, scenes] = await Promise.all([
    projectReferenceAssets(projectId),
    prisma.scene.findMany({ where: { projectId }, orderBy: { sceneNumber: "asc" } }),
  ]);
  const out: Record<number, string[]> = {};
  if (refs.length === 0) return out;
  // A scene whose keyframe IS one of a reference's pictures shows that reference.
  const pictureOwner = new Map<string, string>();
  const shaOwner = new Map<string, string>();
  const refAssets = await prisma.asset.findMany({ where: { referenceAssetId: { in: refs.map((r) => r.id) } } });
  for (const a of refAssets) {
    pictureOwner.set(a.id, a.referenceAssetId!);
    if (a.sha256) shaOwner.set(a.sha256, a.referenceAssetId!);
  }
  const keyframes = await prisma.asset.findMany({
    where: { id: { in: scenes.map((s) => s.imageAssetId).filter((x): x is string => Boolean(x)) } },
    select: { id: true, sha256: true },
  });
  const assignable = refs.map((r) => ({ id: r.id, name: r.name, type: r.type, enabled: r.enabled, useThroughout: r.useThroughout, aliases: r.aliases }));
  for (const scene of scenes) {
    if (opts.onlyEmpty && sceneReferenceIds(scene).length > 0) continue;
    const text = [scene.visualDescription, scene.narration, scene.dialogue, scene.subtitle, scene.imagePrompt].join(" ");
    const ids = new Set(autoAssign(text, assignable));
    const kf = keyframes.find((k) => k.id === scene.imageAssetId);
    const owner = kf ? (pictureOwner.get(kf.id) ?? (kf.sha256 ? shaOwner.get(kf.sha256) : undefined)) : undefined;
    if (owner) ids.add(owner);
    const list = refs.filter((r) => ids.has(r.id)).map((r) => r.id);
    out[scene.sceneNumber] = list;
    await setSceneReferences(scene.id, list);
  }
  return out;
}

// ------------------------------------------------------- change / invalidate ---

/**
 * The scene's GENERATED picture (and any clip made from it) no longer matches
 * what the scene must show. Cleared - never deleted: the Asset rows and the
 * ledger keep the purchase. Voice, dialogue lines and subtitles are untouched.
 * An imported picture is the person's own photo and stays.
 */
async function invalidateGeneratedPicture(sceneId: string, reason: string): Promise<boolean> {
  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  if (scene.imageSource !== "GENERATED" || (!scene.imagePath && !scene.videoPath)) return false;
  await prisma.scene.update({
    where: { id: sceneId },
    data: { imagePath: null, videoPath: null, status: scene.status === "skipped" ? scene.status : "pending", errorMessage: null },
  });
  // A finished video now has a scene to make again: it goes back to "media to
  // make" so preflight / TIẾP TỤC price it. The old MP4 stays on disk.
  await prisma.project.updateMany({
    where: { id: scene.projectId, status: { in: ["completed", "media_ready"] } },
    data: { status: "script_ready" },
  });
  await logger.info({
    event: "reference.scene_invalidated",
    projectId: scene.projectId,
    sceneId,
    message: `Cảnh ${scene.sceneNumber}: ${reason} → cần ảnh mới (xem chi phí ở PREFLIGHT trước khi tạo). Giọng và phụ đề giữ nguyên.`,
  });
  return true;
}

export interface ReferenceChangeResult {
  version: number;
  /** Scene numbers that now need a new picture (shown before anything is bought). */
  invalidatedScenes: number[];
  /** Scenes whose own imported photo was swapped for the new main picture ($0). */
  rephotographedScenes: number[];
}

/**
 * Change a reference's pictures or look (new photo, new main photo, new
 * description). Only scenes that SHOW this reference are touched.
 */
export async function changeReference(
  refId: string,
  change: {
    uploads?: { bytes: Buffer; filename: string }[];
    primaryAssetId?: string;
    removeAssetIds?: string[];
    name?: string;
    description?: string;
    priority?: ReferencePriority;
    enabled?: boolean;
    useThroughout?: boolean;
  },
): Promise<ReferenceChangeResult> {
  const ref = await prisma.referenceAsset.findUnique({ where: { id: refId } });
  if (!ref || !ref.projectId) throw new ReferenceError("NOT_FOUND", "Không tìm thấy tham chiếu.");
  const oldImages = await prisma.asset.findMany({ where: { referenceAssetId: refId } });
  const oldPrimary = ref.assetId;

  const added = await attachPictures(refId, ref.projectId, change.uploads ?? [], []);
  if (change.removeAssetIds?.length) {
    await prisma.asset.updateMany({ where: { id: { in: change.removeAssetIds }, referenceAssetId: refId }, data: { referenceAssetId: null } });
  }
  let primary = change.primaryAssetId ?? (added.length && change.uploads?.length ? (oldPrimary && !change.removeAssetIds?.includes(oldPrimary) ? oldPrimary : added[0]) : oldPrimary);
  if (primary && change.removeAssetIds?.includes(primary)) primary = added[0] ?? null;
  if (change.primaryAssetId) {
    const ok = await prisma.asset.findFirst({ where: { id: change.primaryAssetId, referenceAssetId: refId } });
    if (!ok) throw new ReferenceError("INVALID", "Ảnh chính phải là một ảnh của tham chiếu này.");
  }

  const looksChanged =
    primary !== oldPrimary ||
    (change.description !== undefined && change.description.trim() !== ref.description) ||
    (change.name !== undefined && change.name.trim() !== ref.name) ||
    Boolean(change.removeAssetIds?.length);
  const updated = await prisma.referenceAsset.update({
    where: { id: refId },
    data: {
      assetId: primary ?? null,
      name: change.name?.trim() || ref.name,
      description: change.description?.trim() ?? ref.description,
      priority: change.priority ?? ref.priority,
      enabled: change.enabled ?? ref.enabled,
      useThroughout: change.useThroughout ?? ref.useThroughout,
      version: looksChanged ? ref.version + 1 : ref.version,
    },
  });

  const result: ReferenceChangeResult = { version: updated.version, invalidatedScenes: [], rephotographedScenes: [] };
  if (!looksChanged) return result;

  const scenes = (await prisma.scene.findMany({ where: { projectId: ref.projectId }, orderBy: { sceneNumber: "asc" } })).filter((s) =>
    sceneReferenceIds(s).includes(refId),
  );
  const oldShas = new Set(oldImages.map((a) => a.sha256).filter(Boolean));
  const newPrimary = primary ? await prisma.asset.findUnique({ where: { id: primary } }) : null;
  for (const scene of scenes) {
    if (scene.imageSource === "IMPORTED") {
      // The scene shows the reference's own photo: give it the new main photo ($0).
      const kf = scene.imageAssetId ? await prisma.asset.findUnique({ where: { id: scene.imageAssetId } }) : null;
      if (kf?.sha256 && oldShas.has(kf.sha256) && newPrimary && kf.sha256 !== newPrimary.sha256 && primary !== oldPrimary) {
        await importSceneImage({
          sceneId: scene.id,
          bytes: fs.readFileSync(toAbsolute(newPrimary.filePath)),
          originalFilename: newPrimary.originalFilename ?? "reference.png",
          via: "reference",
        });
        result.rephotographedScenes.push(scene.sceneNumber);
      }
      continue;
    }
    if (await invalidateGeneratedPicture(scene.id, `tham chiếu "${updated.name}" đã đổi (v${updated.version})`)) {
      result.invalidatedScenes.push(scene.sceneNumber);
    }
  }
  return result;
}

// -------------------------------------------------------------- validation ---

export interface ReferenceProblem {
  sceneNumber: number;
  code: "REFERENCE_MISSING_LOCAL_FILE" | "REFERENCE_NOT_FOUND" | "REFERENCE_DISABLED";
  message: string;
}

/**
 * Preflight: every reference a live scene shows still exists, is on, and its
 * main picture is still on disk. A missing file is reported - never re-made.
 */
export async function referenceProblems(projectId: string): Promise<ReferenceProblem[]> {
  const [refs, scenes] = await Promise.all([
    projectReferenceAssets(projectId),
    prisma.scene.findMany({ where: { projectId, skipped: false }, orderBy: { sceneNumber: "asc" } }),
  ]);
  const out: ReferenceProblem[] = [];
  for (const scene of scenes) {
    for (const id of sceneReferenceIds(scene)) {
      const r = refs.find((x) => x.id === id);
      if (!r) {
        out.push({ sceneNumber: scene.sceneNumber, code: "REFERENCE_NOT_FOUND", message: `Cảnh ${scene.sceneNumber}: tham chiếu đã bị xoá.` });
        continue;
      }
      if (!r.enabled) {
        out.push({ sceneNumber: scene.sceneNumber, code: "REFERENCE_DISABLED", message: `Cảnh ${scene.sceneNumber}: tham chiếu "${r.name}" đang tắt.` });
        continue;
      }
      const main = r.images.find((i) => i.primary);
      if (main && !main.exists) {
        out.push({
          sceneNumber: scene.sceneNumber,
          code: "REFERENCE_MISSING_LOCAL_FILE",
          message: `REFERENCE_MISSING_LOCAL_FILE: cảnh ${scene.sceneNumber}, ảnh tham chiếu "${r.name}" (${main.filename}) không còn trên đĩa. Không tự tạo lại - hãy tải ảnh lên lại.`,
        });
      }
    }
  }
  return out;
}

/** Resolved references of one scene, for the image request and the router. $0. */
export async function sceneReferences(scene: Pick<Scene, "projectId" | "referenceIdsJson">): Promise<UniversalReference[]> {
  const ids = sceneReferenceIds(scene);
  if (ids.length === 0) return [];
  const own = await projectReferenceAssets(scene.projectId);
  return ids.map((id) => own.find((r) => r.id === id)).filter((r): r is UniversalReference => Boolean(r && r.enabled));
}

/** CRITICAL pictures a scene must send (for routing). */
export function criticalPictureCount(refs: UniversalReference[], override: string | null | undefined): number {
  if (override === "NO_REFERENCES_CONFIRMED") return 0;
  return refs.filter((r) => r.priority === "CRITICAL" && r.type !== "LOGO" && r.type !== "STYLE" && r.images.some((i) => i.primary)).length;
}

/** "Tiếp tục không dùng tham chiếu" - only ever set by a person's confirmation. */
export async function confirmSceneWithoutReferences(sceneId: string, confirmed: boolean): Promise<void> {
  await prisma.scene.update({ where: { id: sceneId }, data: { referenceOverride: confirmed ? "NO_REFERENCES_CONFIRMED" : null } });
}
