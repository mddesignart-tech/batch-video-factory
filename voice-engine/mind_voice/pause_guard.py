"""Pause guard (QĐ-156): catch the long pause VieNeu sometimes invents.

VieNeu v3 Turbo samples its prosody (temperature 0.8). Measured on "Những lớp
vật liệu tạo thành một chiếc bát nhỏ ấm áp." - one chunk, no comma - 4 takes in
20 stopped 500-1000 ms between "bát nhỏ" and "ấm áp"; the others read it
through, or paused 300-470 ms where a speaker would (after the subject). Lower
temperatures did not remove it (0.4: 2 in 20, plus a 5.4 s take).

So a take is checked against what its own text allows - a comma or a full
stop may pause, the middle of a phrase may not for long - and a take that
pauses where nothing allows it is generated again. Never cut, stretched or
crossfaded: the take that is kept is audio the model made, unchanged.

Pure numpy: no engine, no file, unit-testable.
"""
from __future__ import annotations

import re

import numpy as np

WIN_S = 0.01
# Envelope mean|x| per 10 ms below this is silence. -40 dBFS: breaths and the
# quiet tail of a syllable stay "sound", so only true gaps are measured.
SILENCE_DB = -40.0
# Shorter runs are the stops inside syllables and words, not pauses.
MIN_PAUSE_S = 0.12
# Longest pause with nothing in the text to explain it. The natural phrase
# pause measured above reached 470 ms.
FREE_PAUSE_MS = 500
# Longest pause a punctuation mark inside the chunk can explain: the SDK's own
# sentence pause is 500-650 ms, a paragraph 700 ms.
PUNCT_PAUSE_MS = 900
# A take is generated at most this many times; the best one is kept.
MAX_TAKES = 3

_INNER_MARKS = re.compile(r"[,;:.!?…]+(?=\s*\S)")


def pauses(wav: np.ndarray, sr: int) -> list[tuple[float, float, int]]:
    """(start s, end s, ms) of every silent run >= MIN_PAUSE_S strictly inside the speech."""
    win = max(1, int(WIN_S * sr))
    n = wav.size // win
    if n == 0:
        return []
    env = np.abs(np.asarray(wav[: n * win], dtype=np.float32)).reshape(n, win).mean(1)
    loud = env > 10 ** (SILENCE_DB / 20)
    idx = np.flatnonzero(loud)
    if idx.size == 0:
        return []
    out: list[tuple[float, float, int]] = []
    start = None
    for i in range(int(idx[0]), int(idx[-1]) + 1):
        if not loud[i]:
            if start is None:
                start = i
        elif start is not None:
            if (i - start) * WIN_S >= MIN_PAUSE_S:
                out.append((round(start * WIN_S, 3), round(i * WIN_S, 3), int(round((i - start) * WIN_S * 1000))))
            start = None
    return out


def allowed_marks(text: str) -> int:
    """Punctuation inside the chunk (not its final mark): each may carry one longer pause."""
    return len(_INNER_MARKS.findall(text.strip()))


def excess_ms(pause_ms: list[int], marks: int) -> int:
    """How far the pauses go beyond what the text allows (0 = acceptable).

    The `marks` longest pauses are taken to be the punctuation's and may last
    PUNCT_PAUSE_MS; every other pause may last FREE_PAUSE_MS.
    """
    ordered = sorted(pause_ms, reverse=True)
    total = 0
    for i, ms in enumerate(ordered):
        limit = PUNCT_PAUSE_MS if i < marks else FREE_PAUSE_MS
        total += max(0, ms - limit)
    return total


def assess(wav: np.ndarray, sr: int, text: str) -> dict:
    p = pauses(wav, sr)
    marks = allowed_marks(text)
    return {
        "excessMs": excess_ms([ms for _, _, ms in p], marks),
        "marks": marks,
        "pauses": [{"start": s, "end": e, "ms": ms} for s, e, ms in p],
        "seconds": round(wav.size / sr, 3),
    }


def best_take(takes: list[tuple[np.ndarray, dict]]) -> int:
    """Index of the take to keep: least excess; then the first one made."""
    return min(range(len(takes)), key=lambda i: (takes[i][1]["excessMs"], i))
