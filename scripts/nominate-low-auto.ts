/**
 * Record that a model has been nominated for automatic LOW routing.
 *
 * A NOMINATION, not a switch. `isAutoRoutable("LOW_AUTO_CANDIDATE")` returns
 * false, so the router keeps refusing to pick the model on its own - the state
 * says "the evidence has been gathered and reviewed", which is a different
 * claim from "it is now in production". A state that started routing the moment
 * it was written would make the review it exists for impossible.
 *
 * Writes one registry row and nothing else. No network, no cost.
 *
 *   npx tsx scripts/nominate-low-auto.ts --model h3_max:768x1280
 *   npx tsx scripts/nominate-low-auto.ts --model h3_max:768x1280 --apply
 */
import { prisma } from "../src/lib/prisma";
import { autoRouteBlock } from "../src/services/provider-catalog";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const APPLY = process.argv.includes("--apply");
const MODEL_ID = arg("model", "h3_max:768x1280");

async function main() {
  const row = await prisma.modelRegistry.findFirst({
    where: { provider: "runway", modelId: MODEL_ID },
  });
  if (!row) throw new Error(`Không thấy ${MODEL_ID}.`);

  console.log(`Model      : runway/${MODEL_ID}`);
  console.log(`Trước      : ${row.lifecycle} / ${row.verification} / ${row.reliability}`);

  if (row.verification !== "BENCHMARK_VERIFIED") {
    // A nomination has to rest on something. Without a scored clip there is no
    // evidence to review, and the state would be a label pretending to be one.
    throw new Error(
      `${MODEL_ID} mới ở mức ${row.verification}. Chỉ đề cử model đã BENCHMARK_VERIFIED.`,
    );
  }

  if (!APPLY) {
    console.log(`Sau        : LOW_AUTO_CANDIDATE / ${row.verification} / ${row.reliability}`);
    console.log("\n(Thử khô. Thêm --apply để ghi.)");
    return;
  }

  await prisma.modelRegistry.updateMany({
    where: { provider: "runway", modelId: MODEL_ID },
    data: {
      lifecycle: "LOW_AUTO_CANDIDATE",
      replacementNote:
        "Ung vien LOW_AUTO. 4 mau benchmark, 3 mau co guardrail camera dat 9,07 " +
        "trung binh (do lech chuan 0,12). CHUA duoc auto-route.",
    },
  });

  const after = await prisma.modelRegistry.findFirst({
    where: { provider: "runway", modelId: MODEL_ID },
  });
  console.log(`Sau        : ${after!.lifecycle} / ${after!.verification} / ${after!.reliability}`);
  console.log(`Router     : ${autoRouteBlock(after!) ?? "CHO PHEP TU DINH TUYEN"}`);
}

main()
  .catch((e) => {
    console.error(String(e));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
