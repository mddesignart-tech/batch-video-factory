import { prisma } from "@/lib/prisma";
import { assetHealthReport } from "@/services/asset-health";

/**
 * `npm run assets:health [-- --json] [-- --all]` - READ-ONLY (QĐ-113).
 * Reports; never repairs, moves or deletes anything.
 */
async function main() {
  const r = await assetHealthReport();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log("SỨC KHOẺ ASSET (chỉ đọc)");
  console.log(`  Assets            : ${r.assets}`);
  console.log(`  Healthy           : ${r.healthy}`);
  console.log(`  Missing           : ${r.missing}`);
  console.log(`  Invalid           : ${r.invalid}`);
  console.log(`  Legacy unverified : ${r.legacyUnverified}`);
  console.log(`  Orphan candidates : ${r.orphanCandidates}`);
  console.log("\nTheo loại kiểm tra:");
  for (const [k, n] of Object.entries(r.counts).sort()) console.log(`  ${k.padEnd(24)} ${n}`);
  const shown = process.argv.includes("--all") ? r.issues : r.issues.filter((i) => i.severity !== "INFO");
  if (shown.length > 0) {
    console.log(`\nVấn đề (${shown.length}${process.argv.includes("--all") ? "" : ", bỏ qua INFO — thêm --all"}):`);
    for (const i of shown.slice(0, 200)) {
      console.log(`  [${i.severity}] ${i.check}: ${i.message}${i.assetId ? ` (asset ${i.assetId.slice(0, 8)})` : ""}`);
    }
  }
  console.log("\nKhông sửa gì tự động.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
