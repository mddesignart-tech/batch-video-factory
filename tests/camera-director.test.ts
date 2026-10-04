import { describe, expect, it } from "vitest";
import { directScene, directVideo, effectiveCameraPreset, type DirectorContext, type SceneSemantics } from "@/domain/camera-director";
import { EFFECT_MOVES } from "@/domain/camera-grammar";

/** QĐ-128 PHASE B + C: AI Camera Director, continuity, Creative Style camera. Pure. */

const ctx = (p: Partial<DirectorContext> = {}): DirectorContext => ({
  contentType: "STORY",
  comedyLevel: 1,
  tone: "NATURAL",
  emotion: "AUTO",
  pacing: "MEDIUM",
  creativePreset: "AUTO",
  cameraPreset: "AUTO",
  width: 1080,
  height: 1920,
  ...p,
});
const sem = (p: Partial<SceneSemantics>): SceneSemantics => ({ sceneNumber: 1, duration: 4, ...p });

describe("AI Camera Director", () => {
  it("A. đối thoại 2 người → trung cảnh two-shot, ngang tầm mắt, đẩy máy chậm; có lý do", () => {
    const { plan, kind } = directScene(sem({ sceneRole: "dialogue", dialogue: "Leo: Hi!\nMax: Hello!", charactersPresent: ["Leo", "Max"], speakingCharacters: ["Leo", "Max"] }), ctx());
    expect(kind).toBe("DIALOGUE");
    expect(plan).toMatchObject({ shotSize: "MEDIUM", cameraAngle: "EYE_LEVEL", cameraMovement: "PUSH_IN" });
    expect(["VERY_SLOW", "SLOW"]).toContain(plan.cameraSpeed);
    expect(plan.subjectFocus).toBe("Leo + Max");
    expect(plan.reason).toMatch(/đối thoại/);
  });

  it("B. phản ứng hài (hài 4) → cận, zoom gắt được phép; hài thấp → chỉ đẩy máy", () => {
    const funny = directScene(sem({ sceneRole: "reaction", charactersPresent: ["Leo"] }), ctx({ comedyLevel: 4, creativePreset: "TIKTOK_FUNNY" })).plan;
    expect(funny.shotSize).toBe("CLOSE_UP");
    expect(funny.cameraMovement).toBe("CRASH_ZOOM");
    const calm = directScene(sem({ sceneRole: "reaction", charactersPresent: ["Leo"] }), ctx({ comedyLevel: 1 })).plan;
    expect(calm.cameraMovement).toBe("PUSH_IN");
  });

  it("C. review sản phẩm → cận sản phẩm, chuyển động sạch; sản phẩm bắt buộc không bị hiệu ứng mạnh dù hài cao", () => {
    const refs = [{ type: "PRODUCT", name: "Bình Mind", critical: true }];
    const p = directScene(sem({ sceneRole: "feature", references: refs }), ctx({ contentType: "PRODUCT_REVIEW" })).plan;
    expect(["CLOSE_UP", "MEDIUM_CLOSE_UP"]).toContain(p.shotSize);
    expect(EFFECT_MOVES).not.toContain(p.cameraMovement);
    expect(p.subjectFocus).toBe("Bình Mind");
    const funny = directScene(sem({ sceneRole: "reaction", references: refs, charactersPresent: ["Lan"] }), ctx({ contentType: "PRODUCT_REVIEW", comedyLevel: 5, creativePreset: "TIKTOK_FUNNY" })).plan;
    expect(EFFECT_MOVES).not.toContain(funny.cameraMovement);
    expect(funny.reason).toMatch(/tham chiếu bắt buộc/);
    const handling = directScene(sem({ sceneRole: "feature", references: refs, characterAction: "Lan pours tea from the bottle" }), ctx({ contentType: "PRODUCT_REVIEW" })).plan;
    expect(handling).toMatchObject({ shotSize: "MEDIUM_CLOSE_UP", cameraAngle: "THREE_QUARTER" });
  });

  it("D. động vật ngoài thiên nhiên → trung rộng/rộng, bám theo, rõ cả nền", () => {
    const p = directScene(sem({ sceneRole: "behaviour", visualDescription: "A small bird builds a nest in the forest" }), ctx({ contentType: "ANIMAL_FACT" })).plan;
    expect(["MEDIUM_WIDE", "WIDE", "MEDIUM"]).toContain(p.shotSize);
    expect(["TRACK_RIGHT", "TRACK_LEFT", "DOLLY_IN"]).toContain(p.cameraMovement);
    expect(p.focusStyle).toBe("DEEP_FOCUS");
  });

  it("E. cảnh cảm xúc → cận, tiến máy chậm, xoá phông", () => {
    const p = directScene(sem({ sceneRole: "moment", charactersPresent: ["Mia"] }), ctx({ emotion: "TOUCHING", tone: "EMOTIONAL" })).plan;
    expect(p).toMatchObject({ shotSize: "CLOSE_UP", focusStyle: "SHALLOW_FOCUS" });
    expect(["DOLLY_IN", "PUSH_IN"]).toContain(p.cameraMovement);
    expect(["VERY_SLOW", "SLOW"]).toContain(p.cameraSpeed);
  });

  it("F/G. Chuyên nghiệp và Documentary → không bao giờ zoom gắt / lia whip, kể cả cảnh phản ứng", () => {
    for (const c of [
      ctx({ tone: "PROFESSIONAL", creativePreset: "PROFESSIONAL", comedyLevel: 0 }),
      ctx({ tone: "DOCUMENTARY", creativePreset: "DOCUMENTARY", comedyLevel: 0 }),
      ctx({ tone: "DOCUMENTARY", comedyLevel: 4 }),
    ]) {
      for (const role of ["reaction", "payoff", "hook", "dialogue"]) {
        const p = directScene(sem({ sceneRole: role, charactersPresent: ["Leo", "Max"], speakingCharacters: ["Leo"] }), c).plan;
        expect(EFFECT_MOVES).not.toContain(p.cameraMovement);
      }
    }
    expect(effectiveCameraPreset(ctx({ tone: "DOCUMENTARY" }))).toBe("DOCUMENTARY");
  });

  it("H/I. khung dọc 9:16 vs ngang 16:9: cảnh giới thiệu địa điểm đổi cách đi máy", () => {
    const s = sem({ sceneRole: "hook", visualDescription: "A busy city street at sunset" });
    const portrait = directScene(s, ctx({ width: 1080, height: 1920 })).plan;
    const landscape = directScene(s, ctx({ width: 1920, height: 1080 })).plan;
    expect(portrait.cameraMovement).toBe("TILT_DOWN");
    expect(landscape.cameraMovement).toBe("PAN_RIGHT");
    expect(landscape.shotSize).toBe("ESTABLISHING");
  });

  it("preset camera: Tĩnh → đứng yên; AUTO theo phong cách (Hài TikTok → Hài nhanh, review → Review sản phẩm)", () => {
    const p = directScene(sem({ sceneRole: "reaction", charactersPresent: ["Leo"] }), ctx({ cameraPreset: "STATIC", comedyLevel: 4 })).plan;
    expect(p.cameraMovement).toBe("STATIC");
    expect(effectiveCameraPreset(ctx({ comedyLevel: 4, creativePreset: "TIKTOK_FUNNY" }))).toBe("FAST_COMEDY");
    expect(effectiveCameraPreset(ctx({ contentType: "PRODUCT_REVIEW" }))).toBe("PRODUCT_REVIEW");
  });

  it("continuity: cùng hướng lia, hiệu ứng mạnh tối đa 1/3 cảnh, không 3 cảnh giống hệt, người nói giữ bên màn hình", () => {
    const c = ctx({ comedyLevel: 4, creativePreset: "TIKTOK_FUNNY", width: 1920, height: 1080 });
    const scenes: SceneSemantics[] = [
      sem({ sceneNumber: 1, sceneRole: "hook", visualDescription: "A quiet park in the morning" }),
      sem({ sceneNumber: 2, sceneRole: "dialogue", dialogue: "Leo: Hi", charactersPresent: ["Leo", "Max"], speakingCharacters: ["Leo"] }),
      sem({ sceneNumber: 3, sceneRole: "reaction", charactersPresent: ["Max", "Leo"], speakingCharacters: ["Max"] }),
      sem({ sceneNumber: 4, sceneRole: "reaction", charactersPresent: ["Leo", "Max"], speakingCharacters: ["Leo"] }),
      sem({ sceneNumber: 5, sceneRole: "dialogue", dialogue: "Max: Ok", charactersPresent: ["Max", "Leo"], speakingCharacters: ["Max"] }),
      sem({ sceneNumber: 6, sceneRole: "behaviour", visualDescription: "A dog runs back across the park", characterAction: "the dog runs" }),
      sem({ sceneNumber: 7, sceneRole: "behaviour", visualDescription: "The dog runs again", characterAction: "the dog runs" }),
    ];
    const plans = directVideo(scenes, c).map((x) => x.plan);
    const effects = plans.map((p, i) => (EFFECT_MOVES.includes(p.cameraMovement) ? i : -1)).filter((i) => i >= 0);
    for (let k = 1; k < effects.length; k += 1) expect(effects[k]! - effects[k - 1]!).toBeGreaterThanOrEqual(3);
    const lateral = plans.map((p) => p.cameraMovement).filter((m) => /LEFT|RIGHT/.test(m));
    expect(new Set(lateral.map((m) => (m.endsWith("LEFT") ? "L" : "R"))).size).toBeLessThanOrEqual(1);
    for (const i of [1, 2, 3, 4]) {
      expect(plans[i]!.screenLeft).toEqual(["Leo"]);
      expect(plans[i]!.screenRight).toEqual(["Max"]);
    }
    for (let i = 2; i < plans.length; i += 1) {
      const [a, b, p] = [plans[i - 2]!, plans[i - 1]!, plans[i]!];
      expect(a.shotSize === p.shotSize && b.shotSize === p.shotSize && a.cameraMovement === p.cameraMovement && b.cameraMovement === p.cameraMovement).toBe(false);
    }
    expect(directVideo(scenes, c).map((x) => x.plan)).toEqual(plans);
  });
});
