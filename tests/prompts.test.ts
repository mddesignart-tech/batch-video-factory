import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  loadPrompt,
  promptPath,
  PROMPT_NAMES,
  readPromptFile,
  renderTemplate,
  resetPromptOverride,
  savePromptOverride,
  templatePlaceholders,
} from "@/lib/prompts";

describe("prompt templates", () => {
  it("ships every template the app references", () => {
    for (const name of PROMPT_NAMES) {
      expect(fs.existsSync(promptPath(name)), name).toBe(true);
      expect(readPromptFile(name).trim().length).toBeGreaterThan(50);
    }
  });

  it("keeps the content safety rules in the script template", () => {
    const script = readPromptFile("script");
    expect(script).toMatch(/FORBIDDEN/);
    expect(script).toMatch(/politics/i);
    expect(script).toMatch(/copyrighted/i);
    // The violent-literal rewrite rule is a hard product requirement.
    expect(script).toMatch(/violent literal/i);
  });

  it("asks the text provider for bare JSON", () => {
    const script = readPromptFile("script");
    expect(script).toMatch(/valid JSON object/i);
    expect(script).toMatch(/No markdown fence/i);
  });

  it("declares the placeholders the script service fills in", () => {
    const placeholders = templatePlaceholders(readPromptFile("script"));
    for (const key of [
      "idiom",
      "meaning",
      "literalMeaning",
      "exampleSentence",
      "targetDuration",
      "stylePrompt",
      "characters",
      "avoidAngles",
    ]) {
      expect(placeholders, key).toContain(key);
    }
  });
});

describe("renderTemplate", () => {
  it("substitutes provided values", () => {
    expect(renderTemplate("Hi {{name}}, {{n}} times", { name: "Max", n: 3 })).toBe(
      "Hi Max, 3 times",
    );
  });

  it("leaves an unknown placeholder visible rather than writing 'undefined'", () => {
    expect(renderTemplate("A {{missing}} B", {})).toBe("A {{missing}} B");
  });

  it("replaces every occurrence", () => {
    expect(renderTemplate("{{x}}-{{x}}", { x: "1" })).toBe("1-1");
  });
});

describe("prompt overrides", () => {
  it("prefers a saved override over the file, and reverts when cleared", async () => {
    const fromFile = await loadPrompt("youtube");

    await savePromptOverride("youtube", "CUSTOM {{idiom}}");
    expect(await buildPrompt("youtube", { idiom: "Break a leg" })).toBe(
      "CUSTOM Break a leg",
    );

    await resetPromptOverride("youtube");
    expect(await loadPrompt("youtube")).toBe(fromFile);
  });
});
