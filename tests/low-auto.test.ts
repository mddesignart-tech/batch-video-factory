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
    // The motion floor (QĐ-074). SUBTLE is the only band with evidence behind
    // it, so it is what a passing fixture has to state - and leaving it out is
    // tested below for the refusal it is supposed to produce.
    motionScale: "SUBTLE",
    multiCharacterInteraction: false,
    // LOW_AUTO, not LOW_AUTO_CANDIDATE. The gate now demands the GRANT, and the
    // candidate state is tested below for the refusal it is supposed to produce.
    modelLifecycle: "LOW_AUTO",
    modelReliability: "OK",
    modelVerification: "BENCHMARK_VERIFIED",
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
    expect(isAutoRoutable("LOW_AUTO_CANDIDATE", { complexity: "LOW" })).toBe(false);
    const block = autoRouteBlock({
      lifecycle: "LOW_AUTO_CANDIDATE",
      reliability: "OK",
      shutdownDate: null,
    });
    expect(block).not.toBeNull();
    expect(block).toContain("CHƯA được bật");
  });

  it("cổng cũng từ chối ứng viên, không chỉ riêng isAutoRoutable", () => {
    // Belt and braces, and the braces are the point: an earlier gate accepted
    // LOW_AUTO_CANDIDATE because it only excluded DEPRECATED and DISABLED, so
    // the one state meaning "not granted yet" read as granted.
    const v = lowAutoEligibility(input({ modelLifecycle: "LOW_AUTO_CANDIDATE" }));
    expect(v.eligible).toBe(false);
    expect(v.blockers.map((b) => b.code)).toContain("model_lifecycle");
  });
});

describe("LOW_AUTO chỉ áp cho cảnh LOW", () => {
  it("LOW thì được, MEDIUM và HIGH thì không", () => {
    expect(isAutoRoutable("LOW_AUTO", { complexity: "LOW" })).toBe(true);
    expect(isAutoRoutable("LOW_AUTO", { complexity: "MEDIUM" })).toBe(false);
    expect(isAutoRoutable("LOW_AUTO", { complexity: "HIGH" })).toBe(false);
  });

  it("không biết độ khó thì KHÔNG cho, vì điều kiện chưa được kiểm", () => {
    // A conditional grant with the condition unevaluated has not been met.
    expect(isAutoRoutable("LOW_AUTO")).toBe(false);
    expect(isAutoRoutable("LOW_AUTO", { complexity: null })).toBe(false);
    expect(isAutoRoutable("LOW_AUTO", { complexity: "" })).toBe(false);
  });

  it("lifecycle trống nghĩa là ACTIVE, KHÔNG phải LOW_AUTO", () => {
    // An absent field must never be read as the narrowest grant in the system.
    // ACTIVE is the column default, so absence means a fixture forgot to set it.
    for (const absent of [null, undefined, ""]) {
      expect(isAutoRoutable(absent, { complexity: "HIGH" })).toBe(true);
    }
  });

  it("chuỗi lạ thì chặn, ở mọi độ khó", () => {
    for (const weird of ["low_auto", "LOW-AUTO", "ENABLED", "yes"]) {
      expect(isAutoRoutable(weird, { complexity: "LOW" })).toBe(false);
      expect(isAutoRoutable(weird)).toBe(false);
    }
  });

  it("LOW_AUTO nằm trong enum và có nhãn tiếng Việt", () => {
    expect(MODEL_LIFECYCLES).toContain("LOW_AUTO");
    expect(VI_MODEL_LIFECYCLE.LOW_AUTO).toBeTruthy();
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

  it("vượt trần mỗi video -> chặn", () => {
    // A third ceiling, independent of the other two: the global cap protects
    // the project, the wallet protects the vendor account, and this one stops
    // a single scene eating an approval meant to cover several.
    const v = lowAutoEligibility(input({ perVideoCapRemaining: 0.1 }));
    expect(v.blockers.map((b) => b.code)).toContain("over_per_video_cap");
    expect(lowAutoEligibility(input({ perVideoCapRemaining: null })).eligible).toBe(true);
  });

  it("model chưa BENCHMARK_VERIFIED -> chặn", () => {
    const v = lowAutoEligibility(input({ modelVerification: "UNVERIFIED" }));
    expect(v.blockers.map((b) => b.code)).toContain("not_benchmark_verified");
  });

  it("cảnh LOCAL_MOTION -> chặn, không có gì để mua", () => {
    const v = lowAutoEligibility(input({ motionSource: "LOCAL_MOTION" }));
    expect(v.blockers.map((b) => b.code)).toContain("local_motion");
  });

  it("đã ghim tay model khác -> low-auto không chen vào", () => {
    const v = lowAutoEligibility(input({ manualPinElsewhere: true }));
    expect(v.blockers.map((b) => b.code)).toContain("manual_pin_elsewhere");
  });
});

describe("keyframe: đúng giai đoạn mới là lỗi", () => {
  it("trước bước tạo ảnh, thiếu keyframe là CHỜ chứ không phải hỏng", () => {
    // Refusing here would condemn every project at the one moment when every
    // project looks the same - before any image has been generated.
    const v = lowAutoEligibility(input({ hasKeyframe: false, stage: "PLANNING" }));
    expect(v.eligible).toBe(false);
    expect(v.pendingOnly).toBe(true);
    expect(v.blockers.map((b) => b.code)).toContain("keyframe_pending");
    expect(v.blockers.map((b) => b.code)).not.toContain("needs_keyframe");
  });

  it("tới bước gọi Video AI, thiếu keyframe là hỏng thật", () => {
    // This is where money moves, and "it will be there later" is not a file.
    const v = lowAutoEligibility(input({ hasKeyframe: false, stage: "VIDEO" }));
    expect(v.eligible).toBe(false);
    expect(v.pendingOnly).toBe(false);
    expect(v.blockers.map((b) => b.code)).toContain("needs_keyframe");
  });

  it("thiếu stage thì hiểu là VIDEO — mặc định nghiêm hơn", () => {
    const v = lowAutoEligibility(input({ hasKeyframe: false }));
    expect(v.blockers.map((b) => b.code)).toContain("needs_keyframe");
  });

  it("pendingOnly chỉ đúng khi keyframe là lý do DUY NHẤT", () => {
    // A second blocker means the scene has a real problem and the pending
    // still is not the story.
    const v = lowAutoEligibility(
      input({ hasKeyframe: false, stage: "PLANNING", characterCount: 5 }),
    );
    expect(v.pendingOnly).toBe(false);
  });

  it("cả hai mã keyframe đều dẫn về NEEDS_KEYFRAME", () => {
    for (const stage of ["PLANNING", "VIDEO"] as const) {
      const v = lowAutoEligibility(input({ hasKeyframe: false, stage }));
      expect(lowAutoFallback(v, { localMotionAllowed: false })).toBe("NEEDS_KEYFRAME");
    }
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
