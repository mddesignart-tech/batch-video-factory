"""The two local engines behind Mind Voice, each loaded on first use.

Both read ONLY the files the Model Manager installed and verified. Neither may
download anything: VieNeu's ONNX loader would otherwise fetch the audio codec
into the Hugging Face cache, so its fetch is pointed at our folder below.
"""

from __future__ import annotations

import contextlib
import io
import json
import threading
from importlib import resources
from pathlib import Path

import numpy as np
import soundfile as sf

from .catalog import ENGINES, MOSS_CODEC_REPO
from . import pause_guard
from .models import installed_variant, model_dir


class ModelMissing(RuntimeError):
    """The engine's model is not installed (HTTP 409)."""


class VoiceNotFound(ValueError):
    """The voice id is not one the engine has (HTTP 400)."""


def wav_bytes(wav: np.ndarray, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, np.asarray(wav, dtype=np.float32).reshape(-1), sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


# ------------------------------------------------------------------ VieNeu ---

_REGION = {"bắc": "north", "trung": "central", "nam": "south"}
_STYLE = {"tu_nhien": "natural", "doc_truyen": "storytelling", "tin_tuc": "news"}


def vieneu_voices() -> list[dict]:
    """The preset voices the installed VieNeu SDK ships (its own voices file)."""
    raw = json.loads(resources.files("vieneu").joinpath("assets/voices_v3_turbo.json").read_text(encoding="utf-8"))
    out = []
    for name, v in raw.get("presets", {}).items():
        region = str(v.get("region") or "").strip().lower()
        out.append(
            {
                "id": name,
                "name": name,
                "engine": "vieneu",
                "languages": ["vi"],
                "gender": v.get("gender") or None,
                # Only what the SDK states; no region is guessed from a name.
                "region": _REGION.get(region),
                "style": _STYLE.get(v.get("style") or "", v.get("style") or None),
                "description": v.get("description") or "",
                "featured": v.get("featured"),
                "aliases": list(v.get("aliases") or []),
                "default": name == raw.get("default_voice"),
            }
        )
    return sorted(out, key=lambda x: (x["featured"] is None, x["featured"] or 0))


_KEPT_ENDINGS = ("?", "!")


def _keeping_ending(fn):
    """`fn` (a punctuation-normalizing call), except that a final ? or ! it turned into "." comes back."""

    def wrapped(text, *args, **kwargs):
        out = fn(text, *args, **kwargs)
        mark = str(text).rstrip()[-1:]
        if mark in _KEPT_ENDINGS and isinstance(out, str) and out.rstrip().endswith("."):
            out = out.rstrip()[:-1] + mark
        return out

    return wrapped


@contextlib.contextmanager
def _keep_short_line_endings():
    """
    QĐ-147. The VieNeu SDK ends every chunk under 5 words with "." (sea-g2p
    punc_norm), so "Bạn ăn sáng chưa?" is read as a statement. Asked for by the
    app (dialogue lines, `keep_punct`), the line's own ? or ! is kept instead.
    Only the final mark of a chunk changes; no word, no cue, nothing added.
    Callers hold the engine lock, so the patch never leaks to another request.
    """
    from vieneu_utils import phonemize_text as pt

    saved = (pt.punc_norm, pt._phonemize_cached)
    cached = pt._phonemize_cached
    keep = _keeping_ending(saved[0])

    def phonemize(text, punc_norm=True):
        return keep(cached(text, False)) if punc_norm else cached(text, False)

    pt.punc_norm, pt._phonemize_cached = keep, phonemize
    try:
        yield
    finally:
        pt.punc_norm, pt._phonemize_cached = saved


class VieNeuEngine:
    id = "vieneu"

    def __init__(self) -> None:
        self._tts = None
        self._variant: str | None = None
        self._lock = threading.Lock()

    @property
    def loaded_variant(self) -> str | None:
        return self._variant

    def _load(self):
        variant = installed_variant(self.id)
        if variant is None:
            raise ModelMissing("Chưa cài model VieNeu-TTS v3 Turbo. Mở Mind Voice Studio → Quản lý model để cài.")
        if self._tts is not None and self._variant == variant:
            return self._tts
        base = model_dir(self.id, variant)
        codec = base / "codec"
        from vieneu import Vieneu
        from vieneu._v3_turbo_engine import onnx_runtime_lite as lite

        original = lite.OnnxV3LiteEngine._fetch

        def local_only(repo, files, subfolder):  # never the network, never the HF cache
            if repo == MOSS_CODEC_REPO:
                return codec
            raise ModelMissing(f"VieNeu yêu cầu tệp ngoài bộ model đã cài: {repo}")

        lite.OnnxV3LiteEngine._fetch = staticmethod(local_only)
        try:
            self._tts = Vieneu(
                mode="v3turbo",
                backend="onnx",
                precision=variant,
                backbone_repo=str(base / "vieneu"),
                onnx_dir=str(base / "vieneu"),
            )
        finally:
            lite.OnnxV3LiteEngine._fetch = original
        self._variant = variant
        return self._tts

    def voices(self) -> list[dict]:
        return vieneu_voices()

    def synthesize(self, text: str, voice: str, language: str, speed: float, keep_punct: bool = False) -> tuple[bytes, float, int, dict]:
        with self._lock:
            tts = self._load()
            if tts.resolve_voice_name(voice) is None:
                raise VoiceNotFound(f"VieNeu không có giọng \"{voice}\".")
            # No native speed on v3 Turbo: the caller time-stretches when needed.
            with _keep_short_line_endings() if keep_punct else contextlib.nullcontext():
                wav, report = self._guarded(tts, text, voice)
            sr = tts.sample_rate
        return wav_bytes(wav, sr), len(wav) / sr, sr, report

    @staticmethod
    def _guarded(tts, text: str, voice: str) -> tuple[np.ndarray, dict]:
        """QĐ-156: the SDK's own chunks, each checked by the pause guard."""
        from vieneu_utils.core_utils import gaps_to_silence, join_audio_chunks

        kept, gaps, per_chunk = guarded_chunks(tts, text, voice)
        if not kept:
            return np.array([], dtype=np.float32), {"chunks": [], "gaps": [], "takes": 0}
        wav = join_audio_chunks(kept, tts.sample_rate, silence_ps=gaps_to_silence(gaps))
        return wav, {"chunks": per_chunk, "gaps": gaps, "takes": sum(c["takes"] for c in per_chunk)}


def guarded_chunks(tts, text: str, voice: str, max_takes: int = pause_guard.MAX_TAKES) -> tuple[list[np.ndarray], list[str], list[dict]]:
    """Each chunk's kept take, the boundary kinds, and what the guard saw.

    Same split, boundary pauses and join as ``tts.infer(text)`` - which is
    normalize_to_chunks_v3_with_gaps -> one take per chunk -> join_audio_chunks
    - except that a chunk whose take pauses where its text allows no pause is
    generated again, up to ``max_takes``, and the best take is kept. Nothing is
    cut, stretched or crossfaded. ``max_takes=1`` is the SDK's behaviour.
    """
    from vieneu_utils.phonemize_text import normalize_to_chunks_v3_with_gaps

    chunks, gaps = normalize_to_chunks_v3_with_gaps(text, max_chars=256)
    sr = tts.sample_rate
    kept: list[np.ndarray] = []
    per_chunk: list[dict] = []
    for chunk in chunks:
        takes = []
        for _ in range(max(1, max_takes)):
            take = np.asarray(tts.infer(chunk, voice=voice), dtype=np.float32).reshape(-1)
            takes.append((take, pause_guard.assess(take, sr, chunk)))
            if takes[-1][1]["excessMs"] == 0:
                break
        best = pause_guard.best_take(takes)
        kept.append(takes[best][0])
        per_chunk.append({
            "text": chunk,
            "takes": len(takes),
            "kept": best + 1,
            **takes[best][1],
            "rejected": [t[1]["excessMs"] for i, t in enumerate(takes) if i != best],
        })
    return kept, gaps, per_chunk


# -------------------------------------------------------------- Supertonic ---


class SupertonicEngine:
    id = "supertonic"

    def __init__(self) -> None:
        self._tts = None
        self._lock = threading.Lock()

    @property
    def loaded_variant(self) -> str | None:
        return "cpu" if self._tts is not None else None

    def _dir(self) -> Path | None:
        variant = installed_variant(self.id)
        return model_dir(self.id, variant) if variant else None

    def _load(self):
        if self._tts is not None:
            return self._tts
        base = self._dir()
        if base is None:
            raise ModelMissing("Chưa cài model Supertonic 3. Mở Mind Voice Studio → Quản lý model để cài.")
        from supertonic import TTS

        self._tts = TTS(model="supertonic-3", model_dir=base, auto_download=False)
        return self._tts

    def voices(self) -> list[dict]:
        base = self._dir()
        if base is None:
            return []
        out = []
        for p in sorted((base / "voice_styles").glob("*.json")):
            # Supertonic's documented naming: M1..M5 male, F1..F5 female.
            gender = {"M": "male", "F": "female"}.get(p.stem[:1])
            out.append(
                {
                    "id": p.stem,
                    "name": p.stem,
                    "engine": "supertonic",
                    "languages": ["en"],
                    "gender": gender,
                    "region": None,
                    "style": None,
                    "description": f"Supertonic 3 · {'Nam' if gender == 'male' else 'Nữ' if gender == 'female' else ''} · {p.stem}",
                    "featured": None,
                    "aliases": [],
                    "default": p.stem == "M1",
                }
            )
        return out

    def synthesize(self, text: str, voice: str, language: str, speed: float, keep_punct: bool = False) -> tuple[bytes, float, int, dict]:
        # keep_punct: Supertonic reads the text as given - its ? and ! are never rewritten.
        with self._lock:
            tts = self._load()
            if voice not in tts.voice_style_names:
                raise VoiceNotFound(f"Supertonic không có giọng \"{voice}\".")
            style = tts.get_voice_style(voice)
            wav, _ = tts.synthesize(text, voice_style=style, speed=float(speed), lang=language or "en")
            sr = int(tts.sample_rate)
        samples = np.asarray(wav).reshape(-1)
        return wav_bytes(samples, sr), len(samples) / sr, sr, {}


ENGINE_IMPLS = {"vieneu": VieNeuEngine(), "supertonic": SupertonicEngine()}
assert set(ENGINE_IMPLS) == set(ENGINES)
