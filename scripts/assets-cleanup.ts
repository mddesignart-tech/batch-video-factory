import { prisma } from "@/lib/prisma";
import { applyCleanup, planCleanup } from "@/services/asset-cleanup";
import { getSettings } from "@/lib/settings";

/**
 * `npm run assets:cleanup -- --dry-run`   report only (the default)
 * `npm run assets:cleanup -- --apply`     delete the SAFE files, nothing else
 *
 * SAFE = expired temp files, interrupted partial files, test data of finished
 * test processes. Paid, imported, rendered and referenced files are never SAFE;
 * unreferenced media is an ORPHAN_CANDIDATE and is kept (QĐ-113).
 */

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const verbose = process.argv.includes("--verbose");
  const settings = await getSettings();
  const plan = await planCleanup({ tempDays: settings.cleanupTempDays });

  console.log(`DỌN DẸP ${apply ? "(--apply: XOÁ file SAFE)" : "(CHẠY THỬ — không xoá gì)"}`);
  console.log(`  Files scanned     : ${plan.filesScanned}`);
  console.log(`  Safe to delete    : ${plan.safe.length}`);
  console.log(`  Bytes reclaimable : ${plan.bytesReclaimable} (${mb(plan.bytesReclaimable)})`);
  console.log(`  Protected files   : ${plan.protectedFiles}`);
  console.log(`  Orphan candidates : ${plan.orphanCandidates.length} (giữ lại, chỉ báo cáo)`);
  console.log(`  Unknown files     : ${plan.unknown.length} (giữ lại)`);
  console.log("\nTheo nhóm:");
  for (const [k, v] of Object.entries(plan.byCategory).sort()) {
    console.log(`  ${k.padEnd(34)} ${String(v.files).padStart(6)} file  ${mb(v.bytes)}`);
  }
  if (verbose) {
    for (const e of [...plan.safe, ...plan.orphanCandidates, ...plan.unknown]) {
      console.log(`  ${e.action.padEnd(16)} ${e.category.padEnd(20)} ${e.path}  — ${e.reason}`);
    }
  }
  if (!apply) {
    console.log("\nFiles actually deleted: 0 (chạy thử). Thêm --apply để xoá các file SAFE.");
    return;
  }
  const done = await applyCleanup(plan);
  console.log(`\nFiles actually deleted: ${done.deleted} (${mb(done.bytes)}); bỏ qua ${done.skipped} (không còn SAFE).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
