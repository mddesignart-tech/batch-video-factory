import fs from "node:fs";
import path from "node:path";

/**
 * QĐ-151: the review page for data/benchmarks/qd151 (reads results.json from
 * bench.ts). Plain HTML next to the videos; open it from disk.
 *
 * Every comparison is ONE video with the four renders side by side
 * (A legacy | V2 1x | V2 2x | V2 easing), so they are frame-locked by
 * construction; a detail strip magnifies product text / picture edges 2x.
 *
 *   npx tsx scripts/qa/qd151/report.ts
 */

const OUT = path.resolve("data", "benchmarks", "qd151");

type Probe = {
  frames: number; cfr: boolean; r_frame_rate: string; duplicate_frames: number;
  edge_speed_px_per_frame: { mean: number };
  jitter_px: { rms: number; max: number; rel_rms_pct: number };
  direction_reversals: number;
};
type Row = { id: string; image: string; variant: string; move: string; file: string; renderSec?: number; bytes?: number; probe: Probe };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const IMAGE_NAME: Record<string, string> = { S1_hall: "S1 hành lang (chiều sâu)", S2_park: "S2 công viên (nhân vật, cây)", S3_product: "S3 sản phẩm (chữ LOCK&LOCK)" };
const DETAIL_NAME: Record<string, string> = { S1_hall: "mép trên-trái, đèn trần", S2_park: "mép phải, thân cây và lá", S3_product: "chữ trên bình" };
const MOVES: { id: string; vi: string }[] = [
  { id: "PAN_RIGHT", vi: "Pan (lia phải)" },
  { id: "ZOOM_IN", vi: "Zoom vào chậm" },
  { id: "TILT_UP", vi: "Tilt (ngửa lên)" },
  { id: "DOLLY_IN", vi: "Dolly (tiến vào)" },
];
const VARIANTS: { v: string; vi: string }[] = [
  { v: "A_prod", vi: "A — LEGACY (production hiện tại)" },
  { v: "B1x1_v2render_1x", vi: "V2 1× (đề xuất)" },
  { v: "B1_v2render", vi: "V2 2× (siêu mẫu)" },
  { v: "B2_v2full", vi: "V2 Easing (SMOOTHERSTEP, 2×)" },
];

function main(): void {
  const r = JSON.parse(fs.readFileSync(path.join(OUT, "results.json"), "utf8")) as { clips: Row[] };
  const rows = r.clips;
  const by = (image: string, move: string, v: string) => rows.find((c) => c.image === image && c.move === move && c.variant === v);
  const avg = (v: string, f: (p: Row) => number | undefined) => {
    const xs = rows.filter((c) => c.variant === v).map(f).filter((x): x is number => typeof x === "number");
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  };
  const summary = VARIANTS.map(
    ({ v, vi }) =>
      `<tr><td>${esc(vi)}</td><td>${avg(v, (c) => c.probe.jitter_px.rel_rms_pct).toFixed(1)}%</td><td>${avg(v, (c) => c.renderSec).toFixed(1)} s</td><td>30 · CFR</td>` +
      `<td>${rows.filter((c) => c.variant === v).reduce((n, c) => n + c.probe.duplicate_frames, 0)}</td><td>${rows.filter((c) => c.variant === v).length}</td></tr>`,
  ).join("");

  const section = (m: { id: string; vi: string }) => {
    const items = Object.keys(IMAGE_NAME)
      .map((img) => {
        const stats = VARIANTS.map(({ v, vi }) => {
          const c = by(img, m.id, v);
          return c ? `<span><b>${esc(vi.split(" (")[0]!)}</b>: giật ${c.probe.jitter_px.rel_rms_pct.toFixed(1)}% · ${c.renderSec ?? "?"} s · ${c.probe.frames} khung</span>` : "";
        }).join("");
        return `<div class="item">
<h3>${esc(IMAGE_NAME[img]!)} — ${esc(m.vi)}</h3>
<video class="sync" src="compare/${img}__${m.id}__4up.mp4" controls loop muted playsinline preload="metadata"></video>
<p class="cap">Phóng to 2× (${esc(DETAIL_NAME[img]!)}) — cùng thứ tự A · V2 1× · V2 2× · V2 Easing:</p>
<video class="sync" src="compare/${img}__${m.id}__detail.mp4" controls loop muted playsinline preload="metadata"></video>
<div class="stats">${stats}</div></div>`;
      })
      .join("\n");
    return `<section id="${m.id}"><h2>${esc(m.vi)}</h2>${items}</section>`;
  };

  const group = (prefix: string) =>
    rows
      .filter((c) => c.variant.startsWith(prefix))
      .map((c) => `<figure><figcaption>${esc(c.move)} ${esc(c.variant.replace(prefix, "").replace(/^_/, ""))} · ${c.renderSec ?? "?"} s</figcaption><video src="${c.file}" controls loop muted playsinline preload="metadata"></video></figure>`)
      .join("\n");

  const metricRow = (c: Row) =>
    `<tr><td>${esc(c.image)}</td><td>${esc(c.move)}</td><td>${esc(c.variant)}</td><td>${c.probe.frames} · ${esc(c.probe.r_frame_rate)} · ${c.probe.cfr ? "CFR" : "VFR"}</td>` +
    `<td>${c.probe.duplicate_frames}</td><td>${c.probe.edge_speed_px_per_frame.mean.toFixed(2)}</td><td>${c.probe.jitter_px.rms.toFixed(3)}</td><td>${c.probe.jitter_px.rel_rms_pct.toFixed(1)}%</td>` +
    `<td>${c.probe.jitter_px.max.toFixed(2)}</td><td>${c.renderSec ?? "-"}</td><td>${c.bytes ? (c.bytes / 1e6).toFixed(2) : "-"}</td></tr>`;

  const html = `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QĐ-151 Motion Benchmark</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--mut:#666;--line:#ddd;--card:#f5f5f5}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--mut:#aaa;--line:#333;--card:#1c1c1c}}
body{font:14px/1.5 system-ui,sans-serif;margin:0;background:var(--bg);color:var(--fg)}
header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px}
main{padding:0 16px 40px}
h1{font-size:20px;margin:0 0 6px}h2{margin:28px 0 8px;font-size:18px}h3{font-size:14px;margin:0 0 6px}
nav a{margin-right:12px}
button{font:inherit;padding:6px 12px;margin:2px 4px 2px 0;cursor:pointer}
.item{background:var(--card);border-radius:8px;padding:10px;margin:10px 0}
video{width:100%;background:#000;border-radius:6px;display:block}
.cap,.note{color:var(--mut);font-size:12px;margin:6px 0}
.stats{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;margin-top:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
figure{margin:0}figcaption{font-size:12px;color:var(--mut)}
table{border-collapse:collapse;font-size:12px;display:block;overflow-x:auto}td,th{border:1px solid var(--line);padding:4px 6px;text-align:right;white-space:nowrap}td:first-child,th:first-child{text-align:left}
</style>
<header>
<h1>QĐ-151 — Nghiệm thu chuyển động camera LOCAL_MOTION</h1>
<div>
<button onclick="ctl('play')">▶ Phát đồng bộ tất cả</button><button onclick="ctl('pause')">⏸ Dừng</button><button onclick="ctl('restart')">⟲ Về 0 s</button>
<button onclick="speed(0.5)">Chậm 0,5×</button><button onclick="speed(1)">Tốc độ 1×</button>
<nav style="display:inline">${MOVES.map((m) => `<a href="#${m.id}">${esc(m.vi)}</a>`).join("")}<a href="#extra">10 đường V2 · cường độ</a><a href="#metrics">Số đo</a></nav>
</div>
</header>
<main>
<p class="note">Mỗi video là 4 bản render <b>trong cùng một khung hình</b> (luôn đồng bộ tuyệt đối): <b>A Legacy</b> | <b>V2 1×</b> | <b>V2 2×</b> | <b>V2 Easing</b>. Cùng ảnh, cùng đường camera, 1080×1920 · 30 fps · 7 s, render tại máy ($0). Nhãn trên video ghi thời gian render và FPS.
Nhấp đúp vào video (hoặc nút ⛶ của trình phát) để xem <b>toàn màn hình</b>. Dải "phóng to 2×" cho thấy chữ trên sản phẩm và chi tiết ở mép ảnh.</p>
<table><tr><th>Phương án</th><th>Giật TB (đo)</th><th>Render TB / 7 s</th><th>FPS</th><th>Khung đứng yên</th><th>Số clip</th></tr>${summary}</table>
<p class="note">"Giật" = lệch của từng khung so với đường chuyển động mượt (% tốc độ), đo bằng motion_probe.py. "Khung đứng yên" của V2 nằm ở đầu/cuối cảnh nơi easing cố ý chậm lại (xem báo cáo). Chất lượng hình ảnh (đẹp, tự nhiên) là do bạn đánh giá — trang này không chấm điểm cảm tính.</p>
${MOVES.map(section).join("\n")}
<section id="extra"><h2>V2 — 10 đường chuyển động (công viên, NORMAL, SMOOTHERSTEP, 2×)</h2><div class="grid">${group("V2_catalogue")}</div>
<h2>V2 — 4 mức cường độ (Dolly In, hành lang)</h2><div class="grid">${group("V2_intensity")}</div>
<h2>Chuỗi V1 (cảnh chưa có camera plan) — tham khảo</h2><div class="grid">${group("A0_v1chain")}</div></section>
<section id="metrics"><h2>Số đo chi tiết</h2>
<table><tr><th>Ảnh</th><th>Chuyển động</th><th>Biến thể</th><th>Khung · fps</th><th>Khung đứng yên</th><th>Tốc độ rìa TB</th><th>Giật RMS (px)</th><th>Giật %</th><th>Giật max</th><th>Render (s)</th><th>MB</th></tr>
${rows.map(metricRow).join("\n")}</table></section>
</main>
<script>
const vids=()=>[...document.querySelectorAll('video')];
function ctl(a){vids().forEach(v=>{if(a==='restart'){v.currentTime=0;v.play()}else if(a==='play'){v.play()}else{v.pause()}})}
function speed(s){vids().forEach(v=>v.playbackRate=s)}
vids().forEach(v=>v.addEventListener('dblclick',()=>v.requestFullscreen&&v.requestFullscreen()));
</script>
</html>`;
  fs.writeFileSync(path.join(OUT, "index.html"), html, "utf8");
  console.log(path.join(OUT, "index.html"));
}

main();
