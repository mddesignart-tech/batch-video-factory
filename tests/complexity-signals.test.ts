import { describe, expect, it } from "vitest";
import {
  classifyScene,
  extractSignals,
  COMPLEXITY_PATTERNS,
} from "@/services/complexity";

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
  characters: ["Max", "Leo"],
};

const SCENE_5 = {
  duration: 3,
  visualDescription: "Leo stands alone, simple background, explains meaning.",
  characterAction: "Leo points to text appearing beside him.",
  camera: "Medium shot of Leo.",
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

  it("cannot be handed dialogue at all - the TYPE refuses it", () => {
    // A comment asking callers not to pass dialogue would hold until someone
    // was in a hurry. The field is absent from SceneLike, so the compiler
    // refuses it; this test proves that even a cast past the type changes
    // nothing, because nothing reads it.
    const smuggled = {
      ...SCENE_5,
      dialogue: 'Leo: "Beans everywhere! Hundreds of them spilling and rolling!"',
    } as unknown as typeof SCENE_5;
    expect(classifyScene(smuggled).score).toBe(classifyScene(SCENE_5).score);
    expect(classifyScene(smuggled).complexity).toBe("LOW");
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

describe("REGRESSION: no pattern may contain a control character", () => {
  /**
   * The shape the worst of the three bugs took.
   *
   * `\b` inside a template literal is BACKSPACE (U+0008), not a word boundary.
   * The pattern began with an invisible control code, matched nothing, and
   * nothing failed - it simply scored every bean-covered scene as having no
   * beans. A diff shows no difference between the broken and the fixed form.
   *
   * Fixing one pattern would not stop this happening in the next one, so the
   * whole set is held to the rule.
   */
  it("holds for every pattern the classifier uses", () => {
    const controlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
    for (const [name, pattern] of Object.entries(COMPLEXITY_PATTERNS)) {
      expect(controlChars.test(pattern.source), `${name} has a control char`).toBe(
        false,
      );
    }
  });

  it("checks a real pattern set, not an empty object", () => {
    // A guard that walks nothing passes forever.
    expect(Object.keys(COMPLEXITY_PATTERNS).length).toBeGreaterThan(8);
  });

  it("would CATCH a pattern built the broken way", () => {
    // Proving the guard works, by handing it the bug it exists to find.
    const controlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
    const broken = new RegExp(`${"\b"}(?:beans)`, "i");
    expect(controlChars.test(broken.source)).toBe(true);
    // ...and the broken pattern cannot match the thing it names.
    expect(broken.test("beans everywhere")).toBe(false);
  });

  it("every pattern actually matches something it is meant to", () => {
    // A pattern that matches nothing is the failure mode; each gets one case.
    const probes: Record<string, string> = {
      BODY_MOVEMENT: "Max jumps over the chair",
      CAMERA_MOTION: "slow pan to Leo",
      HAND_INTERACTION: "Leo points at the jar",
      OBJECT_INTERACTION: "Max holds the jar",
      FACIAL: "Max looks surprised",
      ENVIRONMENT: "a busy street",
      MOTION_COMPLEX: "beans scatter everywhere",
      REPEATED_SMALL_OBJECTS: "the floor is covered in coins",
      DENSE_FIELD: "a cluttered table",
      OCCLUSION: "Leo stands behind Max",
      COMPLEX_PHYSICS: "the jar topples",
      TEXT_IN_FRAME: "text appears beside him",
      TEXT_NEGATED: "no text on screen",
    };
    for (const [name, pattern] of Object.entries(COMPLEXITY_PATTERNS)) {
      const probe = probes[name];
      expect(probe, `no probe written for ${name}`).toBeTruthy();
      expect(pattern.test(probe ?? ""), `${name} did not match "${probe}"`).toBe(true);
    }
  });
});

describe("REGRESSION: word boundaries behave", () => {
  const P = COMPLEXITY_PATTERNS.REPEATED_SMALL_OBJECTS;

  it("matches the plural", () => {
    expect(P.test("the floor is covered in beans")).toBe(true);
  });

  it("matches the singular where the quantity word carries it", () => {
    expect(P.test("hundreds of bean shapes")).toBe(true);
  });

  it("matches mid-sentence, not only at the start", () => {
    expect(P.test("Max stands there while beans lie scattered around")).toBe(true);
  });

  it("does NOT match a word that merely contains the noun", () => {
    // "beanbag" is furniture, not a field of beans.
    expect(P.test("many beanbags")).toBe(false);
    expect(P.test("countless cardigans")).toBe(false);
  });

  it("does not match the quantity word on its own", () => {
    expect(P.test("there are hundreds of people")).toBe(false);
  });
});

describe("REGRESSION: text in frame is semantic, not a phrase list", () => {
  const seen = (text: string) =>
    extractSignals({ duration: 3, visualDescription: text }).textInFrame;

  it("catches every tense and wording the scripts actually use", () => {
    for (const text of [
      "text appears beside him",
      "text appearing beside him",
      "words appear on screen",
      "letters appear one by one",
      "a caption appears",
      "the sign displays text",
      "visible text on the wall",
      "written words float up",
      "a title card shows",
      "Leo writes on a whiteboard",
    ]) {
      expect(seen(text), text).toBe(true);
    }
  });

  it("does NOT fire on a scene with no writing in it", () => {
    expect(seen("Leo stands alone against a plain wall")).toBe(false);
    expect(seen("Max shrugs at the camera")).toBe(false);
  });

  it("does NOT fire on a NEGATION of text", () => {
    // Prompts say "no text, no captions". Scoring that as text being present
    // is exactly backwards.
    expect(seen("Static camera. No text. No captions.")).toBe(false);
    expect(seen("no words on screen")).toBe(false);
  });

  it("does not treat the pipeline's own subtitles as on-screen text", () => {
    // Every scene has subtitles; scoring for that would score every scene.
    expect(seen("Leo explains the meaning")).toBe(false);
  });
});
