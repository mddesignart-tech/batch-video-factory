import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpeg, ffprobe, probeDimensions } from "@/media/ffmpeg";
import { buildClipAudioArgs, buildSceneNormalizeArgs, renderProject, type RenderClip, type RenderScene } from "@/media/render";
import { projectSubdir, toAbsolute } from "@/lib/paths";
import { resolveSceneDuration } from "@/domain/scene-timing";
import { clipWindow, sniffClipContainer, trimProblem } from "@/domain/user-clip";
import { ClipUploadError, inspectClipBytes } from "@/services/uploaded-clip";
import { renderRecipeHash } from "@/services/render-recipe";

/**
 * UPLOADED VIDEO CLIP - the media half: validation, metadata, trim, frame
 * rates, aspect ratios, the clip's own sound. Local FFmpeg only, no provider.
 */

const PROJECT = "uploaded-clip-media-test";
let root = "";
const f = (name: string) => path.join(root, name);
const q = ["-y", "-hide_banner", "-loglevel", "error"];

async function frameGray(file: string, atSec: number, w: number, h: number): Promise<Buffer> {
  const raw = f(`g-${Math.random().toString(36).slice(2)}.raw`);
  await ffmpeg([...q, "-ss", String(atSec), "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "gray", raw]);
  const buf = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  return buf;
}

async function frameRgb(file: string, atSec: number): Promise<[number, number, number]> {
  const raw = f(`c-${Math.random().toString(36).slice(2)}.raw`);
  await ffmpeg([...q, "-ss", String(atSec), "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
  const b = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  return [b[0]!, b[1]!, b[2]!];
}

/** Bounding box of the white pixels (the test square). */
function whiteBox(gray: Buffer, w: number, h: number) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if ((gray[y * w + x] ?? 0) > 200) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
  }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

async function streamInfo(file: string) {
  const { stdout } = await ffprobe(["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  return JSON.parse(stdout) as { streams: { codec_type: string; r_frame_rate: string; nb_frames?: string; duration?: string; width?: number; height?: number }[]; format: { duration: string } };
}

/**
 * One label per decoded frame; consecutive frames that show the same picture
 * share a label. Compared by mean pixel difference: an encoded duplicate is not
 * byte-identical after decoding, but it is visually the same frame.
 */
async function frameHashes(file: string): Promise<string[]> {
  const raw = f(`h-${Math.random().toString(36).slice(2)}.raw`);
  const W = 64;
  const H = 36;
  await ffmpeg([...q, "-i", file, "-map", "0:v:0", "-vf", `scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "gray", raw]);
  const buf = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  const n = Math.floor(buf.length / (W * H));
  const labels: string[] = [];
  let label = 0;
  for (let i = 0; i < n; i += 1) {
    if (i > 0) {
      let diff = 0;
      for (let p = 0; p < W * H; p += 1) diff += Math.abs((buf[i * W * H + p] ?? 0) - (buf[(i - 1) * W * H + p] ?? 0));
      if (diff / (W * H) > 0.2) label += 1; // duplicates measure < 0.1, real motion here > 0.4
    }
    labels.push(String(label));
  }
  return labels;
}

async function meanDb(file: string, from: number, to: number, filter = "anull"): Promise<number> {
  const { stderr } = await ffmpeg(["-hide_banner", "-ss", String(from), "-to", String(to), "-i", file, "-af", `${filter},volumedetect`, "-f", "null", "-"]);
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  return m && m[1] !== "-inf" ? Number(m[1]) : -120;
}

const clip = (lengthSec: number, extra: Partial<RenderClip> = {}): RenderClip => ({ startSec: 0, lengthSec, shortMode: "AUTO", frame: "AUTO", audioGain: null, ...extra });

beforeAll(async () => {
  root = toAbsolute(projectSubdir(PROJECT, "temp"));
  fs.mkdirSync(root, { recursive: true });
  // 16:9, 30 fps, 4 s, with sound; a white 180x180 square in the centre.
  await ffmpeg([...q, "-f", "lavfi", "-i", "color=c=0x3050a0:s=1280x720:r=30:d=4", "-f", "lavfi", "-i", "sine=frequency=300:duration=4",
    "-vf", "drawbox=x=550:y=270:w=180:h=180:c=white:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f("wide30.mp4")]);
  // 9:16 MOV, 25 fps, with sound.
  await ffmpeg([...q, "-f", "lavfi", "-i", "color=c=0x30a050:s=720x1280:r=25:d=3", "-f", "lavfi", "-i", "sine=frequency=500:duration=3",
    "-vf", "drawbox=x=270:y=550:w=180:h=180:c=white:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-f", "mov", f("tall25.mov")]);
  // Moving content at 24 and 60 fps (every source frame differs).
  await ffmpeg([...q, "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", f("move24.mp4")]);
  await ffmpeg([...q, "-f", "lavfi", "-i", "testsrc2=s=640x360:r=60:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", f("move60.mp4")]);
  // WebM (VP9).
  await ffmpeg([...q, "-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=1", "-c:v", "libvpx-vp9", "-b:v", "200k", f("small.webm")]);
  // Red 0-2 s, green 2-4 s, blue 4-6 s: a trim shows which part plays.
  await ffmpeg([...q, "-f", "lavfi", "-i", "color=c=red:s=360x640:r=30:d=2", "-f", "lavfi", "-i", "color=c=green:s=360x640:r=30:d=2", "-f", "lavfi", "-i", "color=c=blue:s=360x640:r=30:d=2",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", f("rgb.mp4")]);
  // Narration: 1 s of 1000 Hz from 1.0 s to 2.0 s, silent otherwise (4 s).
  await ffmpeg([...q, "-f", "lavfi", "-i", "sine=frequency=1000:duration=1", "-af", "adelay=1000:all=1,apad=whole_dur=4", "-ar", "24000", "-ac", "1", f("voice.wav")]);
  await ffmpeg([...q, "-f", "lavfi", "-i", "sine=frequency=1000:duration=1", "-ar", "24000", "-ac", "1", f("line.wav")]);
}, 180_000);

afterAll(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

describe("UPLOAD + VALIDATION + METADATA", () => {
  it("A. MP4 hợp lệ → metadata đúng (ffprobe, không tin đuôi file)", async () => {
    const bytes = fs.readFileSync(f("wide30.mp4"));
    const { info, sha256 } = await inspectClipBytes(bytes, "presenter.mp4");
    expect(info).toMatchObject({ container: "mp4", width: 1280, height: 720, fps: 30, codec: "h264", hasAudio: true, audioCodec: "aac", rotation: 0, orientation: "LANDSCAPE", aspectRatio: "16:9", bytes: bytes.length });
    expect(info.durationSec).toBeGreaterThan(3.9);
    expect(info.durationSec).toBeLessThan(4.2);
    expect(info.pixelFormat).toBe("yuv420p");
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("B. MOV hợp lệ → nhận (dọc 9:16, 25 fps); WebM cũng nhận", async () => {
    const mov = await inspectClipBytes(fs.readFileSync(f("tall25.mov")), "rot-nuoc.MOV");
    expect(mov.info).toMatchObject({ container: "mov", width: 720, height: 1280, fps: 25, orientation: "PORTRAIT", aspectRatio: "9:16", hasAudio: true });
    const webm = await inspectClipBytes(fs.readFileSync(f("small.webm")), "broll.webm");
    expect(webm.info).toMatchObject({ container: "webm", codec: "vp9", hasAudio: false });
  });

  it("clip điện thoại lưu ngang + xoay 90° → hiểu là dọc (kích thước hiển thị)", async () => {
    await ffmpeg([...q, "-display_rotation", "90", "-i", f("move24.mp4"), "-c", "copy", f("phone.mp4")]);
    const { info } = await inspectClipBytes(fs.readFileSync(f("phone.mp4")), "phone.mp4");
    expect(info).toMatchObject({ width: 360, height: 640, orientation: "PORTRAIT", aspectRatio: "9:16" });
    expect([90, 270]).toContain(info.rotation);
    expect(await probeDimensions(f("phone.mp4"))).toEqual({ width: 360, height: 640 });
  });

  it("C. file giả .mp4 / container hỏng → báo lỗi dễ hiểu, không nhận", async () => {
    const fake = Buffer.from("<html>not a video</html>".padEnd(200, " "));
    await expect(inspectClipBytes(fake, "fake.mp4")).rejects.toMatchObject({ code: "clip_not_a_video" });
    await expect(inspectClipBytes(fake, "fake.mp4")).rejects.toThrow(/không phải MP4 \/ MOV \/ WebM/);
    // A real MP4 header, then garbage: the header is perfect, the file is not.
    const real = fs.readFileSync(f("wide30.mp4"));
    const broken = Buffer.concat([real.subarray(0, 64), Buffer.alloc(4000, 7)]);
    expect(sniffClipContainer(broken)).toBe("mp4");
    const err = await inspectClipBytes(broken, "hong.mp4").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClipUploadError);
    expect((err as ClipUploadError).message).toMatch(/hong\.mp4/);
    await expect(inspectClipBytes(real, "clip.exe")).rejects.toMatchObject({ code: "clip_extension_not_allowed" });
    // A picture renamed .mp4 is not a clip.
    const png = await ffmpeg([...q, "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", f("red.png")]).then(() => fs.readFileSync(f("red.png")));
    await expect(inspectClipBytes(png, "anh.mp4")).rejects.toMatchObject({ code: "clip_not_a_video" });
  });
});

describe("TRIM / DURATION (pure)", () => {
  it("cửa sổ cắt luôn nằm trong clip; trim sai bị từ chối", () => {
    expect(clipWindow({ clipStartSec: 1.5, clipEndSec: 3 }, 6)).toEqual({ startSec: 1.5, endSec: 3, lengthSec: 1.5 });
    expect(clipWindow({ clipStartSec: null, clipEndSec: 99 }, 6)).toEqual({ startSec: 0, endSec: 6, lengthSec: 6 });
    expect(trimProblem(7, null, 6)).toMatch(/vượt quá/);
    expect(trimProblem(2, 2.2, 6)).toMatch(/0,5 giây/);
    expect(trimProblem(1, 3, 6)).toBeNull();
  });

  it("clip dài hơn cảnh → cắt; ngắn hơn → AUTO giữ ≤1s hoặc dừng hỏi, LOOP / SLOW / HOLD theo lựa chọn", () => {
    const base = { sceneNumber: 4, plannedDuration: 4, motion: "VIDEO_AI" as const, userClip: true };
    expect(resolveSceneDuration({ ...base, voiceDuration: null, clipDuration: 6 })).toMatchObject({ finalDuration: 4, timingReason: "CLIP_TRIMMED_LOCAL", blocked: false });
    const auto = resolveSceneDuration({ ...base, voiceDuration: 5, clipDuration: 2 });
    expect(auto.blocked).toBe(true);
    expect(auto.timingReason).toBe("USER_CLIP_TOO_SHORT");
    expect(auto.message).toMatch(/Lặp lại clip.*Không gọi Video AI/);
    const loop = resolveSceneDuration({ ...base, voiceDuration: 5, clipDuration: 2, clipShortMode: "LOOP" });
    expect(loop).toMatchObject({ blocked: false, timingReason: "USER_CLIP_LOOPED", freezeSec: 0, clipFill: { mode: "LOOP", speed: 1 } });
    const slow = resolveSceneDuration({ ...base, voiceDuration: 3, clipDuration: 2.5, clipShortMode: "SLOW" });
    expect(slow.clipFill?.mode).toBe("SLOW");
    expect(slow.clipFill!.speed).toBeGreaterThanOrEqual(0.5);
    expect(slow.clipFill!.speed).toBeCloseTo(2.5 / slow.finalDuration, 2);
    const hold = resolveSceneDuration({ ...base, voiceDuration: 5, clipDuration: 2, clipShortMode: "HOLD" });
    expect(hold).toMatchObject({ blocked: false, timingReason: "USER_CLIP_HELD" });
    expect(hold.warnings.join(" ")).toMatch(/Giữ khung cuối/);
    // An AI clip keeps V1's rule exactly (no user-clip fields).
    const ai = resolveSceneDuration({ sceneNumber: 1, plannedDuration: 4, motion: "VIDEO_AI", voiceDuration: 5, clipDuration: 2 });
    expect(ai.timingReason).toBe("CLIP_TOO_SHORT_FOR_VOICE");
    expect(ai.clipFill).toBeUndefined();
  });
});

describe("RENDER (local FFmpeg)", () => {
  const scene = (n: number, videoPath: string, duration: number, c: RenderClip, lines: RenderScene["dialogueLines"] = []): RenderScene => ({
    sceneNumber: n, duration, subtitle: "", videoPath, audioPath: null, imagePath: null, dialogueLines: lines, clip: c,
    // The planned length stands (the voice fits), so silences can be measured.
    durationMode: "LOCKED",
  });

  it("K. clip 16:9 → đầu ra 9:16: không méo (CONTAIN và COVER đều giữ hình vuông vuông)", async () => {
    for (const frame of ["CONTAIN", "COVER"] as const) {
      const r = await renderProject({ projectId: PROJECT, scenes: [scene(1, f("wide30.mp4"), 2, clip(4, { frame }))], target: { width: 360, height: 640, fps: 30 }, burnSubtitles: false });
      const info = await streamInfo(r.videoPath);
      expect(info.streams.find((s) => s.codec_type === "video")).toMatchObject({ width: 360, height: 640 });
      const box = whiteBox(await frameGray(r.videoPath, 1, 360, 640), 360, 640);
      expect(Math.abs(box.w - box.h)).toBeLessThanOrEqual(3);
      // Contain: 180 px * 360/1280 ≈ 51; cover: 180 * 640/720 = 160.
      expect(box.w).toBeCloseTo(frame === "CONTAIN" ? 51 : 160, -1);
    }
  }, 300_000);

  it("L. 9:16 → 9:16: đúng khung, không méo, lấp đầy", async () => {
    const r = await renderProject({ projectId: PROJECT, scenes: [scene(1, f("tall25.mov"), 2, clip(3))], target: { width: 360, height: 640, fps: 30 }, burnSubtitles: false });
    const box = whiteBox(await frameGray(r.videoPath, 1, 360, 640), 360, 640);
    expect(box.w).toBeCloseTo(90, -1);
    expect(Math.abs(box.w - box.h)).toBeLessThanOrEqual(2);
    const [, g] = await frameRgb(r.videoPath, 0.5);
    expect(g).toBeGreaterThan(100); // the green clip fills the frame, no bars
  }, 300_000);

  it("M. 24fps → 30fps: nhịp lặp khung đều (≤2 khung giống nhau liền nhau), không lệch thời lượng", async () => {
    const r = await renderProject({ projectId: PROJECT, scenes: [scene(1, f("move24.mp4"), 3, clip(3))], target: { width: 320, height: 568, fps: 30 }, burnSubtitles: false });
    const info = await streamInfo(r.videoPath);
    expect(info.streams.find((s) => s.codec_type === "video")!.r_frame_rate).toBe("30/1");
    const hashes = await frameHashes(r.videoPath);
    expect(hashes.length).toBeGreaterThanOrEqual(89);
    expect(hashes.length).toBeLessThanOrEqual(91);
    let dupes = 0;
    let run = 1;
    let longest = 1;
    for (let i = 1; i < hashes.length; i += 1) {
      if (hashes[i] === hashes[i - 1]) { dupes += 1; run += 1; longest = Math.max(longest, run); } else run = 1;
    }
    expect(longest).toBeLessThanOrEqual(2);
    expect(dupes).toBeGreaterThanOrEqual(15); // 6 per second, the regular 24→30 cadence
    expect(dupes).toBeLessThanOrEqual(21);
    expect(Math.abs(Number(info.format.duration) - 3)).toBeLessThan(0.1);
  }, 300_000);

  it("N. 60fps → 30fps: mỗi khung khác nhau, đúng thời lượng", async () => {
    const r = await renderProject({ projectId: PROJECT, scenes: [scene(1, f("move60.mp4"), 3, clip(3))], target: { width: 320, height: 568, fps: 30 }, burnSubtitles: false });
    const hashes = await frameHashes(r.videoPath);
    expect(hashes.length).toBeGreaterThanOrEqual(89);
    expect(hashes.length).toBeLessThanOrEqual(91);
    // The final pass (shared by every render, V1's) repeats the very first frame
    // once; from there on every output frame is a new source frame.
    for (let i = 2; i < hashes.length; i += 1) expect(hashes[i]).not.toBe(hashes[i - 1]);
    const info = await streamInfo(r.videoPath);
    expect(Math.abs(Number(info.format.duration) - 3)).toBeLessThan(0.1);
  }, 300_000);

  it("Q. trim: chỉ phát đoạn 2s → 4s (màu xanh lá) từ đầu đến cuối cảnh", async () => {
    const r = await renderProject({ projectId: PROJECT, scenes: [scene(1, f("rgb.mp4"), 2, clip(2, { startSec: 2 }))], target: { width: 360, height: 640, fps: 30 }, burnSubtitles: false });
    for (const t of [0.1, 1.0, 1.85]) {
      const [rr, g, b] = await frameRgb(r.videoPath, t);
      expect(g).toBeGreaterThan(80);
      expect(rr).toBeLessThan(60);
      expect(b).toBeLessThan(60);
    }
    expect(Math.abs(r.durationSeconds - 2)).toBeLessThan(0.1);
  }, 300_000);

  it("LOOP: clip 1s lặp lại cho cảnh 3s - không đứng hình", async () => {
    const line = [{ lineNumber: 1, speaker: "A", text: "x", audioPath: f("line.wav"), durationSec: 1 }];
    // Voice + padding needs ~1.5 s; the clip window is 1 s of moving content.
    const r = await renderProject({ projectId: PROJECT, scenes: [scene(1, f("move24.mp4"), 3, clip(1, { shortMode: "LOOP" }), line)], target: { width: 320, height: 568, fps: 30 }, burnSubtitles: false });
    expect(r.sceneTimings[0]!.timingReason).toBe("USER_CLIP_LOOPED");
    const hashes = await frameHashes(r.videoPath);
    let run = 1;
    let longest = 1;
    for (let i = 1; i < hashes.length; i += 1) {
      if (hashes[i] === hashes[i - 1]) { run += 1; longest = Math.max(longest, run); } else run = 1;
    }
    expect(longest).toBeLessThanOrEqual(2);
  }, 300_000);

  it("O. clip có âm thanh, TẮT → chỉ nghe lời đọc (khoảng lặng giữa câu im lặng)", async () => {
    const line = [{ lineNumber: 1, speaker: "A", text: "Xin chào", audioPath: f("line.wav"), durationSec: 1 }];
    const r = await renderProject({ projectId: PROJECT, scenes: [scene(1, f("wide30.mp4"), 4, clip(4, { audioGain: null }), line)], target: { width: 360, height: 640, fps: 30 }, burnSubtitles: false });
    const t = r.sceneTimings[0]!;
    const speechStart = t.leadInSec;
    expect(await meanDb(r.videoPath, speechStart + 0.2, speechStart + 0.8)).toBeGreaterThan(-35); // narration plays
    expect(await meanDb(r.videoPath, speechStart + 1.3, 3.8)).toBeLessThan(-60); // no clip sound
  }, 300_000);

  it("P. BẬT âm thanh clip → trộn dưới lời đọc, tự hạ khi có lời (ducking), lời đọc không bị hạ", async () => {
    const mixed = f("clip-mix.wav");
    await ffmpeg(buildClipAudioArgs({ clipInput: f("wide30.mp4"), window: { startSec: 0, lengthSec: 4 }, voiceInput: f("voice.wav"), durationSec: 4, gain: 0.8, output: mixed }));
    const clipBand = "bandpass=f=300:width_type=h:w=80";
    const voiceBand = "bandpass=f=1000:width_type=h:w=80";
    const clipAlone = await meanDb(mixed, 2.6, 3.6, clipBand);
    const clipUnderVoice = await meanDb(mixed, 1.3, 1.8, clipBand);
    expect(clipAlone).toBeGreaterThan(-40); // the clip's sound is there
    expect(clipAlone - clipUnderVoice).toBeGreaterThan(6); // and ducks under speech
    const voiceInMix = await meanDb(mixed, 1.3, 1.8, voiceBand);
    const voiceAlone = await meanDb(f("voice.wav"), 1.3, 1.8, voiceBand);
    expect(Math.abs(voiceInMix - voiceAlone)).toBeLessThan(1.5); // narration untouched
    const info = await streamInfo(mixed);
    expect(Math.abs(Number(info.format.duration) - 4)).toBeLessThan(0.05);

    // Through the whole render: the clip's sound is in the final MP4 between the lines.
    const line = [{ lineNumber: 1, speaker: "A", text: "Xin chào", audioPath: f("line.wav"), durationSec: 1 }];
    const r = await renderProject({ projectId: PROJECT, scenes: [scene(1, f("wide30.mp4"), 4, clip(4, { audioGain: 0.6 }), line)], target: { width: 360, height: 640, fps: 30 }, burnSubtitles: false });
    const speechStart = r.sceneTimings[0]!.leadInSec;
    expect(await meanDb(r.videoPath, speechStart + 1.4, 3.8)).toBeGreaterThan(-45);
  }, 300_000);

  it("R. cảnh không có clip người dùng: lệnh FFmpeg và công thức render y như trước", () => {
    const args = buildSceneNormalizeArgs({ videoInput: "a.mp4", audioInput: null, duration: 4, target: { width: 720, height: 1280, fps: 30 }, output: "o.mp4" });
    expect(args).not.toContain("-ss");
    expect(args.join(" ")).not.toMatch(/setpts|stream_loop/);
    expect(args.join(" ")).toMatch(/\[0:v\]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=30,tpad=stop_mode=clone:stop_duration=10/);
    const plain: RenderScene = { sceneNumber: 1, duration: 4, subtitle: "", videoPath: null, audioPath: null, imagePath: null };
    expect(renderRecipeHash({ scenes: [plain], target: { width: 720, height: 1280, fps: 30 }, burnSubtitles: true })).toBe(
      renderRecipeHash({ scenes: [{ ...plain, clip: undefined }], target: { width: 720, height: 1280, fps: 30 }, burnSubtitles: true }),
    );
  });
});
