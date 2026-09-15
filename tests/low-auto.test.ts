import { describe, expect, it } from "vitest";
import {
  LOW_AUTO_MAX_CHARACTERS,
  lowAutoEligibility,
  lowAutoFallback,
  type LowAutoInput,
} from "@/domain/low-auto";
import { isAutoRoutable, MODEL_LIFECYCLES, VI_MODEL_LIFECYCLE } from "@/domain/enums";
import { autoRouteBlock } from "@/services/provider-catalog";

/**
 * The LOW auto-routing gate.
 *
 * Deliberately narrow. h3_max has four samples and three scored 8.9+, but all
 * three were one or two characters on a plain background with a locked camera.
 * That is the shape this gate describes and nothing wider - a 9.07 average is
 * not a licence to route anything merely because it is labelled LOW.
 *
 * The rule the tests guard hardest: a scene that can be made for FREE must stay
 * free. Low-auto exists to stop paid clips reaching the wrong model, not to
 * find new things to buy.
 */

function input(over: Partial<LowAutoInput> = {}): LowAutoInput {
  return {
    complexity: "LOW",
    characterCount: 1,
    hasKeyframe: true,
    cameraMode: "LOCKED_CAMERA",
    repeatedSmallObjects: false,
    modelLifecycle: "LOW_AUTO_CANDIDATE",
    modelReliability: "OK",
    promptGuarded: true,
    contradictions: [],
    estimatedCost: 0.4,
    budgetRemaining: 2.5,
    providerBudgetRemaining: 6.71,
    ...over,
  };
}

describe("LOW_AUTO_CANDIDATE là đề cử, KHÔNG phải đã bật", () => {
  it("vẫn nằm trong danh sách vòng đời hợp lệ", () => {
    expect(MODEL_LIFECYCLES).toContain("LOW_AUTO_CANDIDATE");
    expect(VI_MODEL_LIFECYCLE.LOW_AUTO_CANDIDATE).toBeTruthy();
  });

  it("router KHÔNG được tự chọn model ở trạng thái ứng viên", () => {
    // The whole point of the state. A candidate that started routing the moment
    // it was recorded would make the review it exists for impossible.
    expect(isAutoRoutable("LOW_AUTO_CANDIDATE")).toBe(false);
    const block = autoRouteBlock({
      lifecycle: "LOW_AUTO_CANDIDATE",
      reliability: "OK",
      shutdownDate: null,
    });
    expect(block).not.toBeNull();
    expect(block).toContain("CHƯA được bật");
  });
});

describe("điều kiện đủ", () => {
  it("cảnh LOW, 1 nhân vật, có keyframe, camera khoá -> đạt", () => {
    const v = lowAutoEligibility(input());
    expect(v.eligible).toBe(true);
    expect(v.blockers).toEqual([]);
  });

  it("2 nhân vật vẫn đạt, 3 thì không", () => {
    expect(lowAutoEligibility(input({ characterCount: 2 })).eligible).toBe(true);
    const three = lowAutoEligibility(input({ characterCount: 3 }));
    expect(three.eligible).toBe(false);
    expect(three.blockers.map((b) => b.code)).toContain("too_many_characters");
    expect(LOW_AUTO_MAX_CHARACTERS).toBe(2);
  });

  it("không có keyframe -> chặn", () => {
    // Every good sample was image-to-video. Text-to-video on this model has
    // never been measured, so routing one automatically buys an untested path.
    const v = lowAutoEligibility(input({ hasKeyframe: false }));
    expect(v.eligible).toBe(false);
    expect(v.blockers.map((b) => b.code)).toContain("needs_keyframe");
  });

  it("camera có chuyển động chủ đích -> chặn", () => {
    const v = lowAutoEligibility(input({ cameraMode: "DIRECTED_CAMERA" }));
    expect(v.blockers.map((b) => b.code)).toContain("camera_not_locked");
  });

  it("vật thể nhỏ dày đặc -> chặn", () => {
    // This is the signal that cost two paid clips: a floor of spilled beans
    // scored LOW at 3.5 and Runway refused it twice with BAD_OUTPUT.
    const v = lowAutoEligibility(input({ repeatedSmallObjects: true }));
    expect(v.blockers.map((b) => b.code)).toContain("dense_small_objects");
  });

  it("độ khó khác LOW -> chặn", () => {
    for (const c of ["MEDIUM", "HIGH"]) {
      const v = lowAutoEligibility(input({ complexity: c }));
      expect(v.blockers.map((b) => b.code)).toContain("not_low");
    }
  });

  it("model DEGRADED hoặc DEPRECATED -> chặn", () => {
    expect(
      lowAutoEligibility(input({ modelReliability: "DEGRADED" })).blockers.map((b) => b.code),
    ).toContain("model_degraded");
    expect(
      lowAutoEligibility(input({ modelLifecycle: "DEPRECATED" })).blockers.map((b) => b.code),
    ).toContain("model_lifecycle");
  });

  it("prompt chưa qua guardrail hoặc tự mâu thuẫn -> chặn", () => {
    expect(
      lowAutoEligibility(input({ promptGuarded: false })).blockers.map((b) => b.code),
    ).toContain("prompt_not_guarded");
    expect(
      lowAutoEligibility(input({ contradictions: ["vừa cấm pan vừa yêu cầu pan"] }))
        .blockers.map((b) => b.code),
    ).toContain("prompt_contradiction");
  });

  it("vượt ngân sách chung hoặc ví nhà cung cấp -> chặn", () => {
    expect(
      lowAutoEligibility(input({ budgetRemaining: 0.1 })).blockers.map((b) => b.code),
    ).toContain("over_global_budget");
    expect(
      lowAutoEligibility(input({ providerBudgetRemaining: 0.1 })).blockers.map((b) => b.code),
    ).toContain("over_provider_budget");
  });

  it("ví null (nhà cung cấp tự tính tiền) KHÔNG bị coi là hết tiền", () => {
    // Null and zero are different answers. Treating them alike would block
    // every externally-metered provider forever.
    const v = lowAutoEligibility(input({ providerBudgetRemaining: null }));
    expect(v.eligible).toBe(true);
  });

  it("liệt kê MỌI lý do chặn, không dừng ở cái đầu tiên", () => {
    // Fixing one blocker only to meet the next is a worse experience than
    // being told all three at once.
    const v = lowAutoEligibility(
      input({ hasKeyframe: false, characterCount: 4, repeatedSmallObjects: true }),
    );
    const codes = v.blockers.map((b) => b.code);
    expect(codes).toContain("needs_keyframe");
    expect(codes).toContain("too_many_characters");
    expect(codes).toContain("dense_small_objects");
  });
});

describe("không đủ điều kiện thì đi đâu", () => {
  it("cảnh làm được tại máy thì GIỮ LOCAL_MOTION", () => {
    // The rule that matters most. Low-auto must never convert free work into
    // billed work - that is the easiest way to lose a budget with nobody ever
    // making a decision.
    const v = lowAutoEligibility(input({ hasKeyframe: false }));
    expect(lowAutoFallback(v, { localMotionAllowed: true })).toBe("LOCAL_MOTION");
  });

  it("thiếu keyframe và không làm local được -> NEEDS_KEYFRAME", () => {
    const v = lowAutoEligibility(input({ hasKeyframe: false }));
    expect(lowAutoFallback(v, { localMotionAllowed: false })).toBe("NEEDS_KEYFRAME");
  });

  it("lý do khác -> NEEDS_PROVIDER, KHÔNG âm thầm sang model trả phí khác", () => {
    // gen4_turbo is DEGRADED, gen4.5 is PIN_ONLY, Sora is DEPRECATED. Quietly
    // picking one to rescue a scene would undo all three decisions at once.
    const v = lowAutoEligibility(input({ characterCount: 5 }));
    expect(lowAutoFallback(v, { localMotionAllowed: false })).toBe("NEEDS_PROVIDER");
  });

  it("LOCAL_MOTION thắng kể cả khi cảnh vốn đủ điều kiện trả phí", () => {
    const v = lowAutoEligibility(input());
    expect(v.eligible).toBe(true);
    // Eligible for paid, but the scene can be made locally - so it is.
    expect(lowAutoFallback(v, { localMotionAllowed: true })).toBe("LOCAL_MOTION");
  });
});
