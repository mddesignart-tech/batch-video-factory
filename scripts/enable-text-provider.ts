import { PrismaClient } from "@prisma/client";

/**
 * Switch a text provider on for real use, from the command line.
 *
 * Does exactly what the two admin pages do - enter prices, enable the model,
 * confirm the provider/model pair - but scriptable, so a setup can be repeated
 * or checked into notes.
 *
 * Usage:
 *   npx tsx scripts/enable-text-provider.ts --provider ollama --model llama3.1
 *   npx tsx scripts/enable-text-provider.ts --provider openai --model gpt-4o-mini \
 *        --price-in 0.00015 --price-out 0.0006
 *   npx tsx scripts/enable-text-provider.ts --provider ollama --model llama3.1 --revoke
 *
 * It refuses to confirm a paid model with no price, exactly like the UI does:
 * a $0 price makes every estimate and every budget check silently evaluate to
 * zero, which is how an unexpected bill happens.
 */

const prisma = new PrismaClient();

const LOCAL_FREE = new Set(["ollama", "lmstudio"]);
const CONFIRM_KEY = "spend.confirmedProviders";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function confirmed(): Promise<string[]> {
  const row = await prisma.setting.findUnique({ where: { key: CONFIRM_KEY } });
  if (!row) return [];
  try {
    const v: unknown = JSON.parse(row.valueJson);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function writeConfirmed(list: string[]): Promise<void> {
  const valueJson = JSON.stringify([...new Set(list)]);
  await prisma.setting.upsert({
    where: { key: CONFIRM_KEY },
    create: { key: CONFIRM_KEY, valueJson },
    update: { valueJson },
  });
}

async function main(): Promise<void> {
  const provider = arg("provider");
  const modelId = arg("model");
  const revoke = process.argv.includes("--revoke");

  if (!provider || !modelId) {
    console.error(
      "Thieu tham so. Vi du:\n" +
        "  npx tsx scripts/enable-text-provider.ts --provider ollama --model llama3.1",
    );
    process.exitCode = 1;
    return;
  }

  const key = `${provider}/${modelId}`;
  const model = await prisma.modelRegistry.findUnique({
    where: { provider_modelId: { provider, modelId } },
  });

  if (!model) {
    console.error(
      `Khong tim thay model ${key} trong bang Mo hinh AI.\n` +
        `Chay "npm run seed" truoc, hoac them model trong giao dien.`,
    );
    process.exitCode = 1;
    return;
  }

  if (revoke) {
    await writeConfirmed((await confirmed()).filter((c) => c !== key));
    await prisma.modelRegistry.update({
      where: { id: model.id },
      data: { enabled: false },
    });
    console.log(`Da thu hoi quyen va tat model ${key}.`);
    return;
  }

  const priceIn = arg("price-in");
  const priceOut = arg("price-out");
  const isFree = LOCAL_FREE.has(provider);

  if (priceIn !== undefined || priceOut !== undefined) {
    await prisma.modelRegistry.update({
      where: { id: model.id },
      data: {
        price: priceIn !== undefined ? Number(priceIn) : model.price,
        priceOutput: priceOut !== undefined ? Number(priceOut) : model.priceOutput,
      },
    });
  }

  const refreshed = await prisma.modelRegistry.findUniqueOrThrow({
    where: { id: model.id },
  });

  if (!isFree && refreshed.price <= 0 && refreshed.priceOutput <= 0) {
    console.error(
      `TU CHOI: ${key} chua co gia.\n` +
        `Nhap gia that truoc, vi du:\n` +
        `  --price-in 0.00015 --price-out 0.0006\n` +
        `Model gia 0 se lam moi uoc tinh va moi kiem tra ngan sach cho ra 0.`,
    );
    process.exitCode = 1;
    return;
  }

  await prisma.modelRegistry.update({
    where: { id: refreshed.id },
    data: { enabled: true },
  });
  await writeConfirmed([...(await confirmed()), key]);

  console.log(`\nDa bat va cho phep goi API that: ${key}`);
  console.log(`  Gia input : $${refreshed.price} / 1k token`);
  console.log(`  Gia output: $${refreshed.priceOutput} / 1k token`);
  if (isFree) {
    console.log(`  Ghi chu   : chay cuc bo, chi phi that luon $0.00`);
  }

  const capRow = await prisma.setting.findUnique({ where: { key: "spend.cap" } });
  const cap = capRow ? (JSON.parse(capRow.valueJson) as number) : 0.5;
  const spent = await prisma.costEntry.aggregate({
    where: { estimated: false, provider: { not: "mock" } },
    _sum: { amount: true },
  });
  console.log(`  Han muc   : $${cap.toFixed(2)}`);
  console.log(`  Da chi    : $${(spent._sum.amount ?? 0).toFixed(4)}`);
  console.log(
    `\nBuoc cuoi: dat AI_MOCK_MODE=false trong .env roi khoi dong lai ung dung.\n`,
  );
}

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
