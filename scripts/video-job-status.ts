import { PrismaClient } from "@prisma/client";

/**
 * Ask the vendor what happened to a video job we already created.
 *
 * This exists for the one situation that costs real money to get wrong: a
 * create succeeded, then something failed afterwards. The job may or may not
 * have been billed, and the wrong reaction - sending the request again - buys
 * a second clip. So the first move is always to ask, and asking is a GET that
 * costs nothing.
 *
 * It also reads the credit balance before and after, which is the only
 * independent check on whether a charge actually landed. Our own ledger records
 * what we THINK happened; the vendor's balance records what did.
 *
 * Usage:
 *   npx tsx scripts/video-job-status.ts --provider runway
 *   npx tsx scripts/video-job-status.ts --provider runway --id <task id>
 */

const prisma = new PrismaClient();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function runwayBalance(apiKey: string, baseUrl: string): Promise<number | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/organization`, {
      headers: {
        "X-Runway-Version": "2024-11-06",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { creditBalance?: number };
    return json.creditBalance ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const provider = arg("provider", "runway");
  const onlyId = arg("id", "");

  const { resolveApiKey, resolveBaseUrl } = await import(
    "../src/providers/provider-credentials"
  );
  const apiKey = await resolveApiKey(provider);
  const baseUrl = await resolveBaseUrl(provider);

  console.log(`\n========== JOB VIDEO ${provider.toUpperCase()} (GET, mien phi) ==========\n`);

  if (provider === "runway") {
    const balance = await runwayBalance(apiKey, baseUrl);
    console.log(
      `  So du hien tai : ${balance === null ? "khong doc duoc" : `${balance} credit (~$${(balance * 0.01).toFixed(2)})`}`,
    );
  }

  const jobs = await prisma.providerJob.findMany({
    where: {
      provider,
      kind: "video",
      ...(onlyId ? { externalId: onlyId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  console.log(`  Job trong so   : ${jobs.length}\n`);
  if (jobs.length === 0) {
    console.log("  Chua co job nao. Khong co gi de kiem tra.\n");
    return;
  }

  for (const job of jobs) {
    console.log(`  ---- ${job.externalId ?? "(chua co ma)"} ----`);
    console.log(`    So ghi cua ta : ${job.status}, uoc tinh $${job.estimatedCost.toFixed(6)}, da ghi $${job.actualCost.toFixed(6)}`);
    console.log(`    Tao luc       : ${job.createdAt.toISOString()}`);
    console.log(`    So lan thu    : ${job.attempts}`);
    if (job.error) console.log(`    Loi           : ${job.error}`);

    if (!job.externalId) {
      console.log("    -> Khong co ma ben nha cung cap, khong hoi duoc.\n");
      continue;
    }

    // What the vendor says, which is the answer that counts.
    try {
      const res = await fetch(
        `${baseUrl.replace(/\/+$/, "")}/tasks/${job.externalId}`,
        {
          headers: {
            "X-Runway-Version": "2024-11-06",
            Authorization: `Bearer ${apiKey}`,
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      const text = await res.text();
      console.log(`    Nha cung cap  : HTTP ${res.status}`);
      console.log(`    ${text.slice(0, 700)}`);
    } catch (err) {
      console.log(
        `    Nha cung cap  : loi mang ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.log("");
  }
}

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
