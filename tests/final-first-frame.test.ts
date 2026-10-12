import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpeg, ffprobe, supportsSubtitleBurn } from "@/media/ffmpeg";
import { buildFinalArgs, buildFinalWithMixArgs, finalVideoFilter, renderProject, type RenderClip, type RenderScene } from "@/media/render";
import { projectSubdir, toAbsolute } from "@/lib/paths";

/**
 * FINAL ENCODE - FIRST FRAME (V1 bug). A hard-cut join (concat demuxer, stream
 * copy) left the joined picture starting at +0.021 s (the AAC priming of each
 * scene file), and the final pass at a constant -r filled the gap with a copy
 * of the first frame: 91 frames for a 3 s video, everything one frame late, and
 * on the dialogue path the LAST real frame cut off by -shortest. Local FFmpeg
 * only, no provider.
 */

const PROJECT = "final-first-frame-test";
const FPS = 30;
const target = { width: 320, height: 568, fps: FPS };
let root = "";
const f = (name: string) => path.join(root, name);
const q = ["-y", "-hide_banner", "-loglevel", "error"];

const W = 32;
const H = 18;

/** Mean brightness of every decoded frame. */
async function frameMeans(file: string): Promise<number[]> {
  const raw = f(`m-${Math.random().toString(36).slice(2)}.raw`);
  await ffmpeg([...q, "-i", file, "-map", "0:v:0", "-vf", `scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "gray", raw]);
  const buf = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  const out: number[] = [];
  for (let i = 0; i < buf.length / (W * H); i += 1) {
    let s = 0;
    for (let p = 0; p < W * H; p += 1) s += buf[i * W * H + p] ?? 0;
    out.push(s / (W * H));
  }
  return out;
}

/** Mean absolute difference between consecutive decoded frames (64x36 gray). */
async function frameDiffs(file: string): Promise<number[]> {
  const raw = f(`d-${Math.random().toString(36).slice(2)}.raw`);
  const w = 64;
  const h = 36;
  await ffmpeg([...q, "-i", file, "-map", "0:v:0", "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "gray", raw]);
  const buf = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  const n = Math.floor(buf.length / (w * h));
  const out: number[] = [];
  for (let i = 1; i < n; i += 1) {
    let d = 0;
    for (let p = 0; p < w * h; p += 1) d += Math.abs((buf[i * w * h + p] ?? 0) - (buf[(i - 1) * w * h + p] ?? 0));
    out.push(d / (w * h));
  }
  return out;
}

/** Frame count, first/last video PTS and container duration. */
async function videoClock(file: string) {
  const { stdout } = await ffprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time:format=duration", "-of", "json", file]);
  const j = JSON.parse(stdout) as { packets: { pts_time: string }[]; format: { duration: string } };
  const pts = j.packets.map((p) => Number(p.pts_time)).sort((a, b) => a - b);
  return { frames: pts.length, firstPts: pts[0]!, lastPts: pts[pts.length - 1]!, duration: Number(j.format.duration) };
}

/** Start of every flash (frame index whose mean jumps above 200). */
const flashFrames = (means: number[]) => means.flatMap((v, i) => (v > 200 && !((means[i - 1] ?? 0) > 200) ? [i] : []));

/** Where sound starts after silence, in seconds. */
async function soundStarts(file: string): Promise<number[]> {
  const { stderr } = await ffmpeg(["-hide_banner", "-i", file, "-map", "0:a:0", "-af", "silencedetect=n=-30dB:d=0.3", "-f", "null", "-"]);
  return [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
}

const clip = (lengthSec: number, extra: Partial<RenderClip> = {}): RenderClip => ({ startSec: 0, lengthSec, shortMode: "AUTO", frame: "AUTO", audioGain: null, ...extra });

const scene = (n: number, over: Partial<RenderScene>): RenderScene => ({
  sceneNumber: n,
  duration: 3,
  subtitle: "",
  videoPath: null,
  audioPath: null,
  imagePath: null,
  durationMode: "LOCKED",
  ...over,
});

const render = (scenes: RenderScene[], burnSubtitles = false) => renderProject({ projectId: PROJECT, scenes, target, burnSubtitles });

beforeAll(async () => {
  root = toAbsolute(projectSubdir(PROJECT, "temp"));
  fs.mkdirSync(root, { recursive: true });
  // Moving picture, white flash on source frames 30-32 (t = 1.000 s).
  await ffmpeg([...q, "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=3", "-vf", "drawbox=x=0:y=0:w=iw:h=ih:c=white:t=fill:enable='between(n,30,32)'", "-c:v", "libx264", "-pix_fmt", "yuv420p", f("flash30.mp4")]);
  await ffmpeg([...q, "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", f("move24.mp4")]);
  await ffmpeg([...q, "-f", "lavfi", "-i", "testsrc2=s=640x360:r=60:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", f("move60.mp4")]);
  // A textured still: a push-in visibly changes every frame.
  await ffmpeg([...q, "-f", "lavfi", "-i", "testsrc2=s=640x360:r=1:d=1", "-frames:v", "1", f("still.png")]);
  // Narration: silent 0-1 s, a 1000 Hz tone 1.0-1.5 s, silent to 2 s (fits a 3 s scene).
  await ffmpeg([...q, "-f", "lavfi", "-i", "sine=frequency=1000:duration=0.5", "-af", "adelay=1000:all=1,apad=whole_dur=2", "-ar", "24000", "-ac", "1", f("voice.wav")]);
  await ffmpeg([...q, "-f", "lavfi", "-i", "sine=frequency=1000:duration=1", "-ar", "24000", "-ac", "1", f("line.wav")]);
}, 180_000);

afterAll(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

describe("final encode arguments", () => {
  it("rebases the joined picture to 0 before subtitles and -r, on both final paths", () => {
    expect(finalVideoFilter(null)).toBe("setpts=PTS-STARTPTS");
    expect(finalVideoFilter("subs.ass")).toBe("setpts=PTS-STARTPTS,subtitles=subs.ass");
    const mix = buildFinalWithMixArgs({ videoInput: "joined.mp4", audioInput: "mix.wav", subtitleFile: "subs.ass", target, output: "o.mp4" });
    expect(mix[mix.indexOf("-vf") + 1]).toBe("setpts=PTS-STARTPTS,subtitles=subs.ass");
    // Legacy: the joined audio is cut by exactly as much as the picture starts late.
    const legacy = buildFinalArgs({ input: "joined.mp4", subtitleFile: null, musicFile: null, target, output: "o.mp4", audioLeadSec: 0.021029 });
    expect(legacy[legacy.indexOf("-filter_complex") + 1]).toBe("[0:v]setpts=PTS-STARTPTS[v];[0:a]atrim=start=0.021029,asetpts=PTS-STARTPTS[a]");
    const xfade = buildFinalArgs({ input: "joined.mp4", subtitleFile: null, musicFile: "m.mp3", target, output: "o.mp4", audioLeadSec: 0 });
    expect(xfade[xfade.indexOf("-filter_complex") + 1]).toContain("[0:a]asetpts=PTS-STARTPTS,asplit=2[voice][key]");
  });
});

describe("FIRST FRAME: không lặp khung đầu, đủ khung, đúng PTS, không lệch tiếng", () => {
  it("static image: 90 khung, PTS 0 → 2.967", async () => {
    const r = await render([scene(1, { imagePath: f("still.png"), videoPath: f("still.png") })]);
    expect(await videoClock(r.videoPath)).toMatchObject({ frames: 90, firstPts: 0, lastPts: expect.closeTo(2.9667, 3) });
  }, 300_000);

  it("Local Motion: 90 khung, khung đầu không đứng (camera chạy ngay từ khung 0 → 1, không giật)", async () => {
    const r = await render([scene(1, { imagePath: f("still.png"), videoPath: f("still.png"), localCamera: { move: "PUSH_IN", speed: "SLOW" } })]);
    expect(await videoClock(r.videoPath)).toMatchObject({ frames: 90, firstPts: 0 });
    const d = await frameDiffs(r.videoPath);
    const head = d.slice(0, 10);
    // Every step of the push is a real step - none of them a repeated frame.
    expect(Math.min(...head)).toBeGreaterThan(0.05);
  }, 300_000);

  it("native video (Video AI clip) + lời đọc riêng: flash đúng 1.000 s, không mất khung cuối", async () => {
    const line = [{ lineNumber: 1, speaker: "A", text: "x", audioPath: f("line.wav"), durationSec: 1 }];
    const r = await render([scene(1, { videoPath: f("flash30.mp4"), dialogueLines: line })]);
    expect(r.audioPipeline).toBe("dialogue-timeline");
    expect(await videoClock(r.videoPath)).toMatchObject({ frames: 90, firstPts: 0, lastPts: expect.closeTo(2.9667, 3) });
    const means = await frameMeans(r.videoPath);
    expect(flashFrames(means)).toEqual([30]);
    // The first two frames are different moments of the source.
    expect((await frameDiffs(r.videoPath))[0]).toBeGreaterThan(0.5);
  }, 300_000);

  it("uploaded 24fps → 30fps: 90 khung, khung 0 và 1 khác nhau", async () => {
    const r = await render([scene(1, { videoPath: f("move24.mp4"), clip: clip(3) })]);
    expect(await videoClock(r.videoPath)).toMatchObject({ frames: 90, firstPts: 0 });
    expect((await frameDiffs(r.videoPath))[0]).toBeGreaterThan(0.2);
  }, 300_000);

  it("uploaded 60fps → 30fps: 90 khung, MỌI cặp khung liền nhau khác nhau (kể cả khung đầu)", async () => {
    const r = await render([scene(1, { videoPath: f("move60.mp4"), clip: clip(3) })]);
    expect(await videoClock(r.videoPath)).toMatchObject({ frames: 90, firstPts: 0 });
    const d = await frameDiffs(r.videoPath);
    expect(d).toHaveLength(89);
    expect(Math.min(...d)).toBeGreaterThan(0.2);
  }, 300_000);

  it("hard cut + legacy audio: flash và tiếng cùng lúc ở 1.000 s và 4.000 s, 180 khung", async () => {
    const s = (n: number) => scene(n, { videoPath: f("flash30.mp4"), audioPath: f("voice.wav") });
    const r = await render([s(1), s(2)]);
    expect(r.audioPipeline).toBe("legacy-scene-audio");
    expect(await videoClock(r.videoPath)).toMatchObject({ frames: 180, firstPts: 0, lastPts: expect.closeTo(5.9667, 3) });
    expect(flashFrames(await frameMeans(r.videoPath))).toEqual([30, 120]);
    // Legacy scene audio plays from the scene's start: the tone and the flash
    // are the same moment (before the fix the picture ran 1 frame late).
    expect(r.sceneTimings.map((t) => t.finalDuration)).toEqual([3, 3]);
    const sound = await soundStarts(r.videoPath);
    expect(sound[0]).toBeCloseTo(1, 2);
    expect(sound[1]).toBeCloseTo(4, 2);
  }, 300_000);

  it("crossfade: vẫn đúng như trước (đã bắt đầu từ 0), flash đúng 1.000 s / 4.000 s", async () => {
    const s = (n: number, extra: Partial<RenderScene> = {}) => scene(n, { videoPath: f("flash30.mp4"), audioPath: f("voice.wav"), ...extra });
    const r = await render([s(1), s(2, { transitionIn: "CROSSFADE" })]);
    expect(r.transitionsApplied).toBe(1);
    expect(await videoClock(r.videoPath)).toMatchObject({ frames: 180, firstPts: 0 });
    expect(flashFrames(await frameMeans(r.videoPath))).toEqual([30, 120]);
    // Legacy scene audio plays from the scene's start: the tone and the flash
    // are the same moment (before the fix the picture ran 1 frame late).
    expect(r.sceneTimings.map((t) => t.finalDuration)).toEqual([3, 3]);
    const sound = await soundStarts(r.videoPath);
    expect(sound[0]).toBeCloseTo(1, 2);
    expect(sound[1]).toBeCloseTo(4, 2);
  }, 300_000);

  it("trim: clip từ 0.5 s → flash ở khung 15 (0.5 s), 60 khung", async () => {
    const r = await render([scene(1, { duration: 2, videoPath: f("flash30.mp4"), clip: clip(2, { startSec: 0.5 }) })]);
    expect(await videoClock(r.videoPath)).toMatchObject({ frames: 60, firstPts: 0, lastPts: expect.closeTo(1.9667, 3) });
    expect(flashFrames(await frameMeans(r.videoPath))).toEqual([15]);
  }, 300_000);

  it("voice + phụ đề burn: phụ đề vẫn hiện, khung/thời lượng đúng", async () => {
    if (!(await supportsSubtitleBurn())) return;
    const line = [{ lineNumber: 1, speaker: "A", text: "Xin chào", audioPath: f("line.wav"), durationSec: 1 }];
    const plain = await render([scene(1, { imagePath: f("still.png"), videoPath: f("still.png"), subtitle: "XIN CHAO", dialogueLines: line })], false);
    const plainMeans = await frameMeans(plain.videoPath);
    const burned = await render([scene(1, { imagePath: f("still.png"), videoPath: f("still.png"), subtitle: "XIN CHAO", dialogueLines: line })], true);
    expect(burned.subtitlesBurned).toBe(true);
    expect(await videoClock(burned.videoPath)).toMatchObject({ frames: 90, firstPts: 0 });
    const burnedMeans = await frameMeans(burned.videoPath);
    // The caption is on screen while the line plays.
    const differs = burnedMeans.map((v, i) => Math.abs(v - (plainMeans[i] ?? 0)) > 0.3);
    expect(differs.filter(Boolean).length).toBeGreaterThan(10);
  }, 300_000);

  it("resume / render lại: dùng lại segment, kết quả vẫn 90 khung, không lặp khung đầu", async () => {
    const scenes = [scene(1, { videoPath: f("move60.mp4"), clip: clip(3) })];
    await render(scenes);
    const again = await render(scenes);
    expect(again.segmentsReused).toBe(1);
    expect(await videoClock(again.videoPath)).toMatchObject({ frames: 90, firstPts: 0 });
    expect(Math.min(...(await frameDiffs(again.videoPath)))).toBeGreaterThan(0.2);
  }, 300_000);
});
