import { describe, expect, it } from "vitest";
import { MAX_SLUG_LENGTH, safeSlug, suggestBatchName, uniqueSlug } from "@/domain/output-naming";
import {
  BUILT_IN_PRESETS,
  DEFAULT_PRESET_ID,
  aspectWarning,
  exportsSrt,
  presetRender,
  resolvePreset,
  validateCustomPreset,
} from "@/domain/output-preset";
import { friendlyStatus, batchWorkflowStep } from "@/domain/friendly-status";
import { friendlyError } from "@/domain/user-errors";
import { costClass, isZeroCost, orderForRun } from "@/domain/queue-order";
import { checkSubtitleSafeArea } from "@/domain/safe-area";
import { buildSocialMeta, normalizeHashtags, renderTemplate, splitList, DEFAULT_SOCIAL_TEMPLATES } from "@/domain/social-metadata";
import { REPORT_COLUMNS, toCsv, type ReportRow } from "@/services/export-report";
import { renderSettingsFrom } from "@/services/output-layout";
import { wrapSubtitle } from "@/media/subtitles";
import { mapPool, withSemaphore, semaphoreActive } from "@/lib/semaphore";

/** V1.2 Phase 6 (QĐ-114): the pure rules of the daily workflow. No DB, no FFmpeg. */

describe("output-path: slug an toàn cho Windows", () => {
  it("tiếng Việt có dấu -> không dấu, đ -> d", () => {
    expect(safeSlug("5 công cụ AI hữu ích")).toBe("5-cong-cu-ai-huu-ich");
    expect(safeSlug("Đường đến thành công")).toBe("duong-den-thanh-cong");
  });
  it("emoji và ký tự đặc biệt bị bỏ; không còn gì -> 'video'", () => {
    expect(safeSlug("🔥 Top 3 mẹo 😎 !!!")).toBe("top-3-meo");
    expect(safeSlug('a<b>c:d"e/f\\g|h?i*j')).toBe("a-b-c-d-e-f-g-h-i-j");
    expect(safeSlug("🔥🔥🔥")).toBe("video");
    expect(safeSlug("...   ")).toBe("video");
  });
  it("tên thiết bị Windows (CON, NUL, COM1) không bao giờ là tên thư mục", () => {
    expect(safeSlug("CON")).toBe("con-video");
    expect(safeSlug("nul")).toBe("nul-video");
    expect(safeSlug("com1")).toBe("com1-video");
  });
  it("tên rất dài bị cắt ở ranh giới từ, không kết thúc bằng '-'", () => {
    const long = "Một tiêu đề rất rất dài ".repeat(20);
    const s = safeSlug(long);
    expect(s.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(s.endsWith("-")).toBe(false);
    expect(s.startsWith("mot-tieu-de-rat-rat-dai")).toBe(true);
  });
  it("trùng tên -> -2, -3; không vượt giới hạn độ dài", () => {
    expect(uniqueSlug("a", [])).toBe("a");
    expect(uniqueSlug("a", ["a"])).toBe("a-2");
    expect(uniqueSlug("a", ["a", "A-2"])).toBe("a-3");
    const base = "x".repeat(MAX_SLUG_LENGTH);
    const next = uniqueSlug(base, [base]);
    expect(next.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(next.endsWith("-2")).toBe(true);
  });
});

describe("tên lô đề xuất", () => {
  const day = new Date(2026, 8, 28, 10, 0, 0);
  it("một video -> tiêu đề + ngày", () => {
    expect(suggestBatchName(["Break the ice"], day)).toBe("Break the ice - 2026-09-28");
  });
  it("chủ đề chung của các tiêu đề", () => {
    expect(suggestBatchName(["5 AI tools for work", "AI tools for students", "Best AI tools 2026"], day)).toBe("AI Tools - 2026-09-28");
  });
  it("không có chủ đề chung -> tiêu đề đầu + số video còn lại; không bao giờ UUID", () => {
    const name = suggestBatchName(["Cold feet", "Piece of cake", "Break a leg"], day);
    expect(name).toBe("Cold feet + 2 video - 2026-09-28");
    expect(name).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
  it("không có tiêu đề -> tên chung có ngày", () => {
    expect(suggestBatchName([], day)).toBe("Lô video - 2026-09-28");
  });
});

describe("preset", () => {
  it("YouTube Shorts mặc định = đúng render V1: không encode riêng, burn phụ đề, 1080x1920@30", () => {
    const shorts = BUILT_IN_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!;
    const r = presetRender(shorts);
    expect(r).toEqual({ target: { width: 1080, height: 1920, fps: 30 }, burnSubtitles: true });
    expect(exportsSrt(shorts)).toBe(true);
  });
  it("bốn preset có sẵn đúng thông số", () => {
    const byId = Object.fromEntries(BUILT_IN_PRESETS.map((p) => [p.id, p]));
    expect(byId["tiktok"]!.width).toBe(1080);
    expect(byId["instagram-reels"]!.height).toBe(1920);
    expect(byId["youtube-landscape"]!.width).toBe(1920);
    expect(byId["youtube-landscape"]!.height).toBe(1080);
    for (const p of BUILT_IN_PRESETS) {
      expect(p.videoCodec).toBe("h264");
      expect(p.audioCodec).toBe("aac");
      expect(p.fps).toBe(30);
    }
  });
  it("preset tuỳ chỉnh: hợp lệ; id có sẵn, số lẻ, codec lạ bị từ chối", () => {
    const base = {
      id: "shorts-hq",
      name: "Shorts HQ",
      platform: "CUSTOM",
      width: 1080,
      height: 1920,
      fps: 60,
      videoCodec: "h264",
      quality: "HIGH",
      audioCodec: "aac",
      audioBitrateKbps: 256,
      subtitleMode: "SRT",
      thumbnail: true,
      metadata: true,
      textFiles: false,
    };
    const ok = validateCustomPreset(base);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(presetRender(ok.preset)).toEqual({
        target: { width: 1080, height: 1920, fps: 60 },
        burnSubtitles: false,
        encode: { crf: 18, audioBitrateKbps: 256 },
      });
    }
    expect(validateCustomPreset({ ...base, id: "tiktok" }).ok).toBe(false);
    expect(validateCustomPreset({ ...base, width: 1081 }).ok).toBe(false);
    expect(validateCustomPreset({ ...base, videoCodec: "hevc" }).ok).toBe(false);
    expect(validateCustomPreset({ ...base, id: "Bad Id" }).ok).toBe(false);
  });
  it("preset không tồn tại -> mặc định; khác khung -> cảnh báo cắt khung, không tạo lại ảnh", () => {
    expect(resolvePreset("khong-co", null, []).id).toBe(DEFAULT_PRESET_ID);
    const land = BUILT_IN_PRESETS.find((p) => p.id === "youtube-landscape")!;
    expect(aspectWarning(land, "9:16")).toMatch(/cắt/);
    expect(aspectWarning(land, "16:9")).toBeNull();
  });
  it("renderSettingsFrom: không chọn preset + video 16:9 -> giữ khung của video (V1), không ép 9:16", () => {
    const s = renderSettingsFrom({ aspectRatio: "16:9" }, "", { defaultOutputPresetId: DEFAULT_PRESET_ID, customPresets: [], burnSubtitles: true });
    expect(s.render.target).toEqual({ width: 1920, height: 1080, fps: 30 });
    const off = renderSettingsFrom({ aspectRatio: "9:16" }, "", { defaultOutputPresetId: DEFAULT_PRESET_ID, customPresets: [], burnSubtitles: false });
    expect(off.render.burnSubtitles).toBe(false);
    const explicit = renderSettingsFrom({ aspectRatio: "9:16" }, "youtube-landscape", { defaultOutputPresetId: DEFAULT_PRESET_ID, customPresets: [], burnSubtitles: true });
    expect(explicit.render.target).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(explicit.aspectNote).toMatch(/cắt/);
  });
});

describe("trạng thái thân thiện", () => {
  it("9 chữ, không enum nội bộ", () => {
    expect(friendlyStatus({ lifecycle: "DRAFT" })).toBe("NHÁP");
    expect(friendlyStatus({ lifecycle: "PREFLIGHT" })).toBe("CẦN KIỂM TRA");
    expect(friendlyStatus({ lifecycle: "READY" })).toBe("SẴN SÀNG");
    expect(friendlyStatus({ lifecycle: "APPROVED" })).toBe("ĐANG CHỜ");
    expect(friendlyStatus({ lifecycle: "RUNNING" })).toBe("ĐANG TẠO");
    expect(friendlyStatus({ lifecycle: "RENDERING" })).toBe("ĐANG RENDER");
    expect(friendlyStatus({ lifecycle: "COMPLETED" })).toBe("HOÀN THÀNH");
    expect(friendlyStatus({ lifecycle: "FAILED" })).toBe("CẦN XỬ LÝ");
    expect(friendlyStatus({ lifecycle: "NEEDS_RECOVERY" })).toBe("CẦN XỬ LÝ");
    expect(friendlyStatus({ lifecycle: "BLOCKED" })).toBe("BỊ CHẶN");
    expect(friendlyStatus({ lifecycle: "BLOCKED", invalidVoice: true })).toBe("CẦN XỬ LÝ");
    expect(friendlyStatus({ lifecycle: "COMPLETED", invalidVoice: true })).toBe("CẦN XỬ LÝ");
    expect(friendlyStatus({ lifecycle: "RUNNING", invalidVoice: true })).toBe("ĐANG TẠO");
    expect(friendlyStatus({ lifecycle: "FAILED", interrupted: true })).toBe("CẦN XỬ LÝ");
  });
  it("bước workflow của lô", () => {
    const base = { videos: 3, priced: true, approved: false, running: 0, rendering: 0, completed: 0, exported: 0 };
    expect(batchWorkflowStep({ ...base, videos: 0 })).toBe("IMPORT");
    expect(batchWorkflowStep({ ...base, priced: false })).toBe("REVIEW");
    expect(batchWorkflowStep(base)).toBe("PREFLIGHT");
    expect(batchWorkflowStep({ ...base, approved: true })).toBe("QUEUE");
    expect(batchWorkflowStep({ ...base, approved: true, running: 1 })).toBe("GENERATE");
    expect(batchWorkflowStep({ ...base, approved: true, rendering: 1 })).toBe("RENDER");
    expect(batchWorkflowStep({ ...base, approved: true, completed: 2, exported: 2 })).toBe("EXPORT");
  });
});

describe("lỗi cho người dùng", () => {
  it("mã lý do -> câu tiếng Việt, giữ chi tiết kỹ thuật", () => {
    const e = friendlyError("VIDEO_LIMIT_EXCEEDED: Video A vượt giới hạn video $0.10 — dự toán $0.50, giới hạn $0.40.");
    expect(e?.title).toBe("Vượt giới hạn chi phí video");
    expect(e?.detail).toContain("$0.50");
    expect(friendlyError("BLOCKED: MISSING_LOCAL_FILE: scene-02.png")?.title).toBe("Thiếu file nguồn");
    expect(friendlyError("APPROVED_MODEL_UNAVAILABLE: runway/gen4 không khả dụng")?.title).toBe("Model đã duyệt hiện không khả dụng");
    expect(friendlyError("NEEDS_RECOVERY: 1 yêu cầu")?.title).toBe("Cần kiểm tra trạng thái yêu cầu trước đó");
    const voice = friendlyError("INVALID_VOICE_ASSET: 2 file giọng hỏng");
    expect(voice?.title).toBe("Cần tạo lại giọng — có thể phát sinh chi phí");
    expect(voice?.mayCost).toBe(true);
    expect(friendlyError("render: ffmpeg exited 1")?.code).toBe("RENDER_FAILED");
    expect(friendlyError("một lỗi lạ chưa có mã")?.code).toBe("UNKNOWN");
    expect(friendlyError(null)).toBeNull();
  });
});

describe("thứ tự hàng đợi", () => {
  const z = { buyImages: 0, buyVideos: 0, buyVoices: 0, localMotion: 0, incrementalCost: 0 };
  it("FREE < LOCAL < PAID_LIGHT < PAID_VIDEO; hoà thì giữ thứ tự nhập", () => {
    expect(costClass(z)).toBe("FREE");
    expect(costClass({ ...z, localMotion: 3 })).toBe("LOCAL");
    expect(costClass({ ...z, buyVoices: 1, incrementalCost: 0.01 })).toBe("PAID_LIGHT");
    expect(costClass({ ...z, buyImages: 1, buyVideos: 1 })).toBe("PAID_VIDEO");
    expect(isZeroCost({ ...z, localMotion: 2 })).toBe(true);
    expect(isZeroCost({ ...z, buyImages: 1 })).toBe(false);
    const ordered = orderForRun([
      { order: 0, cls: "PAID_VIDEO" as const },
      { order: 1, cls: "FREE" as const },
      { order: 2, cls: "PAID_LIGHT" as const },
      { order: 3, cls: "LOCAL" as const },
      { order: 4, cls: "FREE" as const },
    ]);
    expect(ordered.map((o) => o.order)).toEqual([1, 4, 3, 2, 0]);
  });
});

describe("vùng an toàn Shorts", () => {
  it("phụ đề ngắn: không cảnh báo dưới/trên; dòng dài chạm vùng nút bên phải", () => {
    const short = checkSubtitleSafeArea({ platform: "YOUTUBE_SHORTS", width: 1080, height: 1920, subtitles: ["Hi!"], burnt: true, wrap: wrapSubtitle });
    expect(short.filter((w) => w.zone !== "right")).toEqual([]);
    const long = checkSubtitleSafeArea({
      platform: "TIKTOK",
      width: 1080,
      height: 1920,
      subtitles: ["This is a very long subtitle line that keeps going"],
      burnt: true,
      wrap: wrapSubtitle,
    });
    expect(long.some((w) => w.zone === "right")).toBe(true);
  });
  it("không in phụ đề / video ngang -> không cảnh báo", () => {
    expect(checkSubtitleSafeArea({ platform: "YOUTUBE_SHORTS", width: 1080, height: 1920, subtitles: ["x".repeat(40)], burnt: false, wrap: wrapSubtitle })).toEqual([]);
    expect(checkSubtitleSafeArea({ platform: "YOUTUBE", width: 1920, height: 1080, subtitles: ["x".repeat(40)], burnt: true, wrap: wrapSubtitle })).toEqual([]);
  });
});

describe("metadata đăng bài", () => {
  it("hashtag chuẩn hoá, trùng bị bỏ; mẫu thay biến, biến lạ để nguyên", () => {
    expect(normalizeHashtags(["#AI tools", "ai-tools", "#AItools", " #x ", "", "#"])).toEqual(["#AItools", "#x"]);
    expect(renderTemplate("{{title}} | {{nope}}", { title: "A" })).toBe("A | {{nope}}");
    expect(splitList("a, b;c\n d")).toEqual(["a", "b", "c", "d"]);
  });
  it("người nhập thắng từng trường; trống -> theo mẫu", () => {
    const meta = buildSocialMeta({
      title: "Break the ice",
      summary: "Làm quen",
      input: { hashtags: ["#shorts", "english"] },
      templates: DEFAULT_SOCIAL_TEMPLATES,
    });
    expect(meta.title).toBe("Break the ice");
    expect(meta.description).toBe("Làm quen\n\n#shorts #english");
    const own = buildSocialMeta({ title: "T", summary: "S", input: { title: "Của tôi", description: "Mô tả" }, templates: DEFAULT_SOCIAL_TEMPLATES });
    expect(own.title).toBe("Của tôi");
    expect(own.description).toBe("Mô tả");
  });
});

describe("báo cáo CSV", () => {
  it("đủ cột, UTF-8 BOM, thoát dấu phẩy/ngoặc kép, chặn công thức Excel", () => {
    const row = Object.fromEntries(REPORT_COLUMNS.map((c) => [c, ""])) as ReportRow;
    const csv = toCsv([{ ...row, title: 'Cà phê, "đá"', error_reason: "=HYPERLINK(1)", cost: 0.4, duration: -1 }]);
    expect(csv.startsWith("﻿" + REPORT_COLUMNS.join(","))).toBe(true);
    expect(csv).toContain('"Cà phê, ""đá"""');
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toContain(",-1,");
  });
});

describe("semaphore / pool", () => {
  it("không vượt giới hạn; lỗi của một việc không bỏ rơi việc khác", async () => {
    let peak = 0;
    const results = await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) =>
      withSemaphore("t-pool", 2, async () => {
        peak = Math.max(peak, semaphoreActive("t-pool"));
        await new Promise((r) => setTimeout(r, 5));
        if (n === 3) throw new Error("hỏng 3");
        return n * 10;
      }),
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(results.filter((r) => r.ok).length).toBe(5);
    expect(results[2]!.ok).toBe(false);
    expect(semaphoreActive("t-pool")).toBe(0);
  });
});
