import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ffmpeg, ffmpegAvailable } from "@/media/ffmpeg";
import { projectSubdir, toAbsolute } from "@/lib/paths";

/**
 * QĐ-151: when the V2 sampler cannot render a scene, that scene is rendered
 * with LEGACY - the video is never broken, and the fallback is REPORTED
 * (motion.fallbacks), never silent. The V2 chain is broken on purpose here.
 */

vi.mock("@/media/camera-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/media/camera-motion")>();
  return { ...actual, cameraPerspective: () => ",perspective=x0='this is not an expression'" };
});

const ID = "qd151-motion-fallback";

afterAll(() => {
  fs.rmSync(path.dirname(toAbsolute(projectSubdir(ID, "temp"))), { recursive: true, force: true });
});

describe.skipIf(!ffmpegAvailable())("QĐ-151 V2 fallback", () => {
  it("a V2 failure renders that scene with LEGACY and says so", async () => {
    const { renderProject } = await import("@/media/render");
    const img = toAbsolute(path.join(projectSubdir(ID, "images"), "s1.png"));
    fs.mkdirSync(path.dirname(img), { recursive: true });
    await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=600x900:d=1", "-frames:v", "1", img]);
    const r = await renderProject({
      projectId: ID,
      target: { width: 270, height: 480, fps: 30 },
      burnSubtitles: false,
      motionQuality: "SMOOTH_V2",
      scenes: [{ sceneNumber: 1, duration: 2, subtitle: "", videoPath: null, imagePath: img, audioPath: null, localCamera: { move: "PAN_RIGHT", speed: "SLOW" } } as never],
    });
    expect(fs.existsSync(r.videoPath)).toBe(true);
    expect(r.motion?.v2Scenes).toEqual([]);
    expect(r.motion?.fallbacks).toHaveLength(1);
    expect(r.motion?.fallbacks[0]?.sceneNumber).toBe(1);
    expect(r.durationSeconds).toBeGreaterThan(1.8);
  });
});
