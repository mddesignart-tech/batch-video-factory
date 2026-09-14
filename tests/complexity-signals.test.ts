import { describe, expect, it } from "vitest";
import { classifyScene, extractSignals } from "@/services/complexity";

/**
 * The signals added after Runway refused scene 4 of "Spill the beans".
 *
 * That scene scored LOW at 3.5 - two characters, ordinary gestures - and was
 * rejected twice with INTERNAL.BAD_OUTPUT and zero credits. The floor was
 * covered in hundreds of beans and nothing in the scoring could see them.
 */

const SCENE_4 = {
  duration: 4,
  visualDescription: "Beans everywhere, Max looks at camera, Leo steps forward.",
  characterAction: "Max shrugs, Leo smiles calmly.",
  camera: "Close-up on Max, then pan to Leo.",
  dialogue: 'Max: "I think I spilled too many beans!" Leo: "Now we know the secret."',
  characters: ["Max", "Leo"],
};

const SCENE_5 = {
  duration: 3,
  visualDescription: "Leo stands alone, simple background, explains meaning.",
  characterAction: "Leo points to text appearing beside him.",
  camera: "Medium shot of Leo.",
  dialogue: 'Leo: "Spill the beans means tell a secret."',
  characters: ["Leo"],
};

describe("repeated small objects", () => {
  it("sees a floor covered in beans", () => {
    expect(extractSignals(SCENE_4).repeatedSmallObjects).toBe(true);
  });

  it("generalises beyond beans, which is the whole point", () => {
    // Hard-coding the current script's noun would mean editing this file the
    // first time someone writes "lentils".
    for (const text of [
      "The floor is covered in coins.",
      "Hundreds of tiny confetti pieces fall.",
      "Marbles scattered across the table.",
      "A sea of petals fills the frame.",
      "Piles of crumbs on the counter.",
    ]) {
      expect(
        extractSignals({ duration: 4, visualDescription: text }).repeatedSmallObjects,
        text,
      ).toBe(true);
    }
  });

  it("matches a dense field described directly", () => {
    expect(
      extractSignals({
        duration: 4,
        visualDescription: "A cluttered table fills the frame.",
      }).repeatedSmallObjects,
    ).toBe(true);
  });

  it("does not fire on a plain background", () => {
    expect(extractSignals(SCENE_5).repeatedSmallObjects).toBe(false);
  });

  it("needs BOTH a quantity and a small object, not either alone", () => {
    expect(
      extractSignals({ duration: 4, visualDescription: "Max holds one bean." })
        .repeatedSmallObjects,
    ).toBe(false);
    expect(
      extractSignals({ duration: 4, visualDescription: "Max is everywhere." })
        .repeatedSmallObjects,
    ).toBe(false);
  });
});

describe("visual difficulty comes from visuals, never dialogue", () => {
  /**
   * This was a real defect. Every line of an idiom video contains the idiom, so
   * reading dialogue put "beans" and "spill" into the visual score of a shot
   * showing one man against a blank wall. Scene 5 came out MEDIUM on a shot
   * Runway had already animated successfully.
   */
  it("ignores the idiom spoken over a plain shot", () => {
    const s = extractSignals(SCENE_5);
    expect(s.repeatedSmallObjects).toBe(false);
    expect(s.complexPhysics).toBe(false);
  });

  it("keeps scene 5 LOW, matching the clip Runway actually produced", () => {
    const result = classifyScene(SCENE_5);
    expect(result.complexity).toBe("LOW");
  });

  it("changes nothing when only the dialogue changes", () => {
    const a = classifyScene(SCENE_5);
    const b = classifyScene({
      ...SCENE_5,
      dialogue: 'Leo: "Beans everywhere! Hundreds of them spilling and rolling!"',
    });
    expect(b.score).toBe(a.score);
  });
});

describe("scene 4, the case that motivated all of this", () => {
  it("is no longer LOW", () => {
    expect(classifyScene(SCENE_4).complexity).not.toBe("LOW");
  });

  it("scores at least MEDIUM", () => {
    const result = classifyScene(SCENE_4);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  it("says the beans are why, in words an operator can act on", () => {
    const result = classifyScene(SCENE_4);
    expect(result.reasons.join(" ")).toMatch(/vật thể nhỏ lặp lại/);
  });

  it("scores higher than it did before the signal existed", () => {
    // Same scene minus the bean-covered floor: the difference IS the signal.
    const without = classifyScene({
      ...SCENE_4,
      visualDescription: "Max looks at camera, Leo steps forward.",
    });
    expect(classifyScene(SCENE_4).score).toBeGreaterThan(without.score);
  });
});

describe("the other new signals", () => {
  it("sees physics: falling, rolling, spilling", () => {
    expect(
      extractSignals({
        duration: 4,
        visualDescription: "Beans tumble out and roll across the floor.",
      }).complexPhysics,
    ).toBe(true);
  });

  it("sees occlusion", () => {
    expect(
      extractSignals({
        duration: 4,
        visualDescription: "Leo stands behind Max, partially hidden.",
      }).occlusion,
    ).toBe(true);
  });

  it("sees text in frame, which models render badly", () => {
    expect(extractSignals(SCENE_5).textInFrame).toBe(true);
  });

  it("counts a field of objects as ONE mover, not hundreds", () => {
    // Counting beans individually would drown out every other signal.
    const s = extractSignals(SCENE_4);
    expect(s.independentMovers).toBeLessThan(6);
    expect(s.independentMovers).toBeGreaterThan(2);
  });

  it("keeps a genuinely simple scene simple", () => {
    const result = classifyScene({
      duration: 3,
      visualDescription: "Leo stands still against a plain wall.",
      characterAction: "Leo blinks.",
      camera: "Static medium shot.",
      characters: ["Leo"],
    });
    expect(result.complexity).toBe("LOW");
  });
});
