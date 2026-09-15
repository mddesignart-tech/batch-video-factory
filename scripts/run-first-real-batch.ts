import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { toAbsolute } from "@/lib/paths";
import { peekCreateToken } from "@/services/create-token";
import { spendStatus, totalRealSpend } from "@/services/spend-guard";
import { approveAuthorization } from "@/services/batch-authorization";
import { reservationLedger } from "@/services/cost-reservation";
import { storedPlan } from "@/services/batch-runner";
import { previewProjectCost } from "@/services/project-service";
import { claimNext, completeJob, failJob } from "@/jobs/queue";
import { runJob } from "@/jobs/handlers";
import { probeDuration, ffprobe } from "@/media/ffmpeg";

/**
 * Run ONE authorised batch for real, under the operator's stated rules.
 *
 * ## Why a runner rather than `npm start`
 *
 * It is not to avoid the batch gateway - every paid request still goes through
 * `runProviderJob`, which still presents BATCH_SPEND_AUTHORIZATION and still
 * reserves before it sends. The handlers called here are the production ones.
 *
 * What this replaces is the WORKER'S RETRY POLICY. The queue retries a failed
 * job up to three times, and a retry whose ProviderJob is marked `failed` issues
 * a genuinely new paid request. The operator's rules for this run are explicit:
 * a failed paid POST stops that scene and is reported, with no automatic retry.
 * A background worker cannot honour that; it would have bought the clip twice
 * before anyone read the error.
 *
 * So: same handlers, same gateway, same reservations - one attempt each, and a
 * full stop on the first failure.
 *
 *   AI_MOCK_MODE=false npx tsx scripts/run-first-real-batch.ts \
 *     --batch <id> --authorize 0.90 --confirm-real-spend
 */

const RUNWAY_BASE = "https://api.dev.runwayml.com/v1";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const money = (n: number, d = 6) => `$${n.toFixed(d)}`;

/** Free GET. Used before and after so the credit delta is measured, not assumed. */
async function runwayCredits(): Promise<number | null> {
  const key = process.env.RUNWAY_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${RUNWAY_BASE}/organization`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "X-Runway-Version": "2024-11-06",
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { creditBalance?: number };
    return typeof body.creditBalance === "number" ? body.creditBalance : null;
  } catch {
    return null;
  }
}

/** The routing the operator approved. Anything else is a stop, not a warning. */
const APPROVED_ROUTE: Record<number, { motion: string; video: string | null }> = {
  1: { motion: "AI_VIDEO", video: "runway/gen4_turbo:720x1280" },
  2: { motion: "LOCAL_MOTION", video: null },
  3: { motion: "LOCAL_MOTION", video: null },
  4: { motion: "AI_VIDEO", video: "runway/gen4_turbo:720x1280" },
  5: { motion: "LOCAL_MOTION", video: null },
  6: { motion: "LOCAL_MOTION", video: null },
};

let failures = 0;
function must(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "[DAT ]" : "[DUNG]"} ${label.padEnd(34)} ${detail}`);
}

async function main(): Promise<void> {
  const batchId = arg("batch");
  const authorize = Number(arg("authorize", "0"));
  const confirmed = process.argv.includes("--confirm-real-spend");

  console.log("=".repeat(88));
  console.log("  CHAY THAT 1 VIDEO QUA BATCH VIDEO FACTORY V1");
  console.log("=".repeat(88));

  // ---------------------------------------------------------- preconditions
  console.log("\n--- 1. Dieu kien tien quyet ---");
  must("Da xac nhan chi tien that", confirmed, confirmed ? "--confirm-real-spend" : "THIEU CO");
  must("Mock Mode da TAT", !isMockMode(), `AI_MOCK_MODE=${isMockMode()}`);
  const token = await peekCreateToken();
  must("CREATE_ATTEMPT_TOKEN = 0", token === null, token ? "CO TOKEN (!!)" : "0 - dung quyen chi cua lo");

  const cap = await spendStatus();
  must(
    "Han muc tong du",
    cap.remaining >= authorize,
    `con ${money(cap.remaining)} / tran duyet ${money(authorize, 2)}`,
  );

  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: { authorization: true, projects: { include: { scenes: { orderBy: { sceneNumber: "asc" } } } } },
  });
  must("Tim thay lo", batch !== null, batchId);
  if (!batch) return finish();

  const plan = storedPlan(batch);
  const planned = plan?.production?.estimatedTotal ?? 0;
  must("Lo co ban du toan", plan !== null, `du toan ${money(planned)}`);
  must(
    "Du toan khong vuot tran duyet",
    planned <= authorize,
    `${money(planned)} <= ${money(authorize, 2)}`,
  );

  const project = batch.projects[0];
  must("Lo co dung 1 project", batch.projects.length === 1, `${batch.projects.length} project`);
  if (!project) return finish();
  must("Project co kich ban", Boolean(project.scriptJson), `${project.scenes.length} canh`);

  // ---- the routing the generator WILL use, checked against what was approved
  console.log("\n--- 2. Doi chieu routing voi plan da duyet ---");
  const preview = await previewProjectCost(project.id);
  must(
    "Du toan khop plan",
    Math.abs(preview.current.breakdown.total - planned) < 0.000001,
    `${money(preview.current.breakdown.total)} vs ${money(planned)}`,
  );
  must("Khong canh nao thieu provider", preview.current.needsProvider.length === 0, `${preview.current.needsProvider.length} canh`);
  must("Khong loi dinh tuyen", preview.current.errors.length === 0, `${preview.current.errors.length} loi`);

  for (const scenePlan of preview.current.scenes) {
    const approved = APPROVED_ROUTE[scenePlan.sceneNumber];
    const actualVideo = scenePlan.video
      ? `${scenePlan.video.provider}/${scenePlan.video.modelId}`
      : null;
    const ok =
      approved !== undefined &&
      approved.motion === scenePlan.motionSource &&
      approved.video === actualVideo;
    must(
      `Canh ${scenePlan.sceneNumber} dung plan`,
      ok,
      `${scenePlan.motionSource} ${actualVideo ?? "(local)"}`,
    );
  }

  // Nothing pricier than what was approved may appear anywhere.
  const banned = preview.current.scenes.filter(
    (s) =>
      s.video &&
      (s.video.modelId.includes("sora") || s.video.modelId.includes("gen4.5")),
  );
  must("Khong dung Sora / Gen4.5", banned.length === 0, `${banned.length} canh vi pham`);

  if (failures > 0) return finish();

  // ------------------------------------------------------------- authorise
  console.log("\n--- 3. Cap quyen chi ---");
  const creditsBefore = await runwayCredits();
  console.log(`  Runway credits TRUOC        : ${creditsBefore ?? "(khong doc duoc)"}`);

  if (batch.authorization?.status !== "APPROVED") {
    await approveAuthorization({ batchId, authorizedMaxSpend: authorize });
    console.log(`  Da duyet BATCH_SPEND_AUTHORIZATION = ${money(authorize, 2)}`);
  } else {
    console.log(`  Quyen chi da APPROVED tu truoc = ${money(batch.authorization.authorizedMaxSpend, 2)}`);
  }

  // --------------------------------------------------------------- expand
  console.log("\n--- 4. Mo rong lo (handler that) ---");
  const expandJob = await prisma.job.create({
    data: { type: "batch_expand", batchId, status: "processing", maxAttempts: 1 },
  });
  const expandOutcome = await runJob(expandJob);
  await completeJob(expandJob.id, expandOutcome);
  console.log("  batch_expand xong:", JSON.stringify(expandOutcome));

  // One attempt per job. The operator's rule: a failed paid POST stops the
  // scene, it is not retried.
  const retuned = await prisma.job.updateMany({
    where: { projectId: project.id, status: "queued" },
    data: { maxAttempts: 1 },
  });
  console.log(`  Dat maxAttempts=1 cho ${retuned.count} job (khong tu retry paid POST)`);

  // ----------------------------------------------------------------- drain
  console.log("\n--- 5. Chay hang doi ---");
  let done = 0;
  let stopped = "";

  for (let i = 0; i < 200; i += 1) {
    await prisma.job.updateMany({
      where: { status: "queued", nextRunAt: { gt: new Date() } },
      data: { nextRunAt: new Date() },
    });
    const job = await claimNext();
    if (!job) break;

    const label = `${job.type}${job.sceneId ? ` canh` : ""}`;
    try {
      const outcome = await runJob(job);
      if (!outcome.deferred) {
        await completeJob(job.id, outcome.result);
        done += 1;
        console.log(`  [xong] ${label}`);
      }
    } catch (err) {
      await failJob(job.id, err);
      stopped = err instanceof Error ? err.message : String(err);
      console.log(`  [HONG] ${label}: ${stopped}`);
      console.log("\n  DUNG NGAY. Khong tu thu lai request tra phi.");
      break;
    }
  }
  console.log(`  ${done} job hoan tat`);

  // ---------------------------------------------------------------- report
  await report(batchId, project.id, authorize, creditsBefore, stopped);
}

async function report(
  batchId: string,
  projectId: string,
  authorize: number,
  creditsBefore: number | null,
  stopped: string,
): Promise<void> {
  console.log("\n" + "=".repeat(88));
  console.log("  KET QUA");
  console.log("=".repeat(88));

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { scenes: { orderBy: { sceneNumber: "asc" } } },
  });

  console.log(`\n  Trang thai project : ${project.status}`);
  if (project.errorMessage) console.log(`  Loi                : ${project.errorMessage}`);

  console.log("\n  --- TUNG CANH ---");
  for (const scene of project.scenes) {
    const route = scene.motionSource === "LOCAL_MOTION" ? "LOCAL_MOTION" : "VIDEO_AI";
    const model =
      scene.motionSource === "LOCAL_MOTION"
        ? "ffmpeg/local-motion"
        : `${scene.videoProvider ?? "-"}/${scene.videoModel ?? "-"}`;
    console.log(
      `  canh ${scene.sceneNumber} ${route.padEnd(13)} ${model.padEnd(30)} ` +
        `${scene.status.padEnd(12)} anh=${scene.imagePath ? "co" : "-"} ` +
        `clip=${scene.videoPath ? "co" : "-"} actual=${money(scene.actualCost)}`,
    );
  }

  console.log("\n  --- CHI PHI THAT (tu so CostEntry) ---");
  const rows = await prisma.costEntry.groupBy({
    by: ["category", "provider"],
    where: { projectId, estimated: false },
    _sum: { amount: true },
    _count: { _all: true },
  });
  let total = 0;
  for (const r of rows) {
    const amt = r._sum.amount ?? 0;
    total += amt;
    console.log(`  ${r.category.padEnd(9)} ${r.provider.padEnd(9)} ${String(r._count._all).padStart(2)} lan  ${money(amt)}`);
  }
  console.log(`  ${"TONG".padEnd(19)}       ${money(total)}`);
  console.log(`  Da duyet            ${money(authorize, 2)}`);
  console.log(`  Con lai chua dung   ${money(Math.max(0, authorize - total))}`);

  const auth = await prisma.batchAuthorization.findUnique({ where: { batchId } });
  const ledger = await reservationLedger(batchId, auth?.authorizedMaxSpend ?? authorize);
  const released = await prisma.costReservation.count({ where: { batchId, status: "RELEASED" } });
  console.log("\n  --- AN TOAN NGAN SACH ---");
  console.log(`  reserved (con giu)  ${money(ledger.reserved)}`);
  console.log(`  committed           ${money(ledger.committed)}`);
  console.log(`  released            ${released} khoan`);
  console.log(`  tran duyet          ${money(ledger.ceiling)}`);
  console.log(`  VUOT TRAN?          ${ledger.used > ledger.ceiling ? "CO (!!)" : "KHONG"}`);
  console.log(`  quyen chi           ${auth?.status}`);

  const creditsAfter = await runwayCredits();
  const posts = await prisma.providerJob.count({
    where: { projectId, provider: "runway", externalId: { not: null } },
  });
  console.log("\n  --- RUNWAY ---");
  console.log(`  credits truoc       ${creditsBefore ?? "?"}`);
  console.log(`  credits sau         ${creditsAfter ?? "?"}`);
  console.log(
    `  chenh lech          ${creditsBefore !== null && creditsAfter !== null ? creditsBefore - creditsAfter : "?"}`,
  );
  console.log(`  so paid POST that   ${posts}`);

  console.log("\n  --- VIDEO CUOI ---");
  if (project.finalVideoPath) {
    const file = toAbsolute(project.finalVideoPath);
    console.log(`  duong dan           ${file}`);
    if (fs.existsSync(file)) {
      console.log(`  dung luong          ${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB`);
      console.log(`  thoi luong          ${(await probeDuration(file)).toFixed(2)}s`);
      try {
        const { stdout: info } = await ffprobe([
          "-v", "error",
          "-select_streams", "v:0",
          "-show_entries", "stream=codec_name,width,height,r_frame_rate",
          "-of", "default=noprint_wrappers=1",
          file,
        ]);
        console.log(`  ${info.trim().split("\n").join("\n  ")}`);
      } catch {
        console.log("  (khong doc duoc thong so stream)");
      }
    }
    console.log(`  phu de              ${project.subtitlePath ?? "-"}`);
  } else {
    console.log("  CHUA CO MP4.");
  }

  const spent = await totalRealSpend();
  console.log(`\n  Tong tien that toan ung dung: ${money(spent)}`);
  if (stopped) console.log(`\n  DA DUNG VI: ${stopped}`);
}

function finish(): void {
  if (failures > 0) {
    console.log(`\n  DUNG: ${failures} dieu kien khong dat. KHONG goi API tra phi nao.\n`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
