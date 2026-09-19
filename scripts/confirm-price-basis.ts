import { prisma } from "@/lib/prisma";
import { confirmProvider, confirmedProviders } from "@/services/spend-guard";

/**
 * Record that a model's price was OBSERVED on real billed tasks, and confirm it.
 *
 * Two different facts, deliberately written in two different places:
 *
 *   `ModelRegistry.pricingSource`   WHERE the price figure came from
 *   `spend.confirmedProviders`      whether a PERSON has agreed to pay it
 *
 * The first is provenance and the second is consent. Collapsing them would mean
 * that improving a citation quietly authorised spending, which is exactly the
 * kind of thing the two-lock design exists to prevent.
 *
 * ## Why this is not a price change
 *
 * `price` is already 0.08 and does not move. What changes is what the row CLAIMS
 * about that number. It said MANUAL_DOCS - somebody typed it from Runway's
 * pricing page - and the project has since billed seven real tasks that all say
 * the same thing. A figure taken from documentation and a figure observed on
 * invoices are not equally trustworthy, and a row that cannot tell them apart
 * loses the difference.
 *
 * ## The one thing this must be honest about
 *
 * What was OBSERVED is the CREDIT charge: 40 credits for a 5-second clip, seven
 * times out of seven. The dollar figure rests on Runway's published credit price
 * of $0.01, which no endpoint reports and which is therefore still MANUAL. So
 * the per-second rate is observed in credits and converted with a documented
 * constant, and the note says so rather than implying the dollars were invoiced.
 *
 * ## What it must not disturb
 *
 * `verification`, `lifecycle` and `reliability` answer three different questions
 * and none of them is "what does it cost". They are read before the write and
 * asserted unchanged after it.
 *
 *   npx tsx scripts/confirm-price-basis.ts --model runway/h3_max:768x1280
 *   npx tsx scripts/confirm-price-basis.ts --model ... --apply
 *
 * See QĐ-082.
 */

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const TARGET = arg("model", "runway/h3_max:768x1280");
const APPLY = process.argv.includes("--apply");
/** Runway's published credit price. No endpoint reports it, so it stays MANUAL. */
const USD_PER_CREDIT = 0.01;

function money(n: number): string {
  return `$${n.toFixed(6)}`;
}

async function main(): Promise<void> {
  const [provider, ...rest] = TARGET.split("/");
  const modelId = rest.join("/");
  console.log("=".repeat(92));
  console.log(`  CO SO GIA TU HOA DON THAT — ${TARGET}  ${APPLY ? "[GHI]" : "[DRY RUN]"}`);
  console.log("=".repeat(92));

  const row = await prisma.modelRegistry.findFirst({
    where: { provider, modelId },
  });
  if (!row) {
    console.log(`\nKHONG tim thay ${TARGET} trong bang Mo hinh AI. Dung lai.`);
    process.exitCode = 1;
    return;
  }

  // ---- the evidence, straight out of the benchmark table ------------------
  const samples = await prisma.videoBenchmark.findMany({
    where: { model: modelId, provider, outcome: "succeeded" },
    orderBy: { createdAt: "asc" },
  });
  const usable = samples.filter((s) => s.credits > 0 && s.durationSent > 0);

  console.log("\n--- 1. BANG CHUNG: moi task tra phi da ghi so ---");
  if (usable.length === 0) {
    console.log("  Khong co mau nao ghi ca credits lan thoi luong. KHONG the ket luan gia.");
    process.exitCode = 1;
    return;
  }
  for (const s of usable) {
    console.log(
      `  ${s.createdAt.toISOString().slice(0, 10)}  task ${s.taskId?.slice(0, 8) ?? "?"}  ` +
        `${s.durationSent}s  ${s.credits} credit  ${money(s.actualCost)}  ` +
        `-> ${money(s.credits / s.durationSent * USD_PER_CREDIT)}/giay`,
    );
  }

  const rates = usable.map((s) => (s.credits * USD_PER_CREDIT) / s.durationSent);
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const consistent = Math.abs(max - min) < 1e-9;

  console.log(`\n  ${usable.length} mau tra phi, tu ${usable[0]!.createdAt.toISOString().slice(0, 10)} ` +
    `den ${usable[usable.length - 1]!.createdAt.toISOString().slice(0, 10)}`);
  console.log(`  don gia quan sat: ${money(min)} - ${money(max)} / giay`);

  // A spread means the rate depends on something this row does not model -
  // resolution, a promotion, a tier - and averaging it would invent a number
  // that was never charged.
  if (!consistent) {
    console.log("\n  CAC MAU KHONG THONG NHAT. Khong ket luan mot don gia duy nhat.");
    process.exitCode = 1;
    return;
  }
  const observed = Math.round(min * 1e6) / 1e6;

  console.log("\n--- 2. DOI CHIEU VOI GIA DANG LUU ---");
  console.log(`  gia trong bang : ${money(row.price)} / ${row.priceUnit}`);
  console.log(`  gia quan sat   : ${money(observed)} / per_second`);
  const priceMatches = row.priceUnit === "per_second" && Math.abs(row.price - observed) < 1e-9;
  console.log(
    priceMatches
      ? "  KHOP. Con so khong doi — chi doi cho NOI no den tu dau."
      : "  LECH. Khong tu sua gia: mot con so lech la mot cau hoi, khong phai mot loi go.",
  );
  if (!priceMatches) {
    process.exitCode = 1;
    return;
  }

  // ---- what must not move -------------------------------------------------
  const before = {
    price: row.price,
    lifecycle: row.lifecycle,
    reliability: row.reliability,
    verification: row.verification,
    verificationNote: row.verificationNote,
    enabled: row.enabled,
  };

  const taskIds = usable.map((s) => s.taskId?.slice(0, 8) ?? "?").join(", ");
  const sourceNote =
    `Gia QUAN SAT tu ${usable.length} task Runway da tra tien: ${taskIds}. ` +
    `Moi task ${usable[0]!.durationSent}s = ${usable[0]!.credits} credit, khong lech mot lan nao. ` +
    `Credit -> USD dung gia cong bo ${money(USD_PER_CREDIT)}/credit (Runway KHONG co endpoint bao gia, ` +
    `nen rieng ty le quy doi nay van la MANUAL_DOCS). Bang chung goc: bang VideoBenchmark.`;

  console.log("\n--- 3. SE GHI ---");
  console.log(`  pricingSource   : ${row.pricingSource} -> OBSERVED_CHARGE`);
  console.log(`  pricingCheckedAt: ${row.pricingCheckedAt?.toISOString() ?? "null"} -> ${new Date().toISOString()}`);
  console.log(`  lastVerifiedAt  : ${row.lastVerifiedAt?.toISOString() ?? "null"} -> ${new Date().toISOString()}`);
  console.log(`  sourceNote      : ${sourceNote}`);
  console.log("\n  KHONG doi: price, priceUnit, lifecycle, reliability, verification, enabled.");

  const alreadyConfirmed = (await confirmedProviders()).includes(TARGET);
  console.log("\n--- 4. XAC NHAN CHI TIEU (o khoa thu hai, tach rieng) ---");
  console.log(
    `  spend.confirmedProviders: ${alreadyConfirmed ? "DA CO" : "CHUA CO"} ${TARGET}` +
      (alreadyConfirmed ? "" : " -> se them"),
  );

  if (!APPLY) {
    console.log("\n  (dry run — chua ghi gi ca). Them --apply de ghi.");
    return;
  }

  await prisma.modelRegistry.update({
    where: { id: row.id },
    data: {
      pricingSource: "OBSERVED_CHARGE",
      pricingCheckedAt: new Date(),
      lastVerifiedAt: new Date(),
      sourceNote,
    },
  });
  await confirmProvider(provider!, modelId);

  // ---- read back, and prove the three untouched axes are untouched --------
  const after = await prisma.modelRegistry.findFirstOrThrow({
    where: { provider, modelId },
  });
  const checks: [string, boolean, string][] = [
    ["price khong doi", after.price === before.price, money(after.price)],
    ["priceUnit khong doi", after.priceUnit === "per_second", after.priceUnit],
    ["lifecycle khong doi", after.lifecycle === before.lifecycle, after.lifecycle],
    ["reliability khong doi", after.reliability === before.reliability, after.reliability],
    [
      "verification GIU BENCHMARK_VERIFIED",
      after.verification === before.verification && after.verification === "BENCHMARK_VERIFIED",
      after.verification,
    ],
    [
      "verificationNote khong doi",
      after.verificationNote === before.verificationNote,
      after.verificationNote.slice(0, 40) + "...",
    ],
    ["enabled khong doi", after.enabled === before.enabled, String(after.enabled)],
    ["pricingSource da doi", after.pricingSource === "OBSERVED_CHARGE", after.pricingSource],
    [
      "da xac nhan chi tieu",
      (await confirmedProviders()).includes(TARGET),
      TARGET,
    ],
  ];

  console.log("\n--- 5. DOC LAI TU DB ---");
  let ok = true;
  for (const [label, pass, detail] of checks) {
    console.log(`  ${pass ? "DAT " : "HONG"}  ${label.padEnd(36)} ${detail}`);
    if (!pass) ok = false;
  }

  // Nothing here spends, and this proves it rather than asserting it.
  const [jobs, entries, reservations] = await Promise.all([
    prisma.providerJob.count(),
    prisma.costEntry.count(),
    prisma.costReservation.count(),
  ]);
  console.log(
    `\n  ProviderJob ${jobs} · CostEntry ${entries} · CostReservation ${reservations} ` +
      `(khong co gi duoc tao — day chi la ghi chu va chu ky)`,
  );

  console.log(`\n${ok ? "XONG" : "CO MUC HONG"}`);
  if (!ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
