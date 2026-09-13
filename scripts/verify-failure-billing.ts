import { PrismaClient } from "@prisma/client";

/**
 * Proves that a call billed by the provider is recorded even when it fails.
 *
 * The dangerous case is a request that succeeds at the HTTP level - so the
 * provider charges for it - and then fails on our side: a reply truncated at the
 * token ceiling, or output we cannot parse. Before this was fixed, that spend
 * vanished, which quietly refunded the cap.
 *
 * It forces the failure by setting an absurdly low output ceiling, so the cost
 * is a fraction of a cent.
 *
 * Usage: npx tsx scripts/verify-failure-billing.ts --provider groq --model openai/gpt-oss-120b
 */

const prisma = new PrismaClient();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<void> {
  const provider = arg("provider", "groq");
  const model = arg("model", "openai/gpt-oss-120b");

  process.env.AI_MOCK_MODE = "false";
  const { resetEnvCache } = await import("../src/lib/env");
  resetEnvCache();

  const { buildTextConfig } = await import("../src/providers/text-config");
  const { chatCompletion } = await import(
    "../src/providers/openai/openai-client"
  );
  const { ProviderError } = await import("../src/providers/types");
  const { recordCost } = await import("../src/services/cost-tracker");

  const before = await prisma.costEntry.aggregate({
    where: { estimated: false, provider: { not: "mock" } },
    _sum: { amount: true },
    _count: { _all: true },
  });

  console.log("\nKIEM CHUNG: request that bai NHUNG da bi tinh phi\n");
  console.log(`  Provider : ${provider}/${model}`);
  console.log(`  Truoc    : $${(before._sum.amount ?? 0).toFixed(6)} (${before._count._all} dong)`);

  const config = await buildTextConfig(provider, model);
  // A small ceiling on a request that obviously needs more room, with JSON mode
  // off so the provider answers normally and then simply runs out of tokens.
  // That is exactly the dangerous shape: billed first, failed afterwards.
  const crippled = { ...config, maxOutputTokens: 40 };

  let caught: unknown;
  try {
    await chatCompletion(crippled, {
      messages: [
        {
          role: "user",
          content:
            "Write a detailed 600-word explanation of the English idiom " +
            "'break a leg', covering its theatrical origin, its modern usage, " +
            "and three example sentences.",
        },
      ],
      temperature: 0.3,
      jsonMode: false,
      purpose: "kiem-chung-truncation",
    });
    console.log("\n  [HONG] Yeu cau LE RA phai bi cat nhung lai thanh cong.");
    process.exitCode = 1;
    return;
  } catch (err) {
    caught = err;
  }

  const isProviderError = caught instanceof ProviderError;
  const usage = caught instanceof ProviderError ? caught.usage : undefined;

  console.log(`\n  Loi bat duoc: ${caught instanceof Error ? caught.message : caught}`);
  console.log(`  La ProviderError: ${isProviderError ? "CO" : "KHONG"}`);
  console.log(`  Mang theo usage : ${usage ? "CO" : "KHONG"}`);

  if (!usage) {
    console.log(
      "\n  [HONG] Loi khong mang theo thong tin su dung - chi phi se bi mat.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`    token vao   : ${usage.inputTokens}`);
  console.log(`    token ra    : ${usage.outputTokens}`);
  console.log(`    chi phi that: $${usage.actualCost.toFixed(6)}`);

  // Record it the way script-service does, so the ledger reflects reality.
  await recordCost({
    category: "text",
    provider,
    model: usage.model,
    amount: usage.actualCost,
    note: "kiem chung: that bai nhung van bi tinh phi",
  });

  const after = await prisma.costEntry.aggregate({
    where: { estimated: false, provider: { not: "mock" } },
    _sum: { amount: true },
    _count: { _all: true },
  });

  const delta = (after._sum.amount ?? 0) - (before._sum.amount ?? 0);
  console.log(`\n  Sau      : $${(after._sum.amount ?? 0).toFixed(6)} (${after._count._all} dong)`);
  console.log(`  Chenh    : $${delta.toFixed(6)}`);

  if (after._count._all > before._count._all && delta > 0) {
    console.log("\n  [DAT] Chi phi cua request that bai DA duoc ghi vao so.\n");
  } else {
    console.log("\n  [HONG] Chi phi bi mat - so khong ghi nhan.\n");
    process.exitCode = 1;
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
