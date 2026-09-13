import fs from "node:fs";
import path from "node:path";

/**
 * Local backup.
 *
 * Intentionally boring: copy `data/` (the SQLite file plus all media) and the
 * config files into a timestamped folder under `backups/`. No archive format, no
 * cloud, no incremental logic - restoring is "copy the folder back", which is
 * something the operator can do without this tool existing.
 *
 * Stop the app before running so SQLite is not mid-write.
 */

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const BACKUP_ROOT = path.join(ROOT, "backups");

const CONFIG_FILES = [".env", "package.json", "prisma/schema.prisma"];

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function copyDir(from: string, to: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      const sub = copyDir(src, dest);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      fs.copyFileSync(src, dest);
      files++;
      bytes += fs.statSync(dest).size;
    }
  }
  return { files, bytes };
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function main(): void {
  if (!fs.existsSync(DATA_DIR)) {
    console.error("Không tìm thấy thư mục data/. Không có gì để sao lưu.");
    process.exitCode = 1;
    return;
  }

  // SQLite keeps recent writes in a -wal sidecar. If one exists the app is very
  // likely still running, and copying now could capture a torn database.
  const wal = path.join(DATA_DIR, "app.db-wal");
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
    console.warn(
      "Cảnh báo: tìm thấy app.db-wal khác rỗng. Hãy DỪNG ứng dụng rồi chạy lại " +
        "để đảm bảo bản sao lưu nhất quán.\n",
    );
  }

  const target = path.join(BACKUP_ROOT, timestamp());
  console.log(`Sao lưu vào ${target} ...`);

  const result = copyDir(DATA_DIR, path.join(target, "data"));

  let configs = 0;
  for (const file of CONFIG_FILES) {
    const src = path.join(ROOT, file);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(target, "config", file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    configs++;
  }

  fs.writeFileSync(
    path.join(target, "RESTORE.txt"),
    [
      "KHÔI PHỤC BẢN SAO LƯU",
      "=====================",
      "",
      "1. Dừng ứng dụng (Ctrl+C ở cửa sổ đang chạy npm run dev / npm start).",
      "2. Đổi tên thư mục data/ hiện tại thành data-old/ (đừng xoá ngay).",
      `3. Chép thư mục data/ trong bản sao lưu này về thư mục gốc của dự án.`,
      "4. Nếu cần, chép lại .env từ thư mục config/ trong bản sao lưu.",
      "5. Chạy: npm run db:push",
      "6. Khởi động lại: npm run dev",
      "",
      `Sao lưu lúc: ${new Date().toISOString()}`,
      `Số tệp: ${result.files}`,
      `Dung lượng: ${formatBytes(result.bytes)}`,
    ].join("\n"),
    "utf8",
  );

  console.log(
    `Hoàn tất: ${result.files} tệp, ${formatBytes(result.bytes)}, ${configs} tệp cấu hình.`,
  );
  console.log(`Hướng dẫn khôi phục: ${path.join(target, "RESTORE.txt")}`);
}

main();
