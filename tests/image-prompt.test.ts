import { describe, expect, it } from "vitest";
import {
  EXPRESSION_OVERRIDE_LINE,
  findImageContradictions,
  resolveImagePrompt,
  type ImagePromptSource,
} from "@/domain/image-prompt";

/**
 * Regression tests for QĐ-064.
 *
 * The video path refuses a prompt that both forbids and requests the same
 * camera move. The image path had no equivalent, and scene 4 of the first real
 * production batch is what that cost: the prompt asked for a pace backwards
 * ALONG THE BOARD beside "nothing else in frame", and for eyes that "stay wide"
 * while the character sheet insisted on a "wide eager smile". Both were sent as
 * written. The model dropped the diving board and drew a smiling boy, so a beat
 * about backing out of a jump came back as a cheerful portrait - and the clip
 * animated from it scored 10/10 for faithfulness to an already-wrong keyframe.
 *
 * The scene 4 case below is the real row, verbatim.
 */

/** Max's canonical sheet exactly as `buildCanonicalDescription` emits it. */
const MAX_SHEET =
  "young adult male cartoon character, short messy dark brown hair, large round " +
  "expressive eyes, light warm skin, bright yellow hoodie with a white stripe, blue " +
  "jeans, white sneakers, slightly oversized head proportions, friendly rounded shapes, " +
  "always wide-eyed and eager. hair: short messy dark brown hair, slightly spiky at the " +
  "front. face: round face, large round expressive eyes, small nose, wide eager smile, " +
  "light warm skin. outfit: bright yellow hoodie with a single white chest stripe, blue " +
  "jeans, white sneakers. body: slightly oversized head, short and stocky, noticeably " +
  "shorter than Leo. colour palette: bright yellow, denim blue, white.";

const SCENE_4: ImagePromptSource = {
  sceneDescription:
    "Max shakes his head once and moves one short pace backwards along the board. " +
    "His eyes stay wide. Plain pale sky behind him, nothing else in frame. " +
    "Max shakes his head once, then eases one short pace back.",
  camera: "Locked static medium shot, no camera movement.",
  characters: [{ name: "Max", canonical: MAX_SHEET }],
};

describe("cảnh 4 — hồi quy cho đúng lỗi đã trả tiền", () => {
  const out = resolveImagePrompt(SCENE_4);

  it("bắt đủ cả hai mâu thuẫn, không bỏ sót cái nào", () => {
    const kinds = out.contradictions.map((c) => c.kind).sort();
    expect(kinds).toEqual(["action_vs_empty_frame", "expression_vs_sheet"]);
    expect(out.contradictions.every((c) => c.resolved)).toBe(true);
  });

  it("bỏ câu khung trống, vì hành động cần cầu nhảy có mặt", () => {
    expect(SCENE_4.sceneDescription).toContain("nothing else in frame");
    expect(out.sceneDescription).not.toContain("nothing else in frame");
    // Cái nền vẫn còn: chỉ vế cấm vẽ vật thể bị bỏ.
    expect(out.sceneDescription).toContain("Plain pale sky behind him");
  });

  it("giữ nguyên hành động chính và vật thể nó cần", () => {
    expect(out.sceneDescription).toContain("moves one short pace backwards along the board");
    expect(out.sceneDescription).toContain("shakes his head once");
    expect(out.sceneDescription).toContain("His eyes stay wide");
  });

  it("bỏ nụ cười của bảng nhân vật, giữ nguyên mọi thuộc tính bị khoá", () => {
    const sheet = out.characters[0]!.canonical;
    expect(MAX_SHEET).toContain("wide eager smile");
    expect(sheet).not.toContain("wide eager smile");

    // LOCKED_ATTRIBUTES: tóc, mặt, tuổi, da, chiều cao, tỉ lệ, trang phục, phụ kiện.
    expect(sheet).toContain("short messy dark brown hair");
    expect(sheet).toContain("large round expressive eyes");
    expect(sheet).toContain("round face");
    expect(sheet).toContain("small nose");
    expect(sheet).toContain("light warm skin");
    expect(sheet).toContain("bright yellow hoodie with a single white chest stripe");
    expect(sheet).toContain("blue jeans");
    expect(sheet).toContain("white sneakers");
    expect(sheet).toContain("noticeably shorter than Leo");
    expect(sheet).toContain("colour palette: bright yellow, denim blue, white");
  });

  it("giữ cụm nào ĐỒNG Ý với cảnh, không dọn sạch bừa bãi", () => {
    // "always wide-eyed and eager" nói cùng một thứ với "his eyes stay wide".
    // Xoá nó là sửa một prompt đang đúng.
    expect(out.characters[0]!.canonical).toContain("always wide-eyed and eager");
  });

  it("nói rõ biểu cảm lấy từ cảnh, vì ảnh tham chiếu vẫn đang cười", () => {
    expect(out.expressionOverride).toBe(EXPRESSION_OVERRIDE_LINE);
  });

  it("không còn cặp lệnh nào tự mâu thuẫn sau khi xử lý", () => {
    expect(
      findImageContradictions({
        sceneDescription: out.sceneDescription,
        camera: out.camera,
        characters: out.characters,
      }),
    ).toEqual([]);
  });

  it("không đụng tới lời thoại — punchline không nằm trong prompt ảnh", () => {
    // Prompt ảnh chỉ nhận visualDescription + characterAction. Câu chốt
    // "Tomorrow. Tomorrow is also a day." sống ở dialogue và không bao giờ đi
    // qua đây, nên không có đường nào bộ guard làm mất nó.
    expect(out.sceneDescription).not.toContain("Tomorrow");
    expect(SCENE_4.sceneDescription).not.toContain("Tomorrow");
  });
});

describe("A. hành động và khung tĩnh", () => {
  it("bỏ 'completely static' khi cảnh đang mô tả chuyển động", () => {
    const out = resolveImagePrompt({
      sceneDescription: "Leo steps toward the door. The room is completely static.",
      camera: "Medium shot.",
      characters: [],
    });
    expect(out.contradictions.map((c) => c.kind)).toEqual(["action_vs_static"]);
    expect(out.sceneDescription).not.toContain("completely static");
    expect(out.sceneDescription).toContain("steps toward the door");
  });

  it("không báo động khi vật thể chỉ là bầu trời hay nền", () => {
    const out = resolveImagePrompt({
      sceneDescription: "Mia stands against the sky, nothing else in frame.",
      camera: "Wide shot.",
      characters: [],
    });
    expect(out.contradictions).toEqual([]);
    expect(out.changed).toBe(false);
  });
});

describe("B. biểu cảm của cảnh và bảng nhân vật", () => {
  const sheet =
    "tall cartoon boy, neat black hair, round face, wide eager smile, green jacket.";

  it("cảnh buồn thì bỏ nụ cười mặc định của bảng nhân vật", () => {
    const out = resolveImagePrompt({
      sceneDescription: "Leo frowns and looks down, close to tears.",
      camera: "Medium shot.",
      characters: [{ name: "Leo", canonical: sheet }],
    });
    expect(out.contradictions.map((c) => c.kind)).toEqual(["expression_vs_sheet"]);
    expect(out.contradictions[0]!.character).toBe("Leo");
    expect(out.characters[0]!.canonical).not.toContain("wide eager smile");
    expect(out.characters[0]!.canonical).toContain("neat black hair");
    expect(out.characters[0]!.canonical).toContain("green jacket");
    expect(out.expressionOverride).not.toBeNull();
  });

  it("cảnh vui thì để nguyên, vì không có gì mâu thuẫn", () => {
    const out = resolveImagePrompt({
      sceneDescription: "Leo grins and waves at the camera.",
      camera: "Medium shot.",
      characters: [{ name: "Leo", canonical: sheet }],
    });
    expect(out.contradictions).toEqual([]);
    expect(out.characters[0]!.canonical).toBe(sheet);
    expect(out.expressionOverride).toBeNull();
  });

  it("không nhầm hình dạng mắt là biểu cảm", () => {
    const out = resolveImagePrompt({
      sceneDescription: "Mia frowns at the empty jar.",
      camera: "Medium shot.",
      characters: [
        { name: "Mia", canonical: "small girl, large round expressive eyes, red dress." },
      ],
    });
    expect(out.contradictions).toEqual([]);
    expect(out.characters[0]!.canonical).toContain("large round expressive eyes");
  });
});

describe("C. khung hình và máy quay", () => {
  it("cận cảnh và toàn thân không thể cùng đúng — camera thắng", () => {
    const out = resolveImagePrompt({
      sceneDescription: "A full-body view of Max on the board.",
      camera: "Extreme close-up on his face.",
      characters: [],
    });
    expect(out.contradictions.map((c) => c.kind)).toEqual(["framing_conflict"]);
    expect(out.contradictions[0]!.kept).toContain("close-up");
    expect(out.sceneDescription).not.toContain("full-body");
  });

  it("camera tự mâu thuẫn thì giữ vế đứng trước", () => {
    const out = resolveImagePrompt({
      sceneDescription: "Max waits.",
      camera: "Medium shot, wide shot of the whole pool.",
      characters: [],
    });
    expect(out.contradictions.map((c) => c.kind)).toEqual(["framing_conflict"]);
    expect(out.camera).toContain("Medium shot");
    expect(out.camera).not.toContain("wide shot");
  });

  it("giữa khung và mép khung không thể cùng đúng", () => {
    const out = resolveImagePrompt({
      sceneDescription: "Max stands.",
      camera: "Subject centered, pushed to the far right edge.",
      characters: [],
    });
    expect(out.contradictions.map((c) => c.kind)).toEqual(["framing_conflict"]);
    expect(out.camera).toContain("centered");
    expect(out.camera).not.toContain("far right edge");
  });

  it("ảnh tĩnh không pan/zoom được nên bỏ phần di chuyển, giữ cỡ cảnh", () => {
    const out = resolveImagePrompt({
      sceneDescription: "Max waits on the board.",
      camera: "Locked medium shot, then pans to the water.",
      characters: [],
    });
    expect(out.contradictions.map((c) => c.kind)).toEqual(["camera_move_in_still"]);
    expect(out.camera).toContain("Locked medium shot");
    expect(out.camera).not.toMatch(/\bpans\b/);
  });

  it("câu CẤM di chuyển không bị hiểu nhầm là yêu cầu di chuyển", () => {
    const out = resolveImagePrompt({
      sceneDescription: "Max waits.",
      camera: "Locked static medium shot, no camera movement.",
      characters: [],
    });
    expect(out.contradictions).toEqual([]);
    expect(out.changed).toBe(false);
  });
});

describe("D. vật thể và liền mạch", () => {
  it("vật vừa biến mất vừa đang có: giữ liền mạch, bỏ cụm nhắc lại", () => {
    const out = resolveImagePrompt({
      sceneDescription: "The ice is gone. Max shuffles forward with the ice on his feet.",
      camera: "Medium shot.",
      characters: [],
    });
    expect(out.contradictions.map((c) => c.kind)).toEqual(["object_present_and_absent"]);
    expect(out.contradictions[0]!.keptLayer).toBe("CONTINUITY");
    expect(out.contradictions[0]!.resolved).toBe(true);
    expect(out.sceneDescription).toContain("The ice is gone");
    expect(out.sceneDescription).not.toContain("with the ice");
  });

  it("màu trang phục trái với thuộc tính bị khoá thì sửa về màu khoá", () => {
    const out = resolveImagePrompt({
      sceneDescription: "Max adjusts his red hoodie and looks down.",
      camera: "Medium shot.",
      characters: [{ name: "Max", canonical: MAX_SHEET }],
    });
    const kinds = out.contradictions.map((c) => c.kind);
    expect(kinds).toContain("outfit_vs_locked_identity");
    const clash = out.contradictions.find((c) => c.kind === "outfit_vs_locked_identity")!;
    expect(clash.keptLayer).toBe("IDENTITY");
    expect(out.sceneDescription).not.toContain("red hoodie");
    expect(out.sceneDescription).toContain("bright yellow hoodie");
  });

  it("nhắc trang phục mà không nêu màu thì không phải mâu thuẫn", () => {
    const out = resolveImagePrompt({
      sceneDescription: "Max pulls his hoodie tighter.",
      camera: "Medium shot.",
      characters: [{ name: "Max", canonical: MAX_SHEET }],
    });
    expect(out.contradictions.map((c) => c.kind)).not.toContain("outfit_vs_locked_identity");
  });
});

describe("prompt sạch và tính tất định", () => {
  const CLEAN: ImagePromptSource = {
    sceneDescription:
      "Max stands alone at the end of a high diving board against a plain pale sky. " +
      "He tips his head down to look at the water far below, and his eyes widen.",
    camera: "Locked static medium shot, no camera movement.",
    characters: [
      {
        name: "Max",
        canonical: "young cartoon boy, short messy dark brown hair, blue jeans.",
      },
    ],
  };

  it("prompt không mâu thuẫn thì không bị sửa một ký tự nào", () => {
    const out = resolveImagePrompt(CLEAN);
    expect(out.contradictions).toEqual([]);
    expect(out.changed).toBe(false);
    expect(out.sceneDescription).toBe(CLEAN.sceneDescription);
    expect(out.camera).toBe(CLEAN.camera);
    expect(out.characters[0]!.canonical).toBe(CLEAN.characters[0]!.canonical);
    expect(out.expressionOverride).toBeNull();
  });

  it("cùng đầu vào ra cùng kết quả, từng ký tự — khoá idempotency phụ thuộc vào đây", () => {
    for (const input of [CLEAN, SCENE_4]) {
      const a = resolveImagePrompt(input);
      const b = resolveImagePrompt(input);
      const c = resolveImagePrompt({ ...input, characters: [...input.characters] });
      expect(b.sceneDescription).toBe(a.sceneDescription);
      expect(c.sceneDescription).toBe(a.sceneDescription);
      expect(b.camera).toBe(a.camera);
      expect(c.camera).toBe(a.camera);
      expect(JSON.stringify(b.characters)).toBe(JSON.stringify(a.characters));
      expect(JSON.stringify(c.characters)).toBe(JSON.stringify(a.characters));
      expect(JSON.stringify(b.contradictions)).toBe(JSON.stringify(a.contradictions));
    }
  });

  it("không làm hỏng đầu vào của người gọi", () => {
    const sheet = SCENE_4.characters[0]!.canonical;
    resolveImagePrompt(SCENE_4);
    expect(SCENE_4.characters[0]!.canonical).toBe(sheet);
    expect(SCENE_4.sceneDescription).toContain("nothing else in frame");
  });
});
