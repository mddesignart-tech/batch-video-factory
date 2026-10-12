import fs from "node:fs";
import type { Project } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { toAbsolute } from "@/lib/paths";
import { controlsOf, type OutputControls, type SubtitleLayout } from "@/domain/output-controls";
import {
  LOGO_MISSING_MESSAGE,
  logoAlphaWarning,
  logoPlacement,
  logoSubtitleClash,
  type LogoPlacement,
  type LogoSubtitleClash,
} from "@/domain/logo-overlay";
import { probeDimensions } from "@/media/ffmpeg";
import type { RenderLogo } from "@/media/render";

/**
 * LOGO OVERLAY: a project's LOGO Reference on its finished video. Local FFmpeg
 * only - no Image AI, no Video AI, no request of any kind ($0). The logo's own
 * file is used as it is (shape, colours, transparency); a missing file never
 * fails the video and is never "regenerated".
 */

export interface LogoReferenceOption {
  id: string;
  name: string;
  /** The reference's main picture, data-relative; null when it has none. */
  path: string | null;
  filename: string | null;
  width: number | null;
  height: number | null;
  exists: boolean;
}

/** The project's LOGO References (only those - never another kind of reference). */
export async function projectLogoReferences(projectId: string): Promise<LogoReferenceOption[]> {
  const refs = await prisma.referenceAsset.findMany({
    where: { projectId, referenceType: "LOGO" },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });
  if (refs.length === 0) return [];
  const images = await prisma.asset.findMany({
    where: { referenceAssetId: { in: refs.map((r) => r.id) } },
    orderBy: { createdAt: "asc" },
  });
  return refs.map((r) => {
    const own = images.filter((a) => a.referenceAssetId === r.id);
    const main = own.find((a) => a.id === r.assetId) ?? own[0] ?? null;
    let exists = false;
    try {
      exists = !!main && fs.existsSync(toAbsolute(main.filePath));
    } catch {
      exists = false;
    }
    return {
      id: r.id,
      name: r.name,
      path: main?.filePath ?? null,
      filename: main?.originalFilename ?? null,
      width: main?.width ?? null,
      height: main?.height ?? null,
      exists,
    };
  });
}

export class LogoSettingsError extends Error {}

/** A save that turns the logo on must name one of this project's LOGO References. */
export async function checkLogoChoice(projectId: string, logo: OutputControls["logo"]): Promise<void> {
  if (!logo.enabled && !logo.referenceId) return;
  if (!logo.referenceId) {
    if (logo.enabled) throw new LogoSettingsError("Hãy chọn một LOGO Reference trước khi bật logo.");
    return;
  }
  const ref = await prisma.referenceAsset.findFirst({ where: { id: logo.referenceId, projectId } });
  if (!ref || ref.referenceType !== "LOGO") throw new LogoSettingsError("Chỉ dùng được tham chiếu loại LOGO của dự án này làm logo.");
  if (logo.startSec !== null && logo.endSec !== null && logo.endSec <= logo.startSec) {
    throw new LogoSettingsError("Thời điểm kết thúc logo phải sau thời điểm bắt đầu.");
  }
}

export interface LogoState {
  enabled: boolean;
  reference: LogoReferenceOption | null;
  /** Turned on, but the logo's file (or the reference) is gone. */
  missing: boolean;
  missingMessage: string | null;
  alphaWarning: string | null;
  placement: LogoPlacement | null;
  clash: LogoSubtitleClash | null;
}

async function logoSize(option: LogoReferenceOption): Promise<{ width: number; height: number } | null> {
  if (option.width && option.height) return { width: option.width, height: option.height };
  if (!option.path) return null;
  return probeDimensions(toAbsolute(option.path));
}

/**
 * Everything the card and the render need to know about the logo: which one,
 * whether its file is there, where it lands on this frame, and whether it
 * would cover the captions. `subtitles` = the burnt-in caption layout, or null
 * when captions are off.
 */
export async function logoState(
  project: Pick<Project, "id" | "contentType" | "outputControlsJson">,
  frame: { width: number; height: number },
  subtitles: SubtitleLayout | null,
): Promise<LogoState> {
  const c = controlsOf(project).logo;
  const off: LogoState = { enabled: false, reference: null, missing: false, missingMessage: null, alphaWarning: null, placement: null, clash: null };
  if (!c.referenceId) return { ...off, enabled: c.enabled };
  const reference = (await projectLogoReferences(project.id)).find((r) => r.id === c.referenceId) ?? null;
  const size = reference?.exists ? await logoSize(reference) : null;
  const missing = !reference || !reference.exists || !size;
  if (missing) {
    return { ...off, enabled: c.enabled, reference, missing: c.enabled, missingMessage: c.enabled ? LOGO_MISSING_MESSAGE : null };
  }
  const placement = logoPlacement(c, frame, size);
  return {
    enabled: c.enabled,
    reference,
    missing: false,
    missingMessage: null,
    alphaWarning: logoAlphaWarning(reference.filename ?? reference.path ?? ""),
    placement,
    clash: logoSubtitleClash(placement, subtitles, frame, c.position),
  };
}

/**
 * The logo for a render request, or undefined (off / missing). A missing file
 * leaves the logo out and says so in the log; the video still renders.
 */
export async function renderLogoFor(
  project: Pick<Project, "id" | "contentType" | "outputControlsJson">,
  frame: { width: number; height: number },
  subtitles: SubtitleLayout | null,
): Promise<RenderLogo | undefined> {
  const c = controlsOf(project).logo;
  if (!c.enabled) return undefined;
  const state = await logoState(project, frame, subtitles);
  if (state.missing || !state.placement || !state.reference?.path) {
    await logger.warn({
      event: "output.logo_missing",
      projectId: project.id,
      message: `${LOGO_MISSING_MESSAGE} Video được render không có logo. Chọn lại logo hoặc tắt logo. Không gọi Image AI.`,
    });
    return undefined;
  }
  if (state.clash) {
    await logger.warn({ event: "output.logo_subtitle_clash", projectId: project.id, message: state.clash.message });
  }
  return {
    path: toAbsolute(state.reference.path),
    ...state.placement,
    opacity: c.opacity,
    startSec: c.startSec,
    endSec: c.endSec,
  };
}
