import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  BIBLE_FIELDS,
  buildCanonicalDescription,
  buildNegativePrompt,
  characterReadiness,
  getCharacterSheetsByName,
  missingBibleFields,
  requireCharacterSheetsByName,
  REQUIRED_BIBLE_FIELDS,
  UnknownCharacterError,
} from "@/services/character-service";

/**
 * The Character Bible.
 *
 * A NAME IS NOT AN IDENTITY. `LOCKED_ATTRIBUTES` has always told the image model
 * that "apparent age" and "skin tone" must not change, and until QĐ-070 the
 * `Character` row had nowhere to say what either of them was - so the lock held
 * whatever the model improvised on the first frame it drew, which is a different
 * answer for every project.
 *
 * Two promises are guarded here, and both are about money as much as looks:
 *
 *   1. Adding the new fields must not move `buildCanonicalDescription`'s output
 *      for a character that does not use them. That string is hashed into the
 *      master-image idempotency key, so a byte of drift re-buys every master.
 *   2. A scene that names somebody the character table has never heard of must
 *      FAIL, not quietly produce a prompt with no identity block - which is how
 *      a pipeline draws a different person in every scene while every step
 *      reports success.
 */

const BASE = {
  description: "test",
  personality: "",
  visualPrompt: "young cartoon character",
  negativePrompt: "blurry",
};

beforeAll(async () => {
  await prisma.character.upsert({
    where: { name: "BibleOld" },
    update: {},
    create: {
      ...BASE,
      name: "BibleOld",
      hair: "short messy dark brown hair",
      facialFeatures: "large round eyes",
      outfit: "yellow hoodie",
      bodyProportions: "oversized head",
      accessories: "",
      colorPalette: "yellow, blue",
    },
  });

  await prisma.character.upsert({
    where: { name: "BibleFull" },
    update: {},
    create: {
      ...BASE,
      name: "BibleFull",
      presentation: "boy",
      approximateAge: "around eight",
      skinTone: "light warm beige",
      hair: "short messy dark brown hair",
      facialFeatures: "large round eyes",
      distinguishingFeatures: "a small scar above the left eyebrow",
      outfit: "yellow hoodie",
      bodyProportions: "oversized head",
      accessories: "",
      colorPalette: "yellow, blue",
      negativeIdentity: "never add glasses, never change the scar",
    },
  });
});

// ------------------------------------------------- the string that is hashed ---

describe("canonical description: thêm trường mà KHÔNG làm đổi chuỗi cũ", () => {
  // The whole reason the new columns default to "" and are skipped when empty.
  // If this ever fails, every character master image gets bought again.
  it("nhân vật chưa điền trường mới ra CHÍNH XÁC chuỗi như trước", () => {
    const row = {
      id: "x",
      name: "BibleOld",
      version: 1,
      visualPrompt: "young cartoon character",
      negativePrompt: "blurry",
      hair: "short messy dark brown hair",
      facialFeatures: "large round eyes",
      outfit: "yellow hoodie",
      bodyProportions: "oversized head",
      accessories: "",
      colorPalette: "yellow, blue",
      seed: null,
    };
    expect(buildCanonicalDescription(row)).toBe(
      "young cartoon character. hair: short messy dark brown hair. " +
        "face: large round eyes. outfit: yellow hoodie. body: oversized head. " +
        "colour palette: yellow, blue",
    );
  });

  it("trường mới có giá trị thì xuất hiện, theo đúng thứ tự đã khai báo", () => {
    const row = {
      id: "x",
      name: "BibleFull",
      version: 1,
      visualPrompt: "young cartoon character",
      negativePrompt: "blurry",
      presentation: "boy",
      approximateAge: "around eight",
      skinTone: "light warm beige",
      hair: "short hair",
      facialFeatures: "round eyes",
      distinguishingFeatures: "a small scar",
      outfit: "hoodie",
      bodyProportions: "big head",
      accessories: "",
      colorPalette: "yellow",
      seed: null,
    };
    const out = buildCanonicalDescription(row);
    expect(out).toContain("presentation: boy");
    expect(out).toContain("apparent age: around eight");
    expect(out).toContain("skin tone: light warm beige");
    expect(out).toContain("distinguishing features: a small scar");
    // Order is the spec, because the string is hashed.
    const order = BIBLE_FIELDS.map((f) => f.label).filter((l) => out.includes(`${l}:`));
    const positions = order.map((l) => out.indexOf(`${l}:`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("chạy hai lần ra cùng một chuỗi, từng byte", () => {
    const row = {
      id: "x",
      name: "N",
      version: 1,
      visualPrompt: "v",
      negativePrompt: "",
      presentation: "boy",
      approximateAge: "8",
      skinTone: "beige",
      hair: "h",
      facialFeatures: "f",
      distinguishingFeatures: "d",
      outfit: "o",
      bodyProportions: "b",
      accessories: "a",
      colorPalette: "c",
      seed: null,
    };
    expect(buildCanonicalDescription(row)).toBe(buildCanonicalDescription(row));
  });
});

// ------------------------------------------------------------- readiness ---

describe("hồ sơ nhận dạng: thiếu gì thì nói thiếu gì", () => {
  it("nhân vật cũ thiếu tuổi và tông da", () => {
    const missing = missingBibleFields({
      id: "x",
      name: "BibleOld",
      version: 1,
      visualPrompt: "v",
      negativePrompt: "",
      hair: "h",
      facialFeatures: "f",
      outfit: "o",
      bodyProportions: "b",
      accessories: "",
      colorPalette: "",
      seed: null,
    });
    expect(missing).toEqual(["apparent age", "skin tone"]);
  });

  it("điền đủ thì không thiếu gì", () => {
    const full = Object.fromEntries(REQUIRED_BIBLE_FIELDS.map((k) => [k, "x"]));
    expect(
      missingBibleFields({
        id: "x",
        name: "N",
        version: 1,
        visualPrompt: "v",
        negativePrompt: "",
        accessories: "",
        colorPalette: "",
        seed: null,
        ...full,
      } as Parameters<typeof missingBibleFields>[0]),
    ).toEqual([]);
  });

  // The reference is reported first because it is the one an operator has to
  // SUPPLY rather than type - and because nothing here may generate it.
  it("thiếu ảnh tham chiếu được báo trước, kể cả khi cũng thiếu trường", () => {
    expect(
      characterReadiness({ hasApprovedReference: false, missingFields: ["hair"] }),
    ).toBe("NEEDS_CHARACTER_REFERENCE");
    expect(
      characterReadiness({ hasApprovedReference: true, missingFields: ["hair"] }),
    ).toBe("NEEDS_IDENTITY_FIELDS");
    expect(characterReadiness({ hasApprovedReference: true, missingFields: [] })).toBe(
      "READY",
    );
  });
});

// --------------------------------------------------- identity negatives ---

describe("negativeIdentity tách khỏi negative chung", () => {
  it("cả hai đều tới được prompt, và identity đứng trước boilerplate", async () => {
    const [sheet] = await getCharacterSheetsByName(["BibleFull"]);
    expect(sheet).toBeDefined();
    expect(sheet!.negativeIdentity).toContain("never add glasses");

    const negative = buildNegativePrompt([sheet!]);
    expect(negative).toContain("never add glasses");
    expect(negative).toContain("blurry");
    // Ahead of the hygiene list, so a provider that truncates drops boilerplate
    // rather than an identity rule.
    expect(negative.indexOf("never add glasses")).toBeLessThan(
      negative.indexOf("extra limbs"),
    );
  });
});

// ------------------------------------------ the silent new-character bug ---

describe("tên lạ phải BÁO LỖI, không được im lặng bỏ qua", () => {
  it("getCharacterSheetsByName vẫn bỏ qua (dùng cho báo cáo)", async () => {
    const sheets = await getCharacterSheetsByName(["BibleFull", "KhongCoAi"]);
    expect(sheets.map((s) => s.name)).toEqual(["BibleFull"]);
  });

  // The version the image path uses. A name that vanishes here used to mean a
  // prompt with no identity block for that person, so the model invented one -
  // freshly, in every scene that named them.
  it("requireCharacterSheetsByName ném lỗi và nêu ĐÍCH DANH tên thiếu", async () => {
    await expect(
      requireCharacterSheetsByName(["BibleFull", "KhongCoAi", "CungKhongCo"]),
    ).rejects.toThrow(UnknownCharacterError);

    await expect(
      requireCharacterSheetsByName(["KhongCoAi"]),
    ).rejects.toThrow(/KhongCoAi/);
  });

  it("đủ tên thì trả về bình thường", async () => {
    const sheets = await requireCharacterSheetsByName(["BibleOld", "BibleFull"]);
    expect(sheets).toHaveLength(2);
    expect(sheets.every((s) => s.readiness === "NEEDS_CHARACTER_REFERENCE")).toBe(true);
  });
});
