import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { measureLoudness, normalizeVoiceClip } from "@/media/audio-normalize";
import { ffmpeg } from "@/media/ffmpeg";

/**
 * Regression: a mock voice clip whose loudness range measures exactly 0 LU
 * made FFmpeg 6.1's second loudnorm pass hang forever (0 % CPU, empty output)
 * until the 10-minute timeout - every render using it stalled. The fixture is
 * that clip, losslessly (FLAC decodes to the identical PCM).
 */

let tmp = "";
const fixture = path.join(__dirname, "fixtures", "flat-lra-voice.flac");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lra0-"));
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-i", fixture, "-c:a", "pcm_s16le", path.join(tmp, "voice.wav")]);
}, 60_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("CHUẨN HOÁ GIỌNG — dải âm lượng = 0 không làm treo", () => {
  it("clip có LRA đo được = 0 vẫn chuẩn hoá xong trong vài giây", async () => {
    const input = path.join(tmp, "voice.wav");
    expect((await measureLoudness(input)).lra).toBe(0);
    const started = Date.now();
    const r = await normalizeVoiceClip(input, path.join(tmp, "out.wav"));
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(fs.statSync(path.join(tmp, "out.wav")).size).toBeGreaterThan(1000);
    expect(Number.isFinite(r.after.integratedLufs)).toBe(true);
  }, 90_000);
});
