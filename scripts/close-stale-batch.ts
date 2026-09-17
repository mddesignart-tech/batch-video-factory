/**
 * Retire a batch that stopped halfway, without rewriting what it spent.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Batch 11af6ba6 was approved on 2026-09-15 with a $0.90 ceiling, spent $0.44
 * on one clip and one image, and then stopped. What it left behind was not
 * inert: six jobs sat `queued` against its project, and the approval stayed
 * APPROVED with $0.46 of headroom and Runway and OpenAI in scope. `claimNext`
 * takes the lowest priority number regardless of which batch it belongs to, so
 * the next time a worker started - for any reason, including a run of something
 * else entirely - those six would have gone first, on a batch nobody was
 * watching, against a scene pinned to a model marked DEGRADED.
 *
 * THE LINE THIS FILE DOES NOT CROSS
 * ---------------------------------
 * Cancelling work that has not happened is bookkeeping. Editing the record of
 * work that HAS happened is falsification, and the two are one careless
 * `deleteMany` apart. So:
 *
 *   CostEntry            never touched. $5.353920 of real spend stays $5.353920.
 *   CostReservation      never touched. The COMMITTED and RELEASED rows are the
 *                        evidence of what was really bought and what Runway
 *                        confirmed it did not charge for. A "cleanup" that
 *                        removed them would make the ledger tidier and wrong.
 *   LogEntry             never touched, and this run ADDS to it.
 *   BatchAuthorization   status only, through `closeAuthorization`, which keeps
 *                        `actualSpend` and writes `closedReason`. No refund is
 *                        invented: the money left, and the row keeps saying so.
 *   Job                  `queued`/`processing` -> `cancelled`. Cancelled, not
 *                        deleted - a job that was never going to run is still
 *                        something that was once planned.
 *
 *   npx tsx scripts/close-stale-batch.ts                 # dry run, prints only
 *   npx tsx scripts/close-stale-batch.ts --apply         # actually closes it
 */
import { prisma } from "../src/lib/prisma";
import { logger } from "../src/lib/logger";
import { cancelProjectJobs } from "../src/jobs/queue";
import { closeAuthorization } from "../src/services/batch-authorization";
import { reservationLedger } from "../src/services/cost-reservation";

const BATCH_PREFIX = process.argv.includes("--batch")
  ? process.argv[process.argv.indexOf("--batch") + 1]!
  : "11af6ba6";
const APPLY = process.argv.includes("--apply");

const money = (n: number) => `$${n.toFixed(6)}`;

async function main(): Promise<void> {
  console.log("=".repeat(78));
  console.log(`  ĐÓNG LÔ CŨ ${BATCH_PREFIX}  ${APPLY ? "(GHI THẬT)" : "(THỬ KHÔ — chỉ in)"}`);
  console.log("=".repeat(78));

  const batch = await prisma.batch.findFirst({
    where: { id: { startsWith: BATCH_PREFIX } },
  });
  if (!batch) {
    console.log(`\n  Không tìm thấy lô nào bắt đầu bằng ${BATCH_PREFIX}.`);
    return;
  }
  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId: batch.id } });
  const projects = await prisma.project.findMany({
    where: { batchId: batch.id },
    select: { id: true, status: true, idiom: { select: { phrase: true } } },
  });

  // ---- what is actually still live, before anything moves -----------------

  const liveJobs = await prisma.job.findMany({
    where: {
      projectId: { in: projects.map((p) => p.id) },
      status: { in: ["queued", "processing"] },
    },
    select: { id: true, type: true, status: true, priority: true, projectId: true },
    orderBy: { priority: "asc" },
  });

  // Money still being HELD. Settled rows are history and are not a dependency:
  // a COMMITTED reservation has already become a CostEntry, and a RELEASED one
  // gave its hold back. Only PENDING/HELD would mean closing the approval now
  // could strand a request that is still in flight.
  const held = await prisma.costReservation.findMany({
    where: { batchId: batch.id, status: "RESERVED" },
    select: { id: true, status: true, kind: true, provider: true, estimatedCost: true },
  });
  const settled = await prisma.costReservation.groupBy({
    where: { batchId: batch.id },
    by: ["status"],
    _count: { _all: true },
    _sum: { estimatedCost: true, actualCost: true },
  });
  const spendBefore = await prisma.costEntry.aggregate({
    where: { estimated: false },
    _sum: { amount: true },
    _count: { _all: true },
  });

  console.log(`\n  Lô           : ${batch.id}`);
  console.log(`  Tên          : ${batch.name}`);
  console.log(`  Trạng thái   : ${batch.status}`);
  console.log(`  Dự án        : ${projects.map((p) => `${p.id.slice(0, 8)} (${p.idiom?.phrase}, ${p.status})`).join(", ") || "(không có)"}`);
  if (auth) {
    const ledger = await reservationLedger(batch.id, auth.authorizedMaxSpend);
    console.log(`\n  QUYỀN CHI`);
    console.log(`    trạng thái      : ${auth.status}`);
    console.log(`    trần duyệt      : ${money(auth.authorizedMaxSpend)}`);
    console.log(`    đã chi thật     : ${money(auth.actualSpend)}`);
    console.log(`    đang giữ chỗ    : ${money(ledger.reserved ?? 0)}`);
    console.log(`    còn dùng được   : ${money(ledger.available)}`);
    console.log(`    lowAutoApproved : ${auth.lowAutoApproved}`);
    console.log(`    phạm vi         : ${auth.providerScopeJson}`);
  } else {
    console.log(`\n  QUYỀN CHI     : (không có)`);
  }

  console.log(`\n  JOB CÒN SỐNG  : ${liveJobs.length}`);
  for (const j of liveJobs) {
    console.log(`    ${j.status.padEnd(11)} ${j.type.padEnd(22)} pri=${j.priority}`);
  }

  console.log(`\n  GIỮ CHỖ CHƯA CHỐT : ${held.length}`);
  for (const h of held) {
    console.log(`    ${h.status} ${h.kind}/${h.provider} ${money(h.estimatedCost)}`);
  }
  console.log(`\n  GIỮ CHỖ ĐÃ CHỐT (giữ nguyên, không đụng):`);
  for (const r of settled) {
    console.log(
      `    ${r.status.padEnd(10)} n=${r._count._all} ước tính ${money(r._sum.estimatedCost ?? 0)} thực tế ${money(r._sum.actualCost ?? 0)}`,
    );
  }
  console.log(`\n  SỔ CHI THẬT (toàn app, giữ nguyên): ${spendBefore._count._all} dòng, ${money(spendBefore._sum.amount ?? 0)}`);

  // ---- the one condition that would stop this ------------------------------

  if (held.length > 0) {
    console.log(
      `\n  DỪNG: còn ${held.length} giữ chỗ CHƯA chốt. Đóng quyền chi lúc này có thể ` +
        `bỏ rơi một request đang bay. Hãy chốt hoặc nhả chúng trước.`,
    );
    process.exitCode = 1;
    return;
  }

  if (!APPLY) {
    console.log(`\n  THỬ KHÔ — chưa ghi gì. Thêm --apply để thực hiện:`);
    console.log(`    - huỷ ${liveJobs.length} job (queued/processing -> cancelled)`);
    console.log(`    - quyền chi -> CANCELLED (giữ nguyên actualSpend ${money(auth?.actualSpend ?? 0)})`);
    console.log(`    - lô -> CANCELLED`);
    console.log(`    - KHÔNG đụng CostEntry, KHÔNG đụng reservation đã chốt, KHÔNG xoá log\n`);
    return;
  }

  // ---- apply ---------------------------------------------------------------

  const reason =
    `Lô dừng giữa chừng từ 2026-09-15 và không được tiếp tục. ` +
    `Huỷ ${liveJobs.length} job còn xếp hàng rồi thu hồi quyền chi để phần dư ` +
    `${money(auth ? auth.authorizedMaxSpend - auth.actualSpend : 0)} không thể chi cho ` +
    `một lô không ai theo dõi. Đã chi ${money(auth?.actualSpend ?? 0)} giữ nguyên trong sổ.`;

  let cancelled = 0;
  for (const p of projects) {
    cancelled += await cancelProjectJobs(p.id);
  }
  console.log(`\n  Đã huỷ ${cancelled} job.`);

  if (auth) {
    await closeAuthorization(batch.id, "CANCELLED", reason);
    console.log(`  Quyền chi -> CANCELLED.`);
  }

  await prisma.batch.update({
    where: { id: batch.id },
    data: { status: "CANCELLED" },
  });
  console.log(`  Lô -> CANCELLED.`);

  await logger.warn({
    event: "batch.stale_closed",
    message:
      `Lô ${batch.id}: dọn trạng thái cũ. Huỷ ${cancelled} job, thu hồi quyền chi. ` +
      `Sổ chi thật KHÔNG đổi (${money(spendBefore._sum.amount ?? 0)}). ${reason}`,
  });

  // ---- verify, by reading it back -----------------------------------------

  const afterJobs = await prisma.job.count({
    where: {
      projectId: { in: projects.map((p) => p.id) },
      status: { in: ["queued", "processing"] },
    },
  });
  const afterAuth = await prisma.batchAuthorization.findUnique({ where: { batchId: batch.id } });
  const afterLedger = afterAuth
    ? await reservationLedger(batch.id, afterAuth.authorizedMaxSpend)
    : null;
  const spendAfter = await prisma.costEntry.aggregate({
    where: { estimated: false },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const settledAfter = await prisma.costReservation.count({
    where: { batchId: batch.id, status: { in: ["COMMITTED", "RELEASED"] } },
  });

  console.log(`\n  KIỂM CHỨNG SAU KHI DỌN`);
  console.log(`    job queued/processing còn  : ${afterJobs}  ${afterJobs === 0 ? "ĐẠT" : "HỎNG"}`);
  console.log(`    quyền chi                   : ${afterAuth?.status}  ${afterAuth?.status === "CANCELLED" ? "ĐẠT" : "HỎNG"}`);
  console.log(`    đang giữ chỗ                : ${money(afterLedger?.reserved ?? 0)}  ${(afterLedger?.reserved ?? 0) === 0 ? "ĐẠT" : "HỎNG"}`);
  console.log(`    actualSpend giữ nguyên      : ${money(afterAuth?.actualSpend ?? 0)}  ${afterAuth?.actualSpend === auth?.actualSpend ? "ĐẠT" : "HỎNG"}`);
  console.log(
    `    sổ chi thật giữ nguyên      : ${spendAfter._count._all} dòng ${money(spendAfter._sum.amount ?? 0)}  ` +
      `${spendAfter._count._all === spendBefore._count._all && spendAfter._sum.amount === spendBefore._sum.amount ? "ĐẠT" : "HỎNG"}`,
  );
  console.log(`    reservation đã chốt còn     : ${settledAfter} (bằng chứng, không xoá)`);
  console.log(`\n  KHÔNG gọi API nào. CHI PHÍ: $0.00\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
