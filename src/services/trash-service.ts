import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { DATA_ROOT, ensureProjectDirs, projectSubdir, toAbsolute, toRelative } from "@/lib/paths";

/**
 * QĐ-152 TRASH - scenes, exported videos and projects go to a trash first
 * (soft delete) and can be restored. Only a PERMANENT delete removes rows, and
 * then only files that are proven unused:
 *
 *   - the file lies inside the deleted thing's own folder
 *     (data/projects/<id>/...), never a shared library, never outside data/;
 *   - no row of any table still names it (every text column of the database
 *     is scanned, JSON included) and no other video's remix manifest names it;
 *   - it is a regular file (a symlink is never followed or removed).
 *
 * Rows are deleted first (one transaction); files after. A file that cannot be
 * removed is reported and left in place - it can never be referenced again by
 * a row that no longer exists, and the cleanup report will list it as orphan.
 *
 * Nothing here calls an AI provider: $0.
 */

export class TrashBlockedError extends Error {}

const PROJECTS_ROOT = path.join(DATA_ROOT, "projects");
const OUTPUT_ROOT = path.join(DATA_ROOT, "output");
const ACTIVE = ["queued", "processing"];

// ------------------------------------------------------------------ guards ---

/** Work that must not lose its files: a running/queued job, or a render in progress. */
async function activeWork(projectId: string, types?: string[]): Promise<string | null> {
  const jobs = await prisma.job.findMany({
    where: { projectId, status: { in: ACTIVE }, ...(types ? { type: { in: types } } : {}) },
    select: { type: true, status: true },
  });
  if (jobs.length > 0) {
    return `Dự án đang có ${jobs.length} việc ${jobs.some((j) => j.status === "processing") ? "đang chạy" : "đang chờ"} (${[...new Set(jobs.map((j) => j.type))].join(", ")}). Hãy đợi xong hoặc huỷ trước.`;
  }
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { status: true } });
  if (!types && p?.status === "rendering") return "Dự án đang render. Hãy đợi render xong.";
  return null;
}

async function assertIdle(projectId: string, types?: string[]): Promise<void> {
  const busy = await activeWork(projectId, types);
  if (busy) throw new TrashBlockedError(busy);
}

/** A finished video no longer matches its storyboard: say so (never re-render on its own). */
async function markStoryboardChanged(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  const p = await tx.project.findUnique({ where: { id: projectId }, select: { status: true } });
  if (p?.status === "completed") await tx.project.update({ where: { id: projectId }, data: { status: "media_ready" } });
}

// ---------------------------------------------------------------- ordering ---

/** Live scenes 1..N in their current order (two passes: sceneNumber is unique per project). */
async function renumber(tx: Prisma.TransactionClient, projectId: string, orderedIds: string[]): Promise<void> {
  for (const [i, id] of orderedIds.entries()) await tx.scene.update({ where: { id }, data: { sceneNumber: 1_000_000 + i } });
  for (const [i, id] of orderedIds.entries()) await tx.scene.update({ where: { id }, data: { sceneNumber: i + 1 } });
}

async function liveOrder(tx: Prisma.TransactionClient, projectId: string): Promise<string[]> {
  return (await tx.scene.findMany({ where: { projectId, deletedAt: null }, orderBy: { sceneNumber: "asc" }, select: { id: true } })).map((s) => s.id);
}

async function nextTrashNumber(tx: Prisma.TransactionClient, projectId: string): Promise<number> {
  const min = await tx.scene.aggregate({ where: { projectId, sceneNumber: { lt: 0 } }, _min: { sceneNumber: true } });
  return Math.min(-1, (min._min.sceneNumber ?? 0) - 1);
}

// ------------------------------------------------------------------ scenes ---

export async function deleteScene(sceneId: string): Promise<{ sceneNumber: number; projectId: string }> {
  const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
  if (!scene) throw new TrashBlockedError("Không tìm thấy cảnh.");
  if (scene.deletedAt) throw new TrashBlockedError("Cảnh này đã ở trong Thùng rác.");
  await assertIdle(scene.projectId);
  await prisma.$transaction(async (tx) => {
    await tx.scene.update({
      where: { id: sceneId },
      data: {
        deletedAt: new Date(),
        deletedFromNumber: scene.sceneNumber,
        deletedWasSkipped: scene.skipped,
        // Also "skipped": every path that already leaves skipped scenes out
        // (generation, render, estimates) leaves a deleted one out too.
        skipped: true,
        sceneNumber: await nextTrashNumber(tx, scene.projectId),
      },
    });
    await renumber(tx, scene.projectId, await liveOrder(tx, scene.projectId));
    await markStoryboardChanged(tx, scene.projectId);
  });
  await logger.info({ event: "trash.scene_deleted", projectId: scene.projectId, sceneId, message: `Đã chuyển cảnh ${scene.sceneNumber} vào Thùng rác (có thể khôi phục). Không tạo lại gì, $0.` });
  return { sceneNumber: scene.sceneNumber, projectId: scene.projectId };
}

/** Back into the storyboard at `position` (1-based; default: where it was), clamped to the current length. */
export async function restoreScene(sceneId: string, position?: number): Promise<{ sceneNumber: number; projectId: string }> {
  const scene = await prisma.scene.findUnique({ where: { id: sceneId }, include: { project: { select: { deletedAt: true } } } });
  if (!scene?.deletedAt) throw new TrashBlockedError("Cảnh này không ở trong Thùng rác.");
  if (scene.project.deletedAt) throw new TrashBlockedError("Dự án của cảnh này đang ở Thùng rác - hãy khôi phục dự án trước.");
  await assertIdle(scene.projectId);
  let at = 0;
  await prisma.$transaction(async (tx) => {
    const order = await liveOrder(tx, scene.projectId);
    at = Math.min(Math.max(1, Math.round(position ?? scene.deletedFromNumber ?? order.length + 1)), order.length + 1);
    order.splice(at - 1, 0, sceneId);
    await tx.scene.update({ where: { id: sceneId }, data: { deletedAt: null, deletedFromNumber: null, skipped: scene.deletedWasSkipped, deletedWasSkipped: false } });
    await renumber(tx, scene.projectId, order);
    await markStoryboardChanged(tx, scene.projectId);
  });
  await logger.info({ event: "trash.scene_restored", projectId: scene.projectId, sceneId, message: `Đã khôi phục cảnh vào vị trí ${at}.` });
  return { sceneNumber: at, projectId: scene.projectId };
}

/**
 * A copy right after the original: its own id, the same words, picture, voice,
 * camera and settings. Media FILES are shared, never copied or regenerated:
 * every later regeneration writes a NEW file (uuid name), so changing the copy
 * can never change the original. $0.
 */
export async function duplicateScene(sceneId: string): Promise<{ sceneId: string; sceneNumber: number; projectId: string }> {
  const scene = await prisma.scene.findUnique({ where: { id: sceneId }, include: { dialogueLines: true } });
  if (!scene || scene.deletedAt) throw new TrashBlockedError("Không tìm thấy cảnh.");
  await assertIdle(scene.projectId);
  const newId = randomUUID();
  const { id: _id, createdAt: _c, updatedAt: _u, dialogueLines, ...fields } = scene;
  let at = 0;
  await prisma.$transaction(async (tx) => {
    const order = await liveOrder(tx, scene.projectId);
    at = order.indexOf(sceneId) + 2;
    await tx.scene.create({ data: { ...fields, id: newId, sceneNumber: 2_000_000, actualCost: 0, deletedAt: null, deletedFromNumber: null, deletedWasSkipped: false } });
    for (const line of dialogueLines) {
      const { id: _lid, sceneId: _sid, createdAt: _lc, updatedAt: _lu, ...lf } = line;
      await tx.dialogueLine.create({ data: { ...lf, sceneId: newId, actualCost: 0 } });
    }
    order.splice(at - 1, 0, newId);
    await renumber(tx, scene.projectId, order);
    await markStoryboardChanged(tx, scene.projectId);
  });
  await logger.info({ event: "trash.scene_duplicated", projectId: scene.projectId, sceneId: newId, message: `Đã nhân bản cảnh ${scene.sceneNumber} thành cảnh ${at} (dùng lại ảnh/giọng có sẵn, $0).` });
  return { sceneId: newId, sceneNumber: at, projectId: scene.projectId };
}

// ----------------------------------------------------------- video outputs ---

export interface OutputView {
  assetId: string;
  file: string;
  name: string;
  createdAt: string;
  bytes: number | null;
  exists: boolean;
  current: boolean;
  deletedAt: string | null;
  remixSources: boolean;
  /** "remix-audio" or the encoder. */
  kind: string;
}

export async function listOutputs(projectId: string): Promise<OutputView[]> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { finalVideoPath: true } });
  const assets = await prisma.asset.findMany({ where: { projectId, kind: "final" }, orderBy: { createdAt: "desc" } });
  return assets.map((a) => {
    const abs = toAbsolute(a.filePath);
    const exists = fs.existsSync(abs);
    const base = path.basename(a.filePath, path.extname(a.filePath));
    return {
      assetId: a.id,
      file: a.filePath,
      name: path.basename(a.filePath),
      createdAt: a.createdAt.toISOString(),
      bytes: exists ? fs.statSync(abs).size : (a.bytes ?? null),
      exists,
      current: project?.finalVideoPath === a.filePath && !a.deletedAt,
      deletedAt: a.deletedAt?.toISOString() ?? null,
      remixSources: fs.existsSync(path.join(toAbsolute(projectSubdir(projectId, "audio")), "renders", base, "manifest.json")),
      kind: a.model,
    };
  });
}

/** An exported video to the trash. The project, its scenes, sources and other videos are untouched. */
export async function deleteOutput(assetId: string): Promise<{ projectId: string; newCurrent: string | null }> {
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset || asset.kind !== "final") throw new TrashBlockedError("Không tìm thấy video đã xuất.");
  if (asset.deletedAt) throw new TrashBlockedError("Video này đã ở trong Thùng rác.");
  // A remix reads the current MP4; a render replaces it.
  await assertIdle(asset.projectId, ["remix_audio", "render_final"]);
  let newCurrent: string | null = null;
  await prisma.$transaction(async (tx) => {
    await tx.asset.update({ where: { id: assetId }, data: { deletedAt: new Date() } });
    const project = await tx.project.findUniqueOrThrow({ where: { id: asset.projectId } });
    if (project.finalVideoPath === asset.filePath) {
      // The video shown for the project becomes the newest one still kept (if any).
      const others = await tx.asset.findMany({ where: { projectId: asset.projectId, kind: "final", deletedAt: null, id: { not: assetId } }, orderBy: { createdAt: "desc" } });
      const next = others.find((o) => fs.existsSync(toAbsolute(o.filePath))) ?? null;
      newCurrent = next?.filePath ?? null;
      await tx.project.update({
        where: { id: asset.projectId },
        // The recipe described the deleted file: a later RENDER LẠI must not skip.
        data: { finalVideoPath: newCurrent, renderRecipe: null, ...(newCurrent ? {} : project.status === "completed" ? { status: "media_ready" } : {}) },
      });
    }
  });
  if (newCurrent) {
    try {
      const { exportProjectOutput } = await import("./output-export");
      await exportProjectOutput(asset.projectId);
    } catch {
      // the output folder is refreshed on the next render
    }
  }
  await logger.info({ event: "trash.output_deleted", projectId: asset.projectId, message: `Đã chuyển ${path.basename(asset.filePath)} vào Thùng rác (file vẫn còn trên đĩa đến khi xoá vĩnh viễn).` });
  return { projectId: asset.projectId, newCurrent };
}

export async function restoreOutput(assetId: string): Promise<{ projectId: string }> {
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, include: { project: { select: { deletedAt: true, finalVideoPath: true } } } });
  if (!asset?.deletedAt) throw new TrashBlockedError("Video này không ở trong Thùng rác.");
  if (asset.project.deletedAt) throw new TrashBlockedError("Dự án của video này đang ở Thùng rác - hãy khôi phục dự án trước.");
  if (!fs.existsSync(toAbsolute(asset.filePath))) throw new TrashBlockedError("File video không còn trên đĩa - không khôi phục được.");
  await prisma.$transaction(async (tx) => {
    await tx.asset.update({ where: { id: assetId }, data: { deletedAt: null } });
    // Shown again only when the project has no video at all.
    if (!asset.project.finalVideoPath) await tx.project.update({ where: { id: asset.projectId }, data: { finalVideoPath: asset.filePath } });
  });
  return { projectId: asset.projectId };
}

// ---------------------------------------------------------------- projects ---

export async function trashProjects(ids: string[]): Promise<{ id: string; title: string; ok: boolean; message: string }[]> {
  const out: { id: string; title: string; ok: boolean; message: string }[] = [];
  for (const id of [...new Set(ids)]) {
    const p = await prisma.project.findUnique({ where: { id } });
    if (!p) {
      out.push({ id, title: id, ok: false, message: "Không tìm thấy." });
      continue;
    }
    if (p.deletedAt) {
      out.push({ id, title: p.title, ok: false, message: "Đã ở trong Thùng rác." });
      continue;
    }
    const processing = await prisma.job.count({ where: { projectId: id, status: "processing" } });
    if (processing > 0 || p.status === "rendering") {
      out.push({ id, title: p.title, ok: false, message: "Đang có việc chạy - chưa xoá. Hãy đợi xong." });
      continue;
    }
    // Waiting jobs would run on a project nobody can see: cancelled.
    const { count } = await prisma.job.updateMany({ where: { projectId: id, status: "queued" }, data: { status: "cancelled", finishedAt: new Date(), error: "Dự án đã chuyển vào Thùng rác" } });
    await prisma.project.update({ where: { id }, data: { deletedAt: new Date() } });
    await logger.info({ event: "trash.project_deleted", projectId: id, message: `Đã chuyển dự án "${p.title}" vào Thùng rác${count ? ` (huỷ ${count} việc đang chờ)` : ""}. File chưa bị xoá.` });
    out.push({ id, title: p.title, ok: true, message: "Đã chuyển vào Thùng rác." });
  }
  return out;
}

export async function restoreProject(id: string): Promise<void> {
  const p = await prisma.project.findUnique({ where: { id } });
  if (!p?.deletedAt) throw new TrashBlockedError("Dự án này không ở trong Thùng rác.");
  await prisma.project.update({ where: { id }, data: { deletedAt: null } });
  await logger.info({ event: "trash.project_restored", projectId: id, message: `Đã khôi phục dự án "${p.title}".` });
}

/** Paths under projects/<oldId>/ inside a string (a path field or a JSON blob). */
function projectPathsIn(text: string | null | undefined, projectId: string): string[] {
  if (!text) return [];
  const re = new RegExp(`projects[\\\\/]+${projectId}[\\\\/]+[^"'\\s,)\\]}]+`, "gi");
  return [...text.matchAll(re)].map((m) => m[0]!.replace(/\\+/g, "/"));
}

function remap(text: string | null | undefined, from: string, to: string): string | null {
  if (text == null) return text ?? null;
  return text.replace(new RegExp(`(projects[\\\\/]+)${from}([\\\\/]+)`, "gi"), `$1${to}$2`);
}

/**
 * NHÂN BẢN DỰ ÁN: a new project with its own ids - live scenes, lines, pictures,
 * clips, voices, music, references, camera, audio mixer, subtitles, render
 * settings - and NOT its render history, jobs or costs. Files of the project's
 * own folder are COPIED into the new folder (so editing or deleting either
 * project can never break the other); files it borrows from outside its folder
 * (a shared library) stay shared and are never deleted with either project.
 * No AI request of any kind, nothing rendered.
 */
export async function duplicateProject(id: string): Promise<{ id: string; title: string; filesCopied: number; bytesCopied: number }> {
  const src = await prisma.project.findUnique({
    where: { id },
    include: { scenes: { where: { deletedAt: null }, orderBy: { sceneNumber: "asc" }, include: { dialogueLines: true } }, assets: { where: { deletedAt: null, NOT: { kind: "final" } } } },
  });
  if (!src) throw new TrashBlockedError("Không tìm thấy dự án.");
  if (src.deletedAt) throw new TrashBlockedError("Dự án đang ở Thùng rác - hãy khôi phục trước khi nhân bản.");
  const refs = await prisma.referenceAsset.findMany({ where: { projectId: id } });
  const newId = randomUUID();

  // 1. Files of the source folder that the copy will name.
  const named = new Set<string>();
  const collect = (t: string | null | undefined) => projectPathsIn(t, id).forEach((p) => named.add(p));
  for (const s of src.scenes) {
    [s.imagePath, s.videoPath, s.audioPath, s.scenePlanJson, s.referenceManualJson].forEach(collect);
    s.dialogueLines.forEach((l) => collect(l.outputPath));
  }
  src.assets.forEach((a) => collect(a.filePath));
  collect(src.thumbnailChoiceJson);
  ensureProjectDirs(newId);
  let filesCopied = 0;
  let bytesCopied = 0;
  const newRoot = path.join(PROJECTS_ROOT, newId);
  try {
    for (const rel of named) {
      const from = toAbsolute(rel);
      const to = toAbsolute(remap(rel, id, newId)!);
      if (!inside(from, path.join(PROJECTS_ROOT, id)) || !inside(to, newRoot)) continue;
      const st = fs.lstatSync(from, { throwIfNoEntry: false });
      if (!st?.isFile()) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      filesCopied += 1;
      bytesCopied += st.size;
    }

    // 2. Rows, all in one transaction.
    const assetMap = new Map<string, string>();
    src.assets.forEach((a) => assetMap.set(a.id, randomUUID()));
    const refMap = new Map<string, string>();
    refs.forEach((r) => refMap.set(r.id, randomUUID()));
    const remapIds = (text: string | null | undefined) => {
      let t = text ?? "";
      for (const [a, b] of refMap) t = t.split(a).join(b);
      return t;
    };
    await prisma.$transaction(async (tx) => {
      const { id: _i, createdAt: _c, updatedAt: _u, scenes: _s, assets: _a, ...pf } = src;
      await tx.project.create({
        data: {
          ...pf,
          id: newId,
          title: `${src.title} - Bản sao`,
          batchId: null,
          status: src.status === "completed" || src.status === "rendering" ? "media_ready" : src.status,
          finalVideoPath: null,
          subtitlePath: null,
          renderRecipe: null,
          outputSlug: null,
          outputDir: null,
          exportReadyJson: null,
          runStartedAt: null,
          runFinishedAt: null,
          currentStep: null,
          queueOrder: null,
          errorMessage: null,
          actualCost: 0,
          deletedAt: null,
          thumbnailChoiceJson: remap(src.thumbnailChoiceJson, id, newId),
          backgroundMusicAssetId: src.backgroundMusicAssetId ? (assetMap.get(src.backgroundMusicAssetId) ?? src.backgroundMusicAssetId) : null,
        },
      });
      for (const r of refs) {
        const { id: rid, createdAt: _rc, updatedAt: _ru, ...rf } = r;
        await tx.referenceAsset.create({ data: { ...rf, id: refMap.get(rid)!, projectId: newId, assetId: r.assetId ? (assetMap.get(r.assetId) ?? r.assetId) : null } });
      }
      for (const a of src.assets) {
        const { id: aid, createdAt: _ac, sceneId: _sid, ...af } = a;
        await tx.asset.create({ data: { ...af, id: assetMap.get(aid)!, projectId: newId, sceneId: null, filePath: remap(a.filePath, id, newId)!, referenceAssetId: a.referenceAssetId ? (refMap.get(a.referenceAssetId) ?? a.referenceAssetId) : null } });
      }
      for (const [i, s] of src.scenes.entries()) {
        const { id: _sid, createdAt: _sc, updatedAt: _su, dialogueLines, projectId: _p, ...sf } = s;
        const sceneId = randomUUID();
        await tx.scene.create({
          data: {
            ...sf,
            id: sceneId,
            projectId: newId,
            sceneNumber: i + 1,
            actualCost: 0,
            imagePath: remap(s.imagePath, id, newId),
            videoPath: remap(s.videoPath, id, newId),
            audioPath: remap(s.audioPath, id, newId),
            scenePlanJson: remap(s.scenePlanJson, id, newId),
            referenceManualJson: remapIds(remap(s.referenceManualJson, id, newId)),
            referenceIdsJson: remapIds(s.referenceIdsJson),
            imageAssetId: s.imageAssetId ? (assetMap.get(s.imageAssetId) ?? s.imageAssetId) : null,
            videoAssetId: s.videoAssetId ? (assetMap.get(s.videoAssetId) ?? s.videoAssetId) : null,
            deletedAt: null,
            deletedFromNumber: null,
            deletedWasSkipped: false,
          },
        });
        // Re-attach the copied scene assets to the copied scene.
        for (const a of src.assets.filter((x) => x.sceneId === s.id)) await tx.asset.update({ where: { id: assetMap.get(a.id)! }, data: { sceneId } });
        for (const l of dialogueLines) {
          const { id: _lid, sceneId: _ls, createdAt: _lc, updatedAt: _lu, ...lf } = l;
          await tx.dialogueLine.create({ data: { ...lf, sceneId, actualCost: 0, outputPath: remap(l.outputPath, id, newId)! } });
        }
      }
    });
  } catch (err) {
    fs.rmSync(newRoot, { recursive: true, force: true });
    throw err;
  }
  await logger.info({ event: "trash.project_duplicated", projectId: newId, message: `Nhân bản từ "${src.title}": ${src.scenes.length} cảnh, chép ${filesCopied} file (${(bytesCopied / 1e6).toFixed(1)} MB). Không gọi AI, không render, $0.` });
  return { id: newId, title: `${src.title} - Bản sao`, filesCopied, bytesCopied };
}

// ------------------------------------------------------------ the trash view ---

export interface TrashView {
  projects: { id: string; title: string; deletedAt: string; scenes: number; outputs: number }[];
  scenes: { id: string; projectId: string; projectTitle: string; fromNumber: number | null; subtitle: string; deletedAt: string; imagePath: string | null }[];
  outputs: { id: string; projectId: string; projectTitle: string; name: string; file: string; deletedAt: string; bytes: number | null }[];
}

export async function listTrash(): Promise<TrashView> {
  const [projects, scenes, outputs] = await Promise.all([
    prisma.project.findMany({ where: { deletedAt: { not: null } }, orderBy: { deletedAt: "desc" }, include: { _count: { select: { scenes: { where: { deletedAt: null } }, assets: { where: { kind: "final" } } } } } }),
    prisma.scene.findMany({ where: { deletedAt: { not: null }, project: { deletedAt: null } }, orderBy: { deletedAt: "desc" }, include: { project: { select: { title: true } } } }),
    prisma.asset.findMany({ where: { kind: "final", deletedAt: { not: null }, project: { deletedAt: null } }, orderBy: { deletedAt: "desc" }, include: { project: { select: { title: true } } } }),
  ]);
  return {
    projects: projects.map((p) => ({ id: p.id, title: p.title, deletedAt: p.deletedAt!.toISOString(), scenes: p._count.scenes, outputs: p._count.assets })),
    scenes: scenes.map((s) => ({ id: s.id, projectId: s.projectId, projectTitle: s.project.title, fromNumber: s.deletedFromNumber, subtitle: s.subtitle || s.dialogue, deletedAt: s.deletedAt!.toISOString(), imagePath: s.imagePath })),
    outputs: outputs.map((a) => ({ id: a.id, projectId: a.projectId, projectTitle: a.project.title, name: path.basename(a.filePath), file: a.filePath, deletedAt: a.deletedAt!.toISOString(), bytes: a.bytes })),
  };
}

// ------------------------------------------------------- permanent delete ---

function inside(file: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Every path under `prefix` (e.g. "projects/<id>/") still named ANYWHERE: every
 * TEXT column of every table (JSON included) and every remix manifest outside
 * `excludeDirs`. Lower-case, forward slashes, data-relative.
 */
/**
 * History, not use: a log line, a provider's receipt or a cost entry may MENTION
 * a file, but nothing reads the file through them. Every other table counts.
 */
const HISTORY_TABLES = new Set(["LogEntry", "ProviderJob", "CostEntry", "CostReservation"]);

export async function referencedUnder(prefix: string, opts: { excludeDirs?: string[] } = {}): Promise<Set<string>> {
  const id = prefix.split("/")[1] ?? "";
  const found = new Set<string>();
  const add = (t: unknown) => {
    if (typeof t === "string") projectPathsIn(t, id).forEach((p) => found.add(p.toLowerCase()));
  };
  const tables = await prisma.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'`);
  for (const { name } of tables) {
    if (HISTORY_TABLES.has(name)) continue;
    const cols = await prisma.$queryRawUnsafe<{ name: string; type: string }[]>(`PRAGMA table_info("${name.replace(/"/g, "")}")`);
    for (const c of cols) {
      if (!/TEXT|CHAR|CLOB/i.test(c.type)) continue;
      const rows = await prisma.$queryRawUnsafe<{ v: string }[]>(
        `SELECT "${c.name.replace(/"/g, "")}" AS v FROM "${name.replace(/"/g, "")}" WHERE "${c.name.replace(/"/g, "")}" LIKE ? OR "${c.name.replace(/"/g, "")}" LIKE ?`,
        `%projects/${id}%`,
        `%projects\\${id}%`,
      );
      rows.forEach((r) => add(r.v));
    }
  }
  // Remix manifests of every OTHER video name their source tracks.
  const excluded = (opts.excludeDirs ?? []).map((d) => path.resolve(d).toLowerCase());
  for (const pid of fs.existsSync(PROJECTS_ROOT) ? fs.readdirSync(PROJECTS_ROOT) : []) {
    const renders = path.join(PROJECTS_ROOT, pid, "audio", "renders");
    if (!fs.existsSync(renders)) continue;
    for (const d of fs.readdirSync(renders)) {
      const dir = path.join(renders, d);
      if (excluded.some((x) => path.resolve(dir).toLowerCase() === x)) continue;
      const m = path.join(dir, "manifest.json");
      if (fs.existsSync(m)) add(fs.readFileSync(m, "utf8"));
    }
  }
  return found;
}

/** Remove one file - only a regular file inside `root`, never through a symlink. Retries a locked file. */
async function removeFile(file: string, root: string): Promise<string | null> {
  if (!inside(file, root)) return "ngoài thư mục được phép";
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isFile()) return "không phải file thường (symlink/thư mục) - bỏ qua";
  try {
    const real = fs.realpathSync(file);
    if (!inside(real, fs.realpathSync(root))) return "đường dẫn thật nằm ngoài thư mục được phép";
  } catch {
    return "không xác định được đường dẫn thật";
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      fs.rmSync(file);
      return null;
    } catch (err) {
      if (attempt === 3) return (err as Error).message;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  return null;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(...walkFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function pruneEmptyDirs(dir: string, root: string): void {
  if (!fs.existsSync(dir) || !inside(dir, root)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) pruneEmptyDirs(path.join(dir, e.name), root);
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // in use: left
  }
}

export interface PurgeReport {
  deletedFiles: number;
  freedBytes: number;
  keptShared: string[];
  failed: { file: string; reason: string }[];
}

async function purgeFiles(candidates: string[], prefix: string, root: string, excludeDirs: string[] = []): Promise<PurgeReport> {
  const refs = await referencedUnder(prefix, { excludeDirs });
  const report: PurgeReport = { deletedFiles: 0, freedBytes: 0, keptShared: [], failed: [] };
  for (const file of candidates) {
    const rel = toRelative(file).replace(/\\/g, "/").toLowerCase();
    if (refs.has(rel)) {
      report.keptShared.push(toRelative(file));
      continue;
    }
    const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    const err = await removeFile(file, root);
    if (err) report.failed.push({ file: toRelative(file), reason: err });
    else {
      report.deletedFiles += 1;
      report.freedBytes += size;
    }
  }
  return report;
}

/** XOÁ VĨNH VIỄN a project from the trash. */
export async function purgeProject(id: string): Promise<PurgeReport & { title: string }> {
  const p = await prisma.project.findUnique({ where: { id } });
  if (!p) throw new TrashBlockedError("Không tìm thấy dự án.");
  if (!p.deletedAt) throw new TrashBlockedError("Chỉ xoá vĩnh viễn được dự án đang ở Thùng rác.");
  await assertIdle(id);
  const root = path.join(PROJECTS_ROOT, id);
  const files = walkFiles(root);
  // The exported copies of THIS project (data/output/<batch>/<slug>/) - only that folder.
  const outDir = p.outputDir ? toAbsolute(p.outputDir) : null;
  const outFiles = outDir && inside(outDir, OUTPUT_ROOT) && fs.existsSync(outDir) ? walkFiles(outDir) : [];
  await prisma.$transaction(async (tx) => {
    await tx.job.deleteMany({ where: { projectId: id } });
    await tx.project.delete({ where: { id } });
  });
  const report = await purgeFiles(files, `projects/${id}/`, root, [path.join(root, "audio", "renders")]);
  for (const f of outFiles) {
    const err = await removeFile(f, outDir!);
    if (err) report.failed.push({ file: toRelative(f), reason: err });
    else report.deletedFiles += 1;
  }
  pruneEmptyDirs(root, PROJECTS_ROOT);
  if (outDir) pruneEmptyDirs(outDir, OUTPUT_ROOT);
  await logger.warn({
    event: "trash.project_purged",
    projectId: id,
    message: `Đã xoá vĩnh viễn dự án "${p.title}": ${report.deletedFiles} file (${(report.freedBytes / 1e6).toFixed(1)} MB); giữ ${report.keptShared.length} file còn được dùng; ${report.failed.length} file lỗi.`,
    data: report,
  });
  return { ...report, title: p.title };
}

/** XOÁ VĨNH VIỄN one scene from the trash (its media only when nothing else uses it). */
export async function purgeScene(sceneId: string): Promise<PurgeReport> {
  const s = await prisma.scene.findUnique({ where: { id: sceneId }, include: { dialogueLines: true, assets: true } });
  if (!s?.deletedAt) throw new TrashBlockedError("Chỉ xoá vĩnh viễn được cảnh đang ở Thùng rác.");
  await assertIdle(s.projectId);
  const root = path.join(PROJECTS_ROOT, s.projectId);
  const candidates = [s.imagePath, s.videoPath, s.audioPath, ...s.dialogueLines.map((l) => l.outputPath), ...s.assets.map((a) => a.filePath)]
    .filter((p): p is string => Boolean(p))
    .map((p) => toAbsolute(p))
    .filter((p) => inside(p, root));
  await prisma.$transaction(async (tx) => {
    // An asset another scene (a duplicate) or a reference still uses is kept, detached from this scene.
    const usedElsewhere = await tx.scene.findMany({ where: { id: { not: sceneId }, OR: [{ imageAssetId: { in: s.assets.map((a) => a.id) } }, { videoAssetId: { in: s.assets.map((a) => a.id) } }] }, select: { imageAssetId: true, videoAssetId: true } });
    const keep = new Set(usedElsewhere.flatMap((x) => [x.imageAssetId, x.videoAssetId]).filter(Boolean) as string[]);
    const refUsed = await tx.referenceAsset.findMany({ where: { assetId: { in: s.assets.map((a) => a.id) } }, select: { assetId: true } });
    refUsed.forEach((r) => r.assetId && keep.add(r.assetId));
    if (keep.size) await tx.asset.updateMany({ where: { id: { in: [...keep] } }, data: { sceneId: null } });
    await tx.scene.delete({ where: { id: sceneId } });
  });
  const report = await purgeFiles([...new Set(candidates)], `projects/${s.projectId}/`, root);
  await logger.warn({ event: "trash.scene_purged", projectId: s.projectId, message: `Đã xoá vĩnh viễn 1 cảnh: ${report.deletedFiles} file; giữ ${report.keptShared.length} file còn được dùng.`, data: report });
  return report;
}

/** XOÁ VĨNH VIỄN one exported video from the trash (and its remix sources when no other video uses them). */
export async function purgeOutput(assetId: string): Promise<PurgeReport> {
  const a = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!a?.deletedAt || a.kind !== "final") throw new TrashBlockedError("Chỉ xoá vĩnh viễn được video đang ở Thùng rác.");
  await assertIdle(a.projectId, ["remix_audio", "render_final"]);
  const root = path.join(PROJECTS_ROOT, a.projectId);
  const base = path.basename(a.filePath, path.extname(a.filePath));
  const manifestDir = path.join(root, "audio", "renders", base);
  const candidates = [toAbsolute(a.filePath), ...walkFiles(manifestDir)].filter((p) => inside(p, root));
  await prisma.asset.delete({ where: { id: assetId } });
  const report = await purgeFiles(candidates, `projects/${a.projectId}/`, root, [manifestDir]);
  pruneEmptyDirs(manifestDir, root);
  await logger.warn({ event: "trash.output_purged", projectId: a.projectId, message: `Đã xoá vĩnh viễn ${path.basename(a.filePath)}: ${report.deletedFiles} file; giữ ${report.keptShared.length} file còn được dùng.`, data: report });
  return report;
}

// ----------------------------------------------------------------- storage ---

/** Bytes in a project's own folder (a quick total for lists). */
export function folderBytes(projectId: string): number {
  return walkFiles(path.join(PROJECTS_ROOT, projectId)).reduce((n, f) => n + (fs.statSync(f, { throwIfNoEntry: false })?.size ?? 0), 0);
}

export interface StorageView {
  categories: { key: string; label: string; files: number; bytes: number }[];
  ownBytes: number;
  /** Files of this folder another project or video also names: not freed with this project. */
  sharedBytes: number;
  /** Files outside this folder the project borrows (a shared library): never counted as its own. */
  borrowedBytes: number;
  outputCopiesBytes: number;
}

const CATEGORY: Record<string, string> = { images: "Ảnh nguồn", videos: "Video nguồn", audio: "Âm thanh nguồn", final: "Video output", temp: "File tạm", subtitles: "Phụ đề", script: "Kịch bản" };

export async function projectStorage(id: string): Promise<StorageView> {
  const p = await prisma.project.findUnique({ where: { id }, include: { scenes: { include: { dialogueLines: true } }, assets: true } });
  if (!p) throw new TrashBlockedError("Không tìm thấy dự án.");
  const root = path.join(PROJECTS_ROOT, id);
  const cats = new Map<string, { files: number; bytes: number }>();
  let ownBytes = 0;
  const files = walkFiles(root);
  for (const f of files) {
    const top = path.relative(root, f).split(path.sep)[0] ?? "";
    const isRemix = f.includes(`${path.sep}renders${path.sep}`);
    const key = isRemix ? "remix" : CATEGORY[top] ? top : "other";
    const size = fs.statSync(f).size;
    ownBytes += size;
    const c = cats.get(key) ?? { files: 0, bytes: 0 };
    c.files += 1;
    c.bytes += size;
    cats.set(key, c);
  }
  // Shared: paths of this folder named by OTHER projects' rows.
  const others = await prisma.$queryRawUnsafe<{ v: string }[]>(
    `SELECT imagePath AS v FROM Scene WHERE projectId <> ? UNION ALL SELECT videoPath FROM Scene WHERE projectId <> ? UNION ALL SELECT filePath FROM Asset WHERE projectId <> ? UNION ALL SELECT scenePlanJson FROM Scene WHERE projectId <> ?`,
    id, id, id, id,
  );
  const sharedSet = new Set<string>();
  others.forEach((o) => projectPathsIn(o.v, id).forEach((x) => sharedSet.add(x.toLowerCase())));
  const sharedBytes = files.filter((f) => sharedSet.has(toRelative(f).replace(/\\/g, "/").toLowerCase())).reduce((n, f) => n + fs.statSync(f).size, 0);
  // Borrowed: things this project names outside its own folder.
  const named = new Set<string>();
  const addNamed = (t: string | null | undefined) => {
    if (t && !t.replace(/\\/g, "/").startsWith(`projects/${id}/`)) named.add(t);
  };
  p.scenes.forEach((s) => [s.imagePath, s.videoPath, s.audioPath].forEach(addNamed));
  p.assets.forEach((a) => addNamed(a.filePath));
  let borrowedBytes = 0;
  for (const n of named) {
    const st = fs.statSync(toAbsolute(n), { throwIfNoEntry: false });
    if (st?.isFile()) borrowedBytes += st.size;
  }
  const outDir = p.outputDir ? toAbsolute(p.outputDir) : null;
  const outputCopiesBytes = outDir && inside(outDir, OUTPUT_ROOT) ? walkFiles(outDir).reduce((n, f) => n + fs.statSync(f).size, 0) : 0;
  const labels: Record<string, string> = { ...CATEGORY, remix: "Track Remix Audio", other: "Khác" };
  return {
    categories: [...cats.entries()].map(([key, v]) => ({ key, label: labels[key] ?? key, ...v })).sort((a, b) => b.bytes - a.bytes),
    ownBytes,
    sharedBytes,
    borrowedBytes,
    outputCopiesBytes,
  };
}

/**
 * DỌN FILE TẠM of one project: its temp/ folder and interrupted *.tmp / *.part
 * files - never a source picture, voice, clip, remix track, video output or a
 * file any row names. Refused while the project has work running or queued.
 */
export async function cleanProjectTemp(id: string): Promise<PurgeReport> {
  const p = await prisma.project.findUnique({ where: { id } });
  if (!p) throw new TrashBlockedError("Không tìm thấy dự án.");
  await assertIdle(id);
  const root = path.join(PROJECTS_ROOT, id);
  const tempDir = path.join(root, "temp");
  const candidates = [...walkFiles(tempDir), ...walkFiles(root).filter((f) => /\.(tmp|part)$|\.tmp\./i.test(f) && !f.startsWith(tempDir))];
  const report = await purgeFiles([...new Set(candidates)], `projects/${id}/`, root);
  await logger.info({ event: "trash.temp_cleaned", projectId: id, message: `Dọn file tạm: xoá ${report.deletedFiles} file (${(report.freedBytes / 1e6).toFixed(1)} MB), giữ ${report.keptShared.length} file còn được dùng.` });
  return report;
}
