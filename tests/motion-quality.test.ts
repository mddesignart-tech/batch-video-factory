import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAMERA_MOVES } from "@/domain/camera-grammar";
import { controlsOf, mergeControls } from "@/domain/output-controls";
import { DEFAULT_NEW_PROJECT_MOTION_QUALITY, MOTION_QUALITY_INFO } from "@/domain/motion-quality";
import { cameraExpressions, cameraPerspective, cameraZoompan, perspectiveCorners, type LocalCameraSpec } from "@/media/camera-motion";
import { buildSceneNormalizeArgs, DEFAULT_TARGET, renderProject, type RenderRequest, type RenderScene } from "@/media/render";
import { ffmpeg, ffmpegAvailable, ffprobe } from "@/media/ffmpeg";
import { renderRecipeHash } from "@/services/render-recipe";
import { newProjectControlsJson } from "@/services/audio-mixer-service";
import { projectSubdir, toAbsolute } from "@/lib/paths";

/**
 * QĐ-151 LOCAL_MOTION V2. Legacy must stay byte for byte; V2 must render every
 * camera move from the SAME expressions, without frozen frames, black edges or
 * a different clock. Real FFmpeg on synthetic pictures, $0.
 */

const hasFfmpeg = ffmpegAvailable();
const TAG = "qd151-motion";
let root = "";

/** A detailed synthetic picture (gradient + grid + noise) so motion is measurable. */
async function picture(file: string, w: number, h: number): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=s=${w}x${h}:d=1`,
    "-frames:v", "1", file,
  ]);
}

/** Gray frames of a video, decoded at a small size. */
async function grayFrames(file: string, w = 108, h = 192): Promise<Float32Array[]> {
  const raw = path.join(root, `f-${Math.random().toString(36).slice(2)}.raw`);
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-i", file, "-vf", `scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", raw]);
  const buf = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  const n = w * h;
  const out: Float32Array[] = [];
  for (let i = 0; i + n <= buf.length; i += n) out.push(Float32Array.from(buf.subarray(i, i + n)));
  return out;
}

const mad = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
};

async function streamFacts(file: string): Promise<{ frames: number; rate: string; w: number; h: number; audio: boolean }> {
  const v = (await ffprobe(["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames,r_frame_rate,width,height", "-of", "csv=p=0", file])).stdout.trim().split(",");
  const a = (await ffprobe(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", file])).stdout.trim();
  return { w: Number(v[0]), h: Number(v[1]), rate: v[2]!, frames: Number(v[3]), audio: a.length > 0 };
}

beforeAll(() => {
  root = toAbsolute(projectSubdir(`${TAG}-scratch`, "temp"));
  fs.mkdirSync(root, { recursive: true });
});

afterAll(() => {
  for (const id of [`${TAG}-scratch`, `${TAG}-render-v2`, `${TAG}-render-169`]) {
    fs.rmSync(path.dirname(toAbsolute(projectSubdir(id, "temp"))), { recursive: true, force: true });
  }
});

describe("QĐ-151 Motion Quality - pure", () => {
  const spec: LocalCameraSpec = { move: "TILT_UP", speed: "SLOW", easing: "EASE_IN_OUT" };
  const opts = { durationSec: 7, target: DEFAULT_TARGET };

  it("LEGACY zoompan is byte for byte what production built before QĐ-151", () => {
    expect(cameraZoompan(spec, opts)).toBe(
      ",scale=3240:5760:flags=lanczos,format=gbrp,zoompan=z='1.0800':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-(0.4*min(1,on/209)+0.6*(0.5-0.5*cos(PI*min(1,on/209)))))':d=211:s=1080x1920:fps=30",
    );
    expect(cameraZoompan({ move: "STATIC", speed: "SLOW" }, opts)).toBe("");
  });

  it("V2 uses the SAME expressions, normalised, with the frame counter from 1 and the window kept inside", () => {
    const e = cameraExpressions(spec, opts)!;
    const corners = perspectiveCorners(e);
    expect(corners).toContain("min(1,(on-1)/209)");
    expect(corners).not.toMatch(/\biw\b|\bih\b|\bzoom\b/);
    expect(corners).toContain("max(0,min(1-1/ld(2),");
    expect(cameraPerspective(spec, { ...opts, quality: "SMOOTH_V2" })).toMatch(/^,format=gbrp,perspective=.*interpolation=cubic:eval=frame$/);
    expect(cameraPerspective(spec, { ...opts, quality: "HQ_V2" })).toMatch(/^,scale=2160:3840:flags=lanczos,format=gbrp,perspective=.*,scale=1080:1920:flags=lanczos$/);
    expect(cameraPerspective({ move: "STATIC", speed: "SLOW" }, { ...opts, quality: "SMOOTH_V2" })).toBe("");
  });

  it("every camera move (and the speaker lean) has a V2 path", () => {
    for (const move of CAMERA_MOVES) {
      const e = cameraExpressions({ move, speed: "SLOW" }, opts);
      if (move === "STATIC") expect(e).toBeNull();
      else expect(perspectiveCorners(e!)).not.toMatch(/\biw\b|\bzoom\b/);
    }
    const lean = cameraExpressions({ move: "STATIC", speed: "SLOW", speakerBias: [{ atSec: 0, side: -1 }, { atSec: 2, side: 1 }] }, opts);
    expect(lean).not.toBeNull();
  });

  it("scene args: LEGACY / absent identical; V2 feeds a frame stream; clips and stills without a plan are untouched", () => {
    const base = { videoInput: "a.png", audioInput: null, duration: 7, target: DEFAULT_TARGET, output: "o.mp4", camera: spec };
    expect(buildSceneNormalizeArgs({ ...base, motionQuality: "LEGACY" })).toEqual(buildSceneNormalizeArgs(base));
    const v2 = buildSceneNormalizeArgs({ ...base, motionQuality: "SMOOTH_V2" });
    expect(v2.slice(4, 11)).toEqual(["-loop", "1", "-framerate", "30", "-t", "7.5", "-i"]);
    expect(v2.join(" ")).toContain("perspective=");
    expect(v2.join(" ")).not.toContain("zoompan");
    const noPlan = { videoInput: "a.png", audioInput: null, duration: 7, target: DEFAULT_TARGET, output: "o.mp4" };
    expect(buildSceneNormalizeArgs({ ...noPlan, motionQuality: "SMOOTH_V2" })).toEqual(buildSceneNormalizeArgs(noPlan));
    const clip = { ...noPlan, videoInput: "c.mp4", clip: { startSec: 0, lengthSec: 3 } };
    expect(buildSceneNormalizeArgs({ ...clip, motionQuality: "HQ_V2" })).toEqual(buildSceneNormalizeArgs(clip));
  });

  it("render recipe: LEGACY keeps an old project's recipe; V2 changes it", () => {
    const req: RenderRequest = { projectId: "p", scenes: [], target: DEFAULT_TARGET, burnSubtitles: false };
    const before = renderRecipeHash(req);
    expect(renderRecipeHash({ ...req, motionQuality: "LEGACY" })).toBe(before);
    expect(renderRecipeHash({ ...req, motionQuality: "SMOOTH_V2" })).not.toBe(before);
    expect(renderRecipeHash({ ...req, motionQuality: "HQ_V2" })).not.toBe(renderRecipeHash({ ...req, motionQuality: "SMOOTH_V2" }));
  });

  it("old projects read LEGACY; a person can switch and go back; new projects take Settings (never HQ)", () => {
    const old = controlsOf({ contentType: null, outputControlsJson: JSON.stringify({ audio: { narrationVolume: 1.2 } }) });
    expect(old.motion.quality).toBe("LEGACY");
    const up = mergeControls(old, { motion: { quality: "SMOOTH_V2" } });
    expect(up.motion.quality).toBe("SMOOTH_V2");
    expect(up.audio.narrationVolume).toBe(1.2);
    expect(mergeControls(up, { motion: { quality: "LEGACY" } }).motion.quality).toBe("LEGACY");
    expect(DEFAULT_NEW_PROJECT_MOTION_QUALITY).toBe("SMOOTH_V2");
    const json = JSON.parse(newProjectControlsJson({ audioPresets: [], newProjectAudioPresetId: null, newProjectMotionQuality: "SMOOTH_V2" })!);
    expect(json).toEqual({ motion: { quality: "SMOOTH_V2" } });
    expect(newProjectControlsJson({ audioPresets: [], newProjectAudioPresetId: null, newProjectMotionQuality: "LEGACY" })).toBeNull();
    expect(MOTION_QUALITY_INFO.HQ_V2.hint).toMatch(/lâu hơn/);
  });
});

describe.skipIf(!hasFfmpeg)("QĐ-151 Motion Quality - real FFmpeg", () => {
  let still = "";
  beforeAll(async () => {
    still = path.join(root, "still.png");
    await picture(still, 800, 1200);
  });

  it("all 27 camera moves + lean render with V2: right frame count, no frozen frames mid-move, same travel as legacy", async () => {
    const target = { width: 270, height: 480, fps: 30 };
    const holds = new Set(["WHIP_PAN", "CRASH_ZOOM"]); // designed: a quick move, then they hold
    const cases: { name: string; spec: LocalCameraSpec }[] = [
      ...CAMERA_MOVES.filter((m) => m !== "STATIC").map((move) => ({ name: move, spec: { move, speed: "MEDIUM" as const } })),
      { name: "SPEAKER_LEAN", spec: { move: "SLOW_ZOOM_IN", speed: "SLOW", speakerBias: [{ atSec: 0, side: -1 }, { atSec: 1, side: 1 }] } },
    ];
    for (const c of cases) {
      const out = path.join(root, `m-${c.name}.mp4`);
      const legacyOut = path.join(root, `l-${c.name}.mp4`);
      const base = { videoInput: still, audioInput: null, duration: 2, target, camera: c.spec };
      await ffmpeg(buildSceneNormalizeArgs({ ...base, output: out, motionQuality: "SMOOTH_V2" }));
      await ffmpeg(buildSceneNormalizeArgs({ ...base, output: legacyOut }));
      const f = await grayFrames(out, 90, 160);
      const l = await grayFrames(legacyOut, 90, 160);
      expect(f.length, c.name).toBe(60);
      if (!holds.has(c.name)) {
        const still0 = f.slice(1).map((x, i) => mad(x, f[i]!)).filter((d) => d < 0.01).length;
        expect(still0, `${c.name}: frozen frames`).toBeLessThanOrEqual(1);
      }
      // Same path: first and last frames match the legacy render closely.
      expect(mad(f[0]!, l[0]!), `${c.name}: first frame`).toBeLessThan(6);
      expect(mad(f[59]!, l[59]!), `${c.name}: last frame`).toBeLessThan(6);
    }
  });

  it("V2 removes the wobble: frame-to-frame change of a slow pan is far steadier than legacy", async () => {
    // Production conditions (1080x1920), a non-repeating texture (no "pixel locking" of the measurement).
    const noise = path.join(root, "noise.png");
    await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "nullsrc=s=1024x1536,geq=lum='random(1)*255':cb=128:cr=128,gblur=sigma=2", "-frames:v", "1", noise]);
    const target = { width: 1080, height: 1920, fps: 30 };
    const base = { videoInput: noise, audioInput: null, duration: 3, target, camera: { move: "PAN_RIGHT" as const, speed: "SLOW" as const, easing: "LINEAR" as const } };
    const a = path.join(root, "pan-legacy.mp4");
    const b = path.join(root, "pan-v2.mp4");
    await ffmpeg(buildSceneNormalizeArgs({ ...base, output: a }));
    await ffmpeg(buildSceneNormalizeArgs({ ...base, output: b, motionQuality: "SMOOTH_V2" }));
    // Horizontal shift of each frame vs the previous one, sub-pixel: cross-correlate
    // the column profiles and fit a parabola at the peak. A LINEAR pan should move
    // the same amount every frame; the spread of the shifts is the wobble.
    const spread = async (file: string) => {
      const W = 1080;
      const H = 480; // a band of rows is enough and keeps it quick
      const f = await grayFrames(file, W, 1920);
      const prof = f.map((fr) => {
        const p = new Float64Array(W);
        for (let y = 720; y < 720 + H; y += 1) for (let x = 0; x < W; x += 1) p[x]! += fr[y * W + x]!;
        const m = p.reduce((s, v) => s + v, 0) / W;
        return p.map((v) => v - m);
      });
      const shifts: number[] = [];
      for (let i = 1; i < prof.length; i += 1) {
        const a = prof[i - 1]!;
        const b = prof[i]!;
        const corr = (k: number) => {
          let s = 0;
          for (let x = 40; x < W - 40; x += 1) s += a[x]! * b[x - k]!;
          return s;
        };
        let best = 0;
        for (let k = -6; k <= 6; k += 1) if (corr(k) > corr(best)) best = k;
        const l = corr(best - 1), c = corr(best), r = corr(best + 1);
        shifts.push(best + (l - r) / (2 * (l - 2 * c + r)));
      }
      const d = shifts.slice(5, -5);
      const mean = d.reduce((s, x) => s + x, 0) / d.length;
      return Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / d.length) / Math.abs(mean);
    };
    const cvLegacy = await spread(a);
    const cvV2 = await spread(b);
    expect(cvV2).toBeLessThan(cvLegacy / 2);
  });

  async function scenes(projectId: string, n: number, moves: LocalCameraSpec["move"][], size: [number, number]): Promise<RenderScene[]> {
    const out: RenderScene[] = [];
    for (let i = 1; i <= n; i += 1) {
      const img = toAbsolute(path.join(projectSubdir(projectId, "images"), `s${i}.png`));
      await picture(img, size[0], size[1]);
      const line = toAbsolute(path.join(projectSubdir(projectId, "audio"), `l${i}.wav`));
      fs.mkdirSync(path.dirname(line), { recursive: true });
      await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=${300 + i * 20}:duration=1.2`, "-af", "volume=0.3", "-ar", "24000", "-ac", "1", line]);
      out.push({
        sceneNumber: i,
        duration: 2,
        subtitle: `Câu ${i}`,
        videoPath: null,
        imagePath: img,
        audioPath: null,
        motionSource: "LOCAL_MOTION",
        localCamera: { move: moves[(i - 1) % moves.length]!, speed: "SLOW", easing: "EASE_IN_OUT" },
        dialogueLines: [{ lineNumber: 1, speaker: "Narrator", text: `Câu ${i}`, audioPath: line, durationSec: 1.2, pauseAfterMs: 400 }],
      } as RenderScene);
    }
    return out;
  }

  it("a 6-scene 9:16 video with subtitles and mixed cameras: every still on V2, CFR, audio present, timing as legacy", async () => {
    const id = `${TAG}-render-v2`;
    const moves: LocalCameraSpec["move"][] = ["PAN_RIGHT", "SLOW_ZOOM_IN", "TILT_UP", "DOLLY_IN", "HANDHELD_SOFT", "TRACK_LEFT"];
    const sc = await scenes(id, 6, moves, [720, 1280]);
    const target = { width: 540, height: 960, fps: 30 };
    const legacy = await renderProject({ projectId: id, scenes: sc, target, burnSubtitles: true });
    const v2 = await renderProject({ projectId: id, scenes: sc, target, burnSubtitles: true, motionQuality: "SMOOTH_V2" });
    expect(v2.motion?.v2Scenes).toEqual([1, 2, 3, 4, 5, 6]);
    expect(v2.motion?.fallbacks).toEqual([]);
    expect(legacy.motion?.v2Scenes).toEqual([]);
    expect(v2.finalTotal).toBe(legacy.finalTotal);
    expect(v2.sceneTimings.map((t) => t.finalDuration)).toEqual(legacy.sceneTimings.map((t) => t.finalDuration));
    const fa = await streamFacts(v2.videoPath);
    expect(fa.rate).toBe("30/1");
    expect(fa.audio).toBe(true);
    expect(Math.abs(fa.frames - Math.round(v2.durationSeconds * 30))).toBeLessThanOrEqual(1);
    expect(v2.subtitlesBurned).toBe(legacy.subtitlesBurned);
  });

  it("16:9 output with a portrait picture: V2 fills the frame (no black edges)", async () => {
    const id = `${TAG}-render-169`;
    const sc = await scenes(id, 2, ["PAN_LEFT", "DOLLY_OUT"], [800, 1200]);
    const target = { width: 640, height: 360, fps: 30 };
    const r = await renderProject({ projectId: id, scenes: sc, target, burnSubtitles: false, fit: "COVER", motionQuality: "SMOOTH_V2" });
    expect(r.motion?.v2Scenes).toEqual([1, 2]);
    const f = await grayFrames(r.videoPath, 160, 90);
    for (const frame of [f[0]!, f[Math.floor(f.length / 2)]!, f[f.length - 1]!]) {
      // testsrc2 has no black at the edges: a black column / row would mean an empty border.
      const col = (x: number) => Array.from({ length: 90 }, (_, y) => frame[y * 160 + x]!).reduce((s, v) => s + v, 0) / 90;
      const row = (y: number) => Array.from({ length: 160 }, (_, x) => frame[y * 160 + x]!).reduce((s, v) => s + v, 0) / 160;
      expect(Math.min(col(0), col(159), row(0), row(89))).toBeGreaterThan(8);
    }
  });
});
