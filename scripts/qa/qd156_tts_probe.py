"""QĐ-156 TTS probe - local VieNeu only, $0, no network.

For each text and sampling setting, synthesise N takes with the SAME engine
Mind Voice uses, and report what the SDK did to the text (chunks, boundary
kinds) and every pause inside the speech (lead / tail excluded).

    voice-engine\\.venv\\Scripts\\python.exe scripts\\qa\\qd156_tts_probe.py --cases cases.json --out data\\qa\\qd156\\probe

cases.json: [{"id": "D1", "text": "...", "voice": "Thục Đoan", "runs": 4, "temperature": [0.8, 0.5]}]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "voice-engine"))

from mind_voice.engines import VieNeuEngine  # noqa: E402
from vieneu_utils.phonemize_text import normalize_to_chunks_v3_with_gaps  # noqa: E402

WIN_S = 0.01
SILENCE_DB = -40.0  # envelope mean|x| in 10 ms windows, dBFS
MIN_PAUSE_S = 0.12


def pauses(wav: np.ndarray, sr: int) -> list[dict]:
    """Silent runs >= MIN_PAUSE_S strictly inside the speech (not lead/tail)."""
    win = int(WIN_S * sr)
    n = wav.size // win
    env = np.abs(wav[: n * win]).reshape(n, win).mean(1)
    loud = env > 10 ** (SILENCE_DB / 20)
    idx = np.flatnonzero(loud)
    if idx.size == 0:
        return []
    first, last = idx[0], idx[-1]
    out, start = [], None
    for i in range(first, last + 1):
        if not loud[i] and start is None:
            start = i
        elif loud[i] and start is not None:
            if (i - start) * WIN_S >= MIN_PAUSE_S:
                out.append({"start": round(start * WIN_S, 3), "end": round(i * WIN_S, 3), "ms": int(round((i - start) * WIN_S * 1000))})
            start = None
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    cases = json.loads(Path(args.cases).read_text(encoding="utf-8"))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    engine = VieNeuEngine()
    tts = engine._load()
    report = []
    for case in cases:
        chunks, gaps = normalize_to_chunks_v3_with_gaps(case["text"], max_chars=256)
        for temp in case.get("temperature", [0.8]):
            for run in range(case.get("runs", 1)):
                t0 = time.time()
                wav = tts.infer(case["text"], voice=case.get("voice", "Thục Đoan"), temperature=temp)
                sr = tts.sample_rate
                name = f"{case['id']}_t{temp}_r{run + 1}.wav"
                sf.write(out / name, wav, sr, subtype="PCM_16")
                p = pauses(wav, sr)
                row = {
                    "id": case["id"], "temperature": temp, "run": run + 1, "file": name,
                    "seconds": round(wav.size / sr, 3), "genSeconds": round(time.time() - t0, 2),
                    "chunks": chunks, "gaps": gaps, "pauses": p,
                    "maxPauseMs": max([x["ms"] for x in p], default=0),
                }
                report.append(row)
                print(json.dumps({k: row[k] for k in ("id", "temperature", "run", "seconds", "maxPauseMs")}, ensure_ascii=False), flush=True)
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
