import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAlphaAmbientLoopArgs, GENERATED_ALPHA_KINDS } from "@/media/ambient-generate";
import { buildLayeredSceneArgs } from "@/media/camera-motion";
import { ffmpeg, resolveFfmpeg } from "@/media/ffmpeg";
import { AMBIENT_DIR, ambientLoopFor, videoHasAlpha } from "@/services/ambient-library";
import { renderInputsFor } from "@/services/scene-plan-service";
import { DATA_ROOT, toRelative } from "@/lib/paths";

/** G3 — TRANSPARENT AMBIENT LOOPS (cars, passers-by, birds, leaves). Local FFmpeg, $0. */

let tmp = "";
const file = (n: string) => path.join(tmp, n);
const target = { width: 360, height: 640, fps: 30 };

/** One frame as RGB rows (90 x 160). */
function frame(video: string, sec: number): Buffer {
  return execFileSync(resolveFfmpeg()!, ["-hide_banner", "-loglevel", "error", "-ss", String(sec), "-i", video, "-frames:v", "1", "-vf", "scale=90:160,format=rgb24", "-f", "rawvideo", "-"]);
}
const isSky = (b: Buffer, i: number) => Math.abs(b[i]! - 0x40) < 25 && Math.abs(b[i + 1]! - 0x80) < 25 && Math.abs(b[i + 2]! - 0xd0) < 25;

beforeAll(async () => {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  tmp = fs.mkdtempSync(path.join(DATA_ROOT, "ambient-alpha-test-"));
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x4080d0:s=720x1280", "-frames:v", "1", file("sky.png")]);
  // A transparent loop: a dark square crossing the band (QuickTime Animation, alpha kept).
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black@0.0:s=360x60:r=30:d=1",
    "-vf", "format=rgba,geq=r='20':g='20':b='20':a='255*lt(abs(X-mod(T*360,360)),20)*between(Y,10,50)'",
    "-c:v", "qtrle", file("cars.mov"),
  ]);
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=360x60:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", file("glow.mp4")]);
  await ffmpeg(buildAlphaAmbientLoopArgs("birds", file("birds.webm")), { timeoutMs: 120_000 });
}, 180_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("G3 — nhận biết loop trong suốt", () => {
  it("webm VP9 alpha và mov qtrle → có alpha; mp4 thường → không (screen)", () => {
    expect(videoHasAlpha(file("birds.webm"))).toBe(true);
    expect(videoHasAlpha(file("cars.mov"))).toBe(true);
    expect(videoHasAlpha(file("glow.mp4"))).toBe(false);
  });

  it("thư viện ưu tiên file trong suốt khi cùng tên; dải theo loại (xe → HORIZON)", () => {
    fs.mkdirSync(AMBIENT_DIR, { recursive: true });
    fs.copyFileSync(file("glow.mp4"), path.join(AMBIENT_DIR, "traffic.mp4"));
    fs.copyFileSync(file("cars.mov"), path.join(AMBIENT_DIR, "traffic.mov"));
    try {
      expect(ambientLoopFor("traffic")).toMatchObject({ alpha: true, band: "HORIZON" });
      expect(ambientLoopFor("traffic")!.path.endsWith(".mov")).toBe(true);
    } finally {
      fs.rmSync(path.join(AMBIENT_DIR, "traffic.mp4"), { force: true });
      fs.rmSync(path.join(AMBIENT_DIR, "traffic.mov"), { force: true });
    }
  });

  it("có công thức tạo loop trong suốt cho xe / người đi bộ / chim / lá", () => {
    expect(GENERATED_ALPHA_KINDS).toEqual(expect.arrayContaining(["traffic", "pedestrians", "birds", "leaves"]));
    const args = buildAlphaAmbientLoopArgs("traffic", "x.webm");
    expect(args).toContain("libvpx-vp9");
    expect(args).toContain("yuva420p");
  });
});

describe("G3 — ghép vào cảnh", () => {
  it("graph: webm dùng libvpx (giữ alpha); loop trong suốt nằm SAU tiền cảnh, đặt theo dải", () => {
    const args = buildLayeredSceneArgs({
      layers: { background: "bg.png", foregrounds: [{ path: "a.png" }], ambient: [{ path: "b.webm", alpha: true, band: "HORIZON" }] },
      audioInput: null,
      duration: 2,
      target,
      camera: { move: "STATIC", speed: "SLOW" },
      output: "o.mp4",
    });
    expect(args[args.indexOf("b.webm") - 1]).toBe("-i");
    expect(args[args.indexOf("b.webm") - 2]).toBe("libvpx-vp9");
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("overlay=x=0:y='384-h'"); // horizon at 60 % of a 9:16 frame
    expect(graph.indexOf("[mix0]")).toBeLessThan(graph.indexOf("[fgc]"));
  });

  it("render thật: vật thể trong suốt chạy qua dải trời, phần còn lại của nền giữ nguyên", async () => {
    const out = file("sky.mp4");
    await ffmpeg(
      buildLayeredSceneArgs({
        layers: { background: file("sky.png"), ambient: [{ path: file("cars.mov"), alpha: true, band: "SKY" }] },
        audioInput: null,
        duration: 1,
        target,
        camera: { move: "STATIC", speed: "SLOW" },
        output: out,
      }),
    );
    const f = frame(out, 0.5);
    let dark = 0;
    for (let y = 0; y < 30; y += 1) for (let x = 0; x < 90; x += 1) if (f[(y * 90 + x) * 3]! < 60) dark += 1;
    expect(dark).toBeGreaterThan(0); // the "car" is drawn in the sky band
    const bottom = (150 * 90 + 45) * 3;
    expect(isSky(f, bottom)).toBe(true); // nothing drawn outside the band
  }, 60_000);

  it("an toàn: chưa có lớp chủ thể tách nền → chỉ ambient trên trời; có chủ thể → cả xe/người ở xa", () => {
    fs.mkdirSync(AMBIENT_DIR, { recursive: true });
    fs.copyFileSync(file("cars.mov"), path.join(AMBIENT_DIR, "traffic.mov"));
    fs.copyFileSync(file("birds.webm"), path.join(AMBIENT_DIR, "birds.webm"));
    try {
      const amb = (id: string) => ({ id: `amb-${id}`, layerType: "AMBIENT", zIndex: 15, label: id, entityType: "EFFECT", motionType: "AMBIENT_VIDEO", depth: 0.75 });
      const plan = (route: string, extra: object[] = []) =>
        JSON.stringify({ source: "AUTO", route, camera: { shotSize: "MEDIUM", cameraAngle: "EYE_LEVEL", cameraMovement: "PUSH_IN" }, layers: [amb("traffic"), amb("birds"), ...extra] });
      const scene = { imagePath: toRelative(file("sky.png")), videoPath: null };
      const alone = renderInputsFor({ ...scene, scenePlanJson: plan("LOCAL_MOTION") });
      expect(alone.layers?.ambient?.map((a) => a.band)).toEqual(["SKY"]);
      fs.copyFileSync(file("sky.png"), file("fg.png"));
      // a real transparent subject
      execFileSync(resolveFfmpeg()!, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red@0.5:s=40x80,format=rgba", "-frames:v", "1", file("fg.png")]);
      const fg = { id: "fg-1", layerType: "FOREGROUND", zIndex: 40, label: "Leo", entityType: "CHARACTER", depth: 0.1, assetPath: toRelative(file("fg.png")) };
      const withSubject = renderInputsFor({ ...scene, scenePlanJson: plan("COMPOSITE", [fg]) });
      expect(withSubject.layers?.ambient?.map((a) => a.band).sort()).toEqual(["HORIZON", "SKY"]);
    } finally {
      fs.rmSync(path.join(AMBIENT_DIR, "traffic.mov"), { force: true });
      fs.rmSync(path.join(AMBIENT_DIR, "birds.webm"), { force: true });
    }
  });
});
