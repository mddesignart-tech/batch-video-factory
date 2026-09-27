import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenderRequest } from "@/media/render";
import { fileSha256 } from "@/services/asset-content";
import { renderRecipeHash, sameRenderInput } from "@/services/render-recipe";
import { makePng, makeWav } from "./phase5-helpers";

/** V1.2 Phase 5 - the output recipe hash and SAME_RENDER_INPUT (QĐ-113). Pure: no DB, no render. */

let tmp = "";
let base: Omit<RenderRequest, "projectId">;
let otherVoice = "";

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p5-recipe-"));
  const image = await makePng(tmp, "red", "32x32");
  const voice = await makeWav(tmp, 440);
  otherVoice = await makeWav(tmp, 550);
  base = {
    target: { width: 1080, height: 1920, fps: 30 },
    burnSubtitles: true,
    highlightPhrase: "break a leg",
    mixSettings: {},
    scenes: [
      {
        sceneNumber: 1,
        duration: 3,
        subtitle: "Break a leg!",
        videoPath: null,
        audioPath: null,
        imagePath: image,
        dialogueLines: [{ lineNumber: 1, speaker: "Max", text: "Break a leg!", audioPath: voice, durationSec: 1, pauseAfterMs: null }],
        motionSource: "LOCAL_MOTION",
      },
    ],
  };
}, 60_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const withScene = (patch: Partial<RenderRequest["scenes"][number]>) => ({ ...base, scenes: [{ ...base.scenes[0]!, ...patch }] });

describe("QĐ-113 — output recipe hash", () => {
  it("cùng media + nhịp + âm thanh + phụ đề + cài đặt → cùng recipe; file cùng nội dung khác tên cũng vậy", () => {
    const r = renderRecipeHash(base);
    expect(r).toMatch(/^recipe:r1:[0-9a-f]{64}$/);
    expect(renderRecipeHash({ ...base })).toBe(r);
    const renamed = path.join(tmp, "renamed-image.png");
    fs.copyFileSync(base.scenes[0]!.imagePath!, renamed);
    expect(renderRecipeHash(withScene({ imagePath: renamed }))).toBe(r);
  });

  it("đổi phụ đề / giọng / độ dài / cài đặt render → recipe đổi", () => {
    const r = renderRecipeHash(base);
    expect(renderRecipeHash(withScene({ subtitle: "Break a leg?" }))).not.toBe(r);
    const line = base.scenes[0]!.dialogueLines![0]!;
    expect(renderRecipeHash(withScene({ dialogueLines: [{ ...line, audioPath: otherVoice }] }))).not.toBe(r);
    expect(renderRecipeHash(withScene({ duration: 4 }))).not.toBe(r);
    expect(renderRecipeHash({ ...base, burnSubtitles: false })).not.toBe(r);
    expect(renderRecipeHash({ ...base, target: { width: 1080, height: 1080, fps: 30 } })).not.toBe(r);
  });

  it("chỉ đổi tên hiển thị / projectId → recipe giữ nguyên (không nằm trong recipe)", () => {
    const r = renderRecipeHash(base);
    const withId = { ...base, projectId: "some-other-project" } as RenderRequest;
    expect(renderRecipeHash(withId)).toBe(r);
  });

  it("SAME_RENDER_INPUT chỉ khi COMPLETED + recipe khớp + MP4 còn nguyên đúng hash", () => {
    const mp4 = path.join(tmp, "final.mp4");
    fs.writeFileSync(mp4, Buffer.from("pretend mp4 bytes"));
    const sha = fileSha256(mp4);
    const recipe = renderRecipeHash(base);
    const ok = { status: "completed", storedRecipe: recipe, recipe, finalAbsolute: mp4, finalSha256: sha };
    expect(sameRenderInput(ok)).toBe(true);
    expect(sameRenderInput({ ...ok, status: "rendering" })).toBe(false);
    expect(sameRenderInput({ ...ok, storedRecipe: null })).toBe(false);
    expect(sameRenderInput({ ...ok, recipe: renderRecipeHash(withScene({ subtitle: "x" })) })).toBe(false);
    expect(sameRenderInput({ ...ok, finalSha256: null })).toBe(false);
    fs.appendFileSync(mp4, "!");
    expect(sameRenderInput(ok)).toBe(false); // altered
    fs.rmSync(mp4);
    expect(sameRenderInput(ok)).toBe(false); // missing -> render again, local, $0
  });
});
