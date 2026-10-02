import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { round } from "@/lib/utils";
import {
  aspectOf,
  generationAspectFor,
  platformPreset,
  validateProfile,
  viShape,
  type OutputProfile,
} from "@/domain/platform-profile";
import { renderSettingsFor } from "./output-layout";

/**
 * A project's video FORMAT (QĐ-121): where it will be posted, its frame, fps,
 * fit and subtitle position.
 *
 * Changing it NEVER buys anything. A project with no pictures/clips yet simply
 * makes them in the new shape later. A project that has some keeps them: the
 * render crops / fits them locally ($0), and every image, clip and voice keeps
 * its reuse key. Making the assets again in the new shape is a separate act
 * (adoptShapeForNewAssets) that only changes what the NEXT run would buy - the
 * preflight then prices it and asks for approval as usual.
 */

export interface ProjectFormat {
  projectId: string;
  profile: OutputProfile & { inferred: boolean };
  platformLabel: string;
  hint: string;
  /** "9:16" - the frame the video is rendered in. */
  outputAspect: string;
  /** "9:16" - the shape pictures and clips are made in. */
  assetAspect: string;
  /** Pictures / clips already exist (so a new shape is fitted, not re-made). */
  hasVisualAssets: boolean;
  /** Set when the two shapes differ: what the render does about it. */
  note: string | null;
}

async function hasVisualAssets(projectId: string): Promise<boolean> {
  const [scenes, assets] = await Promise.all([
    prisma.scene.count({ where: { projectId, OR: [{ imagePath: { not: null } }, { videoPath: { not: null } }] } }),
    prisma.asset.count({ where: { projectId, kind: { in: ["image", "video"] } } }),
  ]);
  return scenes + assets > 0;
}

export async function projectFormat(projectId: string): Promise<ProjectFormat> {
  const [project, render, visual] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { aspectRatio: true } }),
    renderSettingsFor(projectId),
    hasVisualAssets(projectId),
  ]);
  const p = render.profile;
  const preset = platformPreset(p.platform);
  const outputAspect = aspectOf(p.width, p.height);
  return {
    projectId,
    profile: p,
    platformLabel: preset?.label ?? "Tùy chỉnh",
    hint: p.platform === "CUSTOM" ? viShape(p.width, p.height) : (preset?.hint ?? viShape(p.width, p.height)),
    outputAspect,
    assetAspect: project.aspectRatio,
    hasVisualAssets: visual,
    note: render.aspectNote,
  };
}

export interface FormatChange {
  format: ProjectFormat;
  /** True when pictures/clips will be MADE in the new shape (nothing existed yet). */
  assetShapeChanged: boolean;
  message: string;
}

/** "ĐỔI TỶ LỆ" / save advanced settings. Free: no request is sent, nothing is re-bought. */
export async function setOutputProfile(projectId: string, input: Partial<OutputProfile>): Promise<FormatChange> {
  const checked = validateProfile(input);
  if (!checked.ok) throw new Error(checked.message);
  const profile = checked.profile;
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { aspectRatio: true, status: true } });
  const before = (await renderSettingsFor(projectId)).profile;
  const visual = await hasVisualAssets(projectId);
  const wanted = generationAspectFor(profile.width, profile.height);
  // Nothing made yet: the pictures and clips will simply be made in the new
  // shape. Something made: it is kept and fitted locally - never re-bought.
  const assetShapeChanged = !visual && wanted !== project.aspectRatio;
  // A finished video in the old format is rendered again - locally, $0 - the
  // next time TIẾP TỤC / Render lại runs; nothing else changes.
  const renderChanged =
    before.width !== profile.width ||
    before.height !== profile.height ||
    before.fps !== profile.fps ||
    before.fit !== profile.fit ||
    before.subtitleBottomPct !== profile.subtitleBottomPct;
  await prisma.project.update({
    where: { id: projectId },
    data: {
      outputProfileJson: JSON.stringify(profile),
      ...(assetShapeChanged ? { aspectRatio: wanted } : {}),
      ...(renderChanged && project.status === "completed" ? { status: "media_ready" } : {}),
    },
  });
  const format = await projectFormat(projectId);
  const out = aspectOf(profile.width, profile.height);
  const message =
    (visual && out !== project.aspectRatio
      ? `Đã đổi sang ${format.platformLabel} (${out}). Ảnh/video đã tạo được giữ lại và sẽ được khớp khung khi render. Không phát sinh phí API.`
      : `Đã đổi sang ${format.platformLabel} (${out}). Không phát sinh phí API.`) +
    (renderChanged && project.status === "completed" ? " Bấm TIẾP TỤC hoặc Render lại để xuất theo định dạng mới (tại máy, $0)." : "");
  await logger.info({ event: "project.format_changed", projectId, message: `${message} (${profile.width}x${profile.height}@${profile.fps}, ${profile.fit})` });
  return { format, assetShapeChanged, message };
}

/**
 * What re-making the pictures and AI clips in the output's shape would cost -
 * the price of each scene's picture and clip as they are routed today. An
 * estimate; the real figure is the preflight's, after the person agrees.
 */
export async function reshapeEstimate(projectId: string): Promise<{ image: number; video: number; images: number; clips: number }> {
  const { previewProjectCost } = await import("./project-service");
  const preview = await previewProjectCost(projectId);
  const scenes = await prisma.scene.findMany({ where: { projectId, skipped: false }, select: { sceneNumber: true, imageSource: true } });
  let image = 0;
  let video = 0;
  let images = 0;
  let clips = 0;
  for (const plan of preview.current.scenes) {
    const imported = scenes.find((s) => s.sceneNumber === plan.sceneNumber)?.imageSource === "IMPORTED";
    const img = imported ? 0 : (plan.image?.estimatedCost || plan.saved.image || 0);
    const clip = plan.motionSource === "LOCAL_MOTION" ? 0 : plan.video?.estimatedCost || plan.saved.video || 0;
    if (img > 0) images += 1;
    if (clip > 0) clips += 1;
    image += img;
    video += clip;
  }
  return { image: round(image), video: round(video), images, clips };
}

/**
 * "Tạo lại asset theo tỷ lệ mới": from now on pictures and clips are MADE in
 * the output's shape. Nothing is bought here - the next DUYỆT & CHẠY / TIẾP TỤC
 * preflight prices the new pictures and clips and asks for approval. Imported
 * pictures stay the person's own (fitted locally); voices are unaffected.
 */
export async function adoptShapeForNewAssets(projectId: string): Promise<{ aspectRatio: string; message: string }> {
  const format = await projectFormat(projectId);
  const wanted = generationAspectFor(format.profile.width, format.profile.height);
  await prisma.project.update({ where: { id: projectId }, data: { aspectRatio: wanted } });
  const message =
    `Ảnh/clip mới sẽ được tạo theo khung ${wanted}. CHƯA gửi request nào — lần chạy tới sẽ hiện chi phí ` +
    `và cần bạn duyệt. Ảnh nhập và giọng đọc giữ nguyên.`;
  await logger.info({ event: "project.asset_shape_changed", projectId, message });
  return { aspectRatio: wanted, message };
}
