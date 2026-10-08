import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "@/lib/paths";
import { resolveFfmpeg } from "./ffmpeg";

/**
 * LOCAL CUT-OUT (G1) - a picture of a character / product / animal on a PLAIN
 * background becomes a transparent PNG, on this machine, $0.
 *
 * Not a global colour key: a key removes every pixel of the background colour,
 * including white sneakers on a light-grey studio backdrop. Instead the
 * background is FLOOD-FILLED from the picture's edges, so only background that
 * touches the border goes; anything enclosed by the subject stays.
 *
 * Edges are soft: alpha ramps with colour distance, and the half-transparent
 * edge pixels are "un-mixed" from the backdrop colour so no grey halo shows on
 * a darker background. A soft floor shadow (slightly darker than the backdrop)
 * survives as a semi-transparent shadow.
 *
 * Refuses rather than cutting badly: a busy / gradient / photographic
 * background, a subject that fills or touches most of the frame, or almost no
 * subject at all are all REFUSED with a reason.
 */

export const CUTOUT_VERSION = "cutout-v6";

/** Colour distance (RGB, 0..441) below which a pixel is fully backdrop. */
const T_INNER = 18;
/** The fill spreads through pixels this close to the backdrop (a faint floor shadow included). */
const T_FLOOD = 26;
/** An enclosed pocket is only a backdrop gap when it matches the backdrop this closely (shading on a white shoe does not). */
const T_POCKET = 7;
/**
 * Edge barrier: the fill never crosses a pixel whose brightness changes this
 * much across it. The backdrop is smooth; a subject's outline is not - so a
 * cream sneaker almost the colour of the backdrop still keeps its inside.
 */
const EDGE_BARRIER = 7;
/** ... and above which it is fully subject. Between: soft edge. */
const T_OUTER = 46;
/** Border uniformity: mean deviation from the border colour must stay below this. */
const MAX_BORDER_SPREAD = 10;
/** Corners must agree (a gradient or vignette fails this). */
const MAX_CORNER_DELTA = 22;
/** Floor shadow: grey like the backdrop (channel spread vs the backdrop's, 0..255) ... */
const SHADOW_CHROMA = 8;
/** ... no darker than this share of the backdrop's brightness (dark trousers are not a shadow) ... */
const SHADOW_MIN_LUM = 0.5;
/** ... and only in the lower part of the picture, where a floor is. */
const SHADOW_FLOOR_FROM = 0.6;
/** Shadow opacity per unit of darkening. */
const SHADOW_STRENGTH = 1.8;
/** Long side the mask is computed at; the result keeps the source size. */
const WORK_LONG_SIDE = 1600;

export type CutoutRefusal = "BUSY_BACKGROUND" | "GRADIENT_BACKGROUND" | "SUBJECT_TOO_SMALL" | "SUBJECT_FILLS_FRAME" | "UNREADABLE";

export const VI_CUTOUT_REFUSAL: Record<CutoutRefusal, string> = {
  BUSY_BACKGROUND: "Nền ảnh không phẳng (có cảnh vật/hoạ tiết) — không tách tại máy để tránh tách sai.",
  GRADIENT_BACKGROUND: "Nền ảnh chuyển màu / bóng loang không đều — không tách tại máy.",
  SUBJECT_TOO_SMALL: "Không tìm thấy chủ thể đủ lớn trên nền.",
  SUBJECT_FILLS_FRAME: "Chủ thể chạm phần lớn mép ảnh — không xác định được nền.",
  UNREADABLE: "Không đọc được ảnh.",
};

export interface BackdropAnalysis {
  uniform: boolean;
  color: [number, number, number];
  /** Mean colour distance of the border from its own mean. */
  spread: number;
  cornerDelta: number;
  refusal?: CutoutRefusal;
}

export type CutoutResult =
  | { ok: true; path: string; cached: boolean; subjectShare: number; backdrop: [number, number, number] }
  | { ok: false; reason: CutoutRefusal; message: string };

interface Raster {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8Array;
}

const dist = (d: Uint8Array, i: number, c: [number, number, number]) =>
  Math.hypot(d[i]! - c[0], d[i + 1]! - c[1], d[i + 2]! - c[2]);

/** Is this picture on a plain backdrop? Reads only the border band. Pure. */
export function analyzeBackdrop(img: Raster): BackdropAnalysis {
  const { width: w, height: h, data } = img;
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const samples: number[] = [];
  const push = (x: number, y: number) => samples.push((y * w + x) * 4);
  const step = Math.max(1, Math.round(Math.max(w, h) / 400));
  for (let x = 0; x < w; x += step) for (let b = 0; b < band; b += 1) {
    push(x, b);
    push(x, h - 1 - b);
  }
  for (let y = 0; y < h; y += step) for (let b = 0; b < band; b += 1) {
    push(b, y);
    push(w - 1 - b, y);
  }
  const n = samples.length;
  // Per-channel MEDIAN, not the mean: a subject touching the bottom edge must not tint the backdrop colour.
  const median = (k: number) => {
    const v = samples.map((i) => data[i + k]!).sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)]!;
  };
  const color: [number, number, number] = [median(0), median(1), median(2)];
  // The subject may touch the bottom edge (feet), so the spread is taken over
  // the 80 % of border samples nearest the backdrop colour.
  const ds = samples.map((i) => dist(data, i, color)).sort((a, b) => a - b);
  const kept = ds.slice(0, Math.max(1, Math.floor(n * 0.8)));
  const spread = kept.reduce((a, b) => a + b, 0) / kept.length;
  const corner = (x: number, y: number): [number, number, number] => {
    let r = 0;
    let g = 0;
    let b = 0;
    let k = 0;
    for (let dy = 0; dy < band; dy += 1) for (let dx = 0; dx < band; dx += 1) {
      const i = ((y + dy) * w + (x + dx)) * 4;
      r += data[i]!;
      g += data[i + 1]!;
      b += data[i + 2]!;
      k += 1;
    }
    return [r / k, g / k, b / k];
  };
  // Top corners + the upper side corners (the bottom is often where the subject stands).
  const cs = [corner(0, 0), corner(w - band, 0), corner(0, Math.floor(h * 0.5)), corner(w - band, Math.floor(h * 0.5))];
  let cornerDelta = 0;
  for (const a of cs) for (const b of cs) cornerDelta = Math.max(cornerDelta, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  const refusal = spread > MAX_BORDER_SPREAD ? "BUSY_BACKGROUND" : cornerDelta > MAX_CORNER_DELTA ? "GRADIENT_BACKGROUND" : undefined;
  return { uniform: !refusal, color, spread, cornerDelta, ...(refusal ? { refusal } : {}) };
}

/**
 * Alpha mask by flood fill from the border. Returns the new RGBA (colours
 * un-mixed on soft edges) and the subject share, or a refusal. Pure.
 */
export function cutoutRaster(img: Raster, backdrop: [number, number, number]): { raster: Raster; subjectShare: number } | { refusal: CutoutRefusal } {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const alpha = new Uint8Array(n).fill(255);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  // Brightness and its local change (central differences), for the edge barrier.
  const lum = new Float32Array(n);
  for (let p = 0; p < n; p += 1) lum[p] = 0.299 * data[p * 4]! + 0.587 * data[p * 4 + 1]! + 0.114 * data[p * 4 + 2]!;
  const edge = (p: number) => {
    const x = p % w;
    const gx = x > 0 && x < w - 1 ? Math.abs(lum[p + 1]! - lum[p - 1]!) : 0;
    const gy = p >= w && p < n - w ? Math.abs(lum[p + w]! - lum[p - w]!) : 0;
    return Math.max(gx, gy);
  };
  const seed = (p: number) => {
    if (seen[p]) return;
    if (edge(p) > EDGE_BARRIER) return;
    if (dist(data, p * 4, backdrop) > T_FLOOD) return;
    seen[p] = 1;
    queue[tail++] = p;
  };
  // How much of each edge the subject covers. Standing on the bottom edge is
  // normal; covering the top or a side means there is no backdrop to find
  // (a full-bleed photo, a letterboxed / blurred-fill picture).
  const opaque = (x: number, y: number) => dist(data, (y * w + x) * 4, backdrop) > T_OUTER;
  let top = 0;
  let bottom = 0;
  let left = 0;
  let right = 0;
  for (let x = 0; x < w; x += 1) {
    if (opaque(x, 0)) top += 1;
    if (opaque(x, h - 1)) bottom += 1;
  }
  for (let y = 0; y < h; y += 1) {
    if (opaque(0, y)) left += 1;
    if (opaque(w - 1, y)) right += 1;
  }
  if (top / w > 0.2 || left / h > 0.4 || right / h > 0.4 || bottom / w > 0.85) return { refusal: "SUBJECT_FILLS_FRAME" };
  for (let x = 0; x < w; x += 1) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y += 1) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  const flood = () => {
    while (head < tail) {
      const p = queue[head++]!;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0) seed(p - 1);
      if (x < w - 1) seed(p + 1);
      if (y > 0) seed(p - w);
      if (y < h - 1) seed(p + w);
    }
  };
  flood();
  // Enclosed backdrop: the gap between two people, or between an arm and the
  // body, is not connected to the edge. A pocket of PURE backdrop colour big
  // enough to be a gap (not a white stripe or a highlight) is removed too.
  const minPocket = Math.max(64, Math.round(n * 0.0015));
  const pocket = new Uint8Array(n);
  const stack = new Int32Array(n);
  for (let p0 = 0; p0 < n; p0 += 1) {
    if (seen[p0] || pocket[p0] || dist(data, p0 * 4, backdrop) > T_POCKET) continue;
    let sp = 0;
    const members: number[] = [];
    stack[sp++] = p0;
    pocket[p0] = 1;
    while (sp > 0) {
      const p = stack[--sp]!;
      members.push(p);
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= n || seen[q] || pocket[q] || dist(data, q * 4, backdrop) > T_POCKET) continue;
        pocket[q] = 1;
        stack[sp++] = q;
      }
    }
    if (members.length >= minPocket) for (const p of members) seed(p);
  }
  flood();
  // Soft edge: a NARROW band (a few px) around the backdrop may be partly
  // transparent. The fill itself never walks deep into light parts of the
  // subject (white sneakers shaded grey on a grey backdrop stay solid).
  const band = Math.max(2, Math.round(Math.max(w, h) * 0.004));
  let ring: number[] = [];
  for (let p = 0; p < n; p += 1) {
    if (!seen[p]) continue;
    const x = p % w;
    if ((x > 0 && !seen[p - 1]) || (x < w - 1 && !seen[p + 1]) || (p >= w && !seen[p - w]) || (p < n - w && !seen[p + w])) ring.push(p);
  }
  for (let step = 0; step < band && ring.length; step += 1) {
    const next: number[] = [];
    for (const p of ring) {
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= n || seen[q] || dist(data, q * 4, backdrop) > T_OUTER) continue;
        seen[q] = 1;
        next.push(q);
      }
    }
    ring = next;
  }
  // FLOOR SHADOW: the backdrop's own grey, only darker, smooth, reached from
  // the backdrop in the lower part of the picture. Kept as an opaque grey it
  // reads as a white puddle on a new background; it becomes a black shadow
  // whose strength is how much darker it was. The edge barrier keeps a shoe's
  // outline (and so the shoe) out of it.
  const shadow = new Uint8Array(n);
  const bgLum = 0.299 * backdrop[0] + 0.587 * backdrop[1] + 0.114 * backdrop[2];
  const neutral = (p: number) => {
    const i = p * 4;
    const dr = data[i]! - backdrop[0];
    const dg = data[i + 1]! - backdrop[1];
    const db = data[i + 2]! - backdrop[2];
    return Math.max(Math.abs(dr - dg), Math.abs(dg - db), Math.abs(dr - db)) <= SHADOW_CHROMA;
  };
  const floorTop = Math.floor(h * SHADOW_FLOOR_FROM);
  const isShadow = (q: number) =>
    !seen[q] && !shadow[q] && q >= floorTop * w && lum[q]! < bgLum - 2 && lum[q]! >= bgLum * SHADOW_MIN_LUM && neutral(q) && edge(q) <= EDGE_BARRIER;
  const sq: number[] = [];
  for (let p = floorTop * w; p < n; p += 1) {
    if (!seen[p]) continue;
    const x = p % w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (q >= 0 && q < n && isShadow(q)) {
        shadow[q] = 1;
        sq.push(q);
      }
    }
  }
  for (let k = 0; k < sq.length; k += 1) {
    const p = sq[k]!;
    const x = p % w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (q >= 0 && q < n && isShadow(q)) {
        shadow[q] = 1;
        sq.push(q);
      }
    }
  }
  // A band across the whole width (letterbox, blurred fill, a table edge to edge)
  // is not a subject on a backdrop: refuse rather than keep it as "subject".
  for (let y = 0; y < h; y += 2) {
    let row = 0;
    for (let x = 0; x < w; x += 1) if (!seen[y * w + x]) row += 1;
    if (row / w > 0.95) return { refusal: "SUBJECT_FILLS_FRAME" };
  }
  const out = new Uint8Array(data);
  let subject = 0;
  for (let p = 0; p < n; p += 1) {
    if (shadow[p]) {
      const i = p * 4;
      alpha[p] = Math.round(Math.min(1, ((bgLum - lum[p]!) / bgLum) * SHADOW_STRENGTH) * 255);
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      continue;
    }
    if (!seen[p]) {
      subject += 1;
      continue;
    }
    const i = p * 4;
    const d = dist(data, i, backdrop);
    const a = d <= T_INNER ? 0 : (d - T_INNER) / (T_OUTER - T_INNER);
    alpha[p] = Math.round(a * 255);
    if (a > 0) {
      subject += a;
      // Un-mix the backdrop from a soft edge pixel: c = a*fg + (1-a)*bg.
      for (let k = 0; k < 3; k += 1) out[i + k] = Math.max(0, Math.min(255, Math.round((data[i + k]! - (1 - a) * backdrop[k]!) / a)));
    }
  }
  const share = subject / n;
  if (share < 0.02) return { refusal: "SUBJECT_TOO_SMALL" };
  if (share > 0.95) return { refusal: "SUBJECT_FILLS_FRAME" };
  // Feather: a 3x3 average on alpha only where it changes (1-2 px soft edge).
  const soft = new Uint8Array(alpha);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const p = y * w + x;
      const c = alpha[p]!;
      if (alpha[p - 1] === c && alpha[p + 1] === c && alpha[p - w] === c && alpha[p + w] === c) continue;
      let s = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) s += alpha[p + dy * w + dx]!;
      soft[p] = Math.round(s / 9);
    }
  }
  for (let p = 0; p < n; p += 1) out[p * 4 + 3] = soft[p]!;
  return { raster: { width: w, height: h, data: out }, subjectShare: share };
}

/**
 * Crop to the subject's bounding box (+2 % margin, kept even). Empty
 * transparent margins would make the subject small in its layout box, and
 * the layout would not know where its feet are.
 */
export function trimToSubject(r: Raster): Raster {
  const { width: w, height: h, data } = r;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4 + 3]! > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return r;
  const m = Math.round(Math.max(w, h) * 0.02);
  x0 = Math.max(0, x0 - m);
  y0 = Math.max(0, y0 - m);
  x1 = Math.min(w - 1, x1 + m);
  y1 = Math.min(h - 1, y1 + m);
  const cw = (x1 - x0 + 1) & ~1;
  const ch = (y1 - y0 + 1) & ~1;
  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y += 1) out.set(data.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4), y * cw * 4);
  return { width: cw, height: ch, data: out };
}

// ------------------------------------------------------------------ I/O ---

function run(args: string[], input?: Buffer): Promise<Buffer> {
  const bin = resolveFfmpeg();
  if (!bin) return Promise.reject(new Error("FFmpeg không có."));
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { encoding: "buffer", maxBuffer: 1 << 30, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    if (input) {
      child.stdin!.end(input);
    }
  });
}

async function probeSize(file: string): Promise<{ width: number; height: number }> {
  // One decoded frame to a 1x1 tells nothing; ask FFmpeg for the stream size via a null encode.
  const bin = resolveFfmpeg()!;
  return new Promise((resolve, reject) => {
    execFile(bin, ["-hide_banner", "-i", file], { windowsHide: true }, (_err, _out, stderr) => {
      const m = /, (\d{2,5})x(\d{2,5})/.exec(String(stderr));
      if (m) resolve({ width: Number(m[1]), height: Number(m[2]) });
      else reject(new Error("Không đọc được kích thước ảnh."));
    });
  });
}

async function readRaster(file: string): Promise<Raster> {
  const size = await probeSize(file);
  const scale = Math.min(1, WORK_LONG_SIDE / Math.max(size.width, size.height));
  const width = Math.max(2, Math.round((size.width * scale) / 2) * 2);
  const height = Math.max(2, Math.round((size.height * scale) / 2) * 2);
  const data = await run(["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `scale=${width}:${height}:flags=lanczos,format=rgba`, "-frames:v", "1", "-f", "rawvideo", "-"]);
  return { width, height, data: new Uint8Array(data) };
}

async function writePng(r: Raster, out: string): Promise<void> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp.png`;
  await run(["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${r.width}x${r.height}`, "-i", "-", "-frames:v", "1", tmp], Buffer.from(r.data));
  fs.renameSync(tmp, out);
}

export const CUTOUT_CACHE_DIR = () => path.join(DATA_ROOT, "cache", "cutouts");

/**
 * Cut a picture out of its plain backdrop, cached by the picture's content.
 * The same picture is never cut twice; a refusal is not cached (cheap to redo).
 */
export async function cutoutImage(file: string): Promise<CutoutResult> {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return { ok: false, reason: "UNREADABLE", message: VI_CUTOUT_REFUSAL.UNREADABLE };
  }
  const key = createHash("sha256").update(CUTOUT_VERSION).update(bytes).digest("hex").slice(0, 32);
  const out = path.join(CUTOUT_CACHE_DIR(), `${key}.png`);
  let raster: Raster;
  try {
    raster = await readRaster(file);
  } catch {
    return { ok: false, reason: "UNREADABLE", message: VI_CUTOUT_REFUSAL.UNREADABLE };
  }
  const backdrop = analyzeBackdrop(raster);
  if (!backdrop.uniform) return { ok: false, reason: backdrop.refusal!, message: VI_CUTOUT_REFUSAL[backdrop.refusal!] };
  const color = backdrop.color.map(Math.round) as [number, number, number];
  if (fs.existsSync(out)) return { ok: true, path: out, cached: true, subjectShare: NaN, backdrop: color };
  const cut = cutoutRaster(raster, color);
  if ("refusal" in cut) return { ok: false, reason: cut.refusal, message: VI_CUTOUT_REFUSAL[cut.refusal] };
  await writePng(trimToSubject(cut.raster), out);
  return { ok: true, path: out, cached: false, subjectShare: cut.subjectShare, backdrop: color };
}

/** PNG with an alpha channel (colour type 4 or 6). */
export function pngHasAlpha(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(26);
    fs.readSync(fd, head, 0, 26, 0);
    fs.closeSync(fd);
    return head.toString("latin1", 1, 4) === "PNG" && (head[25] === 6 || head[25] === 4);
  } catch {
    return false;
  }
}
