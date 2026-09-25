import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { toAbsolute } from "@/lib/paths";
import { peekCreateToken } from "@/services/create-token";
import { confirmedProviders, spendStatus, totalRealSpend } from "@/services/spend-guard";
import { providerSpendBreakdown } from "@/services/provider-budget";
import { availableProviderNames } from "@/services/provider-health";
import { approveAuthorization } from "@/services/batch-authorization";
import { release as releaseReservation, reservationLedger } from "@/services/cost-reservation";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { preflightImportedBatch } from "@/services/import-preflight";
import {
  generateSceneImage,
  generateSceneVideo,
  generateSceneVoice,
} from "@/services/generation";
import { writeBatchReport } from "@/services/batch-report";
import { settleBatchIfDone } from "@/services/batch-runner";
import { completeJob, failJob } from "@/jobs/queue";
import { runJob } from "@/jobs/handlers";
import { ffmpeg, ffprobe, probeDuration } from "@/media/ffmpeg";
import type { Job } from "@prisma/client";

/**
 * The first REAL multi-video batch: two videos, ten scenes, one paid clip.
 *
 * The single-video ancestor is `first-real-import-run.ts`, and the reasons it is
 * a script rather than the batch page apply here unchanged: the job queue's
 * retry policy cannot honour "one paid POST per asset, no retries, no provider
 * switch". A worker would have bought the clip twice before anyone read the
 * error. `evaluateScene` is left out for the same reason it was there - a
 * below-threshold verdict bumps `retryCount`, which changes the idempotency key
 * and buys the asset again.
 *
 * ## What is different when there are two videos
 *
 * One video can only succeed or fail. Two can disagree, and the rule is that a
 * failure in one must not cost the other its run: each video is driven inside
 * its own try, and a failure stops THAT video at the scene that failed and
 * leaves the rest of it unbought. The batch continues to the next video, which
 * shares nothing with it but the ceiling - so the batch outcome is COMPLETED,
 * PARTIAL or FAILED, and one bad video never makes the other one worthless.
 *
 * Two videos also means two ceilings that can each be breached alone, so the
 * headroom check runs before EVERY paid step and asks four questions - this
 * video, this batch, the project overall, the vendor's own wallet - rather than
 * trusting an estimate that was true before the previous scene was bought.
 *
 * ## Why no fallback can fire
 *
 * The operator's rule is "one paid attempt, never a different provider".
 * `withFallback` in the generation layer would, on a RETRYABLE failure, try the
 * next model in the routed chain - a second paid POST to a different vendor.
 *
 * It cannot fire here, and not because a flag says so. `fallbacks` is built from
 * `ranked`, which is built from the AUTO-ROUTABLE candidates only: PIN_ONLY,
 * DEGRADED and DEPRECATED rows are already gone. With mock mode off the
 * available providers are openai, groq and runway, and inside that set exactly
 * one model per stage survives - gpt-image-2:medium, h3_max:768x1280,
 * gpt-4o-mini-tts. A chain of one has nothing to fall back to.
 *
 * That is a property of the catalogue, not a promise, so the gate below COUNTS
 * it rather than asserting it, and refuses if the count is ever not one.
 *
 * ## The finished file is checked as a FILE
 *
 * A project row saying `completed` is a claim about bookkeeping, not about
 * video. Every MP4 is probed with ffprobe and scanned for black frames and
 * silence, because the failure this run is most likely to hide is a render that
 * wrote a technically valid file nobody would watch.
 *
 *   npx tsx scripts/run-real-multi-batch.ts                      # $0, refuses loudly
 *   AI_MOCK_MODE=false npx tsx scripts/run-real-multi-batch.ts \
 *     --batch <id> --apply --confirm-real-spend
 */

const RUNWAY_BASE = "https://api.dev.runwayml.com/v1";
const MAX_PER_VIDEO = 0.7;
const MAX_BATCH = 1.0;
/** What the operator approved. A drift from this is a stop, not a rounding note. */
const APPROVED_ESTIMATE = 0.9066;
/** The three the operator fixed for this run. Nothing else may be called. */
const APPROVED = {
  image: "openai/gpt-image-2:medium",
  video: "runway/h3_max:768x1280",
  voice: "openai/gpt-4o-mini-tts",
} as const;

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const money = (n: number, d = 6) => `$${n.toFixed(d)}`;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

let failures = 0;
function must(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "[DAT ]" : "[DUNG]"} ${label.padEnd(46)} ${detail}`);
}
function note(label: string, detail: string): void {
  console.log(`  [    ] ${label.padEnd(46)} ${detail}`);
}
/** A report line that carries a verdict but must never block the run. */
function check(label: string, ok: boolean, detail: string): boolean {
  console.log(`  ${ok ? "[DAT ]" : "[XEM ]"} ${label.padEnd(46)} ${detail}`);
  return ok;
}

/** Free GET. Measured before and after, never assumed. */
async function runwayCredits(): Promise<number | null> {
  const key = process.env.RUNWAY_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${RUNWAY_BASE}/organization`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, "X-Runway-Version": "2024-11-06" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { creditBalance?: number };
    return typeof body.creditBalance === "number" ? body.creditBalance : null;
  } catch {
    return null;
  }
}

/** Real money already booked against one project. Estimates excluded. */
async function spentOnProject(projectId: string): Promise<number> {
  const row = await prisma.costEntry.aggregate({
    where: { projectId, estimated: false },
    _sum: { amount: true },
  });
  return round(row._sum.amount ?? 0);
}

async function spentOnBatch(batchId: string): Promise<number> {
  const projects = await prisma.project.findMany({ where: { batchId }, select: { id: true } });
  let total = 0;
  for (const p of projects) total += await spentOnProject(p.id);
  return round(total);
}

/**
 * The four ceilings, asked again immediately before every paid step.
 *
 * Re-read rather than carried: a batch buys one asset after another, and a
 * figure captured when the batch started is stale by the third one - in the
 * direction that permits spending. The vendor wallet is in here because a
 * provider can run dry while every one of our own ledgers still looks healthy.
 */
async function assertHeadroom(
  projectId: string,
  batchId: string,
  what: string,
): Promise<void> {
  const [video, batch, cap, wallets] = await Promise.all([
    spentOnProject(projectId),
    spentOnBatch(batchId),
    spendStatus(),
    providerSpendBreakdown(),
  ]);
  if (video >= MAX_PER_VIDEO) {
    throw new Error(`${what}: video da chi ${money(video)} >= tran ${money(MAX_PER_VIDEO, 2)}. DUNG.`);
  }
  if (batch >= MAX_BATCH) {
    throw new Error(`${what}: lo da chi ${money(batch)} >= tran ${money(MAX_BATCH, 2)}. DUNG.`);
  }
  if (cap.remaining <= 0) {
    throw new Error(`${what}: han muc du an da het (${money(cap.remaining)}). DUNG.`);
  }
  for (const w of wallets) {
    if (w.remainingUsd !== null && w.remainingUsd <= 0) {
      throw new Error(`${what}: vi ${w.provider} da het (${money(w.remainingUsd)}). DUNG.`);
    }
  }
}

interface Snapshot {
  spend: number;
  costEntries: number;
  providerJobs: number;
  reservations: number;
}

async function snapshot(): Promise<Snapshot> {
  return {
    spend: await totalRealSpend(),
    costEntries: await prisma.costEntry.count(),
    providerJobs: await prisma.providerJob.count(),
    reservations: await prisma.costReservation.count(),
  };
}

async function main(): Promise<void> {
  const source = arg("source", "examples/batch-real-2");
  const apply = process.argv.includes("--apply");
  const confirmed = process.argv.includes("--confirm-real-spend");
  /**
   * Run the SAME batch again. Nothing about the batch is re-approved: a video
   * already COMPLETED is walked scene by scene to prove every asset comes back
   * as REUSE, and is never re-rendered; a stopped video carries on from where
   * it stopped under the approval it already has. When that approval is closed,
   * every paid POST is refused at the gateway - reuse is checked before the
   * gate, so a clean resume of a finished batch still succeeds, for $0.
   */
  const resume = process.argv.includes("--resume");

  console.log("=".repeat(98));
  console.log(
    `  LO THAT 2 VIDEO  ${apply ? "[CHAY THAT - CO TIEU TIEN]" : "[PREFLIGHT - khong chi gi]"}`,
  );
  console.log("=".repeat(98));

  // ------------------------------------------------------- 1. the material
  console.log("\n--- 1. Doc va kiem storyboard ---");
  const scan = scanImportSource(path.resolve(source));
  const validated = await validateImport(scan);
  const errors = validated.issues.filter((i) => i.level === "error");
  must("Khong loi validate", errors.length === 0, `${errors.length} loi`);
  must("Dung 2 video", validated.videos.length === 2, `${validated.videos.length}`);
  if (failures > 0) return finish();

  const totalScenes = validated.videos.reduce((n, v) => n + v.scenes.length, 0);
  const totalAi = validated.videos.reduce((n, v) => n + v.videoAiScenes, 0);
  const totalLocal = validated.videos.reduce((n, v) => n + v.localMotionScenes, 0);
  const totalAuto = validated.videos.reduce((n, v) => n + v.autoScenes, 0);
  must("Dung 10 canh", totalScenes === 10, `${totalScenes}`);
  must("Dung 9 LOCAL_MOTION", totalLocal === 9, `${totalLocal}`);
  must("Dung 1 VIDEO_AI", totalAi === 1, `${totalAi}`);
  must("Khong canh nao de AUTO", totalAuto === 0, `${totalAuto}`);

  // ------------------------------------------------------- 2. the cast
  console.log("\n--- 2. Nhan vat (phai dung lai, khong tao moi) ---");
  const seen = new Set<string>();
  for (const video of validated.videos) {
    for (const character of video.characters) {
      if (seen.has(character.name)) continue;
      seen.add(character.name);
      const existing = await prisma.character.findUnique({
        where: { name: character.name },
        include: { references: { where: { approved: true } } },
      });
      const primary = existing?.references.find((r) => r.isPrimary);
      must(
        `Nhan vat "${character.name}" da co ban ghi`,
        existing !== null,
        existing ? `id ${existing.id.slice(0, 8)}` : "CHUA CO — se tao moi",
      );
      must(
        `"${character.name}" co anh chuan da duyet`,
        (existing?.references.length ?? 0) > 0,
        primary ? `primary: ${primary.filePath}` : `${existing?.references.length ?? 0} anh`,
      );
    }
  }

  // --------------------------------------------- 3. rows, then the estimate
  console.log("\n--- 3. Tao lo (chi ghi DB) va DU TOAN gia that ---");
  const existingBatchId = arg("batch");
  const batchId =
    existingBatchId ||
    (
      await materialiseImport(validated, {
        batchName: "Lo that 2 video — Bite the bullet + All ears",
        maxCostPerVideo: MAX_PER_VIDEO,
        maxCostForBatch: MAX_BATCH,
      })
    ).batchId;
  const pre = await preflightImportedBatch(batchId);
  note("batch", batchId);
  note("AI_MOCK_MODE", String(isMockMode()));

  for (const v of pre.videos) {
    console.log(`\n  ${v.lifecycle.padEnd(10)} ${v.title}`);
    note("project", v.projectId);
    for (const s of v.scenes) {
      console.log(
        `      #${s.sceneNumber}  ${String(s.duration) + "s"} ${s.motionSource.padEnd(12)} ` +
          `${(s.videoModel ?? "ffmpeg/local-motion").padEnd(28)} ${money(s.estimatedCost)}`,
      );
    }
    note(
      "chi phi",
      `image ${money(v.breakdown.image)} · video ${money(v.breakdown.video)} · ` +
        `voice ${money(v.breakdown.voice)} · text ${money(v.breakdown.text)}`,
    );
    note("TONG VIDEO NAY", money(v.estimatedCost));
  }

  const cap = await spendStatus();
  const wallets = await providerSpendBreakdown();
  const creditsBefore = await runwayCredits();
  console.log("");
  note("TONG LO", money(pre.estimatedTotal));
  note("Han muc du an con lai", money(cap.remaining));
  note("Vi runway", `${creditsBefore ?? "?"} credit (LIVE GET)`);

  // ------------------------------------------------------------ 4. the gates
  console.log("\n--- 4. Cong chan (moi dieu kien phai dung cung luc) ---");

  // On a resume a video may legitimately be finished, stopped or mid-run; the
  // one state that is never acceptable is BLOCKED - that is a decision nobody
  // has taken yet, and resuming does not take it for them.
  const runnable = (lifecycle: string) =>
    resume ? lifecycle !== "BLOCKED" : lifecycle === "READY";
  for (const v of pre.videos) {
    must(
      `${v.title}: ${resume ? "khong BLOCKED" : "READY"}`,
      runnable(v.lifecycle),
      v.lifecycle + (v.blockedReason ? ` — ${v.blockedReason}` : ` / ${v.status}`),
    );
    must(
      `${v.title}: <= tran/video ${money(MAX_PER_VIDEO, 2)}`,
      v.estimatedCost <= MAX_PER_VIDEO,
      money(v.estimatedCost),
    );
  }
  must("Tong <= tran lo", pre.estimatedTotal <= MAX_BATCH, money(pre.estimatedTotal));
  must("Tong <= han muc du an", pre.estimatedTotal <= cap.remaining, money(cap.remaining));
  must(
    "Khong video nao bi chan",
    pre.videos.every((v) => runnable(v.lifecycle)),
    `${pre.videos.filter((v) => !runnable(v.lifecycle)).length} bi chan`,
  );
  if (resume) {
    // What was approved is already partly bought; the estimate now prices only
    // what is left, so comparing it with the original figure means nothing.
    note("Du toan phan CON LAI (resume)", money(pre.estimatedTotal));
  } else {
    // The operator approved a NUMBER. If the world has moved since, that is
    // their decision to re-take, not mine to absorb.
    must(
      `Du toan van dung bang ${money(APPROVED_ESTIMATE)}`,
      Math.abs(pre.estimatedTotal - APPROVED_ESTIMATE) < 1e-9,
      money(pre.estimatedTotal),
    );
  }

  const used = new Set<string>();
  for (const v of pre.videos) for (const s of v.scenes) if (s.videoModel) used.add(s.videoModel);
  must(
    "Chi dung dung 1 model video da duyet",
    // On a resume a clip that already exists is not routed at all, so "no model"
    // is the correct answer there - and anything other than the approved one
    // is still a stop.
    (used.size === 1 && used.has(APPROVED.video)) || (resume && used.size === 0),
    [...used].join(", ") || "(khong co)",
  );

  const confirmedList = await confirmedProviders();
  for (const key of Object.values(APPROVED)) {
    must(`Da xac nhan gia ${key}`, confirmedList.includes(key), "trong danh sach");
  }

  const [vprov, vmodel] = APPROVED.video.split("/") as [string, string];
  const videoRow = await prisma.modelRegistry.findUnique({
    where: { provider_modelId: { provider: vprov, modelId: vmodel } },
  });
  must(
    `${APPROVED.video} khong DEGRADED/DEPRECATED`,
    videoRow !== null &&
      videoRow.reliability === "OK" &&
      videoRow.lifecycle !== "DEPRECATED" &&
      videoRow.lifecycle !== "DISABLED",
    videoRow ? `${videoRow.lifecycle} / ${videoRow.reliability} / ${videoRow.verification}` : "?",
  );

  // The reason no fallback can fire. Counted, not asserted. See the header.
  console.log("");
  const providers = await availableProviderNames();
  note("Nha cung cap kha dung", providers.join(", "));
  must("mock KHONG kha dung", !providers.includes("mock"), providers.includes("mock") ? "CO (!!)" : "dung");
  for (const [type, key] of Object.entries(APPROVED)) {
    const pool = await prisma.modelRegistry.findMany({
      where: {
        enabled: true,
        type,
        provider: { in: providers },
        reliability: "OK",
        lifecycle: { notIn: ["DEPRECATED", "DISABLED", "PIN_ONLY"] },
      },
      select: { provider: true, modelId: true },
    });
    const keys = pool.map((m) => `${m.provider}/${m.modelId}`);
    must(
      `${type}: dung 1 model tu dong duoc -> khong du phong`,
      keys.length === 1 && keys[0] === key,
      keys.join(", ") || "(rong)",
    );
  }

  console.log("");
  must("Vi runway du 40 credit", (creditsBefore ?? 0) >= 40, `${creditsBefore ?? "?"} credit`);
  must("CREATE_ATTEMPT_TOKEN = 0", (await peekCreateToken()) === null, "null");
  const batchRow = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
  if (resume) {
    must("Lo khong bi huy", batchRow.status !== "CANCELLED", batchRow.status);
  } else {
    must("Lo dang PLANNED", batchRow.status === "PLANNED", batchRow.status);
  }
  for (const w of wallets) {
    note(`  vi ${w.provider}`, w.remainingUsd === null ? "hang tu quan" : `con ${money(w.remainingUsd)}`);
  }

  if (!apply) {
    console.log(
      `\n  PREFLIGHT xong. ${failures} dieu kien khong dat. KHONG goi API tra phi nao.\n` +
        `  Lo ${batchId} dang PLANNED, quyen chi DRAFT.\n` +
        (failures === 0
          ? `  Chay that:\n    AI_MOCK_MODE=false npx tsx scripts/run-real-multi-batch.ts ` +
            `--batch ${batchId} --apply --confirm-real-spend${resume ? " --resume" : ""}\n`
          :"  Sua het dieu kien roi chay lai.\n"),
    );
    if (failures > 0) process.exitCode = 1;
    return;
  }

  must("Da xac nhan chi tien that", confirmed, confirmed ? "--confirm-real-spend" : "THIEU CO");
  must("Mock Mode da TAT", !isMockMode(), `AI_MOCK_MODE=${isMockMode()}`);
  if (failures > 0) return finish();

  // -------------------------------------------------------------- 5. run it
  console.log("\n--- 5. CHAY THAT ---");
  const before = await snapshot();
  const runStart = new Date();
  note("So chi that TRUOC", money(before.spend));
  note("Runway credits TRUOC", String(creditsBefore ?? "?"));
  note("ProviderJob / CostEntry / Reservation TRUOC",
    `${before.providerJobs} / ${before.costEntries} / ${before.reservations}`);

  const authNow = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
  if (resume) {
    // A resume never re-approves. An approval still APPROVED carries on with
    // the money it has left; a closed one stays closed, so the only thing this
    // run CAN do is reuse - any purchase is refused at the gateway.
    note(
      "Quyen chi (resume, khong duyet lai)",
      authNow.status === "APPROVED"
        ? `APPROVED ${money(authNow.authorizedMaxSpend, 2)} - chi phan con thieu duoc mua`
        : `${authNow.status} - moi POST tra phi se bi CHAN, chi REUSE`,
    );
  } else await approveAuthorization({
    batchId,
    authorizedMaxSpend: MAX_BATCH,
    note: "First real multi-video batch, operator approved $1.00 / $0.70 per video",
    // Scene 3 names no model: the LOW_AUTO grant is what selects h3_max, and
    // approving an amount is not the same as agreeing the router may choose.
    // The operator fixed the model for this run and the preflight they approved
    // showed that exact route, so the mechanism is granted here explicitly -
    // never silently. See QĐ-069.
    lowAutoApproved: true,
  });
  if (!resume) {
    console.log(`  Quyen chi APPROVED = ${money(MAX_BATCH, 2)} (moi video <= ${money(MAX_PER_VIDEO, 2)})`);
  }
  // The batch page reads these columns. Left at PLANNED / script_ready, the
  // progress view would show a batch that is spending money as one waiting to
  // start - so the statuses move exactly when the work does.
  await prisma.batch.update({ where: { id: batchId }, data: { status: "RUNNING" } });

  const projects = await prisma.project.findMany({
    where: { batchId },
    orderBy: { createdAt: "asc" },
  });

  const outcomes: { projectId: string; title: string; stopped: string; rendered: boolean }[] = [];
  for (const project of projects) {
    const scenes = await prisma.scene.findMany({
      where: { projectId: project.id },
      orderBy: { sceneNumber: "asc" },
    });
    // A finished video on a resume is KEPT: its scenes are walked to prove each
    // asset comes back as REUSE, its status is never touched and it is never
    // re-rendered. A throw here means something tried to buy for a video that
    // is done - a V1 blocker, reported as such, never papered over.
    const kept =
      resume &&
      project.status === "completed" &&
      Boolean(project.finalVideoPath) &&
      fs.existsSync(toAbsolute(project.finalVideoPath!));
    console.log(
      `\n  === ${project.title} (${scenes.length} canh)${kept ? " — DA XONG, chi kiem REUSE" : ""} ===`,
    );
    if (!kept) {
      await prisma.project.update({
        where: { id: project.id },
        data: { status: "media_generating", errorMessage: null },
      });
    }
    let stopped = "";
    for (const scene of scenes) {
      try {
        await assertHeadroom(project.id, batchId, `canh ${scene.sceneNumber}`);
        await runScene(scene.id, project.id, batchId);
        console.log(
          `  [xong] canh ${scene.sceneNumber} — video da chi ${money(await spentOnProject(project.id))}`,
        );
      } catch (err) {
        stopped = err instanceof Error ? err.message : String(err);
        console.log(`  [HONG] canh ${scene.sceneNumber}: ${stopped}`);
        console.log("  DUNG VIDEO NAY. Khong thu lai, khong doi provider, khong mua lai.");
        if (kept) break;
        await prisma.scene.update({
          where: { id: scene.id },
          data: { status: "failed", errorMessage: stopped.slice(0, 500) },
        });
        break;
      }
    }

    // A failure in one video is not a reason to abandon the other: they share a
    // ceiling and nothing else. And a render that fails must never reach back
    // for the paid API - the assets are already bought and on disk.
    let rendered = false;
    if (kept) {
      rendered = !stopped;
      console.log(
        stopped ? "  VIDEO DA XONG NHUNG RESUME DOI MUA — BLOCKER" : "  Giu nguyen MP4, khong render lai.",
      );
    } else if (!stopped) {
      console.log("  --- render (FFmpeg tai may, $0) ---");
      try {
        await render(project.id);
        rendered = true;
        console.log("  [xong] render");
      } catch (err) {
        stopped = `render: ${err instanceof Error ? err.message : String(err)}`;
        console.log(`  [HONG] ${stopped}`);
        console.log("  Khong mua lai asset nao. Asset da co van nguyen tren dia.");
      }
    } else {
      console.log("  Bo qua render vi video chua du canh.");
    }
    // One video stopping is recorded on THAT video. The other one's run is
    // untouched, and the batch settles from both - see settleBatchIfDone.
    if (stopped && !kept) {
      await prisma.project.update({
        where: { id: project.id },
        data: { status: "failed", errorMessage: stopped.slice(0, 1000) },
      });
    }
    outcomes.push({ projectId: project.id, title: project.title, stopped, rendered });
  }

  // ---------------------------------------------------- 6. settle and report
  const stranded = await prisma.costReservation.findMany({
    where: { batchId, status: "RESERVED" },
    select: { idempotencyKey: true, kind: true, provider: true, estimatedCost: true },
  });
  for (const r of stranded) {
    await releaseReservation(r.idempotencyKey, { billed: false });
    console.log(`\n  Tra lai cho da giu ${r.kind}/${r.provider} ${money(r.estimatedCost)}`);
  }

  // COMPLETED / PARTIAL / FAILED - one bad video never makes the other worthless.
  const good = outcomes.filter((o) => !o.stopped && o.rendered);
  const verdict =
    good.length === outcomes.length ? "COMPLETED" : good.length === 0 ? "FAILED" : "PARTIAL";
  // The terminal status comes from the same rule the queue-driven runner uses,
  // not from a word invented here: PARTIAL is not a BatchStatus, and the batch
  // page would have rendered it as an unknown state. A half-finished batch is
  // NEEDS_REVIEW - the one status a person can retry a video from.
  const settled = await settleBatchIfDone(batchId);
  note("batch status", settled ?? "(chua chot - con video dang chay?)");

  await report(batchId, creditsBefore, before, runStart, outcomes, verdict);
}

/**
 * One scene: image, then the clip when the storyboard asked for one, then voice.
 *
 * Exactly one paid attempt per asset. The quality stage is deliberately absent -
 * see the header. Anything already completed is reused by the generation layer's
 * own idempotency, so a resume buys nothing.
 */
async function runScene(sceneId: string, projectId: string, batchId: string): Promise<void> {
  await generateSceneImage(sceneId);
  await assertHeadroom(projectId, batchId, "sau anh");

  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  if (scene.motionMode === "VIDEO_AI") {
    const key = `${scene.videoProvider}/${scene.videoModel}`;
    // The router has already chosen by the time the scene row says so. If it
    // chose anything but the model the operator fixed, that is a stop - not a
    // thing to work around.
    if (scene.videoProvider && scene.videoModel && key !== APPROVED.video) {
      throw new Error(`Canh ${scene.sceneNumber} doi model: cho ${APPROVED.video}, thuc te ${key}.`);
    }
    // Said only when a clip will actually be requested. On a resume the clip is
    // on disk and handed back; claiming a POST there would contradict the very
    // counter that proves nothing was bought.
    const owned = Boolean(scene.videoPath) && fs.existsSync(toAbsolute(scene.videoPath!));
    console.log(
      owned
        ? `    canh ${scene.sceneNumber}: clip da co -> REUSE, khong POST`
        : `    canh ${scene.sceneNumber}: POST dung 1 lan toi ${APPROVED.video}`,
    );
  }

  await generateSceneVideo(sceneId);
  await assertHeadroom(projectId, batchId, "sau clip");
  await generateSceneVoice(sceneId);

  // Written only when it changes. A resume walks finished scenes to prove
  // reuse, and must leave them exactly as they were - not even a new updatedAt.
  const done = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  if (done.status !== "completed" || done.errorMessage !== null) {
    await prisma.scene.update({
      where: { id: sceneId },
      data: { status: "completed", errorMessage: null },
    });
  }
}

async function render(projectId: string): Promise<void> {
  const row = await prisma.job.findFirst({
    where: { projectId, type: "render_final" },
    orderBy: { createdAt: "desc" },
  });
  const job =
    row ??
    (await prisma.job.create({
      data: { type: "render_final", projectId, status: "queued", maxAttempts: 1 },
    }));
  for (let i = 0; i < 120; i += 1) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "processing", attempts: 1, maxAttempts: 1, payloadJson: "{}" },
    });
    const fresh = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    try {
      const outcome = await runJob(fresh as Job);
      if (!outcome.deferred) {
        await completeJob(job.id, outcome.result);
        return;
      }
    } catch (err) {
      await failJob(job.id, err);
      throw err;
    }
  }
}

/**
 * Probe the MP4 as a FILE.
 *
 * A project row saying `completed` is bookkeeping. This asks the container what
 * it actually contains, and then looks for the two failures a valid-looking
 * render hides best: a long black stretch and an audio track that is silent.
 */
async function verifyFile(file: string, expectedSeconds: number): Promise<boolean> {
  let ok = true;
  const exists = fs.existsSync(file);
  ok = check("file ton tai", exists, file) && ok;
  if (!exists) return false;

  const size = fs.statSync(file).size;
  ok = check("size > 0", size > 0, `${(size / 1024 / 1024).toFixed(2)} MB`) && ok;

  const { stdout: v } = await ffprobe([
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_read_packets",
    "-of", "default=noprint_wrappers=1:nokey=0", file,
  ]);
  const get = (k: string, s = v): string => s.match(new RegExp(`${k}=(.+)`))?.[1]?.trim() ?? "";
  const width = Number(get("width"));
  const height = Number(get("height"));
  const rate = get("r_frame_rate");
  const fps = rate.includes("/") ? Number(rate.split("/")[0]) / Number(rate.split("/")[1]) : Number(rate);

  ok = check("co video stream", get("codec_name") !== "", get("codec_name")) && ok;
  ok = check("do phan giai 1080x1920", width === 1080 && height === 1920, `${width}x${height}`) && ok;
  ok = check("ti le 9:16", Math.abs(width / height - 9 / 16) < 1e-6, `${(width / height).toFixed(4)}`) && ok;
  ok = check("FPS hop le", Number.isFinite(fps) && fps > 0, fps.toFixed(2)) && ok;

  const { stdout: a } = await ffprobe([
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,channels,sample_rate",
    "-of", "default=noprint_wrappers=1:nokey=0", file,
  ]);
  const acodec = get("codec_name", a);
  ok = check("co audio stream", acodec !== "", `${acodec} ${get("channels", a)}ch ${get("sample_rate", a)}Hz`) && ok;

  const duration = await probeDuration(file);
  const drift = Math.abs(duration - expectedSeconds);
  ok = check("duration hop le", duration > 0, `${duration.toFixed(3)}s`) && ok;
  ok =
    check(
      "duration khop tong storyboard",
      drift <= Math.max(1.5, expectedSeconds * 0.15),
      `${duration.toFixed(3)}s vs storyboard ${expectedSeconds.toFixed(1)}s (lech ${drift.toFixed(3)}s)`,
    ) && ok;

  // Black frames and silence: the two ways a render passes every structural
  // check and is still unwatchable.
  try {
    const black = await ffmpeg(["-i", file, "-vf", "blackdetect=d=1.0:pic_th=0.98", "-an", "-f", "null", "-"]);
    const hits = (black.stderr.match(/black_start:/g) ?? []).length;
    ok = check("khong co doan den >= 1s", hits === 0, hits === 0 ? "khong" : `${hits} doan`) && ok;
  } catch {
    check("khong co doan den >= 1s", true, "khong kiem duoc (bo qua)");
  }
  try {
    const vol = await ffmpeg(["-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"]);
    const mean = vol.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1];
    const silent = mean !== undefined && Number(mean) < -60;
    ok = check("audio khong cam lang", !silent, mean !== undefined ? `mean ${mean} dB` : "khong doc duoc") && ok;
  } catch {
    check("audio khong cam lang", true, "khong kiem duoc (bo qua)");
  }
  return ok;
}

async function report(
  batchId: string,
  creditsBefore: number | null,
  before: Snapshot,
  runStart: Date,
  outcomes: { projectId: string; title: string; stopped: string; rendered: boolean }[],
  verdict: string,
): Promise<void> {
  console.log("\n" + "=".repeat(98));
  console.log("  KET QUA");
  console.log("=".repeat(98));

  const auth = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });
  const projectIds = outcomes.map((o) => o.projectId);

  let batchTotal = 0;
  const rows: { title: string; status: string; cost: number; mp4: string }[] = [];

  for (const [i, outcome] of outcomes.entries()) {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: outcome.projectId },
      include: { scenes: { orderBy: { sceneNumber: "asc" } } },
    });
    const scenes = project.scenes;
    const jobs = await prisma.providerJob.findMany({
      where: { projectId: project.id },
      select: {
        kind: true, provider: true, model: true, status: true, attempts: true,
        externalId: true, actualCost: true, failureCode: true, error: true,
        sceneId: true, createdAt: true,
      },
    });
    const made = jobs.filter((j) => j.createdAt >= runStart);
    const spent = await spentOnProject(project.id);
    batchTotal += spent;

    const byCat = await prisma.costEntry.groupBy({
      by: ["category"],
      where: { projectId: project.id, estimated: false },
      _sum: { amount: true },
    });
    const cat = (name: string) =>
      round(byCat.find((c) => c.category === name)?._sum.amount ?? 0);

    console.log(`\n${"-".repeat(98)}`);
    console.log(`  VIDEO ${i + 1}: ${project.title}`);
    console.log(`${"-".repeat(98)}`);
    note("project ID", project.id);
    note("status", project.status + (outcome.stopped ? `  (DUNG: ${outcome.stopped})` : ""));
    note("so scene", String(scenes.length));
    note("LOCAL_MOTION / VIDEO_AI",
      `${scenes.filter((s) => s.motionSource === "LOCAL_MOTION").length} / ` +
      `${scenes.filter((s) => s.motionSource === "AI_VIDEO").length}`);

    const imgMade = made.filter((j) => j.kind === "image" && j.status === "completed").length;
    const vidMade = made.filter((j) => j.kind === "video" && j.status === "completed").length;
    const voxMade = made.filter((j) => j.kind === "audio" && j.status === "completed").length;
    note("image created / reused",
      `${imgMade} / ${scenes.filter((s) => s.imagePath).length - imgMade}`);
    note("video clip created / reused",
      `${vidMade} / ${scenes.filter((s) => s.videoPath).length - vidMade}`);
    note("voice created / reused",
      `${voxMade} / ${scenes.filter((s) => s.audioPath).length - voxMade}`);
    note("ProviderJob count", `${jobs.length} (moi tao trong lan chay nay: ${made.length})`);
    note("retry count",
      `${made.reduce((n, j) => n + Math.max(0, j.attempts - 1), 0)} (scene.retryCount: ` +
      `${scenes.reduce((n, s) => n + s.retryCount, 0)})`);
    const failed = made.filter((j) => j.status === "failed");
    note("failed paid request", String(failed.length));
    for (const f of failed) {
      note(`  loi ${f.kind}`, `${f.provider}/${f.model} code=${f.failureCode ?? "-"} ${f.error ?? ""}`);
    }

    console.log("");
    for (const s of scenes) {
      const sj = jobs.filter((j) => j.sceneId === s.id);
      console.log(
        `      #${s.sceneNumber} ${s.motionSource.padEnd(12)} ${s.status.padEnd(10)} ` +
          `anh=${s.imagePath ? "co" : "-"} clip=${s.videoPath ? "co" : "-"} ` +
          `voice=${s.audioPath ? "co" : "-"}` +
          (sj.length ? `  [${sj.map((j) => `${j.kind}:${j.status}`).join(" ")}]` : ""),
      );
    }

    console.log("");
    note("render status", outcome.rendered ? "COMPLETED" : "KHONG RENDER");
    note("MP4 path", project.finalVideoPath ?? "(chua co)");
    note("subtitle path", project.subtitlePath ?? "(khong co)");

    if (project.finalVideoPath) {
      const file = toAbsolute(project.finalVideoPath);
      const expected = scenes.reduce((n, s) => n + s.duration, 0);
      console.log("\n  --- KIEM FILE THAT (ffprobe, khong doc DB) ---");
      await verifyFile(file, expected);
      check(
        "subtitle file ton tai",
        Boolean(project.subtitlePath) && fs.existsSync(toAbsolute(project.subtitlePath!)),
        project.subtitlePath ?? "(khong co)",
      );
      const numbers = scenes.map((s) => s.sceneNumber);
      check("scene lien tuc, khong thieu", numbers.every((n, k) => n === k + 1), numbers.join(","));
      check("khong trung scene", new Set(numbers).size === numbers.length, `${new Set(numbers).size}/${numbers.length}`);
    }

    console.log("");
    note("actual TEXT", money(cat("text")));
    note("actual IMAGE", money(cat("image")));
    note("actual VIDEO", money(cat("video")));
    note("actual VOICE", money(cat("voice")));
    note("ACTUAL TOTAL", money(spent));
    note("con lai trong tran/video", money(round(MAX_PER_VIDEO - spent)));
    // LOCAL_MOTION must cost nothing at the video API. Stated as a number.
    const localVideoCost = scenes
      .filter((s) => s.motionSource === "LOCAL_MOTION")
      .reduce((n, s) => {
        const j = jobs.filter((x) => x.sceneId === s.id && x.kind === "video");
        return n + j.reduce((m, x) => m + (x.actualCost ?? 0), 0);
      }, 0);
    check("LOCAL_MOTION ton $0 tien Video API", localVideoCost === 0, money(localVideoCost));

    rows.push({
      title: project.title,
      status: outcome.stopped ? (outcome.rendered ? "PARTIAL" : "FAILED") : "COMPLETED",
      cost: spent,
      mp4: project.finalVideoPath ?? "-",
    });
  }

  // ------------------------------------------------------------ whole batch
  console.log(`\n${"=".repeat(98)}`);
  console.log("  TOAN BATCH");
  console.log("=".repeat(98));

  const after = await snapshot();
  const creditsAfter = await runwayCredits();
  const cap = await spendStatus();
  const madeAll = await prisma.providerJob.findMany({
    where: { projectId: { in: projectIds }, createdAt: { gte: runStart } },
    select: { provider: true, kind: true, status: true, attempts: true, sceneId: true },
  });
  const byProvider = new Map<string, number>();
  for (const j of madeAll) byProvider.set(j.provider, (byProvider.get(j.provider) ?? 0) + 1);
  const dupes = new Map<string, number>();
  for (const j of madeAll) {
    const k = `${j.sceneId}/${j.kind}`;
    dupes.set(k, (dupes.get(k) ?? 0) + 1);
  }
  const duplicateJobs = [...dupes.values()].filter((n) => n > 1).length;
  const stillOpen = await prisma.costReservation.count({
    where: { batchId, status: "RESERVED" },
  });
  const ledger = await reservationLedger(batchId, auth.authorizedMaxSpend);
  const token = await peekCreateToken();

  note("AUTHORIZED BATCH", money(MAX_BATCH, 2));
  note("MAX PER VIDEO", money(MAX_PER_VIDEO, 2));
  note("ESTIMATED BEFORE RUN", money(APPROVED_ESTIMATE));
  console.log("");
  note("ACTUAL BATCH TOTAL", money(batchTotal));
  note("delta (actual - estimated)", money(round(batchTotal - APPROVED_ESTIMATE)));
  note("con lai trong quyen chi", money(round(MAX_BATCH - batchTotal)));
  console.log("");
  note("ngan sach du an truoc", money(round(8 - before.spend)));
  note("ngan sach du an sau", money(cap.remaining));
  note("Runway credits truoc/sau", `${creditsBefore ?? "?"} -> ${creditsAfter ?? "?"}`);
  note(
    "Runway credits da tieu",
    creditsBefore !== null && creditsAfter !== null ? String(creditsBefore - creditsAfter) : "?",
  );
  const openaiSpend = await prisma.costEntry.aggregate({
    where: { projectId: { in: projectIds }, provider: "openai", estimated: false },
    _sum: { amount: true },
  });
  note("OpenAI actual spend (ledger)", money(round(openaiSpend._sum.amount ?? 0)));
  console.log("");
  for (const [p, n] of byProvider) note(`paid POST — ${p}`, String(n));
  note("failed paid POST", String(madeAll.filter((j) => j.status === "failed").length));
  note("retry count", String(madeAll.reduce((n, j) => n + Math.max(0, j.attempts - 1), 0)));
  note("duplicate ProviderJob", String(duplicateJobs));
  console.log("");
  note("ProviderJob truoc/sau", `${before.providerJobs} -> ${after.providerJobs}`);
  note("CostEntry truoc/sau", `${before.costEntries} -> ${after.costEntries}`);
  note("CostReservation truoc/sau", `${before.reservations} -> ${after.reservations}`);
  note("reservation con treo", `${stillOpen} (${money(ledger.reserved)})`);
  // The four numbers a resume is judged on. Any of them above zero on a batch
  // that was already complete is a V1 blocker.
  note("DELTA ProviderJob", String(after.providerJobs - before.providerJobs));
  note("DELTA CostEntry", String(after.costEntries - before.costEntries));
  note("DELTA CostReservation", String(after.reservations - before.reservations));
  note("DELTA chi that", money(round(after.spend - before.spend)));
  note("authorization status", auth.status);
  note("CREATE_ATTEMPT_TOKEN cuoi", token === null ? "null" : "CON (!!)");

  // The operator's two conditions for calling the batch clean.
  console.log("");
  const cleanReservations = check("reservation treo = $0", ledger.reserved === 0, money(ledger.reserved));
  const cleanToken = check("CREATE_ATTEMPT_TOKEN = null", token === null, token === null ? "null" : "CON");
  note("LO CO SACH?", cleanReservations && cleanToken ? "SACH" : "CHUA SACH — xem hai dong tren");

  const reportPath = await writeBatchReport(batchId);
  note("batch-report.json", reportPath);

  console.log(`\n${"=".repeat(98)}`);
  console.log(`REAL MULTI-VIDEO BATCH: ${verdict}`);
  console.log("=".repeat(98));
  for (const [i, r] of rows.entries()) {
    console.log(`  Video ${i + 1} | ${r.status.padEnd(10)} | ${money(r.cost)} | ${r.mp4}`);
  }
  console.log(
    `  Batch   | ${money(batchTotal)} | authorization ${money(MAX_BATCH, 2)} | ` +
      `con lai ${money(round(MAX_BATCH - batchTotal))}`,
  );
  console.log("");
  console.log(`PAID POST COUNT:          ${madeAll.length}`);
  console.log(`PAID RETRY COUNT:         ${madeAll.reduce((n, j) => n + Math.max(0, j.attempts - 1), 0)}`);
  console.log(`DUPLICATE PROVIDER JOB:   ${duplicateJobs}`);
  console.log(`RESERVATION STILL OPEN:   ${stillOpen} (${money(ledger.reserved)})`);
  console.log(`CREATE_ATTEMPT_TOKEN:     ${token === null ? "null" : "CON (!!)"}`);
  console.log(`PROJECT BUDGET REMAINING: ${money(cap.remaining)}`);
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
