import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  applySheetEdit,
  buildScenePrompt,
  EDITABLE_BIBLE_KEYS,
  getCharacterSheet,
  identityFingerprint,
  lockedAttributesFor,
} from "@/services/character-service";

/**
 * Editing a character's Bible: what it changes, and what it must leave alone.
 *
 * The form on the Nhân vật page and the inline editor on the import screen post
 * the same eleven fields, and they used to decide separately when a version
 * bumps. `applySheetEdit` is the single rule both now call, so this is where it
 * gets pinned down.
 *
 * Three promises, in order of how expensive it is to break them:
 *
 *   1. SAVING NEVER DRAWS. A character can be re-described for free as often as
 *      anyone likes; making a picture of the new description is separate, paid,
 *      and deliberate.
 *   2. AN APPROVED REFERENCE SURVIVES AN EDIT. Nothing here touches a reference
 *      row, and the version - which is what makes a master read as current or
 *      stale - follows the APPEARANCE, not the paperwork.
 *   3. AN UNSTATED FIELD IS NOT A LOCK. Saving "unknown" into apparent age must
 *      not put "apparent age" into the prompt's lock clause. See QĐ-072.
 */

const BASE = {
  id: "x",
  name: "SheetEdit",
  version: 3,
  visualPrompt: "young cartoon character",
  negativePrompt: "blurry, extra limbs",
  hair: "short messy dark brown hair",
  facialFeatures: "round face, large eyes",
  outfit: "yellow hoodie",
  bodyProportions: "oversized head",
  accessories: "",
  colorPalette: "yellow, blue",
  presentation: "",
  approximateAge: "",
  skinTone: "",
  distinguishingFeatures: "",
  negativeIdentity: "",
  seed: null as number | null,
};

let characterId = "";
/** ProviderJob count taken immediately before the edit, for the delta below. */
let jobsBeforeEdit = 0;

beforeAll(async () => {
  const row = await prisma.character.create({
    data: {
      name: "SheetEditDB",
      description: "trước khi sửa",
      personality: "",
      visualPrompt: BASE.visualPrompt,
      negativePrompt: BASE.negativePrompt,
      hair: BASE.hair,
      facialFeatures: BASE.facialFeatures,
      outfit: BASE.outfit,
      bodyProportions: BASE.bodyProportions,
    },
  });
  characterId = row.id;
  await prisma.characterReference.create({
    data: {
      characterId: row.id,
      filePath: "characters/sheet-edit-master.png",
      source: "upload",
      isPrimary: true,
      approved: true,
      characterVersion: row.version,
      notes: "ảnh chuẩn đã duyệt",
    },
  });
});

// --------------------------------------------------- the version rule ---

describe("phiên bản đi theo NGOẠI HÌNH, không theo giấy tờ", () => {
  it("đổi tóc -> tăng phiên bản", () => {
    const edit = applySheetEdit(BASE, { hair: "tóc khác hẳn" });
    expect(edit.changed).toBe(true);
    expect(edit.version).toBe(BASE.version + 1);
  });

  it("lưu lại y nguyên -> KHÔNG tăng phiên bản", () => {
    const edit = applySheetEdit(BASE, {
      hair: BASE.hair,
      facialFeatures: BASE.facialFeatures,
      outfit: BASE.outfit,
      bodyProportions: BASE.bodyProportions,
    });
    expect(edit.changed).toBe(false);
    expect(edit.version).toBe(BASE.version);
  });

  // Re-saving a form nobody touched must be a no-op, or the version creeps up
  // every time somebody opens the page.
  it("chỉ thêm khoảng trắng -> KHÔNG tăng phiên bản", () => {
    const edit = applySheetEdit(BASE, { hair: `  ${BASE.hair}  ` });
    expect(edit.changed).toBe(false);
    expect(edit.data.hair).toBe(BASE.hair);
  });

  it("để trống một trường ĐANG có giá trị -> đổi, vì thuộc tính đó thôi bị khoá", () => {
    const edit = applySheetEdit(BASE, { outfit: "" });
    expect(edit.changed).toBe(true);
  });

  it("trường không được gửi lên thì KHÔNG bị ghi đè thành rỗng", () => {
    const edit = applySheetEdit(BASE, { hair: "khác" });
    expect(edit.data).not.toHaveProperty("outfit");
    expect(edit.data).not.toHaveProperty("skinTone");
  });
});

// --------------------------------------- unknown is an answer, not a lock ---

describe("tuổi / tông da: không bắt buộc, và 'unknown' không tạo khoá giả", () => {
  it("lưu được mà không cần điền tuổi hay tông da", () => {
    const edit = applySheetEdit(BASE, { hair: "x", approximateAge: "", skinTone: "" });
    expect(edit.data.approximateAge).toBe("");
    expect(edit.data.skinTone).toBe("");
  });

  it("ghi 'unknown' -> lưu nguyên văn, nhưng KHÔNG trở thành thuộc tính bị khoá", () => {
    const edit = applySheetEdit(BASE, {
      approximateAge: "unknown",
      skinTone: "not_specified",
    });
    // Stored as typed: the operator's "I looked and I do not know" is worth
    // keeping, and it is what silences the nudge.
    expect(edit.data.approximateAge).toBe("unknown");

    const after = { ...BASE, ...edit.data };
    expect(lockedAttributesFor(after)).not.toContain("apparent age");
    expect(lockedAttributesFor(after)).not.toContain("skin tone");
  });

  it("điền giá trị thật -> mới thành khoá, và prompt nêu đích danh", async () => {
    const stated = { ...BASE, approximateAge: "around eight" };
    expect(lockedAttributesFor(stated)).toContain("apparent age");

    const prompt = buildScenePrompt({
      sceneDescription: "x",
      characters: [
        {
          id: "x",
          name: "SheetEdit",
          version: 1,
          canonical: "young cartoon character",
          negative: "",
          negativeIdentity: "",
          seed: null,
          primaryReference: "characters/m.png",
          references: ["characters/m.png"],
          missingFields: [],
          unlockedAttributes: [],
          lockedAttributes: lockedAttributesFor(stated),
          readiness: "READY",
          warnings: [],
          fingerprint: "x",
        },
      ],
      stylePrompt: "3D cartoon",
    });
    expect(prompt).toContain("apparent age");
    expect(prompt).toContain("must not change");
  });

  it("'unknown' KHÔNG lọt vào câu khoá của prompt", () => {
    const vague = { ...BASE, approximateAge: "unknown" };
    const prompt = buildScenePrompt({
      sceneDescription: "x",
      characters: [
        {
          id: "x",
          name: "SheetEdit",
          version: 1,
          canonical: "young cartoon character",
          negative: "",
          negativeIdentity: "",
          seed: null,
          primaryReference: "characters/m.png",
          references: ["characters/m.png"],
          missingFields: [],
          unlockedAttributes: ["apparent age"],
          lockedAttributes: lockedAttributesFor(vague),
          readiness: "READY",
          warnings: [],
          fingerprint: "x",
        },
      ],
      stylePrompt: "3D cartoon",
    });
    expect(prompt).not.toContain("apparent age");
    expect(prompt).not.toContain("unknown");
    // ...and the unlocked attribute is handed to the picture instead.
    expect(prompt).toContain("must match the reference image exactly");
  });
});

// -------------------------------------------- what an edit must not touch ---

describe("sửa hồ sơ KHÔNG tạo ảnh và KHÔNG đụng ảnh tham chiếu", () => {
  it("lưu đủ 11 trường: dữ liệu giữ nguyên sau khi đọc lại", async () => {
    const current = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    jobsBeforeEdit = await prisma.providerJob.count();
    const values: Record<string, string> = {
      presentation: "boy",
      approximateAge: "unknown",
      skinTone: "light warm beige",
      hair: "short messy dark brown hair, spiky",
      facialFeatures: "round face, large round eyes",
      distinguishingFeatures: "a small scar above the left eyebrow",
      outfit: "bright yellow hoodie with a white chest stripe",
      bodyProportions: "slightly oversized head",
      accessories: "",
      colorPalette: "yellow, denim blue, white",
      negativeIdentity: "never add glasses",
    };
    const edit = applySheetEdit(current, values);
    await prisma.character.update({
      where: { id: characterId },
      data: { ...edit.data, version: edit.version },
    });

    const reloaded = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    for (const key of EDITABLE_BIBLE_KEYS) {
      expect(reloaded[key]).toBe(values[key]);
    }
    expect(reloaded.version).toBe(current.version + 1);
  });

  it("ảnh chuẩn đã duyệt vẫn nguyên vẹn sau khi sửa", async () => {
    const refs = await prisma.characterReference.findMany({ where: { characterId } });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.isPrimary).toBe(true);
    expect(refs[0]!.approved).toBe(true);
    expect(refs[0]!.filePath).toBe("characters/sheet-edit-master.png");
    // The reference still records the version it was made FOR - that is how a
    // stale master is recognised, and it must not be quietly rewritten.
    expect(refs[0]!.characterVersion).toBe(1);

    const sheet = await getCharacterSheet(characterId);
    expect(sheet!.primaryReference).toBe("characters/sheet-edit-master.png");
    expect(sheet!.readiness).toBe("READY");
  });

  it("không có ProviderJob nào được tạo bởi việc sửa hồ sơ", async () => {
    // BEFORE/AFTER around the edit, not an absolute count: the suite shares one
    // database and other files legitimately create master-image jobs in it. The
    // claim being tested is "this edit created none", and only a delta says
    // that. An absolute zero passed alone and failed in the suite - which is
    // the assertion being wrong, not the code.
    const jobsAfterEdit = await prisma.providerJob.count();
    expect(jobsAfterEdit).toBe(jobsBeforeEdit);
  });

  it("sửa metadata thuần (không phải ngoại hình) -> phiên bản đứng yên", async () => {
    const current = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const edit = applySheetEdit(
      { ...current, notes: "ghi chú mới" } as typeof current,
      {},
    );
    expect(edit.changed).toBe(false);
    expect(edit.version).toBe(current.version);
    expect(identityFingerprint(current)).toBe(edit.after);
  });
});
