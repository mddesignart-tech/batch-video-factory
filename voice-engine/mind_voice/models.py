"""Model Manager: install, check and describe the local TTS models.

A model is INSTALLED when its folder holds a manifest.json written after every
file was downloaded from the pinned official revision and matched the Hub's
checksum. Installing happens only when asked (POST /models/install) - the
service never downloads anything on its own.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

from .catalog import ENGINES, Source, Variant, variant_of

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = Path(os.environ.get("MIND_VOICE_MODELS_DIR") or ROOT / "models")
MANIFEST = "manifest.json"


def model_dir(engine: str, variant: str) -> Path:
    return MODELS_DIR / engine / variant


def _dir_size(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file()) if path.exists() else 0


def read_manifest(engine: str, variant: str) -> dict | None:
    path = model_dir(engine, variant) / MANIFEST
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def is_installed(engine: str, variant: str) -> bool:
    """Manifest present and every file in it on disk at its recorded size (no re-hash)."""
    manifest = read_manifest(engine, variant)
    if not manifest:
        return False
    base = model_dir(engine, variant)
    for rel, info in manifest.get("files", {}).items():
        p = base / rel
        if not p.is_file() or p.stat().st_size != info["size"]:
            return False
    return True


def installed_variant(engine: str) -> str | None:
    """The variant a request uses: the default one when present, else any installed one."""
    spec = ENGINES[engine]
    order = [spec.default_variant] + [v.id for v in spec.variants if v.id != spec.default_variant]
    return next((v for v in order if is_installed(engine, v)), None)


# ----------------------------------------------------------------- checksums ---


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _git_blob_sha1(path: Path) -> str:
    data = path.read_bytes()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def _matches(path: Path, info: dict) -> bool:
    if path.stat().st_size != info["size"]:
        return False
    if info.get("sha256"):
        return _sha256(path) == info["sha256"]
    return _git_blob_sha1(path) == info["git_sha1"]


@dataclass
class RemoteFile:
    source: Source
    path: str  # path inside the repo
    local: str  # path inside the model folder
    size: int
    sha256: str | None
    git_sha1: str


def remote_files(variant: Variant) -> list[RemoteFile]:
    """Sizes and checksums the Hub publishes for the pinned files (metadata only)."""
    from huggingface_hub import HfApi

    api = HfApi()
    out: list[RemoteFile] = []
    for src in variant.sources:
        infos = {i.path: i for i in api.get_paths_info(src.repo, src.files, revision=src.revision)}
        for f in src.files:
            info = infos.get(f)
            if info is None:
                raise RuntimeError(f"{src.repo}@{src.revision[:8]} không có tệp {f}")
            lfs = getattr(info, "lfs", None)
            local = f"{src.target}/{Path(f).name}" if src.target else f
            out.append(RemoteFile(src, f, local, int(info.size), lfs.sha256 if lfs else None, info.blob_id))
    return out


# ------------------------------------------------------------------- install ---


@dataclass
class InstallJob:
    engine: str
    variant: str
    state: str = "running"  # running | done | failed
    total_bytes: int = 0
    done_bytes: int = 0
    current: str = ""
    error: str | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None

    def view(self) -> dict:
        return asdict(self)


_jobs: dict[str, InstallJob] = {}
_jobs_lock = threading.Lock()


def install_job(engine: str) -> InstallJob | None:
    return _jobs.get(engine)


def _download(rf: RemoteFile, staging: Path) -> Path:
    from huggingface_hub import hf_hub_download

    tmp = staging / ".dl"
    got = Path(hf_hub_download(rf.source.repo, rf.path, revision=rf.source.revision, local_dir=str(tmp)))
    dest = staging / rf.local
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(got), dest)
    return dest


def install(engine: str, variant_id: str | None, on_progress: Callable[[InstallJob], None] | None = None) -> InstallJob:
    """Download, verify, then move into place. A failure leaves no half-installed model."""
    variant = variant_of(engine, variant_id)
    job = InstallJob(engine, variant.id)
    with _jobs_lock:
        running = _jobs.get(engine)
        if running and running.state == "running":
            raise RuntimeError("Đang cài model này.")
        _jobs[engine] = job

    staging = MODELS_DIR / ".staging" / f"{engine}-{variant.id}"
    try:
        files = remote_files(variant)
        job.total_bytes = sum(f.size for f in files)
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        manifest_files: dict[str, dict] = {}
        for rf in files:
            job.current = rf.path
            if on_progress:
                on_progress(job)
            dest = _download(rf, staging)
            info = {"size": rf.size, "sha256": rf.sha256, "git_sha1": rf.git_sha1, "repo": rf.source.repo, "path": rf.path}
            if not _matches(dest, info):
                raise RuntimeError(f"Sai checksum: {rf.path} - tệp tải về không khớp với nguồn chính thức.")
            manifest_files[rf.local] = info
            job.done_bytes += rf.size
        shutil.rmtree(staging / ".dl", ignore_errors=True)
        spec = ENGINES[engine]
        manifest = {
            "engine": engine,
            "variant": variant.id,
            "label": spec.label,
            "license": spec.license,
            "license_url": spec.license_url,
            "attribution": spec.attribution,
            "sources": [{"repo": s.repo, "revision": s.revision} for s in variant.sources],
            "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "files": manifest_files,
        }
        (staging / MANIFEST).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        final = model_dir(engine, variant.id)
        shutil.rmtree(final, ignore_errors=True)
        final.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staging), final)
        job.state = "done"
    except Exception as err:  # noqa: BLE001 - reported to the person as is
        job.state = "failed"
        job.error = str(err)
        shutil.rmtree(staging, ignore_errors=True)
    finally:
        job.current = ""
        job.finished_at = time.time()
        if on_progress:
            on_progress(job)
    return job


def verify(engine: str, variant_id: str) -> dict:
    """Re-hash every installed file against the manifest."""
    manifest = read_manifest(engine, variant_id)
    if not manifest:
        return {"ok": False, "bad": [], "message": "Model chưa cài."}
    base = model_dir(engine, variant_id)
    bad = [rel for rel, info in manifest["files"].items() if not (base / rel).is_file() or not _matches(base / rel, info)]
    return {"ok": not bad, "bad": bad, "message": "Checksum khớp nguồn chính thức." if not bad else f"{len(bad)} tệp hỏng hoặc thiếu."}


def remove(engine: str, variant_id: str) -> None:
    shutil.rmtree(model_dir(engine, variant_id), ignore_errors=True)


# -------------------------------------------------------------------- status ---


_size_cache: dict[str, int] = {}


def download_size(engine: str, variant: Variant, *, remote: bool) -> int | None:
    key = f"{engine}/{variant.id}"
    if key not in _size_cache and remote:
        try:
            _size_cache[key] = sum(f.size for f in remote_files(variant))
        except Exception:  # noqa: BLE001 - offline: size unknown
            return None
    return _size_cache.get(key)


def engine_status(engine: str, *, remote: bool = False) -> dict:
    spec = ENGINES[engine]
    variants = []
    for v in spec.variants:
        installed = is_installed(engine, v.id)
        manifest = read_manifest(engine, v.id) if installed else None
        variants.append(
            {
                "id": v.id,
                "label": v.label,
                "note": v.note,
                "installed": installed,
                "disk_bytes": _dir_size(model_dir(engine, v.id)) if installed else 0,
                "download_bytes": download_size(engine, v, remote=remote),
                "installed_at": manifest.get("installed_at") if manifest else None,
                "sources": [{"repo": s.repo, "revision": s.revision} for s in v.sources],
            }
        )
    job = install_job(engine)
    return {
        "id": spec.id,
        "label": spec.label,
        "languages": spec.languages,
        "license": spec.license,
        "license_url": spec.license_url,
        "attribution": spec.attribution,
        "sample_rate": spec.sample_rate,
        "tags": spec.tags,
        "native_speed": spec.native_speed,
        "notes": spec.notes,
        "installed": any(v["installed"] for v in variants),
        "active_variant": installed_variant(engine),
        "variants": variants,
        "install_job": job.view() if job else None,
    }
