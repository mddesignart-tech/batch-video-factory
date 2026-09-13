import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { toAbsolute } from "@/lib/paths";
import { resetEnvCache } from "@/lib/env";
import {
  buildCanonicalDescription,
  buildMasterPrompt,
  buildNegativePrompt,
  buildScenePrompt,
  getCharacterSheet,
  getCharacterSheetsByName,
  LOCKED_ATTRIBUTES,
} from "@/services/character-service";
import {
  approveCharacterReference,
  deleteCharacterReference,
  generateCharacterMaster,
  masterIdempotencyKey,
  uploadCharacterReference,
} from "@/services/character-master";
import { costSummary } from "@/services/cost-tracker";
import { setSpendCap } from "@/services/spend-guard";

/**
 * The character consistency machinery.
 *
 * These tests guard the promise the whole feature rests on: what a character
 * looks like is stored data that gets pasted into every prompt, and it does not
 * change unless a human changes it.
 */

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let maxId = "";
let leoId = "";

beforeAll(async () => {
  // Mock mode keeps every generation in this file free.
  process.env.AI_MOCK_MODE = "true";
  resetEnvCache();
  await setSpendCap(3);

  const max = await prisma.character.upsert({
    where: { name: "RefMax" },
    update: {},
    create: {
      name: "RefMax",
      description: "Nhân vật chính",
      personality: "naive",
      visualPrompt: "young adult male cartoon character, light warm skin",
      negativePrompt: "realistic photo, extra fingers",
      hair: "short messy dark brown hair",
      facialFeatures: "large round expressive eyes",
      outfit: "bright yellow hoodie, blue jeans",
      bodyProportions: "slightly oversized head",
      accessories: "",
      colorPalette: "yellow, blue, white",
      seed: 110022,
    },
  });
  maxId = max.id;

  const leo = await prisma.character.upsert({
    where: { name: "RefLeo" },
    update: {},
    create: {
      name: "RefLeo",
      description: "Bạn thông minh",
      personality: "calm",
      visualPrompt: "young adult male cartoon character, medium brown skin",
      negativePrompt: "realistic photo, missing glasses",
      hair: "neat black hair",
      accessories: "round glasses",
      colorPalette: "teal, grey",
      seed: 220033,
    },
  });
  leoId = leo.id;

  await prisma.modelRegistry.upsert({
    where: { provider_modelId: { provider: "mock", modelId: "mock-image-pro" } },
    update: { enabled: true },
    create: {
      provider: "mock",
      modelId: "mock-image-pro",
      displayName: "Mock Image Pro",
      type: "image",
      enabled: true,
      priceUnit: "per_image",
      price: 0.02,
    },
  });
});

// ------------------------------------------------------ canonical sheet ---

describe("mô tả chuẩn của nhân vật", () => {
  it("ghép các thuộc tính thành câu có nhãn rõ ràng", () => {
    const text = buildCanonicalDescription({
      id: "x",
      name: "Max",
      version: 1,
      visualPrompt: "young adult male cartoon character",
      negativePrompt: "",
      hair: "short messy dark brown hair",
      facialFeatures: "large round eyes",
      outfit: "yellow hoodie",
      bodyProportions: "oversized head",
      accessories: "",
      colorPalette: "yellow, blue",
      seed: null,
    });

    expect(text).toContain("hair: short messy dark brown hair");
    expect(text).toContain("outfit: yellow hoodie");
    // Thuộc tính rỗng phải biến mất hẳn: nhãn trống mời model tự bịa giá trị.
    expect(text).not.toContain("accessories:");
  });

  it("luôn cho ra cùng một chuỗi với cùng dữ liệu", () => {
    const row = {
      id: "x",
      name: "Max",
      version: 1,
      visualPrompt: "a",
      negativePrompt: "",
      hair: "b",
      facialFeatures: "c",
      outfit: "d",
      bodyProportions: "e",
      accessories: "f",
      colorPalette: "g",
      seed: null,
    };
    // Chuỗi này được băm vào khoá idempotency; nếu nó dao động thì cơ chế
    // chống trả tiền hai lần mất tác dụng.
    expect(buildCanonicalDescription(row)).toBe(buildCanonicalDescription(row));
  });

  it("đọc được hồ sơ đầy đủ của MAX và LEO từ cơ sở dữ liệu", async () => {
    const sheets = await getCharacterSheetsByName(["RefMax", "RefLeo"]);
    expect(sheets).toHaveLength(2);
    expect(sheets[0]?.name).toBe("RefMax");
    expect(sheets[0]?.canonical).toContain("yellow hoodie");
    expect(sheets[1]?.canonical).toContain("round glasses");
  });

  it("giữ đúng thứ tự tên được yêu cầu", async () => {
    const sheets = await getCharacterSheetsByName(["RefLeo", "RefMax"]);
    expect(sheets.map((s) => s.name)).toEqual(["RefLeo", "RefMax"]);
  });
});

// ------------------------------------------------------------- prompts ---

describe("prompt giữ nhân vật nhất quán", () => {
  it("đặt câu khoá thuộc tính sau phần mô tả nhân vật", async () => {
    const sheets = await getCharacterSheetsByName(["RefMax", "RefLeo"]);
    const prompt = buildScenePrompt({
      sceneDescription: "Max panics on stage",
      characters: sheets,
      stylePrompt: "3D cartoon",
      camera: "medium shot",
    });

    expect(prompt.indexOf("Max panics on stage")).toBeLessThan(
      prompt.indexOf("RefMax:"),
    );
    for (const attribute of LOCKED_ATTRIBUTES) {
      expect(prompt).toContain(attribute);
    }
    expect(prompt).toContain("must not change");
    // Khung 2:3 rộng hơn 9:16 nên bị cắt hai bên, không phải trên dưới.
    expect(prompt).toContain("Vertical portrait composition");
    expect(prompt).toContain("left and right edges");
  });

  it("nhắc tên mọi nhân vật trong câu khoá", async () => {
    const sheets = await getCharacterSheetsByName(["RefMax", "RefLeo"]);
    const prompt = buildScenePrompt({
      sceneDescription: "x",
      characters: sheets,
      stylePrompt: "y",
    });
    expect(prompt).toContain("Keep RefMax and RefLeo identical");
  });

  it("không sinh câu khoá khi cảnh không có nhân vật nào", () => {
    const prompt = buildScenePrompt({
      sceneDescription: "an empty stage",
      characters: [],
      stylePrompt: "3D cartoon",
    });
    expect(prompt).not.toContain("must not change");
  });

  it("prompt ảnh chuẩn dùng tư thế trung tính và nền trơn", async () => {
    const sheet = await getCharacterSheet(maxId);
    const prompt = buildMasterPrompt(sheet!, "3D cartoon");
    expect(prompt).toContain("neutral standing pose");
    expect(prompt).toContain("plain flat light-grey background");
    expect(prompt).toContain("yellow hoodie");
  });

  it("gộp prompt phủ định của mọi nhân vật và loại trùng", async () => {
    const sheets = await getCharacterSheetsByName(["RefMax", "RefLeo"]);
    const negative = buildNegativePrompt(sheets, "blurry");
    const terms = negative.split(",").map((t) => t.trim());
    expect(new Set(terms).size).toBe(terms.length);
    expect(negative).toContain("extra fingers");
    expect(negative).toContain("missing glasses");
    expect(negative).toContain("watermark");
  });
});

// -------------------------------------------------------- file storage ---

describe("lưu trữ ảnh tham chiếu", () => {
  it("ghi tệp xuống đĩa và chỉ lưu đường dẫn vào cơ sở dữ liệu", async () => {
    const { referenceId, relativePath } = await uploadCharacterReference({
      characterId: maxId,
      fileName: "max-upload.png",
      bytes: TINY_PNG,
    });

    const row = await prisma.characterReference.findUnique({
      where: { id: referenceId },
    });
    expect(row?.filePath).toBe(relativePath);
    expect(row?.source).toBe("upload");
    expect(row?.bytes).toBe(TINY_PNG.byteLength);
    // Cơ sở dữ liệu không được chứa bản thân ảnh.
    expect(JSON.stringify(row)).not.toContain(TINY_PNG.toString("base64"));
    expect(fs.existsSync(toAbsolute(relativePath))).toBe(true);
  });

  it("từ chối tệp rỗng và định dạng lạ", async () => {
    await expect(
      uploadCharacterReference({
        characterId: maxId,
        fileName: "empty.png",
        bytes: Buffer.alloc(0),
      }),
    ).rejects.toThrow(/rỗng/);

    await expect(
      uploadCharacterReference({
        characterId: maxId,
        fileName: "virus.exe",
        bytes: TINY_PNG,
      }),
    ).rejects.toThrow(/không được hỗ trợ/);
  });

  it("từ chối tệp đặt tên .png nhưng nội dung không phải ảnh", async () => {
    // Tên tệp là lời khai, phần đầu tệp mới là bằng chứng. Route phục vụ media
    // chọn content-type theo đuôi tệp, nên tin mỗi cái tên là để lộ sơ hở.
    await expect(
      uploadCharacterReference({
        characterId: maxId,
        fileName: "tra-hinh.png",
        bytes: Buffer.from("MZ  day khong phai anh", "latin1"),
      }),
    ).rejects.toThrow(/không phải ảnh/);
  });

  it("xoá ảnh thì xoá cả tệp trên đĩa", async () => {
    const { referenceId, relativePath } = await uploadCharacterReference({
      characterId: leoId,
      fileName: "tam.png",
      bytes: TINY_PNG,
    });
    const absolute = toAbsolute(relativePath);
    expect(fs.existsSync(absolute)).toBe(true);

    await deleteCharacterReference(referenceId);
    expect(fs.existsSync(absolute)).toBe(false);
    expect(
      await prisma.characterReference.findUnique({ where: { id: referenceId } }),
    ).toBeNull();
  });
});

// ------------------------------------------------------------ approval ---

describe("duyệt ảnh chuẩn", () => {
  it("chỉ có đúng một ảnh chuẩn tại mọi thời điểm", async () => {
    const first = await uploadCharacterReference({
      characterId: leoId,
      fileName: "leo-1.png",
      bytes: TINY_PNG,
    });
    const second = await uploadCharacterReference({
      characterId: leoId,
      fileName: "leo-2.png",
      bytes: TINY_PNG,
    });

    await approveCharacterReference(first.referenceId);
    await approveCharacterReference(second.referenceId);

    const primaries = await prisma.characterReference.findMany({
      where: { characterId: leoId, isPrimary: true },
    });
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.id).toBe(second.referenceId);
  });

  it("hồ sơ nhân vật chỉ trỏ tới ảnh đã duyệt", async () => {
    const sheet = await getCharacterSheet(leoId);
    expect(sheet?.primaryReference).not.toBeNull();
    const row = await prisma.characterReference.findFirst({
      where: { characterId: leoId, isPrimary: true },
    });
    expect(sheet?.primaryReference).toBe(row?.filePath);
  });

  it("ảnh chưa duyệt không lọt vào bộ tham chiếu gửi cho AI", async () => {
    const pending = await prisma.characterReference.create({
      data: {
        characterId: maxId,
        filePath: "characters/testmax/chua-duyet.png",
        source: "generated",
        approved: false,
        isPrimary: false,
      },
    });

    const sheet = await getCharacterSheet(maxId);
    expect(sheet?.references).not.toContain(pending.filePath);
  });
});

// ------------------------------------------- master generation behaviour ---

describe("tạo ảnh chuẩn bằng AI", () => {
  it("KHÔNG tự thay ảnh chuẩn đã duyệt", async () => {
    const before = await prisma.characterReference.findFirst({
      where: { characterId: leoId, isPrimary: true },
    });
    expect(before).not.toBeNull();

    const result = await generateCharacterMaster({
      characterId: leoId,
      provider: "mock",
      model: "mock-image-pro",
    });

    expect(result.keptExistingPrimary).toBe(true);

    const after = await prisma.characterReference.findFirst({
      where: { characterId: leoId, isPrimary: true },
    });
    // Đây là điều kiện quan trọng nhất của cả tính năng: ảnh mốc của nhân vật
    // không được đổi sau lưng người dùng.
    expect(after?.id).toBe(before?.id);

    const candidate = await prisma.characterReference.findUnique({
      where: { id: result.referenceId },
    });
    expect(candidate?.approved).toBe(false);
    expect(candidate?.isPrimary).toBe(false);
  });

  it("ghi lại nhà cung cấp, model và phiên bản nhân vật của ảnh", async () => {
    const result = await generateCharacterMaster({
      characterId: maxId,
      provider: "mock",
      model: "mock-image-pro",
    });
    const row = await prisma.characterReference.findUnique({
      where: { id: result.referenceId },
    });
    expect(row?.provider).toBe("mock");
    expect(row?.model).toBe("mock-image-pro");
    expect(row?.source).toBe("generated");
    expect(row?.characterVersion).toBeGreaterThanOrEqual(1);
    expect(row?.prompt.length).toBeGreaterThan(0);
  });

  it("khoá idempotency đổi khi phiên bản nhân vật đổi, nhưng ổn định khi không đổi", () => {
    const base = {
      characterId: "c1",
      provider: "openai",
      model: "gpt-image-1:medium",
      prompt: "x",
    };
    const v1 = masterIdempotencyKey({ ...base, version: 1 });
    const v1Again = masterIdempotencyKey({ ...base, version: 1 });
    const v2 = masterIdempotencyKey({ ...base, version: 2 });

    expect(v1).toBe(v1Again);
    expect(v1).not.toBe(v2);
  });
});

// ------------------------------------------------------- image cost ledger ---

describe("sổ chi phí ảnh tách riêng", () => {
  it("chi phí ảnh không bị trộn vào chi phí text", async () => {
    const summary = await costSummary("all");
    const categories = Object.keys(summary.byCategory);
    // Mock không tính tiền thật nên không xuất hiện trong chi phí thật - đó
    // chính là sự tách bạch cần chứng minh.
    expect(categories).not.toContain("image");

    const imageRows = await prisma.costEntry.count({
      where: { category: "image" },
    });
    expect(imageRows).toBeGreaterThan(0);

    const mixed = await prisma.costEntry.count({
      where: { category: "image", provider: { not: "mock" } },
    });
    expect(mixed).toBe(0);
  });

  it("mọi dòng chi phí ảnh đều ghi rõ nhà cung cấp và model", async () => {
    const rows = await prisma.costEntry.findMany({ where: { category: "image" } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.provider.length).toBeGreaterThan(0);
      expect(row.model.length).toBeGreaterThan(0);
    }
  });
});
