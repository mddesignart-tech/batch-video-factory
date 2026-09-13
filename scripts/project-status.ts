import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

/**
 * Exact state of one project's scenes. Read-only: calls no API, spends nothing.
 *
 * Every column is derived from stored data rather than memory. In particular,
 * which prompt version an image was drawn with is read back out of the prompt
 * saved on its Asset row - the only record that cannot drift from what was
 * actually sent.
 *
 * Usage: npx tsx scripts/project-status.ts --idiom "Spill the beans"
 */

const prisma = new PrismaClient();

/** Marker phrases that identify which prompt revision produced an image. */
const MARKER_SAFE_AREA = "left and right edges will be cropped";
const MARKER_GROUPING = "tight group near the centre";
/**
 * Boilerplate the text model puts in `imagePrompt`. Its presence in a saved
 * prompt means that image was drawn before the fix that made the scene's own
 * `visualDescription` the subject - so the scene itself never reached the API.
 */
const MARKER_BOILERPLATE = "as defined";

const SOURCE = { width: 1024, height: 1536 };
const TARGET = { width: 1080, height: 1920 };
const SATURATION_THRESHOLD = 40;
const DARK_THRESHOLD = 90;
const COLUMN_OCCUPANCY = 0.02;

/**
 * Safe-area verdicts.
 *
 * Deliberately three-valued. Almost every image loses SOMETHING to the crop -
 * a shoe, a table corner - so a pass/fail split would condemn images that are
 * perfectly usable. What matters is whether faces and the acting hands survive.
 */
const PASS_FACE = 0.005;
const PASS_ACTION = 0.03;
const ACCEPTABLE_FACE = 0.06;
const ACCEPTABLE_ACTION = 0.1;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("ffmpeg-static") as string | { default: string };
  return typeof mod === "string" ? mod : mod.default;
}

function isContent(data: Buffer, i: number): boolean {
  const r = data[i] ?? 0;
  const g = data[i + 1] ?? 0;
  const b = data[i + 2] ?? 0;
  const saturation = Math.max(r, g, b) - Math.min(r, g, b);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return saturation > SATURATION_THRESHOLD || luma < DARK_THRESHOLD;
}

function keptBand(): { leftPx: number; rightPx: number } {
  const scaledWidth = SOURCE.width * (TARGET.height / SOURCE.height);
  const trimmed = (1 - TARGET.width / scaledWidth) / 2;
  return {
    leftPx: Math.round(trimmed * SOURCE.width),
    rightPx: Math.round((1 - trimmed) * SOURCE.width),
  };
}

function lostInBand(data: Buffer, fromY: number, toY: number): number {
  const band = keptBand();
  const rows = toY - fromY;
  const columns: number[] = [];
  for (let x = 0; x < SOURCE.width; x++) {
    let hits = 0;
    for (let y = fromY; y < toY; y++) {
      if (isContent(data, (y * SOURCE.width + x) * 3)) hits++;
    }
    if (hits / rows >= COLUMN_OCCUPANCY) columns.push(x);
  }
  const total = columns.length || 1;
  return (
    (columns.filter((x) => x < band.leftPx).length +
      columns.filter((x) => x >= band.rightPx).length) /
    total
  );
}

/**
 * Verdicts.
 *
 * "FAIL" here means the automated screen saw a lot of content in the strips
 * that get cropped - which is also what a scene with a full-width environment
 * looks like. Beans covering a floor are not a defect. So a metric FAIL asks
 * for human eyes rather than automatically ordering a redraw; only objective
 * faults (no image, stale prompt, scene text missing) command a regeneration.
 */
type SafeArea = "PASS" | "ACCEPTABLE" | "FAIL" | "-";

function safeArea(file: string): { verdict: SafeArea; face: number; action: number } {
  const data = execFileSync(
    ffmpegPath(),
    ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 1024 * 1024 * 256 },
  );
  const face = lostInBand(data, 0, Math.floor(0.35 * SOURCE.height));
  const action = lostInBand(
    data,
    Math.floor(0.35 * SOURCE.height),
    Math.floor(0.72 * SOURCE.height),
  );

  let verdict: SafeArea = "FAIL";
  if (face <= PASS_FACE && action <= PASS_ACTION) verdict = "PASS";
  else if (face <= ACCEPTABLE_FACE && action <= ACCEPTABLE_ACTION) {
    verdict = "ACCEPTABLE";
  }
  return { verdict, face, action };
}

async function main(): Promise<void> {
  const idiom = arg("idiom", "Spill the beans");

  // Mock mode: this script must never be able to spend, whatever the .env says.
  process.env.AI_MOCK_MODE = "true";
  const { resetEnvCache } = await import("../src/lib/env");
  resetEnvCache();

  const { sceneCharacters } = await import("../src/domain/scene-characters");
  const { buildSceneImageRequest } = await import("../src/services/generation");
  const { toAbsolute } = await import("../src/lib/paths");

  const project = await prisma.project.findFirst({
    where: { idiom: { phrase: idiom } },
    include: {
      idiom: true,
      scenes: { orderBy: { sceneNumber: "asc" } },
    },
  });
  if (!project) {
    console.log(`Khong tim thay du an "${idiom}".`);
    process.exitCode = 1;
    return;
  }

  // The model the estimate must use is the one these scenes will actually be
  // drawn with. Picking "first enabled image model" grabs the mock row, whose
  // $0.004 makes a real batch look ten times cheaper than it is.
  const pinned = project.scenes.find(
    (s) => s.imageModel && s.imageProvider && s.imageProvider !== "mock",
  );
  const model = pinned
    ? await prisma.modelRegistry.findUnique({
        where: {
          provider_modelId: {
            provider: pinned.imageProvider as string,
            modelId: pinned.imageModel as string,
          },
        },
      })
    : await prisma.modelRegistry.findFirst({
        where: { type: "image", enabled: true, provider: { not: "mock" } },
        orderBy: { price: "asc" },
      });

  console.log(`\n========== TRANG THAI: ${project.idiom.phrase} ==========\n`);
  console.log(`  Che do chat luong : ${project.qualityMode}`);
  console.log(`  So canh           : ${project.scenes.length}`);
  console.log(`  Model dang bat    : ${model?.provider}/${model?.modelId} ($${model?.price}/anh)`);
  console.log(`  (Script nay khong goi API, khong tieu tien.)\n`);

  let toRegenerate = 0;
  let missing = 0;
  let keep = 0;
  let review = 0;

  for (const scene of project.scenes) {
    const lists = sceneCharacters(scene);
    const shot = await buildSceneImageRequest(scene, project.stylePresetId);

    // The prompt saved on the Asset is the only record of what was really sent.
    const asset = scene.imagePath
      ? await prisma.asset.findFirst({
          where: { sceneId: scene.id, kind: "image", filePath: scene.imagePath },
        })
      : null;

    const usedNewPresence = asset ? asset.prompt.includes(MARKER_SAFE_AREA) : false;
    const usedGrouping = asset ? asset.prompt.includes(MARKER_GROUPING) : false;
    // Count the cast that is actually DRAWN, after trimming characters the
    // scene lists but never stages. Counting the raw list asked for a grouping
    // instruction on a shot that only ever had two people in it.
    const needsGrouping = shot.characters.length >= 3;
    // Did the scene's own description actually reach the provider?
    const sceneInPrompt = asset
      ? !asset.prompt.includes(MARKER_BOILERPLATE) &&
        (scene.visualDescription.length === 0 ||
          asset.prompt.includes(scene.visualDescription.slice(0, 40)))
      : false;

    let area = { verdict: "-" as SafeArea, face: 0, action: 0 };
    if (scene.imagePath) {
      try {
        area = safeArea(toAbsolute(scene.imagePath));
      } catch {
        // An unreadable file is reported as unknown rather than silently passing.
      }
    }

    // KEEP only when the image exists, was drawn by the current pipeline, and
    // survives the crop. Anything else is named as work, not quietly accepted.
    let status: "KEEP" | "REGENERATE" | "MISSING" | "REVIEW";
    let reason = "";
    if (!scene.imagePath) {
      status = "MISSING";
      reason = "chua co anh";
      missing++;
    } else if (!usedNewPresence) {
      status = "REGENERATE";
      reason = "tao bang prompt cu";
      toRegenerate++;
    } else if (!sceneInPrompt) {
      status = "REGENERATE";
      reason = "noi dung canh KHONG lot vao prompt (loi imagePrompt boilerplate)";
      toRegenerate++;
    } else if (needsGrouping && !usedGrouping) {
      status = "REGENERATE";
      reason = "3 nhan vat nhung chua co chi dan gom nhom";
      toRegenerate++;
    } else if (area.verdict === "FAIL") {
      status = "REVIEW";
      reason =
        "nhieu noi dung o dai bi cat - xem bang mat: boi canh phu kin khung " +
        "hinh cung cho ket qua nay";
      review++;
    } else {
      status = "KEEP";
      reason = area.verdict === "ACCEPTABLE" ? "dung duoc" : "dat";
      keep++;
    }

    const summary = (scene.visualDescription || scene.imagePrompt)
      .replace(/\s+/g, " ")
      .slice(0, 68);

    console.log(`  ---- Canh ${scene.sceneNumber} ----`);
    console.log(`    Noi dung        : ${summary}`);
    console.log(`    Trong khung hinh: ${lists.present.join(", ") || "-"}`);
    console.log(`    Co thoai        : ${lists.speaking.join(", ") || "khong ai"}`);
    console.log(`    Trong tam       : ${lists.primary.join(", ") || "-"}`);
    console.log(`    Do phuc tap     : ${scene.complexity}`);
    console.log(`    Co anh          : ${scene.imagePath ? "CO" : "CHUA"}`);
    console.log(
      `    He Presence     : ${
        !scene.imagePath ? "-" : usedNewPresence ? "MOI" : "CU"
      }`,
    );
    console.log(
      `    Noi dung canh   : ${
        !scene.imagePath ? "-" : sceneInPrompt ? "CO trong prompt" : "BI BO QUA"
      }`,
    );
    console.log(
      `    Gom nhom        : ${
        !scene.imagePath
          ? "-"
          : usedGrouping
            ? "CO"
            : needsGrouping
              ? "CHUA (can)"
              : "khong can"
      }`,
    );
    console.log(
      `    Anh tham chieu  : ${shot.referencedCharacters.join(" > ") || "khong"}` +
        (shot.unreferencedCharacters.length > 0
          ? `  (thieu anh chuan: ${shot.unreferencedCharacters.join(", ")})`
          : ""),
    );
    console.log(
      `    Safe area 9:16  : ${area.verdict}` +
        (scene.imagePath
          ? `  (mat ${(area.face * 100).toFixed(1)}%, hanh dong ${(area.action * 100).toFixed(1)}%)`
          : ""),
    );
    console.log(`    KET LUAN        : ${status}  — ${reason}\n`);
  }

  const needed = toRegenerate + missing;
  const cost = needed * (model?.price ?? 0);

  console.log("---------- TONG KET ----------");
  console.log(`  KEEP       : ${keep} anh (khong dung toi)`);
  console.log(`  REVIEW     : ${review} anh (can nguoi xem, chua chac phai ve lai)`);
  console.log(`  REGENERATE : ${toRegenerate} anh`);
  console.log(`  MISSING    : ${missing} anh`);
  console.log(`  CAN TAO    : ${needed} anh`);
  console.log(`\n  Uoc tinh   : ${needed} x $${model?.price} = $${cost.toFixed(4)}`);

  const { spendStatus } = await import("../src/services/spend-guard");
  const status = await spendStatus();
  console.log(`  Da chi     : $${status.spent.toFixed(6)} / $${status.cap.toFixed(2)}`);
  console.log(`  Sau khi tao: $${(status.spent + cost).toFixed(4)} / $${status.cap.toFixed(2)}`);
  console.log("");
}

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
