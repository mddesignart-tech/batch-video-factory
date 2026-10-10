import { describe, expect, it } from "vitest";
import { animalScale, defaultScale, isAirborne, subjectKind } from "@/domain/subject-grounding";
import { buildLayeredSceneArgs, personScale, productFraming, standingLine } from "@/media/camera-motion";
import { subtitleTopLine } from "@/media/layer-layout";
import { cutoutRaster, trimToSubject } from "@/media/cutout";

/** G10 — SUBJECT GROUNDING: size / standing line / contact shadow / edge / product framing. Pure, $0. */

const target = { width: 1080, height: 1920, fps: 30 };
const graph = (args: string[]) => args[args.indexOf("-filter_complex") + 1]!;
const args = (layers: Parameters<typeof buildLayeredSceneArgs>[0]["layers"], shot?: number) =>
  buildLayeredSceneArgs({
    layers: { ...layers, ...(shot ? { backgroundSoftness: shot } : {}) },
    audioInput: null,
    duration: 3,
    target,
    camera: { move: "PUSH_IN", speed: "SLOW" },
    output: "out.mp4",
  });

describe("G10 — cỡ theo loại + ngữ nghĩa", () => {
  it("chim / bướm nhỏ, mèo / chó vừa, ngựa / bò lớn (EN + VI); sản phẩm 0.6; người lấp hộp", () => {
    expect(animalScale("Chim xanh")).toBe(0.2);
    expect(animalScale("A small bluebird")).toBe(0.2);
    expect(animalScale("Con mèo")).toBe(0.4);
    expect(animalScale("Golden dog")).toBe(0.4);
    expect(animalScale("Ngựa trắng")).toBe(0.85);
    expect(animalScale("Unknown creature")).toBe(0.4);
    expect(defaultScale(subjectKind("PRODUCT"), "Bình")).toBe(0.6);
    expect(defaultScale(subjectKind("CHARACTER"), "Leo")).toBeUndefined();
  });

  it("đang bay ↔ đậu: theo nhãn hoặc cờ airborne", () => {
    expect(isAirborne("Chim đang bay")).toBe(true);
    expect(isAirborne("Bird flying over the lake")).toBe(true);
    expect(isAirborne("Chim xanh")).toBe(false);
    expect(isAirborne("Chim xanh", true)).toBe(true);
    expect(isAirborne("Chim đang bay", false)).toBe(false);
  });
});

describe("G10 — chỗ đứng + cỡ theo chân trời", () => {
  const subTop = subtitleTopLine(target);
  it("vật nhỏ đậu: giữa chân trời và phụ đề; vật bay: trên chân trời, không dưới chữ; floorY của người dùng thắng", () => {
    const perched = standingLine({ path: "b.png", kind: "ANIMAL", scale: 0.2 }, { box: 0.985, horizon: 0.55, subtitleTop: subTop, size: 0.14 });
    expect(perched).toBeGreaterThan(0.55);
    expect(perched).toBeLessThan(subTop);
    const flying = standingLine({ path: "b.png", kind: "ANIMAL", scale: 0.2, airborne: true }, { box: 0.985, horizon: 0.55, subtitleTop: subTop, size: 0.14 });
    expect(flying).toBeLessThan(0.55);
    expect(standingLine({ path: "b.png", floorY: 0.8 }, { box: 0.985, horizon: 0.55, subtitleTop: subTop, size: 0.14 })).toBe(0.8);
  });

  it("người theo tầm mắt: chân trời cao → người nhỏ hơn hộp, không bao giờ dưới 0.75 hộp", () => {
    expect(personScale(0.985, 0.53, 0.62)).toBeCloseTo(0.834, 2);
    expect(personScale(0.985, 0.2, 0.62)).toBe(1);
    expect(personScale(0.985, 0.8, 0.62)).toBe(0.75);
  });
});

describe("G10 — bóng tiếp xúc, viền, nền mềm, khung cận sản phẩm (FFmpeg graph)", () => {
  it("người / sản phẩm đứng → có bóng mềm mờ; vật bay → không; viền: chỉ ăn mòn alpha nhẹ", () => {
    const g = graph(args({ background: "bg.png", foregrounds: [{ path: "a.png", slot: "LEFT", kind: "PERSON" }, { path: "p.png", slot: "RIGHT", kind: "PRODUCT", scale: 0.6 }] }));
    expect(g.match(/colorchannelmixer=rr=0[^,]*aa=0\.32/)).not.toBeNull();
    expect(g.match(/aa=0\.38/)).not.toBeNull();
    expect(g).toContain("erosion=threshold0=0:threshold1=0:threshold2=0:threshold3=80");
    const flying = graph(args({ background: "bg.png", foregrounds: [{ path: "b.png", kind: "ANIMAL", scale: 0.2, airborne: true }] }));
    expect(flying).not.toMatch(/colorchannelmixer=rr=0/);
  });

  it("nền mềm rất nhẹ theo cỡ khung, chỉ khi có chủ thể phía trước", () => {
    expect(graph(args({ background: "bg.png", foregrounds: [{ path: "a.png", kind: "PERSON" }] }, 1.6))).toMatch(/crop=1080:1920,gblur=sigma=1\.60/);
    expect(graph(args({ background: "bg.png", ambient: [] }, 1.6))).not.toContain("gblur=sigma=1.60");
  });

  it("cảnh chỉ có sản phẩm + mặt bàn cao → nền được kéo gần (≤1.6x, từ mép trên), mặt bàn hạ xuống trên phụ đề", () => {
    const only = { background: "bg.png", foregrounds: [{ path: "p.png", kind: "PRODUCT" as const, scale: 0.6, floorY: 0.45 }], horizonY: 0.45 };
    const k = productFraming(only, target);
    expect(k).toBeGreaterThan(1.3);
    expect(k).toBeLessThanOrEqual(1.6);
    expect(graph(args(only))).toContain(`crop=1080:1920:(iw-1080)/2:0`);
    // With a presenter, or with a low counter, the background is never reframed.
    expect(productFraming({ ...only, foregrounds: [...only.foregrounds, { path: "a.png", kind: "PERSON" }] }, target)).toBe(1);
    expect(productFraming({ ...only, horizonY: 0.72 }, target)).toBe(1);
  });
});

describe("G10 — tách nền: sàn giữa hai chân + bóng không kéo rộng ảnh tách", () => {
  const W = 300;
  const H = 300;
  const BG: [number, number, number] = [211, 210, 210];
  // Two brown legs standing on a grey floor; a soft floor shadow between and around the feet, long to the left.
  const img = (() => {
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        let c: [number, number, number] = BG;
        const leg = y >= 60 && y < 280 && ((x >= 120 && x < 140) || (x >= 160 && x < 180));
        const body = y >= 20 && y < 120 && x >= 115 && x < 185;
        if (leg || body) c = [120, 70, 30];
        else if (y >= 240) {
          // Shadow: darkest at the feet, fading out - and a long cast shadow to the left.
          const dx = x < 120 ? (120 - x) / 4 : x >= 180 ? (x - 180) * 2 : 0;
          const v = Math.round(211 - Math.max(0, 22 - dx * 0.4 - Math.abs(y - 280) * 0.3));
          c = [v, v - 1, v - 1];
        }
        const i = (y * W + x) * 4;
        data.set([c[0], c[1], c[2], 255], i);
      }
    }
    return { width: W, height: H, data };
  })();
  const r = cutoutRaster(img, BG);

  it("điểm sàn giữa hai chân không còn là mảng xám đục: trong suốt hoặc bóng đen mờ", () => {
    if (!("raster" in r)) throw new Error("refused");
    const i = (275 * W + 150) * 4;
    const [cr, cg, cb, a] = [r.raster.data[i]!, r.raster.data[i + 1]!, r.raster.data[i + 2]!, r.raster.data[i + 3]!];
    expect(a === 0 || (cr === 0 && cg === 0 && cb === 0 && a < 160)).toBe(true);
    // The legs are untouched.
    expect(r.raster.data[(200 * W + 130) * 4 + 3]).toBe(255);
  });

  it("bóng đổ dài mờ dần ngoài bề ngang chủ thể → ảnh tách không rộng ra", () => {
    if (!("raster" in r)) throw new Error("refused");
    const t = trimToSubject(r.raster);
    // Subject spans x 115..184 (70 px); 2 % margin + the short fade - never the 120 px cast shadow.
    expect(t.width).toBeLessThan(110);
  });
});
