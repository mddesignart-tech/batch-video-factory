import { describe, expect, it } from "vitest";
import { inferLayers, layersPromptPhrase, sceneComplexity } from "@/domain/scene-layers";
import { ScenePlanSchema } from "@/domain/scene-plan";
import { CameraPlanSchema } from "@/domain/camera-grammar";
import { REFERENCE_TYPES, VI_REFERENCE_TYPE, typeRank } from "@/domain/reference";

/** QĐ-128 PHASE D: multi-layer scene model. Pure. */

const types = (ls: ReturnType<typeof inferLayers>) => ls.map((l) => l.layerType);

describe("MULTI-LAYER SCENE", () => {
  it("J. phố: 2 nhân vật nói chuyện phía trước + xe + người đi bộ phía sau → plan hợp lệ", () => {
    const layers = inferLayers({
      visualDescription: "Leo and Max chat on a busy city street while cars pass and pedestrians walk behind them",
      charactersPresent: ["Leo", "Max"],
      speakingCharacters: ["Leo"],
    });
    expect(types(layers)).toEqual(["FOREGROUND", "BACKGROUND", "AMBIENT", "AMBIENT"]);
    const fg = layers[0]!;
    expect(fg).toMatchObject({ label: "Leo + Max", motionType: "TALKING", entityType: "CHARACTER", parallaxFactor: 1 });
    expect(layers.find((l) => l.layerType === "BACKGROUND")).toMatchObject({ label: "Đường phố", parallaxFactor: 0.2, motionType: "STATIC" });
    expect(layers.filter((l) => l.layerType === "AMBIENT").map((l) => l.label)).toEqual(["Xe chạy ngang", "Người đi bộ phía xa"]);
    const plan = ScenePlanSchema.parse({
      camera: CameraPlanSchema.parse({ shotSize: "MEDIUM", cameraAngle: "EYE_LEVEL", cameraMovement: "PUSH_IN" }),
      layers,
      complexity: sceneComplexity(layers, "PUSH_IN"),
    });
    expect(plan.complexity).toBe("HIGH");
    const phrase = layersPromptPhrase(layers);
    expect(phrase).toMatch(/Background: a city street/);
    expect(phrase).toMatch(/Subtle background motion: cars pass slowly in the distance, a few people walk by far in the background - keep it subtle/);
  });

  it("động vật: chủ thể chính phía trước + rừng + chim bay xa + lá rung; tối đa 2 ambient", () => {
    const layers = inferLayers({
      visualDescription: "A small bird builds a nest on a branch in the forest, clouds above, other birds fly far away",
      references: [{ id: "r1", type: "ANIMAL", name: "Chim sẻ", critical: true }],
    });
    expect(layers[0]).toMatchObject({ layerType: "FOREGROUND", entityType: "ANIMAL", label: "Chim sẻ", critical: true });
    expect(types(layers)).toContain("MIDGROUND");
    expect(layers.find((l) => l.layerType === "BACKGROUND")!.label).toBe("Rừng");
    expect(layers.filter((l) => l.layerType === "AMBIENT").length).toBeLessThanOrEqual(2);
  });

  it("review: presenter + sản phẩm (bắt buộc) + quầy + gian bếp + hơi nước; bối cảnh tham chiếu thắng mô tả", () => {
    const layers = inferLayers({
      visualDescription: "Lan holds the bottle at the kitchen counter, hot tea steaming",
      charactersPresent: ["Lan"],
      references: [
        { id: "p1", type: "PRODUCT", name: "Bình Mind", critical: true },
        { id: "e1", type: "ENVIRONMENT", name: "Bếp nhà Lan", critical: false },
      ],
    });
    expect(layers.filter((l) => l.layerType === "FOREGROUND").map((l) => l.label)).toEqual(["Lan", "Bình Mind"]);
    expect(layers.find((l) => l.entityType === "PRODUCT")).toMatchObject({ critical: true, motionType: "STATIC", referenceAssetIds: ["p1"] });
    expect(layers.find((l) => l.layerType === "MIDGROUND")!.label).toBe("counter");
    expect(layers.find((l) => l.layerType === "BACKGROUND")).toMatchObject({ label: "Bếp nhà Lan", referenceAssetIds: ["e1"] });
    expect(layers.some((l) => l.label === "Hơi nước")).toBe(true);
  });

  it("ambient tắt được; có file loop thì ambient chạy tại máy (AMBIENT_VIDEO), không có thì chỉ mô tả", () => {
    const base = { visualDescription: "Two friends in the park", charactersPresent: ["Leo", "Max"] };
    expect(inferLayers({ ...base, ambientEnabled: false }).some((l) => l.layerType === "AMBIENT")).toBe(false);
    const withLoop = inferLayers({ ...base, ambientAvailable: ["leaves"] });
    expect(withLoop.find((l) => l.id === "amb-leaves")!.motionType).toBe("AMBIENT_VIDEO");
    expect(withLoop.find((l) => l.id === "amb-birds")!.motionType).toBe("CROSS");
  });

  it("cảnh đơn giản: chỉ tiền cảnh, LOW; hành động mạnh cần AI_MOTION", () => {
    const simple = inferLayers({ visualDescription: "A text card", charactersPresent: [] });
    expect(types(simple)).toEqual(["FOREGROUND"]);
    expect(sceneComplexity(simple, "SLOW_ZOOM_IN")).toBe("LOW");
    const action = inferLayers({ characterAction: "Max runs and jumps over the fence", charactersPresent: ["Max"] });
    expect(action[0]!.motionType).toBe("AI_MOTION");
  });

  it("ENVIRONMENT là loại tham chiếu dùng chung, nhường chỗ cho chủ thể khi model giới hạn ảnh", () => {
    expect(REFERENCE_TYPES).toContain("ENVIRONMENT");
    expect(VI_REFERENCE_TYPE.ENVIRONMENT).toBe("Bối cảnh");
    expect(typeRank("ENVIRONMENT", false)).toBeGreaterThan(typeRank("ANIMAL", false));
    expect(typeRank("ENVIRONMENT", false)).toBeLessThan(typeRank("LOGO", false));
  });
});
