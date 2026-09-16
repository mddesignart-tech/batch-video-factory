import { describe, expect, it } from "vitest";
import {
  decideMotion,
  effectiveMotionSource,
  type MotionDecision,
} from "@/domain/local-motion";

/**
 * What happens when the two records of how a scene gets its movement DISAGREE.
 *
 * A dry-run over this project's 23 scenes found four where the stored
 * `motionSource` said AI_VIDEO and a fresh `decideMotion` said LOCAL_MOTION.
 * The pipeline read the stored field and would have bought four clips the
 * current rules call unnecessary.
 *
 * Neither "stored wins" nor "newest wins" is safe. Stored-wins keeps paying for
 * a decision the rules have since reversed; newest-wins lets a
 * re-classification START spending with nobody approving it. The rule is
 * directional instead:
 *
 *   FREE WINS        - either side saying LOCAL_MOTION settles it
 *   PAID NEEDS BOTH  - AI_VIDEO only when they agree
 *   A PIN IS A PIN   - except when a person named a provider AND a model
 */

const LOCAL: MotionDecision = { source: "LOCAL_MOTION", reason: "cảnh tĩnh" };
const AI: MotionDecision = { source: "AI_VIDEO", reason: "cảnh hook" };

describe("đồng thuận thì không có gì để giải quyết", () => {
  it("cả hai nói LOCAL_MOTION", () => {
    const r = effectiveMotionSource("LOCAL_MOTION", LOCAL);
    expect(r.source).toBe("LOCAL_MOTION");
    expect(r.diverged).toBe(false);
  });

  it("cả hai nói AI_VIDEO", () => {
    const r = effectiveMotionSource("AI_VIDEO", AI);
    expect(r.source).toBe("AI_VIDEO");
    expect(r.diverged).toBe(false);
  });
});

describe("bất đồng: phương án MIỄN PHÍ thắng", () => {
  it("lưu AI_VIDEO + luật nói LOCAL_MOTION -> LOCAL_MOTION", () => {
    // The four real scenes. Going from paid to free needs nobody's approval:
    // money not spent cannot surprise anyone.
    const r = effectiveMotionSource("AI_VIDEO", LOCAL);
    expect(r.source).toBe("LOCAL_MOTION");
    expect(r.diverged).toBe(true);
    expect(r.reason).toContain("$0");
  });

  it("lưu LOCAL_MOTION + luật nói AI_VIDEO -> VẪN LOCAL_MOTION", () => {
    // The direction that would start spending. Refused: a re-classification is
    // not an approval, and this is exactly what the stored field protects.
    const r = effectiveMotionSource("LOCAL_MOTION", AI);
    expect(r.source).toBe("LOCAL_MOTION");
    expect(r.diverged).toBe(true);
    expect(r.reason).toContain("không tự chuyển sang trả phí");
  });

  it("KHÔNG BAO GIỜ tự chuyển từ miễn phí sang trả phí, ở mọi tổ hợp", () => {
    for (const stored of ["LOCAL_MOTION", "AI_VIDEO", null, undefined, ""]) {
      const r = effectiveMotionSource(stored, LOCAL);
      expect(r.source).toBe("LOCAL_MOTION");
    }
  });
});

describe("ghim tay là một lệnh, không phải mặc định", () => {
  it("đã ghim provider + model thì giữ AI_VIDEO", () => {
    // A person who named both halves decided to buy a clip. Overruling that
    // with the classifier would be the same silent override, pointed the other
    // way - and two scenes in this project are pinned to h3_max on purpose.
    const r = effectiveMotionSource("AI_VIDEO", LOCAL, { manuallyPinned: true });
    expect(r.source).toBe("AI_VIDEO");
    expect(r.diverged).toBe(true);
    expect(r.reason).toContain("GHIM TAY");
  });

  it("ghim tay KHÔNG hồi sinh được một cảnh đã lưu là LOCAL_MOTION", () => {
    // The pin says which model to use if a clip is bought. It does not decide
    // that one should be.
    const r = effectiveMotionSource("LOCAL_MOTION", AI, { manuallyPinned: true });
    expect(r.source).toBe("LOCAL_MOTION");
  });
});

describe("cảnh cũ chưa có trường motionSource", () => {
  it("dùng quyết định mới, và không coi là bất đồng", () => {
    for (const absent of [null, undefined, "", "RUBBISH"]) {
      const r = effectiveMotionSource(absent, AI);
      expect(r.source).toBe("AI_VIDEO");
      expect(r.diverged).toBe(false);
    }
  });
});

describe("bốn cảnh có thật trong dự án", () => {
  /**
   * BALANCED mode, spendPriority LOW. `decideMotion` calls these LOCAL_MOTION
   * because they are the explanation card and the closing tag - the two static
   * beats per video where a push-in on the still is indistinguishable.
   */
  const fresh = decideMotion({
    qualityMode: "BALANCED",
    complexity: "MEDIUM",
    spendPriority: "LOW",
    characterCount: 3,
  });

  it("luật hiện tại đúng là nói LOCAL_MOTION", () => {
    expect(fresh.source).toBe("LOCAL_MOTION");
  });

  it("không ghim tay -> thành LOCAL_MOTION, tiết kiệm tiền", () => {
    expect(effectiveMotionSource("AI_VIDEO", fresh).source).toBe("LOCAL_MOTION");
  });

  it("có ghim tay -> giữ AI_VIDEO, và được ghi nhận là bất đồng", () => {
    const r = effectiveMotionSource("AI_VIDEO", fresh, { manuallyPinned: true });
    expect(r.source).toBe("AI_VIDEO");
    expect(r.diverged).toBe(true);
  });
});
