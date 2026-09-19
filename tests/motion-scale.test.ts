import { describe, expect, it } from "vitest";
import { classifyMotionScale } from "@/domain/motion-scale";
import { lowAutoEligibility, type LowAutoInput } from "@/domain/low-auto";
import { deriveSceneVideoFacts } from "@/services/low-auto-facts";

/**
 * The motion floor: h3_max may be CHOSEN BY THE ROUTER only for the size of
 * movement its samples actually covered.
 *
 * Seven scored paid clips, and every one of them is a blink, a nod, one hand
 * raised and lowered, or half a step backwards - scdet means of 0.00047 to
 * 0.0023, a photograph that breathes. Nobody has ever paid this model to draw
 * somebody running. Reading "LOW complexity" as permission to try would be
 * extrapolating from evidence that does not exist, at $0.40 a guess.
 *
 * These tests are deliberately written as two lists: what the router MAY reach
 * for, and what it may not. A gate with only negative tests drifts closed until
 * it blocks everything and nobody notices; one with only positive tests drifts
 * open. See QĐ-074.
 */

function gate(over: Partial<LowAutoInput> = {}): LowAutoInput {
  return {
    complexity: "LOW",
    characterCount: 1,
    hasKeyframe: true,
    cameraMode: "LOCKED_CAMERA",
    repeatedSmallObjects: false,
    motionScale: "SUBTLE",
    multiCharacterInteraction: false,
    modelLifecycle: "LOW_AUTO",
    modelReliability: "OK",
    modelVerification: "BENCHMARK_VERIFIED",
    promptGuarded: true,
    contradictions: [],
    estimatedCost: 0.4,
    budgetRemaining: 2.5,
    providerBudgetRemaining: 5.51,
    ...over,
  };
}

const scale = (characterAction: string, characterCount = 1) =>
  classifyMotionScale({ characterAction, characterCount });

// ------------------------------------------------------ what MAY be routed ---

describe("ĐƯỢC phép: đúng cỡ chuyển động đã có bằng chứng", () => {
  // Each of these is a real line from a scene that produced a scored clip.
  const allowed: [string, string][] = [
    ["chớp mắt", "Max blinks once and tilts his head very slightly."],
    ["gật đầu", "Max nods once."],
    ["lắc đầu", "Max shakes his head once."],
    ["đứng yên", "Max holds still and looks ahead."],
    ["giữ nguyên tư thế", "Max stays where he is."],
    ["thở", "Max breathes in slowly."],
    ["biểu cảm", "Max frowns, then raises an eyebrow."],
    ["đổi chân", "Max shifts his weight slightly."],
    ["nhìn", "Max glances down at his shoes."],
    ["nửa bước", "Max moves one short pace backwards."],
    // The 8.91 sample, word for word from scene 4 of the first real batch.
    ["mẫu 8,91 nguyên văn", "Max shakes his head once, then eases one short pace back."],
    ["bước rất nhẹ", "Max steps back slightly."],
    ["không mô tả gì", ""],
  ];

  for (const [label, action] of allowed) {
    it(`${label} -> SUBTLE, và cổng cho qua`, () => {
      const verdict = scale(action);
      expect(verdict.scale).toBe("SUBTLE");
      expect(lowAutoEligibility(gate({ motionScale: verdict.scale })).eligible).toBe(true);
    });
  }

  // The 8.91 sample. "Lui nửa bước" is a step, and the evidence covers it
  // precisely because the storyboard said it was a small one.
  it("động tác vừa NHƯNG được mô tả là rất nhỏ -> SUBTLE, có nêu lý do", () => {
    const v = scale("Max steps back half a step, barely moving.");
    expect(v.scale).toBe("SUBTLE");
    expect(v.reason).toContain("rất nhỏ");
  });
});

// ------------------------------------------------- what MUST NOT be routed ---

describe("BỊ CHẶN: chuyển động chưa ai đo trên model này", () => {
  const blocked: [string, string, "MODERATE" | "VIGOROUS"][] = [
    ["chạy", "Max runs across the room.", "VIGOROUS"],
    ["nhảy", "Max jumps off the diving board.", "VIGOROUS"],
    ["đánh nhau", "Max and Leo fight over the jar.", "VIGOROUS"],
    ["quay người mạnh", "Max spins around to face the door.", "VIGOROUS"],
    ["nhảy múa", "Max dances badly.", "VIGOROUS"],
    ["ngã", "Max trips and falls onto the mat.", "VIGOROUS"],
    ["ném", "Max throws the jar across the kitchen.", "VIGOROUS"],
    ["leo", "Max climbs onto the chair.", "VIGOROUS"],
    ["rượt đuổi", "Leo chases Max around the table.", "VIGOROUS"],
    ["đi", "Max walks to the window.", "MODERATE"],
    ["ngồi xuống", "Max sits down on the sofa.", "MODERATE"],
    ["đứng lên", "Max stands up from the chair.", "MODERATE"],
    ["xoay người", "Max turns around to look behind him.", "MODERATE"],
    ["cúi xuống", "Max bends down to pick up the coin.", "MODERATE"],
    ["với tay", "Max reaches out for the handle.", "MODERATE"],
    ["đẩy cửa", "Max pushes the door open.", "MODERATE"],
    ["chỉ tay", "Max points at the ceiling.", "MODERATE"],
  ];

  for (const [label, action, expected] of blocked) {
    it(`${label} -> ${expected}, và cổng CHẶN`, () => {
      const verdict = scale(action);
      expect(verdict.scale).toBe(expected);
      const result = lowAutoEligibility(gate({ motionScale: verdict.scale }));
      expect(result.eligible).toBe(false);
      expect(result.blockers.map((b) => b.code)).toContain("motion_too_large");
    });
  }

  // A diminisher shrinks a walk, not a run. "Runs slightly" is still a run.
  // "Pace" is a unit of distance as often as it is a verb. Pacing about the
  // room is a walk; one short pace back is the 8.91 sample.
  it("'paces around the room' là đi, 'one short pace' thì không", () => {
    expect(scale("Max paces around the room.").scale).toBe("MODERATE");
    expect(scale("Max eases one short pace back.").scale).toBe("SUBTLE");
  });

  it("'chạy' kèm từ giảm nhẹ vẫn là VIGOROUS", () => {
    expect(scale("Max runs slightly to the left.").scale).toBe("VIGOROUS");
  });

  it("không biết cỡ chuyển động -> CHẶN, không đoán", () => {
    const result = lowAutoEligibility(gate({ motionScale: undefined }));
    expect(result.eligible).toBe(false);
    const blocker = result.blockers.find((b) => b.code === "motion_too_large");
    expect(blocker!.message).toContain("chưa xác định");
  });
});

// --------------------------------------------------- multi-character work ---

describe("tương tác nhiều nhân vật: chưa có mẫu nào đo", () => {
  const interactions = [
    "Leo hugs Max.",
    "Max and Leo shake hands.",
    "Leo hands him the jar.",
    "Mia pats him on the shoulder.",
  ];

  for (const action of interactions) {
    it(`"${action}" -> đánh dấu tương tác và CHẶN`, () => {
      const v = scale(action, 2);
      expect(v.multiCharacterInteraction).toBe(true);
      const result = lowAutoEligibility(
        gate({
          characterCount: 2,
          motionScale: "SUBTLE",
          multiCharacterInteraction: true,
        }),
      );
      expect(result.eligible).toBe(false);
      expect(result.blockers.map((b) => b.code)).toContain("multi_character_interaction");
    });
  }

  // One person cannot interact with anybody, so the same words must not fire.
  it("cảnh một nhân vật: cùng câu chữ KHÔNG bị coi là tương tác", () => {
    expect(scale("Max hands over the jar.", 1).multiCharacterInteraction).toBe(false);
  });

  // The 8.92 sample: two characters taking turns, not touching. That shape has
  // evidence and must stay routable, or the floor has closed too far.
  it("hai nhân vật lần lượt nói và gật -> vẫn ĐƯỢC, vì đúng mẫu 8,92", () => {
    const v = scale("Leo raises one hand then lowers it. Mia nods.", 2);
    expect(v.scale).toBe("SUBTLE");
    expect(v.multiCharacterInteraction).toBe(false);
    expect(
      lowAutoEligibility(gate({ characterCount: 2, motionScale: v.scale })).eligible,
    ).toBe(true);
  });
});

// ------------------------------------------ the derivation the pipeline uses ---

describe("dẫn xuất chung: cùng một câu trả lời cho mọi caller", () => {
  const sceneRow = (over: Record<string, unknown> = {}) => ({
    duration: 5,
    camera: "Locked static medium shot, no camera movement.",
    visualDescription: "Max stands against a plain wall.",
    characterAction: "Max blinks once.",
    videoPrompt:
      "Max stands against a plain wall. Movement: Max blinks once. " +
      "Camera: Locked static medium shot, no camera movement. " +
      "Keep the character identical to the reference image.",
    complexity: "LOW",
    spendPriority: "HIGH",
    motionSource: "AI_VIDEO",
    imagePath: "projects/p/images/k.png",
    videoProvider: null,
    videoModel: null,
    videoModelPinned: false,
    charactersPresentJson: JSON.stringify(["Max"]),
    speakingCharactersJson: JSON.stringify(["Max"]),
    primaryCharactersJson: JSON.stringify(["Max"]),
    ...over,
  });

  it("cảnh chớp mắt -> facts nói SUBTLE", () => {
    const d = deriveSceneVideoFacts(sceneRow(), {
      qualityMode: "BALANCED",
      keyframeExists: () => true,
    });
    expect(d.facts.motionScale).toBe("SUBTLE");
    expect(d.motionScale.matched).toContain("chớp mắt");
  });

  it("cảnh chạy -> facts nói VIGOROUS, và nêu lý do đọc được", () => {
    const d = deriveSceneVideoFacts(
      sceneRow({ characterAction: "Max runs towards the edge." }),
      { qualityMode: "BALANCED", keyframeExists: () => true },
    );
    expect(d.facts.motionScale).toBe("VIGOROUS");
    expect(d.motionScale.reason).toContain("chạy");
  });

  // The action field is what an author fills in; the description is the
  // fallback for an import that folded the action into it.
  it("hành động rỗng -> đọc sang visualDescription", () => {
    const d = deriveSceneVideoFacts(
      sceneRow({
        characterAction: "",
        visualDescription: "Max runs down the corridor.",
      }),
      { qualityMode: "BALANCED", keyframeExists: () => true },
    );
    expect(d.facts.motionScale).toBe("VIGOROUS");
  });
});
