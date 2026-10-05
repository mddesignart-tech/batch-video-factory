import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLayeredSceneArgs } from "@/media/camera-motion";
import { frameShape, subjectBoxes, TOP_SAFE } from "@/media/layer-layout";
import { ffmpeg, probeDuration, resolveFfmpeg } from "@/media/ffmpeg";
import { DATA_ROOT } from "@/lib/paths";

/**
 * G6 — MULTI-LAYER LAYOUT ON EVERY PLATFORM FRAME (9:16, 16:9, 1:1, 4:5).
 * Real renders, measured on the frames themselves. $0.
 */

const FRAMES = [
  { name: "9:16", width: 270, height: 480 },
  { name: "16:9", width: 480, height: 270 },
  { name: "1:1", width: 360, height: 360 },
  { name: "4:5", width: 288, height: 360 },
] as const;

let tmp = "";
const file = (n: string) => path.join(tmp, n);

beforeAll(async () => {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  tmp = fs.mkdtempSync(path.join(DATA_ROOT, "platform-test-"));
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x4080d0:s=1200x1200", "-vf", "drawbox=x=0:y=700:w=1200:h=500:color=0x30a040:t=fill", "-frames:v", "1", file("bg.png")]);
  // Two "people" (pure red / pure magenta, tall) and a brown "table", on transparency.
  const figure = (name: string, color: string, w: number, h: number) =>
    ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${w}x${h},format=rgba`, "-frames:v", "1", file(name)]);
  await figure("red.png", "0xff0000", 160, 480);
  await figure("magenta.png", "0xff00ff", 160, 480);
  await figure("table.png", "0x704020", 400, 160);
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black@0.0:s=360x60:r=30:d=1",
    "-vf", "format=rgba,geq=r='250':g='250':b='20':a='255*lt(abs(X-mod(T*360,360)),12)*between(Y,20,58)'",
    "-c:v", "qtrle", file("cars.mov"),
  ]);
}, 120_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Bounding box of pixels matching a colour test, on one frame. */
function boxOf(video: string, w: number, h: number, test: (r: number, g: number, b: number) => boolean) {
  const raw = execFileSync(resolveFfmpeg()!, ["-hide_banner", "-loglevel", "error", "-ss", "1", "-i", video, "-frames:v", "1", "-vf", "format=rgb24", "-f", "rawvideo", "-"]);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3;
      if (test(raw[i]!, raw[i + 1]!, raw[i + 2]!)) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, cx: (x0 + x1) / 2 };
}
const isRed = (r: number, g: number, b: number) => r > 200 && g < 60 && b < 60;
const isMagenta = (r: number, g: number, b: number) => r > 200 && g < 60 && b > 200;

describe("G6 — bố cục theo khổ (thuần)", () => {
  it("khổ dọc 9:16 và 4:5 là PORTRAIT, 1:1 SQUARE, 16:9 LANDSCAPE; người cao hơn trên khổ dọc", () => {
    expect(FRAMES.map((f) => frameShape(f))).toEqual(["PORTRAIT", "LANDSCAPE", "SQUARE", "PORTRAIT"]);
    const tall = subjectBoxes(2, { width: 1080, height: 1920 })[0]!.maxH / 1920;
    const wide = subjectBoxes(2, { width: 1920, height: 1080 })[0]!.maxH / 1080;
    expect(tall).toBeLessThan(wide); // share of height: portrait leaves room for the scene above
    for (const f of FRAMES) {
      for (const n of [1, 2, 3]) {
        for (const b of subjectBoxes(n, f)) {
          expect(b.cx - b.maxW / 2).toBeGreaterThanOrEqual(-0.5);
          expect(b.cx + b.maxW / 2).toBeLessThanOrEqual(f.width + 0.5);
          expect(b.bottom - b.maxH).toBeGreaterThanOrEqual(f.height * TOP_SAFE - 0.5);
        }
      }
    }
  });
});

describe("G6 — render thật trên 4 khổ", () => {
  it.each(FRAMES)("$name: 2 người trong khung, trái / phải đúng, đầu dưới lề an toàn và trên dải phụ đề; ambient + trung cảnh có mặt", async (f) => {
    const out = file(`layout-${f.name.replace(":", "x")}.mp4`);
    await ffmpeg(
      buildLayeredSceneArgs({
        layers: {
          background: file("bg.png"),
          foregrounds: [{ path: file("red.png"), slot: "LEFT" }, { path: file("magenta.png"), slot: "RIGHT" }],
          midground: [{ path: file("table.png") }],
          ambient: [{ path: file("cars.mov"), alpha: true, band: "HORIZON", opacity: 1 }],
        },
        audioInput: null,
        duration: 2,
        target: { width: f.width, height: f.height, fps: 30 },
        camera: { move: "PUSH_IN", speed: "SLOW" },
        output: out,
      }),
      { timeoutMs: 180_000 },
    );
    expect(Math.abs((await probeDuration(out)) - 2)).toBeLessThan(0.1);
    const red = boxOf(out, f.width, f.height, isRed);
    const mag = boxOf(out, f.width, f.height, isMagenta);
    expect(red).not.toBeNull();
    expect(mag).not.toBeNull();
    // Left / right as asked.
    expect(red!.cx).toBeLessThan(f.width / 2);
    expect(mag!.cx).toBeGreaterThan(f.width / 2);
    // Inside the frame sideways (a push-in may grow them a little, never off one side entirely).
    for (const b of [red!, mag!]) {
      expect(b.x1 - b.x0).toBeGreaterThan(f.width * 0.05);
      // Heads below the top safe margin (a push-in may lift them slightly), and above the subtitle band.
      expect(b.y0).toBeGreaterThan(f.height * TOP_SAFE * 0.5);
      expect(b.y0).toBeLessThan(f.height * 0.78);
    }
    // The distant cars and the table are drawn too (behind the people).
    expect(boxOf(out, f.width, f.height, (r, g, b) => r > 200 && g > 200 && b < 80)).not.toBeNull();
    expect(boxOf(out, f.width, f.height, (r, g, b) => Math.abs(r - 0x70) < 30 && Math.abs(g - 0x40) < 30 && b < 60)).not.toBeNull();
  }, 240_000);
});
