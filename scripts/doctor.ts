import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

/**
 * Environment check.
 *
 * Run `npm run doctor` when something will not start. It verifies the handful of
 * things that actually go wrong on a fresh Windows machine, and says what to do
 * about each one, rather than leaving the operator to read a stack trace.
 */

const ROOT = process.cwd();
let failures = 0;
let warnings = 0;

function ok(label: string, detail = ""): void {
  console.log(`  [OK]   ${label}${detail ? ` - ${detail}` : ""}`);
}
function warn(label: string, advice: string): void {
  warnings++;
  console.log(`  [WARN] ${label}\n         -> ${advice}`);
}
function fail(label: string, advice: string): void {
  failures++;
  console.log(`  [FAIL] ${label}\n         -> ${advice}`);
}

function checkNode(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok("Node.js", `v${process.versions.node}`);
  else {
    fail(
      `Node.js quá cũ (v${process.versions.node})`,
      "Cài Node.js 20 LTS trở lên từ https://nodejs.org",
    );
  }
}

function checkEnv(): void {
  if (!fs.existsSync(path.join(ROOT, ".env"))) {
    fail(
      "Không tìm thấy tệp .env",
      "Chạy: copy .env.example .env  (rồi mở ra kiểm tra DATABASE_URL)",
    );
    return;
  }
  ok("Tệp .env");

  const mock = process.env.AI_MOCK_MODE;
  if (mock === undefined || mock.toLowerCase() === "true") {
    ok("AI_MOCK_MODE", "bật - sẽ không gọi API tính phí");
  } else {
    warn(
      "AI_MOCK_MODE=false",
      "Ứng dụng sẽ gọi nhà cung cấp thật và phát sinh chi phí. " +
        "Đặt lại thành true nếu bạn chỉ đang thử nghiệm.",
    );
  }

  if (!process.env.SECRET_ENCRYPTION_KEY) {
    warn(
      "Chưa có SECRET_ENCRYPTION_KEY",
      'Tạo bằng: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
        "rồi dán vào .env. Không có khoá này thì không lưu được API key từ giao diện.",
    );
  } else {
    ok("SECRET_ENCRYPTION_KEY");
  }
}

function resolveBinary(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function checkFfmpeg(): void {
  const bundledFfmpeg = path.join(
    ROOT,
    "node_modules",
    "ffmpeg-static",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  const binary = resolveBinary([
    process.env.FFMPEG_PATH ?? "",
    bundledFfmpeg,
  ]);

  if (!binary) {
    fail(
      "Không tìm thấy FFmpeg",
      "Chạy: npm install   (gói ffmpeg-static sẽ tải sẵn bản dùng được), " +
        "hoặc cài riêng: winget install Gyan.FFmpeg",
    );
    return;
  }

  try {
    const out = execFileSync(binary, ["-hide_banner", "-version"], {
      encoding: "utf8",
    });
    const version = out.split("\n")[0]?.trim() ?? "";
    ok("FFmpeg", version.slice(0, 60));

    const filters = execFileSync(binary, ["-hide_banner", "-filters"], {
      encoding: "utf8",
    });
    if (filters.includes(" subtitles ")) ok("Bộ lọc subtitles (libass)");
    else {
      warn(
        "FFmpeg không có bộ lọc subtitles",
        "Phụ đề sẽ được xuất ra tệp .srt riêng thay vì ghi thẳng lên video.",
      );
    }
    if (filters.includes(" scale ")) ok("Bộ lọc scale");
  } catch (err) {
    fail(
      "FFmpeg không chạy được",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function checkDirs(): void {
  const dataDir = path.join(ROOT, "data");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, ".write-probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    ok("Thư mục data/ ghi được", dataDir);
  } catch (err) {
    fail(
      "Không ghi được vào thư mục data/",
      `Kiểm tra quyền truy cập ổ đĩa. ${err instanceof Error ? err.message : ""}`,
    );
  }
}

function checkPrompts(): void {
  const names = [
    "concept",
    "script",
    "storyboard",
    "image",
    "video",
    "quality",
    "youtube",
  ];
  const missing = names.filter(
    (n) => !fs.existsSync(path.join(ROOT, "prompts", `${n}.txt`)),
  );
  if (missing.length === 0) ok("Mẫu prompt", `${names.length} tệp`);
  else {
    fail(
      `Thiếu mẫu prompt: ${missing.join(", ")}`,
      "Khôi phục thư mục prompts/ từ kho mã nguồn.",
    );
  }
}

async function checkDatabase(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const [idioms, characters, presets, models, providers] = await Promise.all([
      prisma.idiom.count(),
      prisma.character.count(),
      prisma.stylePreset.count(),
      prisma.modelRegistry.count(),
      prisma.providerConfig.count(),
    ]);
    ok("Kết nối SQLite");

    if (idioms === 0) {
      warn("Thư viện thành ngữ trống", "Chạy: npm run seed");
    } else ok("Thành ngữ", String(idioms));

    if (characters === 0) warn("Chưa có nhân vật", "Chạy: npm run seed");
    else ok("Nhân vật", String(characters));

    if (presets === 0) warn("Chưa có phong cách", "Chạy: npm run seed");
    else ok("Phong cách", String(presets));

    if (models === 0) {
      fail("Bảng mô hình AI trống", "Chạy: npm run seed - không có mô hình thì AI Router không chạy được.");
    } else ok("Mô hình AI", String(models));

    const enabled = await prisma.modelRegistry.count({
      where: { enabled: true, provider: { not: "mock" } },
    });
    const unpriced = await prisma.modelRegistry.count({
      where: { enabled: true, provider: { not: "mock" }, price: { lte: 0 } },
    });
    if (enabled > 0 && unpriced > 0) {
      warn(
        `${unpriced} mô hình thật đang bật nhưng giá = 0`,
        "Nhập giá thực tế ở trang Mô hình AI, nếu không phần ước tính chi phí sẽ sai.",
      );
    }

    ok("Nhà cung cấp", String(providers));

    const stuck = await prisma.job.count({ where: { status: "processing" } });
    if (stuck > 0) {
      warn(
        `${stuck} job đang ở trạng thái "processing"`,
        "Khởi động lại ứng dụng - worker sẽ tự đưa chúng về hàng đợi.",
      );
    }
  } catch (err) {
    fail(
      "Không kết nối được SQLite",
      `Chạy: npm run db:push. ${err instanceof Error ? err.message : ""}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  console.log("\nKiểm tra môi trường Funny Idioms Video Factory\n");

  console.log("Hệ thống:");
  checkNode();
  checkDirs();

  console.log("\nCấu hình:");
  checkEnv();
  checkPrompts();

  console.log("\nFFmpeg:");
  checkFfmpeg();

  console.log("\nCơ sở dữ liệu:");
  await checkDatabase();

  console.log(
    `\nKết quả: ${failures} lỗi, ${warnings} cảnh báo.` +
      (failures === 0
        ? "\nSẵn sàng chạy: npm run dev\n"
        : "\nHãy xử lý các mục [FAIL] ở trên trước khi chạy ứng dụng.\n"),
  );
  if (failures > 0) process.exitCode = 1;
}

void main();
