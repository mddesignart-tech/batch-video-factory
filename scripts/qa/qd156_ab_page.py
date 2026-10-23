"""QĐ-156: build the A/B listening page from ab/report.json. Local file, no network.

    voice-engine\\.venv\\Scripts\\python.exe scripts\\qa\\qd156_ab_page.py data\\qa\\qd156\\ab
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

PAGE = r"""<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QĐ-156 · Nghe thử A/B ngắt câu</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--muted:#5d6470;--line:#d9dde3;--a:#8a5a00;--b:#0b6b3a;--bad:#c0262d;--bound:#2457c5;--nat:#9aa3af;--wave:#4b5563}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1b1e23;--ink:#e8eaee;--muted:#9aa1ad;--line:#2c3138;--a:#e0a63a;--b:#43c483;--bad:#ff5c63;--bound:#6f9bff;--nat:#5f6772;--wave:#b5bcc7}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:1180px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.muted{color:var(--muted)}.small{font-size:13px}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:14px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.stat b{font-size:22px;display:block}
.legend span{display:inline-flex;align-items:center;gap:6px;margin-right:16px}
.sw{width:14px;height:10px;border-radius:2px;display:inline-block}
.case{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:12px 0}
.case h3{margin:0 0 4px;font-size:16px}
.text{white-space:pre-wrap;background:var(--bg);border-radius:8px;padding:8px 10px;margin:8px 0;font-size:14px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}
@media (max-width:760px){.pair{grid-template-columns:1fr}}
.col{border:1px solid var(--line);border-radius:10px;padding:10px;min-width:0}
.col.A{border-top:4px solid var(--a)}.col.B{border-top:4px solid var(--b)}
.col h4{margin:0 0 6px;font-size:14px}
canvas{width:100%;height:90px;display:block;border-radius:6px;background:var(--bg);cursor:pointer}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:4px 12px;cursor:pointer}
button:hover{border-color:var(--ink)}
.meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:13px;margin:6px 0}
.bad{color:var(--bad);font-weight:600}.ok{color:var(--b);font-weight:600}
details{margin-top:6px;font-size:13px}details code{white-space:pre-wrap;word-break:break-word}
.run{font-size:12px;color:var(--muted);margin-top:8px}
</style>
</head>
<body>
<main>
<h1>QĐ-156 · Nghe thử A/B: ngắt câu, xuống dòng, câu dài</h1>
<p class="muted">Mind Voice Local · VieNeu-TTS v3 Turbo · chạy tại máy, $0. <b>A</b> = engine hiện tại (văn bản như trước, mỗi chunk tạo 1 lần).
<b>B</b> = đã cải tiến (xuống dòng đọc liền khi không phải ngắt đoạn, kiểm tra khoảng ngừng và tạo lại chunk bị ngắt bất thường). Âm thanh 48 kHz, chưa qua tăng tốc/chuẩn hoá của app.</p>
<div class="legend small"><span><i class="sw" style="background:var(--bound)"></i>điểm nối chunk</span><span><i class="sw" style="background:var(--bad)"></i>khoảng ngừng bất thường</span><span><i class="sw" style="background:var(--nat)"></i>khoảng ngừng tự nhiên (có dấu câu cho phép, hoặc ≤ 500 ms)</span></div>
<div class="summary" id="summary"></div>
<div id="cases"></div>
</main>
<script>
const DATA = __DATA__;
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmt = s => s.toFixed(2) + " s";
let current = null;

function draw(cv, row, t) {
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, r.width * dpr); cv.height = 90 * dpr;
  const g = cv.getContext("2d"), W = cv.width, H = cv.height, d = row.seconds || 1;
  g.clearRect(0, 0, W, H);
  for (const p of row.pauses) {
    g.fillStyle = p.kind === "abnormal" ? css("--bad") : p.kind === "boundary" ? css("--bound") : css("--nat");
    g.globalAlpha = p.kind === "abnormal" ? 0.35 : 0.18;
    g.fillRect(p.start / d * W, 0, Math.max(2, (p.end - p.start) / d * W), H);
  }
  g.globalAlpha = 1; g.fillStyle = css("--wave");
  const n = row.peaks.length, bw = W / n;
  row.peaks.forEach((v, i) => { const h = Math.max(1, v * H * 0.95); g.fillRect(i * bw, (H - h) / 2, Math.max(1, bw - 0.5), h); });
  g.strokeStyle = css("--bound"); g.lineWidth = 2 * dpr; g.setLineDash([5 * dpr, 4 * dpr]);
  row.chunks.slice(1).forEach(c => { const x = c.start / d * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); });
  g.setLineDash([]);
  if (t != null) { g.strokeStyle = css("--ink"); g.lineWidth = 1.5 * dpr; const x = t / d * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
}

function column(row) {
  const el = document.createElement("div");
  el.className = "col " + row.variant;
  const bad = row.abnormal.length
    ? `<span class="bad">${row.abnormal.length} ngừng bất thường: ${row.abnormal.map(p => `${p.ms} ms @ ${p.start.toFixed(2)} s`).join(", ")}</span>`
    : `<span class="ok">không có ngừng bất thường</span>`;
  const longest = Math.max(0, ...row.pauses.filter(p => p.kind !== "boundary").map(p => p.ms));
  el.innerHTML = `<h4>${row.variant === "A" ? "A · Engine hiện tại" : row.variant === "B" ? "B · Đã cải tiến" : row.variantLabel}</h4>
    <canvas></canvas>
    <div class="meta"><button>▶ Phát</button><span>${fmt(row.seconds)}</span><span>${row.chunks.length} chunk</span><span>${row.takes} lần tạo</span><span>ngừng dài nhất trong chunk: ${longest} ms</span></div>
    <div class="meta">${bad}</div>
    ${row.noPunctMax != null ? `<div class="meta">Ngừng dài nhất trong câu (kịch bản không có dấu câu nào ở giữa): <b class="${row.noPunctMax >= 500 ? "bad" : "ok"}">${row.noPunctMax} ms</b></div>` : ""}
    <div class="meta muted">Engine đọc: <code>${row.engineRead}</code></div>
    <details><summary>Chunk, điểm nối và văn bản gửi engine</summary>
      ${row.chunks.map((c, i) => `<div>#${i + 1} [${c.start.toFixed(2)}–${c.end.toFixed(2)} s] ${c.takes > 1 ? `<b>${c.takes} lần tạo, giữ lần ${c.kept}</b> (loại: ${c.rejected.map(x => "+" + x + " ms").join(", ")}) ` : ""}<code>${c.text}</code></div>${i < row.gaps.length ? `<div class="muted">↳ nối: ${row.gaps[i] === "para" ? "ngắt đoạn (≥ 0,70 s)" : row.gaps[i] === "sentence" ? "hết câu (≥ 0,50 s)" : "trong câu (≥ 0,30 s)"}</div>` : ""}`).join("")}
      <div class="muted">Văn bản gửi TTS: <code>${JSON.stringify(row.ttsText)}</code></div>
      <div class="muted">Tệp: ${row.file}</div>
    </details>`;
  const cv = el.querySelector("canvas"), btn = el.querySelector("button");
  const audio = new Audio(row.file);
  const tick = () => { draw(cv, row, audio.currentTime); if (!audio.paused) requestAnimationFrame(tick); };
  btn.onclick = () => {
    if (current && current !== audio) { current.pause(); }
    if (audio.paused) { current = audio; audio.play(); btn.textContent = "❚❚ Dừng"; tick(); } else { audio.pause(); }
  };
  audio.onpause = audio.onended = () => { btn.textContent = "▶ Phát"; draw(cv, row, audio.ended ? null : audio.currentTime); };
  cv.onclick = e => { const r = cv.getBoundingClientRect(); audio.currentTime = (e.clientX - r.left) / r.width * row.seconds; if (audio.paused) { current && current.pause(); current = audio; audio.play(); btn.textContent = "❚❚ Dừng"; tick(); } };
  requestAnimationFrame(() => draw(cv, row, null));
  window.addEventListener("resize", () => draw(cv, row, audio.paused ? null : audio.currentTime));
  return el;
}

function render() {
  const rows = DATA.rows;
  const stat = v => { const xs = rows.filter(r => r.variant === v); return { n: xs.length, bad: xs.filter(r => r.abnormal.length).length, ms: xs.reduce((a, r) => a + r.abnormal.reduce((b, p) => b + p.ms, 0), 0) }; };
  const A = stat("A"), B = stat("B");
  document.getElementById("summary").innerHTML =
    `<div class="stat"><span class="muted">A · bản có ngừng bất thường</span><b>${A.bad} / ${A.n}</b></div>
     <div class="stat"><span class="muted">B · bản có ngừng bất thường</span><b>${B.bad} / ${B.n}</b></div>
     <div class="stat"><span class="muted">D1 trong video thật (trước sửa)</span><b>${DATA.real ? DATA.real.abnormal.map(p => p.ms + " ms").join(", ") || "—" : "—"}</b></div>
     <div class="stat"><span class="muted">Chi phí API</span><b>$0</b></div>` +
    (DATA.probe ? `<div class="stat"><span class="muted">D1 · Thục Đoan · 20 lần: bản có ngừng ≥ 500 ms</span><b>A ${DATA.probe.A} · B ${DATA.probe.B}</b><span class="small muted">A dài nhất ${DATA.probe.Amax} ms · B dài nhất ${DATA.probe.Bmax} ms</span></div>` : "");
  const root = document.getElementById("cases");
  const groups = [...new Set(rows.map(r => r.group))];
  for (const g of groups) {
    const h = document.createElement("h2"); h.textContent = g; root.appendChild(h);
    const keys = [...new Set(rows.filter(r => r.group === g).map(r => r.id + "|" + r.voice))];
    for (const k of keys) {
      const [id, voice] = k.split("|");
      const xs = rows.filter(r => r.id === id && r.voice === voice);
      const box = document.createElement("section"); box.className = "case";
      box.innerHTML = `<h3>${id} · ${xs[0].title}</h3><div class="muted small">Giọng: ${voice} · ${xs[0].words} từ</div><div class="text">${xs[0].rawText.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>`;
      if (id === "D1" && voice === "Thục Đoan" && DATA.real) {
        const p = document.createElement("div"); p.className = "pair";
        const c = column(DATA.real); p.appendChild(c); box.appendChild(p);
      }
      const runs = [...new Set(xs.map(r => r.run))];
      for (const run of runs) {
        if (runs.length > 1) { const l = document.createElement("div"); l.className = "run"; l.textContent = "Lần " + run; box.appendChild(l); }
        const p = document.createElement("div"); p.className = "pair";
        for (const v of ["A", "B"]) { const r = xs.find(x => x.run === run && x.variant === v); if (r) p.appendChild(column(r)); }
        box.appendChild(p);
      }
      root.appendChild(box);
    }
  }
}
render();
</script>
</body>
</html>
"""


def main() -> None:
    out = Path(sys.argv[1])
    rows = json.loads((out / "report.json").read_text(encoding="utf-8"))
    real_path = out / "real.json"
    real = json.loads(real_path.read_text(encoding="utf-8")) if real_path.exists() else None
    probe_path = out / "probe-20.json"
    probe = json.loads(probe_path.read_text(encoding="utf-8")) if probe_path.exists() else None
    # One clause with no punctuation in the SCRIPT: every pause in it - also at a
    # chunk join the engine made out of a line break - is a pause the text never asked for.
    for r in rows + ([real] if real else []):
        if r["id"] in ("D1", "D2", "D2b"):
            r["noPunctMax"] = max([x["ms"] for x in r["pauses"]], default=0)
        r["engineRead"] = " | ".join(c["text"] for c in r["chunks"])
    data = json.dumps({"rows": rows, "real": real, "probe": probe}, ensure_ascii=False).replace("</", "<\\/")
    (out / "index.html").write_text(PAGE.replace("__DATA__", data), encoding="utf-8")
    print(out / "index.html")


if __name__ == "__main__":
    main()
