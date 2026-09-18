import path from "node:path";
import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { peekCreateToken } from "@/services/create-token";
import { hasErrors } from "@/domain/storyboard";
import {
  materialiseImport,
  scanImportSource,
  validateImport,
} from "@/services/storyboard-import";
import { preflightImportedBatch } from "@/services/import-preflight";

/**
 * Import storyboards from a folder, a ZIP or a single file - and stop.
 *
 * Nothing in this path can spend. It reads files, writes rows, and prices what
 * it wrote using the same estimator the run itself checks against. The batch it
 * leaves behind is `PLANNED` with a `DRAFT` authorisation, which permits
 * nothing: approving an amount is a separate act by a person, on the batch
 * page, exactly as it is for a V1 batch.
 *
 *   npx tsx scripts/import-storyboard.ts --source examples/storyboard-import
 *   npx tsx scripts/import-storyboard.ts --source batch.zip --apply \
 *     --name "Lo nhap 1" --max-per-video 1.50 --max-batch 4.00
 */

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const money = (n: number, d = 6) => `$${n.toFixed(d)}`;

async function main(): Promise<void> {
  const source = arg("source");
  const apply = process.argv.includes("--apply");
  if (!source) {
    console.error("Thieu --source <thu muc | file .zip | file .json/.csv>");
    process.exitCode = 1;
    return;
  }

  console.log("=".repeat(92));
  console.log(`  NHAP STORYBOARD  ${apply ? "[TAO LO]" : "[CHI KIEM TRA]"}  — khong goi API nao`);
  console.log("=".repeat(92));

  // Said out loud rather than assumed: this script has no code path to a
  // provider, and these two lines are how an operator confirms that cheaply.
  const token = await peekCreateToken();
  console.log(`\n  AI_MOCK_MODE          : ${isMockMode()}`);
  console.log(`  CREATE_ATTEMPT_TOKEN  : ${token ? "CO TOKEN (!!)" : "0"}`);

  console.log("\n--- 1. Doc nguon nhap ---");
  const scan = scanImportSource(path.resolve(source));
  console.log(`  kieu nguon   : ${scan.sourceKind} (${scan.sourceLabel})`);
  console.log(`  so storyboard: ${scan.videos.length}`);

  console.log("\n--- 2. Kiem tra ---");
  const validated = await validateImport(scan);
  const errors = validated.issues.filter((i) => i.level === "error");
  const warnings = validated.issues.filter((i) => i.level === "warning");

  for (const i of validated.issues) {
    const where = [
      i.videoId ? `video ${i.videoId}` : "",
      i.sceneNumber !== undefined ? `canh ${i.sceneNumber}` : "",
      i.line !== undefined ? `dong ${i.line}` : "",
    ]
      .filter((s) => s.length > 0)
      .join(", ");
    console.log(
      `  ${i.level === "error" ? "[LOI ]" : "[NHAC]"} ${i.code.padEnd(28)} ${where ? `(${where}) ` : ""}${i.message}`,
    );
  }
  console.log(`\n  ${errors.length} loi, ${warnings.length} nhac nho.`);

  for (const v of validated.videos) {
    console.log(
      `  video ${v.videoId.padEnd(14)} ${String(v.scenes.length).padStart(2)} canh | ` +
        `anh co san ${v.suppliedImages}, thieu ${v.missingImages} | ` +
        `LOCAL_MOTION ${v.localMotionScenes}, VIDEO_AI ${v.videoAiScenes}, AUTO ${v.autoScenes}`,
    );
  }

  if (hasErrors(validated.issues)) {
    console.log("\n  DUNG: con loi. Khong tao lo nao.\n");
    process.exitCode = 1;
    return;
  }
  if (!apply) {
    console.log("\n  Kiem tra xong, khong ghi gi. Them --apply de tao lo.\n");
    return;
  }

  console.log("\n--- 3. Tao lo (chi ghi DB, khong chi tien) ---");
  const result = await materialiseImport(validated, {
    batchName: arg("name", `Nhap storyboard ${new Date().toISOString().slice(0, 10)}`),
    maxCostPerVideo: Number(arg("max-per-video", "1.5")),
    maxCostForBatch: Number(arg("max-batch", "5")),
  });
  console.log(`  lo           : ${result.batchId}`);
  console.log(`  video         : ${result.projects.length}`);
  console.log(`  anh da chep   : ${result.copiedImages}`);

  console.log("\n--- 4. Du toan (PREFLIGHT) ---");
  const pre = await preflightImportedBatch(result.batchId);
  for (const v of pre.videos) {
    console.log(
      `\n  ${v.title}  [${v.status}]\n` +
        `    ${v.sceneCount} canh — ${v.localMotionCount} LOCAL_MOTION, ${v.videoAiCount} VIDEO_AI\n` +
        `    anh co san ${v.suppliedImages}, se tao ${v.missingImages}\n` +
        `    provider: ${v.providers.join(", ") || "(khong)"}\n` +
        `    TEXT ${money(v.breakdown.text)}  IMAGE ${money(v.breakdown.image)}  ` +
        `VIDEO ${money(v.breakdown.video)}  VOICE ${money(v.breakdown.voice)}\n` +
        `    TONG ${money(v.estimatedCost)}`,
    );
    for (const w of v.warnings) console.log(`    ! ${w}`);
  }

  console.log("\n  " + "-".repeat(60));
  console.log(`  TONG LO           ${money(pre.estimatedTotal)}  (co so gia: ${pre.costBasis})`);
  console.log(`  ke ca video bi chan ${money(pre.estimatedTotalIncludingBlocked)}`);
  console.log(`  chay duoc / bi chan ${pre.runnableCount} / ${pre.blockedCount}`);
  console.log(`  tran moi video      ${money(pre.maxCostPerVideo, 2)}`);
  console.log(`  tran ca lo          ${money(pre.maxCostForBatch, 2)}`);
  console.log(`  de xuat duyet       ${money(pre.suggestedAuthorizedMaxSpend, 2)}`);
  console.log(`  han muc tong con    ${money(pre.globalRemaining)}`);
  for (const w of pre.warnings) console.log(`  ! ${w}`);

  console.log(
    `\n  Lo dang PLANNED, quyen chi DRAFT — KHONG chi duoc gi.\n` +
      `  Mo /batches/${result.batchId} de xem, sua va DUYET.\n`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
