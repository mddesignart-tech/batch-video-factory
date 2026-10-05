import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSceneNormalizeArgs } from "@/media/render";
import { buildLayeredSceneArgs, cameraZoompan, renderableMove } from "@/media/camera-motion";
import { ffmpeg, probeDuration } from "@/media/ffmpeg";

/** QĐ-128 PHASE E: local camera + layer compositor. Local FFmpeg only, $0. */

const target = { width: 360, height: 640, fps: 24 };
let tmp = "";
const file = (n: string) => path.join(tmp, n);

/** One frame, shrunk to 36x64 grey bytes - compared by mean difference (encoding noise is ~0). */
async function frameAt(video: string, sec: number, out: string): Promise<Buffer> {
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-ss", String(sec), "-i", video, "-frames:v", "1", "-vf", "scale=36:64,format=gray", "-f", "rawvideo", out]);
  return fs.readFileSync(out);
}
const meanDiff = (a: Buffer, b: Buffer) => a.reduce((n, v, i) => n + Math.abs(v - (b[i] ?? 0)), 0) / a.length;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cam-"));
  // A detailed picture (so motion is visible), a transparent foreground and a short ambient loop.
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=720x1280", "-frames:v", "1", file("still.png")]);
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red@0.0:s=200x300,format=rgba,drawbox=x=50:y=50:w=100:h=200:color=yellow@1:t=fill", "-frames:v", "1", file("fg.png")]);
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=320x240:d=1", "-pix_fmt", "yuv420p", file("amb.mp4")]);
}, 120_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("LOCAL CAMERA (args)", () => {
  it("cảnh không có plan: args y hệt V1 (zoom vào chậm) - project cũ render như cũ", () => {
    const args = buildSceneNormalizeArgs({ videoInput: "a.png", audioInput: null, duration: 4, target, output: "o.mp4" });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("zoompan=z='min(zoom+0.001042,1.10)':d=96:s=360x640:fps=24");
    expect(graph).not.toMatch(/scale=720:1280,zoompan/);
  });

  it("Tĩnh = không zoompan; pan/tilt/zoom có biểu thức riêng; chuyển động trải theo thời lượng giọng (d = số frame thật)", () => {
    expect(cameraZoompan({ move: "STATIC", speed: "SLOW" }, { durationSec: 5, target })).toBe("");
    const pan = cameraZoompan({ move: "PAN_RIGHT", speed: "SLOW" }, { durationSec: 5, target });
    expect(pan).toContain("d=121:"); // frames + 1 spare (the fps filter drops zoompan's last frame)
    expect(pan).toContain("on/119"); // eased over EVERY frame of the scene: no hold at the end
    expect(pan).toMatch(/x='\(iw-iw\/zoom\)\*/);
    const tilt = cameraZoompan({ move: "TILT_DOWN", speed: "SLOW" }, { durationSec: 3, target });
    expect(tilt).toMatch(/y='\(ih-ih\/zoom\)\*/);
    const longer = cameraZoompan({ move: "SLOW_ZOOM_IN", speed: "SLOW" }, { durationSec: 8, target });
    expect(longer).toContain("d=193:");
  });

  it("vùng an toàn: zoom có giới hạn; chủ thể bắt buộc → biên độ nhỏ hơn; orbit/crane dùng phương án local", () => {
    const zoomOf = (s: string) => Number(/z='1\+([\d.]+)\*/.exec(s)?.[1] ?? "0");
    expect(zoomOf(cameraZoompan({ move: "SLOW_ZOOM_IN", speed: "FAST" }, { durationSec: 4, target }))).toBeLessThanOrEqual(0.2);
    expect(zoomOf(cameraZoompan({ move: "SLOW_ZOOM_IN", speed: "FAST", critical: true }, { durationSec: 4, target }))).toBeLessThanOrEqual(0.08);
    expect(cameraZoompan({ move: "CRASH_ZOOM", speed: "FAST" }, { durationSec: 4, target })).toContain("z='1+0.3000*min(1,on/8)'");
    expect(renderableMove("ORBIT_LEFT")).toBe("TRUCK_LEFT");
    expect(renderableMove("CRANE_UP")).toBe("TILT_UP");
    const withCamera = buildSceneNormalizeArgs({ videoInput: "a.png", audioInput: null, duration: 4, target, output: "o.mp4", camera: { move: "ORBIT_RIGHT", speed: "SLOW" } });
    expect(withCamera[withCamera.indexOf("-filter_complex") + 1]).toMatch(/x='\(iw-iw\/zoom\)\*\(/);
    // A clip (Video AI) is never re-moved locally.
    const clip = buildSceneNormalizeArgs({ videoInput: "a.mp4", audioInput: null, duration: 4, target, output: "o.mp4", camera: { move: "PAN_LEFT", speed: "SLOW" } });
    expect(clip[clip.indexOf("-filter_complex") + 1]).not.toContain("zoompan");
  });

  it("ghép lớp trong MỘT graph: hậu cảnh (+camera, parallax) → ambient (screen, mờ) → tiền cảnh PNG trong suốt", () => {
    const args = buildLayeredSceneArgs({
      layers: { background: "bg.png", foreground: "fg.png", ambient: [{ path: "amb.mp4", opacity: 0.3 }] },
      audioInput: null,
      duration: 3,
      target,
      camera: { move: "PAN_RIGHT", speed: "SLOW" },
      output: "o.mp4",
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toMatch(/\[0:v\].*zoompan.*\[bg0\]/);
    expect(graph).toContain("blend=all_mode=screen:all_opacity=0.30");
    expect(graph).toMatch(/\[mix0\]\[fg\]overlay=/);
    expect(args.filter((a) => a === "-stream_loop")).toHaveLength(1);
  });
});

describe("LOCAL CAMERA (real FFmpeg render, $0)", () => {
  it("lia phải thật sự chuyển động; tĩnh thì đứng yên; thời lượng đúng", async () => {
    const pan = file("pan.mp4");
    await ffmpeg(buildSceneNormalizeArgs({ videoInput: file("still.png"), audioInput: null, duration: 2, target, output: pan, camera: { move: "PAN_RIGHT", speed: "MEDIUM" } }));
    expect(Math.abs((await probeDuration(pan)) - 2)).toBeLessThan(0.15);
    expect(meanDiff(await frameAt(pan, 0.05, file("p0.raw")), await frameAt(pan, 1.8, file("p1.raw")))).toBeGreaterThan(5);
    const still = file("static.mp4");
    await ffmpeg(buildSceneNormalizeArgs({ videoInput: file("still.png"), audioInput: null, duration: 2, target, output: still, camera: { move: "STATIC", speed: "SLOW" } }));
    expect(meanDiff(await frameAt(still, 0.1, file("s0.raw")), await frameAt(still, 1.8, file("s1.raw")))).toBeLessThan(1.5);
  }, 120_000);

  it("khổ thật 1080×1920: ảnh vào MỘT frame (không lặp) → render nhanh, không nổ số frame", async () => {
    const big = { width: 1080, height: 1920, fps: 30 };
    const args = buildSceneNormalizeArgs({ videoInput: file("still.png"), audioInput: null, duration: 4, target: big, output: file("big.mp4"), camera: { move: "PUSH_IN", speed: "SLOW" } });
    expect(args).not.toContain("-loop");
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("scale=3240:5760:flags=lanczos,format=gbrp,zoompan=");
    const t0 = Date.now();
    await ffmpeg(args);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(Math.abs((await probeDuration(file("big.mp4"))) - 4)).toBeLessThan(0.15);
    // V1 chain (no plan) still loops the picture, exactly as before.
    expect(buildSceneNormalizeArgs({ videoInput: "a.png", audioInput: null, duration: 4, target: big, output: "o.mp4" })).toContain("-loop");
  }, 120_000);

  it("ghép lớp thật: hậu cảnh + ambient loop + tiền cảnh trong suốt → MP4 đúng thời lượng", async () => {
    const out = file("layered.mp4");
    await ffmpeg(
      buildLayeredSceneArgs({
        layers: { background: file("still.png"), foreground: file("fg.png"), ambient: [{ path: file("amb.mp4"), opacity: 0.3 }] },
        audioInput: null,
        duration: 2,
        target,
        camera: { move: "PAN_LEFT", speed: "SLOW" },
        output: out,
      }),
    );
    expect(Math.abs((await probeDuration(out)) - 2)).toBeLessThan(0.15);
    expect(fs.statSync(out).size).toBeGreaterThan(1000);
  }, 120_000);
});
