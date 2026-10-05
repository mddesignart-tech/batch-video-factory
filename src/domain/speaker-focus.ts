/**
 * SPEAKER FOCUS (G4) - in a conversation the camera leans, very slightly,
 * towards whoever is talking, and keeps the two-shot. Pure.
 *
 * Rules:
 *  - one TURN = consecutive lines of the same speaker (never per sentence);
 *  - a turn shorter than `minTurnSec` does not move the camera (it keeps the
 *    previous lean) - no flicking for "Yes!" / "What?";
 *  - a fast exchange (median turn shorter than `fastSwitchSec`) keeps the
 *    plain two-shot: no lean at all;
 *  - the lean is a small horizontal bias (~1-1.5 % of the frame), eased over
 *    ~1.2 s by the renderer, on top of the scene's normal camera move.
 */

/** -1 = screen left, 0 = centre, 1 = screen right. */
export type ScreenSide = -1 | 0 | 1;

export interface BiasKey {
  /** Seconds from the start of the scene. */
  atSec: number;
  side: ScreenSide;
}

export interface SpokenLine {
  speaker: string;
  startSec: number;
  endSec: number;
}

export const SPEAKER_FOCUS = {
  minTurnSec: 1.2,
  fastSwitchSec: 1.5,
  /** Ease of one lean change, seconds (slow on purpose: a lean, not a pan). */
  easeSec: 1.2,
} as const;

/** Lean keyframes for one scene; [] = keep the two-shot (no lean). */
export function speakerBiasKeys(
  lines: SpokenLine[],
  sideOf: (speaker: string) => ScreenSide | null,
  opts: { minTurnSec?: number; fastSwitchSec?: number } = {},
): BiasKey[] {
  const minTurn = opts.minTurnSec ?? SPEAKER_FOCUS.minTurnSec;
  const fast = opts.fastSwitchSec ?? SPEAKER_FOCUS.fastSwitchSec;
  // Turns: same speaker back to back is one turn.
  const turns: { speaker: string; start: number; end: number }[] = [];
  for (const l of [...lines].sort((a, b) => a.startSec - b.startSec)) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === l.speaker) last.end = Math.max(last.end, l.endSec);
    else turns.push({ speaker: l.speaker, start: l.startSec, end: l.endSec });
  }
  const sides = new Set(turns.map((t) => sideOf(t.speaker)).filter((s): s is ScreenSide => s !== null && s !== 0));
  if (sides.size < 2) return []; // one side only (or unknown): nothing to lean between
  const lengths = turns.map((t) => t.end - t.start).sort((a, b) => a - b);
  if (lengths[Math.floor(lengths.length / 2)]! < fast) return []; // fast exchange: keep the two-shot
  const keys: BiasKey[] = [{ atSec: 0, side: 0 }];
  for (const t of turns) {
    if (t.end - t.start < minTurn) continue;
    const side = sideOf(t.speaker) ?? 0;
    if (keys[keys.length - 1]!.side === side) continue;
    // Lean slightly BEFORE the line starts, so the move lands as they speak.
    keys.push({ atSec: Math.max(0, Math.round((t.start - 0.4) * 1000) / 1000), side });
  }
  return keys.length > 1 ? keys : [];
}

/** Screen side from a slot / director side name. */
export function sideFromSlot(slot: string | undefined | null): ScreenSide | null {
  if (slot === "LEFT") return -1;
  if (slot === "RIGHT") return 1;
  if (slot === "CENTER") return 0;
  return null;
}
