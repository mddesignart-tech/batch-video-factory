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

// ------------------------------------------ the holes the QĐ-065 audit found ---

/**
 * `scripts/audit-image-guard.ts` put eight named contradiction shapes through
 * the guard and four of them came back silent. Silence from a guard is
 * indistinguishable from "nothing was wrong", which is precisely how scene 4 of
 * the first real batch was bought. These are the four, and they stay here so a
 * future edit to a lexicon cannot quietly reopen one. See QĐ-075.
 */
describe("QĐ-075: bốn lỗ hổng bộ dò tìm ra khi audit", () => {
  // 1. "does not smile" contains "smile", so a lexicon that only looks for
  // words read a PROHIBITION as a REQUEST - and then agreed with a sheet that
  // says "wide eager smile".
  describe("phủ định biểu cảm không còn bị đọc thành yêu cầu", () => {
    it("'không cười' + bảng nhân vật 'wide eager smile' -> BẮT ĐƯỢC", () => {
      const out = findImageContradictions({
        sceneDescription: "Max looks deadly serious and does not smile at all.",
        camera: "Locked static medium shot.",
        characters: [
          { name: "Max", canonical: "a boy, wide eager smile, outfit: yellow hoodie" },
        ],
      });
      const hit = out.find((c) => c.kind === "expression_vs_sheet");
      expect(hit).toBeDefined();
      expect(hit!.kept).toContain("SERIOUS");
      expect(hit!.dropped).toBe("wide eager smile");
    });

    it("'serious' nay là một nhóm biểu cảm thật, không còn vô hình", () => {
      const out = findImageContradictions({
        sceneDescription: "Max is stern and unsmiling.",
        camera: "",
        characters: [{ name: "Max", canonical: "a boy, always smiling" }],
      });
      expect(out.map((c) => c.kind)).toContain("expression_vs_sheet");
    });

    // The rule must not fire the other way: a scene that AGREES with the sheet
    // is not a contradiction, and rewriting it would be editing correct input.
    it("cảnh và bảng nhân vật cùng nói cười -> KHÔNG báo gì", () => {
      const out = findImageContradictions({
        sceneDescription: "Max grins widely.",
        camera: "",
        characters: [{ name: "Max", canonical: "a boy, wide eager smile" }],
      });
      expect(out.filter((c) => c.kind === "expression_vs_sheet")).toEqual([]);
    });
  });

  // 2. One body, two postures. No rule existed at all.
  describe("đứng và ngồi cùng lúc", () => {
    it("'stands ... while sitting' -> posture_conflict", () => {
      const out = findImageContradictions({
        sceneDescription: "Max stands at the end of the board while sitting on the bench.",
        camera: "",
        characters: [],
      });
      const hit = out.find((c) => c.kind === "posture_conflict");
      expect(hit).toBeDefined();
      expect(hit!.kept).toBe("stands");
      expect(hit!.dropped).toBe("sitting");
    });

    // Not auto-resolved on purpose: deleting either half leaves a sentence that
    // reads correctly and means something nobody wrote.
    it("KHÔNG tự sửa, và nói rõ là không tự sửa", () => {
      const out = findImageContradictions({
        sceneDescription: "Max kneels by the door, then he stands in the hallway.",
        camera: "",
        characters: [],
      });
      const hit = out.find((c) => c.kind === "posture_conflict")!;
      expect(hit.resolved).toBe(false);
      expect(hit.message).toContain("KHÔNG tự sửa");
    });

    it("một tư thế duy nhất -> KHÔNG báo gì", () => {
      const out = findImageContradictions({
        sceneDescription: "Max stands still at the end of the diving board.",
        camera: "",
        characters: [],
      });
      expect(out.filter((c) => c.kind === "posture_conflict")).toEqual([]);
    });

    // "Stands out" is not a posture. A guard that fires on idioms gets muted.
    it("'stands out' / 'stands for' KHÔNG phải tư thế", () => {
      const out = findImageContradictions({
        sceneDescription: "The jar stands out against the wall while Max is sitting.",
        camera: "",
        characters: [],
      });
      expect(out.filter((c) => c.kind === "posture_conflict")).toEqual([]);
    });
  });

  // 3. A crowd beside "nothing else in frame" - the QĐ-064 failure with people
  // instead of props.
  describe("đám đông vs khung trống", () => {
    it("'a cheering crowd' + 'nothing else is in frame' -> BẮT ĐƯỢC", () => {
      const out = findImageContradictions({
        sceneDescription:
          "Max stands in front of a cheering crowd, and nothing else is in frame.",
        camera: "",
        characters: [],
      });
      const hit = out.find((c) => c.kind === "crowd_vs_empty_frame");
      expect(hit).toBeDefined();
      expect(hit!.resolved).toBe(true);
    });

    it("đám đông thắng, câu khung trống bị bỏ khỏi prompt", () => {
      const resolved = resolveImagePrompt({
        sceneDescription: "Max waves at the audience, and nothing else is in frame.",
        camera: "",
        characters: [],
      });
      expect(resolved.sceneDescription).toContain("audience");
      expect(resolved.sceneDescription).not.toContain("nothing else");
    });

    // Nền phẳng một mình không phải mâu thuẫn - gần như mọi cảnh của dự án này
    // đều là nền phẳng.
    it("nền trống KHÔNG có đám đông -> KHÔNG báo gì", () => {
      const out = findImageContradictions({
        sceneDescription: "Max stands against a plain grey background, nothing else in frame.",
        camera: "",
        characters: [],
      });
      expect(out.filter((c) => c.kind === "crowd_vs_empty_frame")).toEqual([]);
    });
  });

  // 4. A different garment entirely, not merely a recoloured one.
  describe("trang phục khác hẳn với bộ đã khoá", () => {
    it("'red raincoat' vs bộ khoá 'yellow hoodie, blue jeans' -> BẮT ĐƯỢC", () => {
      const out = findImageContradictions({
        sceneDescription: "Max wears a red raincoat and green wellies.",
        camera: "",
        characters: [
          { name: "Max", canonical: "a boy. outfit: bright yellow hoodie, blue jeans" },
        ],
      });
      const hits = out.filter((c) => c.kind === "garment_vs_locked_identity");
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits.map((h) => h.dropped).join(" ")).toContain("raincoat");
      // Not auto-resolved: a costume change and a mistake look identical from
      // here, and only a person can tell them apart.
      expect(hits[0]!.resolved).toBe(false);
      expect(hits[0]!.character).toBe("Max");
    });

    it("mặc đúng đồ đã khoá -> KHÔNG báo gì", () => {
      const out = findImageContradictions({
        sceneDescription: "Max tugs at his yellow hoodie and looks down at his blue jeans.",
        camera: "",
        characters: [
          { name: "Max", canonical: "a boy. outfit: bright yellow hoodie, blue jeans" },
        ],
      });
      expect(out.filter((c) => c.kind === "garment_vs_locked_identity")).toEqual([]);
    });

    it("nhân vật chưa khai trang phục -> không có gì để so, KHÔNG báo gì", () => {
      const out = findImageContradictions({
        sceneDescription: "Max wears a red raincoat.",
        camera: "",
        characters: [{ name: "Max", canonical: "a boy with dark hair" }],
      });
      expect(out.filter((c) => c.kind === "garment_vs_locked_identity")).toEqual([]);
    });
  });

  // The guard ran over all 29 real scenes during the audit and produced 11
  // findings, every one auto-resolved and none of them from the three new
  // rules. This pins the part that matters: the new rules are silent on the
  // prose this project actually contains.
  it("ba luật mới KHÔNG kêu oan trên văn phong storyboard thật", () => {
    const realScenes = [
      "Max stands alone at the end of a high diving board against a plain pale sky. Max holds still and looks ahead.",
      "A plain shot of Max from the knees down, both feet sealed inside one slab of pale cartoon ice on the board. The feet stay exactly where they are.",
      "Max stands alone against a plain light grey background, mouth slightly open, arms relaxed at his sides. Nobody else is in the shot. Max blinks once and tilts his head very slightly.",
      "Max on a plain background, a little calmer, arms at his sides. Max stands still.",
      "Max stands on plain ground against a clean background, arms relaxed at his sides. Max stays where he is.",
    ];
    for (const sceneDescription of realScenes) {
      const out = findImageContradictions({
        sceneDescription,
        camera: "Locked static medium shot, no camera movement.",
        characters: [
          {
            name: "Max",
            canonical:
              "young adult male cartoon character. hair: short messy dark brown hair. " +
              "outfit: bright yellow hoodie with a single white chest stripe, blue jeans",
          },
        ],
      });
      const fresh = out.filter((c) =>
        ["posture_conflict", "crowd_vs_empty_frame", "garment_vs_locked_identity"].includes(
          c.kind,
        ),
      );
      expect(fresh).toEqual([]);
    }
  });
});
