import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AMBIENT_LOOP, buildAmbientLoopArgs, GENERATED_AMBIENT_KINDS } from "@/media/ambient-generate";
import { buildLayeredSceneArgs } from "@/media/camera-motion";
import { ffmpeg, probeDuration } from "@/media/ffmpeg";

/** Procedural ambient loops + screen blend in the sky band. Local FFmpeg only, $0. */

const target = { width: 180, height: 320, fps: 24 };
let tmp = "";
const file = (n: string) => path.join(tmp, n);

/** Mean grey level of a horizontal band of one frame (rows from..to of a 18x32 thumbnail). */
async function bandLuma(video: string, sec: number, from: number, to: number): Promise<number> {
  const out = file(`b_${Math.random().toString(36).slice(2)}.gray`);
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-ss", String(sec), "-i", video, "-frames:v", "1", "-vf", "scale=18:32,format=gray", "-f", "rawvideo", out]);
  const rows = fs.readFileSync(out).subarray(from * 18, to * 18);
  return rows.reduce((n, v) => n + v, 0) / rows.length;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amb-"));
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x406080:s=360x640", "-frames:v", "1", file("bg.png")]);
  // A pure-black "loop": screen-blending it must change nothing.
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=1", "-pix_fmt", "yuv420p", file("black.mp4")]);
}, 60_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("AMBIENT LOOPS (tạo tại máy)", () => {
  it("có công thức cho mây / khói / hơi nước / đèn / nước; loại lạ bị từ chối", () => {
    expect(GENERATED_AMBIENT_KINDS).toEqual(expect.arrayContaining(["clouds", "smoke", "steam", "lights", "water"]));
    expect(() => buildAmbientLoopArgs("unicorns", "x.mp4")).toThrow();
  });

  it("chuyển động tuần hoàn đúng một vòng mỗi loop (lặp không giật)", () => {
    for (const kind of GENERATED_AMBIENT_KINDS) {
      const vf = buildAmbientLoopArgs(kind, "x.mp4")[buildAmbientLoopArgs(kind, "x.mp4").indexOf("-vf") + 1]!;
      expect(vf).toContain(`(2*PI*T/${AMBIENT_LOOP.seconds})`);
    }
  });

  it("mây: render thật, đúng thời lượng, sáng trên nền đen (nửa dưới gần như đen)", async () => {
    const out = file("clouds.mp4");
    await ffmpeg(buildAmbientLoopArgs("clouds", out), { timeoutMs: 120_000 });
    expect(Math.abs((await probeDuration(out)) - AMBIENT_LOOP.seconds)).toBeLessThan(0.1);
    // Bottom = video black (limited range reads ~8-16 here); the sky band is clearly brighter.
    expect(await bandLuma(out, 1, 0, 8)).toBeGreaterThan((await bandLuma(out, 1, 20, 32)) + 10);
  }, 120_000);
});

describe("AMBIENT vùng trời (TOP) — blend screen", () => {
  it("graph: dải trên được cắt ra, screen-blend rồi đặt lại (không còn overlay alpha làm tối)", () => {
    const args = buildLayeredSceneArgs({
      layers: { background: "bg.png", foreground: null, ambient: [{ path: "a.mp4", opacity: 0.3, region: "TOP" }] },
      audioInput: null,
      duration: 2,
      target,
      camera: { move: "STATIC", speed: "SLOW" },
      output: "o.mp4",
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[top0][amb0]blend=all_mode=screen:all_opacity=0.30,format=yuv420p[lit0]");
    expect(graph).toContain("crop=180:96:0:0,format=gbrp[top0]");
    expect(graph).not.toContain("colorchannelmixer=aa=");
  });

  it("loop đen trong vùng trời không làm tối ảnh", async () => {
    const plain = file("plain.mp4");
    const layered = file("layered.mp4");
    const common = { audioInput: null, duration: 1, target, camera: { move: "STATIC" as const, speed: "SLOW" as const } };
    await ffmpeg(buildLayeredSceneArgs({ ...common, layers: { background: file("bg.png"), foreground: null, ambient: [] }, output: plain }));
    await ffmpeg(
      buildLayeredSceneArgs({ ...common, layers: { background: file("bg.png"), foreground: null, ambient: [{ path: file("black.mp4"), opacity: 0.3, region: "TOP" }] }, output: layered }),
    );
    expect(Math.abs((await bandLuma(layered, 0.5, 0, 9)) - (await bandLuma(plain, 0.5, 0, 9)))).toBeLessThan(3);
  }, 60_000);
});
