import { describe, expect, it } from "vitest";
import {
  CONTENT_CATEGORIES,
  CONTENT_TEMPLATES,
  formatOf,
  templateOf,
  templateIdFor,
  validateRegistry,
} from "@/domain/content-templates";
import { LANGUAGES, audienceOf, clampDuration, languageOf } from "@/domain/content-options";
import { planScenes, sceneCountFor } from "@/domain/scene-planner";
import { needsScriptApproval, projectContent } from "@/domain/content-legacy";

/**
 * Multi-content engine, Phase A: one template registry, a scene planner that
 * does not force six scenes on every video, and legacy projects that read as
 * the English idiom videos they always were.
 */

describe("CONTENT TEMPLATE REGISTRY", () => {
  it("không có lỗi cấu hình; mỗi loại video trên màn hình có template", () => {
    expect(validateRegistry()).toEqual([]);
    expect(CONTENT_CATEGORIES.map((c) => c.id)).toEqual([
      "ENGLISH", "PRODUCT", "AI", "TOYS", "ANIMALS", "STORY", "KNOWLEDGE", "ADS", "CUSTOM",
    ]);
  });

  it("mỗi template có đủ trường bắt buộc và phiên bản prompt", () => {
    for (const t of CONTENT_TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.defaultDuration).toBeGreaterThan(0);
      expect(t.promptVersion).toMatch(/-v\d+$/);
      expect(Array.isArray(t.sceneRules)).toBe(true);
      expect(Array.isArray(t.safetyRules)).toBe(true);
      expect(audienceOf(t.defaultAudience).id).toBe(t.defaultAudience);
      expect(languageOf(t.defaultLanguage).code).toBe(t.defaultLanguage);
    }
  });

  it("Thành ngữ là một template trong HỌC TIẾNG ANH, dùng đúng bộ viết cũ", () => {
    const idiom = templateOf("ENGLISH_IDIOM");
    expect(idiom.category).toBe("ENGLISH");
    expect(idiom.engine).toBe("LEGACY_IDIOM");
    expect(CONTENT_TEMPLATES.filter((t) => t.engine === "LEGACY_IDIOM").map((t) => t.id)).toEqual(["ENGLISH_IDIOM"]);
  });

  it("Review sản phẩm có cấu trúc mặc định + 9 dạng review và cấm nói như đã tự dùng", () => {
    const p = templateOf("PRODUCT_REVIEW");
    // The default structure + the nine review formats of the brief.
    expect(p.formats.map((f) => f.id)).toEqual([
      "standard", "quick", "three-reasons", "problem-solution", "how-to", "pros-cons", "compare", "top-list", "affiliate", "showcase",
    ]);
    expect(p.factual).toBe(true);
    expect(p.safetyRules.join(" ")).toMatch(/pretend to have personally used/);
    expect(templateIdFor(p, formatOf(p, "pros-cons"))).toBe("PRODUCT_REVIEW:pros-cons");
  });

  it("ngôn ngữ tách khỏi loại nội dung; thêm ngôn ngữ mới = thêm một dòng", () => {
    expect(LANGUAGES.filter((l) => l.enabled).map((l) => l.code)).toEqual(["vi", "en", "vi-en", "auto"]);
    expect(LANGUAGES.map((l) => l.code)).toEqual(expect.arrayContaining(["zh", "ja", "ko"]));
  });
});

describe("SCENE PLANNER", () => {
  it("số cảnh theo thời lượng (heuristic), không ép 6 cảnh", () => {
    const n15 = sceneCountFor(15, "GENERAL");
    const n30 = sceneCountFor(30, "GENERAL");
    const n60 = sceneCountFor(60, "GENERAL");
    expect(n15).toBeGreaterThanOrEqual(3);
    expect(n15).toBeLessThanOrEqual(4);
    expect(n30).toBeGreaterThanOrEqual(5);
    expect(n30).toBeLessThanOrEqual(7);
    expect(n60).toBeGreaterThanOrEqual(8);
    expect(n60).toBeLessThanOrEqual(12);
  });

  it("trẻ em: cảnh dài và chậm hơn người lớn", () => {
    expect(sceneCountFor(60, "KIDS")).toBeLessThanOrEqual(sceneCountFor(60, "ADULTS"));
    expect(audienceOf("KIDS").maxSentenceWords).toBeLessThan(audienceOf("ADULTS").maxSentenceWords);
  });

  it("lặp beat 'Điểm nổi bật' khi video dài, bỏ beat tuỳ chọn khi video ngắn", () => {
    const product = templateOf("PRODUCT_REVIEW");
    const long = planScenes({ format: formatOf(product, "standard"), durationSeconds: 60, audience: "ADULTS" });
    expect(long.filter((b) => b.role === "feature").length).toBeGreaterThanOrEqual(2);
    expect(long[0]!.role).toBe("hook");
    const short = planScenes({ format: formatOf(product, "standard"), durationSeconds: 15, audience: "ADULTS" });
    expect(short.length).toBeLessThanOrEqual(4);
    expect(short.some((b) => b.role === "cta")).toBe(false);
    for (const b of [...long, ...short]) {
      expect(b.durationSeconds).toBeGreaterThanOrEqual(2);
      expect(b.durationSeconds).toBeLessThanOrEqual(6);
    }
    expect(long.map((b) => b.index)).toEqual(long.map((_, i) => i + 1));
  });

  it("thời lượng tuỳ chỉnh được kẹp trong giới hạn", () => {
    expect(clampDuration(3)).toBe(10);
    expect(clampDuration(999)).toBe(180);
    expect(clampDuration(42.4)).toBe(42);
  });
});

describe("LEGACY PROJECTS", () => {
  it("project cũ (mọi cột mới NULL) đọc là ENGLISH_IDIOM, không cần DUYỆT KỊCH BẢN", () => {
    const old = { contentType: null, contentTemplateId: null, templateVersion: null, language: "en" };
    const c = projectContent(old);
    expect(c.contentType).toBe("ENGLISH_IDIOM");
    expect(c.legacy).toBe(true);
    expect(c.template.engine).toBe("LEGACY_IDIOM");
    expect(c.templateVersion).toBe("idiom-v1");
    expect(needsScriptApproval(old)).toBe(false);
  });

  it("project mới cần duyệt kịch bản trước media; storyboard nhập thì không", () => {
    const fresh = { contentType: "PRODUCT_REVIEW", contentSourceType: "PROMPT", scriptApprovedAt: null };
    expect(needsScriptApproval(fresh)).toBe(true);
    expect(needsScriptApproval({ ...fresh, scriptApprovedAt: new Date() })).toBe(false);
    expect(needsScriptApproval({ ...fresh, contentSourceType: "STORYBOARD" })).toBe(false);
  });

  it("giá trị lạ trong DB không làm vỡ trang (rơi về mặc định an toàn)", () => {
    const c = projectContent({ contentType: "NOT_A_TYPE", audience: "???", tone: "???" });
    expect(c.contentType).toBe("ENGLISH_IDIOM");
    expect(c.audience).toBe("GENERAL");
    expect(c.tone).toBe("AUTO");
  });
});
