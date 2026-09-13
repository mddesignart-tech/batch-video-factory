import fs from "node:fs";
import path from "node:path";
import { Bitmap, GLYPH_ADVANCE, wrapText, type RGB } from "@/media/png";
import { ffmpeg, ffmpegAvailable } from "@/media/ffmpeg";
import { hashCode } from "@/lib/utils";
import type { Complexity } from "@/domain/enums";

/**
 * Placeholder media for mock mode.
 *
 * These are real, playable files - not stubs. The point of mock mode is to
 * exercise the exact same download-write-probe-render path a paid provider
 * would, so that when Milestone 2 swaps in a real API the only thing that
 * changes is where the bytes came from.
 *
 * Output is deterministic: the same scene always produces the same colours, so
 * re-running a project does not churn the file contents.
 */

const PALETTES: [RGB, RGB][] = [
  [
    { r: 255, g: 158, b: 87 },
    { r: 209, g: 60, b: 106 },
  ],
  [
    { r: 92, g: 200, b: 255 },
    { r: 46, g: 76, b: 186 },
  ],
  [
    { r: 168, g: 230, b: 130 },
    { r: 34, g: 139, b: 110 },
  ],
  [
    { r: 255, g: 214, b: 102 },
    { r: 214, g: 104, b: 40 },
  ],
  [
    { r: 205, g: 160, b: 255 },
    { r: 96, g: 52, b: 178 },
  ],
];

const INK: RGB = { r: 22, g: 22, b: 32 };
const PAPER: RGB = { r: 255, g: 255, b: 255 };

export interface SceneCardInput {
  sceneNumber: number;
  totalScenes: number;
  caption: string;
  complexity: Complexity;
  provider: string;
  model: string;
  width: number;
  height: number;
  seed: number;
}

/**
 * Draw a storyboard-style card: two stick characters against a gradient, with
 * the scene's caption and the routing decision that produced it. Having the
 * chosen model printed on the frame makes per-scene routing visible during the
 * acceptance test without opening the database.
 */
export function renderSceneCard(input: SceneCardInput): Buffer {
  const { width, height } = input;
  const bmp = new Bitmap(width, height);

  const palette =
    PALETTES[hashCode(`${input.seed}:${input.sceneNumber}`) % PALETTES.length];
  const [top, bottom] = palette ?? [PALETTES[0]![0], PALETTES[0]![1]];
  bmp.verticalGradient(top, bottom);

  // Ground line
  const groundY = Math.round(height * 0.72);
  bmp.rect(0, groundY, width, Math.round(height * 0.01), {
    r: Math.max(0, top.r - 60),
    g: Math.max(0, top.g - 60),
    b: Math.max(0, top.b - 60),
  });

  // Two characters, sized to the frame. A HIGH complexity scene draws both
  // facing each other; LOW draws a single figure.
  const scale = Math.round(height / 34);
  const figureCount = input.complexity === "LOW" ? 1 : 2;
  const positions =
    figureCount === 1
      ? [Math.round(width * 0.5)]
      : [Math.round(width * 0.33), Math.round(width * 0.67)];
  for (let i = 0; i < positions.length; i++) {
    drawFigure(bmp, positions[i]!, groundY, scale, i === 0 ? INK : PAPER);
  }

  // Header band: which scene this is and how the router classified it.
  bmp.rect(0, 0, width, Math.round(height * 0.09), { r: 18, g: 18, b: 26 });
  bmp.centeredFittedText(
    `SCENE ${input.sceneNumber}/${input.totalScenes} - ${input.complexity}`,
    Math.round(height * 0.03),
    Math.max(2, Math.round(width / 200)),
    PAPER,
    width * 0.9,
  );

  // Caption block in the lower third, where the burned-in subtitle will sit.
  const blockLeft = Math.round(width * 0.06);
  const blockWidth = Math.round(width * 0.88);
  const innerWidth = blockWidth - Math.round(width * 0.04);
  const capScale = Math.max(2, Math.round(width / 280));
  const maxChars = Math.max(
    10,
    Math.floor(innerWidth / ((GLYPH_ADVANCE) * capScale)),
  );
  const lines = wrapText(truncate(input.caption, 110), maxChars).slice(0, 4);
  const lineHeight = 7 * capScale + Math.round(capScale * 4);
  // Anchor the block to the bottom of the frame so it grows upward and can
  // never collide with the footer, whatever the caption length.
  const blockHeight = lines.length * lineHeight + capScale * 10;
  const blockBottom = Math.round(height * 0.93);
  const blockTop = blockBottom - blockHeight + Math.round(capScale * 6);
  bmp.rect(blockLeft, blockBottom - blockHeight, blockWidth, blockHeight, {
    r: 12,
    g: 12,
    b: 20,
  });
  lines.forEach((line, i) => {
    bmp.centeredFittedText(
      line,
      blockTop + i * lineHeight,
      capScale,
      PAPER,
      innerWidth,
    );
  });

  // Footer: the router's decision for this scene, which is the thing worth
  // seeing on the frame while reviewing a mock run.
  bmp.centeredFittedText(
    `${input.provider}/${input.model} - MOCK`,
    Math.round(height * 0.95),
    Math.max(1, Math.round(width / 380)),
    PAPER,
    width * 0.9,
  );

  return bmp.toPNG();
}

function drawFigure(
  bmp: Bitmap,
  cx: number,
  groundY: number,
  scale: number,
  color: RGB,
): void {
  const headR = Math.round(scale * 1.1);
  const bodyH = scale * 3;
  const headY = groundY - bodyH - headR * 2;

  bmp.circle(cx, headY, headR, color);
  bmp.rect(cx - Math.round(scale * 0.22), headY + headR, Math.max(2, Math.round(scale * 0.45)), bodyH, color);
  // Arms
  bmp.rect(cx - scale, headY + headR + Math.round(scale * 0.6), scale * 2, Math.max(2, Math.round(scale * 0.3)), color);
  // Legs
  const legTop = headY + headR + bodyH;
  bmp.rect(cx - scale, legTop, Math.max(2, Math.round(scale * 0.35)), Math.round(scale * 1.6), color);
  bmp.rect(cx + Math.round(scale * 0.7), legTop, Math.max(2, Math.round(scale * 0.35)), Math.round(scale * 1.6), color);
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}...`;
}

export function writeSceneCard(
  outputPath: string,
  input: SceneCardInput,
): number {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const png = renderSceneCard(input);
  fs.writeFileSync(outputPath, png);
  return png.length;
}

// ------------------------------------------------------------------ video ---

/**
 * Turn a still card into a moving clip. If FFmpeg is unavailable we fall back to
 * writing the PNG beside the intended output and returning that path, so mock
 * mode still works on a machine that has not installed FFmpeg yet.
 */
export async function writeMockClip(opts: {
  stillPath: string;
  outputPath: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
}): Promise<string> {
  const { stillPath, outputPath, durationSeconds, width, height, fps } = opts;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  if (!ffmpegAvailable()) return stillPath;

  // Motion comes from over-scaling once and then panning the crop window, not
  // from `zoompan`. zoompan re-renders the source at zoom resolution on every
  // frame, which at 1080x1920 is slow enough to dominate a whole mock run;
  // scale-then-crop is a couple of orders of magnitude cheaper and looks the
  // same for a placeholder.
  const overscan = 1.12;
  const scaledW = Math.round(width * overscan);
  const scaledH = Math.round(height * overscan);

  await ffmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-loop",
    "1",
    "-t",
    String(durationSeconds),
    "-i",
    stillPath,
    "-vf",
    `scale=${scaledW}:${scaledH},` +
      `crop=${width}:${height}:` +
      `x='(iw-ow)/2+sin(t*0.9)*(iw-ow)/2.5':` +
      `y='(ih-oh)/2+cos(t*0.6)*(ih-oh)/2.5',` +
      `fps=${fps},format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "26",
    "-pix_fmt",
    "yuv420p",
    "-an",
    outputPath,
  ]);
  return outputPath;
}

// ------------------------------------------------------------------ audio ---

/**
 * A 16-bit PCM WAV placeholder voice track, synthesised in pure TypeScript so
 * mock mode needs no audio dependency at all.
 *
 * It is not speech - it is one short pitched blip per word, with pitch derived
 * from the voice id. That makes it obvious at review time which line belongs to
 * which character, and it gives the mixer a real waveform of the right length.
 */
export function synthesizeVoiceWav(opts: {
  text: string;
  durationSeconds: number;
  voiceId: string;
  sampleRate?: number;
}): Buffer {
  const sampleRate = opts.sampleRate ?? 48000;
  const duration = Math.max(0.4, opts.durationSeconds);
  const total = Math.floor(sampleRate * duration);
  const samples = new Int16Array(total);

  const words = opts.text.split(/\s+/).filter(Boolean);
  const wordCount = Math.max(1, words.length);
  const base = 120 + (hashCode(opts.voiceId) % 80); // 120-200 Hz
  const perWord = total / wordCount;

  for (let w = 0; w < wordCount; w++) {
    const word = words[w] ?? "";
    const start = Math.floor(w * perWord);
    const len = Math.floor(perWord * 0.68); // leave a gap between words
    const freq = base + (hashCode(word) % 60);
    for (let i = 0; i < len && start + i < total; i++) {
      const t = i / sampleRate;
      // Short attack / long decay envelope keeps it from clicking.
      const env = Math.min(1, i / (sampleRate * 0.02)) * Math.exp(-3 * (i / len));
      const value =
        Math.sin(2 * Math.PI * freq * t) * 0.55 +
        Math.sin(2 * Math.PI * freq * 2 * t) * 0.2 +
        Math.sin(2 * Math.PI * freq * 3 * t) * 0.08;
      samples[start + i] = Math.round(value * env * 9000);
    }
  }

  return wavFromPCM(samples, sampleRate);
}

function wavFromPCM(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // format = PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i] ?? 0, 44 + i * 2);
  }
  return buf;
}

export function writeMockVoice(
  outputPath: string,
  opts: { text: string; durationSeconds: number; voiceId: string },
): number {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const wav = synthesizeVoiceWav(opts);
  fs.writeFileSync(outputPath, wav);
  return wav.length;
}

/** Rough speaking time: ~2.6 words/second at normal pace. */
export function estimateSpeechDuration(text: string, speed = 1): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0.6;
  return Math.max(0.6, (words / 2.6) / Math.max(0.5, speed));
}
