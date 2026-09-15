/**
 * What this Runway account can actually call, and how sure we are of each fact.
 *
 * READ-ONLY. One GET to /organization and nothing else. There is no POST in
 * this file, so it cannot start a generation and cannot be billed.
 *
 * WHY /organization AND NOT /models
 * ---------------------------------
 * GET /v1/models does not exist. Checked on 2026-09-15:
 *
 *     GET /organization        200
 *     GET /models              404  Cannot GET /v1/models
 *     GET /organization/usage  404
 *     GET /pricing             404
 *     GET /capabilities        404
 *
 * So the account listing is the ONLY live source, and it carries exactly two
 * things: which models exist, and their rate limits. Price, resolution,
 * duration, aspect ratio and audio support are served by no endpoint at all -
 * they come from the public docs, typed in by a person, and this script labels
 * them MANUAL every time rather than letting them blend into the live data.
 *
 *   npx tsx scripts/catalog-runway.ts            # live, plus reconciliation
 *   npx tsx scripts/catalog-runway.ts --apply    # stamp existence=ACCOUNT_LISTING
 *   npx tsx scripts/catalog-runway.ts --offline  # cache only, clearly labelled
 */
import { prisma } from "../src/lib/prisma";
import {
  applyCatalogToRegistry,
  autoRouteBlock,
  cachedCatalog,
  fetchRunwayCatalog,
  reconcileRegistry,
  type Catalog,
} from "../src/services/provider-catalog";

const APPLY = process.argv.includes("--apply");
const OFFLINE = process.argv.includes("--offline");

/** The candidates this round is about, in the order the operator ranked them. */
const WATCHLIST = [
  "wan3",
  "wan3_prime",
  "h3_max",
  "hailuo3",
  "veo3.1_fast",
  "gen4.5",
  "gen4_turbo",
];

function age(catalog: Catalog): string {
  if (catalog.source === "LIVE") return "vừa đọc xong";
  const mins = Math.round(catalog.ageMs / 60000);
  return `${mins} phút trước (${catalog.fetchedAt.toISOString()})`;
}

async function main() {
  const catalog = OFFLINE
    ? await cachedCatalog("runway")
    : await fetchRunwayCatalog();

  if (!catalog) {
    console.log("Chưa có bản lưu nào. Chạy lại khi có mạng.");
    return;
  }

  // Said once, loudly, at the top. A reader who skims must not be able to
  // mistake a stored snapshot for a live answer.
  console.log(`NGUỒN: ${catalog.source}  (${age(catalog)})`);
  console.log(`Endpoint: ${catalog.endpoint}  — KHÔNG phải /models, route đó trả 404.`);
  if (catalog.source === "CACHE") {
    console.log("*** ĐÂY LÀ DỮ LIỆU CACHE. Không dùng để quyết định chi tiền. ***");
  }
  if (catalog.creditBalance !== null) {
    console.log(`Số dư: ${catalog.creditBalance} credit (= $${(catalog.creditBalance * 0.01).toFixed(2)})`);
  }
  console.log(`Tài khoản có ${catalog.models.length} model.\n`);

  console.log("=== CÁC ỨNG VIÊN ĐANG XÉT ===");
  const keys = new Map(catalog.models.map((m) => [m.key, m]));
  for (const name of WATCHLIST) {
    const m = keys.get(name);
    console.log(
      `${name.padEnd(14)} ${m ? `CÓ    đồng thời=${m.maxConcurrent} /ngày=${m.maxDaily}` : "KHÔNG CÓ"}`,
    );
  }

  console.log("\n=== ĐỐI CHIẾU REGISTRY VỚI TÀI KHOẢN ===");
  const rows = await reconcileRegistry(catalog);
  for (const r of rows) {
    const mark = r.confirmed === null ? "?" : r.confirmed ? "OK" : "!!";
    const auto = r.autoRoutable ? "tự định tuyến" : "CHẶN tự định tuyến";
    console.log(
      `${mark} ${r.modelId.padEnd(26)} key=${(r.providerModelKey ?? "-").padEnd(13)} ` +
        `${r.lifecycle.padEnd(10)} ${r.reliability.padEnd(11)} ${auto}`,
    );
    if (r.problem) console.log(`     ^ ${r.problem}`);
  }

  console.log("\n=== NGUỒN GỐC & MỨC XÁC MINH ===");
  const registry = await prisma.modelRegistry.findMany({
    where: { provider: "runway" },
    orderBy: { price: "asc" },
  });
  for (const m of registry) {
    const block = autoRouteBlock(m);
    console.log(
      `${m.modelId.padEnd(26)} $${m.price.toFixed(2)}/s  ` +
        `tồn tại=${m.existenceSource.padEnd(16)} giá=${m.pricingSource.padEnd(12)} ` +
        `xác minh=${m.verification.padEnd(20)} ${block ? `[${block}]` : ""}`,
    );
    if (m.sourceNote) console.log(`     nguồn: ${m.sourceNote}`);
  }

  if (APPLY) {
    if (catalog.source !== "LIVE") {
      console.log("\nKhông --apply được với dữ liệu cache.");
      return;
    }
    const n = await applyCatalogToRegistry(catalog);
    console.log(`\nĐã đóng dấu existence=ACCOUNT_LISTING cho ${n} dòng.`);
  } else {
    console.log("\nChạy lại với --apply để ghi existence=ACCOUNT_LISTING vào registry.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
