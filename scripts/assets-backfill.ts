import { prisma } from "@/lib/prisma";
import { backfillLegacyAssets } from "@/services/asset-backfill";

/**
 * `npm run assets:backfill -- --dry-run | --apply [--verbose]`
 *
 * Measures legacy assets (hash, size, type, dimensions, duration) and rebuilds
 * a reuse key only from recorded evidence (QĐ-113). Asset metadata only: no
 * row created or deleted, ledger / jobs / spend untouched. Safe to run again.
 */
async function main() {
  const apply = process.argv.includes("--apply");
  const verbose = process.argv.includes("--verbose");
  if (!apply && !process.argv.includes("--dry-run")) {
    console.log("Chạy thử (không ghi gì). Thêm --apply để ghi.\n");
  }
  const r = await backfillLegacyAssets({ apply });
  console.log(`BACKFILL ${apply ? "(ĐÃ GHI)" : "(CHẠY THỬ — chưa ghi)"}`);
  console.log(`  Asset đã quét         : ${r.scanned}`);
  console.log(`  Dòng thay đổi         : ${r.updated}   (không đổi: ${r.unchanged})`);
  console.log(`  Dựng lại reuse key    : ${r.backfilled}   (đổi khoá audio v1→v2: ${r.rekeyed})`);
  console.log(`  LEGACY_UNVERIFIED     : ${r.legacyUnverified}`);
  console.log(`  MISSING               : ${r.missing}`);
  console.log(`  INVALID               : ${r.invalid}`);
  console.log(`  Cùng nội dung khác tên: ${r.contentDuplicateGroups} nhóm (nhận ra là MỘT nội dung)`);
  console.log(`  Cùng tên khác nội dung: ${r.sameNameDifferentContent} tên (KHÔNG gộp)`);
  if (verbose) {
    for (const row of r.rows) {
      console.log(`  ${row.assetId.slice(0, 8)} ${row.kind.padEnd(6)} ${row.action.padEnd(9)} ${String(row.legacyState ?? "-").padEnd(18)} ${row.validity.padEnd(18)} ${row.keyed.padEnd(10)} ${row.reason}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
