import { describe, expect, it } from "vitest";
import {
  COMPACT_CONSTRAINTS,
  fitVideoPrompt,
  PromptTooLongError,
  RUNWAY_MAX_PROMPT_CHARS,
} from "@/domain/video-prompt";

/**
 * Regression test for a paid-path failure: Runway rejects promptText over 1000
 * characters, and our scene prompts are ~1200. The 400 was free, but it was
 * discovered by making the paid call.
 */

const SETUP =
  "Animate this keyframe. Scene: Max and Leo stand together on a floor covered with spilled beans.";
const MOVEMENT =
  "Movement: Max notices the ridiculous mess around him, looks briefly down at the beans, " +
  "then looks toward the camera with an embarrassed expression. Max raises both shoulders " +
  "in one clearly visible shrug and opens his hands slightly as if saying \"What did I do?\". " +
  "His shoulders then relax naturally. Leo turns his eyes toward Max and reacts with an " +
  "amused smile, followed by one small visible head shake. A few beans near their shoes " +
  "roll and settle naturally.";
const BOILERPLATE =
  "Use natural expressive character animation. The described gestures and facial reactions " +
  "should be clearly visible to a viewer. Camera remains locked and stable: no camera pan, " +
  "no camera tilt, no large zoom, no scene transition. Keep every character exactly as they " +
  "appear in the source image: same face, same hairstyle, same clothing, same body " +
  "proportions, same relative height, same visual style. Do not redraw or restyle either " +
  "character. No new characters. No new objects. No text, no captions, no subtitles, no " +
  "letters or numbers. Avoid: morphing, face drift, body deformation, extra limbs, warped " +
  "hands, flicker, background replacement.";

const FULL = [SETUP, MOVEMENT, BOILERPLATE].join("\n\n");

describe("fitVideoPrompt", () => {
  it("leaves a prompt that already fits completely alone", () => {
    const short = [SETUP, MOVEMENT].join("\n\n");
    const fitted = fitVideoPrompt(short, RUNWAY_MAX_PROMPT_CHARS);
    expect(fitted.changed).toBe(false);
    expect(fitted.text).toBe(short);
  });

  it("brings a real 1200-character scene prompt under the limit", () => {
    expect(FULL.length).toBeGreaterThan(RUNWAY_MAX_PROMPT_CHARS);
    const fitted = fitVideoPrompt(FULL, RUNWAY_MAX_PROMPT_CHARS);
    expect(fitted.changed).toBe(true);
    expect(fitted.finalChars).toBeLessThanOrEqual(RUNWAY_MAX_PROMPT_CHARS);
  });

  it("preserves the movement description BYTE FOR BYTE", () => {
    // The whole point of the benchmark is that every vendor animates the same
    // motion. Trimming a word here would make the comparison meaningless.
    const fitted = fitVideoPrompt(FULL, RUNWAY_MAX_PROMPT_CHARS);
    expect(fitted.text).toContain(MOVEMENT);
  });

  it("preserves the scene setup", () => {
    const fitted = fitVideoPrompt(FULL, RUNWAY_MAX_PROMPT_CHARS);
    expect(fitted.text).toContain(SETUP);
  });

  it("replaces the boilerplate rather than cutting it mid-sentence", () => {
    const fitted = fitVideoPrompt(FULL, RUNWAY_MAX_PROMPT_CHARS);
    expect(fitted.text).toContain(COMPACT_CONSTRAINTS);
    expect(fitted.text).not.toContain("Avoid: morphing");
  });

  it("still states the two constraints that matter most", () => {
    const fitted = fitVideoPrompt(FULL, RUNWAY_MAX_PROMPT_CHARS);
    expect(fitted.text.toLowerCase()).toContain("static locked camera");
    expect(fitted.text.toLowerCase()).toContain("same faces");
  });

  it("refuses instead of truncating when the movement alone will not fit", () => {
    const huge = [SETUP, `Movement: ${"x".repeat(2000)}`, BOILERPLATE].join("\n\n");
    expect(() => fitVideoPrompt(huge, RUNWAY_MAX_PROMPT_CHARS)).toThrow(
      PromptTooLongError,
    );
  });

  it("says what to shorten when it refuses", () => {
    const huge = [SETUP, `Movement: ${"x".repeat(2000)}`].join("\n\n");
    expect(() => fitVideoPrompt(huge, RUNWAY_MAX_PROMPT_CHARS)).toThrow(
      /Movement/,
    );
  });

  it("reports the before and after sizes for the log", () => {
    const fitted = fitVideoPrompt(FULL, RUNWAY_MAX_PROMPT_CHARS);
    expect(fitted.originalChars).toBe(FULL.length);
    expect(fitted.note).toContain(String(fitted.finalChars));
  });
});
