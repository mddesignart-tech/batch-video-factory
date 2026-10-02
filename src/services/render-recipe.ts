import fs from "node:fs";
import { createHash } from "node:crypto";
import type { RenderRequest } from "@/media/render";
import { fileSha256OrNull } from "./asset-content";

/**
 * The OUTPUT RECIPE of a final render (V1.2 Phase 5, QĐ-113): one hash over
 * everything the MP4 is made from - the ordered scene media BY CONTENT, scene
 * timing, every voice line by content, subtitles, music/effects, mix and render
 * settings - and nothing it is not made from (project id, title, file names).
 *
 * Equal recipe = SAME_RENDER_INPUT: rendering again would produce the same
 * video, so a COMPLETED video whose MP4 is still intact is not rendered again.
 * A changed subtitle, voice, picture or duration changes the recipe.
 *
 * Bump RENDER_RECIPE_VERSION whenever the renderer's own output changes for the
 * same inputs (a new filter chain, encoder settings, timing engine).
 */
export const RENDER_RECIPE_VERSION = "r1";

const content = (p: string | null | undefined): string | null =>
  p ? (fileSha256OrNull(p) ?? "missing") : null;

/** Canonical JSON: sorted keys, undefined dropped, so key order never changes the hash. */
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** The recipe as data - what the hash is taken over. Exposed for tests and the detail view. */
export function renderRecipeFields(req: Omit<RenderRequest, "projectId">): Record<string, unknown> {
  return {
    version: RENDER_RECIPE_VERSION,
    target: req.target,
    burnSubtitles: req.burnSubtitles,
    // Output preset encoder settings (Phase 6). Undefined for V1's defaults and
    // then dropped by canonical(), so an unchanged video keeps its recipe.
    encode: req.encode,
    // Output profile (QĐ-121): only when a person chose something other than
    // the defaults, so a video nobody touched keeps its recipe.
    fit: req.fit && req.fit !== "AUTO" ? req.fit : undefined,
    subtitleBottomPct: req.subtitleBottomPct ?? undefined,
    highlightPhrase: req.highlightPhrase ?? "",
    music: content(req.musicPath ?? null),
    sfx: (req.sfx ?? []).map((e) => ({ sha: content(e.path), atSec: e.atSec })),
    mix: req.mixSettings ?? {},
    timing: req.timingConfig ?? null,
    scenes: req.scenes.map((s) => ({
      n: s.sceneNumber,
      duration: s.duration,
      subtitle: s.subtitle,
      video: content(s.videoPath),
      image: content(s.imagePath),
      // The legacy single file only counts when there are no lines (that is
      // what the renderer does with it).
      audio: s.dialogueLines && s.dialogueLines.length > 0 ? null : content(s.audioPath),
      lines: (s.dialogueLines ?? []).map((l) => ({
        n: l.lineNumber,
        speaker: l.speaker,
        text: l.text,
        audio: content(l.audioPath),
        durationSec: l.durationSec,
        pauseAfterMs: l.pauseAfterMs ?? null,
      })),
      durationMode: s.durationMode ?? null,
      minDuration: s.minDuration ?? null,
      maxDuration: s.maxDuration ?? null,
      motionSource: s.motionSource ?? null,
      // Multi-speaker captions (QĐ-122); absent for a one-line scene, so an
      // unchanged single-speaker video keeps its recipe.
      spoken: s.spokenLines && s.spokenLines.length >= 2 ? s.spokenLines : undefined,
    })),
  };
}

export function renderRecipeHash(req: Omit<RenderRequest, "projectId">): string {
  const hash = createHash("sha256").update(canonical(renderRecipeFields(req))).digest("hex");
  return `recipe:${RENDER_RECIPE_VERSION}:${hash}`;
}

/** Content hashes of the media a render reads, for the final asset's dependency list. */
export function renderMediaHashes(req: Omit<RenderRequest, "projectId">): string[] {
  const out: string[] = [];
  for (const s of req.scenes) {
    for (const p of [s.imagePath, s.videoPath, ...(s.dialogueLines ?? []).map((l) => l.audioPath)]) {
      const h = p ? fileSha256OrNull(p) : null;
      if (h && !out.includes(h)) out.push(h);
    }
    if ((!s.dialogueLines || s.dialogueLines.length === 0) && s.audioPath) {
      const h = fileSha256OrNull(s.audioPath);
      if (h && !out.includes(h)) out.push(h);
    }
  }
  return out;
}

/**
 * May this COMPLETED video skip its render? Only when the recipe is the one it
 * was rendered from AND the MP4 is still exactly the file that render produced
 * (present, non-empty, same hash as recorded). Anything else renders again,
 * locally, at $0.
 */
export function sameRenderInput(opts: {
  status: string;
  storedRecipe: string | null;
  recipe: string;
  finalAbsolute: string | null;
  finalSha256: string | null;
}): boolean {
  if (opts.status !== "completed") return false;
  if (!opts.storedRecipe || opts.storedRecipe !== opts.recipe) return false;
  if (!opts.finalAbsolute || !fs.existsSync(opts.finalAbsolute)) return false;
  if (fs.statSync(opts.finalAbsolute).size === 0) return false;
  if (!opts.finalSha256) return false;
  return fileSha256OrNull(opts.finalAbsolute) === opts.finalSha256;
}
