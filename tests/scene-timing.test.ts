import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMING,
  estimateVoiceDuration,
  pacingSummary,
  parseDurationMode,
  resolveSceneDuration,
  resolveVideoTiming,
} from "@/domain/scene-timing";
import { buildSceneTimeline } from "@/domain/scene-timeline";
import { cuesFromTimelines } from "@/media/subtitles";
import { parseStoryboardCsv, parseStoryboardJson } from "@/domain/storyboard";

/**
 * Voice-aware scene timing - the pure rules (V1.2 Phase 1). $0: no file, no
 * database, no provider. Cases A-I and G of the spec; E-H are proven again on
 * real FFmpeg renders in voice-timing.e2e.test.ts.
 */

const PAD = DEFAULT_TIMING.voicePaddingBefore + DEFAULT_TIMING.voicePaddingAfter; // 0.5

describe("resolveSceneDuration — chế độ thời lượng", () => {
  it("A. dự kiến 5s, lời 2s, AUTO -> ~2.5s (lời + đệm)", () => {
    const t = resolveSceneDuration({ sceneNumber: 1, plannedDuration: 5, voiceDuration: 2, motion: "LOCAL_MOTION" });
    expect(t.finalDuration).toBeCloseTo(2 + PAD, 3);
    expect(t.timingReason).toBe("VOICE_PADDED");
    expect(t.leadInSec).toBe(DEFAULT_TIMING.voicePaddingBefore);
    expect(t.change).toBe("RENDER_ONLY_CHANGE");
  });

  it("B. dự kiến 3s, lời 4s, AUTO -> >= 4s + đệm", () => {
    const t = resolveSceneDuration({ sceneNumber: 2, plannedDuration: 3, voiceDuration: 4, motion: "LOCAL_MOTION" });
    expect(t.finalDuration).toBeGreaterThanOrEqual(4 + PAD - 1e-9);
  });

  it("C. dự kiến 5s, lời 2s, MINIMUM -> >= 5s", () => {
    const t = resolveSceneDuration({ sceneNumber: 3, plannedDuration: 5, voiceDuration: 2, durationMode: "MINIMUM", motion: "LOCAL_MOTION" });
    expect(t.finalDuration).toBe(5);
    expect(t.timingReason).toBe("MINIMUM_PLANNED");
  });

  it("D. dự kiến 3s, lời 4s, LOCKED -> không cắt lời (nâng cho đủ, có cảnh báo)", () => {
    const t = resolveSceneDuration({ sceneNumber: 4, plannedDuration: 3, voiceDuration: 4, durationMode: "LOCKED", motion: "LOCAL_MOTION" });
    expect(t.finalDuration).toBeGreaterThanOrEqual(4 + t.leadInSec);
    expect(t.timingReason).toBe("LOCKED_RAISED_FOR_VOICE");
    expect(t.warnings.join(" ")).toContain("không cắt lời");
    // LOCKED and the voice fits: planned is kept exactly.
    const kept = resolveSceneDuration({ sceneNumber: 4, plannedDuration: 5, voiceDuration: 2, durationMode: "LOCKED", motion: "LOCAL_MOTION" });
    expect(kept.finalDuration).toBe(5);
    expect(kept.timingReason).toBe("LOCKED_PLANNED");
  });

  it("AUTO: lời rất ngắn không kéo cảnh xuống dưới tối thiểu; max của storyboard không cắt lời", () => {
    const short = resolveSceneDuration({ sceneNumber: 1, plannedDuration: 5, voiceDuration: 0.5, motion: "LOCAL_MOTION" });
    expect(short.finalDuration).toBe(DEFAULT_TIMING.minSceneDuration);
    expect(short.timingReason).toBe("VOICE_PADDED_MIN_CLAMP");
    const capped = resolveSceneDuration({ sceneNumber: 1, plannedDuration: 5, voiceDuration: 6, maxDuration: 4, motion: "LOCAL_MOTION" });
    expect(capped.finalDuration).toBeCloseTo(6 + PAD, 3);
    expect(capped.timingReason).toBe("VOICE_EXCEEDS_MAX");
    const floored = resolveSceneDuration({ sceneNumber: 1, plannedDuration: 5, voiceDuration: 1.2, minDuration: 3, motion: "LOCAL_MOTION" });
    expect(floored.finalDuration).toBe(3);
  });
});

describe("VIDEO_AI — clip đã mua là cố định", () => {
  it("E. clip 5s, cần 3s -> cắt tại máy, không cần clip mới", () => {
    const t = resolveSceneDuration({ sceneNumber: 1, plannedDuration: 5, voiceDuration: 2.5, motion: "VIDEO_AI", clipDuration: 5 });
    expect(t.finalDuration).toBeCloseTo(3, 3);
    expect(t.trimmedSec).toBeCloseTo(2, 3);
    expect(t.timingReason).toBe("CLIP_TRIMMED_LOCAL");
    expect(t.blocked).toBe(false);
    expect(t.change).toBe("RENDER_ONLY_CHANGE");
  });

  it("F. clip 5s, lời cần 5.6s -> giữ khung cuối trong ngưỡng 1s", () => {
    const t = resolveSceneDuration({ sceneNumber: 2, plannedDuration: 5, voiceDuration: 5.1, motion: "VIDEO_AI", clipDuration: 5 });
    expect(t.blocked).toBe(false);
    expect(t.timingReason).toBe("CLIP_FREEZE_EXTENDED");
    expect(t.freezeSec).toBeGreaterThan(0);
    expect(t.freezeSec).toBeLessThanOrEqual(DEFAULT_TIMING.maxFreezeExtension);
    expect(t.finalDuration).toBeGreaterThanOrEqual(5.1 + t.leadInSec);
  });

  it("F'. clip 5s, lời vừa đủ khi giảm đệm -> vừa clip, không giữ khung", () => {
    const t = resolveSceneDuration({ sceneNumber: 2, plannedDuration: 5, voiceDuration: 4.8, motion: "VIDEO_AI", clipDuration: 5 });
    expect(t.timingReason).toBe("CLIP_FIT_REDUCED_PADDING");
    expect(t.finalDuration).toBe(5);
    expect(t.freezeSec).toBe(0);
    expect(t.leadInSec + 4.8).toBeLessThanOrEqual(5);
  });

  it("G. clip 5s, lời cần 7s -> BLOCKED, MEDIA_REGEN_REQUIRED, không tự mua", () => {
    const t = resolveSceneDuration({ sceneNumber: 3, plannedDuration: 5, voiceDuration: 6.5, motion: "VIDEO_AI", clipDuration: 5 });
    expect(t.blocked).toBe(true);
    expect(t.timingReason).toBe("CLIP_TOO_SHORT_FOR_VOICE");
    expect(t.change).toBe("MEDIA_REGEN_REQUIRED");
    expect(t.message).toContain("KHÔNG tự mua");
    expect(resolveVideoTiming([{ sceneNumber: 3, plannedDuration: 5, voiceDuration: 6.5, motion: "VIDEO_AI", clipDuration: 5 }]).blocked).toHaveLength(1);
  });

  it("clip ngắn, KHÔNG có lời, dự kiến dài -> giữ khung tối đa 1s rồi dừng, không chặn", () => {
    const t = resolveSceneDuration({ sceneNumber: 4, plannedDuration: 8, voiceDuration: null, motion: "VIDEO_AI", clipDuration: 5 });
    expect(t.blocked).toBe(false);
    expect(t.finalDuration).toBe(6);
    expect(t.timingReason).toBe("CLIP_CAPPED_NO_VOICE");
  });

  it("không bao giờ làm chậm clip: chỉ có cắt và giữ khung", () => {
    const t = resolveSceneDuration({ sceneNumber: 1, plannedDuration: 5, voiceDuration: 5.2, motion: "VIDEO_AI", clipDuration: 5 });
    expect(Object.keys(t)).not.toContain("speed");
    expect(t.freezeSec + 5).toBeCloseTo(t.finalDuration, 3);
  });
});

describe("cảnh không lời", () => {
  it("I. không lời -> giữ dự kiến; dưới mức tối thiểu hình ảnh thì nâng lên", () => {
    const keep = resolveSceneDuration({ sceneNumber: 4, plannedDuration: 5, voiceDuration: null, motion: "LOCAL_MOTION" });
    expect(keep.finalDuration).toBe(5);
    expect(keep.timingReason).toBe("NO_VOICE_PLANNED");
    const raise = resolveSceneDuration({ sceneNumber: 4, plannedDuration: 1, voiceDuration: 0, motion: "LOCAL_MOTION" });
    expect(raise.finalDuration).toBe(DEFAULT_TIMING.minLocalMotionDuration);
    const still = resolveSceneDuration({ sceneNumber: 4, plannedDuration: 1, voiceDuration: null, motion: "STATIC" });
    expect(still.finalDuration).toBe(DEFAULT_TIMING.minStaticDuration);
    expect(keep.leadInSec).toBe(0);
  });

  it("LOCAL_MOTION rất dài -> cảnh báo đơn điệu", () => {
    const t = resolveSceneDuration({ sceneNumber: 1, plannedDuration: 9, voiceDuration: null, motion: "LOCAL_MOTION" });
    expect(t.warnings.join(" ")).toContain("đơn điệu");
  });
});

describe("tiện ích", () => {
  it("parseDurationMode: lạ -> AUTO; estimate chỉ dùng cho preflight", () => {
    expect(parseDurationMode("minimum")).toBe("MINIMUM");
    expect(parseDurationMode("xx")).toBe("AUTO");
    expect(parseDurationMode(null)).toBe("AUTO");
    expect(estimateVoiceDuration("")).toBe(0);
    expect(estimateVoiceDuration("one two three four five six")).toBeCloseTo(6 / 2.6, 2);
  });

  it("pacingSummary chỉ nói khi thay đổi đáng kể", () => {
    expect(pacingSummary(26, 21.8)).toBe("Đã tối ưu nhịp: 26s → 21.8s");
    expect(pacingSummary(10, 10.2)).toBeNull();
  });
});

describe("K. timeline + phụ đề theo nhịp cuối", () => {
  it("lời bắt đầu sau đệm trước; phụ đề nằm gọn trong cảnh; không chồng nhau", () => {
    const line = (n: number, d: number) => ({ lineNumber: n, speaker: "Max", text: `line ${n}`, audioPath: "x.wav", durationSec: d });
    const t1 = resolveSceneDuration({ sceneNumber: 1, plannedDuration: 5, voiceDuration: 2, motion: "LOCAL_MOTION" });
    const tl1 = buildSceneTimeline([line(1, 2)], t1.finalDuration, { leadInSec: t1.leadInSec });
    expect(tl1.entries[0]!.startSec).toBe(0.15);
    expect(tl1.entries[0]!.endSec).toBe(2.15);
    expect(tl1.sceneDurationSec).toBeCloseTo(2.5, 3);
    const t2 = resolveSceneDuration({ sceneNumber: 2, plannedDuration: 5, voiceDuration: 3, motion: "LOCAL_MOTION" });
    const tl2 = buildSceneTimeline([line(1, 3)], t2.finalDuration, { leadInSec: t2.leadInSec });
    const cues = cuesFromTimelines([tl1, tl2]);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.startSeconds).toBeCloseTo(0.15, 3);
    expect(cues[0]!.endSeconds).toBeLessThanOrEqual(tl1.sceneDurationSec);
    expect(cues[1]!.startSeconds).toBeGreaterThanOrEqual(tl1.sceneDurationSec);
    expect(cues[1]!.endSeconds).toBeLessThanOrEqual(tl1.sceneDurationSec + tl2.sceneDurationSec);
    expect(cues[1]!.startSeconds).toBeGreaterThan(cues[0]!.endSeconds);
  });

  it("phụ đề không bao giờ vượt khỏi cảnh, kể cả khi dòng chạm cuối cảnh", () => {
    const cues = cuesFromTimelines([
      { entries: [{ startSec: 0, endSec: 3, text: "hết cảnh" }], sceneDurationSec: 3 },
      { entries: [{ startSec: 0.1, endSec: 1, text: "tiếp" }], sceneDurationSec: 2 },
    ]);
    expect(cues[0]!.endSeconds).toBeLessThanOrEqual(3);
    expect(cues[1]!.startSeconds).toBeGreaterThanOrEqual(3);
  });

  it("timeline cũ (không đệm) giữ nguyên hành vi", () => {
    const tl = buildSceneTimeline([{ lineNumber: 1, speaker: "A", text: "x", audioPath: "a", durationSec: 2 }], 5);
    expect(tl.entries[0]!.startSec).toBe(0);
    expect(tl.sceneDurationSec).toBe(5);
  });
});

describe("storyboard: duration_mode / min_duration / max_duration (tương thích ngược)", () => {
  const base = { scene_number: 1, duration: 5, visual_description: "x" };
  const CTX = { sourceFile: "a.json", fallbackVideoId: "v", fallbackVideoTitle: "V" };

  it("storyboard V1.1 không có trường mới -> AUTO, không giới hạn", () => {
    const r = parseStoryboardJson(JSON.stringify([base]), CTX);
    const s = r.videos[0]!.scenes[0]!;
    expect(s.durationMode).toBe("AUTO");
    expect(s.minDuration).toBeNull();
    expect(s.maxDuration).toBeNull();
  });

  it("đọc duration_mode (không phân biệt hoa thường) và giới hạn", () => {
    const r = parseStoryboardJson(
      JSON.stringify([{ ...base, duration_mode: "locked", min_duration: 2, max_duration: 6 }]),
      CTX,
    );
    const s = r.videos[0]!.scenes[0]!;
    expect(s.durationMode).toBe("LOCKED");
    expect(s.minDuration).toBe(2);
    expect(s.maxDuration).toBe(6);
  });

  it("CSV cũ (không cột mới) vẫn đọc được; CSV có cột duration_mode cũng đọc được", () => {
    const old = parseStoryboardCsv("scene_number,duration,visual_description\n1,5,a card\n", CTX);
    expect(old.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(old.videos[0]!.scenes[0]!.durationMode).toBe("AUTO");
    const neu = parseStoryboardCsv(
      "scene_number,duration,visual_description,duration_mode,min_duration,max_duration\n1,5,a card,MINIMUM,2,8\n",
      CTX,
    );
    const s = neu.videos[0]!.scenes[0]!;
    expect([s.durationMode, s.minDuration, s.maxDuration]).toEqual(["MINIMUM", 2, 8]);
  });

  it("giá trị sai bị từ chối có mã lỗi", () => {
    const bad = parseStoryboardJson(JSON.stringify([{ ...base, duration_mode: "FAST" }]), CTX);
    expect(bad.issues.map((i) => i.code)).toContain("duration_mode_invalid");
    const bounds = parseStoryboardJson(JSON.stringify([{ ...base, min_duration: 6, max_duration: 2 }]), CTX);
    expect(bounds.issues.map((i) => i.code)).toContain("duration_bounds_invalid");
  });
});
