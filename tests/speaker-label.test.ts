import { describe, expect, it } from "vitest";
import { isSpeakerLabel, parseDialogueLines, splitSpeakerLabel } from "@/domain/dialogue-lines";
import { sceneSubtitleText } from "@/domain/scene-subtitles";
import { prepareSpeechText } from "@/domain/speech-text";
import { voiceReuseKey } from "@/services/asset-keys";
import { speechTextFor } from "@/services/generation";

/**
 * QĐ-143 SPEAKER LABEL IS NOT SPOKEN TEXT. The text model wrote
 * "Narrator: ..." into the narration field and the voice read "Narrator"
 * aloud. Only a label that is a speaker of the scene or a voice role comes off;
 * "Lưu ý: ..." is words. Pure, $0.
 */

const cols = (speaking: string[]) => ({
  charactersPresentJson: JSON.stringify(speaking),
  speakingCharactersJson: JSON.stringify(speaking),
  primaryCharactersJson: JSON.stringify(speaking.slice(-1)),
});
/** What the voice is handed: the parsed line, made speakable (Voice Director). */
const ttsInput = (dialogue: string, narration: string, speaking: string[]) =>
  parseDialogueLines(dialogue, narration, speaking).map((l) => ({ speaker: l.speaker, tts: prepareSpeechText(l.text, "vi") }));

describe("QĐ-143 - nhãn người nói không phải lời đọc", () => {
  it("A: 'Narrator: Xin chào mọi người' → TTS nhận 'Xin chào mọi người'", () => {
    expect(ttsInput("", "Narrator: Xin chào mọi người", ["Narrator"])).toEqual([{ speaker: "Narrator", tts: "Xin chào mọi người" }]);
    // The real scene from project 88709340.
    expect(ttsInput("", "Narrator: Oops! Trượt ngã trên băng, thật hài hước!", ["Narrator"])[0]!.tts).toBe("Oops! Trượt ngã trên băng, thật hài hước!");
    // Quoted, bold, lower case, several narration lines.
    expect(ttsInput("", `"Narrator: Xin chào"`, ["Narrator"])[0]!.tts).toBe("Xin chào");
    expect(ttsInput("", "**Narrator:** Xin chào", ["Narrator"])[0]!.tts).toBe("Xin chào");
    expect(ttsInput("", "narrator: Xin chào\nNarrator: Tạm biệt", ["Narrator"])[0]!.tts).toBe("Xin chào\nTạm biệt");
  });

  it("B: speaker = Narrator, lời không có nhãn → giữ nguyên", () => {
    expect(ttsInput("", "Hôm nay chúng ta sẽ học ba mẹo nhỏ.", ["Narrator"])).toEqual([{ speaker: "Narrator", tts: "Hôm nay chúng ta sẽ học ba mẹo nhỏ." }]);
  });

  it("C: 'Speaker A: Bạn khỏe không?' → TTS không đọc 'Speaker A'", () => {
    expect(ttsInput("Speaker A: Bạn khỏe không?", "", ["Mia"])).toEqual([{ speaker: "Mia", tts: "Bạn khỏe không?" }]);
    expect(ttsInput("", "Speaker B: Mình khỏe.", ["Narrator"])[0]!.tts).toBe("Mình khỏe.");
    for (const label of ["Host", "Voice Over", "VO", "Người dẫn chuyện"]) {
      expect(ttsInput("", `${label}: Chào bạn.`, ["Narrator"])[0]!.tts).toBe("Chào bạn.");
    }
  });

  it("D: Character Mia: 'Mia: Let's go!' → chỉ đọc 'Let's go!' (dialogue và narration)", () => {
    expect(ttsInput("Mia: Let's go!", "", ["Mia"])).toEqual([{ speaker: "Mia", tts: "Let's go!" }]);
    expect(ttsInput("", "Mia: Let's go!", ["Mia"])).toEqual([{ speaker: "Mia", tts: "Let's go!" }]);
  });

  it("E: 'Lưu ý: đây là điều quan trọng' → KHÔNG bỏ 'Lưu ý:'; chỉ bỏ nhãn khớp người nói", () => {
    expect(ttsInput("", "Lưu ý: đây là điều quan trọng", ["Narrator"])[0]!.tts).toBe("Lưu ý: đây là điều quan trọng");
    expect(ttsInput("", "Chim cánh cụt: vũ công bơi tuyệt vời!", ["Narrator"])[0]!.tts).toBe("Chim cánh cụt: vũ công bơi tuyệt vời!");
    expect(ttsInput("", "Narrator: Nhớ nhé: không bay, bơi giỏi.", ["Narrator"])[0]!.tts).toBe("Nhớ nhé: không bay, bơi giỏi.");
    expect(ttsInput("Note: this matters.", "", ["Mia"])[0]!.tts).toBe("Note: this matters.");
    // A name that is not a speaker of this scene stays words.
    expect(ttsInput("", "Max: đây không phải nhãn ở cảnh này", ["Narrator"])[0]!.tts).toBe("Max: đây không phải nhãn ở cảnh này");
    expect(isSpeakerLabel("Lưu ý", ["Narrator"])).toBe(false);
    expect(isSpeakerLabel("Speaker A", [])).toBe(true);
    expect(splitSpeakerLabel("Lưu ý: x", ["Narrator"])).toEqual({ speaker: null, text: "Lưu ý: x" });
  });

  it("speechTextFor (ước tính / kế hoạch): cùng luật - bỏ nhãn người nói, giữ 'Lưu ý:'", () => {
    expect(speechTextFor({ dialogue: "", narration: "Narrator: Xin chào mọi người", ...cols(["Narrator"]) })).toBe("Xin chào mọi người");
    expect(speechTextFor({ dialogue: `Max: "So easy!"`, narration: "", ...cols(["Max"]) })).toBe("So easy!");
    expect(speechTextFor({ dialogue: "", narration: "Lưu ý: đây là điều quan trọng", ...cols(["Narrator"]) })).toBe("Lưu ý: đây là điều quan trọng");
    expect(speechTextFor({ dialogue: "Note: this matters.", narration: "", ...cols(["Mia"]) })).toBe("Note: this matters.");
  });

  it("F: phụ đề mặc định không có nhãn người nói", () => {
    const narrated = { dialogue: "", narration: "Narrator: Xin chào mọi người", subtitle: "", ...cols(["Narrator"]) };
    expect(sceneSubtitleText(narrated)).toBe("Xin chào mọi người");
    expect(sceneSubtitleText({ ...narrated, dialogue: "Mia: Let's go!", narration: "", ...cols(["Mia"]) })).toBe("Let's go!");
    // A conversation still says who speaks which line - the narrator never.
    expect(sceneSubtitleText({ dialogue: "Max: Hi!\nLeo: Hello.", narration: "", subtitle: "", ...cols(["Max", "Leo"]) })).toBe("Max: Hi!\nLeo: Hello.");
  });

  it("G: nhiều người nói - mỗi câu đúng người nói (đúng giọng), nhãn không lọt vào lời", () => {
    const lines = parseDialogueLines(`Max: "So easy!" Leo: "No, Max, it's an idiom."\nMia: Let's go!`, "", ["Max", "Leo", "Mia"]);
    expect(lines.map((l) => [l.speaker, l.text])).toEqual([
      ["Max", "So easy!"],
      ["Leo", "No, Max, it's an idiom."],
      ["Mia", "Let's go!"],
    ]);
  });

  it("khoá giọng: câu không có nhãn giữ y nguyên khoá cũ; câu có nhãn có khoá của lời thật", () => {
    const key = (text: string) =>
      voiceReuseKey({ provider: "openai", model: "gpt-4o-mini-tts", text, voiceId: "marin", instructions: "x", speed: 1, accent: "US", targetDuration: 4, spokenText: prepareSpeechText(text, "vi") });
    const clean = parseDialogueLines("", "Hôm nay chúng ta sẽ học.", ["Narrator"])[0]!.text;
    expect(key(clean)).toBe(key("Hôm nay chúng ta sẽ học."));
    const labelled = parseDialogueLines("", "Narrator: Hôm nay chúng ta sẽ học.", ["Narrator"])[0]!.text;
    expect(key(labelled)).toBe(key("Hôm nay chúng ta sẽ học."));
    expect(key(labelled)).not.toBe(key("Narrator: Hôm nay chúng ta sẽ học."));
  });
});
