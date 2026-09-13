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
 *   npx tsx scripts/video-test.ts --idiom "Spill the beans" --scene 4 --real --limit 1.00
 */

const prisma = new PrismaClient();

const MODEL = "sora-2:720x1280";
const PROVIDER = "openai";
/** How long to wait for the whole job before giving up on polling (not on it). */
const MAX_WAIT_MS = 15 * 60_000;
const POLL_INTERVAL_MS = 10_000;

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
  const idiom = arg("idiom", "Spill the beans");
  const sceneNumber = Number(arg("scene", "4"));
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

  const model = await prisma.modelRegistry.findUnique({
    where: { provider_modelId: { provider: PROVIDER, modelId: MODEL } },
  });
  if (!model) {
    console.log(`Khong tim thay model ${PROVIDER}/${MODEL} trong bang Mo hinh AI.`);
    process.exitCode = 1;
    return;
  }

  const estimate =
    Math.round(scene.duration * model.price * 1e6) / 1e6;
  const before = await spendStatus();
  const { splitModelSize } = await import("../src/providers/video-config");
  const { size } = splitModelSize(MODEL);

  console.log("\n========== TEST VIDEO AI ==========\n");
  console.log(`  Che do        : ${real ? "THAT (co tinh tien)" : "MOCK (mien phi)"}`);
  console.log(`  Du an         : ${project.idiom.phrase} canh ${scene.sceneNumber}`);
  console.log(`  Provider      : ${PROVIDER}`);
  console.log(`  Model         : ${MODEL}`);
  console.log(`  Do phan giai  : ${size}`);
  console.log(`  Thoi luong    : ${scene.duration}s`);
  console.log(`  Don vi gia    : ${model.priceUnit}`);
  console.log(`  Gia           : $${model.price}/giay`);
  console.log(`  Gia kiem chung: ${model.lastVerifiedAt?.toISOString().slice(0, 10) ?? "CHUA BAO GIO"}`);
  console.log(`  UOC TINH      : $${estimate.toFixed(4)}`);
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

  // ---- idempotency: is this work already paid for? ----------------------
  const { idempotencyKey } = await import("../src/services/generation");
  const key = idempotencyKey({
    sceneId: scene.id,
    kind: "video",
    provider: PROVIDER,
    model: MODEL,
    prompt: scene.videoPrompt,
    generation: scene.retryCount,
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

  // ---- pin the model so routing cannot choose something else ------------
  await prisma.scene.update({
    where: { id: scene.id },
    data: {
      videoProvider: PROVIDER,
      videoModel: MODEL,
      routingMode: "MANUAL",
    },
  });

  console.log("\n---------- DANG TAO ----------");
  console.log(`  Toi da cho: ${MAX_WAIT_MS / 60000} phut, hoi trang thai moi ${POLL_INTERVAL_MS / 1000}s.`);
  const started = Date.now();

  try {
    const filePath = await generateSceneVideo(scene.id);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
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
