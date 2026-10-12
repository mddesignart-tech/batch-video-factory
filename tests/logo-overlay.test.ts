import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { ffmpeg, ffprobe } from "@/media/ffmpeg";
import {
  buildFinalArgs,
  buildFinalWithMixArgs,
  logoOverlayFilter,
  renderProject,
  type RenderClip,
  type RenderLogo,
  type RenderRequest,
  type RenderScene,
} from "@/media/render";
import { projectSubdir, toAbsolute } from "@/lib/paths";
import { controlsOf, OutputControlsSchema, platformSafeArea, subtitleLayout, type OutputControls } from "@/domain/output-controls";
import { LOGO_MISSING_MESSAGE, logoAlphaWarning, logoPlacement, logoSubtitleClash } from "@/domain/logo-overlay";
import { renderRecipeHash } from "@/services/render-recipe";
import { createReference } from "@/services/reference-assets";
import { applyOutputControls, saveProjectControls } from "@/services/output-controls";
import { logoState, projectLogoReferences, renderLogoFor } from "@/services/logo-overlay";
import { bareProject } from "./phase5-helpers";

/**
 * LOGO OVERLAY: a LOGO Reference on the finished video, laid by local FFmpeg
 * in the final pass. No provider of any kind is involved ($0).
 */

const PROJECT = "logo-overlay-test";
let root = "";
const f = (name: string) => path.join(root, name);
const q = ["-y", "-hide_banner", "-loglevel", "error"];

const logoCfg = (over: Partial<OutputControls["logo"]> = {}): OutputControls["logo"] => ({ ...OutputControlsSchema.parse({}).logo, enabled: true, referenceId: "x", ...over });

/** One frame as RGB24. */
async function frameRgb(file: string, atSec: number, w: number, h: number): Promise<Buffer> {
  const raw = f(`r-${Math.random().toString(36).slice(2)}.raw`);
  await ffmpeg([...q, "-ss", String(atSec), "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
  const b = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  return b;
}

/** Bounding box of the logo's red mark. */
function redBox(b: Buffer, w: number, h: number, test = (r: number, g: number, bl: number) => r > 150 && g < 90 && bl < 90) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3;
      if (test(b[i]!, b[i + 1]!, b[i + 2]!)) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
const px = (b: Buffer, w: number, x: number, y: number) => [b[(y * w + x) * 3]!, b[(y * w + x) * 3 + 1]!, b[(y * w + x) * 3 + 2]!];

const clip = (lengthSec: number): RenderClip => ({ startSec: 0, lengthSec, shortMode: "AUTO", frame: "AUTO", audioGain: null });
const scene = (n: number, over: Partial<RenderScene>): RenderScene => ({
  sceneNumber: n, duration: 1.5, subtitle: "", videoPath: null, audioPath: null, imagePath: null, durationMode: "LOCKED", ...over,
});

/** The logo file is 400x200: transparent, with a red 200x100 mark in the middle (2:1). */
const LOGO_W = 400;
const LOGO_H = 200;
const placed = (frame: { width: number; height: number }, over: Partial<OutputControls["logo"]> = {}, file = f("logo.png")): RenderLogo => {
  const c = logoCfg(over);
  return { path: file, ...logoPlacement(c, frame, { width: LOGO_W, height: LOGO_H }), opacity: c.opacity, startSec: c.startSec, endSec: c.endSec };
};
/** Where the red mark should be: the middle half of the placed box. */
const markOf = (p: RenderLogo) => ({ x: p.x + p.width / 4, y: p.y + p.height / 4, w: p.width / 2, h: p.height / 2 });

async function render(target: { width: number; height: number; fps: number }, scenes: RenderScene[], logo?: RenderLogo, extra: Partial<RenderRequest> = {}) {
  return renderProject({ projectId: PROJECT, scenes, target, burnSubtitles: false, ...(logo ? { logo } : {}), ...extra });
}

beforeAll(async () => {
  root = toAbsolute(projectSubdir(PROJECT, "temp"));
  fs.mkdirSync(root, { recursive: true });
  await ffmpeg([...q, "-f", "lavfi", "-i", `color=c=black@0.0:s=${LOGO_W}x${LOGO_H},format=rgba`, "-vf", "drawbox=x=100:y=50:w=200:h=100:c=red@1:t=fill:replace=1", "-frames:v", "1", f("logo.png")]);
  await ffmpeg([...q, "-f", "lavfi", "-i", `color=c=red:s=${LOGO_W}x${LOGO_H}`, "-frames:v", "1", f("logo.jpg")]);
  // Plain blue background (any shape: the renderer fills the frame).
  await ffmpeg([...q, "-f", "lavfi", "-i", "color=c=0x2040c0:s=1080x1080", "-frames:v", "1", f("bg.png")]);
  // A textured still (grey - nothing red that could pass for the logo): a push-in visibly moves it.
  await ffmpeg([...q, "-f", "lavfi", "-i", "testsrc2=s=640x360:r=1:d=1", "-vf", "format=gray,format=rgb24", "-frames:v", "1", f("tex.png")]);
  await ffmpeg([...q, "-f", "lavfi", "-i", "color=c=yellow:s=200x300,format=rgba", "-frames:v", "1", f("fg.png")]);
  await ffmpeg([...q, "-f", "lavfi", "-i", "color=c=0x2040c0:s=640x360:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", f("clip.mp4")]);
}, 120_000);

afterAll(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

// ------------------------------------------------------------------ pure ---

describe("LOGO PLACEMENT (thuần, không FFmpeg)", () => {
  it("B. góc trên phải 9:16: tránh vùng UI của nền tảng (trên, phải), không dính mép", () => {
    const frame = { width: 1080, height: 1920 };
    const p = logoPlacement(logoCfg({ position: "TOP_RIGHT", size: "MEDIUM" }), frame, { width: 400, height: 400 });
    const safe = platformSafeArea(1080, 1920);
    expect(p.width).toBe(p.height);
    expect(p.width).toBe(130); // 12 % of the short side
    expect(p.x + p.width).toBeLessThanOrEqual(1080 - safe.right * 1080 + 1);
    expect(p.y).toBeGreaterThanOrEqual(safe.top * 1920 - 1);
  });

  it("E. Nhỏ / Vừa / Lớn = 8 / 12 / 18 % cạnh ngắn; Tuỳ chỉnh theo %", () => {
    const frame = { width: 1080, height: 1920 };
    const side = (size: OutputControls["logo"]["size"], customPct = 12) => logoPlacement(logoCfg({ size, customPct }), frame, { width: 1, height: 1 }).width;
    expect([side("SMALL"), side("MEDIUM"), side("LARGE"), side("CUSTOM", 20)]).toEqual([86, 130, 194, 216]);
  });

  it("giữ đúng tỷ lệ logo (2:1, 4:1, 1:3) - không kéo méo; logo rất dài bị giới hạn chứ không tràn", () => {
    for (const [w, h] of [[400, 200], [800, 200], [100, 300]] as const) {
      const p = logoPlacement(logoCfg({ size: "LARGE" }), { width: 1920, height: 1080 }, { width: w, height: h });
      expect(Math.abs(p.width / p.height - w / h) / (w / h)).toBeLessThan(0.03);
    }
    const huge = logoPlacement(logoCfg({ size: "CUSTOM", customPct: 30 }), { width: 1080, height: 1920 }, { width: 2000, height: 100 });
    expect(huge.width).toBeLessThanOrEqual(1080 * 0.4 + 2);
  });

  it("F–I. 9:16 / 16:9 / 1:1 / 4:5: cùng một cỡ tương đối (theo cạnh ngắn), luôn nằm trong khung + lề", () => {
    const sizes = [
      { width: 1080, height: 1920 },
      { width: 1920, height: 1080 },
      { width: 1080, height: 1080 },
      { width: 1080, height: 1350 },
    ];
    const widths = sizes.map((frame) => {
      for (const position of ["TOP_LEFT", "TOP_RIGHT", "BOTTOM_LEFT", "BOTTOM_RIGHT", "TOP_CENTER", "BOTTOM_CENTER"] as const) {
        const p = logoPlacement(logoCfg({ position }), frame, { width: LOGO_W, height: LOGO_H });
        const margin = Math.min(frame.width, frame.height) * 0.04;
        expect(p.x).toBeGreaterThanOrEqual(position.endsWith("CENTER") ? 0 : margin - 1);
        expect(p.y).toBeGreaterThanOrEqual(margin - 1);
        expect(p.x + p.width).toBeLessThanOrEqual(frame.width - (position.endsWith("CENTER") ? 0 : margin - 1));
        expect(p.y + p.height).toBeLessThanOrEqual(frame.height - margin + 1);
      }
      return logoPlacement(logoCfg(), frame, { width: LOGO_W, height: LOGO_H }).width;
    });
    expect(new Set(widths).size).toBe(1);
  });

  it("C. góc dưới phải + phụ đề dưới → cảnh báo, đề xuất góc trên phải (không tự di chuyển)", () => {
    const frame = { width: 1080, height: 1920 };
    const subs = subtitleLayout(OutputControlsSchema.parse({}).subtitles, 1080, 1920);
    const bottom = logoPlacement(logoCfg({ position: "BOTTOM_CENTER", size: "LARGE" }), frame, { width: LOGO_W, height: LOGO_H });
    const clash = logoSubtitleClash(bottom, subs, frame, "BOTTOM_CENTER");
    expect(clash?.suggest).toBe("TOP_CENTER");
    const br = logoPlacement(logoCfg({ position: "BOTTOM_RIGHT", size: "LARGE" }), frame, { width: LOGO_W, height: LOGO_H });
    expect(logoSubtitleClash(br, subs, frame, "BOTTOM_RIGHT")?.suggest).toBe("TOP_RIGHT");
    const top = logoPlacement(logoCfg({ position: "TOP_RIGHT" }), frame, { width: LOGO_W, height: LOGO_H });
    expect(logoSubtitleClash(top, subs, frame, "TOP_RIGHT")).toBeNull();
    // Captions off: nothing to clash with.
    expect(logoSubtitleClash(bottom, null, frame, "BOTTOM_CENTER")).toBeNull();
  });

  it("JPG → cảnh báo không có nền trong suốt; PNG/WebP thì không", () => {
    expect(logoAlphaWarning("brand.JPG")).toMatch(/không có nền trong suốt/);
    expect(logoAlphaWarning("brand.png")).toBeNull();
    expect(logoAlphaWarning("brand.webp")).toBeNull();
  });

  it("O. project cũ (không có thiết lập logo) → logo TẮT", () => {
    expect(controlsOf({ contentType: null, outputControlsJson: null }).logo.enabled).toBe(false);
    expect(controlsOf({ contentType: null, outputControlsJson: JSON.stringify({ subtitles: { size: "LARGE" } }) }).logo).toMatchObject({ enabled: false, referenceId: null, position: "TOP_RIGHT" });
  });

  it("N. không bật logo → lệnh FFmpeg cuối và render recipe y như trước", () => {
    const target = { width: 1080, height: 1920, fps: 30 };
    const a = buildFinalArgs({ input: "joined.mp4", subtitleFile: "s.ass", musicFile: "m.mp3", target, output: "o.mp4" });
    expect(a.join(" ")).not.toContain("overlay");
    expect(a).toEqual(buildFinalArgs({ input: "joined.mp4", subtitleFile: "s.ass", musicFile: "m.mp3", target, output: "o.mp4", logo: undefined }));
    const m = buildFinalWithMixArgs({ videoInput: "j.mp4", audioInput: "mix.wav", subtitleFile: "s.ass", target, output: "o.mp4" });
    expect(m[m.indexOf("-vf") + 1]).toBe("setpts=PTS-STARTPTS,subtitles=s.ass");
    const base = { scenes: [], target, burnSubtitles: true } as Omit<RenderRequest, "projectId">;
    expect(renderRecipeHash(base)).toBe(renderRecipeHash({ ...base, logo: undefined }));
    expect(renderRecipeHash({ ...base, logo: placed({ width: 1080, height: 1920 }) })).not.toBe(renderRecipeHash(base));
  });

  it("logo nằm SAU phụ đề trong CÙNG một graph encode cuối; opacity chỉ nhân vào alpha", () => {
    const logo: RenderLogo = { path: "logo.png", x: 10, y: 20, width: 130, height: 66, opacity: 0.5 };
    const filter = logoOverlayFilter(logo, 2, "base");
    expect(filter).toBe("[2:v]scale=130:66:flags=lanczos,format=rgba,colorchannelmixer=aa=0.500[logo];[base][logo]overlay=x=10:y=20:format=auto[v]");
    expect(logoOverlayFilter({ ...logo, opacity: 1 }, 1, "base")).not.toContain("colorchannelmixer");
    expect(logoOverlayFilter({ ...logo, startSec: 1, endSec: 3 }, 1, "base")).toContain(":enable='between(t,1,3)'");
    const target = { width: 1080, height: 1920, fps: 30 };
    const m = buildFinalWithMixArgs({ videoInput: "j.mp4", audioInput: "mix.wav", subtitleFile: "s.ass", target, output: "o.mp4", logo });
    expect(m[m.indexOf("-filter_complex") + 1]).toBe(`[0:v]setpts=PTS-STARTPTS,subtitles=s.ass[base];${logoOverlayFilter(logo, 2, "base")}`);
    expect(m.filter((a, i) => m[i - 1] === "-map")).toEqual(["[v]", "1:a"]);
    expect(m.filter((a) => a === "libx264")).toHaveLength(1);
    const legacy = buildFinalArgs({ input: "j.mp4", subtitleFile: null, musicFile: "m.mp3", target, output: "o.mp4", logo });
    expect(legacy[legacy.indexOf("-filter_complex") + 1]).toContain("[2:v]scale=130:66");
  });
});

// ----------------------------------------------------------- real renders ---

describe("LOGO OVERLAY — render thật tại máy ($0)", () => {
  it("A + B. PNG trong suốt, góc trên phải 9:16: đúng vị trí, đúng tỷ lệ, phần trong suốt vẫn thấy nền", async () => {
    const target = { width: 360, height: 640, fps: 30 };
    const logo = placed(target, { position: "TOP_RIGHT", opacity: 1 });
    const r = await render(target, [scene(1, { imagePath: f("bg.png"), videoPath: f("bg.png") })], logo);
    const b = await frameRgb(r.videoPath, 0.5, 360, 640);
    const box = redBox(b, 360, 640)!;
    const want = markOf(logo);
    expect(Math.abs(box.x - want.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.y - want.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.w - want.w)).toBeLessThanOrEqual(3);
    expect(Math.abs(box.h - want.h)).toBeLessThanOrEqual(3);
    // Transparent corner of the logo file: the blue background shows through.
    const [, , blue] = px(b, 360, logo.x + 2, logo.y + 2);
    expect(blue).toBeGreaterThan(150);
    // Platform safe area (9:16): clear of the top bar and the right-hand buttons.
    const safe = platformSafeArea(360, 640);
    expect(logo.x + logo.width).toBeLessThanOrEqual(360 * (1 - safe.right) + 1);
    expect(logo.y).toBeGreaterThanOrEqual(640 * safe.top - 1);
    expect((await ffprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", r.videoPath])).stdout.trim()).toBe("360,640");
  }, 300_000);

  it("D. opacity 50%: logo pha với nền (màu logo không đổi, chỉ trong hơn)", async () => {
    const target = { width: 360, height: 640, fps: 30 };
    const full = placed(target, { opacity: 1 });
    const half = placed(target, { opacity: 0.5 });
    const rf = await render(target, [scene(1, { imagePath: f("bg.png"), videoPath: f("bg.png") })], full);
    const cx = Math.round(full.x + full.width / 2);
    const cy = Math.round(full.y + full.height / 2);
    const solid = px(await frameRgb(rf.videoPath, 0.5, 360, 640), 360, cx, cy);
    const rh = await render(target, [scene(1, { imagePath: f("bg.png"), videoPath: f("bg.png") })], half);
    const mixed = px(await frameRgb(rh.videoPath, 0.5, 360, 640), 360, cx, cy);
    const bg = px(await frameRgb(rh.videoPath, 0.5, 360, 640), 360, 20, 320);
    for (let k = 0; k < 3; k += 1) expect(Math.abs(mixed[k]! - (solid[k]! + bg[k]!) / 2)).toBeLessThanOrEqual(14);
  }, 300_000);

  it("F–I + visual. 9:16 / 16:9 / 1:1 / 4:5: logo đúng chỗ, cùng cỡ tương đối, không méo", async () => {
    const frames = [
      { width: 360, height: 640, fps: 30 },
      { width: 640, height: 360, fps: 30 },
      { width: 480, height: 480, fps: 30 },
      { width: 432, height: 540, fps: 30 },
    ];
    for (const target of frames) {
      const logo = placed(target, { position: target.width > target.height ? "BOTTOM_RIGHT" : "TOP_RIGHT", opacity: 1 });
      const r = await render(target, [scene(1, { imagePath: f("bg.png"), videoPath: f("bg.png") })], logo);
      const box = redBox(await frameRgb(r.videoPath, 0.5, target.width, target.height), target.width, target.height)!;
      const want = markOf(logo);
      expect(Math.abs(box.x - want.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(box.y - want.y)).toBeLessThanOrEqual(2);
      // The 2:1 mark keeps its size and shape (±1 px of scaling at these small frames).
      expect(Math.abs(box.w - want.w)).toBeLessThanOrEqual(3);
      expect(Math.abs(box.h - want.h)).toBeLessThanOrEqual(3);
      // Same share of the short side on every shape.
      expect(Math.abs(logo.width / Math.min(target.width, target.height) - logoPlacement(logoCfg(), { width: 1080, height: 1920 }, { width: LOGO_W, height: LOGO_H }).width / 1080)).toBeLessThan(0.02);
    }
  }, 600_000);

  it("J. nguồn là clip người dùng tải lên → logo vẫn đúng chỗ", async () => {
    const target = { width: 360, height: 640, fps: 30 };
    const logo = placed(target, { opacity: 1 });
    const r = await render(target, [scene(1, { videoPath: f("clip.mp4"), clip: clip(1.5) })], logo);
    const box = redBox(await frameRgb(r.videoPath, 0.7, 360, 640), 360, 640)!;
    expect(Math.abs(box.x - markOf(logo).x)).toBeLessThanOrEqual(2);
  }, 300_000);

  it("K. Local Motion (camera đẩy vào): nền chuyển động, logo đứng yên đúng một chỗ", async () => {
    const target = { width: 360, height: 640, fps: 30 };
    const logo = placed(target, { opacity: 1 });
    const r = await render(target, [scene(1, { imagePath: f("tex.png"), videoPath: f("tex.png"), localCamera: { move: "PUSH_IN", speed: "FAST" } })], logo);
    const a = await frameRgb(r.videoPath, 0.05, 360, 640);
    const b = await frameRgb(r.videoPath, 1.4, 360, 640);
    // The background moved…
    let diff = 0;
    for (let i = 0; i < a.length; i += 3) diff += Math.abs(a[i]! - b[i]!);
    expect(diff / (a.length / 3)).toBeGreaterThan(3);
    // …the logo did not.
    expect(redBox(a, 360, 640, (r2, g, bl) => r2 > 200 && g < 40 && bl < 40)).toEqual(redBox(b, 360, 640, (r2, g, bl) => r2 > 200 && g < 40 && bl < 40));
  }, 300_000);

  it("L. Multi-layer + camera/parallax: logo không bị kéo theo lớp hay camera", async () => {
    const target = { width: 360, height: 640, fps: 30 };
    const logo = placed(target, { opacity: 1, position: "TOP_LEFT" });
    const layered = scene(1, {
      imagePath: f("tex.png"),
      videoPath: f("tex.png"),
      localCamera: { move: "PUSH_IN", speed: "FAST" },
      layers: { background: f("tex.png"), foregrounds: [{ path: f("fg.png"), slot: "CENTER", scale: 0.4 }] },
    });
    const r = await render(target, [layered], logo);
    const red = (r2: number, g: number, bl: number) => r2 > 200 && g < 40 && bl < 40;
    const a = redBox(await frameRgb(r.videoPath, 0.05, 360, 640), 360, 640, red);
    const b = redBox(await frameRgb(r.videoPath, 1.4, 360, 640), 360, 640, red);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    expect(Math.abs(a!.x - markOf(logo).x)).toBeLessThanOrEqual(2);
  }, 300_000);

  it("M. file logo mất → video vẫn render (không logo), không lỗi, không gọi API", async () => {
    const target = { width: 360, height: 640, fps: 30 };
    const jobsBefore = await prisma.providerJob.count();
    const r = await render(target, [scene(1, { imagePath: f("bg.png"), videoPath: f("bg.png") })], placed(target, { opacity: 1 }, f("gone.png")));
    expect(fs.existsSync(r.videoPath)).toBe(true);
    expect(redBox(await frameRgb(r.videoPath, 0.5, 360, 640), 360, 640)).toBeNull();
    expect(await prisma.providerJob.count()).toBe(jobsBefore);
  }, 300_000);

  it("P. render lại: segment dùng lại, logo vẫn ghép tại máy", async () => {
    const target = { width: 360, height: 640, fps: 30 };
    const logo = placed(target, { opacity: 1 });
    const scenes = [scene(1, { imagePath: f("bg.png"), videoPath: f("bg.png") })];
    await render(target, scenes, logo);
    const again = await render(target, scenes, logo);
    expect(again.segmentsReused).toBe(1);
    expect(redBox(await frameRgb(again.videoPath, 0.5, 360, 640), 360, 640)).not.toBeNull();
  }, 300_000);

  it("thời gian hiện logo (từ 0,5 s đến 1,0 s)", async () => {
    const target = { width: 360, height: 640, fps: 30 };
    const logo = placed(target, { opacity: 1, startSec: 0.5, endSec: 1 });
    const r = await render(target, [scene(1, { imagePath: f("bg.png"), videoPath: f("bg.png") })], logo);
    expect(redBox(await frameRgb(r.videoPath, 0.2, 360, 640), 360, 640)).toBeNull();
    expect(redBox(await frameRgb(r.videoPath, 0.75, 360, 640), 360, 640)).not.toBeNull();
    expect(redBox(await frameRgb(r.videoPath, 1.3, 360, 640), 360, 640)).toBeNull();
  }, 300_000);
});

// ------------------------------------------------------- project settings ---

describe("LOGO SETTINGS trên dự án (chỉ LOGO Reference, $0)", () => {
  it("chỉ chọn được LOGO Reference; không tự lấy ảnh tham chiếu khác; thiếu file → báo + render không lỗi", async () => {
    const project = await bareProject("Logo settings");
    const jobsBefore = await prisma.providerJob.count();
    const product = await createReference({ projectId: project.id, type: "PRODUCT", name: "Máy xay", uploads: [{ bytes: fs.readFileSync(f("bg.png")), filename: "san-pham.png" }] });
    // No LOGO Reference yet: nothing to turn on, and the product is never used as a logo.
    expect(await projectLogoReferences(project.id)).toEqual([]);
    await expect(saveProjectControls(project.id, { logo: { enabled: true } })).rejects.toThrow(/chọn một LOGO Reference/);
    await expect(saveProjectControls(project.id, { logo: { enabled: true, referenceId: product.id } })).rejects.toThrow(/loại LOGO/);

    const brand = await createReference({ projectId: project.id, type: "LOGO", name: "Brand", uploads: [{ bytes: fs.readFileSync(f("logo.png")), filename: "brand.png" }] });
    const options = await projectLogoReferences(project.id);
    expect(options.map((o) => o.id)).toEqual([brand.id]);
    await saveProjectControls(project.id, { logo: { enabled: true, referenceId: brand.id, position: "BOTTOM_RIGHT", size: "LARGE" } });
    const saved = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });

    // On the render request: the logo's own file (alpha kept), placed on the frame.
    const target = { width: 1080, height: 1920, fps: 30 };
    const req: RenderRequest = { projectId: project.id, scenes: [], target, burnSubtitles: true };
    await applyOutputControls(saved, [], req);
    expect(req.logo?.path).toBe(toAbsolute(options[0]!.path!));
    expect(req.logo).toMatchObject(logoPlacement(controlsOf(saved).logo, target, { width: LOGO_W, height: LOGO_H }));

    // Bottom-right LARGE over bottom captions: a warning with a suggestion; the choice is kept.
    const state = await logoState(saved, target, subtitleLayout(controlsOf(saved).subtitles, 1080, 1920));
    expect(state.clash?.suggest).toBe("TOP_RIGHT");
    expect(controlsOf(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).logo.position).toBe("BOTTOM_RIGHT");

    // The file disappears: a clear message, the render request has no logo, nothing bought.
    fs.rmSync(toAbsolute(options[0]!.path!));
    const gone = await logoState(saved, target, null);
    expect(gone.missing).toBe(true);
    expect(gone.missingMessage).toBe(LOGO_MISSING_MESSAGE);
    expect(await renderLogoFor(saved, target, null)).toBeUndefined();
    const req2: RenderRequest = { projectId: project.id, scenes: [], target, burnSubtitles: true };
    await applyOutputControls(saved, [], req2);
    expect(req2.logo).toBeUndefined();
    expect(await prisma.providerJob.count()).toBe(jobsBefore);
  });
});
