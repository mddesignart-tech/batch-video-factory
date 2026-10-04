import { describe, expect, it } from "vitest";
import {
  MIN_AUTO_FIT_SCALE,
  OutputControlsSchema,
  SUBTITLE_FIT_RULES,
  controlsOf,
  fitCaption,
  platformSafeArea,
  subtitleLayout,
} from "@/domain/output-controls";
import { buildASS, buildSRT, fittedCues, type SubtitleCue } from "@/media/subtitles";
import { renderRecipeFields } from "@/services/render-recipe";
import type { RenderRequest } from "@/media/render";

/**
 * QĐ-126: one project, one subtitle size. "My socks?" and
 * `Max: "A little bird told me it is your birthday."` used to render at
 * visibly different sizes because auto-fit shrank every long caption on its
 * own (down to 80 %) before splitting it. Pure: no DB, no FFmpeg, no API.
 */

const base = OutputControlsSchema.parse({});
const A = "My socks?";
const B = "A little bird told me it is your birthday.";
const C = "This is a much longer sentence that certainly needs two lines or more to be shown on the screen, okay?";
const D = 'Max: "A little bird told me it is your birthday."';

const cues: SubtitleCue[] = [A, B, C, D].map((text, i) => ({ startSeconds: i * 4, endSeconds: i * 4 + 3.9, text }));

/** Font size of every Dialogue event in an ASS file (style size unless overridden). */
function eventSizes(ass: string): number[] {
  const styleSize = Number(ass.split("\n").find((l) => l.startsWith("Style: Default,"))!.split(",")[2]);
  return ass
    .split("\n")
    .filter((l) => l.startsWith("Dialogue:"))
    .map((l) => {
      const m = /\{\\fs(\d+)\}/.exec(l);
      return m ? Number(m[1]) : styleSize;
    });
}

describe("SUBTITLE CONSISTENCY (QĐ-126)", () => {
  for (const size of ["SMALL", "MEDIUM", "LARGE"] as const) {
    it(`${size}: câu ngắn giữ đúng cỡ gốc; câu dài/nhiều người nói ≥ 90% cỡ gốc, không bao giờ < ${MIN_AUTO_FIT_SCALE}`, () => {
      const layout = subtitleLayout({ ...base.subtitles, size }, 1080, 1920);
      expect(fitCaption(A, layout).fontSize).toBe(layout.fontSize);
      for (const t of [B, C, D]) {
        const fit = fitCaption(t, layout);
        expect(fit.fontSize).toBeGreaterThanOrEqual(Math.round(layout.fontSize * 0.9));
        expect(fit.screens.flat().join(" ")).toBe(t);
        expect(fit.screens.every((s) => s.length <= 2)).toBe(true);
      }
    });
  }

  it("câu dài: xuống 2 dòng ở cỡ gốc trước, rồi chia đoạn — không thu nhỏ để nhồi", () => {
    const layout = subtitleLayout(base.subtitles, 1080, 1920);
    const two = fitCaption("Leo: No, Max, it's an idiom.", layout);
    expect(two.fontSize).toBe(layout.fontSize);
    expect(two.screens).toHaveLength(1);
    expect(two.screens[0]).toHaveLength(2);
    const long = fitCaption(C, layout);
    expect(long.fontSize).toBe(layout.fontSize);
    expect(long.screens.length).toBeGreaterThan(1);
    // Lines are balanced, not "long line / one word".
    for (const s of long.screens) if (s.length === 2) expect(Math.min(s[0]!.length, s[1]!.length)).toBeGreaterThan(3);
  });

  it("auto-fit không bao giờ thu nhỏ dưới minAutoFitScale, kể cả một từ rất dài", () => {
    const layout = subtitleLayout({ ...base.subtitles, size: "LARGE" }, 1080, 1920);
    const fit = fitCaption("Supercalifragilisticexpialidocious-antidisestablishmentarianism!", layout);
    expect(fit.fontSize).toBe(Math.round(layout.fontSize * MIN_AUTO_FIT_SCALE));
    expect(layout.minFontSize).toBe(Math.round(layout.fontSize * MIN_AUTO_FIT_SCALE));
  });

  it("tự động vừa khung TẮT: mọi câu đúng cỡ gốc", () => {
    const layout = subtitleLayout({ ...base.subtitles, autoFit: false }, 1080, 1920);
    for (const t of [A, B, C, D]) expect(fitCaption(t, layout).fontSize).toBe(layout.fontSize);
  });

  it("nhãn người nói 'Max:' không làm câu nhỏ bất thường và không bị tách khỏi lời", () => {
    for (const size of ["MEDIUM", "LARGE"] as const) {
      const layout = subtitleLayout({ ...base.subtitles, size }, 1080, 1920);
      const withLabel = fitCaption(D, layout);
      const without = fitCaption(`"${B}"`, layout);
      expect(Math.abs(withLabel.fontSize - without.fontSize)).toBeLessThanOrEqual(Math.round(layout.fontSize * 0.1));
      expect(withLabel.screens[0]![0]!.startsWith("Max: ")).toBe(true);
    }
  });

  it("ASS cả video: một Style chung, mọi câu trong ±10% cỡ gốc; tối đa 2 dòng; SRT cùng số đoạn", () => {
    for (const [w, h] of [[1080, 1920], [1920, 1080], [1080, 1080], [1080, 1350]] as const) {
      const layout = subtitleLayout({ ...base.subtitles, size: "LARGE" }, w, h);
      const ass = buildASS(cues, { width: w, height: h, layout });
      expect(ass.split("\n").filter((l) => l.startsWith("Style:"))).toHaveLength(1);
      const sizes = eventSizes(ass);
      for (const s of sizes) {
        expect(s).toBeLessThanOrEqual(layout.fontSize);
        expect(s).toBeGreaterThanOrEqual(Math.round(layout.fontSize * 0.9));
      }
      for (const l of ass.split("\n").filter((x) => x.startsWith("Dialogue:"))) expect(l.split("\\N").length).toBeLessThanOrEqual(2);
      expect(buildSRT(cues, layout).split("\n\n").filter(Boolean).length).toBe(sizes.length);
    }
  });

  it("đổi cỡ dự án (Lớn) áp dụng cho toàn bộ câu; cỡ theo cạnh ngắn, không cố định pixel", () => {
    const medium = eventSizes(buildASS(cues, { width: 1080, height: 1920, layout: subtitleLayout(base.subtitles, 1080, 1920) }));
    const large = eventSizes(buildASS(cues, { width: 1080, height: 1920, layout: subtitleLayout({ ...base.subtitles, size: "LARGE" }, 1080, 1920) }));
    expect(Math.min(...large)).toBeGreaterThan(Math.max(...medium) * 0.95);
    // 720p and 1080p of the same shape scale together.
    expect(subtitleLayout(base.subtitles, 720, 1280).fontSize).toBe(Math.round(subtitleLayout(base.subtitles, 1080, 1920).fontSize * (720 / 1080)));
  });

  it("chia đoạn giữ đúng thời gian của câu (bám giọng): bắt đầu/kết thúc như cue gốc, liên tục", () => {
    const layout = subtitleLayout({ ...base.subtitles, size: "LARGE" }, 1080, 1920);
    const out = fittedCues([{ startSeconds: 2, endSeconds: 7, text: C }], layout);
    expect(out[0]!.startSeconds).toBe(2);
    expect(out.at(-1)!.endSeconds).toBe(7);
    for (let i = 1; i < out.length; i += 1) expect(out[i]!.startSeconds).toBeCloseTo(out[i - 1]!.endSeconds, 6);
  });

  it("vị trí: Trên / Giữa / Dưới; 9:16 và 16:9 luôn trong vùng an toàn nền tảng", () => {
    for (const [w, h] of [[1080, 1920], [1920, 1080]] as const) {
      const safe = platformSafeArea(w, h);
      const bottom = subtitleLayout(base.subtitles, w, h);
      const top = subtitleLayout({ ...base.subtitles, position: "TOP" }, w, h);
      const middle = subtitleLayout({ ...base.subtitles, position: "MIDDLE" }, w, h);
      expect([bottom.alignment, middle.alignment, top.alignment]).toEqual([2, 2, 8]);
      expect(middle.marginV).toBeGreaterThan(bottom.marginV);
      for (const offsetPct of [-20, 0, 20]) {
        expect(subtitleLayout({ ...base.subtitles, offsetPct }, w, h).marginV).toBeGreaterThanOrEqual(Math.round(safe.bottom * h));
        expect(subtitleLayout({ ...base.subtitles, position: "TOP", offsetPct }, w, h).marginV).toBeGreaterThanOrEqual(Math.round(safe.top * h));
      }
      expect(bottom.marginL).toBeGreaterThanOrEqual(Math.round(safe.left * w));
      expect(bottom.marginR).toBeGreaterThanOrEqual(Math.round(safe.right * w));
    }
    // 9:16: never at the very bottom (TikTok / Shorts / Reels caption + buttons).
    expect(subtitleLayout({ ...base.subtitles, offsetPct: -20 }, 1080, 1920).marginV).toBeGreaterThanOrEqual(1920 * 0.2 - 1);
  });

  it("dự án cũ: không có thiết lập → BẬT, Vừa, Dưới, 2 dòng, tự vừa khung; thiết lập cũ một phần vẫn kế thừa phần còn lại", () => {
    const legacy = controlsOf({ contentType: null, outputControlsJson: null }).subtitles;
    expect(legacy).toMatchObject({ enabled: true, size: "MEDIUM", position: "BOTTOM", maxLines: 2, autoFit: true, style: "OUTLINE" });
    const partial = controlsOf({ contentType: null, outputControlsJson: JSON.stringify({ subtitles: { size: "LARGE" } }) }).subtitles;
    expect(partial).toMatchObject({ enabled: true, size: "LARGE", position: "BOTTOM", maxLines: 2, autoFit: true });
    expect(controlsOf({ contentType: null, outputControlsJson: "{broken" }).subtitles.enabled).toBe(true);
  });

  it("quy tắc vừa khung mới nằm trong công thức render → video cũ được render lại tại máy (không dùng bản cache cũ)", () => {
    const req = {
      target: { width: 1080, height: 1920, fps: 30 },
      burnSubtitles: true,
      scenes: [],
      subtitleLayout: subtitleLayout(base.subtitles, 1080, 1920),
    } as unknown as Omit<RenderRequest, "projectId">;
    expect((renderRecipeFields(req).subtitleLayout as { fitRules: string }).fitRules).toBe(SUBTITLE_FIT_RULES);
  });
});
