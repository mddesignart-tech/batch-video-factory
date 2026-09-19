import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * The real-price preflight for a multi-video batch, and NOTHING else.
 *
 * It answers one question - "may this batch be approved, and for how much" -
 * using production prices, the production registry and the production wallets,
 * and then stops. There is deliberately no flag that makes it spend.
 *
 * ## Why it runs against a SCRATCH database
 *
 * Importing creates rows: projects, scenes, and `Character` rows that are not
 * owned by the batch that first mentioned them. A preflight that dirties the
 * production tables to answer a question about money is not a preflight. So the
 * database is built fresh from the migrations, seeded, and then the REAL
 * characters and REAL wallet figures are copied across - because those are the
 * facts the answer depends on, and inventing them would make the answer fiction.
 *
 * ## AI_MOCK_MODE=false, and what that does and does not permit
 *
 * Mock mode off means the registry's real prices are used and `costBasis` reads
 * PRODUCTION_ESTIMATE rather than MOCK. It does NOT mean anything is bought:
 * every call here is a read, and the batch is left `PLANNED` with a `DRAFT`
 * authorisation, which permits no spending at all. Free GETs - the Runway
 * balance - are allowed and are marked as such.
 *
 *   npx tsx scripts/production-preflight.ts
 *   npx tsx scripts/production-preflight.ts --source <dir> --keep
 *
 * See QĐ-080.
 */

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const SOURCE = arg("source", "examples/batch-real-2");
const KEEP = process.argv.includes("--keep");
const MAX_PER_VIDEO = Number(arg("max-per-video", "0.60"));
const MAX_BATCH = Number(arg("max-batch", "1.00"));
/**
 * A soft target is an ASPIRATION, and an aspiration is something a person
 * states - not a number left over from a previous run. The two HARD limits
 * above still bind every time; this one is checked only when passed, because a
 * stale default fails a batch the operator has actually authorised and reads
 * exactly like a real budget breach when it is not one.
 */
const TARGET = process.argv.includes("--target") ? Number(arg("target")) : null;

const ROOT = process.cwd();
const SCRATCH = path.join(ROOT, "data", ".production-preflight");
const DB_FILE = path.join(SCRATCH, "preflight.db");
const PROD_DB = path.join(ROOT, "data", "app.db");

// Set BEFORE anything imports Prisma or the paths module.
process.env.DATA_DIR = SCRATCH;
process.env.DATABASE_URL = `file:${DB_FILE.replace(/\\/g, "/")}`;
process.env.AI_MOCK_MODE = "false";
process.env.JOB_WORKER_ENABLED = "false";

const money = (n: number) => `$${n.toFixed(6)}`;
let failures = 0;

function must(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "[DAT ]" : "[HONG]"} ${label.padEnd(44)} ${detail}`);
}
function note(label: string, detail: string): void {
  console.log(`  [    ] ${label.padEnd(44)} ${detail}`);
}
function heading(text: string): void {
  console.log(`\n--- ${text} ---`);
}
function run(command: string, args: string[]): void {
  execFileSync(command, args, {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
}

async function main(): Promise<void> {
  console.log("=".repeat(96));
  console.log("  PRODUCTION PREFLIGHT — gia THAT, khong POST, khong chi mot dong");
  console.log("=".repeat(96));

  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  run("npx", ["prisma", "migrate", "deploy"]);
  run("npx", ["tsx", "scripts/seed.ts"]);

  const { prisma } = await import("@/lib/prisma");
  const { isMockMode } = await import("@/lib/env");
  const { peekCreateToken } = await import("@/services/create-token");
  const { spendStatus, setSpendCap, confirmProvider } = await import("@/services/spend-guard");
  const { setProviderBudget } = await import("@/services/provider-budget");
  const { materialiseImport, scanImportSource, validateImport } = await import(
    "@/services/storyboard-import"
  );
  const { preflightImportedBatch } = await import("@/services/import-preflight");
  const { fetchRunwayCatalog } = await import("@/services/provider-catalog");

  // ---- 1. copy the facts the answer depends on out of production ----------
  heading("1. Sao chep SU THAT tu DB production sang DB nhap");
  const { PrismaClient } = await import("@prisma/client");
  const prod = new PrismaClient({ datasources: { db: { url: `file:${PROD_DB.replace(/\\/g, "/")}` } } });
  try {
    const [prodChars, prodSettings, prodModels, prodProviders, prodPresets] =
      await Promise.all([
        prod.character.findMany({ include: { references: true } }),
        prod.setting.findMany(),
        prod.modelRegistry.findMany(),
        prod.providerConfig.findMany(),
        prod.stylePreset.findMany(),
      ]);

    // Models: the registry decides price, lifecycle and reliability, and all
    // three change the answer. Copied wholesale rather than seeded, because the
    // seed is a starting point and production has moved since.
    for (const m of prodModels) {
      await prisma.modelRegistry.upsert({
        where: { provider_modelId: { provider: m.provider, modelId: m.modelId } },
        create: m,
        update: m,
      });
    }
    note("model registry", `${prodModels.length} dong (gia/lifecycle/reliability that)`);

    // Provider configs decide AVAILABILITY - enabled, and whether a key is
    // present. Without them the scratch database reports every vendor as
    // unreachable and the router refuses every scene, which looks exactly like
    // a routing problem and is not one.
    for (const cfg of prodProviders) {
      await prisma.providerConfig.upsert({
        where: { name: cfg.name },
        create: cfg,
        update: cfg,
      });
    }
    note(
      "provider config",
      prodProviders.map((p) => `${p.name}${p.enabled ? "" : "(tat)"}`).join(", "),
    );

    // The style preset is pasted into every image prompt, so a preflight run
    // against the seed's preset would price a different picture than the run.
    for (const preset of prodPresets) {
      await prisma.stylePreset.upsert({
        where: { slug: preset.slug },
        create: preset,
        update: preset,
      });
    }

    // The seed writes its own Max/Leo/Mia with different ids, and `name` is
    // unique - so the production rows are copied in VERBATIM, ids and all,
    // after clearing what the seed made. Verbatim matters: the id is what a
    // reference image points at, and a character whose references belong to a
    // different row is a character with no references.
    await prisma.characterReference.deleteMany({});
    await prisma.character.deleteMany({});
    for (const c of prodChars) {
      const { references, ...row } = c;
      await prisma.character.create({ data: row });
      for (const r of references) {
        await prisma.characterReference.create({ data: r });
      }
    }
    note("nhan vat", prodChars.map((c) => `${c.name}(${c.references.length} anh)`).join(", "));

    for (const key of ["spend.cap", "spend.providerBudgets", "spend.confirmedProviders"]) {
      const row = prodSettings.find((s) => s.key === key);
      if (row) {
        await prisma.setting.upsert({
          where: { key },
          create: { key, valueJson: row.valueJson },
          update: { valueJson: row.valueJson },
        });
      }
    }
    // The cap is the project's, but the SPENT half lives in CostEntry rows we do
    // not copy - so the scratch database would read "nothing spent yet" and
    // promise headroom that does not exist. The cap is lowered to the real
    // REMAINING figure instead, which makes every budget check here as tight as
    // the real one.
    const prodSpent = await prod.costEntry.aggregate({
      where: { estimated: false },
      _sum: { amount: true },
    });
    const prodCapRow = prodSettings.find((s) => s.key === "spend.cap");
    const prodCap = prodCapRow ? Number(JSON.parse(prodCapRow.valueJson)) : 8;
    const realRemaining = Math.round((prodCap - (prodSpent._sum.amount ?? 0)) * 1e6) / 1e6;
    await setSpendCap(realRemaining);
    note(
      "han muc",
      `production da chi ${money(prodSpent._sum.amount ?? 0)} / ${money(prodCap)} ` +
        `-> cap cua ban chay nay = ${money(realRemaining)}`,
    );
  } finally {
    await prod.$disconnect();
  }

  // ---- 2. live wallet, via a free GET ------------------------------------
  heading("2. So du LIVE (GET mien phi, khong phai POST)");
  let runwayCredits: number | null = null;
  try {
    const catalog = await fetchRunwayCatalog();
    runwayCredits = catalog.creditBalance ?? null;
    if (runwayCredits !== null) {
      await setProviderBudget({
        provider: "runway",
        available: runwayCredits,
        unit: "credits",
        usdPerUnit: 0.01,
        note: `Doc GET /organization luc ${new Date().toISOString()}`,
      });
    }
    note("runway", `${runwayCredits ?? "?"} credit = ${money((runwayCredits ?? 0) * 0.01)} (LIVE)`);
  } catch (err) {
    note("runway", `KHONG doc duoc so du live: ${err instanceof Error ? err.message : err}`);
  }

  // ---- 3. import + validate ----------------------------------------------
  heading("3. Nhap + kiem tra storyboard");
  note("nguon", SOURCE);
  note("AI_MOCK_MODE", String(isMockMode()));
  const scan = scanImportSource(path.resolve(SOURCE));
  const validated = await validateImport(scan);
  const errors = validated.issues.filter((i) => i.level === "error");
  const warnings = validated.issues.filter((i) => i.level === "warning");
  must("Khong con loi validate", errors.length === 0, `${errors.length} loi`);
  for (const e of errors) console.log(`      LOI  [${e.videoId ?? "-"}] ${e.code}: ${e.message}`);
  for (const w of warnings) console.log(`      CB   [${w.videoId ?? "-"}] ${w.code}: ${w.message}`);
  must("Dung 2 video", validated.videos.length === 2, `${validated.videos.length} video`);

  const created = await materialiseImport(validated, {
    batchName: "Production preflight 2 video",
    maxCostPerVideo: MAX_PER_VIDEO,
    maxCostForBatch: MAX_BATCH,
  });
  must("Khong video nao bi bo qua", created.skipped.length === 0, `${created.skipped.length} bi bo`);

  // ---- 4. the estimate, at real prices ------------------------------------
  heading("4. DU TOAN GIA THAT");
  const pre = await preflightImportedBatch(created.batchId);

  for (const v of pre.videos) {
    const seconds = v.scenes.reduce((n, s) => n + s.duration, 0);
    console.log(`\n  ${v.lifecycle.padEnd(10)} ${v.title}`);
    note("canh / giay", `${v.sceneCount} / ${seconds.toFixed(1)}s`);
    note("LOCAL_MOTION / VIDEO_AI", `${v.localMotionCount} / ${v.videoAiCount}`);
    note("anh", `${v.counts.imageBuy} tao moi, ${v.counts.imageReuse} dung lai`);
    note("clip", `${v.counts.videoBuy} tao moi, ${v.counts.videoReuse} dung lai`);
    note("giong", `${v.counts.voiceBuy} tao moi, ${v.counts.voiceReuse} dung lai`);
    for (const s of v.scenes) {
      console.log(
        `      #${s.sceneNumber} ${String(s.duration).padStart(2)}s ` +
          `${s.motionSource.padEnd(12)} anh=${s.plan.image.padEnd(11)} ` +
          `clip=${s.plan.video.padEnd(11)} giong=${s.plan.voice.padEnd(11)} ` +
          `${(s.videoModel ?? "-").padEnd(28)} ${money(s.estimatedCost)}`,
      );
    }
    note(
      "chi phi",
      `text ${money(v.breakdown.text)} · image ${money(v.breakdown.image)} · ` +
        `video ${money(v.breakdown.video)} · voice ${money(v.breakdown.voice)} · ` +
        `render ${money(v.breakdown.render)} · quality ${money(v.breakdown.quality)}`,
    );
    // Printed because it is part of the total. A breakdown whose lines do not
    // add up to the figure beneath them is a breakdown nobody can check.
    note("du phong thu lai", money(v.breakdown.retries));
    note(
      "TONG VIDEO NAY",
      v.uncappedCost > v.estimatedCost
        ? `${money(v.estimatedCost)} (phan LOT vao tran) — that ra ${money(v.uncappedCost)}`
        : money(v.estimatedCost),
    );
    if (v.blockedReason) note("BI CHAN VI", v.blockedReason);
    for (const w of v.warnings) console.log(`      CB  ${w}`);
  }

  // ---- 5. every gate the operator listed ----------------------------------
  heading("5. TUNG CUA KHOA");
  const cap = await spendStatus();

  for (const v of pre.videos) {
    must(`${v.title}: READY`, v.lifecycle === "READY", v.lifecycle + (v.blockedReason ? ` — ${v.blockedReason}` : ""));
    must(
      `${v.title}: <= max/video ${money(MAX_PER_VIDEO)}`,
      v.estimatedCost <= MAX_PER_VIDEO,
      money(v.estimatedCost),
    );
  }

  console.log("\n  Model tra phi va tinh trang xac nhan:");
  for (const m of pre.paidModels) {
    must(`  xac nhan ${m.key}`, m.confirmed, m.confirmed ? "DA XAC NHAN" : "CHUA XAC NHAN");
  }

  const videoModels = [
    ...new Set(
      pre.videos.flatMap((v) => v.scenes.map((s) => s.videoModel).filter((m): m is string => m !== null)),
    ),
  ];
  for (const key of videoModels) {
    const [provider, ...rest] = key.split("/");
    const row = await prisma.modelRegistry.findFirst({
      where: { provider, modelId: rest.join("/") },
    });
    must(
      `  ${key} khong DEGRADED/DEPRECATED`,
      row !== null && row.reliability === "OK" && row.lifecycle !== "DEPRECATED",
      row ? `${row.lifecycle} / ${row.reliability} / ${row.verification}` : "khong thay trong registry",
    );
  }

  must(
    `Tong <= hard cap ${money(MAX_BATCH)}`,
    pre.estimatedTotal <= MAX_BATCH,
    money(pre.estimatedTotal),
  );
  if (TARGET !== null) {
    must(
      `Tong <= muc tieu ${money(TARGET)}`,
      pre.estimatedTotal <= TARGET,
      money(pre.estimatedTotal),
    );
  }
  must(
    "Tran de xuat <= hard cap",
    pre.suggestedAuthorizedMaxSpend <= MAX_BATCH,
    money(pre.suggestedAuthorizedMaxSpend),
  );
  must(
    "Tong <= ngan sach du an con lai",
    pre.estimatedTotal <= cap.remaining,
    `${money(pre.estimatedTotal)} vs con ${money(cap.remaining)}`,
  );
  must("Khong video nao bi chan", pre.blockedCount === 0, `${pre.blockedCount} bi chan`);
  must("Co so gia = PRODUCTION_ESTIMATE", pre.costBasis === "PRODUCTION_ESTIMATE", pre.costBasis);

  console.log("\n  Nhan vat:");
  for (const c of pre.characters) {
    must(
      `  ${c.name} READY`,
      c.readiness === "READY",
      `${c.readiness}, ${c.referenceCount} anh, ${c.sceneCount} canh` +
        (c.missingFields.length > 0 ? `, thieu: ${c.missingFields.join(", ")}` : ""),
    );
  }

  // ---- 6. nothing was spent, nothing was authorised ----------------------
  heading("6. KHONG CHI, KHONG CAP PHEP");
  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId: created.batchId } });
  const batch = await prisma.batch.findUniqueOrThrow({ where: { id: created.batchId } });
  must("Quyen chi DRAFT", auth?.status === "DRAFT", auth?.status ?? "khong co");
  must("Tran da duyet = 0", (auth?.authorizedMaxSpend ?? -1) === 0, String(auth?.authorizedMaxSpend));
  must("Lo PLANNED", batch.status === "PLANNED", batch.status);
  must("CREATE_ATTEMPT_TOKEN = 0", (await peekCreateToken()) === null, "null");
  must("ProviderJob = 0", (await prisma.providerJob.count()) === 0, String(await prisma.providerJob.count()));
  must("CostReservation = 0", (await prisma.costReservation.count()) === 0, String(await prisma.costReservation.count()));
  must(
    "Chi that = 0",
    (await prisma.costEntry.count({ where: { estimated: false } })) === 0,
    String(await prisma.costEntry.count({ where: { estimated: false } })),
  );
  void confirmProvider;

  // ---- 7. the summary the operator asked for -----------------------------
  heading("7. TONG HOP");
  note("video", `${pre.videos.length} (${JSON.stringify(pre.lifecycleCounts)})`);
  note("canh", String(pre.totalScenes));
  note("LOCAL_MOTION / VIDEO_AI", `${pre.totalLocalMotion} / ${pre.totalVideoAi}`);
  note(
    "WILL_CREATE  anh/clip/giong",
    `${pre.counts.imageBuy} / ${pre.counts.videoBuy} / ${pre.counts.voiceBuy}`,
  );
  note(
    "REUSE        anh/clip/giong",
    `${pre.counts.imageReuse} / ${pre.counts.videoReuse} / ${pre.counts.voiceReuse}`,
  );
  const totals = pre.videos.reduce(
    (acc, v) => ({
      text: acc.text + v.breakdown.text,
      image: acc.image + v.breakdown.image,
      video: acc.video + v.breakdown.video,
      voice: acc.voice + v.breakdown.voice,
      render: acc.render + v.breakdown.render,
      quality: acc.quality + v.breakdown.quality,
      retries: acc.retries + v.breakdown.retries,
    }),
    { text: 0, image: 0, video: 0, voice: 0, render: 0, quality: 0, retries: 0 },
  );
  note("TEXT", money(totals.text));
  note("IMAGE", money(totals.image));
  note("VIDEO", money(totals.video));
  note("VOICE", money(totals.voice));
  note("RENDER", money(totals.render));
  note("QUALITY", money(totals.quality));
  note("RETRIES (du phong)", money(totals.retries));
  note("SAFETY MARGIN", `${money(pre.safetyMargin)} (${pre.safetyMarginPercent.toFixed(0)}%)`);
  note("TOTAL ESTIMATED (chi video CHAY DUOC)", money(pre.estimatedTotal));
  // Both figures, always. The runnable total is what an approval should be
  // sized to; the all-videos total is what the batch costs if the blocked ones
  // are unblocked - and confusing the two is how a ceiling ends up too small.
  note("TONG NEU MOI VIDEO DEU CHAY", money(pre.estimatedTotalUncapped));
  note("RECOMMENDED MAX AUTHORIZATION", money(pre.suggestedAuthorizedMaxSpend));
  note("ngan sach du an con lai", money(cap.remaining));
  for (const w of pre.providerWallets) {
    note(
      `vi ${w.provider}`,
      `da chi ${money(w.spentUsd)} · con ${w.remainingUsd === null ? "khong ro" : money(w.remainingUsd)} · ${w.live ? "LIVE" : "tu khai"}`,
    );
  }
  for (const w of pre.warnings) console.log(`  CB  ${w}`);

  await prisma.$disconnect();
  if (!KEEP) {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    console.log("\n  Da xoa DB preflight. Dung --keep neu muon giu lai de xem tren UI.");
  } else {
    console.log(`\n  Giu lai ${SCRATCH} — lo ${created.batchId}`);
  }

  console.log(
    `\n${failures === 0 ? "REAL MULTI-VIDEO PREFLIGHT: READY" : `REAL MULTI-VIDEO PREFLIGHT: NOT READY (${failures} muc HONG)`}`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
