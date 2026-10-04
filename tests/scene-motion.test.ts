import { describe, expect, it } from "vitest";
import {
  CAMERA_MOVES,
  CameraPlanSchema,
  cameraPromptPhrase,
  cameraSummaryVi,
  localFallbackMove,
  localSupport,
  type CameraPlan,
} from "@/domain/camera-grammar";
import { legacyScenePlan, parseScenePlan, ScenePlanSchema } from "@/domain/scene-plan";

/**
 * QĐ-128 SCENE MOTION + MULTI-LAYER COMPOSER + AI CAMERA DIRECTOR.
 * Pure tests first; DB / render tests further down. Mock / local only.
 */

const plan = (p: Partial<CameraPlan>): CameraPlan =>
  CameraPlanSchema.parse({ shotSize: "MEDIUM", cameraAngle: "EYE_LEVEL", cameraMovement: "STATIC", ...p });

describe("PHASE A - camera grammar", () => {
  it("ZOOM ≠ DOLLY: lời gửi provider khác nhau và không lẫn thuật ngữ", () => {
    const zoom = cameraPromptPhrase(plan({ cameraMovement: "SLOW_ZOOM_IN" }));
    const dolly = cameraPromptPhrase(plan({ cameraMovement: "DOLLY_IN" }));
    const push = cameraPromptPhrase(plan({ cameraMovement: "PUSH_IN" }));
    expect(zoom).toMatch(/lens zoom/);
    expect(zoom).toMatch(/camera stays in place/);
    expect(zoom).not.toMatch(/dolly|travels/i);
    expect(dolly).toMatch(/Dolly in \(camera travels forward/);
    expect(dolly).not.toMatch(/zoom/i);
    expect(push).toMatch(/camera moves forward/);
    expect(push).not.toMatch(/zoom/i);
  });

  it("câu chữ chuẩn: cỡ cảnh + góc + focus + chủ thể; lý do KHÔNG vào prompt", () => {
    const p = plan({ shotSize: "CLOSE_UP", cameraAngle: "LOW_ANGLE", cameraMovement: "PUSH_IN", focusStyle: "SHALLOW_FOCUS", subjectFocus: "Max", reason: "SECRET REASON" });
    const text = cameraPromptPhrase(p);
    expect(text).toMatch(/^Close-up, low angle, shallow depth of field/);
    expect(text).toMatch(/on Max/);
    expect(text).not.toMatch(/SECRET REASON/);
    expect(cameraPromptPhrase(plan({ cameraMovement: "STATIC" }))).toMatch(/Static locked camera/);
    expect(cameraSummaryVi(p)).toBe("Cận · Góc thấp · Đẩy máy vào · Focus chủ thể (xoá phông)");
  });

  it("khả năng local trung thực: pan/zoom chính xác, dolly/track xấp xỉ, orbit/crane cần Video AI (có phương án local)", () => {
    expect(localSupport("PAN_LEFT")).toBe("EXACT");
    expect(localSupport("SLOW_ZOOM_IN")).toBe("EXACT");
    expect(localSupport("DOLLY_IN")).toBe("APPROX");
    expect(localSupport("PARALLAX")).toBe("APPROX");
    for (const m of ["ORBIT_LEFT", "ORBIT_RIGHT", "ARC", "CRANE_UP", "CRANE_DOWN"] as const) {
      expect(localSupport(m)).toBe("NONE");
      expect(localSupport(localFallbackMove(m))).not.toBe("NONE");
    }
    expect(CAMERA_MOVES).toContain("AUTO");
  });

  it("project cũ: không có plan → mô tả lại là zoom vào chậm (như trước), không phải dữ liệu mới", () => {
    expect(parseScenePlan(null)).toBeNull();
    expect(parseScenePlan("{broken")).toBeNull();
    const legacy = legacyScenePlan({ camera: "Close-up on Max's panicked face", charactersPresent: ["Max"], motionSource: "LOCAL_MOTION" });
    expect(legacy.source).toBe("LEGACY");
    expect(legacy.camera.cameraMovement).toBe("SLOW_ZOOM_IN");
    expect(legacy.camera.shotSize).toBe("CLOSE_UP");
    expect(legacy.layers.map((l) => l.layerType)).toEqual(["FOREGROUND"]);
    expect(ScenePlanSchema.parse(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
  });
});
