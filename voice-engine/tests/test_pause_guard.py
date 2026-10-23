"""QĐ-156 pause guard - pure numpy, no model, no network.

    voice-engine\\.venv\\Scripts\\python.exe -m unittest discover -s voice-engine\\tests -t voice-engine
"""

import unittest

import numpy as np

from mind_voice import pause_guard as pg

SR = 48000


def speech(*parts: tuple[str, float]) -> np.ndarray:
    """("s", seconds) = tone at -12 dBFS, ("p", seconds) = digital silence."""
    out = []
    for kind, sec in parts:
        n = int(sec * SR)
        if kind == "s":
            t = np.arange(n) / SR
            out.append((0.25 * np.sin(2 * np.pi * 220 * t)).astype(np.float32))
        else:
            out.append(np.zeros(n, dtype=np.float32))
    return np.concatenate(out)


class PauseGuardTest(unittest.TestCase):
    def test_measures_only_pauses_inside_the_speech(self):
        wav = speech(("p", 0.3), ("s", 1.0), ("p", 0.88), ("s", 0.5), ("p", 0.4))
        p = pg.pauses(wav, SR)
        self.assertEqual(len(p), 1)
        self.assertAlmostEqual(p[0][0], 1.3, places=2)
        self.assertTrue(870 <= p[0][2] <= 890)

    def test_short_stops_inside_words_are_not_pauses(self):
        wav = speech(("s", 0.5), ("p", 0.08), ("s", 0.5))
        self.assertEqual(pg.pauses(wav, SR), [])

    def test_counts_punctuation_inside_the_chunk_not_the_final_mark(self):
        self.assertEqual(pg.allowed_marks("những lớp vật liệu tạo thành một chiếc bát nhỏ ấm áp."), 0)
        self.assertEqual(pg.allowed_marks("những lớp vật liệu tạo thành một chiếc bát nhỏ, ấm áp."), 1)
        self.assertEqual(pg.allowed_marks("chú chim tìm vật liệu. nó nhặt cành khô. rồi bay về."), 2)
        self.assertEqual(pg.allowed_marks("thật vậy sao?"), 0)

    def test_the_bat_nho_case(self):
        # 875 ms with no comma: rejected. The same pause after a comma: allowed.
        self.assertGreater(pg.excess_ms([875], 0), 0)
        self.assertEqual(pg.excess_ms([875], 1), 0)
        # A natural phrase pause (measured up to 470 ms) is never rejected.
        self.assertEqual(pg.excess_ms([470, 130, 120], 0), 0)
        # One comma explains one long pause, not two.
        self.assertGreater(pg.excess_ms([800, 800], 1), 0)

    def test_assess_and_best_take(self):
        text = "những lớp vật liệu tạo thành một chiếc bát nhỏ ấm áp."
        bad = speech(("s", 2.0), ("p", 0.9), ("s", 0.5))
        good = speech(("s", 1.0), ("p", 0.3), ("s", 1.4))
        worse = speech(("s", 2.0), ("p", 1.2), ("s", 0.5))
        takes = [(w, pg.assess(w, SR, text)) for w in (bad, good, worse)]
        self.assertGreater(takes[0][1]["excessMs"], 0)
        self.assertEqual(takes[1][1]["excessMs"], 0)
        self.assertEqual(pg.best_take(takes), 1)
        # All bad: the least bad, the first on a tie.
        self.assertEqual(pg.best_take([takes[2], takes[0]]), 1)
        self.assertEqual(pg.best_take([takes[0], takes[0]]), 0)

    def test_silence_and_empty_audio(self):
        self.assertEqual(pg.pauses(np.zeros(SR, dtype=np.float32), SR), [])
        self.assertEqual(pg.pauses(np.zeros(0, dtype=np.float32), SR), [])


if __name__ == "__main__":
    unittest.main()
