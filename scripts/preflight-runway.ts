import { PrismaClient } from "@prisma/client";

/**
 * Free checks before spending anything on Runway.
 *
 * Every request this script makes is a GET or an intentionally-invalid POST -
 * nothing here can start a generation, so nothing here can be billed. The one
 * job is to answer "would the paid call work, and what would it cost" before
 * the paid call is made.
 *
 * It refuses rather than warns. A preflight that prints a warning and carries
 * on is just a slower way of spending the money.
 *
 * Usage:
 *   npx tsx scripts/preflight-runway.ts --idiom "Spill the beans" --scene 4 --limit 0.30
 */

const prisma = new PrismaClient();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "[DAT ]" : "[HONG]"} ${label.padEnd(28)} ${detail}`);
}

async function main(): Promise<void> {
  const idiom = arg("idiom", "Spill the beans");
  const sceneNumber = Number(arg("scene", "4"));
  const limit = Number(arg("limit", "0.30"));

  const { resolvedEnvVarName, envVarCandidates } = await import("../src/lib/env");
  const { resolveApiKey, resolveBaseUrl } = await import(
    "../src/providers/provider-credentials"
  );
  const { billedVideoSeconds, splitModelSize } = await import(
    "../src/domain/video-duration"
  );
  const { spendStatus } = await import("../src/services/spend-guard");
  const { toAbsolute } = await import("../src/lib/paths");
  const { RUNWAY_API_VERSION } = await import(
    "../src/providers/runway/runway-video-client"
  );
  const fs = await import("node:fs");

  console.log("\n========== PREFLIGHT RUNWAY (mien phi) ==========\n");

  // ---- 1. key present, and under which name ------------------------------
  console.log("--- 1. API key ---");
  const varName = resolvedEnvVarName("runway");
  check(
    "Bien moi truong",
    varName !== null,
    varName !== null
      ? `doc tu ${varName}`
      : `khong thay: ${envVarCandidates("runway").join(" / ")}`,
  );

  let apiKey = "";
  try {
    apiKey = await resolveApiKey("runway");
  } catch (err) {
    check("Giai ma key", false, err instanceof Error ? err.message : String(err));
  }
  // Never print the key. Length and prefix are enough to tell a real key from
  // a placeholder, and neither can be used to authenticate.
  check(
    "Hinh dang key",
    apiKey.length > 20,
    `do dai ${apiKey.length}, tien to "${apiKey.slice(0, 4)}...", phan con lai bi che`,
  );

  const baseUrl = await resolveBaseUrl("runway");
  console.log(`         Endpoint                     ${baseUrl}`);
  console.log(`         X-Runway-Version             ${RUNWAY_API_VERSION}`);

  if (failures > 0) {
    console.log("\n  [DUNG] Chua co key dung. Khong goi gi them.\n");
    process.exitCode = 1;
    return;
  }

  // ---- 2. does the key authenticate at all? ------------------------------
  //
  // A GET against the tasks collection costs nothing. What matters is the
  // status code: 401/403 means the key is wrong, anything else means the key
  // was accepted and we are only arguing about the path.
  // GET /organization is free and does three jobs at once: it proves the key
  // authenticates, it reports the credit balance, and - the important one - it
  // returns the models this account can actually call. That last part is the
  // live model list step 1 taught us to demand: Groq removed a model we had
  // seeded, and trusting the seed cost us a 404 on the first real run.
  console.log("\n--- 2. Hoi thang nha cung cap (GET, khong tinh tien) ---");
  let authOk = false;
  let credits: number | null = null;
  let liveModels: string[] = [];
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/organization`, {
      method: "GET",
      headers: {
        "X-Runway-Version": RUNWAY_API_VERSION,
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    console.log(`         GET /organization            -> HTTP ${res.status}`);
    authOk = res.status !== 401 && res.status !== 403;
    if (authOk) {
      const json = (await res.json()) as {
        creditBalance?: number;
        tier?: { models?: Record<string, unknown> };
      };
      credits = json.creditBalance ?? null;
      liveModels = Object.keys(json.tier?.models ?? {}).sort();
    }
  } catch (err) {
    console.log(
      `         GET /organization            -> loi mang: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  check("Key duoc chap nhan", authOk, authOk ? "khong bi 401/403" : "bi 401/403");
  console.log(
    `         So du                        ${credits === null ? "API khong tra ve" : `${credits} credit (~$${(credits * 0.01).toFixed(2)})`}`,
  );
  console.log(`         Model API bao co             ${liveModels.length} model`);

  // ---- 3. the model row we would actually use ----------------------------
  console.log("\n--- 3. Model ---");
  const rows = await prisma.modelRegistry.findMany({
    where: { provider: "runway", type: "video" },
    orderBy: { price: "asc" },
  });
  const model = rows[0];
  check("Co model video", model !== undefined, `${rows.length} dong trong ModelRegistry`);
  if (!model) {
    console.log("\n  [DUNG] Khong co model nao de chay.\n");
    process.exitCode = 1;
    return;
  }
  const { apiModel, size } = splitModelSize(model.modelId);
  const [rawW, rawH] = size.split("x").map(Number);
  const w = rawW ?? 0;
  const h = rawH ?? 0;
  const ratio = w && h ? `${w}:${h}` : "?";
  const aspect = w && h ? (h > w ? "9:16 (doc)" : "ngang") : "?";
  console.log(`         Model registry               ${model.modelId}`);
  console.log(`         Ten gui len API              ${apiModel}`);
  console.log(`         Resolution                   ${size}  (ratio "${ratio}")`);
  console.log(`         Khung hinh                   ${aspect}`);
  check(
    "Image-to-video",
    model.supportsImageToVideo,
    model.supportsImageToVideo ? "co co supportsImageToVideo" : "model khong ho tro",
  );
  // The seed's model name checked against the vendor's OWN list, not its docs.
  check(
    "API XAC NHAN co model nay",
    liveModels.length === 0 || liveModels.includes(apiModel),
    liveModels.length === 0
      ? "khong lay duoc danh sach - KHONG kiem chung duoc"
      : liveModels.includes(apiModel)
        ? `"${apiModel}" co trong danh sach live`
        : `"${apiModel}" KHONG CO trong danh sach live`,
  );
  check("Doc 9:16", h > w, `${w}x${h}`);
  console.log(
    `         Gia kiem chung               ${model.lastVerifiedAt?.toISOString().slice(0, 10) ?? "CHUA BAO GIO"}`,
  );

  // ---- 4. the scene and its keyframe -------------------------------------
  console.log("\n--- 4. Canh va keyframe ---");
  const project = await prisma.project.findFirst({
    where: { idiom: { phrase: idiom } },
    include: { idiom: true, scenes: { orderBy: { sceneNumber: "asc" } } },
  });
  const scene = project?.scenes.find((s) => s.sceneNumber === sceneNumber);
  check("Tim thay canh", Boolean(scene), `${idiom} canh ${sceneNumber}`);
  if (!project || !scene) {
    console.log("\n  [DUNG]\n");
    process.exitCode = 1;
    return;
  }
  const kf = scene.imagePath;
  check("Canh co keyframe", Boolean(kf), kf ?? "khong co");
  let kfBytes = 0;
  if (kf) {
    const abs = toAbsolute(kf);
    const exists = fs.existsSync(abs);
    kfBytes = exists ? fs.statSync(abs).size : 0;
    check("Keyframe tren dia", exists, `${(kfBytes / 1024 / 1024).toFixed(2)} MB`);
    // Runway takes the image as a base64 data URI inside the JSON body, which
    // inflates it by about a third. Vendors cap data URIs; being close to the
    // cap is worth knowing before the request, though a rejection here is a
    // free 400 rather than a charge.
    const b64MB = (kfBytes * 4) / 3 / 1024 / 1024;
    console.log(
      `         Kich thuoc sau base64        ${b64MB.toFixed(2)} MB` +
        (b64MB > 3.3 ? "  <-- VUOT NGUONG 3.3MB thuong gap" : ""),
    );
  }
  check("Canh co videoPrompt", scene.videoPrompt.trim().length > 0, `${scene.videoPrompt.length} ky tu`);

  // ---- 5. what it would cost ---------------------------------------------
  console.log("\n--- 5. Chi phi ---");
  const requested = Number(arg("duration", String(scene.duration)));
  const billed = billedVideoSeconds({
    provider: "runway",
    size,
    requestedSeconds: requested,
    hasKeyframe: Boolean(kf),
  });
  const estimate = Math.round(billed * model.price * 1e6) / 1e6;
  const status = await spendStatus();
  console.log(`         Thoi luong yeu cau           ${requested}s`);
  console.log(`         Thoi luong BI TINH TIEN      ${billed}s`);
  console.log(`         Gia                          $${model.price}/giay`);
  console.log(`         UOC TINH                     $${estimate.toFixed(4)}`);
  console.log(`         Da chi                       $${status.spent.toFixed(6)} / $${status.cap.toFixed(2)}`);
  console.log(`         Sau khi chay                 $${(status.spent + estimate).toFixed(6)}`);
  console.log(`         Hard limit                   $${limit.toFixed(2)}`);
  check(
    "Uoc tinh <= hard limit",
    estimate <= limit,
    `$${estimate.toFixed(4)} vs $${limit.toFixed(2)}`,
  );
  check(
    "Con trong han muc tong",
    status.spent + estimate <= status.cap,
    `con lai $${(status.cap - status.spent).toFixed(6)}`,
  );
  if (credits !== null) {
    const needed = Math.ceil(estimate / 0.01);
    check(
      "Du credit ben Runway",
      credits >= needed,
      `can ~${needed} credit, dang co ${credits}`,
    );
  }

  // ---- verdict ------------------------------------------------------------
  console.log("\n---------- KET LUAN ----------");
  if (failures === 0) {
    console.log("  PREFLIGHT DAT. Co the chay video:test --real.\n");
  } else {
    console.log(`  PREFLIGHT HONG: ${failures} muc khong dat. KHONG goi API tra phi.\n`);
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
