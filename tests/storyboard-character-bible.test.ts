import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { parseStoryboardJson } from "@/domain/storyboard";
import {
  materialiseImport,
  scanImportSource,
  validateImport,
} from "@/services/storyboard-import";

/**
 * The Character Bible, coming in through an imported storyboard.
 *
 * The blocker this closes: before QĐ-070 an imported character was a NAME and
 * nothing else. `materialiseImport` created the row with
 * `"<name>, consistent character design across every scene"` as its entire
 * visual description - enough to stop the pipeline from treating scene 3's Max
 * as a different person by accident, and nowhere near enough to stop the image
 * model from drawing him differently.
 *
 * Three rules are guarded here:
 *
 *   1. A storyboard MAY state the Bible, and what it states is stored - and no
 *      more. A blank field stays blank rather than being filled with a
 *      plausible guess that would be pasted into every prompt forever.
 *   2. A character with no approved reference and none supplied is reported as
 *      NEEDS_CHARACTER_REFERENCE, and NOTHING here generates one. That is a
 *      paid call and it belongs to a person.
 *   3. An existing character is reused UNTOUCHED. An import that rewrote Max
 *      would silently redraw him in every older video regenerated afterwards.
 */

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const SCENE = (n: number, over: Record<string, unknown> = {}) => ({
  scene_number: n,
  duration: 4,
  visual_description: `Bo does thing ${n} on a plain background.`,
  character_action: "Bo nods once.",
  camera: "Locked static medium shot, no camera movement.",
  dialogue: `Bo: "Line ${n}."`,
  subtitle: `Line ${n}.`,
  motion_mode: "LOCAL_MOTION",
  priority: "LOW",
  image_file: "k.png",
  character_id: "bo",
  character_name: "Bo",
  ...over,
});

const FULL_BIBLE = {
  character_id: "bo",
  character_name: "Bo",
  character_presentation: "boy",
  character_age: "around eight",
  character_skin_tone: "light warm beige",
  character_hair: "short messy dark brown hair, slightly spiky",
  character_face: "round face, large round eyes",
  character_distinguishing_features: "a small scar above the left eyebrow",
  character_outfit: "bright yellow hoodie with a white chest stripe, blue jeans",
  character_body: "slightly oversized head, short and stocky",
  character_accessories: "",
  character_color_palette: "yellow, denim blue, white",
  character_negative_identity: "never add glasses, never remove the scar",
};

let tmp = "";

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-bible-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function folder(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeVideo(
  root: string,
  id: string,
  characters: Record<string, unknown>[],
  scenes: Record<string, unknown>[],
  files: Record<string, Buffer> = { "k.png": PNG_1X1 },
): void {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({ video_id: id, video_title: id, characters, scenes }),
  );
  for (const [name, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), bytes);
  }
}

// ----------------------------------------------------------------- parse ---

describe("parser: đọc hồ sơ nhân vật từ storyboard", () => {
  it("đọc đủ 11 trường, chấp nhận vài cách viết tên cột", () => {
    const out = parseStoryboardJson(
      JSON.stringify({
        video_id: "v",
        video_title: "v",
        characters: [FULL_BIBLE],
        scenes: [SCENE(1)],
      }),
      { sourceFile: "storyboard.json", fallbackVideoId: "v", fallbackVideoTitle: "V" },
    );
    expect(out.issues.filter((i) => i.level === "error")).toEqual([]);
    const bo = out.videos[0]!.characters.find((c) => c.characterId === "bo")!;
    expect(bo.bible.presentation).toBe("boy");
    expect(bo.bible.approximateAge).toBe("around eight");
    expect(bo.bible.skinTone).toBe("light warm beige");
    expect(bo.bible.distinguishingFeatures).toContain("scar");
    expect(bo.bible.negativeIdentity).toContain("never add glasses");
  });

  it("storyboard chỉ có tên vẫn hợp lệ, hồ sơ rỗng chứ không bịa", () => {
    const out = parseStoryboardJson(
      JSON.stringify({
        video_id: "v",
        video_title: "v",
        characters: [{ character_id: "bo", character_name: "Bo" }],
        scenes: [SCENE(1)],
      }),
      { sourceFile: "storyboard.json", fallbackVideoId: "v", fallbackVideoTitle: "V" },
    );
    expect(out.issues.filter((i) => i.level === "error")).toEqual([]);
    const bo = out.videos[0]!.characters[0]!;
    expect(Object.values(bo.bible).every((v) => v === "")).toBe(true);
  });

  // Two declarations of one person with two different hair colours is a
  // contradiction. Taking the last one would resolve it by file order.
  it("khai báo hai giá trị khác nhau cho cùng một thuộc tính -> cảnh báo, giữ giá trị ĐẦU", () => {
    const out = parseStoryboardJson(
      JSON.stringify({
        video_id: "v",
        video_title: "v",
        characters: [
          { character_id: "bo", character_name: "Bo", character_hair: "brown" },
          { character_id: "bo", character_name: "Bo", character_hair: "blond" },
        ],
        scenes: [SCENE(1)],
      }),
      { sourceFile: "storyboard.json", fallbackVideoId: "v", fallbackVideoTitle: "V" },
    );
    expect(out.issues.map((i) => i.code)).toContain("character_attribute_conflict");
    expect(out.videos[0]!.characters[0]!.bible.hair).toBe("brown");
  });
});

// ------------------------------------------------------------ validation ---

describe("validate: đánh dấu NEEDS_CHARACTER_REFERENCE, không tự tạo ảnh", () => {
  it("không có ảnh nhân vật và chưa từng có -> cảnh báo, KHÔNG phải lỗi", async () => {
    const root = folder("bible-1");
    writeVideo(root, "b1", [{ character_id: "nobody", character_name: "NobodyOne" }], [
      SCENE(1, { character_id: "nobody", character_name: "NobodyOne" }),
    ]);
    const validated = await validateImport(scanImportSource(root));

    const flagged = validated.issues.find((i) => i.code === "character_needs_reference");
    expect(flagged).toBeDefined();
    expect(flagged!.level).toBe("warning");
    expect(flagged!.message).toContain("NobodyOne");
    // The message has to say what the system will NOT do, or the operator waits
    // for an image that is never coming.
    expect(flagged!.message).toContain("KHÔNG tự tạo ảnh");

    const cast = validated.videos[0]!.characters.find((c) => c.name === "NobodyOne")!;
    expect(cast.readiness).toBe("NEEDS_CHARACTER_REFERENCE");
    expect(cast.existing).toBe(false);

    // The strongest proof: no Character row, no reference, no image job.
    expect(await prisma.character.findUnique({ where: { name: "NobodyOne" } })).toBeNull();
    expect(await prisma.providerJob.count({ where: { kind: "image" } })).toBe(
      await prisma.providerJob.count({ where: { kind: "image" } }),
    );
  });

  it("storyboard kèm ảnh nhân vật -> đủ ảnh, chỉ còn thiếu trường thì báo riêng", async () => {
    const root = folder("bible-2");
    writeVideo(
      root,
      "b2",
      [{ character_id: "thin", character_name: "ThinOne", character_reference_image: "ref.png" }],
      [SCENE(1, { character_id: "thin", character_name: "ThinOne" })],
      { "k.png": PNG_1X1, "ref.png": PNG_1X1 },
    );
    const validated = await validateImport(scanImportSource(root));

    const cast = validated.videos[0]!.characters.find((c) => c.name === "ThinOne")!;
    // Có ảnh, nhưng không một chữ nào mô tả ngoại hình.
    expect(cast.readiness).toBe("NEEDS_IDENTITY_FIELDS");
    const thin = validated.issues.find((i) => i.code === "character_identity_thin");
    expect(thin).toBeDefined();
    expect(thin!.level).toBe("warning");
    // Nói rõ phải điền ít nhất một thứ gì, chứ không đòi cả bảng.
    expect(thin!.message).toContain("ít nhất một");
    expect(thin!.message).toContain("tóc");
  });

  it("storyboard kèm ảnh VÀ hồ sơ đủ -> READY, không cảnh báo nhân vật nào", async () => {
    const root = folder("bible-3");
    writeVideo(
      root,
      "b3",
      [{ ...FULL_BIBLE, character_id: "ready", character_name: "ReadyOne", character_reference_image: "ref.png" }],
      [SCENE(1, { character_id: "ready", character_name: "ReadyOne" })],
      { "k.png": PNG_1X1, "ref.png": PNG_1X1 },
    );
    const validated = await validateImport(scanImportSource(root));

    const cast = validated.videos[0]!.characters.find((c) => c.name === "ReadyOne")!;
    expect(cast.readiness).toBe("READY");
    expect(cast.missingFields).toEqual([]);
    expect(
      validated.issues.filter(
        (i) => i.code === "character_needs_reference" || i.code === "character_identity_thin",
      ),
    ).toEqual([]);
  });
});

// --------------------------------------------------------- materialising ---

describe("materialise: lưu đúng hồ sơ, và KHÔNG ghi đè nhân vật đã có", () => {
  it("nhân vật mới nhận đủ 11 trường từ storyboard", async () => {
    const root = folder("bible-4");
    writeVideo(
      root,
      "b4",
      [{ ...FULL_BIBLE, character_id: "new1", character_name: "NewBo", character_reference_image: "ref.png" }],
      [SCENE(1, { character_id: "new1", character_name: "NewBo" })],
      { "k.png": PNG_1X1, "ref.png": PNG_1X1 },
    );
    const validated = await validateImport(scanImportSource(root));
    await materialiseImport(validated, {
      batchName: "bible-4",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });

    const row = await prisma.character.findUniqueOrThrow({ where: { name: "NewBo" } });
    expect(row.presentation).toBe("boy");
    expect(row.approximateAge).toBe("around eight");
    expect(row.skinTone).toBe("light warm beige");
    expect(row.hair).toContain("dark brown");
    expect(row.facialFeatures).toContain("round eyes");
    expect(row.distinguishingFeatures).toContain("scar");
    expect(row.outfit).toContain("yellow hoodie");
    expect(row.bodyProportions).toContain("oversized head");
    expect(row.colorPalette).toContain("denim blue");
    expect(row.negativeIdentity).toContain("never add glasses");

    // The supplied image became the approved master, since there was none.
    const primary = await prisma.characterReference.findFirst({
      where: { characterId: row.id, isPrimary: true },
    });
    expect(primary?.approved).toBe(true);
  });

  it("nhân vật đã tồn tại KHÔNG bị storyboard ghi đè", async () => {
    const before = await prisma.character.create({
      data: {
        name: "KeepBo",
        description: "đã có từ trước",
        personality: "",
        visualPrompt: "the original description",
        hair: "neat black hair",
        skinTone: "deep brown",
      },
    });

    const root = folder("bible-5");
    writeVideo(
      root,
      "b5",
      [{ ...FULL_BIBLE, character_id: "keep", character_name: "KeepBo" }],
      [SCENE(1, { character_id: "keep", character_name: "KeepBo" })],
    );
    const validated = await validateImport(scanImportSource(root));
    await materialiseImport(validated, {
      batchName: "bible-5",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });

    const after = await prisma.character.findUniqueOrThrow({ where: { name: "KeepBo" } });
    expect(after.id).toBe(before.id);
    expect(after.visualPrompt).toBe("the original description");
    expect(after.hair).toBe("neat black hair");
    expect(after.skinTone).toBe("deep brown");
    // The storyboard's values are simply not applied - not merged, not appended.
    expect(after.presentation).toBe("");
    expect(after.distinguishingFeatures).toBe("");
  });

  it("một nhân vật, sáu cảnh, vẫn là MỘT hàng Character", async () => {
    const root = folder("bible-6");
    writeVideo(
      root,
      "b6",
      [{ ...FULL_BIBLE, character_id: "solo", character_name: "SoloBo", character_reference_image: "ref.png" }],
      [1, 2, 3, 4, 5, 6].map((n) => SCENE(n, { character_id: "solo", character_name: "SoloBo" })),
      { "k.png": PNG_1X1, "ref.png": PNG_1X1 },
    );
    const validated = await validateImport(scanImportSource(root));
    const created = await materialiseImport(validated, {
      batchName: "bible-6",
      maxCostPerVideo: 5,
      maxCostForBatch: 20,
    });

    expect(await prisma.character.count({ where: { name: "SoloBo" } })).toBe(1);
    const scenes = await prisma.scene.findMany({
      where: { projectId: created.projects[0]!.projectId },
    });
    expect(scenes).toHaveLength(6);
    // Every scene points at the same name, so every prompt gets the same sheet.
    for (const s of scenes) {
      expect(JSON.parse(s.charactersPresentJson)).toEqual(["SoloBo"]);
    }
    expect(
      await prisma.characterReference.count({
        where: { character: { name: "SoloBo" } },
      }),
    ).toBe(1);
  });
});
