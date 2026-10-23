import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { projectSubdir, toAbsolute, toRelative } from "@/lib/paths";
import { ffmpeg, ffmpegAvailable, ffprobe, probeDuration } from "@/media/ffmpeg";
import {
  allPresets,
  duckGainDbAt,
  duckVolumeExpression,
  MUSIC_REF_LUFS,
  mergeSpeechRegions,
  musicGainDb,
  presetToAudioPatch,
  previewWindow,
  SYSTEM_AUDIO_PRESETS,
  systemPreset,
} from "@/domain/audio-mixer";
import { controlsOf, mergeControls } from "@/domain/output-controls";
import { buildMixerGraph, manifestDirFor, readAudioManifest, renderMixerMix, type MixerRenderSettings } from "@/media/audio-mixer-render";
import { DEFAULT_TARGET, renderProject, type RenderRequest, type RenderScene } from "@/media/render";
import { renderRecipeHash } from "@/services/render-recipe";
import { applyOutputControls, saveProjectControls, setBackgroundMusic } from "@/services/output-controls";
import {
  applyAudioPresetToBatch,
  applyAudioPresetToProject,
  audioPreview,
  deleteCustomAudioPreset,
  enqueueBatchRemix,
  newProjectControlsJson,
  remixAvailability,
  remixProjectAudio,
  REMIX_NO_SOURCES,
  saveCustomAudioPreset,
} from "@/services/audio-mixer-service";
import { getSettings, saveSettings } from "@/lib/settings";
import { runJob } from "@/jobs/handlers";

/**
 * QĐ-150 AUDIO MIXER. Pure maths first, then real FFmpeg on synthetic tones
 * (no network, $0): the bed is rendered ALONE (voice at 0) wherever a level is
 * asserted, so every number is the music's own and not the voice's.
 */

const hasFfmpeg = ffmpegAvailable();
const TAG = "qd150";
let root = "";

const BASE: MixerRenderSettings = {
  musicPct: 1,
  duckDb: 6,
  attackMs: 200,
  releaseMs: 800,
  fadeInSec: 0,
  fadeOutSec: 0,
  sfxGain: 0.5,
  voice: { gain: 1, normalize: false },
};

async function tone(file: string, seconds: number, freq: number, amp: number, channels = 1): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}:sample_rate=48000`,
    "-af", `volume=${amp}`, "-ac", String(channels), "-c:a", "pcm_s16le", file,
  ]);
}

/** Voice track of `total` s with tone "lines" at the given regions. */
async function voiceTrack(file: string, total: number, regions: { startSec: number; endSec: number }[]): Promise<void> {
  const expr = regions.length ? regions.map((r) => `between(t,${r.startSec},${r.endSec})`).join("+") : "0";
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=300:duration=${total}:sample_rate=24000`,
    "-af", `volume='0.3*(${expr})':eval=frame`, "-ac", "1", "-c:a", "pcm_s16le", file,
  ]);
}

async function makeVideo(file: string, seconds: number, colour: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${colour}:s=360x640:d=${seconds}:r=30`,
    "-f", "lavfi", "-i", `anullsrc=r=24000:cl=mono:d=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file,
  ]);
}

/**
 * Power of a window in dB, summed over channels (as loudness meters do): a
 * mono line and the same line centred in stereo at -3 dB a side read the same.
 */
async function levelDb(file: string, from: number, to: number): Promise<number> {
  const raw = path.join(root, `probe-${Math.random().toString(36).slice(2)}.f32`);
  const r = await ffprobe(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", file]);
  const channels = Number(r.stdout.trim()) || 1;
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-ss", String(from), "-to", String(to), "-i", file, "-vn", "-f", "f32le", raw]);
  const buf = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  const s = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  let sum = 0;
  for (const v of s) sum += v * v;
  return s.length === 0 ? -120 : 10 * Math.log10((sum * channels) / s.length + 1e-12);
}

async function peakDb(file: string): Promise<number> {
  const raw = path.join(root, `peak-${Math.random().toString(36).slice(2)}.f32`);
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-f", "f32le", raw]);
  const buf = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  const s = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  let peak = 0;
  for (const v of s) peak = Math.max(peak, Math.abs(v));
  return 20 * Math.log10(peak + 1e-12);
}

/** "48000 Hz, stereo"-style summary of the first audio stream. */
async function streamInfo(file: string): Promise<string> {
  const r = await ffprobe(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", file]);
  const [rate, channels] = r.stdout.trim().split(",");
  return `${rate} Hz, ${channels === "2" ? "stereo" : `${channels} ch`}`;
}

async function videoMd5(file: string): Promise<string> {
  const r = await ffmpeg(["-hide_banner", "-loglevel", "error", "-i", file, "-map", "0:v", "-c", "copy", "-f", "md5", "-"]);
  return r.stdout.trim();
}

beforeAll(() => {
  root = toAbsolute(projectSubdir(`${TAG}-scratch`, "temp"));
  fs.mkdirSync(root, { recursive: true });
});

afterAll(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

// --------------------------------------------------------------------- pure ---

describe("QĐ-150 audio mixer - pure", () => {
  const opts = { duckDb: 6, attackMs: 200, releaseMs: 800 };

  it("bridges pauses shorter than attack + release and keeps long ones", () => {
    const merged = mergeSpeechRegions(
      [
        { startSec: 5, endSec: 6 },
        { startSec: 1, endSec: 2 },
        { startSec: 2.6, endSec: 3 }, // 0.6 s scene-change pause -> bridged
        { startSec: 4, endSec: 3.5 }, // empty -> dropped
      ],
      1,
    );
    expect(merged).toEqual([
      { startSec: 1, endSec: 3 },
      { startSec: 5, endSec: 6 },
    ]);
  });

  it("ducks exactly duckDb under speech, holds through a short pause, recovers in a long one", () => {
    const regions = [
      { startSec: 1, endSec: 3 },
      { startSec: 3.6, endSec: 5 }, // 0.6 s pause
      { startSec: 9, endSec: 10 }, // 4 s pause
    ];
    expect(duckGainDbAt(0.5, regions, opts)).toBe(0);
    expect(duckGainDbAt(0.9, regions, opts)).toBeCloseTo(-3, 5); // halfway down the attack, before the word
    expect(duckGainDbAt(2, regions, opts)).toBeCloseTo(-6, 5);
    expect(duckGainDbAt(3.3, regions, opts)).toBeCloseTo(-6, 5); // inside the short pause: no swell
    expect(duckGainDbAt(5.4, regions, opts)).toBeCloseTo(-3, 5); // halfway up the release
    expect(duckGainDbAt(7, regions, opts)).toBe(0); // long pause: music back
    expect(duckGainDbAt(9.5, regions, opts)).toBeCloseTo(-6, 5);
  });

  it("never steps more than the ramp allows (no jump)", () => {
    const regions = Array.from({ length: 12 }, (_, i) => ({ startSec: i * 2.1, endSec: i * 2.1 + 1.5 }));
    let worst = 0;
    for (let t = 0; t < 26; t += 0.01) worst = Math.max(worst, Math.abs(duckGainDbAt(t + 0.01, regions, opts) - duckGainDbAt(t, regions, opts)));
    // 6 dB over 200 ms = 0.3 dB per 10 ms at most.
    expect(worst).toBeLessThanOrEqual(0.3 + 1e-9);
  });

  it("no curve without speech or without depth", () => {
    expect(duckVolumeExpression([], opts)).toBeNull();
    expect(duckVolumeExpression([{ startSec: 1, endSec: 2 }], { ...opts, duckDb: 0 })).toBeNull();
    expect(duckVolumeExpression([{ startSec: 1, endSec: 2 }], opts)).toContain("pow(10,-6*");
  });

  it("100 % music = the reference loudness, percent is amplitude", () => {
    expect(musicGainDb(MUSIC_REF_LUFS, 1)).toBe(0);
    expect(musicGainDb(-13.1, 1)).toBeCloseTo(-6.2, 5); // the approved AIVietLab render
    expect(musicGainDb(-13.1, 2)).toBeCloseTo(-6.2 + 6.02, 2);
    expect(musicGainDb(-13.1, 0)).toBeNull();
    expect(musicGainDb(-70, 1)).toBe(20); // a near-silent track is not boosted without limit
  });

  it("five system presets; values are copied, not linked; no-voice never ducks", () => {
    expect(SYSTEM_AUDIO_PRESETS.map((p) => p.id)).toEqual(["REVIEW_AI", "FUNNY", "STORY", "PRODUCT", "NO_VOICE"]);
    const review = systemPreset("REVIEW_AI")!;
    const patch = presetToAudioPatch(review);
    expect(patch.mixer).toMatchObject({ presetId: "REVIEW_AI", musicPct: 1, duckDb: 6, attackMs: 200, releaseMs: 800 });
    patch.mixer.musicPct = 2;
    expect(systemPreset("REVIEW_AI")!.values.musicPct).toBe(1);
    expect(presetToAudioPatch(systemPreset("NO_VOICE")!).duckMusic).toBe(false);
    // A custom preset can never shadow a system id.
    const list = allPresets([{ id: "REVIEW_AI", name: "x", values: review.values }, { id: "custom-1", name: "Mine", values: review.values }]);
    expect(list.filter((p) => p.id === "REVIEW_AI")).toHaveLength(1);
    expect(list.find((p) => p.id === "custom-1")?.system).toBe(false);
  });

  it("preview windows: first line, longest pause, scene change nearest the middle", () => {
    const input = { totalSec: 30, regions: [{ startSec: 2, endSec: 8 }, { startSec: 20, endSec: 28 }], sceneStartsSec: [0, 9, 16, 24] };
    expect(previewWindow("SPEECH", input)).toEqual({ startSec: 1, endSec: 9 });
    expect(previewWindow("GAP", input)).toEqual({ startSec: 10, endSec: 18 });
    expect(previewWindow("TRANSITION", input)).toEqual({ startSec: 12, endSec: 20 });
    expect(previewWindow("SPEECH", { ...input, regions: [] })).toBeNull();
    expect(previewWindow("TRANSITION", { ...input, sceneStartsSec: [0] })).toBeNull();
  });

  it("old projects read no mixer; a partial mixer change merges; null turns it off", () => {
    const legacy = controlsOf({ contentType: null, outputControlsJson: null });
    expect(legacy.audio.mixer).toBeNull();
    const on = mergeControls(legacy, { audio: presetToAudioPatch(systemPreset("REVIEW_AI")!) });
    const moved = mergeControls(on, { audio: { mixer: { musicPct: 1.1 } } });
    expect(moved.audio.mixer).toMatchObject({ musicPct: 1.1, duckDb: 6, presetId: "REVIEW_AI" });
    expect(mergeControls(moved, { audio: { mixer: null } }).audio.mixer).toBeNull();
  });

  it("render recipe is unchanged without a mixer and changes with one", () => {
    const req: RenderRequest = { projectId: "p", scenes: [], target: DEFAULT_TARGET, burnSubtitles: false };
    const before = renderRecipeHash(req);
    expect(renderRecipeHash({ ...req })).toBe(before);
    const withMixer = renderRecipeHash({ ...req, audioMixer: { musicPct: 1, duckDb: 6, attackMs: 200, releaseMs: 800, fadeInSec: 1, fadeOutSec: 1.5 } });
    expect(withMixer).not.toBe(before);
    expect(renderRecipeHash({ ...req, audioMixer: { musicPct: 1.1, duckDb: 6, attackMs: 200, releaseMs: 800, fadeInSec: 1, fadeOutSec: 1.5 } })).not.toBe(withMixer);
  });

  it("new projects get the Settings preset; none = old mix", () => {
    const json = newProjectControlsJson({ audioPresets: [], newProjectAudioPresetId: "STORY" }, { voice: { director: true } });
    const parsed = JSON.parse(json!);
    expect(parsed.voice).toEqual({ director: true });
    expect(parsed.audio.mixer.presetId).toBe("STORY");
    expect(newProjectControlsJson({ audioPresets: [], newProjectAudioPresetId: null })).toBeNull();
  });

  it("the voice is never faded and music fades only at the ends", () => {
    const g = buildMixerGraph({
      dialoguePath: "v.wav",
      totalSec: 20,
      regions: [],
      musicPath: "m.wav",
      musicLufs: MUSIC_REF_LUFS,
      settings: { ...BASE, fadeInSec: 1, fadeOutSec: 2 },
    }).graph;
    const voice = g.split(";").find((p) => p.endsWith("[voice]"))!;
    expect(voice).not.toContain("afade");
    expect(g.match(/afade=t=in/g)).toHaveLength(1);
    expect(g).toContain("afade=t=out:st=18:d=2");
    expect(g).toContain("alimiter");
  });
});

// ---------------------------------------------------------------- real ffmpeg ---

describe.skipIf(!hasFfmpeg)("QĐ-150 audio mixer - real FFmpeg", () => {
  // Lines with 0.6 s scene-change pauses, then a 4 s pause, then a last line.
  const total = 16;
  const regions = [
    { startSec: 1, endSec: 3 },
    { startSec: 3.6, endSec: 5.4 },
    { startSec: 6, endSec: 7 },
    { startSec: 11, endSec: 13 },
  ];
  let voice = "";
  let longMusic = "";
  let shortMusic = "";

  beforeAll(async () => {
    voice = path.join(root, "voice.wav");
    longMusic = path.join(root, "music-long.wav");
    shortMusic = path.join(root, "music-short.wav");
    await voiceTrack(voice, total, regions);
    await tone(longMusic, 40, 440, 0.2, 2);
    await tone(shortMusic, 5, 440, 0.2, 2);
  });

  const bedOnly = { ...BASE, voice: { gain: 0, normalize: false } };

  it("bed stays ducked through 0.6 s pauses and recovers in a long one - no jump", async () => {
    const out = path.join(root, "bed-duck.wav");
    await renderMixerMix({ dialoguePath: voice, totalSec: total, regions, musicPath: longMusic, musicLufs: null, settings: bedOnly }, out);
    const free = await levelDb(out, 0.1, 0.7);
    const speaking = await levelDb(out, 1.5, 2.5);
    const shortPause = await levelDb(out, 3.1, 3.5);
    const longPause = await levelDb(out, 8.5, 10);
    expect(speaking - free).toBeCloseTo(-6, 0);
    expect(shortPause - free).toBeCloseTo(-6, 0);
    expect(Math.abs(longPause - free)).toBeLessThan(0.3);
    // 50 ms steps across the whole file: never more than the ramp (6 dB / 200 ms = 1.5 dB per 50 ms) + margin.
    let prev = await levelDb(out, 0, 0.05);
    let worst = 0;
    for (let t = 0.05; t < total - 0.05; t += 0.05) {
      const cur = await levelDb(out, t, t + 0.05);
      worst = Math.max(worst, Math.abs(cur - prev));
      prev = cur;
    }
    expect(worst).toBeLessThan(2);
  });

  it("music is continuous: a short song loops to the end, a long one is cut to the video", async () => {
    const shortOut = path.join(root, "bed-short.wav");
    await renderMixerMix({ dialoguePath: voice, totalSec: total, regions: [], musicPath: shortMusic, musicLufs: null, settings: bedOnly }, shortOut);
    // Still the song's own level in the last second: it looped, it did not run out.
    expect(Math.abs((await levelDb(shortOut, total - 1, total - 0.1)) - (await levelDb(shortOut, 1, 2)))).toBeLessThan(0.5);
    expect(await probeDuration(shortOut)).toBeCloseTo(total, 1);
    const longOut = path.join(root, "bed-long.wav");
    await renderMixerMix({ dialoguePath: voice, totalSec: total, regions: [], musicPath: longMusic, musicLufs: null, settings: bedOnly }, longOut);
    expect(await probeDuration(longOut)).toBeCloseTo(total, 1);
    const info = await streamInfo(longOut);
    expect(info).toMatch(/48000 Hz, stereo/);
  });

  it("no voice: nothing is ducked; effects are mixed in", async () => {
    const fx = path.join(root, "fx.wav");
    await tone(fx, 0.5, 1200, 0.5);
    const out = path.join(root, "novoice.wav");
    await renderMixerMix({ dialoguePath: voice, totalSec: total, regions: [], musicPath: longMusic, musicLufs: null, sfx: [{ path: fx, atSec: 9 }], settings: bedOnly }, out);
    const a = await levelDb(out, 2, 3);
    const b = await levelDb(out, 12, 13);
    expect(Math.abs(a - b)).toBeLessThan(0.3);
    expect(await levelDb(out, 9.1, 9.4)).toBeGreaterThan(a + 1);
  });

  it("music volume moves only the music; the voice level is untouched", async () => {
    const quiet = path.join(root, "mix-100.wav");
    const loud = path.join(root, "mix-200.wav");
    const noMusic = { ...BASE, musicPct: 0 };
    const silentBed = path.join(root, "voice-only.wav");
    await renderMixerMix({ dialoguePath: voice, totalSec: total, regions, musicPath: longMusic, musicLufs: null, settings: noMusic }, silentBed);
    await renderMixerMix({ dialoguePath: voice, totalSec: total, regions, musicPath: longMusic, musicLufs: null, settings: { ...bedOnly, musicPct: 1 } }, quiet);
    await renderMixerMix({ dialoguePath: voice, totalSec: total, regions, musicPath: longMusic, musicLufs: null, settings: { ...bedOnly, musicPct: 2 } }, loud);
    expect((await levelDb(loud, 8.5, 10)) - (await levelDb(quiet, 8.5, 10))).toBeCloseTo(6.02, 0);
    // Voice alone, at 100 %: the same power as the source line (-3 dB a side, two sides).
    const src = await levelDb(voice, 1.5, 2.5);
    expect(await levelDb(silentBed, 1.5, 2.5)).toBeCloseTo(src, 0);
  });

  it("fade only on the music, at the ends; the first word is not faded", async () => {
    const early = path.join(root, "voice-early.wav");
    await voiceTrack(early, 8, [{ startSec: 0, endSec: 8 }]);
    const out = path.join(root, "fade.wav");
    await renderMixerMix(
      { dialoguePath: early, totalSec: 8, regions: [], musicPath: null, sfx: [], settings: { ...BASE, fadeInSec: 2, fadeOutSec: 2 } },
      out,
    );
    expect(Math.abs((await levelDb(out, 0, 0.4)) - (await levelDb(out, 4, 4.4)))).toBeLessThan(0.3);
  });

  it("a very loud mix is limited below 0 dBFS (no clipping)", async () => {
    const hot = path.join(root, "music-hot.wav");
    await tone(hot, 20, 440, 0.9, 2);
    const out = path.join(root, "hot.wav");
    await renderMixerMix(
      { dialoguePath: voice, totalSec: total, regions, musicPath: hot, musicLufs: -40, settings: { ...BASE, musicPct: 2, duckDb: 0, voice: { gain: 2, normalize: false } } },
      out,
    );
    expect(await peakDb(out)).toBeLessThan(-0.5);
  });

  it("preview: a short MP3 of one window, same clock as the full mix", async () => {
    const out = path.join(root, "preview.mp3");
    await renderMixerMix({ dialoguePath: voice, totalSec: total, regions, musicPath: longMusic, musicLufs: null, settings: BASE }, out, { window: { startSec: 2, endSec: 6 }, format: "mp3" });
    expect(await probeDuration(out)).toBeGreaterThan(3.8);
    expect(await probeDuration(out)).toBeLessThan(4.3);
  });

  it("a long video with many lines goes through a filter script (no command-line limit)", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ startSec: i * 2, endSec: i * 2 + 0.5 }));
    const longVoice = path.join(root, "voice-long.wav");
    await voiceTrack(longVoice, 300, []);
    const out = path.join(root, "long.wav");
    await renderMixerMix({ dialoguePath: longVoice, totalSec: 300, regions: many, musicPath: longMusic, musicLufs: null, settings: BASE }, out);
    expect(await probeDuration(out)).toBeCloseTo(300, 0);
    expect(fs.existsSync(`${out}.filter.txt`)).toBe(false);
  });
});

// ------------------------------------------------- render, remix, presets, batch ---

describe.skipIf(!hasFfmpeg)("QĐ-150 render + REMIX AUDIO + batch", () => {
  let projectId = "";
  let otherId = "";
  let batchId = "";
  let musicFile = "";

  async function scenesFor(id: string, n: number): Promise<RenderScene[]> {
    const scenes: RenderScene[] = [];
    for (let i = 1; i <= n; i += 1) {
      const video = toAbsolute(path.join(projectSubdir(id, "videos"), `s${i}.mp4`));
      const line = toAbsolute(path.join(projectSubdir(id, "audio"), `line-${i}.wav`));
      await makeVideo(video, 3, ["red", "green", "blue", "black"][i % 4]!);
      await tone(line, 1.6, 300 + i * 40, 0.3);
      scenes.push({
        sceneNumber: i,
        duration: 3,
        subtitle: `Câu ${i}`,
        videoPath: video,
        imagePath: null,
        audioPath: null,
        dialogueLines: [{ lineNumber: 1, speaker: "Narrator", text: `Câu ${i}`, audioPath: line, durationSec: 1.6, pauseAfterMs: 600 }],
      } as RenderScene);
    }
    return scenes;
  }

  beforeAll(async () => {
    const idiom = await prisma.idiom.create({
      data: { phrase: `qd150 ${Date.now()}`, slug: `qd150-${Date.now()}`, meaning: "m", literalMeaning: "l", exampleSentence: "e", category: "test-qd150" },
    });
    const batch = await prisma.batch.create({ data: { name: `qd150 batch ${Date.now()}` } });
    batchId = batch.id;
    const p = await prisma.project.create({ data: { idiomId: idiom.id, title: "QĐ-150 A", batchId } });
    const q = await prisma.project.create({ data: { idiomId: idiom.id, title: "QĐ-150 B", batchId } });
    projectId = p.id;
    otherId = q.id;
    musicFile = path.join(root, "bed-src.wav");
    await tone(musicFile, 30, 440, 0.2, 2);
    await setBackgroundMusic(projectId, fs.readFileSync(musicFile), "bed.wav");
  });

  afterAll(async () => {
    await prisma.job.deleteMany({ where: { projectId: { in: [projectId, otherId] } } });
    await prisma.asset.deleteMany({ where: { projectId: { in: [projectId, otherId] } } });
    await prisma.project.deleteMany({ where: { id: { in: [projectId, otherId] } } });
    await prisma.batch.deleteMany({ where: { id: batchId } });
    for (const id of [projectId, otherId]) fs.rmSync(path.dirname(toAbsolute(projectSubdir(id, "temp"))), { recursive: true, force: true });
  });

  it("an old project (no mixer) renders the old way, still keeps its sources", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const req: RenderRequest = { projectId, scenes: await scenesFor(projectId, 3), target: DEFAULT_TARGET, burnSubtitles: false };
    await applyOutputControls(project, [], req);
    expect(req.audioMixer).toBeUndefined();
    const r = await renderProject(req);
    expect(r.audioEngine).toBe("legacy");
    expect(r.audioManifestPath && fs.existsSync(r.audioManifestPath)).toBe(true);
  });

  it("with a preset: mixer render, regions from the timeline, sources kept; remix keeps the picture and moves the music", async () => {
    await applyAudioPresetToProject(projectId, "REVIEW_AI");
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const req: RenderRequest = { projectId, scenes: await scenesFor(projectId, 3), target: DEFAULT_TARGET, burnSubtitles: false };
    await applyOutputControls(project, [], req);
    expect(req.audioMixer).toMatchObject({ musicPct: 1, duckDb: 6 });
    const r = await renderProject(req);
    expect(r.audioEngine).toBe("mixer");
    expect(await streamInfo(r.videoPath)).toMatch(/48000 Hz, stereo/);
    const manifest = readAudioManifest(manifestDirFor(projectSubdir(projectId, "audio"), path.basename(r.videoPath)))!;
    expect(manifest.regions).toHaveLength(3);
    expect(manifest.sceneStartsSec).toHaveLength(3);
    expect(manifest.regions[1]!.startSec).toBeGreaterThan(manifest.sceneStartsSec[1]!);
    await prisma.project.update({ where: { id: projectId }, data: { finalVideoPath: toRelative(r.videoPath), status: "completed", renderRecipe: "x" } });

    // Preview of each moment - local, no picture.
    const pv = await audioPreview(projectId, "TRANSITION");
    expect(fs.existsSync(toAbsolute(pv.path))).toBe(true);

    // Louder music, then REMIX through the job handler.
    await saveProjectControls(projectId, { audio: { mixer: { musicPct: 2 } } });
    expect((await remixAvailability(projectId)).ok).toBe(true);
    const job = await prisma.job.create({ data: { type: "remix_audio", projectId } });
    const out = await runJob(job);
    expect(out.deferred).toBe(false);
    const after = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(after.finalVideoPath).not.toBe(toRelative(r.videoPath));
    expect(after.renderRecipe).toBeNull();
    expect(fs.existsSync(r.videoPath)).toBe(true); // the old file is left in place
    const remixed = toAbsolute(after.finalVideoPath!);
    expect(await videoMd5(remixed)).toBe(await videoMd5(r.videoPath)); // picture stream-copied
    // Between two lines only music plays (ducked the same in both): +6 dB.
    const gapFrom = manifest.regions[0]!.endSec + 0.05;
    const gapTo = manifest.regions[1]!.startSec - 0.05;
    expect(gapTo - gapFrom).toBeGreaterThan(0.25);
    expect((await levelDb(remixed, gapFrom, gapTo)) - (await levelDb(r.videoPath, gapFrom, gapTo))).toBeCloseTo(6.02, 0);
    // ...and the remixed file can be remixed again.
    expect((await remixAvailability(projectId)).ok).toBe(true);
    expect(await prisma.asset.count({ where: { projectId, kind: "final", model: "remix-audio" } })).toBe(1);
  });

  it("a video without kept sources says so instead of guessing", async () => {
    const fake = toAbsolute(path.join(projectSubdir(otherId, "final"), "final_old.mp4"));
    await makeVideo(fake, 2, "white");
    await prisma.project.update({ where: { id: otherId }, data: { finalVideoPath: toRelative(fake) } });
    const a = await remixAvailability(otherId);
    expect(a.ok).toBe(false);
    expect(a.message).toBe(REMIX_NO_SOURCES);
    await expect(remixProjectAudio(otherId)).rejects.toThrow(/không còn track nguồn/);
  });

  it("batch: one preset for all, each video stays independent; batch remix queues only what can work", async () => {
    expect(await applyAudioPresetToBatch(batchId, "STORY")).toBe(2);
    await applyAudioPresetToProject(otherId, "FUNNY");
    const [a, b] = await Promise.all([prisma.project.findUniqueOrThrow({ where: { id: projectId } }), prisma.project.findUniqueOrThrow({ where: { id: otherId } })]);
    expect(controlsOf(a).audio.mixer?.presetId).toBe("STORY");
    expect(controlsOf(b).audio.mixer?.presetId).toBe("FUNNY");
    const r = await enqueueBatchRemix(batchId);
    expect(r.queued).toBe(1);
    expect(r.skipped.map((s) => s.title)).toEqual(["QĐ-150 B"]);
    expect(await prisma.job.count({ where: { batchId, type: "remix_audio", status: "queued" } })).toBe(1);
  });

  it("custom presets: create, edit, delete; system presets are protected; projects keep copied values", async () => {
    const before = await getSettings();
    try {
      const p = await saveCustomAudioPreset({ name: "Thử QĐ-150", values: { ...systemPreset("REVIEW_AI")!.values, musicPct: 1.25 } });
      await applyAudioPresetToProject(otherId, p.id);
      await saveCustomAudioPreset({ id: p.id, name: "Thử QĐ-150", values: { ...systemPreset("REVIEW_AI")!.values, musicPct: 0.5 } });
      await expect(saveCustomAudioPreset({ id: "REVIEW_AI", name: "x", values: systemPreset("REVIEW_AI")!.values })).rejects.toThrow(/hệ thống/);
      await expect(deleteCustomAudioPreset("REVIEW_AI")).rejects.toThrow(/hệ thống/);
      await deleteCustomAudioPreset(p.id);
      const b = await prisma.project.findUniqueOrThrow({ where: { id: otherId } });
      expect(controlsOf(b).audio.mixer?.musicPct).toBe(1.25);
    } finally {
      await saveSettings({ audioPresets: before.audioPresets, newProjectAudioPresetId: before.newProjectAudioPresetId });
    }
  });
});
