import { describe, expect, it } from "vitest";
import { analyseCrowding, COMFORTABLE_CAST } from "@/domain/crowding";
import type { ScriptDoc } from "@/domain/script";

/**
 * Character crowding, checked against fixtures.
 *
 * These fixtures are the two real shapes seen from the text model: a tight
 * two-hander, and the over-corrected version where a third character was
 * pasted silently into every scene. No API is called and nothing is billed.
 *
 * What this CANNOT prove is that a real model obeys the prompt instruction -
 * only a paid call shows that. It proves that when a model does over-crowd a
 * script, the app notices instead of quietly paying for it.
 */

function scene(
  sceneNumber: number,
  present: string[],
  speaking: string[],
  primary: string[],
): ScriptDoc["scenes"][number] {
  return {
    sceneNumber,
    duration: 4,
    visualDescription: "x",
    dialogue: speaking.length > 0 ? `${speaking[0]}: "hi"` : "",
    narration: "",
    subtitle: "",
    camera: "",
    characterAction: "",
    soundEffect: "",
    imagePrompt: "",
    videoPrompt: "",
    complexity: "LOW",
    spendPriority: "NORMAL",
    charactersPresent: present,
    speakingCharacters: speaking,
    primaryCharacters: primary,
    characters: present,
  };
}

function script(scenes: ScriptDoc["scenes"]): ScriptDoc {
  return {
    idiom: "Spill the beans",
    title: "t",
    hook: "h",
    literalMisunderstanding: "",
    setup: "",
    escalation: "",
    punchline: "p",
    meaning: "m",
    exampleSentence: "e",
    durationTarget: 27,
    scenes,
    closingCTA: "c",
    angleKey: "a",
  } as ScriptDoc;
}

/** The shape we want: two leads, a third character only where the gag needs one. */
const TIGHT = script([
  scene(1, ["Max"], ["Max"], ["Max"]),
  scene(2, ["Max", "Leo"], ["Max"], ["Max"]),
  scene(3, ["Max", "Leo"], ["Max", "Leo"], ["Max"]),
  scene(4, ["Max", "Leo", "Mia"], ["Max"], ["Max"]),
  scene(5, ["Leo"], ["Leo"], ["Leo"]),
]);

/** The over-corrected shape: Mia pasted into every scene, silent throughout. */
const PADDED = script([
  scene(1, ["Max", "Leo", "Mia"], ["Max"], ["Max"]),
  scene(2, ["Max", "Leo", "Mia"], ["Max"], ["Max"]),
  scene(3, ["Max", "Leo", "Mia"], ["Leo"], ["Leo"]),
  scene(4, ["Max", "Leo", "Mia"], ["Max"], ["Max"]),
  scene(5, ["Max", "Leo", "Mia"], ["Max"], ["Max"]),
]);

describe("phát hiện nhân vật bị nhét thừa", () => {
  it("không cảnh báo kịch bản gọn gàng", () => {
    const report = analyseCrowding(TIGHT);
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it("cảnh báo nhân vật có mặt khắp nơi nhưng luôn im lặng", () => {
    const report = analyseCrowding(PADDED);
    expect(report.ok).toBe(false);
    expect(report.warnings.map((w) => w.character)).toEqual(["Mia"]);

    const mia = report.warnings[0]!;
    expect(mia.appearances).toBe(5);
    expect(mia.passive).toBe(5);
    expect(mia.message).toContain("5/5");
  });

  it("KHÔNG cảnh báo nhân vật im lặng nhưng chỉ xuất hiện đúng chỗ", () => {
    // Mia có mặt 1/5 cảnh: đó là dàn cảnh, không phải nhét thừa.
    const report = analyseCrowding(TIGHT);
    expect(report.warnings.map((w) => w.character)).not.toContain("Mia");
  });

  it("KHÔNG cảnh báo nhân vật có mặt khắp nơi nhưng có thoại", () => {
    const talkative = script([
      scene(1, ["Max", "Leo"], ["Max", "Leo"], ["Max"]),
      scene(2, ["Max", "Leo"], ["Leo"], ["Leo"]),
      scene(3, ["Max", "Leo"], ["Max", "Leo"], ["Max"]),
    ]);
    // Leo ở mọi cảnh nhưng nói ở mọi cảnh - đó là nhân vật chính, không phải độn.
    expect(analyseCrowding(talkative).ok).toBe(true);
  });

  it("KHÔNG cảnh báo nhân vật chỉ nói một lần trong nhiều cảnh", () => {
    // Ngưỡng theo tỷ lệ từng gắn cờ đúng trường hợp này: im lặng 4/5 cảnh vẫn
    // là 80%. Nhưng nói được một câu là có đóng góp thật, không phải độn.
    const quietLead = script([
      scene(1, ["Max", "Leo"], ["Max"], ["Max"]),
      scene(2, ["Max", "Leo"], ["Max"], ["Max"]),
      scene(3, ["Max", "Leo"], ["Leo"], ["Leo"]),
      scene(4, ["Max", "Leo"], ["Max"], ["Max"]),
      scene(5, ["Max", "Leo"], ["Max"], ["Max"]),
    ]);
    expect(analyseCrowding(quietLead).warnings).toEqual([]);
  });

  it("đếm đúng cảnh đông và số nhân vật trung bình", () => {
    const padded = analyseCrowding(PADDED);
    expect(padded.crowdedScenes).toEqual([1, 2, 3, 4, 5]);
    expect(padded.averageCast).toBe(3);

    const tight = analyseCrowding(TIGHT);
    expect(tight.crowdedScenes).toEqual([4]);
    expect(tight.averageCast).toBeLessThanOrEqual(COMFORTABLE_CAST);
  });

  it("giữ đúng cách viết hoa tên như trong kịch bản", () => {
    const mixed = script([
      scene(1, ["Max", "mia"], ["Max"], ["Max"]),
      scene(2, ["Max", "MIA"], ["Max"], ["Max"]),
    ]);
    // Gộp theo tên không phân biệt hoa thường, nhưng báo cáo theo cách viết đầu.
    const report = analyseCrowding(mixed);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]?.character).toBe("mia");
    expect(report.warnings[0]?.appearances).toBe(2);
  });
});

describe("quy tắc đã nằm trong prompt gửi cho Text AI", () => {
  it("prompt yêu cầu không nhét nhân vật thừa", async () => {
    const { readFileSync } = await import("node:fs");
    const template = readFileSync("prompts/script.txt", "utf8");

    expect(template).toContain("Include a character only when the scene genuinely needs them");
    expect(template).toContain("Two characters");
    expect(template).toContain("each extra character costs another reference image");
  });

  it("prompt vẫn giữ nguyên quy tắc liệt kê đủ người trong khung hình", async () => {
    const { readFileSync } = await import("node:fs");
    const template = readFileSync("prompts/script.txt", "utf8");
    // Hai quy tắc phải cùng tồn tại: liệt kê đủ người CÓ MẶT, nhưng đừng thêm
    // người không cần. Mất một trong hai là quay lại lỗi cũ hoặc sinh lỗi mới.
    expect(template).toContain("EVERY character visible anywhere in the frame");
    expect(template).toContain("Do NOT list only the characters who speak");
  });
});
