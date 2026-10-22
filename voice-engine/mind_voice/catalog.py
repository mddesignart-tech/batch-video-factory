"""What Mind Voice can install: official sources only, pinned to a revision.

Every file is downloaded from the publisher's own Hugging Face repo at the
commit below and checked against the checksum the Hub publishes for it
(SHA-256 for LFS files, the git blob SHA-1 for small text files). Nothing is
bundled with Batch Video Factory - the person installs a model on purpose,
after seeing its size and licence.
"""

from __future__ import annotations

from dataclasses import dataclass, field

VIENEU_REPO = "pnnbao-ump/VieNeu-TTS-v3-Turbo"
VIENEU_REVISION = "61b85e3d937fbbacb387714180e8182823512523"
MOSS_CODEC_REPO = "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX"
MOSS_CODEC_REVISION = "ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae"
SUPERTONIC_REPO = "supertone-oss-archive/supertonic-3"
SUPERTONIC_REVISION = "aafc6e32416a594460b32413efc49d7fe4ce6d46"

_VIENEU_GRAPH = [
    "vieneu_prefill.onnx",
    "vieneu_decode_step.onnx",
    "vieneu_acoustic_cached.onnx",
    "vieneu_backbone_shared.data",
    "vieneu_v3_heads.npz",
    "config.json",
    "tokenizer.json",
]
# The encoder half of the codec is only used to clone a voice - not installed.
_MOSS_DECODE = [
    "moss_audio_tokenizer_decode_full.onnx",
    "moss_audio_tokenizer_decode_shared.data",
    "moss_audio_tokenizer_decode_step.onnx",
    "codec_browser_onnx_meta.json",
]
_SUPERTONIC_VOICES = [f"voice_styles/{g}{i}.json" for g in ("F", "M") for i in range(1, 6)]


@dataclass(frozen=True)
class Source:
    repo: str
    revision: str
    files: list[str]
    # Local sub-folder of the model folder these files land in.
    target: str = ""


@dataclass(frozen=True)
class Variant:
    id: str
    label: str
    sources: list[Source]
    note: str = ""


@dataclass(frozen=True)
class EngineSpec:
    id: str
    label: str
    languages: list[str]
    license: str
    license_url: str
    attribution: str
    sample_rate: int
    variants: list[Variant]
    default_variant: str
    # Inline cues the engine documents; anything else is read as text by it.
    tags: list[str] = field(default_factory=list)
    native_speed: bool = False
    notes: list[str] = field(default_factory=list)


ENGINES: dict[str, EngineSpec] = {
    "vieneu": EngineSpec(
        id="vieneu",
        label="VieNeu-TTS v3 Turbo",
        languages=["vi"],
        license="Apache-2.0",
        license_url=f"https://huggingface.co/{VIENEU_REPO}",
        attribution="VieNeu-TTS © Phạm Nguyễn Ngọc Bảo (Apache-2.0); MOSS Audio Tokenizer © OpenMOSS (Apache-2.0)",
        sample_rate=48_000,
        default_variant="fp32",
        tags=["[cười]", "[thở dài]", "[hắng giọng]"],
        native_speed=False,
        notes=["Tiếng Việt là chính; đọc được tiếng Anh xen trong câu tiếng Việt."],
        variants=[
            Variant(
                id="fp32",
                label="CPU - chất lượng cao (fp32)",
                note="Mặc định. Chạy trên mọi CPU.",
                sources=[
                    Source(VIENEU_REPO, VIENEU_REVISION, [f"onnx_update/{f}" for f in _VIENEU_GRAPH], "vieneu"),
                    Source(MOSS_CODEC_REPO, MOSS_CODEC_REVISION, _MOSS_DECODE, "codec"),
                ],
            ),
            Variant(
                id="int8",
                label="CPU - nhẹ, nhanh (int8)",
                note="Nhỏ hơn ~3 lần. VieNeu khuyên dùng trên CPU có VNNI; CPU cũ có thể méo tiếng.",
                sources=[
                    Source(VIENEU_REPO, VIENEU_REVISION, [f"onnx_int8/{f}" for f in _VIENEU_GRAPH], "vieneu"),
                    Source(MOSS_CODEC_REPO, MOSS_CODEC_REVISION, _MOSS_DECODE, "codec"),
                ],
            ),
        ],
    ),
    "supertonic": EngineSpec(
        id="supertonic",
        label="Supertonic 3",
        languages=["en"],
        license="OpenRAIL-M",
        license_url=f"https://huggingface.co/{SUPERTONIC_REPO}/blob/{SUPERTONIC_REVISION}/LICENSE",
        attribution="Supertonic 3 © Supertone Inc. (OpenRAIL-M - phải tuân thủ các giới hạn sử dụng trong LICENSE)",
        sample_rate=44_100,
        default_variant="cpu",
        tags=["<laugh>", "<breath>", "<sigh>"],
        native_speed=True,
        notes=[
            "MVP chỉ bật tiếng Anh; model hỗ trợ 31 ngôn ngữ.",
            "Repo chính thức đã lưu trữ (archived) từ 2026-09-09: không còn cập nhật.",
        ],
        variants=[
            Variant(
                id="cpu",
                label="CPU (ONNX)",
                sources=[
                    Source(
                        SUPERTONIC_REPO,
                        SUPERTONIC_REVISION,
                        [
                            "LICENSE",
                            "config.json",
                            "onnx/duration_predictor.onnx",
                            "onnx/text_encoder.onnx",
                            "onnx/tts.json",
                            "onnx/unicode_indexer.json",
                            "onnx/vector_estimator.onnx",
                            "onnx/vocoder.onnx",
                            *_SUPERTONIC_VOICES,
                        ],
                    )
                ],
            )
        ],
    ),
}


def variant_of(engine: str, variant: str | None) -> Variant:
    spec = ENGINES[engine]
    wanted = variant or spec.default_variant
    for v in spec.variants:
        if v.id == wanted:
            return v
    raise KeyError(f"Engine {engine} has no variant {wanted}")
