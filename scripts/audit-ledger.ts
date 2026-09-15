/**
 * Read-only audit of what the app believes it has spent.
 *
 * Makes NO network calls and writes nothing. Run it before and after any ledger
 * repair so the change is visible rather than asserted.
 */
import { prisma } from "../src/lib/prisma";

function money(n: number): string {
  return `$${n.toFixed(6)}`;
}

async function main() {
  const auths = await prisma.batchAuthorization.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  console.log("=== BATCH AUTHORIZATIONS ===");
  for (const a of auths) {
    console.log(
      `${a.id.slice(0, 8)} batch=${a.batchId.slice(0, 8)} status=${a.status} ` +
        `ceiling=${money(a.authorizedMaxSpend)} estimated=${money(a.estimatedCost)} ` +
        `actualSpend=${money(a.actualSpend)}`,
    );
  }

  console.log("\n=== RESERVATIONS ===");
  const res = await prisma.costReservation.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
  for (const r of res) {
    console.log(
      `${r.status.padEnd(9)} est=${money(r.estimatedCost)} actual=${money(r.actualCost)} ` +
        `${r.provider}/${r.model} ${r.kind} ` +
        `key=${r.idempotencyKey.slice(0, 28)}`,
    );
  }

  console.log("\n=== PROVIDER JOBS ===");
  const jobs = await prisma.providerJob.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
  for (const j of jobs) {
    console.log(
      `${j.status.padEnd(10)} ${j.provider}/${j.model} ${j.kind.padEnd(6)} ` +
        `est=${money(j.estimatedCost)} actual=${money(j.actualCost)} ` +
        `code=${j.failureCode ?? "-"} units=${j.billedUnits ?? "-"} task=${j.externalId ?? "-"}`,
    );
  }

  console.log("\n=== COST ENTRIES (total real spend) ===");
  const entries = await prisma.costEntry.groupBy({
    by: ["provider"],
    _sum: { amount: true },
  });
  let total = 0;
  for (const e of entries) {
    const sum = e._sum.amount ?? 0;
    total += sum;
    console.log(`${e.provider.padEnd(12)} ${money(sum)}`);
  }
  console.log(`${"TOTAL".padEnd(12)} ${money(total)}`);

  console.log("\n=== MODEL FAILURE EVIDENCE ===");
  const ev = await prisma.modelFailureEvidence.findMany({ orderBy: { createdAt: "desc" } });
  for (const e of ev) {
    console.log(
      `${e.provider}/${e.model} ${e.failureCode} units=${e.billedUnits ?? "-"} ` +
        `scene=${e.sceneId?.slice(0, 8) ?? "-"} fp=${e.fingerprint.slice(0, 12)}`,
    );
  }
  if (ev.length === 0) console.log("(chưa có)");

  console.log("\n=== MODEL RELIABILITY (not OK) ===");
  const bad = await prisma.modelRegistry.findMany({
    where: { NOT: { reliability: "OK" } },
  });
  for (const m of bad) {
    console.log(`${m.provider}/${m.modelId} ${m.reliability} - ${m.reliabilityNote}`);
  }
  if (bad.length === 0) console.log("(tất cả OK)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
