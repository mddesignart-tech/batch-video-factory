import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  recordBenchmark,
  findContradictions,
  benchmarksFor,
  averageScore,
  averageIdentity,
  type RecordBenchmarkInput,
} from "@/services/benchmark-evidence";
import { RUNWAY_UNSUITABLE } from "@/domain/video-suitability";

/**
 * The point of this table is that a later edit to the routing rules cannot
 * quietly contradict a clip somebody paid for.
 *
 * That has already happened twice in this project and both times a person
 * caught it by remembering a result, which is not a mechanism. These tests are
 * the mechanism: they assert the alarm fires in both directions, and - just as
 * importantly - that it stays quiet when the rules and the evidence agree.
 */

const BASE: RecordBenchmarkInput = {
  provider: "runway",
  model: "gen4_turbo:720x1280",
  sceneNumber: 1,
  complexity: "LOW",
  characterCount: 1,
  promptSent: "Animate this image. Static camera.",
  durationRequested: 5,
  durationSent: 5,
  outcome: "succeeded",
  actualCost: 0.25,
};

beforeEach(async () => {
  await prisma.videoBenchmark.deleteMany();
});

describe("recording a run", () => {
  it("keeps the prompt that was SENT, not the one we meant to send", async () => {
    // The same mistake `sentRequest` exists to prevent: a record that describes
    // a request which never left the building is worse than no record, because
    // it looks authoritative.
    await recordBenchmark({ ...BASE, promptSent: "the fitted 796-char version" });
    const [row] = await benchmarksFor("runway");
    expect(row!.promptSent).toBe("the fitted 796-char version");
  });

  it("stores both durations, so a billing surprise is visible afterwards", async () => {
    await recordBenchmark({ ...BASE, durationRequested: 3, durationSent: 5 });
    const [row] = await benchmarksFor("runway");
    expect(row!.durationRequested).toBe(3);
    expect(row!.durationSent).toBe(5);
  });

  it("does not invent scores for a run nobody graded", async () => {
    await recordBenchmark(BASE);
    const [row] = await benchmarksFor("runway");
    expect(JSON.parse(row!.scoresJson)).toEqual({});
  });

  it("caps a runaway prompt rather than refusing the record", async () => {
    await recordBenchmark({ ...BASE, promptSent: "x".repeat(9000) });
    const [row] = await benchmarksFor("runway");
    expect(row!.promptSent.length).toBe(4000);
  });

  it("filters by model when asked, not just by provider", async () => {
    await recordBenchmark(BASE);
    await recordBenchmark({ ...BASE, model: "gen4.5:720x1280" });
    expect(await benchmarksFor("runway")).toHaveLength(2);
    expect(await benchmarksFor("runway", "gen4.5:720x1280")).toHaveLength(1);
  });
});

describe("the alarm: rules that disagree with a paid result", () => {
  it("is silent when the rules match the evidence", async () => {
    // gen4_turbo on a LOW one-character scene: succeeded, and allowed.
    await recordBenchmark(BASE);
    // gen4_turbo on MEDIUM: failed, and blocked. Agreement in both directions.
    await recordBenchmark({
      ...BASE,
      sceneNumber: 4,
      complexity: "MEDIUM",
      characterCount: 2,
      outcome: "failed",
      failureCode: "INTERNAL.BAD_OUTPUT.CODE01",
      actualCost: 0,
    });
    expect(await findContradictions()).toEqual([]);
  });

  it("shouts when the rules block work the model has actually done", async () => {
    // The gen4.5 case, as it would have been: a HIGH three-character scene that
    // succeeded twice. If someone ever gives gen4.5 gen4_turbo's LOW ceiling
    // again, this is what has to stop them.
    await recordBenchmark({
      ...BASE,
      model: "gen4_turbo:720x1280",
      sceneNumber: 3,
      complexity: "HIGH",
      characterCount: 3,
      outcome: "succeeded",
      actualCost: 0.72,
    });
    const [conflict, ...rest] = await findContradictions();
    expect(rest).toHaveLength(0);
    expect(conflict!.kind).toBe("blocked_but_succeeded");
    expect(conflict!.sceneNumber).toBe(3);
    // The money is in the message: a rule costing a capable model is easier to
    // argue about when the reader can see what the run was worth.
    expect(conflict!.message).toContain("0.7200");
  });

  it("shouts when the rules offer work the model has refused", async () => {
    // A LOW one-character scene that failed anyway. The rules allow it, so the
    // next render will pay to rediscover this.
    await recordBenchmark({
      ...BASE,
      outcome: "failed",
      failureCode: "INTERNAL.BAD_OUTPUT.CODE01",
      actualCost: 0,
    });
    const [conflict] = await findContradictions();
    expect(conflict!.kind).toBe("allowed_but_failed");
    expect(conflict!.message).toContain("INTERNAL.BAD_OUTPUT.CODE01");
  });

  it("does not count a scene's own failure marker against it", async () => {
    // Scene 4 carries RUNWAY_UNSUITABLE precisely BECAUSE it failed. Feeding
    // that flag back in would make every failed run look like it contradicts
    // itself, and the alarm would cry wolf on the very data it is protecting.
    await recordBenchmark({
      ...BASE,
      sceneNumber: 4,
      complexity: "MEDIUM",
      characterCount: 2,
      outcome: "failed",
      failureCode: "INTERNAL.BAD_OUTPUT.CODE01",
      actualCost: 0,
      notes: `scene carries ${RUNWAY_UNSUITABLE}`,
    });
    expect(await findContradictions()).toEqual([]);
  });

  it("reports every disagreement, not just the first", async () => {
    await recordBenchmark({
      ...BASE,
      sceneNumber: 3,
      complexity: "HIGH",
      characterCount: 3,
      outcome: "succeeded",
      actualCost: 0.72,
    });
    await recordBenchmark({
      ...BASE,
      sceneNumber: 7,
      outcome: "failed",
      actualCost: 0,
    });
    const kinds = (await findContradictions()).map((c) => c.kind).sort();
    expect(kinds).toEqual(["allowed_but_failed", "blocked_but_succeeded"]);
  });

  it("treats an unscored character count as one character, not zero", async () => {
    // A run recorded without a character count must not slip under a ceiling by
    // claiming the scene had nobody in it.
    await recordBenchmark({
      ...BASE,
      characterCount: 0,
      outcome: "failed",
      actualCost: 0,
    });
    expect(await findContradictions()).toHaveLength(1);
  });

  it("says nothing about a table with no runs in it", async () => {
    expect(await findContradictions()).toEqual([]);
  });
});

describe("reading the scores back", () => {
  it("averages only the criteria that were graded", () => {
    expect(averageScore({ camera: 7, composition: 9 })).toBe(8);
  });

  it("ignores a missing criterion instead of scoring it zero", () => {
    // Scene 5 was never graded for physics. Counting that as 0 would turn a
    // good clip into a bad one.
    expect(averageScore({ camera: 10, composition: 6, physics: undefined })).toBe(8);
  });

  it("returns zero for a run with no scores at all", () => {
    expect(averageScore({})).toBe(0);
  });

  it("averages identity across whoever was actually in the shot", () => {
    // Scene 5 had one character; scene 3 had three. Both are valid.
    expect(averageIdentity({ leoIdentity: 10 })).toBe(10);
    expect(
      averageIdentity({ maxIdentity: 9, leoIdentity: 9, miaIdentity: 10 }),
    ).toBe(9.3);
  });

  it("does not let a non-identity score leak into the identity average", () => {
    expect(averageIdentity({ maxIdentity: 6, camera: 10, composition: 10 })).toBe(6);
  });
});
