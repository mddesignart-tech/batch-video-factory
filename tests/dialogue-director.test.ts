import { describe, expect, it } from "vitest";
import {
  DIALOGUE_CAPABILITIES,
  DIALOGUE_EMOTION_IDS,
  dialogueDirection,
  mindKeepsPunct,
  speakerEmotionOf,
} from "@/domain/dialogue-director";
import { mindDirection, mindDirectionSummary } from "@/domain/mind-voice";
import { VoiceDirectionSchema } from "@/domain/voice-director";

describe("QĐ-147 Dialogue Voice Director (thuần)", () => {
  it("mỗi nhân vật có cảm xúc riêng, độc lập; cảnh riêng > cả video > Tự động", () => {
    const emotions = { "*": { Max: "HAPPY" as const }, s1: { Max: "CALM" as const, Leo: "SURPRISED" as const } };
    expect(speakerEmotionOf(emotions, "s1", "Max")).toBe("CALM");
    expect(speakerEmotionOf(emotions, "s1", "Leo")).toBe("SURPRISED");
    expect(speakerEmotionOf(emotions, "s2", "Max")).toBe("HAPPY");
    expect(speakerEmotionOf(emotions, "s2", "Leo")).toBe("AUTO");
    expect(speakerEmotionOf({}, null, " Max ")).toBe("AUTO");
  });

  it("câu hỏi ngắn: VieNeu được yêu cầu giữ dấu ?, chữ không đổi; Supertonic không cần", () => {
    const vi = dialogueDirection({ text: "Bạn ăn sáng chưa?", engine: "vieneu", emotion: "AUTO" });
    expect(vi).toMatchObject({ text: "Bạn ăn sáng chưa?", tempo: 1, keepPunct: true, summary: "dlg=AUTO punct=keep" });
    const en = dialogueDirection({ text: "Really?", engine: "supertonic", emotion: "AUTO" });
    expect(en).toMatchObject({ text: "Really?", keepPunct: false, summary: "dlg=AUTO" });
    expect(dialogueDirection({ text: "Vậy mình đi dạo một vòng đi.", engine: "vieneu", emotion: "AUTO" })).toMatchObject({
      text: "Vậy mình đi dạo một vòng đi.",
      keepPunct: false,
      applied: [],
    });
  });

  it("chỉ dùng cần gạt engine có thật: dấu câu cuối, nhịp, tiếng cười ổn định - không bao giờ thở dài", () => {
    expect(dialogueDirection({ text: "Mình ăn rồi.", engine: "vieneu", emotion: "SURPRISED" })).toMatchObject({ text: "Mình ăn rồi!", tempo: 1.05, keepPunct: true });
    expect(dialogueDirection({ text: "Lại nữa.", engine: "vieneu", emotion: "ANNOYED" })).toMatchObject({ text: "Lại nữa!", tempo: 1.04 });
    expect(dialogueDirection({ text: "Chờ chút...", engine: "vieneu", emotion: "ANNOYED" }).text).toBe("Chờ chút...");
    expect(dialogueDirection({ text: "Giỏi ghê.", engine: "vieneu", emotion: "TEASING" })).toMatchObject({ text: "Giỏi ghê. [cười]", tempo: 1, keepPunct: false });
    expect(dialogueDirection({ text: "Nice one?", engine: "supertonic", emotion: "TEASING" }).text).toBe("Nice one? <laugh>");
    expect(dialogueDirection({ text: "Giỏi ghê?", engine: "vieneu", emotion: "TEASING" })).toMatchObject({ text: "Giỏi ghê? [cười]", keepPunct: true });
    // Cues off: no laugh, the rest stays.
    expect(dialogueDirection({ text: "Giỏi ghê.", engine: "vieneu", emotion: "TEASING", cues: false }).text).toBe("Giỏi ghê.");
    expect(dialogueDirection({ text: "Ổn mà.", engine: "vieneu", emotion: "CALM" })).toMatchObject({ text: "Ổn mà.", tempo: 0.96 });
    for (const id of DIALOGUE_EMOTION_IDS) {
      for (const engine of ["vieneu", "supertonic"] as const) {
        const d = dialogueDirection({ text: "[thở dài] Một ngày dài. <sigh>", engine, emotion: id });
        expect(d.text).not.toMatch(/thở dài|sigh|breath/);
      }
      // Every emotion says plainly what no engine can do (AUTO claims nothing).
      expect(id === "AUTO" || Boolean(DIALOGUE_CAPABILITIES[id].missing)).toBe(true);
    }
  });

  it("đọc yêu cầu giữ dấu từ chỉ dẫn đã lưu của dòng thoại", () => {
    expect(mindKeepsPunct("MIND mind-v1 engine=vieneu/int8 lang=vi director=off dlg=AUTO punct=keep")).toBe(true);
    expect(mindKeepsPunct("MIND mind-v1 engine=vieneu/int8 lang=vi director=off dlg=CALM")).toBe(false);
    expect(mindKeepsPunct("")).toBe(false);
    expect(mindKeepsPunct(undefined)).toBe(false);
  });

  it("regression: dự án cũ tắt mặc định; adapter QĐ-145/146 và chỉ dẫn không đổi", () => {
    const old = VoiceDirectionSchema.parse({ director: true, emotion: "WARM" });
    expect(old.dialogueDirector).toBe(false);
    expect(old.speakerEmotions).toEqual({});
    expect(() => VoiceDirectionSchema.parse({ speakerEmotions: { s1: { Max: "ANGRY" } } })).toThrow();
    expect(mindDirection({ text: "Bạn ăn sáng chưa?", engine: "vieneu", style: null, role: null, emotion: null }).text).toBe("Bạn ăn sáng chưa?");
    expect(mindDirectionSummary({ engine: "vieneu", variant: "int8", language: "vi", style: null, role: null, emotion: null })).toBe(
      "MIND mind-v1 engine=vieneu/int8 lang=vi director=off",
    );
  });
});
