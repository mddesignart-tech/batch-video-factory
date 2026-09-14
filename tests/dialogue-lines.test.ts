import { describe, expect, it } from "vitest";
import { billableChars, parseDialogueLines } from "@/domain/dialogue-lines";

/**
 * Voice used to be one file per scene, read by whoever was first in the
 * speaking list. Scene 4 of "Spill the beans" is the case that breaks:
 *
 *   Max: "I think I spilled too many beans!" Leo: "Now we know the secret."
 *
 * One file meant Max's voice read Leo's line too, or Leo was dropped. Neither
 * shows up in a cost ledger or a status field, which is why it needs tests.
 */

describe("two speakers in one scene", () => {
  it("splits the real scene 4 line into two", () => {
    const lines = parseDialogueLines(
      'Max: "I think I spilled too many beans!" Leo: "Now we know the secret."',
      "",
      ["Max", "Leo"],
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      speaker: "Max",
      text: "I think I spilled too many beans!",
      lineNumber: 1,
    });
    expect(lines[1]).toMatchObject({
      speaker: "Leo",
      text: "Now we know the secret.",
      lineNumber: 2,
    });
  });

  it("numbers lines from 1 with no gaps", () => {
    const lines = parseDialogueLines(
      'Max: "One." Leo: "Two." Max: "Three."',
      "",
      ["Max", "Leo"],
    );
    expect(lines.map((l) => l.lineNumber)).toEqual([1, 2, 3]);
  });

  it("strips the label and the surrounding quotes", () => {
    const lines = parseDialogueLines('Max: "Hello there!"', "", ["Max"]);
    expect(lines[0]?.text).toBe("Hello there!");
  });
});

describe("speech follows SPEAKING, never PRESENT", () => {
  it("gives no line to a character who is present but silent", () => {
    // Max and Leo are both in frame; only Max speaks. Leo must be drawn and
    // must not be voiced.
    const lines = parseDialogueLines('Max: "Look at this mess!"', "", ["Max"]);
    expect(lines).toHaveLength(1);
    expect(lines.map((l) => l.speaker)).not.toContain("Leo");
  });

  it("does not treat a label as a speaker change when that name is not speaking", () => {
    // "Leo:" here is Max quoting Leo, not Leo talking. Synthesising a Leo voice
    // would be inventing a speaker the script never declared.
    const lines = parseDialogueLines(
      'Max: "And then Leo: the beans are a secret, he said!"',
      "",
      ["Max"],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.speaker).toBe("Max");
    expect(lines[0]?.text).toContain("Leo:");
  });

  it("voices nobody when nobody is speaking", () => {
    expect(parseDialogueLines('Max: "Hello"', "", [])).toEqual([]);
  });
});

describe("fallbacks", () => {
  it("falls back to narration when there is no dialogue", () => {
    const lines = parseDialogueLines("", "Beans roll across the floor.", ["Leo"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      speaker: "Leo",
      text: "Beans roll across the floor.",
    });
  });

  it("gives unlabelled dialogue to the first speaker", () => {
    const lines = parseDialogueLines("Just tell me the secret.", "", ["Mia"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.speaker).toBe("Mia");
  });

  it("returns nothing when there is neither dialogue nor narration", () => {
    expect(parseDialogueLines("", "", ["Max"])).toEqual([]);
  });

  it("returns nothing rather than guessing when narration has no speaker", () => {
    expect(parseDialogueLines("", "Beans everywhere.", [])).toEqual([]);
  });

  it("drops a label with nothing after it", () => {
    const lines = parseDialogueLines('Max: "Hi." Leo:', "", ["Max", "Leo"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.speaker).toBe("Max");
  });
});

describe("billing", () => {
  it("counts the characters actually sent, not the raw script", () => {
    // Labels and quotes are stripped before the request, so billing them would
    // overstate every estimate.
    const raw = 'Max: "I think I spilled too many beans!" Leo: "Now we know the secret."';
    const lines = parseDialogueLines(raw, "", ["Max", "Leo"]);
    const billed = billableChars(lines);
    expect(billed).toBeLessThan(raw.length);
    expect(billed).toBe(
      "I think I spilled too many beans!".length + "Now we know the secret.".length,
    );
  });

  it("counts nothing for a scene with no speech", () => {
    expect(billableChars(parseDialogueLines("", "", []))).toBe(0);
  });
});
