/**
 * Ask Runway what it holds, and make that the stored figure.
 *
 * One `GET /organization`. Free, and there is no POST in the path it takes.
 *
 * Worth having as its own command because the answer decays: a balance read on
 * Monday is a claim about Monday, and the app spent days answering budget
 * questions from a figure that was 304 credits out of date.
 *
 *   npx tsx scripts/refresh-runway-balance.ts
 */
import { prisma } from "../src/lib/prisma";
import {
  providerSpendBreakdown,
  refreshRunwayBalance,
  USD_PER_RUNWAY_CREDIT,
} from "../src/services/provider-budget";

async function main() {
  const before = (await providerSpendBreakdown()).find((r) => r.provider === "runway");
  console.log(
    `Trước : $${(before?.remainingUsd ?? 0).toFixed(6)} ` +
      `[${before?.budget?.source ?? "?"}]` +
      (before?.budget?.checkedAt ? ` đọc lúc ${before.budget.checkedAt}` : " chưa đọc lần nào"),
  );

  const r = await refreshRunwayBalance();
  console.log(`\nGET /organization : ${r.ok ? "THÀNH CÔNG" : "THẤT BẠI"} — ${r.note}`);
  if (r.ok) {
    console.log(`Số dư LIVE        : ${r.credits} credit = $${(r.usd ?? 0).toFixed(6)}`);
    console.log(`Quy đổi           : ${1 / USD_PER_RUNWAY_CREDIT} credit = $1 (luật của app)`);
  } else {
    console.log(
      `Đang dùng         : $${(r.effectiveUsd ?? 0).toFixed(6)} [${r.source}]` +
        (r.cacheAgeHours !== null ? ` — cũ ${r.cacheAgeHours} giờ` : ""),
    );
    console.log("KHÔNG coi số này là số dư hiện tại khi quyết định chi.");
  }

  const after = (await providerSpendBreakdown()).find((r2) => r2.provider === "runway");
  console.log(
    `\nSau   : $${(after?.remainingUsd ?? 0).toFixed(6)} ` +
      `[${after?.budget?.source ?? "?"}] — sổ nội bộ ghi đã chi $${(after?.spentUsd ?? 0).toFixed(6)}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
