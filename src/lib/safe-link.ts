import fs from "node:fs";
import { createHash } from "node:crypto";

/**
 * Give `dest` the same bytes as `source` without buying or re-rendering
 * anything, Windows-first (QĐ-113):
 *
 *   1. NTFS hard link - no second copy of the bytes, and deleting the other
 *      project's folder never takes this file with it (the data lives until
 *      its LAST link is gone).
 *   2. Link refused (another volume EXDEV, FAT/exFAT or a share with no link
 *      support, too many links, a permission quirk) -> plain copy.
 *   3. File briefly held by another process (antivirus scan, indexer, a file
 *      watcher: EBUSY / EPERM / EACCES) -> the copy is retried with a short
 *      back-off before giving up.
 *
 * Whatever path is taken, the result is VERIFIED - present, same size, same
 * SHA-256 as expected - before this returns. On failure the half-made `dest`
 * is removed and an error is thrown, so the caller never records a database
 * row pointing at a file that does not exist or is not what it claims to be.
 */

export type LinkMethod = "hardlink" | "copy";

const TRANSIENT = new Set(["EBUSY", "EPERM", "EACCES"]);

function sha256Of(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface LinkOptions {
  /** Expected content hash of `source` (and so of `dest`). Computed when omitted. */
  sha256?: string | null;
  /** Copy attempts when the file is held by another process. */
  retries?: number;
  retryDelayMs?: number;
  /** Test seams. */
  link?: (from: string, to: string) => void;
  copy?: (from: string, to: string) => void;
}

export async function linkOrCopyVerified(
  source: string,
  dest: string,
  opts: LinkOptions = {},
): Promise<{ method: LinkMethod }> {
  const link = opts.link ?? fs.linkSync;
  const copy = opts.copy ?? fs.copyFileSync;
  const expected = opts.sha256 ?? sha256Of(source);
  const retries = opts.retries ?? 5;
  const delay = opts.retryDelayMs ?? 200;

  const verify = (): boolean => {
    try {
      return fs.existsSync(dest) && fs.statSync(dest).size > 0 && sha256Of(dest) === expected;
    } catch {
      return false;
    }
  };
  const discard = () => {
    try {
      if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
    } catch {
      /* best effort - the caller is told it failed either way */
    }
  };

  try {
    link(source, dest);
    if (verify()) return { method: "hardlink" };
    discard();
  } catch {
    discard();
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      copy(source, dest);
      if (verify()) return { method: "copy" };
      discard();
      // The SOURCE is not the bytes it should be: copying again cannot fix that.
      lastError = new Error("bản sao không khớp SHA-256");
      break;
    } catch (err) {
      discard();
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!TRANSIENT.has(code)) break;
    }
    if (attempt < retries) await sleep(delay * (attempt + 1));
  }
  throw new Error(
    `Không tạo được bản liên kết/sao chép hợp lệ cho ${dest}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
