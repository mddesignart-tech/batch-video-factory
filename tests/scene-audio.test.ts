import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildSceneTimeline,
  clampPause,
  hasOverlap,
  projectOffsets,
  DEFAULT_PAUSE_SAME_SPEAKER,
  DEFAULT_PAUSE_SPEAKER_CHANGE,
  MAX_PAUSE,
  MIN_PAUSE,
} from "@/domain/scene-timeline";
import {
  buildFinalMixGraph,
  renderDuckedBedOnly,
  renderSceneDialogue,
  renderFinalMix,
  concatSceneDialogue,
} from "@/media/scene-audio";
import {
  DEFAULT_MIX,
  ratioForDuck,
  resolveMix,
  thresholdForDuck,
} from "@/media/mix-config";
import { cuesFromTimelines } from "@/media/subtitles";
import { ffmpeg, ffmpegAvailable } from "@/media/ffmpeg";

let tmp = "";
const hasFfmpeg = ffmpegAvailable();

function line(
  n: number,
  speaker: string,
  durationSec: number,
  audioPath = `line${n}.wav`,
  pauseAfterOverride?: number,
) {
  return {
    lineNumber: n,
    speaker,
    text: `${speaker} line ${n}`,
    audioPath,
    durationSec,
    pauseAfterOverride,
  };
}

/** Tone then silence then tone, so a ducking window and a gap both exist. */
async function makeSpeechPattern(file: string): Promise<void> {
  await ffmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=3",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=24000:cl=mono:d=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=3",
    "-filter_complex",
    "[0:a]volume=0.4[a0];[2:a]volume=0.4[a2];[a0][1:a][a2]concat=n=3:v=0:a=1,aresample=24000[out]",
    "-map",
    "[out]",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    file,
  ]);
}

async function makeTone(file: string, seconds: number, amplitude = 0.3): Promise<void> {
  await ffmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=300:duration=${seconds}`,
    "-af",
    `volume=${amplitude},aresample=24000`,
    "-ar",
    "24000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    file,
  ]);
}

/** Mean square level of a window, read straight from the samples. */
async function windowRms(file: string, fromSec: number, toSec: number): Promise<number> {
  const raw = path.join(tmp, `win-${Math.random().toString(36).slice(2)}.f32`);
  await ffmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(fromSec),
    "-to",
    String(toSec),
    "-i",
    file,
    "-ac",
    "1",
    "-f",
    "f32le",
    raw,
  ]);
  const buf = fs.readFileSync(raw);
  const samples = new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
  fs.rmSync(raw, { force: true });
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return samples.length === 0 ? 0 : Math.sqrt(sum / samples.length);
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sceneaudio-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("scene timeline", () => {
  it("places three speakers in order without overlap", () => {
    // The case the old one-file-per-scene design could not represent.
    const t = buildSceneTimeline(
      [line(1, "Max", 2), line(2, "Leo", 3), line(3, "Mia", 2)],
      6,
    );
    expect(t.entries.map((e) => e.speaker)).toEqual(["Max", "Leo", "Mia"]);
    expect(hasOverlap(t)).toBe(false);
  });

  it("NEVER lets two lines sound at once", () => {
    const t = buildSceneTimeline(
      [line(1, "Max", 2), line(2, "Leo", 2), line(3, "Max", 2)],
      6,
    );
    for (let i = 1; i < t.entries.length; i += 1) {
      expect(t.entries[i]?.startSec).toBeGreaterThanOrEqual(t.entries[i - 1]?.endSec ?? 0);
    }
  });

  it("gives a change of speaker more room than the same speaker continuing", () => {
    const changed = buildSceneTimeline([line(1, "Max", 2), line(2, "Leo", 2)], 6);
    const same = buildSceneTimeline([line(1, "Max", 2), line(2, "Max", 2)], 6);
    expect(changed.entries[0]?.pauseAfterSec).toBe(DEFAULT_PAUSE_SPEAKER_CHANGE);
    expect(same.entries[0]?.pauseAfterSec).toBe(DEFAULT_PAUSE_SAME_SPEAKER);
  });

  it("keeps every pause inside the 150-300ms brief", () => {
    const t = buildSceneTimeline(
      [line(1, "Max", 2), line(2, "Leo", 2), line(3, "Mia", 2)],
      6,
    );
    for (const entry of t.entries.slice(0, -1)) {
      expect(entry.pauseAfterSec).toBeGreaterThanOrEqual(MIN_PAUSE);
      expect(entry.pauseAfterSec).toBeLessThanOrEqual(MAX_PAUSE);
    }
  });

  it("adds no pause after the last line", () => {
    const t = buildSceneTimeline([line(1, "Max", 2), line(2, "Leo", 2)], 6);
    expect(t.entries[1]?.pauseAfterSec).toBe(0);
  });

  it("honours a script override", () => {
    const t = buildSceneTimeline(
      [line(1, "Max", 2, "a.wav", 0.25), line(2, "Leo", 2)],
      6,
    );
    expect(t.entries[0]?.pauseAfterSec).toBe(0.25);
  });

  it("CLAMPS an override that would stall or collide", () => {
    // A two-second beat stalls a Short; zero runs two speakers together. Both
    // are worse than the default the script was trying to improve on.
    const long = buildSceneTimeline([line(1, "Max", 2, "a.wav", 2), line(2, "Leo", 2)], 6);
    const zero = buildSceneTimeline([line(1, "Max", 2, "a.wav", 0), line(2, "Leo", 2)], 6);
    expect(long.entries[0]?.pauseAfterSec).toBe(MAX_PAUSE);
    expect(zero.entries[0]?.pauseAfterSec).toBe(MIN_PAUSE);
    expect(clampPause(Number.NaN)).toBe(DEFAULT_PAUSE_SAME_SPEAKER);
  });

  it("EXTENDS the scene when speech runs longer than the visuals", () => {
    // Cutting the picture while someone is still talking is the one outcome
    // neither figure should be allowed to cause.
    const t = buildSceneTimeline([line(1, "Leo", 12)], 6);
    expect(t.sceneDurationSec).toBeGreaterThanOrEqual(12);
    expect(t.extended).toBe(true);
  });

  it("keeps the planned duration when speech is shorter", () => {
    const t = buildSceneTimeline([line(1, "Max", 2)], 6);
    expect(t.sceneDurationSec).toBe(6);
    expect(t.extended).toBe(false);
  });

  it("sorts by line number rather than trusting the array order", () => {
    const t = buildSceneTimeline([line(3, "Mia", 1), line(1, "Max", 1), line(2, "Leo", 1)], 6);
    expect(t.entries.map((e) => e.lineNumber)).toEqual([1, 2, 3]);
  });

  it("lays scenes end to end on the project clock", () => {
    const a = buildSceneTimeline([line(1, "Max", 2)], 6);
    const b = buildSceneTimeline([line(1, "Leo", 12)], 6);
    expect(projectOffsets([a, b])).toEqual([0, 6]);
  });
});

describe("subtitles come from the timeline itself", () => {
  it("puts each caption where its line actually speaks", () => {
    const t = buildSceneTimeline([line(1, "Max", 2), line(2, "Leo", 3)], 6);
    const cues = cuesFromTimelines([t]);
    expect(cues[0]?.startSeconds).toBe(0);
    expect(cues[1]?.startSeconds).toBe(t.entries[1]?.startSec);
  });

  it("does not divide the scene evenly between lines", () => {
    // Even division is the bug: a 2s line and a 6s line would each get 4s.
    const t = buildSceneTimeline([line(1, "Max", 2), line(2, "Leo", 6)], 10);
    const cues = cuesFromTimelines([t]);
    const first = (cues[0]?.endSeconds ?? 0) - (cues[0]?.startSeconds ?? 0);
    const second = (cues[1]?.endSeconds ?? 0) - (cues[1]?.startSeconds ?? 0);
    expect(second).toBeGreaterThan(first * 2);
  });

  it("offsets later scenes by the scenes before them", () => {
    const a = buildSceneTimeline([line(1, "Max", 2)], 6);
    const b = buildSceneTimeline([line(1, "Leo", 2)], 6);
    const cues = cuesFromTimelines([a, b]);
    expect(cues[1]?.startSeconds).toBe(6);
  });
});

describe("mix settings", () => {
  it("has safe defaults that keep speech on top", () => {
    expect(DEFAULT_MIX.musicGain).toBeLessThanOrEqual(0.3);
    expect(DEFAULT_MIX.duckDb).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_MIX.sfxGain).toBeLessThanOrEqual(0.6);
  });

  it("clamps nonsense from a settings form instead of failing a render", () => {
    const r = resolveMix({ musicGain: 500, duckDb: -4, attackMs: 0, releaseMs: 99999 });
    expect(r.musicGain).toBe(1);
    expect(r.duckDb).toBe(0);
    expect(r.attackMs).toBeGreaterThanOrEqual(1);
    expect(r.releaseMs).toBeLessThanOrEqual(2000);
  });

  it("disables the duck when asked for none", () => {
    expect(ratioForDuck(0)).toBe(1);
    expect(thresholdForDuck(0)).toBeGreaterThan(0.9);
  });

  it("lowers the threshold as a deeper duck is asked for", () => {
    // Threshold is what actually decides the depth; ratio barely moves it.
    expect(thresholdForDuck(18)).toBeLessThan(thresholdForDuck(6));
    expect(thresholdForDuck(24)).toBeLessThan(thresholdForDuck(18));
  });
});

describe("final mix graph", () => {
  it("keeps the dialogue at full level when music is added", () => {
    const { graph } = buildFinalMixGraph({
      dialoguePath: "d.wav",
      musicPath: "m.wav",
    });
    expect(graph).toContain("normalize=0");
    expect(graph).toContain("sidechaincompress");
  });

  it("ducks effects with the same sidechain as music", () => {
    // An effect over a line is worse than music over a line: louder, shorter,
    // and the ear cannot look past it.
    const { graph } = buildFinalMixGraph({
      dialoguePath: "d.wav",
      musicPath: "m.wav",
      sfx: [{ path: "s.wav", atSec: 1 }],
    });
    expect(graph).toContain("[sfx0]");
    expect(graph).toMatch(/\[music\]\[sfx0\]amix/);
  });

  it("places an effect at the second it was asked for", () => {
    const { graph } = buildFinalMixGraph({
      dialoguePath: "d.wav",
      sfx: [{ path: "s.wav", atSec: 2.5 }],
    });
    expect(graph).toContain("adelay=2500");
  });

  it("passes dialogue straight through when there is nothing to mix", () => {
    const { graph } = buildFinalMixGraph({ dialoguePath: "d.wav" });
    expect(graph).not.toContain("amix");
  });

  it("applies the operator's settings rather than the defaults", () => {
    const { graph, settings } = buildFinalMixGraph({
      dialoguePath: "d.wav",
      musicPath: "m.wav",
      settings: { musicGain: 0.1, attackMs: 5, releaseMs: 500 },
    });
    expect(settings.musicGain).toBe(0.1);
    expect(graph).toContain("volume=0.1");
    expect(graph).toContain("attack=5");
    expect(graph).toContain("release=500");
  });
});

describe.runIf(hasFfmpeg)("rendering a scene", () => {
  it("puts each line at its timeline position and measures the result", async () => {
    const a = path.join(tmp, "a.wav");
    const b = path.join(tmp, "b.wav");
    await makeTone(a, 2);
    await makeTone(b, 2);
    const t = buildSceneTimeline(
      [line(1, "Max", 2, a), line(2, "Leo", 2, b)],
      6,
    );
    const out = path.join(tmp, "scene.wav");
    const r = await renderSceneDialogue(t, out);
    expect(r.lineCount).toBe(2);
    // 2 + 0.28 + 2 = 4.28s of speech, padded out to the planned 6s.
    expect(r.durationSec).toBeGreaterThan(5.9);
    expect(r.durationSec).toBeLessThan(6.2);
  }, 120_000);

  it("leaves a gap of silence between the two lines", async () => {
    const a = path.join(tmp, "g1.wav");
    const b = path.join(tmp, "g2.wav");
    await makeTone(a, 2);
    await makeTone(b, 2);
    const t = buildSceneTimeline([line(1, "Max", 2, a), line(2, "Leo", 2, b)], 6);
    const out = path.join(tmp, "gap.wav");
    await renderSceneDialogue(t, out);
    const duringSpeech = await windowRms(out, 0.5, 1.5);
    const duringGap = await windowRms(out, 2.05, 2.25);
    expect(duringGap).toBeLessThan(duringSpeech * 0.1);
  }, 120_000);

  it("refuses a scene with no audio rather than writing silence", async () => {
    const t = buildSceneTimeline([], 6);
    await expect(
      renderSceneDialogue(t, path.join(tmp, "empty.wav")),
    ).rejects.toThrow();
  });

  it("names the missing line when a clip has gone", async () => {
    const t = buildSceneTimeline([line(1, "Max", 2, path.join(tmp, "gone.wav"))], 6);
    await expect(renderSceneDialogue(t, path.join(tmp, "x.wav"))).rejects.toThrow(
      /câu 1/,
    );
  });

  it("joins scenes end to end", async () => {
    const a = path.join(tmp, "s1.wav");
    const b = path.join(tmp, "s2.wav");
    await makeTone(a, 2);
    await makeTone(b, 3);
    const out = path.join(tmp, "joined.wav");
    const r = await concatSceneDialogue([a, b], out);
    expect(r.durationSec).toBeGreaterThan(4.8);
    expect(r.durationSec).toBeLessThan(5.2);
  }, 120_000);
});

describe.runIf(hasFfmpeg)("ducking actually ducks", () => {
  it("drops the music while speech is present and lets it back afterwards", async () => {
    // The real proof. Having `sidechaincompress` in the graph is not evidence
    // that the music gets out of the way; measuring the bed is.
    const speech = path.join(tmp, "speech.wav");
    const music = path.join(tmp, "music.wav");
    await makeSpeechPattern(speech); // 3s tone, 3s silence, 3s tone
    await makeTone(music, 12, 0.4);

    const bed = path.join(tmp, "bed-ducked.wav");
    await renderDuckedBedOnly(
      { dialoguePath: speech, musicPath: music, settings: { duckDb: 12 } },
      bed,
    );

    const underSpeech = await windowRms(bed, 1.5, 2.5);
    const inTheGap = await windowRms(bed, 4.5, 5.5);

    expect(inTheGap).toBeGreaterThan(underSpeech);
    // A reduction worth having, not a token one.
    const reductionDb = 20 * Math.log10(underSpeech / Math.max(inTheGap, 1e-9));
    expect(reductionDb).toBeLessThan(-4);
  }, 180_000);

  it("does not duck when the operator turns ducking off", async () => {
    const speech = path.join(tmp, "speech2.wav");
    const music = path.join(tmp, "music2.wav");
    await makeSpeechPattern(speech);
    await makeTone(music, 12, 0.4);

    const bed = path.join(tmp, "bed-flat.wav");
    await renderDuckedBedOnly(
      { dialoguePath: speech, musicPath: music, settings: { duckDb: 0 } },
      bed,
    );
    const underSpeech = await windowRms(bed, 1.5, 2.5);
    const inTheGap = await windowRms(bed, 4.5, 5.5);
    expect(Math.abs(underSpeech - inTheGap)).toBeLessThan(inTheGap * 0.25);
  }, 180_000);

  it("DELIVERS the reduction the operator asked for, within a decibel", async () => {
    // The knob used to be labelled in decibels and deliver about half: asking
    // for 12 dB gave 6.3. A control that lies by a factor of two is worse than
    // one with an arbitrary scale, because the operator trusts the number.
    const speech = path.join(tmp, "speech4.wav");
    const music = path.join(tmp, "music4.wav");
    await makeSpeechPattern(speech);
    await makeTone(music, 12, 0.4);

    for (const duckDb of [6, 18]) {
      const bed = path.join(tmp, `bed-${duckDb}.wav`);
      await renderDuckedBedOnly(
        { dialoguePath: speech, musicPath: music, settings: { duckDb } },
        bed,
      );
      const under = await windowRms(bed, 1.5, 2.8);
      const gap = await windowRms(bed, 5.0, 5.9);
      const achieved = -20 * Math.log10(under / gap);
      expect(Math.abs(achieved - duckDb)).toBeLessThan(1.5);
    }
  }, 240_000);

  it("does not make the dialogue quieter by adding music", async () => {
    // amix normalises by default; without normalize=0 this drops 6 dB.
    const speech = path.join(tmp, "speech3.wav");
    const music = path.join(tmp, "music3.wav");
    await makeSpeechPattern(speech);
    await makeTone(music, 12, 0.4);

    const mixed = path.join(tmp, "mixed.wav");
    await renderFinalMix({ dialoguePath: speech, musicPath: music }, mixed);

    const voiceAlone = await windowRms(speech, 1.5, 2.5);
    const voiceInMix = await windowRms(mixed, 1.5, 2.5);
    expect(voiceInMix).toBeGreaterThan(voiceAlone * 0.85);
  }, 180_000);
});
