import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  hasErrors,
  parseCsvRows,
  parseStoryboardCsv,
  parseStoryboardJson,
  isSafeRelativePath,
  type ImportIssue,
} from "@/domain/storyboard";
import { readZipBuffer } from "@/lib/zip";
import {
  materialiseImport,
  scanImportSource,
  validateImport,
} from "@/services/storyboard-import";
import { preflightImportedBatch } from "@/services/import-preflight";
import { buildBatchReport } from "@/services/batch-report";
import { generateSceneImage } from "@/services/generation";
import { toAbsolute } from "@/lib/paths";

/**
 * Import Storyboard / Batch From Scenes V1.
 *
 * Everything here runs in mock mode against a throwaway database and a
 * throwaway folder, so it costs nothing and contacts nobody. What it proves is
 * the part that is expensive to get wrong:
 *
 *   - a storyboard that brings its own keyframe is never charged for one
 *   - LOCAL_MOTION never reaches a video model
 *   - VIDEO_AI is an instruction, not a preference the planner may overrule
 *   - a pin to a DEPRECATED or DISABLED model is refused at the door
 *   - a malformed row is reported with its LINE, not swallowed
 *   - a ZIP cannot write outside the folder it was imported into
 *   - one bad video does not take the batch down with it
 *   - importing twice does not duplicate anything that costs money
 */

const CTX = { sourceFile: "storyboard.json", fallbackVideoId: "vid", fallbackVideoTitle: "Vid" };

function codes(issues: ImportIssue[]): string[] {
  return issues.map((i) => i.code);
}

// ---------------------------------------------------------------- fixtures ---

const SCENE = (n: number, over: Record<string, unknown> = {}) => ({
  scene_number: n,
  duration: 4,
  visual_description: `Max does thing ${n} on a plain background.`,
  character_action: "Max nods once.",
  camera: "Locked static medium shot, no camera movement.",
  dialogue: `Max: "Line ${n}."`,
  subtitle: `Line ${n}.`,
  motion_mode: "LOCAL_MOTION",
  priority: "LOW",
  ...over,
});

const SIX_SCENES = [1, 2, 3, 4, 5, 6].map((n) =>
  SCENE(n, n === 1 ? { motion_mode: "VIDEO_AI", priority: "HIGH", duration: 5 } : {}),
);

/** A 1x1 PNG, so a "supplied keyframe" is a real file on disk. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A ZIP writer, here rather than as a dependency.
 *
 * Testing our reader against an archive our writer made would only prove the
 * two agree. These bytes are laid out to the spec - local header, data, central
 * directory, EOCD - so the reader is tested against the format, including the
 * entry names it must refuse.
 */
function makeZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const deflated = zlib.deflateRawSync(file.data);
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-import-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function folder(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ------------------------------------------------------------------ JSON ---

describe("nhập JSON", () => {
  it("đọc đủ 6 cảnh và giữ nguyên nội dung đã soạn", () => {
    const out = parseStoryboardJson(
      JSON.stringify({ video_id: "v1", video_title: "Sáu cảnh", scenes: SIX_SCENES }),
      CTX,
    );
    expect(out.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(out.videos).toHaveLength(1);
    expect(out.videos[0]!.scenes).toHaveLength(6);
    expect(out.videos[0]!.videoTitle).toBe("Sáu cảnh");
    expect(out.videos[0]!.scenes[0]!.motionMode).toBe("VIDEO_AI");
    expect(out.videos[0]!.scenes[0]!.dialogue).toBe('Max: "Line 1."');
  });

  it("nhiều video trong một file", () => {
    const out = parseStoryboardJson(
      JSON.stringify({
        videos: [
          { video_id: "a", video_title: "A", scenes: [SCENE(1)] },
          { video_id: "b", video_title: "B", scenes: [SCENE(1), SCENE(2)] },
        ],
      }),
      CTX,
    );
    expect(out.videos.map((v) => v.videoId)).toEqual(["a", "b"]);
    expect(out.videos[1]!.scenes).toHaveLength(2);
  });

  it("JSON hỏng báo rõ là hỏng, không ném lỗi", () => {
    const out = parseStoryboardJson("{ not json", CTX);
    expect(codes(out.issues)).toEqual(["json_malformed"]);
    expect(out.videos).toEqual([]);
  });

  it("đúng JSON nhưng sai cấu trúc thì báo sai cấu trúc", () => {
    const out = parseStoryboardJson(JSON.stringify({ hello: "world" }), CTX);
    expect(codes(out.issues)).toEqual(["json_schema_invalid"]);
  });
});

// ------------------------------------------------------------------- CSV ---

describe("nhập CSV", () => {
  const HEADER =
    "video_id,video_title,scene_number,duration,visual_description,character_action,motion_mode,dialogue";

  it("đọc được dấu phẩy và xuống dòng nằm trong ô có nháy kép", () => {
    const csv =
      `${HEADER}\n` +
      `v1,Test,1,4,"Max stands, waits, and sighs.","Max nods.",LOCAL_MOTION,"Max: ""Hello, world."""\n` +
      `v1,Test,2,4,"Line one\nline two","Max nods.",LOCAL_MOTION,"Max: ""Two."""\n`;
    const out = parseStoryboardCsv(csv, { ...CTX, sourceFile: "s.csv" });
    expect(out.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(out.videos[0]!.scenes).toHaveLength(2);
    expect(out.videos[0]!.scenes[0]!.visualDescription).toBe("Max stands, waits, and sighs.");
    expect(out.videos[0]!.scenes[0]!.dialogue).toBe('Max: "Hello, world."');
    expect(out.videos[0]!.scenes[1]!.visualDescription).toContain("\n");
  });

  it("dòng thiếu ô báo đúng SỐ DÒNG", () => {
    const csv = `${HEADER}\n` + `v1,Test,1,4,"ok","ok",LOCAL_MOTION,"hi"\n` + `v1,Test,2,4,oops\n`;
    const out = parseStoryboardCsv(csv, { ...CTX, sourceFile: "s.csv" });
    const bad = out.issues.find((i) => i.code === "csv_column_count");
    expect(bad).toBeDefined();
    expect(bad!.line).toBe(3);
    // Dòng hỏng bị loại, dòng tốt vẫn vào.
    expect(out.videos[0]!.scenes).toHaveLength(1);
  });

  it("nháy kép không đóng làm hỏng cả file và được nói thẳng", () => {
    const out = parseStoryboardCsv(`${HEADER}\nv1,Test,1,4,"chưa đóng,,,\n`, {
      ...CTX,
      sourceFile: "s.csv",
    });
    expect(codes(out.issues)).toContain("csv_unterminated_quote");
    expect(out.videos).toEqual([]);
  });

  it("thiếu cột bắt buộc thì từ chối ngay ở dòng tiêu đề", () => {
    const out = parseStoryboardCsv("a,b,c\n1,2,3\n", { ...CTX, sourceFile: "s.csv" });
    expect(codes(out.issues)).toEqual(["csv_header_invalid"]);
  });

  it("CSV thô: ô rỗng cuối dòng vẫn được đếm", () => {
    const { rows } = parseCsvRows("a,b,c\n1,,3\n");
    expect(rows[1]).toEqual(["1", "", "3"]);
  });
});

// ------------------------------------------------------------ validation ---

describe("kiểm tra dữ liệu", () => {
  it("trùng scene_number là lỗi", () => {
    const out = parseStoryboardJson(
      JSON.stringify({ video_id: "v", scenes: [SCENE(1), SCENE(1), SCENE(2)] }),
      CTX,
    );
    expect(codes(out.issues)).toContain("scene_number_duplicate");
  });

  it("duration ngoài khoảng là lỗi, và cảnh đó không lọt vào", () => {
    const out = parseStoryboardJson(
      JSON.stringify({ video_id: "v", scenes: [SCENE(1, { duration: 900 }), SCENE(2)] }),
      CTX,
    );
    expect(codes(out.issues)).toContain("duration_invalid");
    expect(out.videos[0]!.scenes.map((s) => s.sceneNumber)).toEqual([2]);
  });

  it("motion_mode lạ bị từ chối chứ không bị đoán ý", () => {
    const out = parseStoryboardJson(
      JSON.stringify({ video_id: "v", scenes: [SCENE(1, { motion_mode: "MAYBE" })] }),
      CTX,
    );
    expect(codes(out.issues)).toContain("motion_mode_invalid");
  });

  it("ghim nửa vời (có provider, thiếu model) là lỗi", () => {
    const out = parseStoryboardJson(
      JSON.stringify({
        video_id: "v",
        scenes: [SCENE(1, { motion_mode: "VIDEO_AI", video_provider: "runway" })],
      }),
      CTX,
    );
    expect(codes(out.issues)).toContain("pin_incomplete");
  });

  it("LOCAL_MOTION mà lại ghim model là hai lệnh chọi nhau", () => {
    const out = parseStoryboardJson(
      JSON.stringify({
        video_id: "v",
        scenes: [
          SCENE(1, {
            motion_mode: "LOCAL_MOTION",
            video_provider: "runway",
            video_model: "x",
          }),
        ],
      }),
      CTX,
    );
    expect(codes(out.issues)).toContain("pin_contradicts_local_motion");
  });

  it("đường dẫn ảnh thoát thư mục bị chặn", () => {
    for (const bad of ["../../etc/passwd.png", "/etc/x.png", "C:\\x.png", "a/../../b.png"]) {
      expect(isSafeRelativePath(bad)).toBe(false);
    }
    expect(isSafeRelativePath("images/01.png")).toBe(true);
  });

  it("ảnh sai định dạng bị chặn", () => {
    const out = parseStoryboardJson(
      JSON.stringify({ video_id: "v", scenes: [SCENE(1, { image_file: "a.exe" })] }),
      CTX,
    );
    expect(codes(out.issues)).toContain("image_type_invalid");
  });
});

// ------------------------------------------------------------------- ZIP ---

describe("ZIP", () => {
  it("đọc được storyboard và ảnh trong ZIP", () => {
    const zip = makeZip([
      {
        name: "video-001/storyboard.json",
        data: Buffer.from(JSON.stringify({ video_id: "z1", scenes: [SCENE(1, { image_file: "a.png" })] })),
      },
      { name: "video-001/a.png", data: PNG_1X1 },
    ]);
    const listing = readZipBuffer(zip);
    expect(listing.entries.map((e) => e.path).sort()).toEqual([
      "video-001/a.png",
      "video-001/storyboard.json",
    ]);
    expect(listing.entries.find((e) => e.path.endsWith("a.png"))!.read()).toEqual(PNG_1X1);
  });

  it("từ chối mục thoát ra ngoài thư mục, và nói tên nó", () => {
    const zip = makeZip([
      { name: "../../evil.png", data: PNG_1X1 },
      { name: "video-001/storyboard.json", data: Buffer.from("[]") },
    ]);
    const listing = readZipBuffer(zip);
    expect(listing.entries.map((e) => e.path)).toEqual(["video-001/storyboard.json"]);
    expect(listing.rejected).toHaveLength(1);
    expect(listing.rejected[0]!.reason).toContain("..");
  });

  it("từ chối đường dẫn tuyệt đối và ổ đĩa", () => {
    const listing = readZipBuffer(
      makeZip([
        { name: "/etc/passwd", data: Buffer.from("x") },
        { name: "C:/windows/system32/a.dll", data: Buffer.from("x") },
        { name: "ok/storyboard.json", data: Buffer.from("[]") },
      ]),
    );
    expect(listing.entries.map((e) => e.path)).toEqual(["ok/storyboard.json"]);
    expect(listing.rejected).toHaveLength(2);
  });

  it("file không phải ZIP thì báo, không ném lỗi lạ", () => {
    expect(() => readZipBuffer(Buffer.from("this is not a zip file at all!!"))).toThrow(
      /ZIP/i,
    );
  });
});

// -------------------------------------------------------------- scanning ---

describe("quét nguồn nhập", () => {
  it("thư mục nhiều video: mỗi thư mục con là một video", () => {
    const root = folder("batch-a");
    for (const id of ["video-001", "video-002", "video-003"]) {
      const dir = path.join(root, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "storyboard.json"),
        JSON.stringify({ video_id: id, video_title: id, scenes: [SCENE(1, { image_file: "k.png" }), SCENE(2)] }),
      );
      fs.writeFileSync(path.join(dir, "k.png"), PNG_1X1);
    }
    const scan = scanImportSource(root);
    expect(scan.sourceKind).toBe("folder");
    expect(scan.videos.map((v) => v.video.videoId).sort()).toEqual([
      "video-001",
      "video-002",
      "video-003",
    ]);
  });

  it("ảnh trong thư mục con images/ vẫn tìm được", () => {
    const root = folder("batch-b");
    const dir = path.join(root, "video-009");
    fs.mkdirSync(path.join(dir, "images"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "storyboard.json"),
      JSON.stringify({ video_id: "video-009", scenes: [SCENE(1, { image_file: "images/01.png" })] }),
    );
    fs.writeFileSync(path.join(dir, "images", "01.png"), PNG_1X1);
    const scan = scanImportSource(root);
    expect(scan.videos).toHaveLength(1);
    expect(scan.videos[0]!.assets.has("images/01.png")).toBe(true);
  });

  it("nguồn không có storyboard nào thì nói thẳng", () => {
    const root = folder("batch-empty");
    fs.writeFileSync(path.join(root, "note.txt"), "nothing here");
    const scan = scanImportSource(root);
    expect(codes(scan.issues)).toContain("no_storyboard_found");
  });
});

// ------------------------------------------- database: the expensive part ---

describe("tạo lô từ storyboard (mock mode, $0)", () => {
  async function seedModels(): Promise<void> {
    const rows = [
      { modelId: "si-text", type: "text", priceUnit: "per_1k_tokens", price: 0.001, priceOutput: 0.002 },
      { modelId: "si-image", type: "image", priceUnit: "per_image", price: 0.02 },
      { modelId: "si-video", type: "video", priceUnit: "per_second", price: 0.05 },
      { modelId: "si-voice", type: "voice", priceUnit: "per_1k_chars", price: 0.01 },
      { modelId: "si-quality", type: "quality", priceUnit: "per_job", price: 0.004 },
    ];
    for (const row of rows) {
      await prisma.modelRegistry.upsert({
        where: { provider_modelId: { provider: "mock", modelId: row.modelId } },
        create: {
          provider: "mock",
          modelId: row.modelId,
          displayName: row.modelId,
          type: row.type,
          enabled: true,
          priceUnit: row.priceUnit,
          price: row.price,
          priceOutput: row.priceOutput ?? 0,
          supportsTextToVideo: true,
          supportsImageToVideo: true,
          supportsReferenceImage: true,
          supportsCharacterReference: true,
          supports1080p: true,
          maxDuration: 30,
          qualityRating: 6,
          speedRating: 6,
          consistencyRating: 6,
          lifecycle: "ACTIVE",
        },
        update: { enabled: true, price: row.price, lifecycle: "ACTIVE" },
      });
    }
    await prisma.modelRegistry.upsert({
      where: { provider_modelId: { provider: "mock", modelId: "si-dead" } },
      create: {
        provider: "mock",
        modelId: "si-dead",
        displayName: "si-dead",
        type: "video",
        enabled: true,
        priceUnit: "per_second",
        price: 0.05,
        supportsTextToVideo: true,
        supportsImageToVideo: true,
        maxDuration: 30,
        qualityRating: 6,
        lifecycle: "DEPRECATED",
      },
      update: { lifecycle: "DEPRECATED", enabled: true },
    });
  }

  function writeVideo(root: string, id: string, scenes: Record<string, unknown>[], withImages = true) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "storyboard.json"),
      JSON.stringify({ video_id: id, video_title: id, scenes }),
    );
    if (withImages) fs.writeFileSync(path.join(dir, "k.png"), PNG_1X1);
  }

  beforeAll(async () => {
    await seedModels();
  });

  it("ảnh do storyboard cung cấp được chép vào dự án và đánh dấu IMPORTED", async () => {
    const root = folder("db-1");
    writeVideo(root, "db1", [
      SCENE(1, { image_file: "k.png", motion_mode: "VIDEO_AI", duration: 5 }),
      SCENE(2, { image_file: "k.png" }),
      SCENE(3),
    ]);
    const validated = await validateImport(scanImportSource(root));
    expect(hasErrors(validated.issues)).toBe(false);

    const created = await materialiseImport(validated, {
      batchName: "db-1",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const scenes = await prisma.scene.findMany({
      where: { projectId: created.projects[0]!.projectId },
      orderBy: { sceneNumber: "asc" },
    });
    expect(scenes).toHaveLength(3);
    expect(scenes[0]!.imageSource).toBe("IMPORTED");
    expect(scenes[0]!.status).toBe("image_ready");
    expect(fs.existsSync(toAbsolute(scenes[0]!.imagePath!))).toBe(true);
    // Cảnh không có ảnh thì vẫn phải tự tạo, và nói rõ là sẽ tạo.
    expect(scenes[2]!.imageSource).toBe("GENERATED");
    expect(scenes[2]!.imagePath).toBeNull();

    // Kịch bản có sẵn → dự án bắt đầu ở script_ready, không ai hỏi Text AI.
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: created.projects[0]!.projectId },
    });
    expect(project.status).toBe("script_ready");
    expect(project.scriptJson).toContain("IMPORT");

    // Quyền chi DRAFT: chưa tiêu được gì.
    const auth = await prisma.batchAuthorization.findUniqueOrThrow({
      where: { batchId: created.batchId },
    });
    expect(auth.status).toBe("DRAFT");
    expect(auth.authorizedMaxSpend).toBe(0);
  });

  it("KHÔNG gọi Image AI cho cảnh đã có ảnh nhập sẵn", async () => {
    const root = folder("db-2");
    writeVideo(root, "db2", [SCENE(1, { image_file: "k.png" })]);
    const validated = await validateImport(scanImportSource(root));
    const created = await materialiseImport(validated, {
      batchName: "db-2",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const scene = await prisma.scene.findFirstOrThrow({
      where: { projectId: created.projects[0]!.projectId },
    });

    const before = await prisma.providerJob.count({ where: { kind: "image" } });
    const result = await generateSceneImage(scene.id);
    const after = await prisma.providerJob.count({ where: { kind: "image" } });

    expect(result).toBeTruthy();
    // Bằng chứng mạnh nhất: KHÔNG có ProviderJob ảnh nào được tạo thêm.
    expect(after).toBe(before);
    const costs = await prisma.costEntry.count({ where: { sceneId: scene.id, category: "image" } });
    expect(costs).toBe(0);
  });

  it("LOCAL_MOTION không bao giờ chạm tới model video; VIDEO_AI thì có", async () => {
    const root = folder("db-3");
    writeVideo(root, "db3", [
      SCENE(1, { image_file: "k.png", motion_mode: "VIDEO_AI", duration: 5, priority: "HIGH" }),
      SCENE(2, { image_file: "k.png", motion_mode: "LOCAL_MOTION" }),
      SCENE(3, { image_file: "k.png", motion_mode: "AUTO" }),
    ]);
    const validated = await validateImport(scanImportSource(root));
    const created = await materialiseImport(validated, {
      batchName: "db-3",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const pre = await preflightImportedBatch(created.batchId);
    const video = pre.videos[0]!;
    const byNumber = new Map(video.scenes.map((s) => [s.sceneNumber, s]));

    expect(byNumber.get(2)!.motionSource).toBe("LOCAL_MOTION");
    expect(byNumber.get(2)!.videoModel).toBeNull();
    expect(byNumber.get(2)!.estimatedCost).toBeLessThan(byNumber.get(1)!.estimatedCost);

    // VIDEO_AI là chỉ thị, không phải sở thích: luật "miễn phí thắng" không
    // được phép hạ nó xuống LOCAL_MOTION.
    //
    // Khẳng định là "có đi tới MỘT model trả phí", không phải "đúng model tôi
    // seed". Router được quyền chọn trong số model đang bật, và khi chạy cả bộ
    // test thì có nhiều model hơn khi chạy riêng file này — ép đích danh là
    // kiểm tra nhiều hơn thứ luật này nói. Việc ghim đích danh đã có test riêng.
    expect(byNumber.get(1)!.motionSource).toBe("AI_VIDEO");
    expect(byNumber.get(1)!.videoModel).toBeTruthy();
    expect(byNumber.get(1)!.estimatedCost).toBeGreaterThan(0);
    expect(byNumber.get(1)!.keyframe).toBe("supplied");
  });

  it("ghim model không tồn tại / đã NGỪNG DÙNG bị chặn ngay khi nhập", async () => {
    const root = folder("db-4");
    writeVideo(root, "db4", [
      SCENE(1, { motion_mode: "VIDEO_AI", video_provider: "mock", video_model: "khong-co-that" }),
    ]);
    const a = await validateImport(scanImportSource(root));
    expect(codes(a.issues)).toContain("pin_model_unknown");

    const root2 = folder("db-5");
    writeVideo(root2, "db5", [
      SCENE(1, { motion_mode: "VIDEO_AI", video_provider: "mock", video_model: "si-dead" }),
    ]);
    const b = await validateImport(scanImportSource(root2));
    expect(codes(b.issues)).toContain("pin_model_deprecated");

    // Và không tạo được lô từ dữ liệu còn lỗi.
    await expect(
      materialiseImport(b, { batchName: "x", maxCostPerVideo: 1, maxCostForBatch: 1 }),
    ).rejects.toThrow(/lỗi/i);
  });

  it("thiếu ảnh khai báo trong storyboard là lỗi, có nói tên file", async () => {
    const root = folder("db-6");
    writeVideo(root, "db6", [SCENE(1, { image_file: "khong-ton-tai.png" })], false);
    const validated = await validateImport(scanImportSource(root));
    const miss = validated.issues.find((i) => i.code === "image_missing");
    expect(miss).toBeDefined();
    expect(miss!.message).toContain("khong-ton-tai.png");
    expect(miss!.sceneNumber).toBe(1);
  });

  it("dự toán: một video vượt trần bị chặn RIÊNG, lô vẫn chạy được phần còn lại", async () => {
    const root = folder("db-7");
    writeVideo(root, "cheap", [SCENE(1, { image_file: "k.png" }), SCENE(2, { image_file: "k.png" })]);
    writeVideo(root, "pricey", [
      SCENE(1, { image_file: "k.png", motion_mode: "VIDEO_AI", duration: 20, priority: "HIGH" }),
      SCENE(2, { image_file: "k.png", motion_mode: "VIDEO_AI", duration: 20, priority: "HIGH" }),
    ]);
    const validated = await validateImport(scanImportSource(root));
    const created = await materialiseImport(validated, {
      batchName: "db-7",
      maxCostPerVideo: 0.5,
      maxCostForBatch: 10,
    });
    const pre = await preflightImportedBatch(created.batchId);

    const pricey = pre.videos.find((v) => v.title === "pricey")!;
    const cheap = pre.videos.find((v) => v.title === "cheap")!;
    expect(pricey.status).toBe("OVER_VIDEO_BUDGET");
    expect(cheap.status).toBe("OK");
    expect(pre.runnableCount).toBe(1);
    expect(pre.blockedCount).toBe(1);
    // Tổng "chạy được" không được tính tiền của video bị chặn.
    expect(pre.estimatedTotal).toBeCloseTo(cheap.estimatedCost, 6);
    expect(pre.estimatedTotalIncludingBlocked).toBeGreaterThanOrEqual(pre.estimatedTotal);

    // QĐ-081. `estimatedCost` của một video vượt trần là phần LỌT VÀO trần, vì
    // bộ dự toán đi dần theo từng cảnh rồi dừng khi hết tiền. Con số thật nằm ở
    // `uncappedCost`, và chính nó mới nói được "phải nâng trần thêm bao nhiêu".
    expect(pricey.uncappedCost).toBeGreaterThan(pricey.estimatedCost);
    expect(pricey.uncappedCost).toBeGreaterThan(0.5);
    expect(pricey.blockedReason).toContain("thật ra tốn");
    // Video chạy được thì hai con số bằng nhau — không có gì bị cắt.
    expect(cheap.uncappedCost).toBeCloseTo(cheap.estimatedCost, 6);
    expect(pre.estimatedTotalUncapped).toBeGreaterThan(pre.estimatedTotalIncludingBlocked);
  });

  it("vượt trần cả lô thì cảnh báo, không tự nâng trần", async () => {
    const root = folder("db-8");
    writeVideo(root, "big", [
      SCENE(1, { image_file: "k.png", motion_mode: "VIDEO_AI", duration: 20, priority: "HIGH" }),
    ]);
    const validated = await validateImport(scanImportSource(root));
    const created = await materialiseImport(validated, {
      batchName: "db-8",
      maxCostPerVideo: 5,
      maxCostForBatch: 0.01,
    });
    const pre = await preflightImportedBatch(created.batchId);
    expect(pre.overBatchCeiling).toBe(true);
    expect(pre.warnings.join(" ")).toContain("vượt trần");
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: created.batchId } });
    expect(batch.maxBudget).toBe(0.01);
  });

  it("nhập lại cùng video_id dùng lại idiom cũ, không đẻ thêm bản trùng", async () => {
    const root = folder("db-9");
    writeVideo(root, "repeat-me", [SCENE(1, { image_file: "k.png" })]);
    const first = await materialiseImport(await validateImport(scanImportSource(root)), {
      batchName: "db-9a",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const second = await materialiseImport(await validateImport(scanImportSource(root)), {
      batchName: "db-9b",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    expect(first.batchId).not.toBe(second.batchId);
    const idioms = await prisma.idiom.findMany({ where: { slug: "import-repeat-me" } });
    expect(idioms).toHaveLength(1);
  });

  it("báo cáo lô đọc từ sổ, không từ bộ đếm trong bộ nhớ", async () => {
    const root = folder("db-10");
    writeVideo(root, "rep", [SCENE(1, { image_file: "k.png" }), SCENE(2, { image_file: "k.png" })]);
    const created = await materialiseImport(await validateImport(scanImportSource(root)), {
      batchName: "db-10",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    await preflightImportedBatch(created.batchId);
    const report = await buildBatchReport(created.batchId);

    expect(report.totals.videos).toBe(1);
    expect(report.totals.scenes).toBe(2);
    expect(report.videos[0]!.suppliedKeyframes).toBe(2);
    expect(report.videos[0]!.actualCost).toBe(0);
    expect(report.authorization!.status).toBe("DRAFT");
    expect(report.reservations.reserved).toBe(0);
  });

  it("một video hỏng không kéo cả lô xuống", async () => {
    const root = folder("db-11");
    writeVideo(root, "good-one", [SCENE(1, { image_file: "k.png" })]);
    // Video thứ hai có một cảnh hỏng và một cảnh tốt.
    writeVideo(root, "half-bad", [SCENE(1, { image_file: "k.png" }), SCENE(2, { duration: -5 })]);
    const validated = await validateImport(scanImportSource(root));

    // Cảnh hỏng bị loại và được báo; video vẫn còn cảnh tốt để chạy.
    expect(codes(validated.issues)).toContain("duration_invalid");
    const halfBad = validated.videos.find((v) => v.videoId === "half-bad")!;
    expect(halfBad.scenes).toHaveLength(1);
    const good = validated.videos.find((v) => v.videoId === "good-one")!;
    expect(good.scenes).toHaveLength(1);
  });
});

// ------------------------------------------------- ZIP, AUTO, pin, resume ---

describe("ZIP end-to-end, định tuyến AUTO, ghim hợp lệ, và chạy lại", () => {
  function zipOf(files: { name: string; data: Buffer }[], name: string): string {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, makeZip(files));
    return file;
  }

  it("nhập thẳng từ file .zip, ảnh trong ZIP thành keyframe thật trên đĩa", async () => {
    const zip = zipOf(
      [
        {
          name: "video-z1/storyboard.json",
          data: Buffer.from(
            JSON.stringify({
              video_id: "zip-one",
              video_title: "Từ ZIP",
              scenes: [SCENE(1, { image_file: "shots/a.png" }), SCENE(2)],
            }),
          ),
        },
        { name: "video-z1/shots/a.png", data: PNG_1X1 },
      ],
      "one.zip",
    );

    const scan = scanImportSource(zip);
    expect(scan.sourceKind).toBe("zip");
    const validated = await validateImport(scan);
    expect(hasErrors(validated.issues)).toBe(false);

    const created = await materialiseImport(validated, {
      batchName: "zip-1",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const scenes = await prisma.scene.findMany({
      where: { projectId: created.projects[0]!.projectId },
      orderBy: { sceneNumber: "asc" },
    });
    expect(scenes[0]!.imageSource).toBe("IMPORTED");
    expect(fs.existsSync(toAbsolute(scenes[0]!.imagePath!))).toBe(true);
    expect(fs.readFileSync(toAbsolute(scenes[0]!.imagePath!))).toEqual(PNG_1X1);
    expect(scenes[1]!.imageSource).toBe("GENERATED");
  });

  it("ZIP nhiều video tạo nhiều dự án độc lập", async () => {
    const files = ["m1", "m2", "m3"].flatMap((id) => [
      {
        name: `${id}/storyboard.json`,
        data: Buffer.from(
          JSON.stringify({ video_id: id, video_title: id, scenes: [SCENE(1, { image_file: "k.png" })] }),
        ),
      },
      { name: `${id}/k.png`, data: PNG_1X1 },
    ]);
    const created = await materialiseImport(
      await validateImport(scanImportSource(zipOf(files, "many.zip"))),
      { batchName: "zip-many", maxCostPerVideo: 5, maxCostForBatch: 20 },
    );
    expect(created.projects).toHaveLength(3);
    const ids = new Set(created.projects.map((p) => p.projectId));
    expect(ids.size).toBe(3);
    // Mỗi video có hạn mức riêng, sổ riêng, trạng thái riêng.
    const projects = await prisma.project.findMany({ where: { batchId: created.batchId } });
    expect(projects.every((p) => p.maxBudget === 5)).toBe(true);
    expect(projects.every((p) => p.status === "script_ready")).toBe(true);
  });

  it("AUTO để router quyết, và nó chọn LOCAL_MOTION cho cảnh LOW rẻ tiền", async () => {
    const root = folder("auto-1");
    const dir = path.join(root, "auto");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "k.png"), PNG_1X1);
    fs.writeFileSync(
      path.join(dir, "storyboard.json"),
      JSON.stringify({
        video_id: "auto",
        scenes: [SCENE(1, { image_file: "k.png", motion_mode: "AUTO", priority: "LOW" })],
      }),
    );
    const created = await materialiseImport(await validateImport(scanImportSource(root)), {
      batchName: "auto-1",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const pre = await preflightImportedBatch(created.batchId);
    const scene = pre.videos[0]!.scenes[0]!;
    // Không khẳng định router PHẢI chọn cái gì; khẳng định nó được phép chọn,
    // và cảnh AUTO không bị ép thành trả phí.
    expect(scene.motionMode).toBe("AUTO");
    expect(["LOCAL_MOTION", "AI_VIDEO"]).toContain(scene.motionSource);
    if (scene.motionSource === "LOCAL_MOTION") expect(scene.videoModel).toBeNull();
  });

  it("ghim hợp lệ được tôn trọng đúng model đã ghi", async () => {
    const root = folder("pin-1");
    const dir = path.join(root, "pinned");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "k.png"), PNG_1X1);
    fs.writeFileSync(
      path.join(dir, "storyboard.json"),
      JSON.stringify({
        video_id: "pinned",
        scenes: [
          SCENE(1, {
            image_file: "k.png",
            motion_mode: "VIDEO_AI",
            video_provider: "mock",
            video_model: "si-video",
            duration: 5,
            priority: "HIGH",
          }),
        ],
      }),
    );
    const validated = await validateImport(scanImportSource(root));
    expect(hasErrors(validated.issues)).toBe(false);

    const created = await materialiseImport(validated, {
      batchName: "pin-1",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const scene = await prisma.scene.findFirstOrThrow({
      where: { projectId: created.projects[0]!.projectId },
    });
    expect(scene.videoProvider).toBe("mock");
    expect(scene.videoModel).toBe("si-video");
    expect(scene.motionMode).toBe("VIDEO_AI");

    const pre = await preflightImportedBatch(created.batchId);
    expect(pre.videos[0]!.scenes[0]!.videoModel).toBe("mock/si-video");
    expect(pre.videos[0]!.scenes[0]!.motionSource).toBe("AI_VIDEO");
  });

  it("chạy lại: ảnh nhập sẵn không bao giờ sinh ProviderJob, gọi bao nhiêu lần cũng vậy", async () => {
    const root = folder("resume-1");
    const dir = path.join(root, "res");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "k.png"), PNG_1X1);
    fs.writeFileSync(
      path.join(dir, "storyboard.json"),
      JSON.stringify({ video_id: "res", scenes: [SCENE(1, { image_file: "k.png" })] }),
    );
    const created = await materialiseImport(await validateImport(scanImportSource(root)), {
      batchName: "resume-1",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const scene = await prisma.scene.findFirstOrThrow({
      where: { projectId: created.projects[0]!.projectId },
    });

    const before = await prisma.providerJob.count();
    const first = await generateSceneImage(scene.id);
    const second = await generateSceneImage(scene.id);
    const after = await prisma.providerJob.count();

    expect(first).toBe(second);
    expect(after).toBe(before);
    expect(await prisma.costEntry.count({ where: { sceneId: scene.id } })).toBe(0);
  });

  it("ảnh nhập sẵn biến mất khỏi đĩa thì DỪNG, không âm thầm mua ảnh thay thế", async () => {
    const root = folder("resume-2");
    const dir = path.join(root, "gone");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "k.png"), PNG_1X1);
    fs.writeFileSync(
      path.join(dir, "storyboard.json"),
      JSON.stringify({ video_id: "gone", scenes: [SCENE(1, { image_file: "k.png" })] }),
    );
    const created = await materialiseImport(await validateImport(scanImportSource(root)), {
      batchName: "resume-2",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const scene = await prisma.scene.findFirstOrThrow({
      where: { projectId: created.projects[0]!.projectId },
    });
    fs.rmSync(toAbsolute(scene.imagePath!));

    const before = await prisma.providerJob.count();
    await expect(generateSceneImage(scene.id)).rejects.toThrow(/không còn trên đĩa/i);
    expect(await prisma.providerJob.count()).toBe(before);
  });
});

// -------------------------------------------- không được phá thư viện V1 ---

describe("không làm hỏng luồng V1", () => {
  it("idiom do import tạo ra phải HỢP LỆ với ScriptSchema, không để ô trống", async () => {
    const root = folder("v1-safe");
    const dir = path.join(root, "safe");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "k.png"), PNG_1X1);
    fs.writeFileSync(
      path.join(dir, "storyboard.json"),
      JSON.stringify({
        video_id: "safe",
        video_title: "Một tiêu đề",
        scenes: [SCENE(1, { image_file: "k.png", dialogue: 'Max: "Câu thoại đầu tiên."' })],
      }),
    );
    const created = await materialiseImport(await validateImport(scanImportSource(root)), {
      batchName: "v1-safe",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: created.projects[0]!.projectId },
      include: { idiom: true },
    });

    // Thư viện idiom là của DÙNG CHUNG. Một hàng có ô bắt buộc để rỗng không
    // hỏng lúc nhập — nó hỏng sau đó, trong một lô V1 chẳng liên quan gì.
    expect(project.idiom.meaning.length).toBeGreaterThan(0);
    expect(project.idiom.literalMeaning.length).toBeGreaterThan(0);
    expect(project.idiom.exampleSentence.length).toBeGreaterThan(0);
    // Nhãn người nói không phải câu ví dụ.
    expect(project.idiom.exampleSentence).toBe("Câu thoại đầu tiên.");
  });

  it("idiom nhập KHÔNG nằm trong danh sách bộ chọn của V1", async () => {
    const root = folder("v1-picker");
    const dir = path.join(root, "nopick");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "storyboard.json"),
      JSON.stringify({ video_id: "nopick", scenes: [SCENE(1)] }),
    );
    await materialiseImport(await validateImport(scanImportSource(root)), {
      batchName: "v1-picker",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });

    const idiom = await prisma.idiom.findUniqueOrThrow({ where: { slug: "import-nopick" } });
    expect(idiom.status).toBe("imported");
    expect(["unused", "planned"]).not.toContain(idiom.status);

    const pickable = await prisma.idiom.findMany({
      where: { status: { in: ["unused", "planned"] } },
      select: { slug: true },
    });
    expect(pickable.map((i) => i.slug)).not.toContain("import-nopick");
  });
});
