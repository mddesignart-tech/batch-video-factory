import zlib from "node:zlib";

/**
 * A tiny, dependency-free PNG writer.
 *
 * Mock mode needs to produce *real* image files - not zero-byte placeholders -
 * so that FFmpeg, the storyboard preview and the final render all exercise the
 * same code paths they will use with a real provider. Pulling in a canvas or
 * image library for that would mean a native build step on Windows, so we encode
 * the handful of primitives we need (fill, gradient, rect, bitmap text) here.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export class Bitmap {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 3);
  }

  setPixel(x: number, y: number, color: RGB): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.data[i] = color.r;
    this.data[i + 1] = color.g;
    this.data[i + 2] = color.b;
  }

  fill(color: RGB): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) this.setPixel(x, y, color);
    }
  }

  verticalGradient(top: RGB, bottom: RGB): void {
    for (let y = 0; y < this.height; y++) {
      const t = this.height <= 1 ? 0 : y / (this.height - 1);
      const color: RGB = {
        r: Math.round(top.r + (bottom.r - top.r) * t),
        g: Math.round(top.g + (bottom.g - top.g) * t),
        b: Math.round(top.b + (bottom.b - top.b) * t),
      };
      for (let x = 0; x < this.width; x++) this.setPixel(x, y, color);
    }
  }

  rect(x: number, y: number, w: number, h: number, color: RGB): void {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) this.setPixel(x + dx, y + dy, color);
    }
  }

  circle(cx: number, cy: number, radius: number, color: RGB): void {
    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy <= r2) this.setPixel(cx + dx, cy + dy, color);
      }
    }
  }

  /** Draw uppercase text with the built-in 5x7 font. Returns the drawn width. */
  text(
    value: string,
    x: number,
    y: number,
    scale: number,
    color: RGB,
  ): number {
    let cursor = x;
    for (const rawChar of value.toUpperCase()) {
      const glyph = FONT[rawChar] ?? FONT["?"];
      if (glyph) {
        for (let row = 0; row < GLYPH_H; row++) {
          const bits = glyph[row] ?? 0;
          for (let col = 0; col < GLYPH_W; col++) {
            if ((bits >> (GLYPH_W - 1 - col)) & 1) {
              this.rect(
                cursor + col * scale,
                y + row * scale,
                scale,
                scale,
                color,
              );
            }
          }
        }
      }
      cursor += (GLYPH_W + 1) * scale;
    }
    return cursor - x;
  }

  textWidth(value: string, scale: number): number {
    return value.length * (GLYPH_W + 1) * scale;
  }

  /**
   * Largest scale at or below `maxScale` that fits `value` inside `maxWidth`.
   * Placeholder cards are drawn at several frame sizes, so text has to adapt
   * rather than run off the edge.
   */
  fitScale(value: string, maxWidth: number, maxScale: number): number {
    for (let scale = maxScale; scale > 1; scale--) {
      if (this.textWidth(value, scale) <= maxWidth) return scale;
    }
    return 1;
  }

  centeredText(value: string, y: number, scale: number, color: RGB): void {
    const w = this.textWidth(value, scale);
    this.text(value, Math.round((this.width - w) / 2), y, scale, color);
  }

  /** Centre `value`, shrinking it until it fits within `maxWidth`. */
  centeredFittedText(
    value: string,
    y: number,
    maxScale: number,
    color: RGB,
    maxWidth = this.width * 0.9,
  ): void {
    this.centeredText(value, y, this.fitScale(value, maxWidth, maxScale), color);
  }

  toPNG(): Buffer {
    return encodePNG(this);
  }
}

// --------------------------------------------------------------- encoding ---

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i] as number;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

export function encodePNG(bitmap: Bitmap): Buffer {
  const { width, height, data } = bitmap;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type 2 = truecolour RGB
  ihdr.writeUInt8(0, 10); // deflate
  ihdr.writeUInt8(0, 11); // adaptive filtering
  ihdr.writeUInt8(0, 12); // no interlace

  // Each scanline is prefixed with filter type 0 (None).
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- font ---

export const GLYPH_ADVANCE = 6; // 5px glyph + 1px gap
const GLYPH_W = 5;
const GLYPH_H = 7;

/** 5x7 bitmap font, one number per row, low 5 bits used. */
const FONT: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  " ": [0, 0, 0, 0, 0, 0, 0],
  ".": [0, 0, 0, 0, 0, 0x0c, 0x0c],
  ",": [0, 0, 0, 0, 0x0c, 0x04, 0x08],
  "!": [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
  "?": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
  "-": [0, 0, 0, 0x1f, 0, 0, 0],
  ":": [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0],
  "'": [0x04, 0x04, 0x08, 0, 0, 0, 0],
  "#": [0x0a, 0x1f, 0x0a, 0x0a, 0x1f, 0x0a, 0x00],
  "/": [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
};

/** Greedy word wrap for the bitmap font. */
export function wrapText(
  value: string,
  maxChars: number,
): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}
