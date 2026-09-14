import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConcatArgs,
  buildConcatList,
  buildFinalArgs,
  buildSceneNormalizeArgs,
  targetForAspect,
  DEFAULT_TARGET,
} from "@/media/render";
import { buildASS, buildCues, buildSRT, wrapSubtitle } from "@/media/subtitles";
import { Bitmap, wrapText } from "@/media/png";
import {
  synthesizeVoiceWav,
  estimateSpeechDuration,
  renderSceneCard,
} from "@/providers/mock/mock-media";
import { ffmpegAvailable, resolveFfmpeg } from "@/media/ffmpeg";
import {
  safeExtension,
  safeSegment,
  toAbsolute,
  toRelative,
  DATA_ROOT,
} from "@/lib/paths";

/**
 * FFmpeg argument construction is tested as pure data, so a regression in the
 * command line is caught without spawning a process. The end-to-end test proves
 * the arguments actually work.
 */

describe("render target", () => {
  it("defaults to vertical 1080x1920 at 30fps", () => {
    expect(DEFAULT_TARGET).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(targetForAspect("9:16")).toEqual(DEFAULT_TARGET);
    expect(targetForAspect("anything-unknown")).toEqual(DEFAULT_TARGET);
  });

  it("supports the other common social ratios", () => {
    expect(targetForAspect("1:1").height).toBe(1080);
    expect(targetForAspect("16:9").width).toBe(1920);
    expect(targetForAspect("4:5").height).toBe(1350);
  });
});

describe("scene normalize arguments", () => {
  const args = buildSceneNormalizeArgs({
    videoInput: "C:\\Tool Video Youtube\\data\\projects\\a b\\videos\\clip.mp4",
    audioInput: "C:\\Tool Video Youtube\\data\\projects\\a b\\audio\\voice.wav",
    duration: 4.25,
    target: DEFAULT_TARGET,
    output: "out.mp4",
  });

  it("passes paths as discrete arguments so spaces need no quoting", () => {
    // The path appears verbatim as its own argv entry - not wrapped in quotes,
    // not concatenated into a command string. That is what makes a folder called
    // "Tool Video Youtube" work without any escaping.
    const inputs = args
      .map((arg, i) => (args[i - 1] === "-i" ? arg : null))
      .filter((v): v is string => v !== null);
    expect(inputs).toContain(
      "C:\\Tool Video Youtube\\data\\projects\\a b\\videos\\clip.mp4",
    );
    expect(inputs).toContain(
      "C:\\Tool Video Youtube\\data\\projects\\a b\\audio\\voice.wav",
    );
    for (const input of inputs) expect(input.startsWith('"')).toBe(false);
  });

  it("scales and crops to fill the vertical frame", () => {
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
    expect(filter).toContain("crop=1080:1920");
    expect(filter).toContain("fps=30");
  });

  it("hard-trims to the scripted scene duration so audio stays in sync", () => {
    expect(args[args.indexOf("-t") + 1]).toBe("4.25");
  });

  it("holds the last frame when the clip is shorter than the scene", () => {
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("tpad=stop_mode=clone");
  });

  it("pads the voice track rather than truncating the video", () => {
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("apad");
  });

  it("synthesises silence when a scene has no voice line", () => {
    const silent = buildSceneNormalizeArgs({
      videoInput: "clip.mp4",
      audioInput: null,
      duration: 3,
      target: DEFAULT_TARGET,
      output: "out.mp4",
    });
    expect(silent.join(" ")).toContain("anullsrc");
  });

  it("animates a still image instead of freezing on it", () => {
    const still = buildSceneNormalizeArgs({
      videoInput: "frame.png",
      audioInput: null,
      duration: 4,
      target: DEFAULT_TARGET,
      output: "out.mp4",
    });
    expect(still).toContain("-loop");
    expect(still.join(" ")).toContain("zoompan");
  });

  it("encodes H.264 + AAC in a browser-safe pixel format", () => {
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
  });
});

describe("concat", () => {
  it("quotes filenames per the demuxer grammar", () => {
    const list = buildConcatList(["norm_001.mp4", "norm_002.mp4"]);
    expect(list).toBe("file 'norm_001.mp4'\nfile 'norm_002.mp4'\n");
  });

  it("escapes an embedded single quote", () => {
    expect(buildConcatList(["it's.mp4"])).toContain("it'\\''s.mp4");
  });

  it("stream-copies rather than re-encoding the join", () => {
    const args = buildConcatArgs("concat.txt", "joined.mp4");
    expect(args).toContain("-c");
    expect(args[args.indexOf("-c") + 1]).toBe("copy");
    expect(args).toContain("-safe");
  });
});

describe("final render arguments", () => {
  it("references the subtitle file by bare name to dodge drive-letter escaping", () => {
    const args = buildFinalArgs({
      input: "joined.mp4",
      subtitleFile: "subs.ass",
      musicFile: null,
      target: DEFAULT_TARGET,
      output: "final.mp4",
    });
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).toBe("subtitles=subs.ass");
    // A Windows absolute path here would need double-escaping and is a bug.
    expect(vf).not.toMatch(/[A-Z]:/);
  });

  it("ducks background music under the voice and leaves the voice at full level", () => {
    // This test previously asserted `volume=0.18` - a FIXED attenuation that
    // the surrounding comment already described as ducking, which it was not.
    // Worse, `amix` normalises by default, so adding music quietly dropped the
    // voice by 6 dB: the opposite of "speech must stay above the music".
    // The assertions now pin the corrected behaviour.
    const args = buildFinalArgs({
      input: "joined.mp4",
      subtitleFile: null,
      musicFile: "music.mp3",
      target: DEFAULT_TARGET,
      output: "final.mp4",
    });
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("sidechaincompress");
    expect(filter).toContain("normalize=0");
    expect(filter).toContain("amix=inputs=2");
  });

  it("combines subtitle burn and music mixing in one pass", () => {
    const args = buildFinalArgs({
      input: "joined.mp4",
      subtitleFile: "subs.ass",
      musicFile: "music.mp3",
      target: DEFAULT_TARGET,
      output: "final.mp4",
    });
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("subtitles=subs.ass");
    expect(filter).toContain("amix");
  });

  it("writes a fast-start MP4 ready for upload", () => {
    const args = buildFinalArgs({
      input: "joined.mp4",
      subtitleFile: null,
      musicFile: null,
      target: DEFAULT_TARGET,
      output: "final.mp4",
    });
    expect(args[args.indexOf("-movflags") + 1]).toBe("+faststart");
    expect(args[args.indexOf("-r") + 1]).toBe("30");
  });
});

describe("subtitles", () => {
  const scenes = [
    { duration: 3, subtitle: "BREAK A LEG?!" },
    { duration: 5, subtitle: "He thinks it means: break his own leg" },
    { duration: 4, subtitle: "" },
    { duration: 4, subtitle: "MEANING: GOOD LUCK" },
  ];

  it("lays cues end to end on the scene timeline", () => {
    const cues = buildCues(scenes);
    expect(cues).toHaveLength(3); // the empty subtitle is skipped
    expect(cues[0]!.startSeconds).toBe(0);
    expect(cues[1]!.startSeconds).toBe(3);
    expect(cues[2]!.startSeconds).toBe(12);
  });

  it("leaves a gap so consecutive cues do not flicker together", () => {
    const cues = buildCues(scenes);
    expect(cues[0]!.endSeconds).toBeLessThan(cues[1]!.startSeconds);
  });

  it("emits well-formed SRT timestamps", () => {
    const srt = buildSRT(buildCues(scenes));
    expect(srt).toMatch(/^1\r?\n00:00:00,000 --> 00:00:02,940/);
  });

  it("wraps long subtitles onto at most three lines", () => {
    const lines = wrapSubtitle(
      "This is a very long subtitle line that would never fit on a phone screen in one go",
    );
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it("sizes ASS text relative to the frame", () => {
    const ass = buildASS(buildCues(scenes), { width: 1080, height: 1920 });
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toMatch(/Style: Default,Arial,1[45]\d,/);
  });

  it("keeps subtitles clear of the platform UI at the bottom", () => {
    const ass = buildASS(buildCues(scenes), { width: 1080, height: 1920 });
    const style = ass.split("\n").find((l) => l.startsWith("Style: Default"))!;
    const marginV = Number(style.split(",").at(-2));
    expect(marginV).toBeGreaterThan(300);
  });

  it("highlights the idiom phrase in a contrasting colour", () => {
    const ass = buildASS(buildCues(scenes), {
      width: 1080,
      height: 1920,
      highlightPhrase: "break a leg",
    });
    expect(ass).toContain("\\c&H0024D7FF&");
  });

  it("neutralises ASS override braces in subtitle text", () => {
    const ass = buildASS([{ startSeconds: 0, endSeconds: 1, text: "{\\an8}hack" }], {
      width: 1080,
      height: 1920,
    });
    const dialogue = ass.split("\n").find((l) => l.startsWith("Dialogue:"))!;
    expect(dialogue).toContain("(\\\\an8)hack");
  });
});

describe("mock media generation", () => {
  it("writes a real, decodable PNG", () => {
    const png = renderSceneCard({
      sceneNumber: 1,
      totalScenes: 6,
      caption: "BREAK A LEG?!",
      complexity: "MEDIUM",
      provider: "mock",
      model: "mock-video-std",
      width: 270,
      height: 480,
      seed: 42,
    });
    // PNG magic number
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.length).toBeGreaterThan(1000);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.subarray(-8, -4).toString("ascii")).toBe("IEND");
  });

  it("is deterministic for the same scene", () => {
    const input = {
      sceneNumber: 2,
      totalScenes: 6,
      caption: "Easy!",
      complexity: "LOW" as const,
      provider: "mock",
      model: "mock-video-lite",
      width: 180,
      height: 320,
      seed: 7,
    };
    expect(renderSceneCard(input).equals(renderSceneCard(input))).toBe(true);
  });

  it("writes a real WAV of roughly the requested length", () => {
    const wav = synthesizeVoiceWav({
      text: "Break a leg on your interview",
      durationSeconds: 2,
      voiceId: "mock-male-us",
      sampleRate: 8000,
    });
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    const dataBytes = wav.readUInt32LE(40);
    expect(dataBytes / (8000 * 2)).toBeCloseTo(2, 1);
  });

  it("estimates speaking time from word count", () => {
    expect(estimateSpeechDuration("one two three four five six")).toBeCloseTo(
      2.3,
      0,
    );
    expect(estimateSpeechDuration("")).toBeGreaterThan(0);
  });
});

describe("bitmap primitives", () => {
  it("fills every pixel", () => {
    const bmp = new Bitmap(4, 4);
    bmp.fill({ r: 10, g: 20, b: 30 });
    expect(bmp.data[0]).toBe(10);
    expect(bmp.data[bmp.data.length - 1]).toBe(30);
  });

  it("ignores out-of-bounds writes instead of corrupting neighbours", () => {
    const bmp = new Bitmap(2, 2);
    expect(() => bmp.setPixel(99, 99, { r: 1, g: 1, b: 1 })).not.toThrow();
    expect(() => bmp.setPixel(-5, -5, { r: 1, g: 1, b: 1 })).not.toThrow();
  });

  it("wraps text at the requested width", () => {
    const lines = wrapText("the quick brown fox jumps over the lazy dog", 12);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(12 + 5);
  });
});

describe("path safety", () => {
  it("strips directory traversal from a provider-supplied name", () => {
    expect(safeSegment("../../etc/passwd")).not.toContain("..");
    expect(safeSegment("..\\..\\windows\\system32")).not.toContain("..");
  });

  it("neutralises characters Windows cannot store", () => {
    expect(safeSegment('bad<>:"|?*name')).not.toMatch(/[<>:"|?*]/);
  });

  it("escapes reserved Windows device names", () => {
    expect(safeSegment("CON")).toBe("_CON");
    expect(safeSegment("nul.txt")).toBe("_nul.txt");
  });

  it("only accepts extensions from the allow list", () => {
    expect(safeExtension("clip.mp4", ".bin")).toBe(".mp4");
    expect(safeExtension("payload.exe", ".bin")).toBe(".bin");
    expect(safeExtension("script.bat", ".png")).toBe(".png");
  });

  it("refuses to resolve a path that escapes the data root", () => {
    expect(() => toAbsolute("../../../Windows/System32/cmd.exe")).toThrow();
    expect(() => toAbsolute("..")).toThrow();
  });

  it("round-trips a legitimate relative path", () => {
    const abs = path.join(DATA_ROOT, "projects", "abc", "final", "v.mp4");
    expect(toAbsolute(toRelative(abs))).toBe(abs);
  });

  it("stores relative paths with forward slashes for portability", () => {
    const abs = path.join(DATA_ROOT, "projects", "abc", "v.mp4");
    expect(toRelative(abs)).toBe("projects/abc/v.mp4");
  });
});

describe("ffmpeg binary resolution", () => {
  it("finds a usable ffmpeg (bundled or on PATH)", () => {
    expect(ffmpegAvailable()).toBe(true);
    const binary = resolveFfmpeg()!;
    expect(fs.existsSync(binary)).toBe(true);
  });
});
