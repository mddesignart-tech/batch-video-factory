import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * Media cleanup.
 *
 * Retention rules, per the product spec:
 *   temp files        -> 3 days   (configurable)
 *   failed job files  -> 7 days   (configurable)
 *   final exports     -> kept forever unless CLEANUP_FINAL_DAYS is explicitly set
 *
 * The last rule is the important one: a finished video is the operator's work
 * product and is never deleted by a scheduled job on our initiative. Run with
 * `--dry-run` to see what would go without touching anything.
 */

const prisma = new PrismaClient();

const DATA_ROOT = path.resolve(process.cwd(), "data");
const PROJECTS_DIR = path.join(DATA_ROOT, "projects");

const DRY_RUN = process.argv.includes("--dry-run");

function days(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const TEMP_DAYS = days("CLEANUP_TEMP_DAYS", 3);
const FAILED_DAYS = days("CLEANUP_FAILED_DAYS", 7);
const FINAL_DAYS_RAW = Number(process.env.CLEANUP_FINAL_DAYS);
const FINAL_DAYS = Number.isFinite(FINAL_DAYS_RAW) && FINAL_DAYS_RAW > 0
  ? FINAL_DAYS_RAW
  : null;

interface Tally {
  files: number;
  bytes: number;
}

const empty = (): Tally => ({ files: 0, bytes: 0 });

function olderThan(file: string, dayCount: number): boolean {
  try {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    return age > dayCount * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function removeOldFiles(dir: string, dayCount: number, tally: Tally): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeOldFiles(full, dayCount, tally);
      // Drop the directory too if the sweep emptied it.
      try {
        if (fs.readdirSync(full).length === 0 && !DRY_RUN) fs.rmdirSync(full);
      } catch {
        /* not empty or in use - leave it */
      }
      continue;
    }
    if (!olderThan(full, dayCount)) continue;
    const size = fs.statSync(full).size;
    if (!DRY_RUN) {
      try {
        fs.unlinkSync(full);
      } catch {
        continue;
      }
    }
    tally.files++;
    tally.bytes += size;
  }
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

async function main(): Promise<void> {
  console.log(
    `Dọn dẹp media${DRY_RUN ? " (chạy thử, không xoá gì)" : ""}...\n` +
      `  Tệp tạm: > ${TEMP_DAYS} ngày\n` +
      `  Tệp job thất bại: > ${FAILED_DAYS} ngày\n` +
      `  Video hoàn chỉnh: ${FINAL_DAYS ? `> ${FINAL_DAYS} ngày` : "giữ vĩnh viễn"}\n`,
  );

  if (!fs.existsSync(PROJECTS_DIR)) {
    console.log("Chưa có thư mục data/projects. Không có gì để dọn.");
    return;
  }

  const temp = empty();
  const failed = empty();
  const finals = empty();
  const orphans = empty();

  const projectDirs = fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  const knownIds = new Set(
    (await prisma.project.findMany({ select: { id: true } })).map((p) => p.id),
  );

  const failedIds = new Set(
    (
      await prisma.project.findMany({
        where: { status: "failed" },
        select: { id: true },
      })
    ).map((p) => p.id),
  );

  for (const dir of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, dir.name);

    // A directory with no row in the database belongs to a deleted project.
    if (!knownIds.has(dir.name)) {
      const size = dirOf(projectPath);
      if (!DRY_RUN) fs.rmSync(projectPath, { recursive: true, force: true });
      orphans.files += size.files;
      orphans.bytes += size.bytes;
      continue;
    }

    removeOldFiles(path.join(projectPath, "temp"), TEMP_DAYS, temp);

    if (failedIds.has(dir.name)) {
      for (const sub of ["images", "videos", "audio"]) {
        removeOldFiles(path.join(projectPath, sub), FAILED_DAYS, failed);
      }
    }

    if (FINAL_DAYS !== null) {
      removeOldFiles(path.join(projectPath, "final"), FINAL_DAYS, finals);
    }
  }

  // Log rows are not media but they do grow without bound.
  const logCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const deletedLogs = DRY_RUN
    ? await prisma.logEntry.count({
        where: { createdAt: { lt: logCutoff }, level: { in: ["debug", "info"] } },
      })
    : (
        await prisma.logEntry.deleteMany({
          where: { createdAt: { lt: logCutoff }, level: { in: ["debug", "info"] } },
        })
      ).count;

  console.log("Kết quả:");
  console.log(`  Tệp tạm:            ${temp.files} tệp, ${formatBytes(temp.bytes)}`);
  console.log(`  Job thất bại:       ${failed.files} tệp, ${formatBytes(failed.bytes)}`);
  console.log(`  Video hoàn chỉnh:   ${finals.files} tệp, ${formatBytes(finals.bytes)}`);
  console.log(`  Dự án đã xoá:       ${orphans.files} tệp, ${formatBytes(orphans.bytes)}`);
  console.log(`  Nhật ký cũ:         ${deletedLogs} dòng`);
  console.log(
    `\nTổng giải phóng: ${formatBytes(
      temp.bytes + failed.bytes + finals.bytes + orphans.bytes,
    )}${DRY_RUN ? " (ước tính - chưa xoá gì)" : ""}`,
  );
}

function dirOf(dir: string): Tally {
  const tally = empty();
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          tally.bytes += fs.statSync(full).size;
          tally.files++;
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  walk(dir);
  return tally;
}

main()
  .catch((err: unknown) => {
    console.error("Dọn dẹp thất bại:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
