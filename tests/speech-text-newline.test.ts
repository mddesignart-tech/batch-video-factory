import { describe, expect, it } from "vitest";
import { prepareSpeechText } from "@/domain/speech-text";
import { parseDialogueLines } from "@/domain/dialogue-lines";
import { DEFAULT_TIMING, resolveSceneDuration } from "@/domain/scene-timing";
import { NATURAL_MAX_SPEED } from "@/domain/voice-director";

/**
 * QĐ-156: what a line break in a script becomes in the text a voice is given.
 * VieNeu reads every "\n" as a full stop, so a break inside a sentence was a
 * 650 ms stop inside the phrase. Pure: no engine.
 */

const BAT = "Những lớp vật liệu tạo thành một chiếc bát nhỏ ấm áp.";

describe("xuống dòng trong văn bản gửi TTS (QĐ-156)", () => {
  it("D1: câu không xuống dòng - giữ nguyên từng chữ", () => {
    expect(prepareSpeechText(BAT, "vi")).toBe(BAT);
  });

  it("D2: xuống dòng giữa câu = khoảng trắng, không thêm dấu chấm", () => {
    expect(prepareSpeechText("Những lớp vật liệu tạo thành một chiếc bát nhỏ\nấm áp.", "vi")).toBe(BAT);
    expect(prepareSpeechText("Những lớp vật liệu tạo thành một\r\nchiếc bát nhỏ ấm áp.", "vi")).toBe(BAT);
    expect(prepareSpeechText("Những lớp vật liệu tạo thành một   \n   chiếc bát nhỏ ấm áp.", "vi")).toBe(BAT);
  });

  it("D3: dấu phẩy có ý nghĩa được giữ", () => {
    expect(prepareSpeechText("Những lớp vật liệu tạo thành một chiếc bát nhỏ, ấm áp.", "vi")).toBe("Những lớp vật liệu tạo thành một chiếc bát nhỏ, ấm áp.");
  });

  it("D4: hai câu trên hai dòng = hai câu liền nhau (nghỉ theo dấu chấm)", () => {
    expect(prepareSpeechText(`${BAT}\nĐó là nơi chú chim bắt đầu xây dựng tổ ấm của mình.`, "vi")).toBe(
      `${BAT} Đó là nơi chú chim bắt đầu xây dựng tổ ấm của mình.`,
    );
  });

  it("D5: dòng trống = ngắt đoạn có chủ đích, giữ lại (một ngắt, dù nhiều dòng trống)", () => {
    const text = "Chú chim nhỏ bắt đầu tìm vật liệu.\n\nNó nhặt những cành cây khô.\n\n\n  \nSau đó, nó dùng các sợi cỏ mềm để tạo thành một chiếc tổ ấm áp.";
    expect(prepareSpeechText(text, "vi")).toBe(
      "Chú chim nhỏ bắt đầu tìm vật liệu.\nNó nhặt những cành cây khô.\nSau đó, nó dùng các sợi cỏ mềm để tạo thành một chiếc tổ ấm áp.",
    );
  });

  it("D6: dấu câu phức tạp và khoảng trắng dư - không mất dấu nào, không thêm dấu nào", () => {
    const text = '  Bạn có biết:   "chim họa mi"   làm tổ thế nào?\nThật kỳ diệu!\n\nNó kiên nhẫn... từng chút một.  ';
    expect(prepareSpeechText(text, "vi")).toBe('Bạn có biết: "chim họa mi" làm tổ thế nào? Thật kỳ diệu!\nNó kiên nhẫn... từng chút một.');
  });

  it("hai lời trên hai dòng KHÔNG có dấu câu, dòng sau viết hoa: vẫn là hai lời (giữ ngắt)", () => {
    expect(prepareSpeechText("Xin chào\nTạm biệt", "vi")).toBe("Xin chào\nTạm biệt");
  });

  it("lời thoại nhiều dòng qua parseDialogueLines vẫn là MỘT câu thoại, xuống dòng chỉ đổi khi gửi TTS", () => {
    const lines = parseDialogueLines("", "Những lớp vật liệu tạo thành một\nchiếc bát nhỏ ấm áp.", ["Narrator"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain("\n");
    expect(prepareSpeechText(lines[0]!.text, "vi")).toBe(BAT);
  });
});

describe("lời dài hơn cảnh (QĐ-156 phần G): cảnh 3 s, lời 4,5 s", () => {
  it("không cắt lời, không ép tốc độ: cảnh được nâng cho đủ lời ở mọi chế độ thời lượng", () => {
    const pad = DEFAULT_TIMING.voicePaddingBefore + DEFAULT_TIMING.voicePaddingAfter;
    for (const durationMode of ["AUTO", "MINIMUM", "LOCKED"] as const) {
      const t = resolveSceneDuration({ sceneNumber: 5, plannedDuration: 3, voiceDuration: 4.5, durationMode, motion: "LOCAL_MOTION" });
      expect(t.finalDuration).toBeGreaterThanOrEqual(4.5 + pad - 1e-9);
      expect(t.plannedDuration).toBe(3);
      expect(t.blocked).toBe(false);
      expect(t.change).toBe("RENDER_ONLY_CHANGE");
    }
    const locked = resolveSceneDuration({ sceneNumber: 5, plannedDuration: 3, voiceDuration: 4.5, durationMode: "LOCKED", motion: "LOCAL_MOTION" });
    expect(locked.message + locked.timingReason).toMatch(/LOCKED_RAISED_FOR_VOICE/);
    expect(NATURAL_MAX_SPEED).toBeLessThanOrEqual(1.15);
  });
});
