import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  measureLoudness,
  normalizeVoiceClip,
  withinVoiceTargets,
  VOICE_TARGET_LUFS,
  VOICE_TARGET_TRUE_PEAK,
} from "@/media/audio-normalize";
import { buildDuckFilter } from "@/media/render";
import {
  buildCuesFromAudio,
  SPEAKER_GAP_SECONDS,
  timelineLength,
} from "@/media/subtitles";
import { ffmpeg, ffmpegAvailable } from "@/media/ffmpeg";

/**
 * The three test clips came off one model spanning more than ten decibels of
 * loudness. A viewer sets the volume for the quiet character and then gets
 * shouted at by the loud one, so levelling is not a polish step.
 *
 * Real ffmpeg, synthetic tones, no network, no cost.
 */

let tmp = "";
const hasFfmpeg = ffmpegAvailable();

/** A tone at a chosen amplitude, so the "before" loudness is known by design. */
async function makeTone(
  file: string,
  amplitude: number,
  seconds: number,
  leadingSilence = 0,
): Promise<void> {
  const filters =
    leadingSilence > 0
      ? `sine=frequency=220:duration=${seconds},adelay=${Math.round(leadingSilence * 1000)}|${Math.round(leadingSilence * 1000)},volume=${amplitude}`
      : `sine=frequency=220:duration=${seconds},volume=${amplitude}`;
  await ffmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=24000:cl=mono:d=0.001`,
    "-filter_complex",
    `${filters}[out]`,
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

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audiomix-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(hasFfmpeg)("levelling voice clips", () => {
  it("brings a quiet clip and a loud clip to the same loudness", async () => {
    // This is the actual defect: Max at -16 LUFS beside Leo at -27.
    const loud = path.join(tmp, "loud.wav");
    const quiet = path.join(tmp, "quiet.wav");
    await makeTone(loud, 0.5, 4);
    await makeTone(quiet, 0.05, 4);

    const beforeLoud = await measureLoudness(loud);
    const beforeQuiet = await measureLoudness(quiet);
    const spreadBefore = Math.abs(beforeLoud.integratedLufs - beforeQuiet.integratedLufs);
    expect(spreadBefore).toBeGreaterThan(8);

    const outLoud = path.join(tmp, "loud-n.wav");
    const outQuiet = path.join(tmp, "quiet-n.wav");
    const a = await normalizeVoiceClip(loud, outLoud);
    const b = await normalizeVoiceClip(quiet, outQuiet);

    const spreadAfter = Math.abs(a.after.integratedLufs - b.after.integratedLufs);
    expect(spreadAfter).toBeLessThan(1.5);
  }, 120_000);

  it("never leaves true peak above the ceiling", async () => {
    // The ceiling exists to survive the AAC encode in the final render, so
    // overshooting it defeats the point of having it.
    const src = path.join(tmp, "hot.wav");
    await makeTone(src, 0.95, 3);
    const out = path.join(tmp, "hot-n.wav");
    const r = await normalizeVoiceClip(src, out);
    expect(r.after.truePeakDb).toBeLessThanOrEqual(VOICE_TARGET_TRUE_PEAK + 0.05);
  }, 120_000);

  it("lands within a decibel of the dialogue target", async () => {
    const src = path.join(tmp, "mid.wav");
    await makeTone(src, 0.2, 4);
    const out = path.join(tmp, "mid-n.wav");
    const r = await normalizeVoiceClip(src, out);
    expect(Math.abs(r.after.integratedLufs - VOICE_TARGET_LUFS)).toBeLessThan(1.5);
  }, 120_000);

  it("trims dead air from the front", async () => {
    const src = path.join(tmp, "padded.wav");
    await makeTone(src, 0.3, 3, 1.2);
    const out = path.join(tmp, "padded-n.wav");
    const r = await normalizeVoiceClip(src, out);
    expect(r.trimmedSeconds).toBeGreaterThan(0.5);
  }, 120_000);

  it("MEASURES the finished duration rather than predicting it", async () => {
    const src = path.join(tmp, "dur.wav");
    await makeTone(src, 0.3, 2.5, 0.8);
    const out = path.join(tmp, "dur-n.wav");
    const r = await normalizeVoiceClip(src, out);
    // Trimming changed the length, so the reported duration must reflect the
    // file that ships - not the 3.3s that went in.
    expect(r.durationSec).toBeGreaterThan(2);
    expect(r.durationSec).toBeLessThan(3.2);
  }, 120_000);

  it("can level a file in place without destroying it", async () => {
    const src = path.join(tmp, "inplace.wav");
    await makeTone(src, 0.08, 3);
    const r = await normalizeVoiceClip(src, src);
    expect(fs.existsSync(src)).toBe(true);
    expect(fs.statSync(src).size).toBeGreaterThan(1000);
    expect(withinVoiceTargets(r.after, 1.5)).toBe(true);
  }, 120_000);

  it("refuses a file that is not there instead of inventing silence", async () => {
    await expect(
      normalizeVoiceClip(path.join(tmp, "nope.wav"), path.join(tmp, "nope-n.wav")),
    ).rejects.toThrow();
  });
});

describe("ducking music under the voice", () => {
  const filter = buildDuckFilter();

  it("uses a sidechain rather than a fixed attenuation", () => {
    // The old filter turned the music down and called it ducking. It wasn't.
    expect(filter).toContain("sidechaincompress");
  });

  it("keeps the voice at full level when music is added", () => {
    // amix normalises by default, dividing every input by the input count -
    // adding music dropped the VOICE by 6 dB, the opposite of what is wanted.
    expect(filter).toContain("normalize=0");
  });

  it("drives the sidechain from the voice, not from the music", () => {
    expect(filter).toMatch(/\[bed\]\[key\]sidechaincompress/);
  });

  it("sends an unprocessed copy of the voice to the mix", () => {
    expect(filter).toContain("asplit=2[voice][key]");
    expect(filter).toMatch(/\[voice\]\[ducked\]amix/);
  });

  it("ends the whole clip when the voice track ends", () => {
    expect(filter).toContain("duration=first");
  });
});

describe("subtitles timed against real audio", () => {
  it("uses measured audio length, not the planned scene duration", () => {
    // The plan says 4s; the levelled clip is 6.2s. Timing against the plan
    // puts every later caption out of step with the voice.
    const cues = buildCuesFromAudio([
      { plannedDuration: 4, lines: [{ durationSec: 6.2, text: "Hello", speaker: "Leo" }] },
    ]);
    expect(cues[0]?.endSeconds).toBeGreaterThan(6);
  });

  it("puts a gap between two different speakers", () => {
    const cues = buildCuesFromAudio([
      {
        plannedDuration: 4,
        lines: [
          { durationSec: 2, text: "Max line", speaker: "Max" },
          { durationSec: 2, text: "Leo line", speaker: "Leo" },
        ],
      },
    ]);
    const first = cues[0];
    const second = cues[1];
    expect(first && second).toBeTruthy();
    expect((second?.startSeconds ?? 0) - (first?.endSeconds ?? 0)).toBeGreaterThanOrEqual(
      SPEAKER_GAP_SECONDS,
    );
  });

  it("never overlaps two captions", () => {
    const cues = buildCuesFromAudio([
      {
        plannedDuration: 4,
        lines: [
          { durationSec: 1.5, text: "One", speaker: "Max" },
          { durationSec: 1.5, text: "Two", speaker: "Leo" },
          { durationSec: 1.5, text: "Three", speaker: "Max" },
        ],
      },
    ]);
    for (let i = 1; i < cues.length; i += 1) {
      expect(cues[i]?.startSeconds).toBeGreaterThan(cues[i - 1]?.endSeconds ?? 0);
    }
  });

  it("does not insert a gap between two lines by the same speaker", () => {
    const cues = buildCuesFromAudio([
      {
        plannedDuration: 4,
        lines: [
          { durationSec: 2, text: "One", speaker: "Max" },
          { durationSec: 2, text: "Two", speaker: "Max" },
        ],
      },
    ]);
    expect(cues[1]?.startSeconds).toBeCloseTo(2, 5);
  });

  it("carries the overrun into the next scene instead of truncating speech", () => {
    // Scene 1 plans 3s but speaks 6s. Scene 2 must start after the speech, or
    // the picture cuts while someone is still talking.
    const cues = buildCuesFromAudio([
      { plannedDuration: 3, lines: [{ durationSec: 6, text: "Long", speaker: "Leo" }] },
      { plannedDuration: 3, lines: [{ durationSec: 2, text: "Next", speaker: "Max" }] },
    ]);
    expect(cues[1]?.startSeconds).toBeGreaterThanOrEqual(6);
  });

  it("keeps the planned duration when the scene has no speech", () => {
    const scenes = [{ plannedDuration: 4, lines: [] }];
    expect(buildCuesFromAudio(scenes)).toHaveLength(0);
    expect(timelineLength(scenes)).toBe(4);
  });

  it("reports a timeline that matches where the cues actually sit", () => {
    const scenes = [
      { plannedDuration: 3, lines: [{ durationSec: 5, text: "A", speaker: "Max" }] },
      { plannedDuration: 4, lines: [{ durationSec: 2, text: "B", speaker: "Leo" }] },
    ];
    const cues = buildCuesFromAudio(scenes);
    expect(timelineLength(scenes)).toBe(9);
    expect(cues[cues.length - 1]?.endSeconds).toBeLessThanOrEqual(9);
  });
});
