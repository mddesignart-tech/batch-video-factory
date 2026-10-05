import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeBackdrop, cutoutImage, cutoutRaster, trimToSubject } from "@/media/cutout";
import { ffmpeg } from "@/media/ffmpeg";
import { pngHasAlpha, resolveSubjects } from "@/services/composite-subjects";
import type { UniversalReference } from "@/services/reference-assets";
import { DATA_ROOT, toAbsolute } from "@/lib/paths";

/** G1 — LOCAL CUT-OUT on a plain backdrop. Pure raster tests + one real FFmpeg round trip. $0. */

const BG: [number, number, number] = [211, 210, 210];
const W = 200;
const H = 300;

function raster(paint: (x: number, y: number) => [number, number, number] | null) {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const c = paint(x, y) ?? BG;
      const i = (y * W + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}
const alphaAt = (r: { data: Uint8Array }, x: number, y: number) => r.data[(y * W + x) * 4 + 3]!;

/** A "character": yellow body, white stripe, a backdrop-coloured hole (big) and a tiny backdrop-coloured dot, a soft dark shadow, standing on the bottom edge. */
const figure = (x: number, y: number): [number, number, number] | null => {
  const body = x >= 60 && x < 140 && y >= 60 && y < 300;
  if (!body) {
    // floor shadow beside the feet: faint far out, darker close to the feet
    if (y >= 280 && x >= 30 && x < 50) return [201, 200, 200];
    if (y >= 280 && x >= 50 && x < 60) return [175, 174, 174];
    return null;
  }
  if (y >= 120 && y < 130) return [250, 250, 250]; // white stripe
  if (x >= 80 && x < 120 && y >= 160 && y < 200) return BG; // a big gap (between arm and body)
  if (x >= 98 && x < 100 && y >= 220 && y < 222) return BG; // a tiny backdrop-coloured dot (a highlight)
  return [240, 200, 30];
};

let tmp = "";
beforeAll(() => {
  // Inside the (test) data folder: reference paths must not escape it.
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  tmp = fs.mkdtempSync(path.join(DATA_ROOT, "cutout-test-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function writePng(r: { data: Uint8Array }, file: string) {
  const raw = path.join(tmp, `${path.basename(file)}.rgba`);
  fs.writeFileSync(raw, Buffer.from(r.data));
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-i", raw, "-frames:v", "1", "-pix_fmt", "rgb24", file]);
}

describe("G1 — phân tích nền", () => {
  it("nền xám phẳng → phẳng (màu nền đúng dù chủ thể chạm mép dưới)", () => {
    const a = analyzeBackdrop(raster(figure));
    expect(a.uniform).toBe(true);
    expect(a.color).toEqual(BG);
  });

  it("nền có hoạ tiết → BUSY_BACKGROUND; nền chuyển màu → GRADIENT_BACKGROUND", () => {
    expect(analyzeBackdrop(raster((x, y) => ((x >> 3) + (y >> 3)) % 2 ? [20, 120, 220] : [230, 220, 30])).refusal).toBe("BUSY_BACKGROUND");
    // A strong gradient is refused (as busy or as a gradient - either way, not cut).
    expect(analyzeBackdrop(raster((_x, y) => [120 + Math.round(y / 3), 120 + Math.round(y / 3), 120 + Math.round(y / 3)])).uniform).toBe(false);
    // A vignette: the sides are even, but one corner is darker.
    expect(analyzeBackdrop(raster((x, y) => (x < 12 && y < 12 ? [170, 170, 170] : null))).refusal).toBe("GRADIENT_BACKGROUND");
  });
});

describe("G1 — tách nền (loang từ mép, không key toàn ảnh)", () => {
  const r = cutoutRaster(raster(figure), BG);
  it("nền liền mép → trong suốt; chủ thể → đục; sọc trắng giữ nguyên", () => {
    expect("raster" in r).toBe(true);
    if (!("raster" in r)) return;
    expect(alphaAt(r.raster, 5, 5)).toBe(0);
    expect(alphaAt(r.raster, 100, 100)).toBe(255);
    expect(alphaAt(r.raster, 100, 125)).toBe(255);
  });

  it("khoảng nền kín đủ lớn (giữa tay và thân) bị xoá; chấm nhỏ cùng màu nền thì giữ", () => {
    if (!("raster" in r)) throw new Error("refused");
    expect(alphaAt(r.raster, 100, 180)).toBe(0);
    expect(alphaAt(r.raster, 98, 220)).toBeGreaterThan(100);
  });

  it("bóng đổ nhạt gần như trong suốt; phần đậm sát chân giữ lại; mép chủ thể mềm (có alpha trung gian)", () => {
    if (!("raster" in r)) throw new Error("refused");
    expect(alphaAt(r.raster, 35, 290)).toBeLessThan(64);
    expect(alphaAt(r.raster, 55, 290)).toBeGreaterThan(64);
    const edge = [57, 58, 59, 60, 61, 62].map((x) => alphaAt(r.raster, x, 100));
    expect(edge.some((a) => a > 0 && a < 255)).toBe(true);
  });

  it("cắt sát chủ thể (+2 % lề): không còn lề trong suốt làm chủ thể nhỏ đi trong khung bố cục", () => {
    if (!("raster" in r)) throw new Error("refused");
    const t = trimToSubject(r.raster);
    // Subject spans x 50..139 (dark shadow kept, the faint part is transparent), y 60..299; margin 6 px.
    expect(t.width).toBeGreaterThanOrEqual(100);
    expect(t.width).toBeLessThanOrEqual(108);
    expect(t.height).toBeGreaterThanOrEqual(244);
    expect(t.height).toBeLessThanOrEqual(250);
    expect(t.data[3]).toBe(0); // the margin corner is transparent
  });

  it("từ chối thay vì tách sai: chạm mép trên / dải kín bề ngang / chủ thể quá nhỏ", () => {
    expect(cutoutRaster(raster((x, y) => (x >= 60 && x < 140 && y < 200 ? [240, 200, 30] : null)), BG)).toEqual({ refusal: "SUBJECT_FILLS_FRAME" });
    expect(cutoutRaster(raster((_x, y) => (y >= 100 && y < 140 ? [40, 40, 40] : null)), BG)).toEqual({ refusal: "SUBJECT_FILLS_FRAME" });
    expect(cutoutRaster(raster((x, y) => (x >= 100 && x < 104 && y >= 100 && y < 104 ? [240, 200, 30] : null)), BG)).toEqual({ refusal: "SUBJECT_TOO_SMALL" });
  });
});

describe("G1 — file thật + cache + chọn chủ thể", () => {
  it("PNG trong suốt được ghi vào cache; lần hai dùng lại (cached), ảnh nền phức tạp bị từ chối", async () => {
    const src = path.join(tmp, "figure.png");
    await writePng(raster(figure), src);
    const first = await cutoutImage(src);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(pngHasAlpha(first.path)).toBe(true);
    const again = await cutoutImage(src);
    expect(again.ok && again.cached).toBe(true);
    const busy = path.join(tmp, "busy.png");
    await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=200x300", "-frames:v", "1", busy]);
    const refused = await cutoutImage(busy);
    expect(refused.ok).toBe(false);
  }, 60_000);

  it("ưu tiên ảnh cảnh (giữ nguyên tư thế cả nhóm); ảnh cảnh phức tạp → tách từng ảnh tham chiếu", async () => {
    const plain = path.join(tmp, "scene.png");
    const busy = path.join(tmp, "busy.png");
    await writePng(raster(figure), plain);
    const ref = (id: string, name: string, type: "CHARACTER" | "PRODUCT", file: string): UniversalReference => ({
      id,
      type,
      name,
      description: "",
      priority: type === "PRODUCT" ? "CRITICAL" : "IMPORTANT",
      isPrimary: false,
      enabled: true,
      useThroughout: false,
      version: 1,
      source: "REFERENCE",
      images: [{ assetId: id, path: file, filename: path.basename(file), primary: true, exists: true }],
      aliases: [],
    });
    const refs = [ref("leo", "Leo", "CHARACTER", plain), ref("pot", "Bình", "PRODUCT", plain)];
    const fromScene = await resolveSubjects({ imagePath: plain }, refs);
    expect(fromScene.subjects).toHaveLength(1);
    expect(fromScene.subjects[0]).toMatchObject({ from: "CUTOUT_SCENE", name: "Leo + Bình", critical: true });
    const fromRefs = await resolveSubjects({ imagePath: busy }, refs);
    expect(fromRefs.subjects.map((s) => s.from)).toEqual(["CUTOUT_REFERENCE", "CUTOUT_REFERENCE"]);
    expect(fromRefs.subjects[1]).toMatchObject({ name: "Bình", entityType: "PRODUCT", critical: true });
    expect(fromRefs.skipped[0]).toMatch(/Ảnh cảnh/);
    expect(fs.existsSync(toAbsolute(fromRefs.subjects[0]!.path))).toBe(true);
  }, 60_000);
});
