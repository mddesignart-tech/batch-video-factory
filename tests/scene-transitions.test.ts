import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSceneNormalizeArgs, renderProject } from "@/media/render";
import { buildTransitionJoinArgs, hasBlend, planJoins } from "@/media/transitions";
import { ffmpeg, probeDuration } from "@/media/ffmpeg";
import { renderInputsFor } from "@/services/scene-plan-service";
import { renderRecipeHash } from "@/services/render-recipe";

/** Scene transitions (xfade) on the join: local FFmpeg only, $0. The clock never moves. */

const target = { width: 180, height: 320, fps: 24 };
let tmp = "";
const file = (n: string) => path.join(tmp, n);

/** Mean grey level of one frame, shrunk to 18x32. */
async function lumaAt(video: string, sec: number): Promise<number> {
  const out = file(`f_${sec}.gray`);
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-ss", String(sec), "-i", video, "-frames:v", "1", "-vf", "scale=18:32,format=gray", "-f", "rawvideo", out]);
  const b = fs.readFileSync(out);
  return b.reduce((n, v) => n + v, 0) / b.length;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xfade-"));
  // Three flat scenes: black, white, black - a blend is visible as a mid grey.
  const colours = ["black", "white", "black"];
  for (const [i, c] of colours.entries()) {
    await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${c}:s=180x320`, "-frames:v", "1", file(`still${i}.png`)]);
    await ffmpeg(
      buildSceneNormalizeArgs({ videoInput: file(`still${i}.png`), audioInput: null, duration: 2, target, output: file(`norm${i}.mp4`), camera: { move: "STATIC", speed: "SLOW" } }),
    );
  }
}, 120_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("CHUYỂN CẢNH (kế hoạch)", () => {
  it("CUT / NONE / không có = cắt thẳng; cảnh đầu bỏ qua transitionIn", () => {
    const joins = planJoins(["CROSSFADE", "CUT", "NONE", undefined], [3, 3, 3, 3]);
    expect(joins.map((j) => j.spec)).toEqual([null, null, null]);
    expect(hasBlend(joins)).toBe(false);
  });

  it("độ dài blend bị giới hạn theo cảnh ngắn (≤ 25 %), quá ngắn thì thành cắt", () => {
    const joins = planJoins([null, "CROSSFADE", "WHIP", "CROSSFADE"], [4, 1, 4, 0.3]);
    expect(joins[0]).toMatchObject({ durationSec: 0.25 });
    expect(joins[0]!.spec?.xfade).toBe("fade");
    expect(joins[1]).toMatchObject({ durationSec: 0.25 });
    expect(joins[1]!.spec?.xfade).toBe("smoothleft");
    expect(joins[2]!.spec).toBeNull();
  });

  it("graph: giữ frame cuối cảnh trước (tpad) rồi xfade ĐÚNG tại giây bắt đầu cảnh sau; tiếng nối liền, không hoà", () => {
    const args = buildTransitionJoinArgs({ inputs: ["a.mp4", "b.mp4", "c.mp4"], durations: [2, 3, 2], transitions: [null, "CROSSFADE", "CUT"], fps: 24, output: "j.mp4" });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[s0]tpad=stop_mode=clone:stop_duration=0.5[h1]");
    expect(graph).toContain("[h1][s1]xfade=transition=fade:duration=0.5:offset=2.000[j1]");
    expect(graph).toContain("[j1][s2]concat=n=2:v=1:a=0[j2]");
    expect(graph).toContain("[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]");
  });
});

describe("CHUYỂN CẢNH (FFmpeg thật)", () => {
  it("crossfade: tổng thời lượng = tổng các cảnh (phụ đề/giọng không lệch), và giữa ranh giới là màu trung gian", async () => {
    const out = file("joined.mp4");
    await ffmpeg(
      buildTransitionJoinArgs({ inputs: [file("norm0.mp4"), file("norm1.mp4"), file("norm2.mp4")], durations: [2, 2, 2], transitions: [null, "CROSSFADE", "CUT"], fps: 24, output: out }),
    );
    expect(Math.abs((await probeDuration(out)) - 6)).toBeLessThan(0.1);
    // Scene 1 (white) starts at 2.0 and is fully in by 2.5; scene 2 cuts in at 4.0.
    expect(await lumaAt(out, 1.5)).toBeLessThan(40);
    const mid = await lumaAt(out, 2.25);
    expect(mid).toBeGreaterThan(60);
    expect(mid).toBeLessThan(200);
    expect(await lumaAt(out, 3.0)).toBeGreaterThan(215);
    expect(await lumaAt(out, 4.3)).toBeLessThan(40);
  }, 120_000);
});

describe("CHUYỂN CẢNH (renderProject đầy đủ)", () => {
  it("một cảnh có CROSSFADE: MP4 cuối đúng tổng thời lượng, báo 1 blend; không có thì vẫn cắt thẳng", async () => {
    const scene = (n: number, transitionIn?: "CROSSFADE") => ({
      sceneNumber: n,
      duration: 2,
      subtitle: `Cảnh ${n}`,
      videoPath: null,
      audioPath: null,
      imagePath: file(`still${n - 1}.png`),
      durationMode: "LOCKED" as const,
      localCamera: { move: "STATIC" as const, speed: "SLOW" as const },
      ...(transitionIn ? { transitionIn } : {}),
    });
    const project = `xfade-${Date.now()}`;
    const blended = await renderProject({ projectId: project, scenes: [scene(1), scene(2, "CROSSFADE"), scene(3)], target, burnSubtitles: false });
    expect(blended.transitionsApplied).toBe(1);
    // The timing engine may lengthen a still (visual floor); the MP4 must match ITS total exactly.
    expect(Math.abs(blended.durationSeconds - blended.finalTotal)).toBeLessThan(0.15);
    const cut = await renderProject({ projectId: project, scenes: [scene(1), scene(2), scene(3)], target, burnSubtitles: false });
    expect(cut.transitionsApplied).toBe(0);
    expect(Math.abs(cut.durationSeconds - blended.durationSeconds)).toBeLessThan(0.1);
  }, 240_000);
});

describe("CHUYỂN CẢNH (mọi kiểu đều render được)", () => {
  it.each(["WHIP", "ZOOM", "MATCH"] as const)("%s: chạy được trên FFmpeg đi kèm, thời lượng không đổi", async (t) => {
    const out = file(`joined_${t}.mp4`);
    await ffmpeg(buildTransitionJoinArgs({ inputs: [file("norm0.mp4"), file("norm1.mp4")], durations: [2, 2], transitions: [null, t], fps: 24, output: out }));
    expect(Math.abs((await probeDuration(out)) - 4)).toBeLessThan(0.1);
  }, 60_000);
});

describe("CHUYỂN CẢNH (nối với kế hoạch cảnh)", () => {
  const plan = (transitionIn: string, source = "AUTO") =>
    JSON.stringify({
      source,
      camera: { shotSize: "MEDIUM", cameraAngle: "EYE_LEVEL", cameraMovement: "STATIC", cameraSpeed: "SLOW", transitionIn },
      layers: [],
      route: "LOCAL_MOTION",
    });

  it("renderInputsFor: chỉ blend mới truyền xuống renderer; cảnh cũ không plan không có transition", () => {
    const scene = { imagePath: null, videoPath: null };
    expect(renderInputsFor({ ...scene, scenePlanJson: plan("CROSSFADE") }).transitionIn).toBe("CROSSFADE");
    expect(renderInputsFor({ ...scene, scenePlanJson: plan("CUT") })).not.toHaveProperty("transitionIn");
    expect(renderInputsFor({ ...scene, scenePlanJson: null })).toEqual({});
  });

  it("recipe: thêm blend thì render lại; cắt thẳng giữ recipe cũ", () => {
    const base = {
      scenes: [{ sceneNumber: 1, duration: 3, subtitle: "a", videoPath: null, audioPath: null, imagePath: null }],
      target,
      burnSubtitles: false,
    } as unknown as Parameters<typeof renderRecipeHash>[0];
    const withCut = { ...base, scenes: [{ ...base.scenes[0]!, transitionIn: undefined }] };
    const withFade = { ...base, scenes: [{ ...base.scenes[0]!, transitionIn: "CROSSFADE" as const }] };
    expect(renderRecipeHash(withCut)).toBe(renderRecipeHash(base));
    expect(renderRecipeHash(withFade)).not.toBe(renderRecipeHash(base));
  });
});
