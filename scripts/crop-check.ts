import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * Does anything important fall outside the 9:16 crop?
 *
 * Measured rather than eyeballed. The renderer scales a 1024x1536 image to
 * cover 1080x1920 and centre-crops, which trims about 8% off each side and
 * keeps the full height. This decodes each image to raw pixels, finds the
 * columns that differ from the plain background, and reports how much content
 * sits in the strips that will be cut away.
 *
 * Usage: npx tsx scripts/crop-check.ts
 */

const prisma = new PrismaClient();

/** Source and target geometry, taken from the renderer rather than restated. */
const SOURCE = { width: 1024, height: 1536 };
const TARGET = { width: 1080, height: 1920 };

/**
 * What counts as "content" rather than backdrop.
 *
 * Comparing against a corner sample does not work: the generated backdrop is a
 * soft grey gradient, so every column differs from one corner and the whole
 * image reads as content. Saturation is the reliable signal instead - the
 * backdrop is near-neutral grey while the characters are strongly coloured
 * (yellow hoodie, teal shirt, auburn hair, skin tones). Dark outlines are
 * caught by the luminance rule.
 */
const SATURATION_THRESHOLD = 40;
const DARK_THRESHOLD = 90;
/** Fraction of a column's pixels that must be content for it to count. */
const COLUMN_OCCUPANCY = 0.02;

function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("ffmpeg-static") as string | { default: string };
  return typeof mod === "string" ? mod : mod.default;
}

/** Decode a PNG to raw RGB24 using the bundled ffmpeg. */
function decode(file: string): { width: number; height: number; data: Buffer } {
  const raw = execFileSync(
    ffmpegPath(),
    ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 1024 * 1024 * 256 },
  );
  // Every image here comes from the same provider at one size; deriving the
  // dimensions from the byte count would be ambiguous, so they are asserted.
  const expected = SOURCE.width * SOURCE.height * 3;
  if (raw.length !== expected) {
    throw new Error(
      `Kich thuoc la: ${raw.length} byte, mong doi ${expected} (${SOURCE.width}x${SOURCE.height})`,
    );
  }
  return { width: SOURCE.width, height: SOURCE.height, data: raw };
}

/**
 * The horizontal band that survives the crop.
 *
 * scale-to-cover then centre-crop: the source is wider than 9:16, so it is
 * scaled by height and the sides are trimmed.
 */
export function keptBand(): { fraction: number; leftPx: number; rightPx: number } {
  const scale = TARGET.height / SOURCE.height;
  const scaledWidth = SOURCE.width * scale;
  const keptFraction = TARGET.width / scaledWidth;
  const trimmed = (1 - keptFraction) / 2;
  return {
    fraction: keptFraction,
    leftPx: Math.round(trimmed * SOURCE.width),
    rightPx: Math.round((1 - trimmed) * SOURCE.width),
  };
}

/**
 * Horizontal bands, measured separately.
 *
 * "Some content falls in the crop strip" is nearly always true and nearly
 * always harmless - a shoe or a table corner. What matters is WHICH content.
 * In these compositions faces sit in the top third and the acting hands and
 * joke prop in the middle, so those bands are reported apart from the bottom
 * one where losing a foot costs nothing.
 */
const BANDS = [
  { name: "mat/dau ", from: 0.0, to: 0.35 },
  { name: "tay/dao cu", from: 0.35, to: 0.72 },
  { name: "chan/ban", from: 0.72, to: 1.0 },
] as const;

interface ColumnProfile {
  /** Columns holding content, as fractions of width (0 = left edge). */
  firstContent: number;
  lastContent: number;
  /** Share of content-bearing columns that fall in the cropped strips. */
  lostLeft: number;
  lostRight: number;
  /** Per-band loss, so a lost shoe is not reported like a lost face. */
  bandLoss: { name: string; lost: number }[];
}

function isContent(data: Buffer, i: number): boolean {
  const r = data[i] ?? 0;
  const g = data[i + 1] ?? 0;
  const b = data[i + 2] ?? 0;
  const saturation = Math.max(r, g, b) - Math.min(r, g, b);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return saturation > SATURATION_THRESHOLD || luma < DARK_THRESHOLD;
}

/** Content-bearing columns within one horizontal band of the image. */
function contentColumnsIn(
  image: ReturnType<typeof decode>,
  fromY: number,
  toY: number,
): number[] {
  const { width, data } = image;
  const rows = toY - fromY;
  const out: number[] = [];
  for (let x = 0; x < width; x++) {
    let hits = 0;
    for (let y = fromY; y < toY; y++) {
      if (isContent(data, (y * width + x) * 3)) hits++;
    }
    if (hits / rows >= COLUMN_OCCUPANCY) out.push(x);
  }
  return out;
}

function profile(image: ReturnType<typeof decode>): ColumnProfile {
  const { width, height } = image;
  const columns = contentColumnsIn(image, 0, height);
  const columnHasContent = Array.from({ length: width }, (_, x) =>
    columns.includes(x),
  );

  const band = keptBand();
  const contentColumns = columnHasContent
    .map((has, x) => (has ? x : -1))
    .filter((x) => x >= 0);

  const total = contentColumns.length || 1;
  const lostShare = (cols: number[]) => {
    const n = cols.length || 1;
    return (
      (cols.filter((x) => x < band.leftPx).length +
        cols.filter((x) => x >= band.rightPx).length) /
      n
    );
  };

  return {
    firstContent: (contentColumns[0] ?? 0) / width,
    lastContent: (contentColumns[contentColumns.length - 1] ?? 0) / width,
    lostLeft: contentColumns.filter((x) => x < band.leftPx).length / total,
    lostRight: contentColumns.filter((x) => x >= band.rightPx).length / total,
    bandLoss: BANDS.map((b) => ({
      name: b.name,
      lost: lostShare(
        contentColumnsIn(
          image,
          Math.floor(b.from * height),
          Math.floor(b.to * height),
        ),
      ),
    })),
  };
}

async function main(): Promise<void> {
  const band = keptBand();
  console.log("\n========== KIEM TRA VUNG CAT 9:16 ==========\n");
  console.log(`  Anh goc   : ${SOURCE.width}x${SOURCE.height} (2:3)`);
  console.log(`  Khung video: ${TARGET.width}x${TARGET.height} (9:16)`);
  console.log(
    `  Giu lai   : ${(band.fraction * 100).toFixed(1)}% chieu ngang ` +
      `(cot ${band.leftPx} den ${band.rightPx}), toan bo chieu cao`,
  );
  console.log(
    `  Cat bo    : ${((1 - band.fraction) / 2 * 100).toFixed(1)}% moi ben\n`,
  );

  const scenes = await prisma.scene.findMany({
    where: { imagePath: { not: null } },
    include: { project: { include: { idiom: true } } },
    orderBy: [{ projectId: "asc" }, { sceneNumber: "asc" }],
  });

  const { toAbsolute } = await import("../src/lib/paths");
  let warned = 0;

  for (const scene of scenes) {
    const file = toAbsolute(scene.imagePath as string);
    let p: ColumnProfile;
    try {
      p = profile(decode(file));
    } catch (err) {
      console.log(
        `  ${scene.project.idiom.phrase} canh ${scene.sceneNumber}: KHONG DOC DUOC - ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    // Only the bands that carry meaning raise a warning. Losing part of a shoe
    // or a table edge is not a defect worth paying to redraw.
    const faceLoss = p.bandLoss[0]?.lost ?? 0;
    const actionLoss = p.bandLoss[1]?.lost ?? 0;
    const risky = faceLoss > 0.02 || actionLoss > 0.04;
    if (risky) warned++;

    const bands = p.bandLoss
      .map((b) => `${b.name} ${(b.lost * 100).toFixed(1)}%`)
      .join("  ");

    console.log(
      `  ${scene.project.idiom.phrase.padEnd(16)} canh ${scene.sceneNumber}: ` +
        `noi dung ${(p.firstContent * 100).toFixed(0)}-${(p.lastContent * 100).toFixed(0)}% ` +
        `| mat: ${bands}${risky ? "   <-- CAN XEM LAI" : ""}`,
    );
  }

  console.log(
    `\n  ${scenes.length} anh, ${warned} anh co noi dung dang ke nam trong vung bi cat.\n`,
  );
  console.log(`  ffmpeg: ${path.basename(ffmpegPath())}\n`);
}

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
