import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFinalWithMixArgs,
  DEFAULT_TARGET,
  renderProject,
  type RenderScene,
} from "@/media/render";
import { checkMix, mixIsAcceptable, summariseMix, toMetrics } from "@/media/audio-metrics";
import { resolveMix } from "@/media/mix-config";
import { ffmpeg, ffmpegAvailable } from "@/media/ffmpeg";
import { projectSubdir, toAbsolute } from "@/lib/paths";
import type { LoudnessStats } from "@/media/audio-normalize";

/**
 * The renderer itself, not the helpers it calls.
 *
 * Testing `renderSceneDialogue` and `renderFinalMix` in isolation proves they
 * work; it does not prove the renderer USES them. A pipeline that quietly kept
 * taking the old single-file audio path would pass every helper test and ship
 * the wrong audio, so these run `renderProject` end to end and inspect what
 * came out.
 */

const hasFfmpeg = ffmpegAvailable();
const PROJECT = "render-audio-test";
let root = "";

/** A silent colour clip, standing in for a generated scene. */
async function makeVideo(file: string, seconds: number, colour: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${colour}:s=360x640:d=${seconds}:r=30`,
    "-f", "lavfi", "-i", `anullsrc=r=24000:cl=mono:d=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    file,
  ]);
}

/** A tone standing in for one spoken line. */
async function makeLine(file: string, seconds: number, freq: number): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`,
    "-af", "volume=0.3,aresample=24000",
    "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le",
    file,
  ]);
}

/** Audio stream level of the finished MP4, to prove it is not silent. */
async function audioRms(file: string, from: number, to: number): Promise<number> {
  const raw = path.join(root, `probe-${Math.random().toString(36).slice(2)}.f32`);
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", String(from), "-to", String(to),
    "-i", file, "-vn", "-ac", "1", "-f", "f32le", raw,
  ]);
  const buf = fs.readFileSync(raw);
  const s = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  fs.rmSync(raw, { force: true });
  let sum = 0;
  for (let i = 0; i < s.length; i += 1) {
    const v = s[i] ?? 0;
    sum += v * v;
  }
  return s.length === 0 ? 0 : Math.sqrt(sum / s.length);
}

beforeAll(() => {
  root = toAbsolute(projectSubdir(PROJECT, "temp"));
  fs.mkdirSync(root, { recursive: true });
});

afterAll(() => {
  const projectRoot = path.dirname(root);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe.runIf(hasFfmpeg)("the renderer uses the dialogue pipeline", () => {
  it("reports the new pipeline and writes a measured mix", async () => {
    const v1 = path.join(root, "v1.mp4");
    const v2 = path.join(root, "v2.mp4");
    await makeVideo(v1, 4, "red");
    await makeVideo(v2, 4, "blue");

    const l1 = path.join(root, "l1.wav");
    const l2 = path.join(root, "l2.wav");
    const l3 = path.join(root, "l3.wav");
    await makeLine(l1, 1.5, 220);
    await makeLine(l2, 1.5, 300);
    await makeLine(l3, 1.5, 400);

    const scenes: RenderScene[] = [
      {
        sceneNumber: 1,
        duration: 4,
        subtitle: "Max speaks",
        videoPath: v1,
        audioPath: null,
        imagePath: null,
        dialogueLines: [
          { lineNumber: 1, speaker: "Max", text: "Max speaks", audioPath: l1, durationSec: 1.5 },
          { lineNumber: 2, speaker: "Leo", text: "Leo answers", audioPath: l2, durationSec: 1.5 },
        ],
      },
      {
        sceneNumber: 2,
        duration: 4,
        subtitle: "Mia closes",
        videoPath: v2,
        audioPath: null,
        imagePath: null,
        dialogueLines: [
          { lineNumber: 1, speaker: "Mia", text: "Mia closes", audioPath: l3, durationSec: 1.5 },
        ],
      },
    ];

    const result = await renderProject({
      projectId: PROJECT,
      scenes,
      target: { width: 360, height: 640, fps: 30 },
      burnSubtitles: false,
    });

    expect(result.audioPipeline).toBe("dialogue-timeline");
    expect(result.audioMetrics).toBeDefined();
    expect(result.sceneAudioPaths.length).toBe(2);
    expect(fs.existsSync(result.videoPath)).toBe(true);
  }, 300_000);

  it("writes the project mix where it can be inspected and re-used", async () => {
    const mix = toAbsolute(path.join(projectSubdir(PROJECT, "audio"), "project-final-mix.wav"));
    const dialogue = toAbsolute(path.join(projectSubdir(PROJECT, "audio"), "project-dialogue.wav"));
    expect(fs.existsSync(mix)).toBe(true);
    expect(fs.existsSync(dialogue)).toBe(true);
  });

  it("the finished MP4 actually carries that audio, not silence", async () => {
    // The check that matters: a renderer could report the new pipeline and
    // still mux the old track.
    const finalDir = toAbsolute(projectSubdir(PROJECT, "final"));
    const mp4 = fs
      .readdirSync(finalDir)
      .filter((f) => f.endsWith(".mp4"))
      .map((f) => path.join(finalDir, f))[0];
    expect(mp4).toBeTruthy();
    const level = await audioRms(mp4 as string, 0.2, 1.3);
    expect(level).toBeGreaterThan(0.01);
  }, 120_000);

  it("names three scene audio tracks for a three-scene project", async () => {
    const v = path.join(root, "v3.mp4");
    await makeVideo(v, 3, "green");
    const l = path.join(root, "l4.wav");
    await makeLine(l, 1, 250);

    const scene = (n: number): RenderScene => ({
      sceneNumber: n,
      duration: 3,
      subtitle: `Scene ${n}`,
      videoPath: v,
      audioPath: null,
      imagePath: null,
      dialogueLines: [
        { lineNumber: 1, speaker: "Max", text: `Scene ${n}`, audioPath: l, durationSec: 1 },
      ],
    });

    const result = await renderProject({
      projectId: PROJECT,
      scenes: [scene(1), scene(2), scene(3)],
      target: { width: 360, height: 640, fps: 30 },
      burnSubtitles: false,
    });
    expect(result.sceneAudioPaths).toHaveLength(3);
    expect(result.audioPipeline).toBe("dialogue-timeline");
  }, 300_000);
});

describe.runIf(hasFfmpeg)("legacy fallback", () => {
  it("uses the old path ONLY when no scene has dialogue lines", async () => {
    const v = path.join(root, "legacy.mp4");
    await makeVideo(v, 3, "black");
    const a = path.join(root, "legacy.wav");
    await makeLine(a, 2, 200);

    const result = await renderProject({
      projectId: PROJECT,
      scenes: [
        {
          sceneNumber: 1,
          duration: 3,
          subtitle: "Old project",
          videoPath: v,
          audioPath: a,
          imagePath: null,
        },
      ],
      target: { width: 360, height: 640, fps: 30 },
      burnSubtitles: false,
    });

    expect(result.audioPipeline).toBe("legacy-scene-audio");
    expect(result.audioMetrics).toBeUndefined();
  }, 300_000);

  it("an EMPTY dialogueLines array still counts as legacy", async () => {
    const v = path.join(root, "empty-lines.mp4");
    await makeVideo(v, 3, "gray");
    const a = path.join(root, "empty-lines.wav");
    await makeLine(a, 2, 200);

    const result = await renderProject({
      projectId: PROJECT,
      scenes: [
        {
          sceneNumber: 1,
          duration: 3,
          subtitle: "Old project",
          videoPath: v,
          audioPath: a,
          imagePath: null,
          dialogueLines: [],
        },
      ],
      target: { width: 360, height: 640, fps: 30 },
      burnSubtitles: false,
    });
    expect(result.audioPipeline).toBe("legacy-scene-audio");
  }, 300_000);

  it("a mixed project uses the NEW pipeline and pads the legacy scene", async () => {
    // One old scene must not drag a whole project back to the old path.
    const v = path.join(root, "mixed.mp4");
    await makeVideo(v, 3, "purple");
    const legacyAudio = path.join(root, "mixed-legacy.wav");
    const lineAudio = path.join(root, "mixed-line.wav");
    await makeLine(legacyAudio, 2, 200);
    await makeLine(lineAudio, 1.5, 330);

    const result = await renderProject({
      projectId: PROJECT,
      scenes: [
        {
          sceneNumber: 1,
          duration: 3,
          subtitle: "Old scene",
          videoPath: v,
          audioPath: legacyAudio,
          imagePath: null,
          dialogueLines: [],
        },
        {
          sceneNumber: 2,
          duration: 3,
          subtitle: "New scene",
          videoPath: v,
          audioPath: null,
          imagePath: null,
          dialogueLines: [
            { lineNumber: 1, speaker: "Leo", text: "New scene", audioPath: lineAudio, durationSec: 1.5 },
          ],
        },
      ],
      target: { width: 360, height: 640, fps: 30 },
      burnSubtitles: false,
    });

    expect(result.audioPipeline).toBe("dialogue-timeline");
    expect(result.sceneAudioPaths).toHaveLength(2);
  }, 300_000);
});

describe.runIf(hasFfmpeg)("audio longer than the scene", () => {
  // Voice-aware timing (V1.2, QĐ-107): speech is never cut. A scene drawn from
  // a still picture simply lasts as long as its speech; a PAID clip is a fixed
  // length, and a hold of more than 1s to cover the speech is refused rather
  // than shown (the old behaviour froze the last frame for 4s).
  it("ảnh tĩnh / LOCAL_MOTION: cảnh KÉO DÀI cho đủ lời, không cắt lời", async () => {
    const still = path.join(root, "still.png");
    await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=orange:s=360x640", "-frames:v", "1", still]);
    const longLine = path.join(root, "long-line.wav");
    await makeLine(longLine, 6, 240);

    const result = await renderProject({
      projectId: PROJECT,
      scenes: [
        {
          sceneNumber: 1,
          duration: 2,
          subtitle: "A long line",
          videoPath: null,
          audioPath: null,
          imagePath: still,
          motionSource: "LOCAL_MOTION",
          dialogueLines: [
            { lineNumber: 1, speaker: "Leo", text: "A long line", audioPath: longLine, durationSec: 6 },
          ],
        },
      ],
      target: { width: 360, height: 640, fps: 30 },
      burnSubtitles: false,
    });

    expect(result.sceneTimings[0]!.finalDuration).toBeGreaterThanOrEqual(6 + result.sceneTimings[0]!.leadInSec);
    expect(result.durationSeconds).toBeGreaterThan(6);
  }, 300_000);

  it("clip đã mua ngắn hơn lời quá 1s: DỪNG (MEDIA_REGEN_REQUIRED), không kéo khung 4s, không mua gì", async () => {
    const v = path.join(root, "short.mp4");
    await makeVideo(v, 2, "orange");
    const longLine = path.join(root, "long-line.wav");
    await makeLine(longLine, 6, 240);

    await expect(
      renderProject({
        projectId: PROJECT,
        scenes: [
          {
            sceneNumber: 1,
            duration: 2,
            subtitle: "A long line",
            videoPath: v,
            audioPath: null,
            imagePath: null,
            dialogueLines: [
              { lineNumber: 1, speaker: "Leo", text: "A long line", audioPath: longLine, durationSec: 6 },
            ],
          },
        ],
        target: { width: 360, height: 640, fps: 30 },
        burnSubtitles: false,
      }),
    ).rejects.toThrow(/MEDIA_REGEN_REQUIRED/);
  }, 300_000);
});

describe("final mix arguments", () => {
  it("takes video from the clip and audio from the mix, never the clip's own", () => {
    // Mixing the joined video's audio in as well would double every line: the
    // per-scene tracks are already inside the mix.
    const args = buildFinalWithMixArgs({
      videoInput: "joined.mp4",
      audioInput: "mix.wav",
      subtitleFile: null,
      target: DEFAULT_TARGET,
      output: "out.mp4",
    });
    const maps = args.filter((a, i) => args[i - 1] === "-map");
    expect(maps).toEqual(["0:v", "1:a"]);
  });

  it("burns subtitles when one is given", () => {
    const args = buildFinalWithMixArgs({
      videoInput: "joined.mp4",
      audioInput: "mix.wav",
      subtitleFile: "subs.ass",
      target: DEFAULT_TARGET,
      output: "out.mp4",
    });
    expect(args[args.indexOf("-vf") + 1]).toBe("subtitles=subs.ass");
  });
});

describe("mix warnings", () => {
  const stats = (over: Partial<LoudnessStats> = {}): LoudnessStats => ({
    integratedLufs: -16,
    truePeakDb: -1.5,
    lra: 5,
    threshold: -26,
    targetOffset: 0,
    ...over,
  });

  it("calls clipping an error, not a note", () => {
    const w = checkMix({ mix: stats({ truePeakDb: 0.4 }), durationSec: 10 });
    expect(w.find((x) => x.kind === "clipping")?.severity).toBe("error");
    expect(mixIsAcceptable(w)).toBe(false);
  });

  it("warns when the mix is too quiet to hear comfortably", () => {
    const w = checkMix({ mix: stats({ integratedLufs: -24 }), durationSec: 10 });
    expect(w.some((x) => x.kind === "voice_too_quiet")).toBe(true);
  });

  it("warns when the mix is loud enough that YouTube will pull it down", () => {
    const w = checkMix({ mix: stats({ integratedLufs: -11 }), durationSec: 10 });
    expect(w.some((x) => x.kind === "voice_too_loud")).toBe(true);
  });

  it("catches music that has risen above the voice", () => {
    // The single failure the whole mix layer exists to prevent.
    const w = checkMix({
      mix: stats({ integratedLufs: -12 }),
      dialogue: stats({ integratedLufs: -16 }),
      durationSec: 10,
    });
    expect(w.find((x) => x.kind === "music_over_voice")?.severity).toBe("error");
  });

  it("accepts a mix that only rises a little over the dialogue", () => {
    const w = checkMix({
      mix: stats({ integratedLufs: -15.2 }),
      dialogue: stats({ integratedLufs: -16 }),
      durationSec: 10,
    });
    expect(w.some((x) => x.kind === "music_over_voice")).toBe(false);
  });

  it("never suggests cutting the dialogue to fit the scene", () => {
    const w = checkMix({ mix: stats(), durationSec: 12, sceneDurationSec: 8 });
    const over = w.find((x) => x.kind === "audio_longer_than_scene");
    expect(over).toBeDefined();
    expect(over?.suggestion).toMatch(/KHÔNG cắt lời thoại/);
    expect(over?.suggestion).toMatch(/kéo dài cảnh/);
  });

  it("treats an empty render as an error and stops looking", () => {
    const w = checkMix({ mix: stats(), durationSec: 0 });
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("empty_audio");
  });

  it("passes a healthy mix with nothing to say", () => {
    const w = checkMix({
      mix: stats(),
      dialogue: stats({ integratedLufs: -16.1 }),
      durationSec: 10,
      sceneDurationSec: 10,
    });
    expect(w).toHaveLength(0);
    expect(mixIsAcceptable(w)).toBe(true);
    expect(summariseMix(toMetrics(stats(), 10), w)).toMatch(/đạt/);
  });

  it("every warning tells the operator what to do", () => {
    const all = [
      checkMix({ mix: stats({ truePeakDb: 0.4 }), durationSec: 10 }),
      checkMix({ mix: stats({ integratedLufs: -24 }), durationSec: 10 }),
      checkMix({ mix: stats(), durationSec: 12, sceneDurationSec: 8 }),
    ].flat();
    for (const w of all) expect(w.suggestion.length).toBeGreaterThan(20);
  });
});

describe("mix settings validation", () => {
  it("survives a settings object with knobs missing", () => {
    const r = resolveMix({ musicGain: 0.4 });
    expect(r.musicGain).toBe(0.4);
    expect(r.duckDb).toBeGreaterThan(0);
    expect(r.releaseMs).toBeGreaterThan(0);
  });

  it("survives an empty object", () => {
    expect(resolveMix({})).toEqual(resolveMix());
  });

  it("clamps rather than throwing, so a bad value cannot fail a render", () => {
    const r = resolveMix({ musicGain: 99, duckDb: -1, attackMs: 0, sfxGain: -5 });
    expect(r.musicGain).toBe(1);
    expect(r.duckDb).toBe(0);
    expect(r.attackMs).toBeGreaterThanOrEqual(1);
    expect(r.sfxGain).toBe(0);
  });

  it("ignores a non-numeric value instead of producing NaN", () => {
    const r = resolveMix({ musicGain: Number.NaN, duckDb: Number.NaN });
    expect(Number.isFinite(r.musicGain)).toBe(true);
    expect(Number.isFinite(r.duckDb)).toBe(true);
  });
});
