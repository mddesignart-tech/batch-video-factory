"""QĐ-151 motion probe - measures how a video's camera ACTUALLY moves, frame by frame.

For every pair of consecutive frames it estimates the global zoom rate and the
translation (phase correlation on a 3x3 grid of patches, least-squares fit of
d = a*(p - centre) + t). From that path it reports:

  - timestamps: frame count, constant frame rate or not, pts gaps;
  - duplicate frames (an exact repeat = a visible stall);
  - edge speed per frame (px/frame at the frame edge, output pixels);
  - jitter: how far each frame's motion departs from a smooth path
    (residual against a centred moving average), RMS and worst frame;
  - direction reversals of the motion (a camera that wobbles back and forth).

Pure numpy + the FFmpeg binary; nothing is installed. Run with python -I:

  python -I scripts/qa/qd151/motion_probe.py <ffmpeg.exe> <ffprobe.exe> <video> [label] [json_out]
"""

import json
import subprocess
import sys

import numpy as np

SCALE = 2  # analyse at half resolution; results are reported in output pixels
PATCH = 160


def probe_timestamps(ffprobe, video):
    out = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", video],
        capture_output=True, text=True, check=True,
    ).stdout
    pts = np.array([float(x.split(",")[0]) for x in out.split() if x.strip() and x.split(",")[0] not in ("", "N/A")])
    d = np.diff(pts)
    info = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,codec_name,pix_fmt", "-of", "json", video],
        capture_output=True, text=True, check=True,
    ).stdout
    s = json.loads(info)["streams"][0]
    return pts, d, s


def frames(ffmpeg, video, w, h):
    p = subprocess.Popen(
        [ffmpeg, "-v", "error", "-i", video, "-vf", f"scale={w}:{h}:flags=area,format=gray", "-f", "rawvideo", "-"],
        stdout=subprocess.PIPE,
    )
    n = w * h
    while True:
        buf = p.stdout.read(n)
        if len(buf) < n:
            break
        yield np.frombuffer(buf, np.uint8).reshape(h, w).astype(np.float32)
    p.wait()


_hann = None


def phase_shift(a, b):
    """Sub-pixel shift of b relative to a (dx, dy) and the peak strength."""
    global _hann
    if _hann is None or _hann.shape != a.shape:
        _hann = np.outer(np.hanning(a.shape[0]), np.hanning(a.shape[1])).astype(np.float32)
    A = np.fft.fft2((a - a.mean()) * _hann)
    B = np.fft.fft2((b - b.mean()) * _hann)
    R = A.conj() * B
    R /= np.abs(R) + 1e-9
    r = np.fft.ifft2(R).real
    iy, ix = np.unravel_index(np.argmax(r), r.shape)
    peak = r[iy, ix]

    def sub(c, axis_len, get):
        l, m, rr = get((c - 1) % axis_len), get(c), get((c + 1) % axis_len)
        den = l - 2 * m + rr
        off = 0.5 * (l - rr) / den if abs(den) > 1e-12 else 0.0
        v = c + off
        return v - axis_len if v > axis_len / 2 else v

    dx = sub(ix, r.shape[1], lambda k: r[iy, k])
    dy = sub(iy, r.shape[0], lambda k: r[k, ix])
    return dx, dy, peak


def estimate(prev, cur):
    h, w = prev.shape
    xs = [int(w * f) for f in (0.22, 0.5, 0.78)]
    ys = [int(h * f) for f in (0.22, 0.5, 0.78)]
    cx, cy = w / 2, h / 2
    rows, rhs_x, rhs_y, wts = [], [], [], []
    for y in ys:
        for x in xs:
            y0, x0 = max(0, y - PATCH // 2), max(0, x - PATCH // 2)
            a = prev[y0 : y0 + PATCH, x0 : x0 + PATCH]
            b = cur[y0 : y0 + PATCH, x0 : x0 + PATCH]
            if a.shape != (PATCH, PATCH) or a.std() < 2:
                continue
            dx, dy, pk = phase_shift(a, b)
            if pk < 0.03:
                continue
            rows.append((x - cx, y - cy))
            rhs_x.append(dx)
            rhs_y.append(dy)
            wts.append(pk)
    if len(rows) < 4:
        return None
    P = np.array(rows)
    W = np.array(wts)
    # dx = a*(x-cx) + tx ; dy = a*(y-cy) + ty  (shared zoom rate a)
    M = np.zeros((2 * len(rows), 3))
    M[: len(rows), 0] = P[:, 0]
    M[: len(rows), 1] = 1
    M[len(rows) :, 0] = P[:, 1]
    M[len(rows) :, 2] = 1
    v = np.concatenate([rhs_x, rhs_y])
    ww = np.sqrt(np.concatenate([W, W]))
    sol, *_ = np.linalg.lstsq(M * ww[:, None], v * ww, rcond=None)
    return sol  # a, tx, ty in analysis pixels


def main():
    ffmpeg, ffprobe, video = sys.argv[1:4]
    label = sys.argv[4] if len(sys.argv) > 4 else video
    out_json = sys.argv[5] if len(sys.argv) > 5 else None
    pts, d, s = probe_timestamps(ffprobe, video)
    W, H = int(s["width"]), int(s["height"])
    w, h = W // SCALE, H // SCALE
    path, dups, diffs = [], 0, []
    prev = None
    for f in frames(ffmpeg, video, w, h):
        if prev is not None:
            mad = float(np.abs(f - prev).mean())
            diffs.append(mad)
            if mad < 0.05:
                dups += 1
            est = estimate(prev, f)
            path.append(est if est is not None else (np.nan, np.nan, np.nan))
        prev = f
    path = np.array(path, dtype=float)
    a, tx, ty = path[:, 0], path[:, 1] * SCALE, path[:, 2] * SCALE
    # Speed of a point at the frame edge (output px / frame): zoom term + translation.
    edge = np.abs(a) * (W / 2) + np.hypot(tx, ty)
    ok = np.isfinite(edge)
    k = 9
    smooth = np.convolve(np.nan_to_num(edge), np.ones(k) / k, mode="same")
    resid = (edge - smooth)[k : len(edge) - k]
    resid = resid[np.isfinite(resid)]
    sign_flips = 0
    for series in (a, tx, ty):
        sgn = np.sign(series[np.isfinite(series) & (np.abs(series) > 1e-4)])
        sign_flips += int(np.sum(sgn[1:] != sgn[:-1]))
    fr = s.get("r_frame_rate", "0/1").split("/")
    fps = float(fr[0]) / float(fr[1]) if float(fr[1]) else 0
    res = {
        "label": label,
        "video": video,
        "size": f"{W}x{H}",
        "codec": s.get("codec_name"),
        "pix_fmt": s.get("pix_fmt"),
        "r_frame_rate": s.get("r_frame_rate"),
        "avg_frame_rate": s.get("avg_frame_rate"),
        "frames": int(len(pts)),
        "duration_s": round(float(pts[-1] - pts[0] + (1 / fps if fps else 0)), 3),
        "cfr": bool(np.allclose(d, d.mean(), atol=1e-4)) if len(d) else None,
        "pts_step_ms": [round(float(d.min()) * 1000, 3), round(float(d.max()) * 1000, 3)] if len(d) else None,
        "duplicate_frames": dups,
        "edge_speed_px_per_frame": {
            "mean": round(float(np.nanmean(edge)), 3),
            "max": round(float(np.nanmax(edge)), 3),
            "first10_mean": round(float(np.nanmean(edge[:10])), 3),
            "last10_mean": round(float(np.nanmean(edge[-10:])), 3),
        },
        "jitter_px": {
            "rms": round(float(np.sqrt(np.mean(resid**2))), 4) if len(resid) else None,
            "max": round(float(np.max(np.abs(resid))), 4) if len(resid) else None,
            "rel_rms_pct": round(float(np.sqrt(np.mean(resid**2)) / max(1e-6, np.nanmean(edge)) * 100), 2) if len(resid) else None,
        },
        "direction_reversals": sign_flips,
        "unmeasured_pairs": int((~ok).sum()),
        "edge_speed_series": [round(float(x), 3) if np.isfinite(x) else None for x in edge],
    }
    if out_json:
        with open(out_json, "w", encoding="utf-8") as fh:
            json.dump(res, fh, ensure_ascii=False, indent=1)
    show = {k: v for k, v in res.items() if k != "edge_speed_series"}
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(show, ensure_ascii=False))


if __name__ == "__main__":
    main()
