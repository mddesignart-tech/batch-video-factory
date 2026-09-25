import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Asset, Scene } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sha256Bytes } from "@/lib/crypto";
import { projectSubdir, toAbsolute, toRelative, uuidFilename } from "@/lib/paths";
import { logger } from "@/lib/logger";
import { ffmpeg, ffprobe } from "@/media/ffmpeg";
import { targetForAspect, type RenderTarget } from "@/media/render";
import { sniffImageType } from "@/lib/image-sniff";
import { ALLOWED_IMAGE_EXTENSIONS } from "@/domain/storyboard";

/**
 * Keyframes a person supplied, as first-class assets.
 *
 * The rule this module exists to keep, in one line:
 *
 *   IMPORTED IMAGE = REUSE = $0 IMAGE API COST
 *
 * Nothing here can reach an image provider. A supplied file is checked (it has
 * to be a real, decodable PNG/JPEG/WebP), copied into the project's own data
 * folder so the original on the Desktop can be deleted, recorded as an `Asset`
 * with `source: IMPORTED`, and attached to its scene. From then on
 * `generateSceneImage` hands the file back without routing, the estimator
 * prices it at $0 (`hasSuppliedKeyframe`), and no reservation is ever made.
 *
 * ## Aspect ratio - no stretching, no silent cropping of the subject
 *
 * Every consumer downstream (the render, and each video provider's
 * `prepareKeyframe`) fills the frame by scaling to cover and cropping the
 * centre. That is right for a picture already close to the target shape. A
 * 16:9 picture put through it would lose two thirds of its width, subject
 * included. So when the shape is far from the target, a WORKING COPY is made at
 * exactly the target size: the picture fitted whole, over a blurred copy of
 * itself. The scene uses the working copy; the original stays untouched as the
 * asset. Both are local FFmpeg work - never an Image API call.
 */

export type ImageFit = "auto" | "cover" | "contain";
export const IMAGE_FITS: readonly ImageFit[] = ["auto", "cover", "contain"];

/** How the picture was made to fit the frame. Reported, never guessed. */
export type Framing = "as_is" | "cover" | "contain_blur";

/** Refuse anything bigger. A storyboard frame is never 40 MB. */
export const IMPORT_MAX_BYTES = 40 * 1024 * 1024;
/** Beyond this on either side a working copy is made, so FFmpeg stays quick. */
const MAX_WORKING_EDGE = 4096;
/** Within 12% of the target shape the centre crop loses almost nothing. */
const ASPECT_TOLERANCE = 0.12;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

export type ImportImageErrorCode =
  | "image_empty"
  | "image_too_large"
  | "image_extension_not_allowed"
  | "image_not_an_image"
  | "image_undecodable";

export class ImportImageError extends Error {
  constructor(
    message: string,
    readonly code: ImportImageErrorCode,
  ) {
    super(message);
    this.name = "ImportImageError";
  }
}

export interface InspectedImage {
  /** The type the BYTES say, which wins over the name. */
  ext: ".png" | ".jpg" | ".webp";
  mime: string;
  width: number;
  height: number;
  sha256: string;
  bytes: number;
}

function allowedName(label: string): boolean {
  const lower = label.toLowerCase();
  return ALLOWED_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Prove a file is a picture this pipeline can use, or say exactly why not.
 *
 * Three independent checks, because each catches what the others miss: the
 * name (an `.exe` is refused before its bytes are read), the header (a `.png`
 * that is really HTML has no PNG signature), and a real decode of one frame (a
 * truncated PNG has a perfect header). A PNG saved as `.jpg` is accepted and
 * stored under its true extension - the name was wrong, not the picture.
 */
export async function inspectImageBytes(bytes: Buffer, label: string): Promise<InspectedImage> {
  if (!allowedName(label)) {
    throw new ImportImageError(
      `"${label}" không phải ảnh được nhận. Chỉ nhận: ${ALLOWED_IMAGE_EXTENSIONS.join(", ")}.`,
      "image_extension_not_allowed",
    );
  }
  if (bytes.length === 0) {
    throw new ImportImageError(`"${label}" rỗng (0 byte).`, "image_empty");
  }
  if (bytes.length > IMPORT_MAX_BYTES) {
    throw new ImportImageError(
      `"${label}" nặng ${(bytes.length / 1024 / 1024).toFixed(1)} MB, vượt giới hạn ` +
        `${IMPORT_MAX_BYTES / 1024 / 1024} MB.`,
      "image_too_large",
    );
  }
  const ext = sniffImageType(bytes);
  if (!ext) {
    throw new ImportImageError(
      `"${label}" có đuôi ảnh nhưng nội dung không phải PNG/JPEG/WebP. Không nhận.`,
      "image_not_an_image",
    );
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "import-check-"));
  const file = path.join(scratch, `probe${ext}`);
  try {
    fs.writeFileSync(file, bytes);
    let width = 0;
    let height = 0;
    try {
      // Decode one real frame: a header can be perfect on a truncated file.
      await ffmpeg(["-v", "error", "-i", file, "-frames:v", "1", "-f", "null", "-"]);
      const { stdout } = await ffprobe([
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file,
      ]);
      const [w, h] = stdout.trim().split("x").map(Number);
      width = w ?? 0;
      height = h ?? 0;
    } catch {
      width = 0;
    }
    if (!(width > 0 && height > 0)) {
      throw new ImportImageError(
        `"${label}" không giải mã được (file hỏng hoặc bị cắt cụt).`,
        "image_undecodable",
      );
    }
    return {
      ext,
      mime: MIME[ext]!,
      width,
      height,
      sha256: sha256Bytes(bytes),
      bytes: bytes.length,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * How a picture of this size will be put into this frame.
 *
 * Pure, so the rule is testable and the UI can show it before anything is
 * written: `as_is` (close enough - the downstream centre crop is harmless),
 * `cover` (the person asked for a crop), or `contain_blur` (whole picture over a
 * blurred copy of itself, because a crop would cut the subject).
 */
export function framingFor(
  width: number,
  height: number,
  target: Pick<RenderTarget, "width" | "height">,
  fit: ImageFit = "auto",
): Framing {
  if (fit === "contain") return "contain_blur";
  if (fit === "cover") return "cover";
  const ratio = width / height;
  const wanted = target.width / target.height;
  return Math.abs(ratio - wanted) / wanted <= ASPECT_TOLERANCE ? "as_is" : "contain_blur";
}

async function writeWorkingCopy(
  source: string,
  destination: string,
  framing: Framing,
  target: Pick<RenderTarget, "width" | "height">,
): Promise<void> {
  const { width: W, height: H } = target;
  const filter =
    framing === "contain_blur"
      ? `[0:v]split=2[a][b];` +
        `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:2[bg];` +
        `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=rgb24`
      : framing === "cover"
        ? `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=rgb24`
        : // as_is but huge: shrink, keep the shape.
          `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=decrease,format=rgb24`;
  await ffmpeg(["-v", "error", "-y", "-i", source, "-filter_complex", filter, "-frames:v", "1", destination]);
}

export interface StoredImport {
  asset: Asset;
  /** What the scene will use: the working copy, or the stored original. */
  imagePath: string;
  framing: Framing;
  /** True when an identical file was already stored in this project. */
  deduplicated: boolean;
}

/**
 * Copy a supplied picture into the project and record it. Spends nothing.
 *
 * Deliberately separate from attaching it to a scene: the import flow creates
 * scenes and attaches in one go, the replace flow attaches to an existing one,
 * and both must produce the same asset row.
 */
export async function storeImportedImage(opts: {
  projectId: string;
  sceneId: string | null;
  bytes: Buffer;
  originalFilename: string;
  fit?: ImageFit;
  /** Which tool supplied it - "storyboard" or "upload". Display only. */
  via?: string;
}): Promise<StoredImport> {
  const info = await inspectImageBytes(opts.bytes, opts.originalFilename);
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: opts.projectId },
    select: { id: true, aspectRatio: true },
  });
  const target = targetForAspect(project.aspectRatio);
  const imagesDir = projectSubdir(project.id, "images");
  fs.mkdirSync(imagesDir, { recursive: true });

  // Same bytes already stored in this project: point at that file instead of
  // writing a second copy. A new Asset row is still made - it is a new use.
  const twin = await prisma.asset.findFirst({
    where: { projectId: project.id, source: "IMPORTED", sha256: info.sha256 },
    orderBy: { createdAt: "asc" },
  });
  let originalAbs: string;
  let deduplicated = false;
  if (twin && fs.existsSync(toAbsolute(twin.filePath))) {
    originalAbs = toAbsolute(twin.filePath);
    deduplicated = true;
  } else {
    originalAbs = path.join(imagesDir, `import-${uuidFilename(info.ext)}`);
    fs.writeFileSync(originalAbs, opts.bytes);
  }

  const framing = framingFor(info.width, info.height, target, opts.fit ?? "auto");
  const huge = info.width > MAX_WORKING_EDGE || info.height > MAX_WORKING_EDGE;
  let imagePath = toRelative(originalAbs);
  if (framing !== "as_is" || huge) {
    const working = path.join(imagesDir, `working-${uuidFilename(".png")}`);
    await writeWorkingCopy(originalAbs, working, framing, target);
    imagePath = toRelative(working);
  }

  const asset = await prisma.asset.create({
    data: {
      projectId: project.id,
      sceneId: opts.sceneId,
      kind: "image",
      provider: "import",
      model: opts.via ?? "upload",
      source: "IMPORTED",
      status: "completed",
      estimatedCost: 0,
      actualCost: 0,
      filePath: toRelative(originalAbs),
      bytes: info.bytes,
      originalFilename: path.basename(opts.originalFilename),
      mimeType: info.mime,
      width: info.width,
      height: info.height,
      sha256: info.sha256,
    },
  });
  return { asset, imagePath, framing, deduplicated };
}

export interface AttachResult {
  scene: Scene;
  /** A clip made from the previous picture no longer matches and was dropped. */
  clipDropped: boolean;
  /** The project had a finished MP4, which now shows the old picture. */
  needsRerender: boolean;
}

/**
 * Make a stored import the scene's active keyframe.
 *
 * The previous image - generated or imported - is not deleted: its Asset row
 * and file stay, so "use the earlier one" is always possible. What does go is a
 * clip made FROM the previous picture, because keeping it would render a scene
 * whose motion shows a different image. Its key also stops matching
 * (`videoKeyVariant` includes the imported asset), so it cannot sneak back.
 */
export async function attachImportedImage(
  sceneId: string,
  stored: Pick<StoredImport, "asset" | "imagePath">,
): Promise<AttachResult> {
  const scene = await prisma.scene.findUniqueOrThrow({
    where: { id: sceneId },
    include: { project: { select: { finalVideoPath: true } } },
  });
  const changed = scene.imageAssetId !== stored.asset.id || scene.imagePath !== stored.imagePath;
  const clipDropped = changed && scene.videoPath !== null;

  const updated = await prisma.scene.update({
    where: { id: sceneId },
    data: {
      imageSource: "IMPORTED",
      imagePath: stored.imagePath,
      imageAssetId: stored.asset.id,
      ...(clipDropped ? { videoPath: null } : {}),
      ...(changed && ["completed", "pending", "failed"].includes(scene.status)
        ? { status: "image_ready", errorMessage: null }
        : {}),
    },
  });
  if (stored.asset.sceneId !== sceneId) {
    await prisma.asset.update({ where: { id: stored.asset.id }, data: { sceneId } });
  }
  await logger.info({
    event: "scene.image_imported",
    projectId: scene.projectId,
    sceneId,
    message:
      `Cảnh ${scene.sceneNumber} dùng ảnh nhập "${stored.asset.originalFilename}". ` +
      `Không gọi Image API, chi phí ảnh $0.` +
      (clipDropped ? " Clip cũ dựng từ ảnh trước đã bị bỏ." : ""),
  });
  return {
    scene: updated,
    clipDropped,
    needsRerender: changed && scene.project.finalVideoPath !== null,
  };
}

/** Store + attach, the path every UI entry point uses. */
export async function importSceneImage(opts: {
  sceneId: string;
  bytes: Buffer;
  originalFilename: string;
  fit?: ImageFit;
  via?: string;
}): Promise<AttachResult & { stored: StoredImport }> {
  const scene = await prisma.scene.findUniqueOrThrow({
    where: { id: opts.sceneId },
    select: { id: true, projectId: true },
  });
  const stored = await storeImportedImage({
    projectId: scene.projectId,
    sceneId: scene.id,
    bytes: opts.bytes,
    originalFilename: opts.originalFilename,
    fit: opts.fit,
    via: opts.via,
  });
  const attached = await attachImportedImage(scene.id, stored);
  return { ...attached, stored };
}

/**
 * Detach the scene's image. The next run will CREATE one (and preflight says so).
 *
 * Nothing is deleted from disk or from the Asset table. A clip made from the
 * removed picture goes with it, for the same reason as on replace.
 */
export async function removeSceneImage(sceneId: string): Promise<Scene> {
  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  return prisma.scene.update({
    where: { id: sceneId },
    data: {
      imageSource: "GENERATED",
      imagePath: null,
      imageAssetId: null,
      videoPath: null,
      status: scene.status === "skipped" ? scene.status : "pending",
      errorMessage: null,
    },
  });
}

/** Every imported picture this scene has ever used, newest first. */
export async function importedAssetsForScene(sceneId: string): Promise<Asset[]> {
  return prisma.asset.findMany({
    where: { sceneId, source: "IMPORTED", kind: "image" },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Go back to an earlier imported picture of the same scene ("Use existing").
 *
 * Re-derives the working copy from the stored original, so choosing an older
 * asset never depends on a temporary file still being around.
 */
export async function useExistingImportedAsset(
  sceneId: string,
  assetId: string,
  fit: ImageFit = "auto",
): Promise<AttachResult> {
  const asset = await prisma.asset.findFirstOrThrow({
    where: { id: assetId, sceneId, source: "IMPORTED" },
  });
  const bytes = fs.readFileSync(toAbsolute(asset.filePath));
  const scene = await prisma.scene.findUniqueOrThrow({
    where: { id: sceneId },
    include: { project: { select: { id: true, aspectRatio: true } } },
  });
  const target = targetForAspect(scene.project.aspectRatio);
  const framing = framingFor(asset.width ?? 0, asset.height ?? 0, target, fit);
  let imagePath = asset.filePath;
  const huge = (asset.width ?? 0) > MAX_WORKING_EDGE || (asset.height ?? 0) > MAX_WORKING_EDGE;
  if (framing !== "as_is" || huge) {
    const working = path.join(projectSubdir(scene.project.id, "images"), `working-${uuidFilename(".png")}`);
    const source = path.join(os.tmpdir(), `reuse-${uuidFilename(path.extname(asset.filePath))}`);
    fs.writeFileSync(source, bytes);
    try {
      await writeWorkingCopy(source, working, framing, target);
    } finally {
      fs.rmSync(source, { force: true });
    }
    imagePath = toRelative(working);
  }
  return attachImportedImage(sceneId, { asset, imagePath });
}
