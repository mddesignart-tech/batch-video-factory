import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { speakerBiasKeys, type ScreenSide } from "@/domain/speaker-focus";
import { cameraZoompan, speakerBiasExpr } from "@/media/camera-motion";
import { buildSceneNormalizeArgs } from "@/media/render";
import { ffmpeg, resolveFfmpeg } from "@/media/ffmpeg";
import { renderInputsFor } from "@/services/scene-plan-service";
import { DATA_ROOT, toRelative } from "@/lib/paths";

/** G4 — MULTI-SPEAKER: keep the two-shot, lean slightly towards the speaker, never flick. $0. */

const sides: Record<string, ScreenSide> = { Leo: -1, Max: 1 };
const sideOf = (n: string) => sides[n] ?? null;
const line = (speaker: string, startSec: number, endSec: number) => ({ speaker, startSec, endSec });
const target = { width: 360, height: 640, fps: 30 };

let tmp = "";
const file = (n: string) => path.join(tmp, n);

beforeAll(async () => {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  tmp = fs.mkdtempSync(path.join(DATA_ROOT, "speaker-test-"));
  // A textured still with one black vertical bar in the middle (its position shows the lean).
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=720x1280,gblur=sigma=2", "-vf", "drawbox=x=350:y=0:w=20:h=1280:color=black:t=fill", "-frames:v", "1", file("still.png")]);
}, 60_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("G4 — lượt nói", () => {
  it("hai người, lượt dài: bắt đầu ở giữa, nghiêng về người nói trước khi họ nói; nhiều câu cùng người = một lượt", () => {
    const keys = speakerBiasKeys([line("Leo", 0.3, 1.4), line("Leo", 1.5, 2.6), line("Max", 2.8, 4.6)], sideOf);
    expect(keys).toEqual([
      { atSec: 0, side: 0 },
      { atSec: 0, side: -1 },
      { atSec: 2.4, side: 1 },
    ]);
  });

  it("câu ngắn (\"Hả?\") không làm camera nghiêng theo", () => {
    const keys = speakerBiasKeys([line("Leo", 0, 2), line("Max", 2.1, 2.6), line("Leo", 2.7, 4.5)], sideOf);
    expect(keys.map((k) => k.side)).toEqual([0, -1]);
  });

  it("đối thoại nhanh (lượt < 1,5 s) → giữ two-shot, không nghiêng", () => {
    const fast = [0, 1, 2, 3, 4, 5].map((i) => line(i % 2 ? "Max" : "Leo", i * 1.1, i * 1.1 + 1));
    expect(speakerBiasKeys(fast, sideOf)).toEqual([]);
  });

  it("chỉ một bên / không rõ bên → không nghiêng", () => {
    expect(speakerBiasKeys([line("Leo", 0, 3)], sideOf)).toEqual([]);
    expect(speakerBiasKeys([line("Mia", 0, 3), line("Zoe", 3, 6)], sideOf)).toEqual([]);
  });

  it("biểu thức: mỗi lần đổi bên là một bước được làm mềm (không nhảy)", () => {
    const e = speakerBiasExpr([{ atSec: 0, side: 0 }, { atSec: 1, side: -1 }, { atSec: 3, side: 1 }], 30);
    expect(e).toContain("-1*min(1,max(0,(on/30-1.000)/1.2))");
    expect(e).toContain("2*min(1,max(0,(on/30-3.000)/1.2))");
    expect(cameraZoompan({ move: "STATIC", speed: "SLOW" }, { durationSec: 3, target })).toBe("");
    expect(cameraZoompan({ move: "STATIC", speed: "SLOW", speakerBias: [{ atSec: 0, side: 0 }, { atSec: 1, side: 1 }] }, { durationSec: 3, target })).toContain("zoompan");
  });
});

describe("G4 — render thật", () => {
  /** x (0..1) of the black bar on one frame row. */
  function barX(video: string, sec: number): number {
    const W = 180;
    const raw = execFileSync(resolveFfmpeg()!, ["-hide_banner", "-loglevel", "error", "-ss", String(sec), "-i", video, "-frames:v", "1", "-vf", `scale=${W}:320,format=gray`, "-f", "rawvideo", "-"]);
    let best = 0;
    let bestV = 999;
    for (let x = 0; x < W; x += 1) {
      const v = raw[160 * W + x]!;
      if (v < bestV) {
        bestV = v;
        best = x;
      }
    }
    return best / W;
  }

  it("nghiêng về Leo (trái) rồi về Max (phải): hình dịch đúng hướng, nhỏ (vài %), trở lại mượt", async () => {
    const out = file("lean.mp4");
    await ffmpeg(
      buildSceneNormalizeArgs({
        videoInput: file("still.png"),
        audioInput: null,
        duration: 4,
        target,
        output: out,
        camera: { move: "STATIC", speed: "SLOW", speakerBias: [{ atSec: 0, side: 0 }, { atSec: 0.2, side: -1 }, { atSec: 2.2, side: 1 }], speakerAmp: 0.015 },
      }),
    );
    const start = barX(out, 0.05);
    const leo = barX(out, 1.6);
    const max = barX(out, 3.8);
    // Looking towards the left speaker moves the picture's content to the right, and back.
    expect(leo).toBeGreaterThan(start + 0.005);
    expect(max).toBeLessThan(start - 0.005);
    expect(Math.abs(leo - start)).toBeLessThan(0.04);
  }, 120_000);

  it("đẩy máy + nghiêng: vị trí dịch đều từng khung (≤ 1 px / khung ở 360 px), không bước nhảy", async () => {
    await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=720x1280", "-vf", "drawbox=x=350:y=0:w=20:h=1280:color=black:t=fill", "-frames:v", "1", file("bar.png")]);
    const out = file("push-lean.mp4");
    await ffmpeg(
      buildSceneNormalizeArgs({
        videoInput: file("bar.png"),
        audioInput: null,
        duration: 3,
        target,
        output: out,
        camera: { move: "PUSH_IN", speed: "SLOW", speakerBias: [{ atSec: 0, side: 0 }, { atSec: 0.3, side: -1 }, { atSec: 1.6, side: 1 }], speakerAmp: 0.015 },
      }),
    );
    const W = 360;
    const H = 640;
    const raw = execFileSync(resolveFfmpeg()!, ["-hide_banner", "-loglevel", "error", "-i", out, "-vf", "format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 });
    const xs: number[] = [];
    for (let f = 0; f < raw.length / (W * H); f += 1) {
      let s = 0;
      let c = 0;
      for (let x = 0; x < W; x += 1) if (raw[f * W * H + 320 * W + x]! < 60) {
        s += x;
        c += 1;
      }
      xs.push(s / c);
    }
    const steps = xs.slice(1).map((x, i) => Math.abs(x - xs[i]!));
    expect(Math.max(...steps)).toBeLessThanOrEqual(1);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(4); // it did lean
  }, 120_000);

  it("renderInputsFor: nhân vật tách riêng → bên theo ô thật (lean 1,5 %); ảnh vẽ chung → bên theo đạo diễn (0,8 %)", () => {
    execFileSync(resolveFfmpeg()!, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red@0.5:s=40x80,format=rgba", "-frames:v", "1", file("fg.png")]);
    const fg = (id: string, label: string) => ({ id, layerType: "FOREGROUND", zIndex: 40, label, entityType: "CHARACTER", depth: 0.1, assetPath: toRelative(file("fg.png")) });
    const camera = { shotSize: "MEDIUM", cameraAngle: "EYE_LEVEL", cameraMovement: "PUSH_IN", screenLeft: ["Leo"], screenRight: ["Max"] };
    const scene = { imagePath: toRelative(file("still.png")), videoPath: null };
    const composite = renderInputsFor({ ...scene, scenePlanJson: JSON.stringify({ source: "USER", route: "COMPOSITE", camera, layers: [fg("fg-1", "Max"), fg("fg-2", "Leo")] }) });
    expect(composite.speakerFocus).toEqual({ sides: { Max: 1, Leo: -1 }, amplitude: 0.015 });
    const drawn = renderInputsFor({ ...scene, scenePlanJson: JSON.stringify({ source: "AUTO", route: "LOCAL_MOTION", camera, layers: [] }) });
    expect(drawn.speakerFocus).toEqual({ sides: { Leo: -1, Max: 1 }, amplitude: 0.008 });
    const solo = renderInputsFor({ ...scene, scenePlanJson: JSON.stringify({ source: "AUTO", route: "LOCAL_MOTION", camera: { ...camera, screenLeft: undefined, screenRight: undefined }, layers: [] }) });
    expect(solo.speakerFocus).toBeUndefined();
  });
});
