"""QĐ-156 A/B: the current engine vs the improved one, local VieNeu only, $0.

  A  text as prepareSpeechText made it BEFORE QĐ-156, one take per chunk -
     exactly what tts.infer(text) does (normalize_to_chunks_v3_with_gaps ->
     one take per chunk -> join_audio_chunks).
  B  text as prepareSpeechText makes it now, the pause guard on - the code
     Mind Voice runs (mind_voice.engines.guarded_chunks).

Every pause inside the speech is placed on the timeline and labelled:
boundary (between two chunks), natural (allowed by the text), abnormal.

    voice-engine\\.venv\\Scripts\\python.exe scripts\\qa\\qd156_ab.py data\\qa\\qd156\\cases.json data\\qa\\qd156\\ab
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "voice-engine"))

from mind_voice import pause_guard  # noqa: E402
from mind_voice.engines import VieNeuEngine, guarded_chunks  # noqa: E402
from vieneu_utils.core_utils import gaps_to_silence, pause_pad_samples  # noqa: E402

VOICES = {
    "Thục Đoan": None,  # every case
    "Thiện Minh": {"D1", "D2", "T3", "T4"},  # male: a representative subset
}
PEAKS = 480


def slug(s: str) -> str:
    table = str.maketrans("àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ", "aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd")
    return re.sub(r"[^a-z0-9]+", "-", s.lower().translate(table)).strip("-")


def join_with_offsets(kept: list[np.ndarray], gaps: list[str], sr: int) -> tuple[np.ndarray, list[tuple[float, float]]]:
    """join_audio_chunks(silence_ps=...) - same pads - plus where each chunk sits."""
    pauses_s = gaps_to_silence(gaps)
    parts, spans, pos = [], [], 0
    for i, w in enumerate(kept):
        if i > 0:
            pad = pause_pad_samples(kept[i - 1], w, sr, pauses_s[i - 1] if i - 1 < len(pauses_s) else 0.0)
            if pad > 0:
                parts.append(np.zeros(pad, dtype=np.float32))
                pos += pad
        parts.append(w)
        spans.append((pos / sr, (pos + w.size) / sr))
        pos += w.size
    return (np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)), spans


def label_pauses(wav: np.ndarray, sr: int, spans: list[tuple[float, float]], chunks: list[str]) -> list[dict]:
    out = []
    found = pause_guard.pauses(wav, sr)
    per_chunk: dict[int, list[int]] = {}
    for idx, (s, e, ms) in enumerate(found):
        mid = (s + e) / 2
        k = next((i for i, (a, b) in enumerate(spans) if a <= mid <= b), None)
        boundary = k is None or any(s <= spans[i][1] + 0.02 and e >= spans[i + 1][0] - 0.02 for i in range(len(spans) - 1))
        out.append({"start": s, "end": e, "ms": ms, "chunk": k, "kind": "boundary" if boundary else "inner"})
        if not boundary and k is not None:
            per_chunk.setdefault(k, []).append(idx)
    for k, idxs in per_chunk.items():
        marks = pause_guard.allowed_marks(chunks[k])
        ordered = sorted(idxs, key=lambda i: -out[i]["ms"])
        for rank, i in enumerate(ordered):
            limit = pause_guard.PUNCT_PAUSE_MS if rank < marks else pause_guard.FREE_PAUSE_MS
            out[i]["kind"] = "abnormal" if out[i]["ms"] > limit else "natural"
    return out


def peaks(wav: np.ndarray) -> list[float]:
    if wav.size == 0:
        return []
    n = PEAKS
    edges = np.linspace(0, wav.size, n + 1).astype(int)
    return [round(float(np.abs(wav[edges[i]:max(edges[i] + 1, edges[i + 1])]).max()), 3) for i in range(n)]


def main() -> None:
    cases = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    tts = VieNeuEngine()._load()
    sr = tts.sample_rate
    rows = []
    for case in cases:
        for voice, only in VOICES.items():
            if only is not None and case["id"] not in only:
                continue
            runs = case.get("runs", 1) if voice == "Thục Đoan" else min(3, case.get("runs", 1))
            for run in range(1, runs + 1):
                for variant, text, takes in (("A", case["textA"], 1), ("B", case["textB"], pause_guard.MAX_TAKES)):
                    t0 = time.time()
                    kept, gaps, info = guarded_chunks(tts, text, voice, max_takes=takes)
                    wav, spans = join_with_offsets(kept, gaps, sr)
                    name = f"{case['id']}_{slug(voice)}_{variant}_r{run}.wav"
                    sf.write(out / name, wav, sr, subtype="PCM_16")
                    labelled = label_pauses(wav, sr, spans, [c["text"] for c in info])
                    row = {
                        "id": case["id"], "group": case["group"], "title": case["title"], "voice": voice, "variant": variant, "run": run,
                        "file": name, "rawText": case["text"], "ttsText": text, "words": case["words"],
                        "seconds": round(wav.size / sr, 3), "genSeconds": round(time.time() - t0, 1),
                        "chunks": [{"text": c["text"], "takes": c["takes"], "kept": c["kept"], "rejected": c["rejected"], "start": round(a, 3), "end": round(b, 3)} for c, (a, b) in zip(info, spans)],
                        "gaps": gaps, "pauses": labelled, "peaks": peaks(wav),
                        "abnormal": [p for p in labelled if p["kind"] == "abnormal"],
                        "takes": sum(c["takes"] for c in info),
                    }
                    rows.append(row)
                    print(json.dumps({k: row[k] for k in ("id", "voice", "variant", "run", "seconds", "takes")} | {"chunks": len(info), "abnormalMs": [p["ms"] for p in row["abnormal"]]}, ensure_ascii=False), flush=True)
                    (out / "report.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
