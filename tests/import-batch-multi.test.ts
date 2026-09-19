import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  materialiseImport,
  scanImportSource,
  validateImport,
} from "@/services/storyboard-import";
import { getCharacterSheetsByName } from "@/services/character-service";

/**
 * Several storyboards at once, and what must survive one of them being wrong.
 *
 * A folder of three storyboards is THREE PIECES OF WORK that happen to be
 * approved together. The batch is a convenience for approving money once; it is
 * not a unit of work, and it had been behaving as though it were: one bad row
 * in the third file refused the whole import, so the operator fixed the typo
 * and re-imported everything - and re-importing is exactly when duplicate
 * characters and duplicate reference images get made.
 *
 * So the rules under test here are about ISOLATION and IDENTITY:
 *
 *   - one bad video is skipped BY NAME, the rest import
 *   - a character named in six scenes is one row with one reference
 *   - "max" and "Max" are one person, not two faces
 *   - the same reference image imported twice is not two references
 *   - a video's state is its own, not its neighbours'
 *
 * Mock mode, throwaway database, no network, no money. See QĐ-073.
 */

const PNG_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
// A visibly different one byte-wise, so "same picture" is a real question.
const PNG_B = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let tmp = "";

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multi-import-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function folder(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const scene = (n: number, over: Record<string, unknown> = {}) => ({
  scene_number: n,
  duration: 4,
  visual_description: `Somebody does thing ${n} on a plain background.`,
  character_action: "They nod once.",
  camera: "Locked static medium shot, no camera movement.",
  dialogue: `Line ${n}.`,
  subtitle: `Line ${n}.`,
  motion_mode: "LOCAL_MOTION",
  priority: "LOW",
  image_file: "k.png",
  ...over,
});

function writeVideo(
  root: string,
  id: string,
  body: Record<string, unknown>,
  files: Record<string, Buffer> = { "k.png": PNG_A },
): void {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({ video_id: id, video_title: id, ...body }),
  );
  for (const [name, bytes] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}

// ------------------------------------------------- one bad video of three ---

describe("một video hỏng không kéo theo hai video kia", () => {
  it("mặc định vẫn từ chối cả lô — không tự ý nhập ít hơn người dùng đưa", async () => {
    const root = folder("partial-default");
    writeVideo(root, "good1", { scenes: [scene(1, { character_name: "MultiA" })] });
    writeVideo(root, "bad", {
      scenes: [
        scene(1, {
          character_name: "MultiA",
          motion_mode: "VIDEO_AI",
          video_provider: "mock",
          video_model: "khong-ton-tai",
        }),
      ],
    });
    const validated = await validateImport(scanImportSource(root));

    await expect(
      materialiseImport(validated, {
        batchName: "partial-default",
        maxCostPerVideo: 5,
        maxCostForBatch: 20,
      }),
    ).rejects.toThrow(/còn lỗi/i);
  });

  it("bật allowPartial: nhập video sạch, BỎ QUA video hỏng và NÊU TÊN nó", async () => {
    const root = folder("partial-on");
    writeVideo(root, "keep-a", { scenes: [scene(1, { character_name: "MultiA" })] });
    writeVideo(root, "keep-b", { scenes: [scene(1, { character_name: "MultiB" })] });
    writeVideo(root, "drop-me", {
      scenes: [
        scene(1, {
          character_name: "MultiC",
          motion_mode: "VIDEO_AI",
          video_provider: "mock",
          video_model: "khong-ton-tai",
        }),
      ],
    });
    const validated = await validateImport(scanImportSource(root));
    const created = await materialiseImport(validated, {
      batchName: "partial-on",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
      allowPartial: true,
    });

    expect(created.projects).toHaveLength(2);
    expect(created.projects.map((p) => p.videoId).sort()).toEqual(["keep-a", "keep-b"]);
    expect(created.skipped).toHaveLength(1);
    expect(created.skipped[0]!.videoId).toBe("drop-me");
    // The reason travels with the skip. A silent drop is the failure mode.
    expect(created.skipped[0]!.reasons.join(" ")).toContain("khong-ton-tai");

    // The skipped video left NOTHING behind - no project, no scenes, no
    // character invented for a video that was never imported.
    const projects = await prisma.project.findMany({ where: { batchId: created.batchId } });
    expect(projects).toHaveLength(2);
    expect(await prisma.character.findUnique({ where: { name: "MultiC" } })).toBeNull();
  });

  it("lỗi của NGUỒN (không thuộc video nào) vẫn chặn cả lô, kể cả allowPartial", async () => {
    const validated = await validateImport(scanImportSource(path.join(tmp, "khong-ton-tai")));
    await expect(
      materialiseImport(validated, {
        batchName: "x",
        maxCostPerVideo: 1,
        maxCostForBatch: 1,
        allowPartial: true,
      }),
    ).rejects.toThrow();
  });
});

// ------------------------------------------------------ identity across scenes ---

describe("một nhân vật, nhiều cảnh, nhiều video — vẫn một hồ sơ", () => {
  it("6 cảnh cùng character_id -> 1 hàng Character, 1 ảnh tham chiếu", async () => {
    const root = folder("one-cast");
    writeVideo(
      root,
      "six",
      {
        characters: [
          {
            character_id: "solo",
            character_name: "MultiSolo",
            character_reference_image: "ref.png",
            character_hair: "short brown hair",
          },
        ],
        scenes: [1, 2, 3, 4, 5, 6].map((n) =>
          scene(n, { character_id: "solo", character_name: "MultiSolo" }),
        ),
      },
      { "k.png": PNG_A, "ref.png": PNG_B },
    );
    const validated = await validateImport(scanImportSource(root));
    const created = await materialiseImport(validated, {
      batchName: "one-cast",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
      allowPartial: true,
    });

    expect(await prisma.character.count({ where: { name: "MultiSolo" } })).toBe(1);
    const row = await prisma.character.findUniqueOrThrow({ where: { name: "MultiSolo" } });
    expect(await prisma.characterReference.count({ where: { characterId: row.id } })).toBe(1);

    const scenes = await prisma.scene.findMany({
      where: { projectId: created.projects[0]!.projectId },
    });
    expect(scenes).toHaveLength(6);
    for (const s of scenes) {
      expect(JSON.parse(s.charactersPresentJson)).toEqual(["MultiSolo"]);
    }
  });

  // QĐ-072. SQLite compares with a BINARY collation, so the obvious lookup
  // misses and a second person appears with the same name in different capitals
  // - two rows, two faces, one character as far as a viewer is concerned.
  it("'multisolo' và 'MultiSolo' là MỘT người, không tạo hàng thứ hai", async () => {
    const before = await prisma.character.count();
    const root = folder("case-fold");
    writeVideo(root, "lower", {
      characters: [{ character_id: "s", character_name: "multisolo" }],
      scenes: [scene(1, { character_id: "s", character_name: "multisolo" })],
    });
    const validated = await validateImport(scanImportSource(root));
    await materialiseImport(validated, {
      batchName: "case-fold",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
      allowPartial: true,
    });

    expect(await prisma.character.count()).toBe(before);
    expect(await prisma.character.count({ where: { name: "MultiSolo" } })).toBe(1);
    expect(await prisma.character.findUnique({ where: { name: "multisolo" } })).toBeNull();

    // ...and the lookup the image path uses finds them from either spelling.
    const sheets = await getCharacterSheetsByName(["multisolo"]);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.name).toBe("MultiSolo");
  });

  it("cảnh viết hoa/thường lẫn lộn chỉ ra MỘT sheet, không nhân đôi", async () => {
    const sheets = await getCharacterSheetsByName(["MultiSolo", "multisolo", "MULTISOLO"]);
    expect(sheets).toHaveLength(1);
  });

  // Re-importing the same storyboard is the ordinary way an operator fixes a
  // typo. It must not grow the reference list each time.
  it("nhập lại cùng ảnh tham chiếu -> DÙNG LẠI, không tạo bản sao", async () => {
    const root = folder("dup-ref");
    writeVideo(
      root,
      "again",
      {
        characters: [
          {
            character_id: "solo",
            character_name: "MultiSolo",
            character_reference_image: "ref.png",
          },
        ],
        scenes: [scene(1, { character_id: "solo", character_name: "MultiSolo" })],
      },
      // Byte-identical to the one imported above.
      { "k.png": PNG_A, "ref.png": PNG_B },
    );
    const validated = await validateImport(scanImportSource(root));
    const created = await materialiseImport(validated, {
      batchName: "dup-ref",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
      allowPartial: true,
    });

    const row = await prisma.character.findUniqueOrThrow({ where: { name: "MultiSolo" } });
    expect(await prisma.characterReference.count({ where: { characterId: row.id } })).toBe(1);
    expect(created.reusedCharacterImages).toBe(1);
    expect(created.copiedImages).toBe(1); // the scene keyframe, not the reference
  });

  it("ảnh tham chiếu KHÁC thì mới thêm, và KHÔNG chiếm chỗ ảnh chính đã duyệt", async () => {
    const row = await prisma.character.findUniqueOrThrow({ where: { name: "MultiSolo" } });
    const primaryBefore = await prisma.characterReference.findFirstOrThrow({
      where: { characterId: row.id, isPrimary: true },
    });

    const root = folder("new-ref");
    writeVideo(
      root,
      "third",
      {
        characters: [
          {
            character_id: "solo",
            character_name: "MultiSolo",
            character_reference_image: "ref.png",
          },
        ],
        scenes: [scene(1, { character_id: "solo", character_name: "MultiSolo" })],
      },
      { "k.png": PNG_A, "ref.png": PNG_A },
    );
    const validated = await validateImport(scanImportSource(root));
    await materialiseImport(validated, {
      batchName: "new-ref",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
      allowPartial: true,
    });

    expect(await prisma.characterReference.count({ where: { characterId: row.id } })).toBe(2);
    const primaryAfter = await prisma.characterReference.findFirstOrThrow({
      where: { characterId: row.id, isPrimary: true },
    });
    // An import must never demote a reference a human already approved.
    expect(primaryAfter.id).toBe(primaryBefore.id);
  });
});
