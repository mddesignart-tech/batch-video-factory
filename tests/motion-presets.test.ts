import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAMERA_PRESETS, directVideo, PRESET_MOTION, presetMotion, type DirectorContext, type SceneSemantics } from "@/domain/camera-director";
import { locationOf } from "@/domain/scene-layers";
import { renderInputsFor } from "@/services/scene-plan-service";
import { AMBIENT_DIR } from "@/services/ambient-library";
import { buildAlphaAmbientLoopArgs } from "@/media/ambient-generate";
import { ffmpeg } from "@/media/ffmpeg";
import { DATA_ROOT, toRelative } from "@/lib/paths";

/** G5 — a motion preset sets camera + ambient intensity + transition tendency. $0. */

const ctx = (cameraPreset: DirectorContext["cameraPreset"]): DirectorContext => ({
  comedyLevel: 1,
  tone: "WARM",
  emotion: "NEUTRAL",
  pacing: "NORMAL",
  creativePreset: "AUTO",
  cameraPreset,
  width: 1080,
  height: 1920,
});
const scene = (n: number, extra: Partial<SceneSemantics> = {}): SceneSemantics => ({
  sceneNumber: n,
  dialogue: "",
  visualDescription: "",
  charactersPresent: [],
  speakingCharacters: [],
  duration: 3,
  ...extra,
});
const transitionsOf = (preset: DirectorContext["cameraPreset"], scenes: SceneSemantics[]) => directVideo(scenes, ctx(preset)).map((x) => x.plan.transitionIn);

describe("G5 — preset → camera + ambient + chuyển cảnh", () => {
  it("mỗi preset (trừ Tự động) có mức ambient và xu hướng chuyển cảnh; Tĩnh = không ambient, chỉ cắt", () => {
    for (const p of CAMERA_PRESETS.filter((x) => x.id !== "AUTO")) expect(PRESET_MOTION[p.id as Exclude<typeof p.id, "AUTO">]).toBeDefined();
    expect(PRESET_MOTION.STATIC).toEqual({ ambient: 0, transitions: "CUT" });
    expect(PRESET_MOTION.PRODUCT_REVIEW.ambient).toBeLessThan(PRESET_MOTION.NATURAL.ambient);
    expect(presetMotion({ ...ctx("AUTO"), tone: "DOCUMENTARY" }).preset).toBe("DOCUMENTARY");
  });

  it("nhận biết bối cảnh từ mô tả cảnh", () => {
    expect(locationOf("Mia stands in a bright kitchen")).toBe("Gian bếp");
    expect(locationOf("Leo walks down a busy street")).toBe("Đường phố");
    expect(locationOf("Leo smiles")).toBeNull();
  });

  const places = [
    scene(1, { location: "Gian bếp", charactersPresent: ["Mia"] }),
    scene(2, { location: "Đường phố", charactersPresent: ["Leo"] }),
    scene(3, { location: "Đường phố", charactersPresent: ["Leo"] }),
    scene(4, { location: "Công viên", charactersPresent: ["Max"] }),
    scene(5, { location: "Gian bếp", charactersPresent: ["Mia"] }),
  ];

  it("Tự nhiên (SOFT): đổi bối cảnh + khác nhân vật → hoà tan ngắn; không hai hiệu ứng liền nhau", () => {
    expect(transitionsOf("NATURAL", places)).toEqual(["NONE", "CROSSFADE", "CUT", "CROSSFADE", "CUT"]);
  });

  it("Sinh động (DYNAMIC): đổi bối cảnh → lia nhanh (trượt, không chồng mặt)", () => {
    expect(transitionsOf("LIVELY", places)).toEqual(["NONE", "WHIP", "CUT", "WHIP", "CUT"]);
  });

  it("Tĩnh / Review sản phẩm: chỉ cắt thẳng", () => {
    expect(new Set(transitionsOf("STATIC", places).slice(1))).toEqual(new Set(["CUT"]));
    expect(new Set(transitionsOf("PRODUCT_REVIEW", places).slice(1))).toEqual(new Set(["CUT"]));
  });

  it("đổi bối cảnh nhưng CÙNG nhân vật → cắt (không hoà tan ra hai khuôn mặt)", () => {
    const same = [scene(1, { location: "Gian bếp", charactersPresent: ["Mia"] }), scene(2, { location: "Đường phố", charactersPresent: ["Mia"] })];
    expect(transitionsOf("NATURAL", same)).toEqual(["NONE", "CUT"]);
  });
});

describe("G5 — mức ambient khi render", () => {
  let tmp = "";
  beforeAll(async () => {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    tmp = fs.mkdtempSync(path.join(DATA_ROOT, "presets-test-"));
    fs.mkdirSync(AMBIENT_DIR, { recursive: true });
    await ffmpeg(buildAlphaAmbientLoopArgs("birds", path.join(AMBIENT_DIR, "birds.webm")), { timeoutMs: 120_000 });
    await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=360x640", "-frames:v", "1", path.join(tmp, "p.png")]);
  }, 120_000);
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.join(AMBIENT_DIR, "birds.webm"), { force: true });
  });

  const inputs = (intensity?: number) =>
    renderInputsFor({
      imagePath: toRelative(path.join(tmp, "p.png")),
      videoPath: null,
      scenePlanJson: JSON.stringify({
        source: "AUTO",
        route: "LOCAL_MOTION",
        camera: { shotSize: "MEDIUM", cameraAngle: "EYE_LEVEL", cameraMovement: "PUSH_IN" },
        layers: [{ id: "amb-birds", layerType: "AMBIENT", zIndex: 15, label: "Chim", entityType: "ANIMAL", motionType: "AMBIENT_VIDEO", depth: 0.75 }],
        ...(intensity !== undefined ? { ambientIntensity: intensity } : {}),
      }),
    });

  it("mức ambient nhân độ đậm của loop; 0 = không có; kế hoạch cũ (không có mức) = như trước", () => {
    expect(inputs(0.5).layers?.ambient?.[0]?.opacity).toBe(0.45);
    expect(inputs(0).layers?.ambient ?? []).toEqual([]);
    expect(inputs().layers?.ambient?.[0]?.opacity).toBe(0.9);
  });
});
