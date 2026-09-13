import { PrismaClient } from "@prisma/client";

/**
 * Pre-flight check before spending anything on OpenAI.
 *
 * Answers, in order, the four questions that decide whether a real call is
 * safe: is there a key, is the model in our registry, does the vendor still
 * serve that model, and what will it cost. Every step is free - listing models
 * is an unbilled endpoint - so this can be run as often as you like.
 *
 * Usage: npx tsx scripts/preflight-openai.ts [--type image|text]
 */

const prisma = new PrismaClient();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value ?? fallback;
}

/** Never print a key. Length and last four characters are enough to identify it. */
function describeKey(key: string): string {
  if (key.length === 0) return "(trong)";
  return `co key, dai ${key.length} ky tu, ket thuc ...${key.slice(-4)}`;
}

async function main(): Promise<void> {
  const type = arg("type", "image") as "image" | "text";

  process.env.AI_MOCK_MODE = "false";
  const { resetEnvCache } = await import("../src/lib/env");
  resetEnvCache();

  const { resolveApiKey, resolveBaseUrl } = await import(
    "../src/providers/provider-credentials"
  );
  const { discoverModels } = await import("../src/services/model-discovery");
  const { splitModelTier } = await import("../src/providers/image-config");
  const { spendStatus } = await import("../src/services/spend-guard");

  console.log(`\n=== KIEM TRA TRUOC KHI GOI OPENAI (${type}) ===\n`);

  // 1 - key ------------------------------------------------------------------
  let apiKey = "";
  try {
    apiKey = await resolveApiKey("openai");
  } catch (err) {
    console.log("1. API key      : KHONG CO");
    console.log(`   ${err instanceof Error ? err.message : String(err)}`);
    console.log("\n   Them dong sau vao tep .env roi chay lai:");
    console.log("   OPENAI_API_KEY=sk-...\n");
    process.exitCode = 1;
    return;
  }
  console.log(`1. API key      : ${describeKey(apiKey)}`);
  console.log(`   Endpoint     : ${await resolveBaseUrl("openai")}`);

  // 2 - registry -------------------------------------------------------------
  const registry = await prisma.modelRegistry.findMany({
    where: { provider: "openai", type },
    orderBy: { price: "asc" },
  });
  console.log(`\n2. Model trong bang Mo hinh AI: ${registry.length}`);
  for (const m of registry) {
    const price =
      type === "text"
        ? `$${m.price}/1k vao, $${m.priceOutput}/1k ra`
        : `$${m.price}/anh`;
    console.log(`   ${m.enabled ? "[BAT]" : "[TAT]"} ${m.modelId.padEnd(24)} ${price}`);
  }

  // 3 - still served upstream? ----------------------------------------------
  console.log(`\n3. Hoi OpenAI xem model nao con phuc vu...`);
  const discovery = await discoverModels("openai", type);
  if (!discovery.ok) {
    console.log(`   THAT BAI: ${discovery.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`   OpenAI dang phuc vu ${discovery.models.length} model ${type}:`);
  for (const m of discovery.models) {
    console.log(`     ${m.known ? "(da co trong bang)" : "(chua co trong bang)"} ${m.id}`);
  }
  if (discovery.stale.length > 0) {
    console.log(`\n   CANH BAO - model trong bang KHONG con duoc phuc vu:`);
    for (const id of discovery.stale) console.log(`     ${id}`);
    console.log("   Goi model nay se bi loi 404. Hay cap nhat bang Mo hinh AI.");
  } else {
    console.log("\n   Khong co model lac hau nao trong bang.");
  }

  // 4 - cost ----------------------------------------------------------------
  const status = await spendStatus();
  console.log(`\n4. Han muc chi tieu`);
  console.log(`   Tran     : $${status.cap.toFixed(2)}`);
  console.log(`   Da chi   : $${status.spent.toFixed(6)}`);
  console.log(`   Con lai  : $${(status.cap - status.spent).toFixed(6)}`);

  if (type === "image") {
    const usable = registry.filter((m) => m.price > 0);
    console.log(`\n   Uoc tinh cho bai test (2 anh chuan + 9 anh canh = 11 anh):`);
    for (const m of usable) {
      const { quality } = splitModelTier(m.modelId);
      const total = m.price * 11;
      const fits = total <= status.cap - status.spent;
      console.log(
        `     ${quality.padEnd(7)} $${m.price.toFixed(3)}/anh -> $${total.toFixed(3)} ${
          fits ? "(trong han muc)" : "(VUOT han muc)"
        }`,
      );
    }
  }

  console.log("\n=== KET LUAN ===");
  const ready =
    apiKey.length > 0 && discovery.ok && discovery.models.length > 0;
  console.log(
    ready
      ? "San sang goi API that. Bat model muon dung trong trang Mo hinh AI, xac nhan chi tieu, roi chay bai test."
      : "Chua san sang. Xem cac muc bao loi o tren.",
  );
  console.log("");
}

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
