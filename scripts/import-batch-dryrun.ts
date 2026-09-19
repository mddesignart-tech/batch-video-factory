import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * A whole batch of storyboards, taken as far as it can go WITHOUT SPENDING.
 *
 *   IMPORT -> VALIDATE -> CHARACTER RESOLVE -> ROUTING -> COST PREVIEW
 *          -> READY / BLOCKED
 *
 * and then it stops. Every step here is reads and row-writes: no provider is
 * contacted, no media is made, and the batch is left `PLANNED` with a `DRAFT`
 * authorisation, which permits no spending at all.
 *
 * ## Why this exists as a script rather than only as a test
 *
 * A test asserts that the pieces behave. This answers the question an operator
 * actually has before approving money - "what is this batch, what will it buy,
 * and what is wrong with it" - in one screen, against real rows in the real
 * database, using the same functions the run itself uses. A dry run that used a
 * different code path would be a simulation of something else.
 *
 * ## The deliberately broken video
 *
 * `examples/batch-import-3` contains one storyboard pinned to a model that does
 * not exist. It is there so this script can demonstrate the rule that matters
 * most for a batch: ONE BAD VIDEO IS ONE BAD VIDEO. The other two import,
 * price and report as usual, and the skipped one is named with its reason
 * rather than quietly dropped.
 *
 * ## A SCRATCH DATABASE, not the real one
 *
 * Importing creates `Character` rows, and a `Character` is not owned by the
 * batch that first mentioned it - deleting the batch afterwards would leave
 * "BatchBo" and friends in the production character table forever. So this runs
 * against its own database and its own data directory, built from the
 * migrations, exactly as `import-e2e-mock.ts` does. A dry run that dirties the
 * real tables is not a dry run.
 *
 *   npx tsx scripts/import-batch-dryrun.ts                       # dry, $0
 *   npx tsx scripts/import-batch-dryrun.ts --source <dir>        # another folder
 *   npx tsx scripts/import-batch-dryrun.ts --keep                # keep the scratch DB
 */

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const SOURCE = arg("source", "examples/batch-import-3");
const KEEP = process.argv.includes("--keep");

const ROOT = process.cwd();
const SCRATCH = path.join(ROOT, "data", ".batch-dryrun");
const DB_FILE = path.join(SCRATCH, "dryrun.db");

// Set BEFORE anything imports Prisma or the paths module, both of which read
// these once at module load.
process.env.DATA_DIR = SCRATCH;
process.env.DATABASE_URL = `file:${DB_FILE.replace(/\\/g, "/")}`;
process.env.AI_MOCK_MODE = "true";
process.env.JOB_WORKER_ENABLED = "false";

function money(n: number): string {
  return `$${n.toFixed(6)}`;
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(30)} ${value}`);
}

async function main(): Promise<void> {
  console.log("=".repeat(86));
  console.log("  DRY-RUN LO NHAP NHIEU STORYBOARD — khong goi API nao, khong chi mot dong");
  console.log("=".repeat(86));

  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  execFileSync("npx", ["tsx", "scripts/seed.ts"], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  // Imported dynamically, AFTER the environment above is in place: a static
  // import would connect Prisma to the production database before the first
  // line of `main` runs.
  const { prisma } = await import("@/lib/prisma");
  const { isMockMode } = await import("@/lib/env");
  const { peekCreateToken } = await import("@/services/create-token");
  const { totalRealSpend } = await import("@/services/spend-guard");
  const { materialiseImport, scanImportSource, validateImport } = await import(
    "@/services/storyboard-import"
  );
  const { preflightImportedBatch } = await import("@/services/import-preflight");

  line("DATA_DIR", SCRATCH);
  line("DATABASE_URL", process.env.DATABASE_URL!);

  const spendBefore = await totalRealSpend();
  const jobsBefore = await prisma.providerJob.count();
  line("Nguon", SOURCE);
  line("AI_MOCK_MODE", String(isMockMode()));
  line("CREATE_ATTEMPT_TOKEN", String((await peekCreateToken()) ?? "null"));
  line("Da chi truoc khi chay", money(spendBefore));

  // ---- 1. IMPORT + VALIDATE -------------------------------------------
  console.log("\n--- 1. IMPORT + VALIDATE ---");
  const scan = scanImportSource(path.resolve(SOURCE));
  const validated = await validateImport(scan);
  const errors = validated.issues.filter((i) => i.level === "error");
  const warnings = validated.issues.filter((i) => i.level === "warning");
  line("Video doc duoc", String(validated.videos.length));
  line("Loi", String(errors.length));
  line("Canh bao", String(warnings.length));
  for (const e of errors) {
    console.log(`    LOI  [${e.videoId ?? "-"}] ${e.code}: ${e.message}`);
  }
  for (const w of warnings) {
    console.log(`    CB   [${w.videoId ?? "-"}] ${w.code}: ${w.message}`);
  }

  // ---- 2. MATERIALISE, partial allowed ---------------------------------
  console.log("\n--- 2. TAO ROW (partial: video hong bi bo qua, co neu ten) ---");
  const created = await materialiseImport(validated, {
    batchName: `Dry-run ${new Date().toISOString().slice(0, 16)}`,
    maxCostPerVideo: 1.5,
    maxCostForBatch: 5,
    allowPartial: true,
  });
  line("Lo", created.batchId);
  line("Video da nhap", String(created.projects.length));
  line("Anh keyframe chep vao", String(created.copiedImages));
  line("Anh nhan vat dung lai", String(created.reusedCharacterImages));
  line("Video BI BO QUA", String(created.skipped.length));
  for (const s of created.skipped) {
    console.log(`    BO QUA  ${s.title}: ${s.reasons.join(" | ")}`);
  }

  // ---- 3. CHARACTER RESOLVE + 4. ROUTING + 5. COST PREVIEW -------------
  console.log("\n--- 3/4/5. NHAN VAT + DINH TUYEN + DU TOAN ---");
  const pre = await preflightImportedBatch(created.batchId);

  console.log("\n  NHAN VAT TRONG CA LO");
  for (const c of pre.characters) {
    console.log(
      `    ${c.name.padEnd(12)} ${c.readiness.padEnd(26)} ` +
        `${c.referenceCount} anh  ${c.sceneCount} canh` +
        (c.missingFields.length > 0 ? `  thieu: ${c.missingFields.join(", ")}` : "") +
        (c.unlockedAttributes.length > 0
          ? `  khong khoa: ${c.unlockedAttributes.join(", ")}`
          : ""),
    );
  }

  for (const v of pre.videos) {
    const seconds = v.scenes.reduce((n, s) => n + s.duration, 0);
    console.log(`\n  ${v.lifecycle.padEnd(10)} ${v.title}`);
    line("canh / giay", `${v.sceneCount} / ${seconds.toFixed(1)}s`);
    line("LOCAL_MOTION / VIDEO_AI", `${v.localMotionCount} / ${v.videoAiCount}`);
    line(
      "anh",
      `${v.counts.imageBuy} can tao, ${v.counts.imageReuse} dung lai`,
    );
    line(
      "clip",
      `${v.counts.videoBuy} can tao, ${v.counts.videoReuse} dung lai`,
    );
    line(
      "giong",
      `${v.counts.voiceBuy} can tao, ${v.counts.voiceReuse} dung lai`,
    );
    line(
      "chi phi",
      `text ${money(v.breakdown.text)} · image ${money(v.breakdown.image)} · ` +
        `video ${money(v.breakdown.video)} · voice ${money(v.breakdown.voice)} · ` +
        `render ${money(v.breakdown.render)}`,
    );
    line("du toan video nay", money(v.estimatedCost));
    if (v.blockedReason) line("BI CHAN VI", v.blockedReason);
    for (const w of v.warnings) console.log(`    CB  ${w}`);
  }

  console.log("\n  TONG");
  line("video", `${pre.videos.length} (${JSON.stringify(pre.lifecycleCounts)})`);
  line("canh", String(pre.totalScenes));
  line("LOCAL_MOTION / VIDEO_AI", `${pre.totalLocalMotion} / ${pre.totalVideoAi}`);
  line(
    "anh / clip / giong can tao",
    `${pre.counts.imageBuy} / ${pre.counts.videoBuy} / ${pre.counts.voiceBuy}`,
  );
  line(
    "anh / clip / giong dung lai",
    `${pre.counts.imageReuse} / ${pre.counts.videoReuse} / ${pre.counts.voiceReuse}`,
  );
  line("du toan chay duoc", money(pre.estimatedTotal));
  line("ke ca video bi chan", money(pre.estimatedTotalIncludingBlocked));
  line(
    "bien an toan",
    `${money(pre.safetyMargin)} (${pre.safetyMarginPercent.toFixed(0)}%)`,
  );
  line("de xuat tran duyet", money(pre.suggestedAuthorizedMaxSpend));
  line("han muc tong con lai", money(pre.globalRemaining));
  line("co so gia", pre.costBasis);
  for (const w of pre.providerWallets) {
    line(
      `vi ${w.provider}`,
      `da chi ${money(w.spentUsd)} · con ${
        w.remainingUsd === null ? "khong ro (hang tu quan)" : money(w.remainingUsd)
      } · ${w.live ? "LIVE" : "tu khai"}`,
    );
  }

  // ---- 6. PROVE NOTHING WAS SPENT --------------------------------------
  console.log("\n--- 6. KHONG CHI MOT DONG NAO ---");
  const spendAfter = await totalRealSpend();
  const jobsAfter = await prisma.providerJob.count();
  const auth = await prisma.batchAuthorization.findUnique({
    where: { batchId: created.batchId },
  });
  const batch = await prisma.batch.findUniqueOrThrow({ where: { id: created.batchId } });
  const checks: [string, boolean, string][] = [
    ["Da chi khong doi", spendAfter === spendBefore, `${money(spendBefore)} -> ${money(spendAfter)}`],
    ["ProviderJob khong doi", jobsAfter === jobsBefore, `${jobsBefore} -> ${jobsAfter}`],
    ["Quyen chi DRAFT", auth?.status === "DRAFT", auth?.status ?? "khong co"],
    ["Tran da duyet = 0", (auth?.authorizedMaxSpend ?? -1) === 0, String(auth?.authorizedMaxSpend)],
    ["Lo PLANNED", batch.status === "PLANNED", batch.status],
    ["CREATE_ATTEMPT_TOKEN = 0", (await peekCreateToken()) === null, "null"],
  ];
  let ok = true;
  for (const [label, pass, detail] of checks) {
    console.log(`  ${pass ? "DAT " : "HONG"}  ${label.padEnd(28)} ${detail}`);
    if (!pass) ok = false;
  }

  await prisma.$disconnect();
  if (!KEEP) {
    // Nothing survives: the whole scratch database and its data directory go.
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    console.log("\n  Da xoa DB va thu muc dry-run. Dung --keep neu muon giu lai.");
  } else {
    console.log(`\n  Giu lai ${SCRATCH} — lo ${created.batchId}`);
  }

  console.log(`\n${ok ? "TAT CA DAT" : "CO MUC HONG"} — khong co paid POST nao.`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
