import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLayeredSceneArgs, foregroundsOf } from "@/media/camera-motion";
import { slotsForNames, subjectBoxes } from "@/media/layer-layout";
import { ffmpeg, probeDuration, resolveFfmpeg } from "@/media/ffmpeg";
import { renderInputsFor } from "@/services/scene-plan-service";
import { DATA_ROOT, toRelative } from "@/lib/paths";

/** G2 — MULTI-SUBJECT LAYER COMPOSITOR (local FFmpeg, $0). */

let tmp = "";
const file = (n: string) => path.join(tmp, n);

/** RGB at a point of one frame (0..1 coordinates). */
function rgbAt(video: string, sec: number, fx: number, fy: number): [number, number, number] {
  const W = 90;
  const H = 160;
  const raw = execFileSync(resolveFfmpeg()!, ["-hide_banner", "-loglevel", "error", "-ss", String(sec), "-i", video, "-frames:v", "1", "-vf", `scale=${W}:${H},format=rgb24`, "-f", "rawvideo", "-"]);
  const i = (Math.round(fy * (H - 1)) * W + Math.round(fx * (W - 1))) * 3;
  return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
}

beforeAll(async () => {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  tmp = fs.mkdtempSync(path.join(DATA_ROOT, "layers-test-"));
  // Background: blue sky over green ground. Subjects: solid red / yellow figures, a brown "table", all on transparency.
  await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x4080d0:s=720x1280", "-vf", "drawbox=x=0:y=800:w=720:h=480:color=0x30a040:t=fill", "-frames:v", "1", file("bg.png")]);
  const figure = async (name: string, color: string, w: number, h: number) =>
    ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${w}x${h},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(abs(X-W/2),W*0.4)*gt(Y,H*0.05),255,0)'`, "-frames:v", "1", file(name)]);
  await figure("red.png", "red", 200, 500);
  await figure("yellow.png", "yellow", 200, 500);
  await figure("table.png", "0x704020", 400, 200);
}, 60_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("G2 — bố cục chủ thể", () => {
  it("2 người: trái / phải, trong khung, đầu dưới lề an toàn; 3 người: trái / giữa / phải", () => {
    const t = { width: 1080, height: 1920 };
    const two = subjectBoxes(2, t);
    expect(two[0]!.cx).toBeLessThan(540);
    expect(two[1]!.cx).toBeGreaterThan(540);
    for (const b of [...two, ...subjectBoxes(3, t)]) {
      expect(b.cx - b.maxW / 2).toBeGreaterThanOrEqual(0);
      expect(b.cx + b.maxW / 2).toBeLessThanOrEqual(1080);
      expect(b.bottom - b.maxH).toBeGreaterThanOrEqual(1920 * 0.06);
    }
    expect(subjectBoxes(3, t).map((b) => Math.round(b.cx / 108))).toEqual([2, 5, 8]);
  });

  it("giữ bên màn hình của đối thoại: Leo trái, Max phải dù thứ tự lớp ngược lại", () => {
    expect(slotsForNames(["Max", "Leo"], ["Leo"], ["Max"])).toEqual(["RIGHT", "LEFT"]);
    expect(slotsForNames(["A", "B", "C"])).toEqual(["LEFT", "CENTER", "RIGHT"]);
    expect(slotsForNames(["Mia"])).toEqual(["CENTER"]);
  });
});

describe("G2 — graph ghép lớp", () => {
  it("nền → trung cảnh → tiền cảnh; mỗi tấm có alpha (gbrap) và camera nhân hệ số parallax 0,2 / 0,5 / 1,0", () => {
    const args = buildLayeredSceneArgs({
      layers: { background: "bg.png", foregrounds: [{ path: "a.png", slot: "LEFT" }, { path: "b.png", slot: "RIGHT" }], midground: [{ path: "t.png" }] },
      audioInput: null,
      duration: 3,
      target: { width: 360, height: 640, fps: 30 },
      camera: { move: "SLOW_ZOOM_IN", speed: "SLOW" },
      output: "o.mp4",
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    const zoom = (label: string) => Number(new RegExp(`z='1\\+([\\d.]+)\\*[^']*'[^;]*\\[${label}\\]`).exec(graph)?.[1] ?? NaN);
    expect(zoom("bg0")).toBeCloseTo(0.016, 3); // 0.08 x 0.2
    expect(graph.indexOf("[midc]")).toBeLessThan(graph.indexOf("[fgc]"));
    expect(graph).toMatch(/format=gbrap,zoompan=z='1\+0\.0400\*/); // midground 0.08 x 0.5
    expect(graph).toMatch(/format=gbrap,zoompan=z='1\+0\.0800\*/); // foreground 0.08 x 1.0
    // Separate subjects: the side ones first, centre in front.
    expect(graph).toContain("pad=360:640");
  });

  it("chủ thể cũ (một foreground) vẫn đọc được: FULL", () => {
    expect(foregroundsOf({ background: "b", foreground: "f.png" })).toEqual([{ path: "f.png", slot: "FULL" }]);
  });
});

describe("G2 — render thật", () => {
  it("2 chủ thể + trung cảnh trên nền: đúng vị trí, nền thấy giữa hai người, đúng thời lượng", async () => {
    const out = file("two.mp4");
    await ffmpeg(
      buildLayeredSceneArgs({
        layers: { background: file("bg.png"), foregrounds: [{ path: file("red.png"), slot: "LEFT" }, { path: file("yellow.png"), slot: "RIGHT" }], midground: [{ path: file("table.png") }] },
        audioInput: null,
        duration: 2,
        target: { width: 360, height: 640, fps: 30 },
        camera: { move: "PUSH_IN", speed: "SLOW" },
        output: out,
      }),
    );
    expect(Math.abs((await probeDuration(out)) - 2)).toBeLessThan(0.1);
    const left = rgbAt(out, 1, 0.3, 0.65);
    const right = rgbAt(out, 1, 0.7, 0.65);
    const sky = rgbAt(out, 1, 0.5, 0.1);
    expect(left[0]).toBeGreaterThan(180); // red
    expect(left[1]).toBeLessThan(90);
    expect(right[0]).toBeGreaterThan(180); // yellow
    expect(right[1]).toBeGreaterThan(180);
    expect(sky[2]).toBeGreaterThan(150); // the sky is still visible above
  }, 120_000);

  it("renderInputsFor: 2 tiền cảnh tách nền → 2 chủ thể, vị trí theo bên màn hình của đạo diễn camera", () => {
    const layer = (id: string, label: string, asset: string) => ({
      id,
      layerType: "FOREGROUND",
      zIndex: 40,
      label,
      entityType: "CHARACTER",
      depth: 0.1,
      assetPath: toRelative(file(asset)),
    });
    const plan = {
      source: "USER",
      route: "COMPOSITE",
      camera: { shotSize: "MEDIUM", cameraAngle: "EYE_LEVEL", cameraMovement: "PUSH_IN", screenLeft: ["Leo"], screenRight: ["Max"] },
      layers: [layer("fg-1", "Max", "red.png"), layer("fg-2", "Leo", "yellow.png"), { ...layer("mid", "Bàn", "table.png"), layerType: "MIDGROUND", depth: 0.5 }],
    };
    const r = renderInputsFor({ scenePlanJson: JSON.stringify(plan), imagePath: toRelative(file("bg.png")), videoPath: null });
    expect(r.layers?.foregrounds?.map((f) => f.slot)).toEqual(["RIGHT", "LEFT"]);
    expect(r.layers?.midground).toHaveLength(1);
  });
});
