import { describe, expect, it } from "vitest";
import {
  checkSuitability,
  marksProviderUnsuitable,
  requiresExplicitPin,
  withFlag,
  RUNWAY_UNSUITABLE,
} from "@/domain/video-suitability";

/** The model every measured limit here was gathered from. */
const TURBO = "gen4_turbo:720x1280";
/** A sibling model at the same vendor that nothing has been measured about. */
const GEN45 = "gen4.5:720x1280";

/**
 * These rules exist because clips were paid for and looked at, not because a
 * provider seemed better on paper.
 *
 *   Runway gen4_turbo, scene 4 (two characters, floor of spilled beans)
 *     FAILED twice, INTERNAL.BAD_OUTPUT.CODE01, 0 credits both times.
 *   Runway gen4_turbo, scene 5 (one character, plain background)
 *     SUCCEEDED. Identity 10, camera 10, motion 4. $0.25.
 *   Sora-2, scene 4, twice
 *     Never failed. $0.40 for 4 seconds.
 */

describe("complexity ceiling", () => {
  it("lets Runway take a simple scene - the one it actually succeeded on", () => {
    const v = checkSuitability({
      provider: "runway",
      model: TURBO,
      complexity: "LOW",
      characterCount: 1,
    });
    expect(v.allowed).toBe(true);
  });

  it("keeps Runway out of MEDIUM", () => {
    const v = checkSuitability({
      provider: "runway",
      model: TURBO,
      complexity: "MEDIUM",
      characterCount: 1,
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/MEDIUM/);
  });

  it("keeps Runway out of HIGH", () => {
    expect(
      checkSuitability({
        provider: "runway",
        model: TURBO,
        complexity: "HIGH",
        characterCount: 1,
      })
        .allowed,
    ).toBe(false);
  });

  it("does NOT apply a sibling model's measured limits to an untested one", () => {
    // gen4_turbo failed scene 4 and passed scene 5. That is a fact about
    // gen4_turbo. gen4.5 is a different model at the same vendor with no
    // evidence either way, and inheriting a ceiling just for sharing a company
    // is the same guess this file refuses to make for a whole provider.
    for (const complexity of ["LOW", "MEDIUM", "HIGH"] as const) {
      expect(
        checkSuitability({
          provider: "runway",
          model: GEN45,
          complexity,
          characterCount: 3,
        }).allowed,
        complexity,
      ).toBe(true);
    }
  });

  it("says WHY, in terms of the benchmark rather than a rule number", () => {
    const v = checkSuitability({
      provider: "runway",
      model: TURBO,
      complexity: "HIGH",
      characterCount: 1,
    });
    expect(v.reason).toMatch(/hỏng ở cảnh phức tạp/);
  });

  it("puts no ceiling on a provider nothing has been measured about", () => {
    // Inventing a limit for an untested provider would be guessing, and a guess
    // that blocks a model is as wrong as a guess that picks one.
    for (const complexity of ["LOW", "MEDIUM", "HIGH"] as const) {
      expect(
        checkSuitability({
          provider: "openai",
          model: "sora-2:720x1280",
          complexity,
          characterCount: 3,
        })
          .allowed,
      ).toBe(true);
    }
  });
});

describe("character ceiling", () => {
  it("allows Runway up to two characters", () => {
    expect(
      checkSuitability({
        provider: "runway",
        model: TURBO,
        complexity: "LOW",
        characterCount: 2,
      })
        .allowed,
    ).toBe(true);
  });

  it("refuses three, which nothing has shown it can do", () => {
    const v = checkSuitability({
      provider: "runway",
      model: TURBO,
      complexity: "LOW",
      characterCount: 3,
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/3 nhân vật/);
  });
});

describe("a scene the provider has already refused", () => {
  it("is never offered to that provider again", () => {
    // Scene 4 was attempted twice with byte-identical requests and failed
    // identically. A third would have done the same.
    const v = checkSuitability({
      provider: "runway",
      model: TURBO,
      complexity: "LOW",
      characterCount: 2,
      sceneFlags: [RUNWAY_UNSUITABLE],
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/INTERNAL.BAD_OUTPUT/);
  });

  it("blocks it even when complexity and character count are both fine", () => {
    // The marker overrides the ceilings: it is direct evidence about THIS
    // scene, which beats a rule inferred from other scenes.
    const v = checkSuitability({
      provider: "runway",
      model: TURBO,
      complexity: "LOW",
      characterCount: 1,
      sceneFlags: [RUNWAY_UNSUITABLE],
    });
    expect(v.allowed).toBe(false);
  });

  it("does not block a DIFFERENT provider on the same scene", () => {
    expect(
      checkSuitability({
        provider: "openai",
        complexity: "LOW",
        characterCount: 2,
        sceneFlags: [RUNWAY_UNSUITABLE],
      }).allowed,
    ).toBe(true);
  });
});

describe("which failures earn the marker", () => {
  it("marks a BAD_OUTPUT, which will not change on a retry", () => {
    expect(marksProviderUnsuitable("runway", "INTERNAL.BAD_OUTPUT.CODE01")).toBe(
      RUNWAY_UNSUITABLE,
    );
  });

  it("does NOT mark a 400 - that is our mistake, worth fixing and retrying", () => {
    expect(marksProviderUnsuitable("runway", "http_400")).toBeNull();
  });

  it("does NOT mark a rate limit or a server error - both are transient", () => {
    expect(marksProviderUnsuitable("runway", "http_429")).toBeNull();
    expect(marksProviderUnsuitable("runway", "http_500")).toBeNull();
  });

  it("does NOT mark a timeout, where the outcome is simply unknown", () => {
    expect(marksProviderUnsuitable("runway", "timeout")).toBeNull();
  });

  it("marks nothing for a provider with no such evidence", () => {
    expect(marksProviderUnsuitable("openai", "INTERNAL.BAD_OUTPUT.CODE01")).toBeNull();
  });

  it("survives a missing error code", () => {
    expect(marksProviderUnsuitable("runway", null)).toBeNull();
    expect(marksProviderUnsuitable("runway", undefined)).toBeNull();
  });
});

describe("flag bookkeeping", () => {
  it("adds a marker once", () => {
    expect(withFlag([], RUNWAY_UNSUITABLE)).toEqual([RUNWAY_UNSUITABLE]);
  });

  it("does not duplicate one already there", () => {
    expect(withFlag([RUNWAY_UNSUITABLE], RUNWAY_UNSUITABLE)).toEqual([
      RUNWAY_UNSUITABLE,
    ]);
  });

  it("keeps markers left by other providers", () => {
    expect(withFlag(["SOMETHING_ELSE"], RUNWAY_UNSUITABLE)).toEqual([
      "SOMETHING_ELSE",
      RUNWAY_UNSUITABLE,
    ]);
  });
});

describe("a model that is capable but not yet cleared", () => {
  /**
   * Gen-4.5 sits in a third state that neither of the obvious two describes.
   *
   * It succeeded twice on the hardest scene in the project, so blocking it in
   * MAX_COMPLEXITY would contradict two paid runs - and `findContradictions`
   * would rightly report that. But with the camera locked seven ways it still
   * crept in far enough to clip Leo's arm out of frame at 4.5s, so automatic
   * routing should not be spending $0.72 a scene on it either.
   */
  it("is still suitable - the evidence says it can do the work", () => {
    expect(
      checkSuitability({
        provider: "runway",
        model: GEN45,
        complexity: "HIGH",
        characterCount: 3,
      }).allowed,
    ).toBe(true);
  });

  it("is nonetheless flagged as needing a deliberate choice", () => {
    expect(requiresExplicitPin("runway", GEN45)).toMatch(/chưa phải mặc định/);
  });

  it("explains itself with the numbers, not just a verdict", () => {
    // An operator deciding whether to pay for it needs the two scores that
    // failed and the price, not the word "unproven".
    const reason = requiresExplicitPin("runway", GEN45)!;
    expect(reason).toContain("0,72");
    expect(reason).toMatch(/camera 7/);
  });

  it("does not flag the model that IS cleared for its tier", () => {
    expect(requiresExplicitPin("runway", TURBO)).toBeNull();
  });

  it("does not flag a whole provider because one of its models is unproven", () => {
    // The same mistake as inheriting a ceiling by vendor, in the other
    // direction: gen4_turbo earned its LOW tier and must keep it.
    expect(requiresExplicitPin("runway")).toBeNull();
    expect(requiresExplicitPin("openai", "sora-2:720x1280")).toBeNull();
  });
});
