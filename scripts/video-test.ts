import { PrismaClient } from "@prisma/client";

/**
 * One controlled video generation, for provider validation.
 *
 * Video is the most expensive call this app makes, so this script is written
 * around refusing rather than around succeeding: it prints every figure first,
 * blocks on a per-run ceiling, refuses to start when a job for the same work
 * already exists, and never retries a create.
 *
 * Usage:
 *   npx tsx scripts/video-test.ts --idiom "Spill the beans" --scene 4 --dry-run
 *   npx tsx scripts/video-test.ts --scene 4 --provider runway --model gen4_turbo:720x1280 --dry-run
 *   npx tsx scripts/video-test.ts --scene 4 --provider runway --real --limit 0.30
 *
 * Unknown flags are a hard error, not a shrug. An earlier version hard-coded
 * the provider, so `--provider runway` was silently swallowed and the run went
 * to Sora anyway - printing an openai quote for what the operator believed was
 * a Runway test. A benchmark that quietly measures the wrong vendor is worse
 * than one that refuses to start.
 */

const prisma = new PrismaClient();

const DEFAULT_MODEL = "sora-2:720x1280";
const DEFAULT_PROVIDER = "openai";

/** Every flag this script understands. Anything else stops the run. */
const KNOWN_FLAGS = new Set([
  "idiom",
  "scene",
  "provider",
  "model",
  "duration",
  "limit",
  "real",
  "dry-run",
  "prompt-file",
]);

function assertKnownFlags(): void {
  const unknown = process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => a.slice(2).split("=")[0] ?? "")
    .filter((name) => !KNOWN_FLAGS.has(name));
  if (unknown.length > 0) {
    console.log("");
    console.log(
      `  [DUNG] Khong hieu tham so: ${unknown.map((u) => `--${u}`).join(", ")}.`,
    );
    console.log(
      `  Tham so hop le: ${[...KNOWN_FLAGS].map((k) => `--${k}`).join(", ")}`,
    );
    console.log("");
    process.exitCode = 1;
    process.exit(1);
  }
}
/** How long to wait for the whole job before giving up on polling (not on it). */
const MAX_WAIT_MS = 15 * 60_000;
const POLL_INTERVAL_MS = 10_000;

/**
 * Runway's credit balance. Free: GET /organization is not billed.
 *
 * Returns null for any provider without such an endpoint, or when anything at
 * all goes wrong - a benchmark must not fail because a courtesy reading did.
 */
async function readRunwayCredits(provider: string): Promise<number | null> {
  if (provider !== "runway") return null;
  try {
    const { fetchRunwayCatalog } = await import(
      "../src/services/provider-catalog"
    );
    return (await fetchRunwayCatalog()).creditBalance;
  } catch {
    return null;
  }
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
function runLimit(): number {
  const raw = arg("limit", "");
  const value = raw === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

async function main(): Promise<void> {
  assertKnownFlags();
  const idiom = arg("idiom", "Spill the beans");
  const sceneNumber = Number(arg("scene", "4"));
  const PROVIDER = arg("provider", DEFAULT_PROVIDER);
  const MODEL = arg("model", "");
  const real = flag("real");
  const dryRun = flag("dry-run") || !real;
  const limit = runLimit();

  process.env.AI_MOCK_MODE = real ? "false" : "true";
  const { resetEnvCache } = await import("../src/lib/env");
  resetEnvCache();

  const { generateSceneVideo } = await import("../src/services/generation");
  const { spendStatus } = await import("../src/services/spend-guard");
  const { toAbsolute } = await import("../src/lib/paths");
  const fs = await import("node:fs");

  const project = await prisma.project.findFirst({
    where: { idiom: { phrase: idiom } },
    include: { idiom: true, scenes: { orderBy: { sceneNumber: "asc" } } },
  });
  const scene = project?.scenes.find((s) => s.sceneNumber === sceneNumber);
  if (!project || !scene) {
    console.log(`Khong tim thay ${idiom} canh ${sceneNumber}.`);
    process.exitCode = 1;
    return;
  }

  // Resolve the model. With --provider but no --model, take that provider's
  // only video row rather than guessing: if it has several, the operator must
  // say which, because they are priced differently.
  const rows = await prisma.modelRegistry.findMany({
    where: { provider: PROVIDER, type: "video" },
    orderBy: { price: "asc" },
  });
  if (rows.length === 0) {
    console.log(
      `\n  [DUNG] Provider "${PROVIDER}" khong co model video nao ` +
        `trong bang Mo hinh AI.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const modelId =
    MODEL !== ""
      ? MODEL
      : PROVIDER === DEFAULT_PROVIDER
        ? DEFAULT_MODEL
        : rows.length === 1
          ? (rows[0]?.modelId ?? "")
          : "";
  if (modelId === "") {
    console.log("");
    console.log(
      `  [DUNG] Provider "${PROVIDER}" co ${rows.length} model video. ` +
        `Chon bang --model:`,
    );
    for (const r of rows) {
      console.log(`    ${r.modelId}  ($${r.price}/giay)`);
    }
    console.log("");
    process.exitCode = 1;
    return;
  }
  const model = rows.find((r) => r.modelId === modelId);
  if (!model) {
    console.log(
      `\n  [DUNG] Khong tim thay model ${PROVIDER}/${modelId} ` +
        `trong bang Mo hinh AI.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const MODEL_ID = modelId;

  const { splitModelSize, billedVideoSeconds } = await import(
    "../src/domain/video-duration"
  );
  const { size } = splitModelSize(MODEL_ID);

  // Requested seconds are not billed seconds. Runway sells 5s and 10s clips
  // only; Veo is forced to 8 with a keyframe. Quoting the requested length
  // under-quotes the invoice, which is the wrong direction for a spend cap.
  const requested = Number(arg("duration", String(scene.duration)));
  const billed = billedVideoSeconds({
    provider: PROVIDER,
    model: MODEL_ID,
    size,
    requestedSeconds: requested,
    hasKeyframe: Boolean(scene.imagePath),
  });
  const estimate = Math.round(billed * model.price * 1e6) / 1e6;
  const before = await spendStatus();

  console.log("\n========== TEST VIDEO AI ==========\n");
  console.log(`  Che do        : ${real ? "THAT (co tinh tien)" : "MOCK (mien phi)"}`);
  console.log(`  Du an         : ${project.idiom.phrase} canh ${scene.sceneNumber}`);
  console.log(`  Provider      : ${PROVIDER}`);
  console.log(`  Model         : ${MODEL_ID}`);
  console.log(`  Do phan giai  : ${size}`);
  console.log(
    `  Thoi luong    : yeu cau ${requested}s` +
      (billed === requested ? "" : ` -> TINH TIEN ${billed}s`),
  );
  console.log(`  Don vi gia    : ${model.priceUnit}`);
  console.log(`  Gia           : $${model.price}/giay`);
  console.log(`  Gia kiem chung: ${model.lastVerifiedAt?.toISOString().slice(0, 10) ?? "CHUA BAO GIO"}`);
  console.log(`  UOC TINH      : $${estimate.toFixed(4)}  (${billed}s x $${model.price})`);
  console.log(`  Keyframe      : ${scene.imagePath ?? "KHONG CO"}`);
  console.log(`\n  Da chi        : $${before.spent.toFixed(6)} / $${before.cap.toFixed(2)}`);
  console.log(`  Sau khi chay  : $${(before.spent + estimate).toFixed(4)}`);
  console.log(`  Han muc lan nay: ${Number.isFinite(limit) ? `$${limit.toFixed(2)}` : "(khong dat)"}`);

  // ---- blocks, in order of tightness ------------------------------------
  if (!scene.imagePath) {
    console.log("\n  [DUNG] Canh chua co anh keyframe. Khong the lam image-to-video.\n");
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(toAbsolute(scene.imagePath))) {
    console.log("\n  [DUNG] Khong tim thay tep keyframe tren dia.\n");
    process.exitCode = 1;
    return;
  }
  if (estimate > limit) {
    console.log(
      `\n  [DUNG] Uoc tinh $${estimate.toFixed(4)} vuot han muc lan nay ` +
        `$${limit.toFixed(2)}. KHONG goi API.\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (before.spent + estimate > before.cap) {
    console.log("\n  [DUNG] Uoc tinh vuot han muc tong cua ung dung.\n");
    process.exitCode = 1;
    return;
  }

  // A replacement prompt is read HERE, before the key, and written to the
  // database later.
  //
  // The key answers "has this exact work already been paid for", and the prompt
  // is part of what makes the work exact. Computing it from the scene's current
  // prompt while sending a different one would key the record to a request
  // nobody made - and two genuinely different benchmarks on one scene would
  // collide, the second refusing to start because it believed the first had
  // already bought it.
  //
  // Reading and writing are split so that --dry-run stays read-only: a rehearsal
  // that rewrites the scene's prompt is not a rehearsal.
  const promptFile = arg("prompt-file", "");
  let replacementPrompt = "";
  if (promptFile !== "") {
    const fsMod = await import("node:fs");
    const pathMod = await import("node:path");
    const abs = pathMod.isAbsolute(promptFile)
      ? promptFile
      : pathMod.join(process.cwd(), promptFile);
    if (!fsMod.existsSync(abs)) {
      console.log(`\n  [DUNG] Khong tim thay tep prompt ${abs}\n`);
      process.exitCode = 1;
      return;
    }
    replacementPrompt = fsMod.readFileSync(abs, "utf8").trim();
    if (replacementPrompt === "") {
      console.log(`\n  [DUNG] Tep prompt ${abs} rong.\n`);
      process.exitCode = 1;
      return;
    }
  }
  const promptToSend = replacementPrompt !== "" ? replacementPrompt : scene.videoPrompt;

  // ---- idempotency: is this work already paid for? ----------------------
  const { idempotencyKey, videoKeyVariant } = await import("../src/services/generation");
  const key = idempotencyKey({
    sceneId: scene.id,
    kind: "video",
    provider: PROVIDER,
    model: MODEL_ID,
    prompt: promptToSend,
    generation: scene.retryCount,
    variant: videoKeyVariant(scene),
  });
  const existing = await prisma.providerJob.findUnique({
    where: { idempotencyKey: key },
  });
  console.log(`\n  Khoa idempotency: ${key.slice(0, 16)}...`);
  if (existing) {
    console.log(
      `  Job da ton tai  : ${existing.externalId ?? "(chua co ma)"} ` +
        `trang thai ${existing.status}, da tinh $${existing.actualCost}`,
    );
    console.log("  -> Se TIEP TUC job nay thay vi tao job moi (khong tra tien lan hai).");
  } else {
    console.log("  Job da ton tai  : khong - day se la lan tao dau tien.");
  }

  if (dryRun) {
    console.log("\n  --dry-run: khong goi API.\n");
    return;
  }

  // Now write the replacement prompt that was read above.
  //
  // It has to go through the database rather than around it: the generation
  // path reads the scene's own prompt, so a flag that changed only what this
  // script printed would describe a request nobody made. The old prompt is
  // echoed first so it can be put back.
  if (replacementPrompt !== "") {
    console.log("\n  ---- DOI PROMPT ----");
    console.log(`  Prompt CU (${scene.videoPrompt.length} ky tu):`);
    for (const l of scene.videoPrompt.split("\n")) console.log(`    | ${l}`);
    console.log(`  Prompt MOI (${replacementPrompt.length} ky tu):`);
    for (const l of replacementPrompt.split("\n")) console.log(`    > ${l}`);
    await prisma.scene.update({
      where: { id: scene.id },
      data: { videoPrompt: replacementPrompt },
    });
    scene.videoPrompt = replacementPrompt;
  }

  // ---- one permit, for one create ---------------------------------------
  //
  // The operator confirmed ONE paid create by running with --real. That buys
  // exactly one call to the create endpoint, consumed by the attempt whatever
  // the outcome. A failure that costs nothing does NOT hand the permit back:
  // an earlier benchmark authorised as one create issued four, each a real
  // attempt to charge the account, and only luck kept the bill at zero.
  // ---- the vendor's own meter, before ------------------------------------
  //
  // Read FIRST, and read again at the end. Our ledger records what we THINK a
  // call cost; the credit balance records what the vendor actually took, and
  // those have already disagreed once by $0.25. A benchmark that reports only
  // our own arithmetic is a benchmark that cannot catch that.
  const creditsBefore = await readRunwayCredits(PROVIDER);
  if (creditsBefore !== null) {
    console.log(`\n  So du truoc: ${creditsBefore} credit (= $${(creditsBefore * 0.01).toFixed(2)})`);
  }

  const { grantCreateToken } = await import("../src/services/create-token");
  await grantCreateToken({
    provider: PROVIDER,
    model: MODEL_ID,
    sceneId: scene.id,
    kind: "video",
    maxCost: Number.isFinite(limit) ? limit : estimate,
    note: `video:test --real, uoc tinh $${estimate.toFixed(6)}`,
  });
  console.log("\n  Quyen goi create: CAP 1 LAN (dung xong la het, ke ca khi that bai)");

  // ---- pin the model so routing cannot choose something else ------------
  await prisma.scene.update({
    where: { id: scene.id },
    data: {
      videoProvider: PROVIDER,
      videoModel: MODEL_ID,
      routingMode: "MANUAL",
    },
  });

  console.log("\n---------- DANG TAO ----------");
  console.log(`  Toi da cho: ${MAX_WAIT_MS / 60000} phut, hoi trang thai moi ${POLL_INTERVAL_MS / 1000}s.`);
  const started = Date.now();

  try {
    const filePath = await generateSceneVideo(scene.id);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    // Null means the scene was routed to LOCAL_MOTION and no video model ran.
    // This script exists to exercise a PAID adapter, so that is a misfire worth
    // reporting rather than a pass: it would otherwise print "success" for a run
    // that never called the provider being tested.
    if (filePath === null) {
      console.log(
        "\n  KHONG GOI API: canh nay dang o che do LOCAL_MOTION (anh + FFmpeg), " +
          "nen khong co request video nao duoc gui. Dat scene.motionSource = " +
          '"AI_VIDEO" neu muon test adapter tra phi.',
      );
      process.exitCode = 1;
      return;
    }

    const bytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;

    console.log(`\n  THANH CONG sau ${elapsed}s`);
    console.log(`  Tep    : ${filePath}`);
    console.log(`  Dung luong: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  } catch (err) {
    console.log(
      `\n  THAT BAI: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }

  // ---- what was actually recorded --------------------------------------
  const after = await spendStatus();
  const job = await prisma.providerJob.findUnique({
    where: { idempotencyKey: key },
  });
  const asset = await prisma.asset.findFirst({
    where: { sceneId: scene.id, kind: "video" },
    orderBy: { createdAt: "desc" },
  });

  console.log("\n---------- DA GHI NHAN ----------");
  if (job) {
    console.log(`  providerJobId : ${job.externalId ?? "(khong co)"}`);
    console.log(`  trang thai    : ${job.status}`);
    console.log(`  so lan thu    : ${job.attempts}`);
    console.log(`  uoc tinh      : $${job.estimatedCost.toFixed(6)}`);
    console.log(`  chi phi that  : $${job.actualCost.toFixed(6)}`);
    console.log(`  tao luc       : ${job.createdAt.toISOString()}`);
    console.log(`  xong luc      : ${job.completedAt?.toISOString() ?? "(chua)"}`);
    if (job.error) console.log(`  loi           : ${job.error}`);
  }
  if (asset) {
    console.log(`  asset         : ${asset.filePath} (${(asset.bytes / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`  provider/model: ${asset.provider}/${asset.model}`);
  }
  // ---- the vendor's own meter, after -------------------------------------
  const creditsAfter = await readRunwayCredits(PROVIDER);
  if (creditsBefore !== null && creditsAfter !== null) {
    const used = creditsBefore - creditsAfter;
    console.log(`\n---------- SO DU NHA CUNG CAP ----------`);
    console.log(`  Credit truoc : ${creditsBefore}`);
    console.log(`  Credit sau   : ${creditsAfter}`);
    console.log(`  Bi tru       : ${used} credit = $${(used * 0.01).toFixed(6)}`);
    if (job && Math.abs(used * 0.01 - job.actualCost) > 0.005) {
      // Not a rounding note. When these two disagree one of them is wrong, and
      // it is always worth knowing which before either is trusted again.
      console.log(
        `  *** LECH: so sach ghi $${job.actualCost.toFixed(6)} nhung nha cung cap ` +
          `tru $${(used * 0.01).toFixed(6)}. Kiem tra truoc khi tin con so nao. ***`,
      );
    }
  }

  console.log(`\n  Lan chay nay tieu: $${(after.spent - before.spent).toFixed(6)}`);
  console.log(`  Tong da chi      : $${after.spent.toFixed(6)} / $${after.cap.toFixed(2)}`);
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
