import { describe, expect, it } from "vitest";
import { adaptMindCues, MIND_CUES, mindCueUsable, mindDirection, mindDirectionSummary } from "@/domain/mind-voice";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  DIALOGUE_AB_RATINGS,
  isPriorityVoice,
  MIND_PRIORITY_VOICE,
  MIND_VOICE_SUGGESTIONS,
  mindUseCaseFor,
  ratingOf,
  suggestMindVoices,
  THUC_DOAN_PRESET,
  totalScore,
  VOICE_BASELINE,
  VOICE_RATINGS,
} from "@/domain/voice-quality";
import { controlsOf } from "@/domain/output-controls";

/** QĐ-146: user ratings, voice suggestions, and the emotion-cue adapter. Pure, $0. */

describe("QĐ-146 điểm người nghe: lưu nguyên, không tự đổi", () => {
  it("15 mẫu, đúng điểm người dùng chấm (Tự nhiên / Phát âm / Cảm xúc / Phù hợp), mỗi mẫu trỏ tới file đã nghe", () => {
    const given: Record<string, [number, number, number, number]> = {
      "01": [4, 5, 4, 5], "02": [5, 5, 5, 5], "03": [4, 5, 4, 5], "04": [4, 5, 4, 4], "05": [5, 5, 5, 4],
      "06": [3, 3, 3, 3], "07": [4, 4, 4, 4], "08": [5, 5, 4, 5], "09": [5, 4, 4, 5], "10": [5, 5, 5, 5],
      "11": [4, 4, 4, 3], "12": [5, 4, 4, 3], V1: [4, 5, 5, 5], V2: [4, 4, 3, 4], V3: [4, 4, 4, 4],
    };
    // (Object.keys would put "10".."12" first: they look like array indexes.)
    expect(VOICE_RATINGS.items.map((r) => r.id)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "V1", "V2", "V3"]);
    for (const r of VOICE_RATINGS.items) {
      const s = r.scores;
      expect([s.natural, s.pronunciation, s.emotion, s.fit], r.id).toEqual(given[r.id]);
      expect(r.file).toMatch(/^data\/voice-ab\/mind-voice-(real-)?2026-10-22[^/]*\/.+\.(wav|mp4)$/);
    }
    expect(ratingOf("06")!.note).toMatch(/thở dài/);
    expect(VOICE_RATINGS.ratedBy).toMatch(/thủ công/);
    // Frozen: code cannot change a score.
    expect(() => {
      (ratingOf("06")!.scores as { emotion: number }).emotion = 5;
    }).toThrow();
    expect(ratingOf("06")!.scores.emotion).toBe(3);
    expect(totalScore(ratingOf("02")!.scores)).toBe(20);
  });
});

describe("QĐ-146 gợi ý giọng theo loại nội dung", () => {
  it("đúng danh sách người dùng chọn, kèm điểm làm căn cứ; Adam bựa là ứng viên cần thử thêm", () => {
    const ids = (u: keyof typeof MIND_VOICE_SUGGESTIONS) => suggestMindVoices(u).map((v) => v.voiceId);
    expect(ids("REVIEW_AI")).toEqual(["Hải Đăng", "Trúc Ly"]);
    expect(ids("REVIEW_PRODUCT")).toEqual(["Thục Đoan", "Trúc Ly"]);
    expect(ids("STORYTELLING")).toEqual(["Thục Đoan", "Thiện Minh"]);
    expect(ids("COMEDY")).toEqual(["Adam bựa"]);
    expect(suggestMindVoices("COMEDY")[0]!.candidate).toBe(true);
    expect(suggestMindVoices("ENGLISH").map((v) => [v.voiceId, v.label])).toEqual([["F1", "Nữ"], ["M1", "Nam"]]);
    const hd = suggestMindVoices("REVIEW_AI")[0]!;
    expect(hd.bestScore).toBe(19);
    expect(hd.basis).toBe("mẫu 01: 18/20, mẫu V1: 19/20");
    expect(suggestMindVoices("REVIEW_PRODUCT")[0]).toMatchObject({ voiceId: "Thục Đoan", bestScore: 20 });
  });

  it("chọn danh sách theo ngôn ngữ, phong cách giọng, loại nội dung; không có căn cứ → không gợi ý", () => {
    expect(mindUseCaseFor({ language: "en", contentType: "AI_REVIEW", styleId: "COMEDY" })).toBe("ENGLISH");
    expect(mindUseCaseFor({ language: "vi", contentType: "AI_REVIEW", styleId: "COMEDY" })).toBe("COMEDY");
    expect(mindUseCaseFor({ language: "vi", contentType: "AI_REVIEW", styleId: "PRODUCT_REVIEW" })).toBe("REVIEW_AI");
    expect(mindUseCaseFor({ language: "vi", contentType: "PRODUCT_REVIEW", styleId: "PRODUCT_REVIEW" })).toBe("REVIEW_PRODUCT");
    expect(mindUseCaseFor({ language: "vi", contentType: "STORY", styleId: "STORYTELLING" })).toBe("STORYTELLING");
    expect(mindUseCaseFor({ language: "vi", contentType: "KNOWLEDGE", styleId: "EDUCATIONAL" })).toBeNull();
  });
});

describe("QĐ-146 emotion adapter theo khả năng thật của engine", () => {
  it("bảng khả năng: VieNeu [cười] [hắng giọng] ổn định, [thở dài] không; Supertonic <laugh> ổn định, <sigh> <breath> không", () => {
    expect(mindCueUsable("vieneu", "laugh")).toBe(true);
    expect(mindCueUsable("vieneu", "clearThroat")).toBe(true);
    expect(mindCueUsable("vieneu", "sigh")).toBe(false);
    expect(mindCueUsable("supertonic", "laugh")).toBe(true);
    expect(mindCueUsable("supertonic", "sigh")).toBe(false);
    expect(mindCueUsable("supertonic", "breath")).toBe(false);
    expect(mindCueUsable("supertonic", "clearThroat")).toBe(false);
    expect(mindCueUsable("vieneu", "laugh", false)).toBe(false);
    for (const engine of ["vieneu", "supertonic"] as const) {
      for (const cap of Object.values(MIND_CUES[engine])) expect(cap!.evidence.length).toBeGreaterThan(10);
    }
  });

  it("thẻ gõ tay: thẻ không ổn định bị bỏ (không gửi thẻ sai), thẻ ổn định viết theo cú pháp engine, chữ trong ngoặc khác giữ nguyên", () => {
    expect(adaptMindCues("[thở dài] Một ngày dài cuối cùng cũng kết thúc.", "vieneu")).toEqual({
      text: "Một ngày dài cuối cùng cũng kết thúc.",
      dropped: [{ tag: "[thở dài]", cue: "sigh", reason: "unreliable" }],
    });
    expect(adaptMindCues("Một ngày dài, [Thở Dài] cuối cùng cũng kết thúc.", "vieneu").text).toBe("Một ngày dài, cuối cùng cũng kết thúc.");
    expect(adaptMindCues("Xong rồi [thở dài].", "vieneu").text).toBe("Xong rồi.");
    expect(adaptMindCues("Haha <laugh> thật à?", "vieneu").text).toBe("Haha [cười] thật à?");
    expect(adaptMindCues("No way [cười] really?", "supertonic").text).toBe("No way <laugh> really?");
    expect(adaptMindCues("[hắng giọng] Hello.", "supertonic")).toEqual({ text: "Hello.", dropped: [{ tag: "[hắng giọng]", cue: "clearThroat", reason: "unsupported" }] });
    expect(adaptMindCues("Giá [khoảng] 500 đô [cười].", "vieneu").text).toBe("Giá [khoảng] 500 đô [cười].");
    expect(adaptMindCues("Câu một. [cười]\n[thở dài]\nCâu hai.", "vieneu").text).toBe("Câu một. [cười]\nCâu hai.");
  });

  it("tắt thẻ cảm xúc: không gửi thẻ nào, nhịp câu giữ nguyên; khoá giọng khác (cues=off)", () => {
    const two = "Câu một rất hay. Câu hai còn hay hơn!";
    const r = mindDirection({ text: two, engine: "vieneu", style: "COMEDY", role: "PUNCHLINE", emotion: "HUMOROUS", cues: false });
    expect(r.text).toBe("Câu một rất hay.\nCâu hai còn hay hơn!");
    expect(r.tags).toEqual([]);
    expect(mindDirection({ text: `[cười] ${two}`, engine: "vieneu", style: null, role: null, emotion: null, cues: false }).text).toBe(two);
    const base = { engine: "vieneu" as const, variant: "fp32", language: "vi", style: null, role: null, emotion: null };
    expect(mindDirectionSummary({ ...base, cues: false })).toBe("MIND mind-v1 engine=vieneu/fp32 lang=vi director=off cues=off");
  });

  it("một câu cảm động: không còn [thở dài]/<sigh>, chỉ nhịp câu", () => {
    const touching = { style: "STORYTELLING" as const, role: "EMOTIONAL" as const, emotion: "TOUCHING" as const };
    const vi = mindDirection({ text: "Mẹ đã đợi rất lâu. Cuối cùng con cũng về.", engine: "vieneu", ...touching });
    expect(vi.text).toBe("Mẹ đã đợi rất lâu.\nCuối cùng con cũng về.");
    expect(vi.tags).toEqual([]);
    expect(mindDirection({ text: "She waited so long.", engine: "supertonic", ...touching }).text).toBe("She waited so long.");
  });
});

describe("QĐ-146 hồi quy: mẫu tốt không đổi (cùng chữ gửi đi + cùng chỉ dẫn → cùng khoá → dùng lại audio cũ)", () => {
  const good: [string, "vieneu" | "supertonic", string][] = [
    ["01 Hải Đăng / V1", "vieneu", "Bạn có biết, chỉ cần uống một ly nước ngay sau khi thức dậy, cơ thể sẽ tỉnh táo hơn hẳn? Thói quen nhỏ này không tốn tiền, cũng chẳng mất thêm thời gian."],
    ["02 Thục Đoan", "vieneu", "Sáng mai thử ngay, rồi kể cho mình nghe cảm giác nhé!"],
    ["03 Thiện Minh", "vieneu", "Ngày xưa, ở một ngôi làng nhỏ ven sông, có một cậu bé rất thích hỏi.\nMột hôm, bà cậu mỉm cười và nói: muốn hiểu thế giới, con hãy bắt đầu bằng việc lắng nghe."],
    ["05 Adam bựa", "vieneu", "Tôi tưởng mình giỏi lắm. [cười] Hóa ra lại quên mang chìa khóa."],
    ["07 Thiện Minh", "vieneu", "[hắng giọng] Xin chào các bạn, hôm nay chúng ta nói về thói quen buổi sáng."],
    ["08 Trúc Ly", "vieneu", "Hôm nay mình review chiếc smartphone mới, pin dùng được cả ngày, camera thì rất sharp, và giá chỉ khoảng năm trăm đô."],
    ["10 F1", "supertonic", "Did you know that a single glass of water right after you wake up can make you feel more alert? It costs nothing, and it takes no extra time."],
    ["11 M2", "supertonic", "I thought I had it all figured out. <laugh> Turns out, I forgot my keys again."],
  ];
  it.each(good)("%s: chữ gửi đi giữ nguyên", (_name, engine, text) => {
    expect(mindDirection({ text, engine, style: null, role: null, emotion: null }).text).toBe(text);
  });

  it("chỉ dẫn (instructions) của dự án cũ giữ nguyên chữ; dự án cũ đọc ra emotionCues = bật", () => {
    const base = { engine: "supertonic" as const, variant: "cpu", language: "en", style: "COMEDY" as const, role: "PUNCHLINE" as const, emotion: "HUMOROUS" as const };
    expect(mindDirectionSummary(base)).toBe("MIND mind-v1 engine=supertonic/cpu lang=en style=COMEDY role=PUNCHLINE emotion=HUMOROUS");
    expect(mindDirectionSummary({ ...base, cues: true })).toBe(mindDirectionSummary(base));
    // V3 (Comedy, punchline) still gets its laugh exactly as before.
    expect(mindDirection({ text: "I tried it. Turns out, no.", ...base }).text).toBe("I tried it. Turns out, no. <laugh>");
    const old = { outputControlsJson: JSON.stringify({ voice: { provider: "mindvoice", model: "mind-local", voiceId: "Thục Đoan" } }) };
    expect(controlsOf(old as Parameters<typeof controlsOf>[0]).voice).toMatchObject({ voiceId: "Thục Đoan", emotionCues: true });
  });
});

describe("QĐ-148 Thục Đoan: giọng ưu tiên #1, preset đúng mẫu 20/20, baseline", () => {
  it("ưu tiên #1 chỉ là đánh dấu + đứng đầu gợi ý; không đổi điểm, không đổi cách chọn tự động", () => {
    expect(MIND_PRIORITY_VOICE.vi).toBe("Thục Đoan");
    expect(isPriorityVoice("Thục Đoan", "vi")).toBe(true);
    expect(isPriorityVoice("Hải Đăng", "vi")).toBe(false);
    expect(isPriorityVoice("Thục Đoan", "en")).toBe(false);
    for (const u of ["STORYTELLING", "REVIEW_PRODUCT", "EMOTIONAL"] as const) {
      expect(suggestMindVoices(u)[0], u).toMatchObject({ voiceId: "Thục Đoan", priority: true, bestScore: 20 });
    }
    expect(MIND_VOICE_SUGGESTIONS.EMOTIONAL.label).toBe("Nội dung cần cảm xúc");
    expect(suggestMindVoices("REVIEW_AI").map((v) => v.voiceId)).toEqual(["Hải Đăng", "Trúc Ly"]);
    expect(suggestMindVoices("REVIEW_AI").some((v) => v.priority)).toBe(false);
    expect(totalScore(ratingOf("02")!.scores)).toBe(20);
    // No project is moved to a new list: no content type / style maps to EMOTIONAL.
    for (const styleId of ["DRAMATIC", "STORYTELLING", "NATURAL", "COMEDY"] as const) {
      expect(mindUseCaseFor({ language: "vi", contentType: null, styleId })).not.toBe("EMOTIONAL");
    }
  });

  it("preset 'Thục Đoan – Tự nhiên & Biểu cảm' = đúng cấu hình mẫu 02: VieNeu fp32, tốc độ 1, không director, không thẻ, không hậu kỳ", () => {
    expect(THUC_DOAN_PRESET).toMatchObject({
      label: "Thục Đoan – Tự nhiên & Biểu cảm",
      baseline: "02",
      engine: "vieneu",
      variant: "fp32",
      voiceId: "Thục Đoan",
      language: "vi",
      speed: 1,
      style: null,
      emotion: null,
      pause: "natural",
      dialogueDirector: false,
      keepPunct: false,
    });
    expect(VOICE_BASELINE.request.voice).toBe(THUC_DOAN_PRESET.voiceId);
    expect(VOICE_BASELINE.request.text).not.toMatch(/\[|<\w+>/);
    // The words of the baseline still go out unchanged (same voice key as the rated sample).
    expect(mindDirection({ text: VOICE_BASELINE.request.text, engine: "vieneu", style: null, role: null, emotion: null }).text).toBe(VOICE_BASELINE.request.text);
    expect(() => {
      (THUC_DOAN_PRESET as { speed: number }).speed = 1.1;
    }).toThrow();
  });

  it("baseline: đúng file đã nghe (SHA-256) khi file có trên máy", () => {
    expect(VOICE_BASELINE.file).toBe(ratingOf("02")!.file);
    if (!fs.existsSync(VOICE_BASELINE.file)) return; // data/ is not in git
    const hash = createHash("sha256").update(fs.readFileSync(VOICE_BASELINE.file)).digest("hex");
    expect(hash).toBe(VOICE_BASELINE.sha256);
  });

  it("QĐ-147 điểm A/B hội thoại lưu đúng như người dùng chấm", () => {
    expect(DIALOGUE_AB_RATINGS.items.map((r) => [r.id, r.scores.natural, r.scores.pronunciation, r.scores.emotion, r.scores.fit, totalScore(r.scores)])).toEqual([
      ["A", 3, 4, 3, 2, 12],
      ["B", 3, 4, 3, 3, 13],
    ]);
    expect(() => {
      (DIALOGUE_AB_RATINGS.items[0]!.scores as { fit: number }).fit = 5;
    }).toThrow();
  });
});
