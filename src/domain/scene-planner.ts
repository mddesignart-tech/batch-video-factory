/**
 * SCENE PLANNER - how many scenes a video gets, and which beat each one is.
 *
 * The idiom writer always made 5-6 scenes. A 15-second ad and a 60-second
 * story cannot share that number, so the count is derived from the running time
 * and the audience (children get longer, calmer scenes), within the hard limits
 * of one generated scene (2-6 s). It is a heuristic, not a rule: the writer may
 * return a different count and the person can add or remove scenes.
 *
 *   15 s -> ~3-4 scenes     30 s -> ~5-7 scenes     60 s -> ~10-12 scenes
 *
 * Pure: no database, no provider.
 */

import { audienceOf } from "./content-options";
import type { BeatSpec, TemplateFormat } from "./content-templates";

export const PLAN_MIN_SCENE_SECONDS = 2;
export const PLAN_MAX_SCENE_SECONDS = 6;
export const PLAN_MAX_SCENES = 30;

export interface PlannedBeat extends BeatSpec {
  /** 1-based position in the video. */
  index: number;
  /** "Điểm nổi bật 2" for the second copy of a repeatable beat. */
  displayLabel: string;
  durationSeconds: number;
}

export function sceneCountFor(durationSeconds: number, audienceId?: string | null): number {
  const audience = audienceOf(audienceId);
  // Longer videos breathe a little more per scene.
  const avg = audience.avgSceneSeconds + (durationSeconds >= 45 ? 0.5 : 0);
  const floor = Math.max(3, Math.ceil(durationSeconds / PLAN_MAX_SCENE_SECONDS));
  const ceiling = Math.max(floor, Math.min(PLAN_MAX_SCENES, Math.floor(durationSeconds / PLAN_MIN_SCENE_SECONDS)));
  return Math.min(ceiling, Math.max(floor, Math.round(durationSeconds / avg)));
}

export function planScenes(input: {
  format: TemplateFormat;
  durationSeconds: number;
  audience?: string | null;
  /** Override the heuristic (the person asked for N scenes). */
  sceneCount?: number;
}): PlannedBeat[] {
  const count = Math.max(1, Math.min(PLAN_MAX_SCENES, input.sceneCount ?? sceneCountFor(input.durationSeconds, input.audience)));
  let beats: BeatSpec[] = [...input.format.beats];

  // Too many beats: drop optional ones from the end, then the lightest middle ones.
  while (beats.length > count) {
    const optionalAt = lastIndexWhere(beats, (b) => b.optional === true);
    if (optionalAt >= 0) {
      beats.splice(optionalAt, 1);
      continue;
    }
    if (beats.length <= 2) {
      beats = beats.slice(0, count);
      break;
    }
    let lightest = 1;
    for (let i = 1; i < beats.length - 1; i++) if (beats[i]!.weight < beats[lightest]!.weight) lightest = i;
    beats.splice(lightest, 1);
  }

  // Too few: repeat the repeatable beats in turn (feature 1, feature 2...).
  const repeatable = beats.filter((b) => b.repeatable);
  let turn = 0;
  while (beats.length < count) {
    const pick =
      repeatable.length > 0
        ? repeatable[turn++ % repeatable.length]!
        : heaviestMiddle(beats);
    const at = lastIndexWhere(beats, (b) => b.role === pick.role);
    beats.splice(at + 1, 0, pick);
  }

  // Durations by weight, clamped to what one scene can carry, in 0.5 s steps.
  const totalWeight = beats.reduce((sum, b) => sum + b.weight, 0) || 1;
  const seen = new Map<string, number>();
  const totalCopies = new Map<string, number>();
  for (const b of beats) totalCopies.set(b.role, (totalCopies.get(b.role) ?? 0) + 1);

  return beats.map((beat, i) => {
    const n = (seen.get(beat.role) ?? 0) + 1;
    seen.set(beat.role, n);
    const raw = (beat.weight / totalWeight) * input.durationSeconds;
    const durationSeconds = Math.min(PLAN_MAX_SCENE_SECONDS, Math.max(PLAN_MIN_SCENE_SECONDS, Math.round(raw * 2) / 2));
    return {
      ...beat,
      index: i + 1,
      displayLabel: (totalCopies.get(beat.role) ?? 1) > 1 ? `${beat.label} ${n}` : beat.label,
      durationSeconds,
    };
  });
}

function lastIndexWhere<T>(list: T[], test: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i]!)) return i;
  return -1;
}

function heaviestMiddle(beats: BeatSpec[]): BeatSpec {
  const middle = beats.length > 2 ? beats.slice(1, -1) : beats;
  return middle.reduce((best, b) => (b.weight > best.weight ? b : best), middle[0]!);
}
