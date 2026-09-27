import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { DATA_ROOT, toRelative } from "@/lib/paths";

/**
 * SAFE CLEANUP (V1.2 Phase 5, QĐ-113) - `npm run assets:cleanup -- --dry-run`.
 *
 * Every file under data/ is put in one class:
 *
 *   A PRODUCTION  used by an asset row, a scene, a dialogue line, a project's
 *                 final or a character sheet                        -> PROTECTED
 *   B OUTPUT      data/output/** (the finished videos for people)   -> PROTECTED
 *   C CACHE       data/cache/** (rebuildable locally, $0)           -> PROTECTED
 *                 (reported; not auto-cleaned)
 *   D TEMP        projects/<id>/temp/** older than the temp age, no
 *                 job running for that project                       -> SAFE
 *   E INTERRUPTED *.tmp* / *.part left beside real files, older than
 *                 the temp age                                       -> SAFE
 *     TEST        data/.test/run-<pid>-* of a test process that is
 *                 no longer running, older than a day                -> SAFE
 *     ORPHAN      a media file in a project/character folder that
 *                 nothing references, or a folder of a deleted
 *                 project: it may be PAID                            -> ORPHAN_CANDIDATE (kept)
 *     UNKNOWN     anything else                                      -> kept
 *
 * Only SAFE is ever deleted, and only by `applyCleanup` (the `--apply` flag).
 * A paid, imported or rendered file is never SAFE.
 */

export type CleanupAction = "SAFE" | "PROTECTED" | "ORPHAN_CANDIDATE" | "UNKNOWN";

export interface CleanupEntry {
  path: string;
  bytes: number;
  action: CleanupAction;
  category: string;
  reason: string;
}

export interface CleanupPlan {
  root: string;
  filesScanned: number;
  safe: CleanupEntry[];
  bytesReclaimable: number;
  protectedFiles: number;
  orphanCandidates: CleanupEntry[];
  unknown: CleanupEntry[];
  byCategory: Record<string, { files: number; bytes: number }>;
  entries: CleanupEntry[];
}

const norm = (p: string) => p.split("\\").join("/");
const DAY = 24 * 60 * 60 * 1000;
const MEDIA = /\.(png|jpe?g|webp|mp4|mov|webm|wav|mp3|m4a|aac|ogg)$/i;
const INTERRUPTED = /(\.tmp(-[^/]*)?(\.\w+)?|\.part|\.partial)$/i;

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
}

async function referencedPaths(): Promise<Set<string>> {
  const [assets, scenes, lines, projects, refs] = await Promise.all([
    prisma.asset.findMany({ select: { filePath: true } }),
    prisma.scene.findMany({ select: { imagePath: true, videoPath: true, audioPath: true } }),
    prisma.dialogueLine.findMany({ select: { outputPath: true } }),
    prisma.project.findMany({ select: { finalVideoPath: true, subtitlePath: true } }),
    prisma.characterReference.findMany({ select: { filePath: true } }),
  ]);
  const out = new Set<string>();
  const add = (p: string | null | undefined) => {
    if (p) out.add(norm(p).toLowerCase());
  };
  assets.forEach((a) => add(a.filePath));
  scenes.forEach((s) => {
    add(s.imagePath);
    add(s.videoPath);
    add(s.audioPath);
  });
  lines.forEach((l) => add(l.outputPath));
  projects.forEach((p) => {
    add(p.finalVideoPath);
    add(p.subtitlePath);
  });
  refs.forEach((r) => add(r.filePath));
  return out;
}

export async function planCleanup(opts: { now?: number; tempDays?: number; testDays?: number; root?: string } = {}): Promise<CleanupPlan> {
  const now = opts.now ?? Date.now();
  const tempMs = (opts.tempDays ?? 3) * DAY;
  const testMs = (opts.testDays ?? 1) * DAY;
  const root = opts.root ?? DATA_ROOT;

  const referenced = await referencedPaths();
  const projectIds = new Set((await prisma.project.findMany({ select: { id: true } })).map((p) => p.id));
  const busyProjects = new Set(
    (
      await prisma.job.findMany({
        where: { status: { in: ["queued", "processing"] }, projectId: { not: null } },
        select: { projectId: true },
      })
    ).map((j) => j.projectId!),
  );

  const files: string[] = [];
  walk(root, files);
  const entries: CleanupEntry[] = [];

  for (const abs of files) {
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue; // vanished mid-scan
    }
    const rel = norm(path.relative(root, abs));
    const parts = rel.split("/");
    const age = now - st.mtimeMs;
    const isRef = (() => {
      try {
        return referenced.has(norm(toRelative(abs)).toLowerCase());
      } catch {
        return referenced.has(rel.toLowerCase());
      }
    })();
    const entry = (action: CleanupAction, category: string, reason: string): CleanupEntry => ({
      path: rel,
      bytes: st.size,
      action,
      category,
      reason,
    });

    if (/^app\.db/i.test(parts[0]!) || /\.db(-journal|-wal|-shm)?$/i.test(rel)) {
      entries.push(entry("PROTECTED", "DATABASE", "cơ sở dữ liệu"));
    } else if (isRef) {
      entries.push(entry("PROTECTED", parts[0] === "output" ? "OUTPUT" : "PRODUCTION", "đang được tham chiếu"));
    } else if (parts[0] === "output") {
      entries.push(entry("PROTECTED", "OUTPUT", "thư mục output chính thức"));
    } else if (parts[0] === "cache") {
      entries.push(entry("PROTECTED", "CACHE", "cache tái tạo được tại máy — không dọn tự động"));
    } else if (parts[0] === ".test") {
      const m = /^run-(\d+)-/.exec(parts[1] ?? "");
      if (m && !pidAlive(Number(m[1])) && age > testMs) {
        entries.push(entry("SAFE", "TEST", "dữ liệu test của tiến trình đã kết thúc"));
      } else {
        entries.push(entry("UNKNOWN", "TEST", m ? "test đang chạy hoặc còn mới" : "thư mục test không rõ chủ"));
      }
    } else if (parts[0] === "projects" && parts.length >= 3) {
      const projectId = parts[1]!;
      const sub = parts[2]!;
      if (!projectIds.has(projectId)) {
        entries.push(entry("ORPHAN_CANDIDATE", "DELETED_PROJECT", "thư mục của dự án đã xoá — có thể là asset đã trả tiền, không tự xoá"));
      } else if (sub === "temp") {
        if (busyProjects.has(projectId)) entries.push(entry("PROTECTED", "TEMP", "dự án đang có job chạy"));
        else if (age > tempMs) entries.push(entry("SAFE", "TEMP", "file tạm đã hết hạn"));
        else entries.push(entry("PROTECTED", "TEMP", "file tạm còn mới"));
      } else if (INTERRUPTED.test(rel)) {
        if (!busyProjects.has(projectId) && age > tempMs) entries.push(entry("SAFE", "INTERRUPTED", "file dở dang của lần chạy bị ngắt"));
        else entries.push(entry("PROTECTED", "INTERRUPTED", "file dở dang còn mới / dự án đang chạy"));
      } else if (MEDIA.test(rel)) {
        entries.push(entry("ORPHAN_CANDIDATE", "UNREFERENCED_MEDIA", "media không còn được tham chiếu — có thể đã trả tiền, không tự xoá"));
      } else {
        entries.push(entry("PROTECTED", "PROJECT_DATA", "dữ liệu dự án (script/phụ đề/metadata)"));
      }
    } else if (parts[0] === "characters") {
      entries.push(
        MEDIA.test(rel)
          ? entry("ORPHAN_CANDIDATE", "UNREFERENCED_MEDIA", "ảnh nhân vật không còn được tham chiếu")
          : entry("PROTECTED", "CHARACTER", "dữ liệu nhân vật"),
      );
    } else if (parts[0] === "music" || parts[0] === "sfx") {
      entries.push(entry("PROTECTED", "LIBRARY", "thư viện nhạc/hiệu ứng"));
    } else {
      entries.push(entry("UNKNOWN", "UNKNOWN", "không thuộc nhóm nào đã biết — giữ nguyên"));
    }
  }

  const byCategory: CleanupPlan["byCategory"] = {};
  for (const e of entries) {
    const c = (byCategory[`${e.action}:${e.category}`] ??= { files: 0, bytes: 0 });
    c.files++;
    c.bytes += e.bytes;
  }
  const safe = entries.filter((e) => e.action === "SAFE");
  return {
    root,
    filesScanned: entries.length,
    safe,
    bytesReclaimable: safe.reduce((n, e) => n + e.bytes, 0),
    protectedFiles: entries.filter((e) => e.action === "PROTECTED").length,
    orphanCandidates: entries.filter((e) => e.action === "ORPHAN_CANDIDATE"),
    unknown: entries.filter((e) => e.action === "UNKNOWN"),
    byCategory,
    entries,
  };
}

/**
 * Delete the SAFE entries of a plan - and nothing else. Each file is checked
 * again right before it goes (still there, still unreferenced, still old), so
 * a job that started after the plan was made keeps its files.
 */
export async function applyCleanup(plan: CleanupPlan): Promise<{ deleted: number; bytes: number; skipped: number }> {
  const fresh = await planCleanup({ root: plan.root });
  const stillSafe = new Set(fresh.safe.map((e) => e.path));
  let deleted = 0;
  let bytes = 0;
  let skipped = 0;
  for (const e of plan.safe) {
    if (!stillSafe.has(e.path)) {
      skipped++;
      continue;
    }
    try {
      fs.rmSync(path.join(plan.root, e.path), { force: true });
      deleted++;
      bytes += e.bytes;
    } catch {
      skipped++;
    }
  }
  return { deleted, bytes, skipped };
}
