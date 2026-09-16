/**
 * Promote a model from LOW_AUTO_CANDIDATE to LOW_AUTO.
 *
 * THE SWITCH ITSELF - the one act `nominate-low-auto.ts` deliberately does not
 * perform. It writes one registry field and nothing else: no network, no cost,
 * no permit. What it grants is narrow by construction, because `LOW_AUTO` only
 * ever applies to a LOW scene that also clears `lowAutoRouteBlock`.
 *
 * DRY BY DEFAULT. Without `--apply` it prints what would change and writes
 * nothing, so the refusals below can be read before anything is decided.
 *
 * It refuses to grant unless the model is BENCHMARK_VERIFIED, reliability OK,
 * and currently a CANDIDATE - the three things the review was supposed to
 * establish. It cannot check the scene-level conditions, because those depend
 * on a scene; `dry-run-low-auto.ts` is what checks those, and it should be run
 * first and read.
 *
 *   npx tsx scripts/grant-low-auto.ts --model h3_max:768x1280
 *   npx tsx scripts/grant-low-auto.ts --model h3_max:768x1280 --apply
 *   npx tsx scripts/grant-low-auto.ts --model h3_max:768x1280 --revoke --apply
 */
import { prisma } from "../src/lib/prisma";
import { autoRouteBlock } from "../src/services/provider-catalog";
import { isAutoRoutable } from "../src/domain/enums";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const APPLY = process.argv.includes("--apply");
const REVOKE = process.argv.includes("--revoke");
const MODEL_ID = arg("model", "h3_max:768x1280");
const PROVIDER = arg("provider", "runway");

async function main() {
  const row = await prisma.modelRegistry.findFirst({
    where: { provider: PROVIDER, modelId: MODEL_ID },
  });
  if (!row) throw new Error(`Không thấy ${PROVIDER}/${MODEL_ID} trong registry.`);

  const target = REVOKE ? "LOW_AUTO_CANDIDATE" : "LOW_AUTO";
  console.log(`Model   : ${PROVIDER}/${MODEL_ID}`);
  console.log(`Trước   : ${row.lifecycle} / ${row.verification} / ${row.reliability}`);
  console.log(`Sau     : ${target}`);

  if (!REVOKE) {
    if (row.lifecycle !== "LOW_AUTO_CANDIDATE") {
      // The candidate state IS the review. Skipping it would mean granting
      // automatic spending to a model nobody was asked about.
      throw new Error(
        `${MODEL_ID} đang ở ${row.lifecycle}, không phải LOW_AUTO_CANDIDATE. ` +
          `Phải đi qua bước đề cử trước — đó chính là bước để người duyệt đọc bằng chứng.`,
      );
    }
    if (row.verification !== "BENCHMARK_VERIFIED") {
      throw new Error(
        `${MODEL_ID} mới ở mức ${row.verification}. LOW_AUTO phải dựa trên clip đã trả tiền và đã chấm điểm.`,
      );
    }
    if (row.reliability !== "OK") {
      throw new Error(
        `${MODEL_ID} có độ tin cậy ${row.reliability}. Không cấp quyền tự định tuyến cho model đang có vấn đề.`,
      );
    }
  }

  if (!APPLY) {
    console.log("\n(Thử khô — chưa ghi gì. Thêm --apply để thực hiện.)");
    console.log("Hãy chạy `npx tsx scripts/dry-run-low-auto.ts` và đọc kết quả trước.");
    return;
  }

  await prisma.modelRegistry.updateMany({
    where: { provider: PROVIDER, modelId: MODEL_ID },
    data: {
      lifecycle: target,
      replacementNote: REVOKE
        ? "Da THU HOI quyen LOW_AUTO, quay lai trang thai ung vien."
        : "Duoc cap LOW_AUTO: router tu chon CHI cho canh LOW, va chi khi qua " +
          "het cong lowAutoRouteBlock (keyframe, <=2 nhan vat, camera khoa, ngan sach).",
    },
  });

  const after = await prisma.modelRegistry.findFirst({
    where: { provider: PROVIDER, modelId: MODEL_ID },
  });
  console.log(`\nĐã ghi  : ${after!.lifecycle}`);
  console.log(`autoRouteBlock : ${autoRouteBlock(after!) ?? "không chặn ở tầng này"}`);
  // Printed for all three complexities so the narrowness of the grant is
  // visible at the moment it is given, rather than assumed.
  for (const complexity of ["LOW", "MEDIUM", "HIGH"] as const) {
    console.log(
      `  cảnh ${complexity.padEnd(6)} -> ${
        isAutoRoutable(after!.lifecycle, { complexity })
          ? "router ĐƯỢC xét (vẫn phải qua cổng LOW_AUTO)"
          : "router KHÔNG được xét"
      }`,
    );
  }
  console.log(
    "\nLưu ý: quyền này KHÔNG tự cấp phép chi tiêu. Mỗi clip vẫn cần một " +
      "BatchAuthorization có lowAutoApproved = true, hoặc CREATE_ATTEMPT_TOKEN.",
  );
}

main()
  .catch((e) => {
    console.error(String(e));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
