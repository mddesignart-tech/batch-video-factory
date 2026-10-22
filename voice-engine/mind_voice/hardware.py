"""What this machine can run. Read once at start-up; nothing is installed."""

from __future__ import annotations

import ctypes
import os
import platform
import shutil
import subprocess


def _ram_gb() -> float | None:
    if os.name != "nt":
        return None

    class MemoryStatus(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    stat = MemoryStatus()
    stat.dwLength = ctypes.sizeof(MemoryStatus)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):  # type: ignore[attr-defined]
        return None
    return round(stat.ullTotalPhys / 1024**3, 1)


def _cpu_name() -> str:
    if os.name == "nt":
        try:
            import winreg

            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
                return str(winreg.QueryValueEx(k, "ProcessorNameString")[0]).strip()
        except OSError:
            pass
    return platform.processor() or platform.machine()


def _windows_name() -> str:
    if os.name != "nt":
        return f"{platform.system()} {platform.release()}"
    build = int(platform.version().split(".")[-1] or 0)
    # platform.release() says "10" on Windows 11; the build number tells them apart.
    return f"Windows {'11' if build >= 22000 else '10'} (build {build})"


def _nvidia_gpu() -> dict | None:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run(
            [exe, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    if not out:
        return None
    name, mem, driver = [x.strip() for x in out.splitlines()[0].split(",")[:3]]
    return {"name": name, "vram_mb": int(float(mem)), "driver": driver}


def _torch_cuda() -> bool:
    try:
        import torch  # type: ignore[import-not-found]

        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001 - torch absent = no CUDA path
        return False


def detect() -> dict:
    gpu = _nvidia_gpu()
    cuda = _torch_cuda()
    return {
        "os": _windows_name(),
        "cpu": _cpu_name(),
        "threads": os.cpu_count(),
        "ram_gb": _ram_gb(),
        "gpu": gpu,
        "cuda_ready": cuda,
        # The ONNX/CPU path is the only one installed by setup: it needs no GPU.
        "device": "cuda" if cuda else "cpu",
        "gpu_note": (
            None
            if gpu is None or cuda
            else "Có card NVIDIA nhưng chưa cài PyTorch CUDA (~3 GB) - Mind Voice chạy bằng CPU. Bản GPU để giai đoạn sau."
        ),
    }
