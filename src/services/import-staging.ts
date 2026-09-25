import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_ROOT } from "@/lib/paths";
import { isSafeRelativePath } from "@/domain/storyboard";

/**
 * Files a browser uploaded for a storyboard import, laid out on disk exactly as
 * the person had them - so the SAME scanner that reads a folder path or a ZIP
 * reads them too. There is no second importer: an upload becomes a folder, and
 * a folder is something `scanImportSource` already understands.
 *
 * Only names that could be part of a storyboard are accepted, every relative
 * path is checked before a byte is written, and the staging area lives under
 * the data root. Old staging folders are swept on each new upload.
 */

export const STAGING_ROOT = path.join(DATA_ROOT, "imports");
const ALLOWED = /\.(json|csv|png|jpe?g|webp|zip)$/i;
export const STAGING_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

export class StagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagingError";
  }
}

export interface StagedUpload {
  /** What to hand to `scanImportSource`: the folder, or the single ZIP in it. */
  source: string;
  fileCount: number;
  bytes: number;
}

function sweepOld(): void {
  if (!fs.existsSync(STAGING_ROOT)) return;
  const now = Date.now();
  for (const name of fs.readdirSync(STAGING_ROOT)) {
    const dir = path.join(STAGING_ROOT, name);
    try {
      if (now - fs.statSync(dir).mtimeMs > STAGING_TTL_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // A folder another request is using right now is simply left alone.
    }
  }
}

export function stageUpload(files: { relativePath: string; bytes: Buffer }[]): StagedUpload {
  if (files.length === 0) throw new StagingError("Chưa chọn file nào.");
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  if (total > STAGING_MAX_TOTAL_BYTES) {
    throw new StagingError(
      `Tổng dung lượng ${(total / 1024 / 1024).toFixed(0)} MB vượt giới hạn ` +
        `${STAGING_MAX_TOTAL_BYTES / 1024 / 1024} MB cho một lần nhập.`,
    );
  }
  const rejected: string[] = [];
  for (const f of files) {
    const rel = f.relativePath.replace(/\\/g, "/");
    if (!isSafeRelativePath(rel)) rejected.push(`${f.relativePath} (đường dẫn không an toàn)`);
    else if (!ALLOWED.test(rel)) rejected.push(`${f.relativePath} (loại file không nhận)`);
  }
  if (rejected.length > 0) {
    throw new StagingError(
      `Không nhận ${rejected.length} file: ${rejected.slice(0, 8).join(", ")}` +
        (rejected.length > 8 ? " …" : "") +
        ". Chỉ nhận .json .csv .png .jpg .jpeg .webp .zip.",
    );
  }

  sweepOld();
  const dir = path.join(STAGING_ROOT, randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const target = path.join(dir, ...f.relativePath.replace(/\\/g, "/").split("/"));
    // Belt and braces after `isSafeRelativePath`: the resolved target must
    // still be inside this upload's folder.
    if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new StagingError(`Đường dẫn "${f.relativePath}" thoát ra ngoài thư mục nhập.`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.bytes);
  }

  const zips = files.filter((f) => /\.zip$/i.test(f.relativePath));
  const source =
    files.length === 1 && zips.length === 1
      ? path.join(dir, ...zips[0]!.relativePath.replace(/\\/g, "/").split("/"))
      : dir;
  return { source, fileCount: files.length, bytes: total };
}
