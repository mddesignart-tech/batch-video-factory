import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resultForScene } from "@/lib/scene-result";

/**
 * UI bug from the QĐ-141 real validation (2026-10-20): with scene 1 open, the
 * storyboard still showed "Cảnh 5 dùng ảnh nhập". The message line was one
 * untagged state for the whole storyboard.
 */
describe("storyboard message belongs to the scene it came from", () => {
  const scene5 = { sceneId: "s5", result: { ok: true, message: 'Cảnh 5 dùng ảnh nhập "hook.png"' } };

  it("shows the message on its own scene", () => {
    expect(resultForScene(scene5, "s5")?.message).toContain("Cảnh 5");
  });

  it("hides it after switching to another scene", () => {
    expect(resultForScene(scene5, "s1")).toBeNull();
  });

  it("shows it again when switching back, and nothing when there is no message", () => {
    expect(resultForScene(scene5, "s5")).toBe(scene5.result);
    expect(resultForScene(null, "s1")).toBeNull();
  });

  it("the storyboard renders only the current scene's message and remounts the image panel per scene", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/projects/[id]/storyboard.tsx"), "utf8");
    expect(src).toContain("resultForScene(sceneResult, selected.id)");
    expect(src).not.toMatch(/useState<ActionResult \| null>/);
    expect(src).toMatch(/<SceneImagePanel\s+key=\{`image-\$\{selected\.id\}`\}/);
  });
});
