import { describe, expect, it } from "vitest";
import { ScriptSchema, scriptNeedsRewrite } from "@/domain/script";
import {
  angleKeyFor,
  parseScript,
  repairJson,
  ScriptError,
  scriptHashFor,
  withDerivedRouting,
} from "@/services/script-service";
import { MockTextProvider } from "@/providers/mock/mock-text-provider";
import { classifyScene, assignSpendPriority } from "@/services/complexity";

const provider = new MockTextProvider();

const request = {
  idiom: "Break a leg",
  meaning: "Good luck",
  literalMeaning:
    "He thinks he must break his own leg, so he wraps it in a giant cartoon bandage.",
  exampleSentence: "Break a leg on your interview!",
  targetDuration: 27,
  stylePrompt: "3D animated cartoon style, bright colours",
  characters: [
    { name: "Max", personality: "naive", visualPrompt: "yellow hoodie" },
    { name: "Leo", personality: "calm", visualPrompt: "round glasses" },
  ],
  avoidAngles: [] as string[],
  model: "mock-text-1",
  systemPrompt: "(mock provider ignores this)",
};

describe("script JSON contract", () => {
  it("produces a document that satisfies the schema", async () => {
    const script = await provider.generateScript(request);
    expect(() => ScriptSchema.parse(script)).not.toThrow();
  });

  it("produces 4 to 6 scenes for a normal target duration", async () => {
    const script = await provider.generateScript(request);
    expect(script.scenes.length).toBeGreaterThanOrEqual(4);
    expect(script.scenes.length).toBeLessThanOrEqual(6);
  });

  it("keeps every scene short enough for a single AI generation", async () => {
    const script = await provider.generateScript(request);
    for (const scene of script.scenes) {
      expect(scene.duration).toBeLessThanOrEqual(6);
      expect(scene.duration).toBeGreaterThanOrEqual(2);
    }
  });

  it("lands near the requested total duration", async () => {
    const script = await provider.generateScript(request);
    const total = script.scenes.reduce((sum, s) => sum + s.duration, 0);
    expect(total).toBeGreaterThan(18);
    expect(total).toBeLessThan(36);
  });

  it("carries the meaning and example sentence through to the document", async () => {
    const script = await provider.generateScript(request);
    expect(script.meaning).toBe("Good luck");
    expect(script.exampleSentence).toBe("Break a leg on your interview!");
  });

  it("fills in image and video prompts for every scene", async () => {
    const script = await provider.generateScript(request);
    for (const scene of script.scenes) {
      expect(scene.imagePrompt.length).toBeGreaterThan(20);
      expect(scene.videoPrompt.length).toBeGreaterThan(20);
    }
  });

  it("includes the style preset in the image prompts", async () => {
    const script = await provider.generateScript(request);
    expect(script.scenes[0]!.imagePrompt).toContain("3D animated cartoon style");
  });

  it("marks the opening scene as high spend priority", async () => {
    const script = withDerivedRouting(await provider.generateScript(request));
    expect(script.scenes[0]!.spendPriority).toBe("HIGH");
  });
});

describe("duplicate prevention", () => {
  it("picks a different comedy angle when the first one is excluded", async () => {
    const first = await provider.generateScript(request);
    const second = await provider.generateScript({
      ...request,
      avoidAngles: [first.angleKey],
    });
    expect(second.angleKey).not.toBe(first.angleKey);
  });

  it("gives identical scripts the same hash", async () => {
    const a = await provider.generateScript(request);
    const b = await provider.generateScript(request);
    expect(scriptHashFor(a)).toBe(scriptHashFor(b));
  });

  it("gives different angles different angle keys", async () => {
    const a = await provider.generateScript(request);
    const b = await provider.generateScript({
      ...request,
      avoidAngles: [a.angleKey],
    });
    expect(angleKeyFor(a)).not.toBe(angleKeyFor(b));
  });

  it("namespaces the angle key by idiom", async () => {
    const a = await provider.generateScript(request);
    const b = await provider.generateScript({
      ...request,
      idiom: "Piece of cake",
    });
    expect(angleKeyFor(a).split("::")[0]).not.toBe(
      angleKeyFor(b).split("::")[0],
    );
  });
});

describe("malformed JSON repair", () => {
  const valid = {
    idiom: "Break a leg",
    title: "Test",
    hook: "Hook line",
    meaning: "Good luck",
    exampleSentence: "Break a leg!",
    durationTarget: 25,
    scenes: [
      { sceneNumber: 1, duration: 4, visualDescription: "A" },
      { sceneNumber: 2, duration: 4, visualDescription: "B" },
      { sceneNumber: 3, duration: 4, visualDescription: "C" },
    ],
  };

  it("accepts clean JSON", () => {
    expect(parseScript(JSON.stringify(valid)).idiom).toBe("Break a leg");
  });

  it("strips a markdown code fence", () => {
    const wrapped = "```json\n" + JSON.stringify(valid) + "\n```";
    expect(parseScript(wrapped).title).toBe("Test");
  });

  it("strips a prose preamble", () => {
    const chatty = `Sure! Here is the script:\n${JSON.stringify(valid)}`;
    expect(parseScript(chatty).title).toBe("Test");
  });

  it("removes trailing commas", () => {
    const broken = JSON.stringify(valid).replace("}]", "},]");
    expect(parseScript(broken).scenes).toHaveLength(3);
  });

  it("normalises smart quotes", () => {
    const smart = repairJson('{“a”: 1}');
    expect(smart).toBe('{"a": 1}');
  });

  it("throws a clear error rather than failing silently", () => {
    expect(() => parseScript("this is not json at all")).toThrow(ScriptError);
    expect(() => parseScript("{}")).toThrow(/kịch bản/i);
  });

  it("rejects a script with too few scenes", () => {
    const short = { ...valid, scenes: valid.scenes.slice(0, 1) };
    expect(() => parseScript(JSON.stringify(short))).toThrow(ScriptError);
  });
});

describe("script quality gating", () => {
  it("scores every axis between 1 and 10", async () => {
    const script = await provider.generateScript(request);
    const score = await provider.scoreScript(script);
    for (const value of [
      score.hook,
      score.humor,
      score.clarity,
      score.learningValue,
      score.visualFeasibility,
    ]) {
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(10);
    }
  });

  it("flags a rewrite when a critical axis is below 7", () => {
    expect(
      scriptNeedsRewrite({
        hook: 6,
        humor: 9,
        clarity: 9,
        learningValue: 9,
        visualFeasibility: 9,
        notes: "",
      }),
    ).toBe(true);
  });

  it("does not flag a rewrite when only a non-critical axis is low", () => {
    expect(
      scriptNeedsRewrite({
        hook: 8,
        humor: 8,
        clarity: 8,
        learningValue: 5,
        visualFeasibility: 5,
        notes: "",
      }),
    ).toBe(false);
  });
});

describe("scene complexity classification", () => {
  it("rates a static explanation card as LOW", () => {
    const result = classifyScene({
      duration: 3,
      visualDescription: "Clean simple background with a text panel.",
      characterAction: "Leo stands still.",
      camera: "static shot",
      characters: ["Leo"],
    });
    expect(result.complexity).toBe("LOW");
  });

  it("rates a two-character slapstick scene as HIGH", () => {
    const result = classifyScene({
      duration: 6,
      visualDescription:
        "Everything collapses in a soft cartoon pile on a busy street.",
      characterAction: "Max grabs the box while Leo runs to catch it.",
      camera: "wide shot with quick whip pan",
      characters: ["Max", "Leo"],
    });
    expect(result.complexity).toBe("HIGH");
    expect(result.reasons.length).toBeGreaterThan(2);
  });

  it("explains its reasoning in Vietnamese for the UI", () => {
    const result = classifyScene({
      duration: 5,
      visualDescription: "Max grabs a giant box",
      characterAction: "Max holds the box",
      camera: "push-in",
      characters: ["Max", "Leo"],
    });
    expect(result.reasons.join(" ")).toMatch(/nhân vật|tay|đạo cụ/);
  });
});

describe("spend priority", () => {
  it("always prioritises the first three seconds", () => {
    const result = assignSpendPriority({
      sceneNumber: 1,
      totalScenes: 6,
      startSeconds: 0,
      complexity: "LOW",
    });
    expect(result.priority).toBe("HIGH");
  });

  it("prioritises the punchline", () => {
    const result = assignSpendPriority({
      sceneNumber: 4,
      totalScenes: 6,
      startSeconds: 14,
      complexity: "MEDIUM",
      role: "punchline",
    });
    expect(result.priority).toBe("HIGH");
  });

  it("deprioritises the static meaning card", () => {
    const result = assignSpendPriority({
      sceneNumber: 5,
      totalScenes: 6,
      startSeconds: 19,
      complexity: "LOW",
      role: "meaning",
    });
    expect(result.priority).toBe("LOW");
  });
});

describe("YouTube metadata", () => {
  it("generates a title, description, hashtags and keywords", async () => {
    const script = await provider.generateScript(request);
    const meta = await provider.generateYoutubeMeta(script);
    expect(meta.title).toContain("Break a leg");
    expect(meta.description).toContain("Good luck");
    expect(meta.hashtags).toContain("#Shorts");
    expect(meta.keywords.length).toBeGreaterThan(3);
  });
});
