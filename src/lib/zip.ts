import fs from "node:fs";
import zlib from "node:zlib";

/**
 * A minimal ZIP reader, written here rather than pulled in as a dependency.
 *
 * ## Why not a library
 *
 * The thing a ZIP reader has to get right in this project is not decompression,
 * it is REFUSAL: an imported archive is untrusted input, and the classic bug is
 * an entry named `../../../.ssh/authorized_keys` that a helpful extractor
 * writes wherever it says. Most libraries extract first and leave that check to
 * the caller. Here the check is not a step the caller can forget - names are
 * validated as the central directory is read, and an unsafe one is dropped
 * before its bytes are ever touched.
 *
 * It also stays small because this reader never writes to disk at all. It
 * returns entries in memory and the import service decides what to keep.
 *
 * ## What it supports
 *
 * Stored (method 0) and deflate (method 8), which is every ZIP any normal tool
 * produces. Encrypted, spanned, and ZIP64 archives are refused by name rather
 * than half-read.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;

/** Refuse an archive that would not fit in memory comfortably. */
export const MAX_ZIP_BYTES = 512 * 1024 * 1024;
/** Refuse a single entry that inflates to more than this - a zip bomb guard. */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** More entries than any storyboard batch could legitimately need. */
export const MAX_ENTRIES = 5000;

export class ZipError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  /** Normalised to forward slashes. Always a safe relative path. */
  path: string;
  isDirectory: boolean;
  size: number;
  read: () => Buffer;
}

export interface ZipListing {
  entries: ZipEntry[];
  /** Entries refused, and why - reported rather than silently dropped. */
  rejected: { path: string; reason: string }[];
}

/**
 * Names that must never be extracted.
 *
 * Duplicated from `domain/storyboard.isSafeRelativePath` on purpose: this layer
 * must be safe on its own, even if something later calls it without the domain
 * checks. A security check that depends on a caller remembering to run another
 * one is not a check.
 */
function unsafeReason(name: string): string | null {
  if (name.length === 0) return "tên rỗng";
  if (name.length > 255) return "tên quá dài";
  if (name.includes("\0")) return "tên chứa ký tự NUL";
  if (/^[a-zA-Z]:/.test(name)) return "đường dẫn có ổ đĩa";
  if (name.startsWith("/") || name.startsWith("\\")) return "đường dẫn tuyệt đối";
  const parts = name.split(/[\\/]+/);
  if (parts.some((p) => p === "..")) return "có '..' — thoát ra ngoài thư mục";
  return null;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The EOCD sits at the end, after a comment of up to 64KB.
  const start = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

export function readZipBuffer(buffer: Buffer): ZipListing {
  if (buffer.length < 22) throw new ZipError("File quá nhỏ để là ZIP.", "zip_too_small");
  if (buffer.length > MAX_ZIP_BYTES) {
    throw new ZipError(
      `ZIP lớn hơn giới hạn ${(MAX_ZIP_BYTES / 1024 / 1024).toFixed(0)} MB.`,
      "zip_too_large",
    );
  }

  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) {
    throw new ZipError("Không tìm thấy phần cuối ZIP — file hỏng hoặc không phải ZIP.", "zip_no_eocd");
  }
  if (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR) {
    throw new ZipError("ZIP64 chưa được hỗ trợ.", "zip64_unsupported");
  }

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ENTRIES) {
    throw new ZipError(`ZIP có ${entryCount} mục, vượt giới hạn ${MAX_ENTRIES}.`, "zip_too_many_entries");
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new ZipError("Bảng thư mục trung tâm nằm ngoài file — ZIP hỏng.", "zip_corrupt");
  }

  const entries: ZipEntry[] = [];
  const rejected: { path: string; reason: string }[] = [];
  let cursor = centralOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError(`Mục thứ ${i + 1} trong ZIP hỏng.`, "zip_corrupt");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const rawName = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    const name = rawName.replace(/\\/g, "/");
    const isDirectory = name.endsWith("/");

    if (flags & 0x1) {
      rejected.push({ path: name, reason: "mục được mã hoá bằng mật khẩu" });
      continue;
    }
    const unsafe = unsafeReason(isDirectory ? name.slice(0, -1) : name);
    if (unsafe) {
      rejected.push({ path: name, reason: unsafe });
      continue;
    }
    if (isDirectory) {
      entries.push({ path: name.slice(0, -1), isDirectory: true, size: 0, read: () => Buffer.alloc(0) });
      continue;
    }
    if (method !== 0 && method !== 8) {
      rejected.push({ path: name, reason: `phương thức nén ${method} không hỗ trợ` });
      continue;
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      rejected.push({
        path: name,
        reason: `giải nén ra ${uncompressedSize} byte, vượt giới hạn ${MAX_ENTRY_BYTES}`,
      });
      continue;
    }

    entries.push({
      path: name,
      isDirectory: false,
      size: uncompressedSize,
      read: () => {
        if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
          throw new ZipError(`Phần dữ liệu của "${name}" hỏng.`, "zip_corrupt");
        }
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const data = buffer.subarray(dataStart, dataStart + compressedSize);
        if (method === 0) return Buffer.from(data);
        const out = zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
        return Buffer.from(out);
      },
    });
  }

  return { entries, rejected };
}

export function readZipFile(filePath: string): ZipListing {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_ZIP_BYTES) {
    throw new ZipError(
      `ZIP lớn hơn giới hạn ${(MAX_ZIP_BYTES / 1024 / 1024).toFixed(0)} MB.`,
      "zip_too_large",
    );
  }
  return readZipBuffer(fs.readFileSync(filePath));
}
