import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSceneNormalizeArgs, renderProject } from "@/media/render";
import { ffmpeg, resolveFfmpeg } from "@/media/ffmpeg";
import { directVideo, type DirectorContext, type SceneSemantics } from "@/domain/camera-director";
import { renderInputsFor } from "@/services/scene-plan-service";

/**
 * FRAME PACING (local FFmpeg, $0). A camera move on a still must change the
 * picture on EVERY frame, by similar amounts, right up to the last frame:
 *  - no runs of near-identical frames inside the move (stepping / freeze),
 *  - no sudden large jumps,
 *  - still moving at the end (no early stop / hold before a cut or blend).
 * The fixture has no subtitles, so every pixel change is camera motion.
 */

const target = { width: 360, height: 640, fps: 30 };
let tmp = "";
const file = (n: string) => path.join(tmp, n);

/** Mean absolute difference between consecutive frames (90x160 grey). */
function frameDiffs(video: string): number[] {
  const W = 90;
  const H = 160;
  const raw = execFileSync(resolveFfmpeg()!, ["-hide_banner", "-loglevel", "error", "-i", video, "-vf", `scale=${W}:${H}:flags=area,format=gray`, "-f", "rawvideo", "-"], {
    maxBuffer: 1 << 28,
  });
  const n = raw.length / (W * H);
  const out: number[] = [];
  for (let i = 1; i < n; i += 1) {
    let s = 0;
    for (let p = 0; p < W * H; p += 1) s += Math.abs(raw[i * W * H + p]! - raw[(i - 1) * W * H + p]!);
    out.push(s / (W * H));
  }
  return out;
}

export function pacing(d: number[]) {
  const median = [...d].sort((a, b) => a - b)[Math.floor(d.length / 2)]!;
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const jerk = d.slice(1).reduce((a, v, i) => a + Math.abs(v - d[i]!), 0) / (d.length - 1) / mean;
  const tail = d.slice(-Math.ceil(d.length * 0.1));
  let run = 0;
  let stillRun = 0;
  for (const v of d) {
    run = v < median * 0.25 ? run + 1 : 0;
    stillRun = Math.max(stillRun, run);
  }
  return { median, jerk, maxJump: Math.max(...d) / median, tailRatio: tail.reduce((a, b) => a + b, 0) / tail.length / median, stillRun, last: d[d.length - 1]! };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smooth-"));
  // A detailed still (soft shapes + texture), like an illustration: motion is visible everywhere.
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=720x1280,gblur=sigma=2", "-frames:v", "1", file("still.png")]);
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "mandelbrot=s=720x1280", "-frames:v", "1", file("still2.png")]);
}, 60_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("FRAME PACING — camera trên ảnh tĩnh", () => {
  it.each([
    ["PUSH_IN", "VERY_SLOW"],
    ["SLOW_ZOOM_OUT", "SLOW"],
    ["PAN_RIGHT", "VERY_SLOW"],
    ["PULL_BACK", "SLOW"],
  ] as const)("%s %s: mỗi frame đều đổi, không bậc thang, không nhảy, vẫn chạy tới frame cuối", async (move, speed) => {
    const out = file(`${move}_${speed}.mp4`);
    await ffmpeg(buildSceneNormalizeArgs({ videoInput: file("still.png"), audioInput: null, duration: 3, target, output: out, camera: { move, speed } }));
    const p = pacing(frameDiffs(out));
    expect(p.stillRun).toBeLessThanOrEqual(3);
    expect(p.maxJump).toBeLessThan(2.5);
    expect(p.jerk).toBeLessThan(0.45);
    expect(p.tailRatio).toBeGreaterThan(0.3); // ease-out, not a stop
    expect(p.last).toBeGreaterThan(p.median * 0.15); // the very last frame still moves
  }, 120_000);

  it("ĐỐI CHỨNG: chuỗi cũ (phóng 1,33x trong YUV, smoothstep 92 % rồi giữ) bị phát hiện là giật + đứng cuối", async () => {
    const N = 90;
    const P = `min(1,on/${Math.round(N * 0.92) - 1})`;
    const E = `(${P}*${P}*(3-2*${P}))`;
    const out = file("old.mp4");
    await ffmpeg([
      "-y", "-hide_banner", "-loglevel", "error", "-i", file("still.png"),
      "-vf", `scale=360:640,scale=480:854,zoompan=z='1+0.0625*${E}':x='iw/2-(iw/zoom/2)':y='max(0,ih/2-(ih/zoom/2)-ih*0.008*${E})':d=${N}:s=360x640:fps=30,format=yuv420p`,
      "-frames:v", String(N), "-c:v", "libx264", "-crf", "20", out,
    ]);
    const p = pacing(frameDiffs(out));
    expect(p.tailRatio < 0.3 || p.stillRun > 3 || p.maxJump >= 2.5).toBe(true);
  }, 120_000);
});

describe("TRANSITION CONTINUITY — không đứng hình, không reset camera quanh chỗ chuyển", () => {
  it("cảnh trước vẫn chuyển động dưới crossfade (đuôi), cảnh sau bắt đầu chuyển động ngay; tổng thời lượng không đổi", async () => {
    const scene = (n: number, image: string, extra: object = {}) => ({
      sceneNumber: n,
      duration: 2.5,
      subtitle: "",
      videoPath: null,
      audioPath: null,
      imagePath: file(image),
      durationMode: "LOCKED" as const,
      localCamera: { move: "PUSH_IN" as const, speed: "SLOW" as const },
      subjects: [`S${n}`],
      ...extra,
    });
    const r = await renderProject({
      projectId: `smooth-${Date.now()}`,
      scenes: [scene(1, "still.png"), scene(2, "still2.png", { transitionIn: "CROSSFADE" })],
      target,
      burnSubtitles: false,
    });
    expect(r.transitionsApplied).toBe(1);
    expect(Math.abs(r.durationSeconds - r.finalTotal)).toBeLessThan(0.1);
    const d = frameDiffs(r.videoPath);
    const boundary = Math.round(r.sceneTimings[0]!.finalDuration * target.fps);
    // The 0.4 s before the blend and the 0.3 s after it: every frame changes.
    const around = d.slice(boundary - 12, boundary + 9);
    const quiet = around.filter((v) => v < 0.02).length;
    expect(quiet).toBe(0);
  }, 240_000);
});

describe("CAMERA DIRECTOR — đa dạng + liên tục", () => {
  const ctx: DirectorContext = {
    comedyLevel: 1,
    tone: "WARM",
    emotion: "NEUTRAL",
    pacing: "NORMAL",
    creativePreset: "AUTO",
    cameraPreset: "AUTO",
    width: 1080,
    height: 1920,
  };
  const s = (n: number, extra: Partial<SceneSemantics> = {}): SceneSemantics => ({
    sceneNumber: n,
    dialogue: "Leo: I am fine.",
    visualDescription: "Leo stands in a bright room.",
    charactersPresent: ["Leo"],
    speakingCharacters: ["Leo"],
    duration: 3,
    ...extra,
  });

  it("không có hai cảnh ảnh tĩnh liền nhau cùng kiểu chuyển động (đẩy, đẩy...)", () => {
    const plans = directVideo([s(1), s(2), s(3), s(4), s(5)], ctx).map((x) => x.plan.cameraMovement);
    const family = (m: string) => (/PUSH_IN|ZOOM_IN|DOLLY_IN/.test(m) ? "IN" : /ZOOM_OUT|PULL_BACK|DOLLY_OUT/.test(m) ? "OUT" : /PAN|TRUCK|TRACK/.test(m) ? "LAT" : m);
    for (let i = 1; i < plans.length; i += 1) expect(family(plans[i]!)).not.toBe(family(plans[i - 1]!));
  });

  it("clip gốc (Video AI) không tính vào chuỗi và không nhận camera tại máy", () => {
    const plans = directVideo([s(1), s(2, { nativeClip: true }), s(3)], ctx);
    expect(plans[1]!.plan.reason).toContain("Clip gốc");
    const plan = JSON.stringify({ source: "AUTO", camera: plans[1]!.plan, layers: [], route: "LOCAL_MOTION" });
    expect(renderInputsFor({ scenePlanJson: plan, imagePath: null, videoPath: "clip.mp4" }).localCamera).toBeUndefined();
  });

  it("cảnh cảm xúc cùng nhân vật với cảnh trước → CẮT, không hoà tan", () => {
    const emotional = { sceneRole: "moment", visualDescription: "Leo looks sad and quiet." };
    const same = directVideo([s(1), s(2, emotional)], ctx);
    expect(same[1]!.plan.transitionIn).toBe("CUT");
  });
});
