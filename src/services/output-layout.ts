import { aspectOf, parseProfile, platformForSize, platformPreset, VI_FIT_MODE, type OutputProfile } from "@/domain/platform-profile";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { DATA_ROOT, toAbsolute, toRelative } from "@/lib/paths";
import { getSettings, type AppSettings } from "@/lib/settings";
import { withSemaphore } from "@/lib/semaphore";
import { safeSlug, uniqueSlug } from "@/domain/output-naming";
import { findPreset, presetAspect, presetRender, resolvePreset, type OutputPreset, type PresetRender } from "@/domain/output-preset";
import { targetForAspect } from "@/media/render";

/**
 * Where a finished video goes, and how it is rendered (V1.2 Phase 6, QĐ-114).
 *
 *   data/output/<batch-slug>/<video-slug>/
 *
 * Both slugs are assigned ONCE and stored (Batch.slug, Project.outputSlug), so
 * renaming a video later never moves its folder, and two videos with the same
 * title get "-2". A video outside any batch goes under "video-le".
 *
 * Compatibility: a video exported before Phase 6 lives in the legacy
 * data/output/<title-slug>-<id8>/ folder. That folder keeps working - it is
 * found, re-exported in place and opened - and is never moved or deleted.
 */

export const OUTPUT_ROOT = path.join(DATA_ROOT, "output");
export const LOOSE_VIDEOS_SLUG = "video-le";

/** The pre-Phase-6 folder name. Kept so existing exports stay valid. */
export function legacyOutputDirFor(project: { id: string; title: string }): string {
  return path.join(OUTPUT_ROOT, `${legacySlug(project.title) || "video"}-${project.id.slice(0, 8)}`);
}

/** Exactly V1's slug (lib/utils slugify, cut at 60) - the legacy name must not drift. */
function legacySlug(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .slice(0, 60);
}

/**
 * The export folder of a project, synchronously, from the row: the stored
 * Phase 6 folder when there is one, else the legacy folder.
 */
export function outputDirFor(project: { id: string; title: string; outputDir?: string | null }): string {
  if (project.outputDir) return toAbsolute(project.outputDir);
  return legacyOutputDirFor(project);
}

function existingDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Batch.slug, assigned on first use. Unique across batches and existing folders. */
export async function ensureBatchSlug(batchId: string): Promise<string> {
  return withSemaphore("output-slug", 1, async () => {
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId }, select: { slug: true, name: true } });
    if (batch.slug) return batch.slug;
    const taken = await prisma.batch.findMany({ where: { slug: { not: null } }, select: { slug: true } });
    const slug = uniqueSlug(safeSlug(batch.name, "lo-video"), [
      ...taken.map((t) => t.slug!),
      ...existingDirs(OUTPUT_ROOT),
      LOOSE_VIDEOS_SLUG,
    ]);
    await prisma.batch.update({ where: { id: batchId }, data: { slug } });
    return slug;
  });
}

/**
 * The Phase 6 folder of a project, assigning slugs on first use. Returns the
 * absolute folder; the relative form is stored on the row.
 */
export async function ensureOutputDir(projectId: string): Promise<string> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { id: true, title: true, batchId: true, outputDir: true, outputSlug: true },
  });
  if (project.outputDir) return toAbsolute(project.outputDir);

  // A legacy export that already exists is honoured where it is.
  const legacy = legacyOutputDirFor(project);
  if (fs.existsSync(path.join(legacy, "final.mp4"))) {
    await prisma.project.update({ where: { id: projectId }, data: { outputDir: toRelative(legacy) } });
    return legacy;
  }

  const batchSlug = project.batchId ? await ensureBatchSlug(project.batchId) : LOOSE_VIDEOS_SLUG;
  return withSemaphore("output-slug", 1, async () => {
    const fresh = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { outputDir: true } });
    if (fresh.outputDir) return toAbsolute(fresh.outputDir);
    const batchRoot = path.join(OUTPUT_ROOT, batchSlug);
    const siblings = await prisma.project.findMany({
      where: project.batchId ? { batchId: project.batchId, outputSlug: { not: null } } : { batchId: null, outputSlug: { not: null } },
      select: { outputSlug: true },
    });
    const videoSlug =
      project.outputSlug ??
      uniqueSlug(safeSlug(project.title, "video"), [...siblings.map((s) => s.outputSlug!), ...existingDirs(batchRoot)]);
    const dir = path.join(batchRoot, videoSlug);
    await prisma.project.update({
      where: { id: projectId },
      data: { outputSlug: videoSlug, outputDir: toRelative(dir) },
    });
    return dir;
  });
}

// ------------------------------------------------------------ presets ---

export interface ProjectRenderSettings {
  preset: OutputPreset;
  /** The project's output profile (QĐ-121): stored, or inferred for an older project. */
  profile: OutputProfile & { inferred: boolean };
  /** True when the batch named a preset; false = Settings default. */
  explicit: boolean;
  render: PresetRender;
  /** Set when the preset's shape differs from the video's (frames get cropped). */
  aspectNote: string | null;
}

/**
 * How THIS project is rendered and exported.
 *
 *   batch names a preset   -> exactly that preset (a different shape is cropped,
 *                             with a note);
 *   no preset on the batch -> Settings' default preset when it has the video's
 *                             own shape, else the video's own shape (V1); the
 *                             Settings "burn subtitles" switch still applies.
 *
 * With the defaults (YouTube Shorts, 9:16 video, burn on) this is exactly the
 * V1 render, so no existing recipe changes and nothing is rendered again.
 */
export function renderSettingsFrom(
  project: { aspectRatio: string; outputProfileJson?: string | null },
  batchPresetId: string | null | undefined,
  settings: Pick<AppSettings, "defaultOutputPresetId" | "customPresets" | "burnSubtitles">,
): ProjectRenderSettings {
  // A profile the person chose for THIS video wins over the batch / Settings
  // preset (QĐ-121): frame size and fps from the profile, subtitles / thumbnail
  // / text files from the platform's export preset. Fit and subtitle position
  // go to the renderer; never a re-purchase - assets of another shape are
  // cropped or fitted locally.
  const chosen = parseProfile(project.outputProfileJson);
  if (chosen) {
    const preset =
      findPreset(platformPreset(chosen.platform)?.exportPresetId, settings.customPresets) ??
      resolvePreset(null, settings.defaultOutputPresetId, settings.customPresets);
    const fromPreset = presetRender(preset);
    const outAspect = aspectOf(chosen.width, chosen.height);
    return {
      preset,
      profile: { ...chosen, inferred: false },
      explicit: true,
      render: {
        target: { width: chosen.width, height: chosen.height, fps: chosen.fps },
        burnSubtitles: fromPreset.burnSubtitles && settings.burnSubtitles,
        ...(fromPreset.encode ? { encode: fromPreset.encode } : {}),
        ...(chosen.fit !== "AUTO" ? { fit: chosen.fit } : {}),
        ...(chosen.subtitleBottomPct !== null ? { subtitleBottomPct: chosen.subtitleBottomPct } : {}),
      },
      aspectNote:
        outAspect === project.aspectRatio
          ? null
          : `Ảnh/clip được tạo cho khung ${project.aspectRatio}, video xuất ${outAspect}: khớp khung tại máy (${VI_FIT_MODE[chosen.fit]}), không tạo lại ảnh/clip, $0.`,
    };
  }
  const explicit = Boolean(batchPresetId) && resolvePreset(batchPresetId, null, settings.customPresets).id === batchPresetId;
  const preset = resolvePreset(explicit ? batchPresetId : null, settings.defaultOutputPresetId, settings.customPresets);
  const fromPreset = presetRender(preset);
  if (explicit) {
    const shape = presetAspect(preset);
    return {
      preset,
      profile: { ...profileOf(fromPreset.target), inferred: true },
      explicit,
      render: fromPreset,
      aspectNote:
        shape === project.aspectRatio
          ? null
          : `Preset ${preset.name} (${shape}) khác khung video (${project.aspectRatio}): khung hình được cắt để lấp đầy, không tạo lại ảnh/clip.`,
    };
  }
  const sameShape = presetAspect(preset) === project.aspectRatio;
  const target = sameShape ? fromPreset.target : targetForAspect(project.aspectRatio);
  return {
    preset,
    profile: { ...profileOf(target), inferred: true },
    explicit,
    render: {
      target,
      burnSubtitles: fromPreset.burnSubtitles && settings.burnSubtitles,
      ...(fromPreset.encode ? { encode: fromPreset.encode } : {}),
    },
    aspectNote: null,
  };
}

export async function renderSettingsFor(projectId: string): Promise<ProjectRenderSettings> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { aspectRatio: true, outputProfileJson: true, batch: { select: { outputPresetId: true } } },
  });
  return renderSettingsFrom(project, project.batch?.outputPresetId ?? null, await getSettings());
}

/** The inferred profile of a render target (an older project's frame). */
function profileOf(target: { width: number; height: number; fps: number }): OutputProfile {
  return { platform: platformForSize(target.width, target.height), width: target.width, height: target.height, fps: target.fps, fit: "AUTO", subtitleBottomPct: null };
}
