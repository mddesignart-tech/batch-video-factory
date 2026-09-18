import fs from "node:fs";
import type { Job, Project, Scene } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { toAbsolute } from "@/lib/paths";
import { sleep } from "@/lib/utils";
import { peekCreateToken } from "@/services/create-token";
import {
  confirmProvider,
  confirmedProviders,
  revokeProvider,
  spendStatus,
  totalRealSpend,
} from "@/services/spend-guard";
import { providerSpendBreakdown } from "@/services/provider-budget";
import { batchApprovalFor } from "@/services/batch-authorization";
import { release as releaseReservation, reservationLedger } from "@/services/cost-reservation";
import { storedPlan } from "@/services/batch-runner";
import { previewProjectCost } from "@/services/project-service";
import {
  buildSceneImageRequest,
  generateSceneImage,
  generateSceneVideo,
  generateSceneVoice,
  idempotencyKey,
} from "@/services/generation";
import { deriveSceneVideoFacts } from "@/services/low-auto-facts";
import { lowAutoEligibility } from "@/domain/low-auto";
import { completeJob, failJob } from "@/jobs/queue";
import { runJob } from "@/jobs/handlers";
import { probeDuration, ffprobe } from "@/media/ffmpeg";

/**
 * Resume ONE batch that stopped part-way, without buying anything twice.
 *
 * ## Why this is not `run-first-real-batch.ts`
 *
 * That script STARTS a batch: it expands the plan into a project, enqueues the
 * scene jobs and drains them. Pointed at a batch that has already run, it does
 * three things that are wrong for a resume:
 *
 *   - it creates a SECOND `batch_expand` job rather than re-attaching the jobs
 *     that already exist;
 *   - it drains only `queued` jobs, so the scene that actually failed - the one
 *     the whole resume is for - is never picked up;
 *   - it refuses to start when a scene carries a model on its row, because on a
 *     first run that can only be a hand pin. After `startMediaForBatchVideo` has
 *     run, the same column holds the APPROVED PLAN written down, and refusing it
 *     would mean no batch could ever be resumed.
 *
 * ## What it keeps
 *
 * Every paid request still goes through `runProviderJob`: same idempotency key,
 * same BATCH_SPEND_AUTHORIZATION, same reservation before the request leaves,
 * same settlement against the actual cost. Nothing here is a side door around
 * the gateway, and this script never writes a ledger row itself.
 *
 * ## What it deliberately does NOT do
 *
 * `handleSceneMedia` ends with `evaluateScene`, and a quality verdict below the
 * threshold bumps `scene.retryCount` and re-queues the scene. That increment
 * changes the idempotency key, so the re-queued job buys the image AND the clip
 * again - $0.44 on this project - on the word of a MOCK quality model. The rule
 * for this run is one attempt per paid POST, so the scene chain is driven step
 * by step here and the quality stage is left out.
 *
 * It also re-asks the LOW_AUTO question AFTER the keyframe exists and BEFORE the
 * clip is bought. The frozen plan reaches `routeFor` as a pin, and a pin is
 * honoured without that gate - right for a pin a human typed, exactly wrong for
 * one that is a machine's earlier answer to the same question. Asking again
 * costs nothing, and it is the difference between buying an image-to-video clip
 * with an image and buying one without.
 *
 *   npx tsx scripts/resume-batch.ts --batch <id>                  # dry run, $0
 *   AI_MOCK_MODE=false npx tsx scripts/resume-batch.ts --batch <id> \
 *     --apply --confirm-real-spend
 */

const RUNWAY_BASE = "https://api.dev.runwayml.com/v1";

/** The routing the operator approved. Anything else is a stop, not a warning. */
const APPROVED_ROUTE: Record<number, { motion: string; video: string | null }> = {
  1: { motion: "AI_VIDEO", video: "runway/h3_max:768x1280" },
  2: { motion: "LOCAL_MOTION", video: null },
  3: { motion: "LOCAL_MOTION", video: null },
  4: { motion: "AI_VIDEO", video: "runway/h3_max:768x1280" },
  5: { motion: "LOCAL_MOTION", video: null },
  6: { motion: "LOCAL_MOTION", video: null },
};

/** Models that must not appear anywhere in this run, whatever the router thinks. */
const BANNED = ["sora", "gen4.5", "gen4_turbo", "wan3", "veo3"];

/** Confirmed only for the length of this run, then taken back in `finally`. */
const TEMP_CONFIRM = { provider: "runway", model: "h3_max:768x1280" } as const;

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const money = (n: number, d = 6) => `$${n.toFixed(d)}`;

let failures = 0;
function must(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "[DAT ]" : "[DUNG]"} ${label.padEnd(38)} ${detail}`);
}
function note(label: string, detail: string): void {
  console.log(`  [    ] ${label.padEnd(38)} ${detail}`);
}

/** Free GET. Used before and after so the credit delta is measured, not assumed. */
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

type Verdict = "REUSE" | "NEW_PAID" | "RESUME_ATTACH" | "FREE";

interface KeyProof {
  sceneNumber: number;
  kind: string;
  model: string;
  key: string;
  existing: string | null;
  fileOnDisk: boolean;
  verdict: Verdict;
  detail: string;
}

/**
 * Recompute the key production will use, and say what the gateway will do with
 * it. This is the whole idempotency argument: if the key matches a completed
 * ProviderJob whose file is still on disk, `runProviderJob` hands that file back
 * before it reaches the budget gate, the reservation or the vendor.
 */
async function proveKeys(project: Project, scenes: Scene[]): Promise<KeyProof[]> {
  const out: KeyProof[] = [];

  for (const scene of scenes) {
    if (scene.imageProvider && scene.imageModel) {
      const shot = await buildSceneImageRequest(scene, project.stylePresetId);
      const key = idempotencyKey({
        sceneId: scene.id,
        kind: "image",
        provider: scene.imageProvider,
        model: scene.imageModel,
        prompt: shot.prompt,
        generation: scene.retryCount,
        variant: "",
      });
      out.push(await classify(scene.sceneNumber, "image", scene.imageModel, key));
    }

    const derived = deriveSceneVideoFacts(scene, {
      qualityMode: project.qualityMode,
      stage: "VIDEO",
    });
    if (derived.motion.source === "LOCAL_MOTION") {
      out.push({
        sceneNumber: scene.sceneNumber,
        kind: "video",
        model: "ffmpeg/local-motion",
        key: "-",
        existing: null,
        fileOnDisk: false,
        verdict: "FREE",
        detail: "LOCAL_MOTION, khong co request tra phi",
      });
      continue;
    }
    if (scene.videoProvider && scene.videoModel) {
      const key = idempotencyKey({
        sceneId: scene.id,
        kind: "video",
        provider: scene.videoProvider,
        model: scene.videoModel,
        prompt: derived.videoPrompt,
        generation: scene.retryCount,
        variant: `${scene.duration}s`,
      });
      out.push(await classify(scene.sceneNumber, "video", scene.videoModel, key));
    }
  }
  return out;
}

async function classify(
  sceneNumber: number,
  kind: string,
  model: string,
  key: string,
): Promise<KeyProof> {
  const job = await prisma.providerJob.findUnique({ where: { idempotencyKey: key } });
  if (!job) {
    return {
      sceneNumber,
      kind,
      model,
      key,
      existing: null,
      fileOnDisk: false,
      verdict: "NEW_PAID",
      detail: "chua co ProviderJob nao -> se la POST that dau tien",
    };
  }
  const stored = JSON.parse(job.responseJson ?? "{}") as { filePath?: string };
  const onDisk = Boolean(stored.filePath && fs.existsSync(stored.filePath));
  if (job.status === "completed" && job.externalId && onDisk) {
    return {
      sceneNumber,
      kind,
      model,
      key,
      existing: job.externalId,
      fileOnDisk: true,
      verdict: "REUSE",
      detail: `da hoan tat, file con tren dia -> tra lai mien phi (da tra ${money(job.actualCost ?? 0)} truoc do)`,
    };
  }
  if ((job.status === "pending" || job.status === "processing") && job.externalId) {
    return {
      sceneNumber,
      kind,
      model,
      key,
      existing: job.externalId,
      fileOnDisk: onDisk,
      verdict: "RESUME_ATTACH",
      detail: "job cu con song -> bam theo externalId, KHONG POST lai",
    };
  }
  return {
    sceneNumber,
    kind,
    model,
    key,
    existing: job.externalId,
    fileOnDisk: onDisk,
    verdict: "NEW_PAID",
    detail: `ProviderJob ${job.status}${onDisk ? "" : ", file khong con tren dia"} -> se POST moi`,
  };
}

/**
 * Would LOW_AUTO pick this model for this scene on its own merits, now that the
 * keyframe exists? `manualPinElsewhere` is deliberately false: the frozen plan
 * IS the answer being re-checked, so leaving it true would make the gate refuse
 * to answer its own question.
 */
async function lowAutoCheck(scene: Scene, project: Project) {
  const derived = deriveSceneVideoFacts(scene, {
    qualityMode: project.qualityMode,
    stage: "VIDEO",
    ignoreManualPin: true,
  });
  const model = await prisma.modelRegistry.findUnique({
    where: {
      provider_modelId: {
        provider: scene.videoProvider ?? "",
        modelId: scene.videoModel ?? "",
      },
    },
  });
  const wallets = Object.fromEntries(
    (await providerSpendBreakdown()).map((r) => [r.provider, r.remainingUsd]),
  );
  const auth = await batchApprovalFor(project.batchId);
  const cap = await spendStatus();
  return {
    derived,
    model,
    verdict: lowAutoEligibility({
      ...derived.facts,
      complexity: scene.complexity,
      characterCount: derived.characterCount,
      modelLifecycle: model?.lifecycle ?? "MISSING",
      modelReliability: model?.reliability ?? "MISSING",
      modelVerification: model?.verification ?? "MISSING",
      estimatedCost: (model?.price ?? 0) * scene.duration,
      budgetRemaining: cap.remaining,
      providerBudgetRemaining: wallets[scene.videoProvider ?? ""] ?? null,
      perVideoCapRemaining: auth?.maxCostPerVideo ?? null,
      manualPinElsewhere: false,
    }),
  };
}

async function main(): Promise<void> {
  const batchId = arg("batch");
  const apply = process.argv.includes("--apply");
  const confirmed = process.argv.includes("--confirm-real-spend");

  console.log("=".repeat(92));
  console.log(
    `  TIEP TUC LO DANG CHAY DO  ${apply ? "[CHAY THAT]" : "[DRY RUN - khong chi gi]"}`,
  );
  console.log("=".repeat(92));

  // ------------------------------------------------------- 1. preconditions
  console.log("\n--- 1. Dieu kien tien quyet ---");
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: {
      authorization: true,
      projects: { include: { scenes: { orderBy: { sceneNumber: "asc" } } } },
    },
  });
  must("Tim thay lo", batch !== null, batchId);
  if (!batch) return finish();

  const auth = batch.authorization;
  must("Quyen chi APPROVED", auth?.status === "APPROVED", auth?.status ?? "khong co");
  must("lowAutoApproved = true", auth?.lowAutoApproved === true, String(auth?.lowAutoApproved));
  must("Lo co dung 1 project", batch.projects.length === 1, `${batch.projects.length} project`);
  const project = batch.projects[0];
  if (!project || !auth) return finish();

  const scenes = project.scenes.filter((s) => !s.skipped);
  must("Du 6 canh", scenes.length === 6, `${scenes.length} canh`);
  must("Khong tao project moi", project.batchId === batchId, project.id.slice(0, 8));

  const ledgerBefore = await reservationLedger(batchId, auth.authorizedMaxSpend);
  note("Tran duyet", money(ledgerBefore.ceiling));
  note(
    "Da dung trong lo",
    `${money(ledgerBefore.used)} (committed ${money(ledgerBefore.committed)}, reserved ${money(ledgerBefore.reserved)})`,
  );
  note("Con lai trong lo", money(ledgerBefore.available));

  const cap = await spendStatus();
  note("Han muc tong", `da chi ${money(cap.spent)} / ${money(cap.cap, 2)}, con ${money(cap.remaining)}`);
  const token = await peekCreateToken();
  must("CREATE_ATTEMPT_TOKEN = 0", token === null, token ? "CO TOKEN (!!)" : "0 - dung quyen chi cua lo");

  const plan = storedPlan(batch);
  const planned = plan?.production?.estimatedTotal ?? 0;
  must("Lo co ban du toan da dong bang", plan !== null, `du toan ${money(planned)}`);
  must(
    "Du toan <= tran duyet",
    planned <= auth.authorizedMaxSpend,
    `${money(planned)} <= ${money(auth.authorizedMaxSpend, 2)}`,
  );

  // ---------------------------------------- 2. routing vs what was approved
  console.log("\n--- 2. Doi chieu routing dong bang voi plan da duyet ---");
  for (const scene of scenes) {
    const want = APPROVED_ROUTE[scene.sceneNumber];
    const got =
      scene.videoProvider && scene.videoModel
        ? `${scene.videoProvider}/${scene.videoModel}`
        : null;
    const ok = want !== undefined && want.motion === scene.motionSource && want.video === got;
    must(`Canh ${scene.sceneNumber} dung plan`, ok, `${scene.motionSource} ${got ?? "(local)"}`);
  }
  const banned = scenes.filter((s) => s.videoModel && BANNED.some((b) => s.videoModel!.includes(b)));
  must(
    "Khong Sora/gen4.5/gen4_turbo/wan3/veo3",
    banned.length === 0,
    banned.map((b) => `canh ${b.sceneNumber}`).join(", ") || "0 canh vi pham",
  );

  const preview = await previewProjectCost(project.id);
  must(
    "Khong canh nao thieu provider",
    preview.current.needsProvider.length === 0,
    `${preview.current.needsProvider.length} canh`,
  );
  must("Khong loi dinh tuyen", preview.current.errors.length === 0, `${preview.current.errors.length} loi`);

  // ------------------------------------------- 3. the idempotency proof
  console.log("\n--- 3. Chung minh idempotency (khoa nao se duoc dung lai) ---");
  const proofs = await proveKeys(project, scenes);
  for (const p of proofs) {
    const tag =
      p.verdict === "REUSE"
        ? "DUNG LAI"
        : p.verdict === "FREE"
          ? "MIEN PHI"
          : p.verdict === "RESUME_ATTACH"
            ? "BAM THEO"
            : "MUA MOI";
    console.log(
      `  canh ${p.sceneNumber} ${p.kind.padEnd(5)} ${p.model.padEnd(24)} ${tag.padEnd(9)} ` +
        `key=${p.key.slice(0, 12)} ${p.detail}`,
    );
  }
  const scene1Image = proofs.find((p) => p.sceneNumber === 1 && p.kind === "image");
  must(
    "Anh canh 1 duoc DUNG LAI, khong mua lai",
    scene1Image?.verdict === "REUSE",
    scene1Image ? `${scene1Image.verdict} ext=${scene1Image.existing ?? "-"}` : "khong tinh duoc khoa",
  );
  must(
    "Khong ProviderJob video nao con treo o vendor",
    proofs.filter((p) => p.kind === "video" && p.verdict === "RESUME_ATTACH").length === 0,
    "0 job video dang treo",
  );
  must(
    "Khong canh nao bi tang retryCount",
    scenes.every((s) => s.retryCount === 0),
    scenes.map((s) => s.retryCount).join(","),
  );

  const willBuy = proofs.filter((p) => p.verdict === "NEW_PAID");
  note(
    "So request tra phi se gui",
    `${willBuy.length} (${willBuy.map((p) => `canh ${p.sceneNumber}/${p.kind}`).join(", ")})`,
  );

  // ------------------------------------------ 4. LOW_AUTO, asked again
  console.log("\n--- 4. Hoi lai cong LOW_AUTO (bo ghim ra, hoi dung cau hoi cua router) ---");
  for (const scene of scenes.filter((s) => s.motionSource === "AI_VIDEO")) {
    const { verdict, model, derived } = await lowAutoCheck(scene, project);
    const reason = verdict.eligible ? "du moi dieu kien" : verdict.blockers.map((b) => b.code).join(", ");
    note(
      `Canh ${scene.sceneNumber} ${model?.provider}/${model?.modelId}`,
      `${verdict.eligible ? "DAT" : "CHUA DAT"} | keyframe=${derived.hasKeyframe ? "co" : "chua"} | ` +
        `camera=${derived.cameraIntent.mode} | ${reason}`,
    );
  }
  console.log(
    "  (canh chua co anh se hien CHUA DAT vi thieu keyframe - dung, va se duoc hoi lai\n" +
      "   ngay sau khi anh duoc tao, TRUOC khi POST clip.)",
  );

  // --------------------------------------------------- 5. the forecast
  console.log("\n--- 5. Du bao tien cua lan chay nay ---");
  const models = await prisma.modelRegistry.findMany();
  let forecast = 0;
  for (const p of willBuy) {
    const m = models.find((x) => x.modelId === p.model);
    const scene = scenes.find((s) => s.sceneNumber === p.sceneNumber)!;
    const cost = p.kind === "video" ? (m?.price ?? 0) * scene.duration : (m?.price ?? 0);
    forecast += cost;
    console.log(`  canh ${p.sceneNumber} ${p.kind.padEnd(5)} ${p.model.padEnd(24)} ~${money(cost)}`);
  }
  const voiceModel = models.find((m) => m.modelId === "gpt-4o-mini-tts");
  const voiceForecast = (voiceModel?.price ?? 0) * 0.2;
  forecast += voiceForecast;
  console.log(`  voice (6 canh, ~225 ky tu)                      ~${money(voiceForecast)}`);
  console.log(`  ${"TONG DU BAO".padEnd(48)}~${money(forecast)}`);
  must(
    "Du bao nam trong phan con lai cua lo",
    forecast <= ledgerBefore.available,
    `${money(forecast)} <= ${money(ledgerBefore.available)}`,
  );
  must(
    "Du bao nam trong han muc tong",
    forecast <= cap.remaining,
    `${money(forecast)} <= ${money(cap.remaining)}`,
  );

  if (!apply) {
    console.log(
      `\n  DRY RUN xong. ${failures} dieu kien khong dat. Khong goi API tra phi nao.\n` +
        `  Chay that: AI_MOCK_MODE=false npx tsx scripts/resume-batch.ts --batch ${batchId} --apply --confirm-real-spend\n`,
    );
    if (failures > 0) process.exitCode = 1;
    return;
  }

  must("Da xac nhan chi tien that", confirmed, confirmed ? "--confirm-real-spend" : "THIEU CO");
  must("Mock Mode da TAT", !isMockMode(), `AI_MOCK_MODE=${isMockMode()}`);
  if (failures > 0) return finish();

  // ------------------------------------------------------------ 6. run it
  const creditsBefore = await runwayCredits();
  const pjBefore = await prisma.providerJob.count({ where: { projectId: project.id } });
  const postsBefore = await prisma.providerJob.count({
    where: { projectId: project.id, externalId: { not: null } },
  });
  console.log("\n--- 6. Chay tiep ---");
  console.log(`  Runway credits TRUOC: ${creditsBefore ?? "(khong doc duoc)"}`);

  const hadConfirm = (await confirmedProviders()).includes(
    `${TEMP_CONFIRM.provider}/${TEMP_CONFIRM.model}`,
  );
  let stopped = "";
  try {
    if (!hadConfirm) {
      await confirmProvider(TEMP_CONFIRM.provider, TEMP_CONFIRM.model);
      console.log(`  Da BAT xac nhan tam thoi: ${TEMP_CONFIRM.provider}/${TEMP_CONFIRM.model}`);
    }

    // Only job rows that already exist may run. A job created DURING this run -
    // which is what a quality retry would be - is left alone, so no paid POST
    // can be repeated behind the operator's back.
    const jobs = await prisma.job.findMany({
      where: { projectId: project.id, status: { in: ["queued", "failed"] } },
      orderBy: { priority: "asc" },
    });
    const sceneJobs = jobs.filter((j) => j.type === "generate_scene_media");
    const renderJob = jobs.find((j) => j.type === "render_final");
    console.log(`  Bam lai ${sceneJobs.length} job canh co san + ${renderJob ? 1 : 0} job render`);

    for (const job of sceneJobs) {
      const scene = scenes.find((s) => s.id === job.sceneId);
      if (!scene) continue;
      // Re-attach: the SAME row, one attempt, no retry budget, and nothing
      // written to scene.retryCount - that column is what keeps the keys stable.
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "processing",
          attempts: 1,
          maxAttempts: 1,
          error: null,
          startedAt: new Date(),
          finishedAt: null,
        },
      });
      try {
        await runScene(scene.id, project);
        await completeJob(job.id, { sceneId: scene.id, resumed: true });
        console.log(`  [xong] canh ${scene.sceneNumber}`);
      } catch (err) {
        await failJob(job.id, err);
        stopped = err instanceof Error ? err.message : String(err);
        console.log(`  [HONG] canh ${scene.sceneNumber}: ${stopped}`);
        console.log("  DUNG NGAY. Khong thu lai request tra phi, khong doi provider.");
        break;
      }
    }

    if (!stopped && renderJob) {
      console.log("  --- render final ---");
      for (let i = 0; i < 120; i += 1) {
        const row = await prisma.job.findUnique({ where: { id: renderJob.id } });
        if (!row) break;
        await prisma.job.update({
          where: { id: row.id },
          data: { status: "processing", startedAt: new Date() },
        });
        try {
          const outcome = await runJob({ ...row, status: "processing" } as Job);
          if (!outcome.deferred) {
            await completeJob(row.id, outcome.result);
            console.log("  [xong] render_final");
            break;
          }
          await sleep(1000);
        } catch (err) {
          await failJob(row.id, err);
          stopped = err instanceof Error ? err.message : String(err);
          console.log(`  [HONG] render_final: ${stopped}`);
          break;
        }
      }
    }
  } finally {
    if (!hadConfirm) {
      await revokeProvider(TEMP_CONFIRM.provider, TEMP_CONFIRM.model);
      console.log(`  Da THU HOI xac nhan tam thoi: ${TEMP_CONFIRM.provider}/${TEMP_CONFIRM.model}`);
    }
  }

  // ---------------------------------------------- 7. settle what is left
  const stranded = await prisma.costReservation.findMany({
    where: { batchId, status: "RESERVED" },
    select: { idempotencyKey: true, kind: true, provider: true, estimatedCost: true },
  });
  if (stranded.length > 0) {
    console.log(`\n--- 7. Dong ${stranded.length} giu cho con treo ---`);
    for (const r of stranded) {
      // `billed: true` on purpose: if we knew the vendor had not charged, the
      // request would have settled itself. Handing budget back for a clip that
      // WAS billed is how a batch overspends while every figure still adds up.
      await releaseReservation(r.idempotencyKey, { billed: true });
      console.log(
        `  ${r.kind}/${r.provider} ${money(r.estimatedCost)} -> RELEASED (coi nhu DA bi tinh phi)`,
      );
    }
  }

  await report(batchId, project.id, creditsBefore, pjBefore, postsBefore, stopped);
}

/**
 * One scene, in the order the operator's rules require.
 *
 * image -> re-ask LOW_AUTO with the keyframe now on disk -> clip -> voice.
 * No quality stage, so nothing here can bump `retryCount` and invalidate a key.
 */
async function runScene(sceneId: string, project: Project): Promise<void> {
  await generateSceneImage(sceneId);

  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  const want = APPROVED_ROUTE[scene.sceneNumber];
  if (!want) throw new Error(`Canh ${scene.sceneNumber} khong co trong plan da duyet.`);

  if (want.motion === "AI_VIDEO") {
    const { verdict, derived, model } = await lowAutoCheck(scene, project);
    const actual = `${scene.videoProvider}/${scene.videoModel}`;
    if (actual !== want.video) {
      throw new Error(
        `Canh ${scene.sceneNumber} doi model: plan ${want.video}, thuc te ${actual}.`,
      );
    }
    if (!derived.hasKeyframe) {
      throw new Error(
        `Canh ${scene.sceneNumber}: khong co keyframe that tren dia sau buoc tao anh. ` +
          `Khong POST clip image-to-video khong co anh.`,
      );
    }
    if (!verdict.eligible) {
      throw new Error(
        `Canh ${scene.sceneNumber} khong qua cong LOW_AUTO sau khi co keyframe: ` +
          verdict.blockers.map((b) => b.message).join("; "),
      );
    }
    console.log(
      `    canh ${scene.sceneNumber}: keyframe OK, LOW_AUTO DAT ` +
        `(${model?.provider}/${model?.modelId}) -> POST dung 1 lan`,
    );
  }

  await generateSceneVideo(sceneId);
  await generateSceneVoice(sceneId);
  await prisma.scene.update({
    where: { id: sceneId },
    data: { status: "completed", errorMessage: null },
  });
}

async function report(
  batchId: string,
  projectId: string,
  creditsBefore: number | null,
  pjBefore: number,
  postsBefore: number,
  stopped: string,
): Promise<void> {
  console.log("\n" + "=".repeat(92));
  console.log("  KET QUA");
  console.log("=".repeat(92));

  const batch = await prisma.batch.findUniqueOrThrow({
    where: { id: batchId },
    include: { authorization: true },
  });
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { scenes: { orderBy: { sceneNumber: "asc" } } },
  });

  console.log(`\n  Lo                 : ${batchId}`);
  console.log(`  Trang thai lo      : ${batch.status}`);
  console.log(
    `  Quyen chi          : ${batch.authorization?.status} tran ${money(batch.authorization?.authorizedMaxSpend ?? 0, 2)}`,
  );
  console.log(`  Trang thai project : ${project.status}`);
  if (project.errorMessage) console.log(`  Loi                : ${project.errorMessage}`);

  console.log("\n  --- TUNG CANH ---");
  for (const scene of project.scenes) {
    const route = scene.motionSource === "LOCAL_MOTION" ? "LOCAL_MOTION" : "AI_VIDEO";
    const model =
      scene.motionSource === "LOCAL_MOTION"
        ? "ffmpeg/local-motion"
        : `${scene.videoProvider ?? "-"}/${scene.videoModel ?? "-"}`;
    const pj = await prisma.providerJob.findMany({
      where: { sceneId: scene.id },
      select: { kind: true, externalId: true, status: true, actualCost: true, attempts: true },
    });
    console.log(
      `  canh ${scene.sceneNumber} ${route.padEnd(12)} ${model.padEnd(28)} ${scene.status.padEnd(11)} ` +
        `anh=${scene.imagePath ? "co" : "-"} clip=${scene.videoPath ? "co" : "-"} ` +
        `retryCount=${scene.retryCount} actual=${money(scene.actualCost)}`,
    );
    for (const j of pj) {
      console.log(
        `        ${j.kind.padEnd(5)} task=${j.externalId ?? "-"} ${j.status} ` +
          `actual=${money(j.actualCost ?? 0)} attempts=${j.attempts}`,
      );
    }
  }

  console.log("\n  --- CHI PHI THAT TRONG LO (so CostEntry, estimated=false) ---");
  const rows = await prisma.costEntry.groupBy({
    by: ["category", "provider"],
    where: { batchId, estimated: false },
    _sum: { amount: true },
    _count: { _all: true },
  });
  let total = 0;
  for (const r of rows) {
    const amt = r._sum.amount ?? 0;
    total += amt;
    console.log(
      `  ${r.category.padEnd(9)} ${r.provider.padEnd(9)} ${String(r._count._all).padStart(2)} lan  ${money(amt)}`,
    );
  }
  const ceiling = batch.authorization?.authorizedMaxSpend ?? 0;
  console.log(`  ${"TONG".padEnd(19)}       ${money(total)}`);
  console.log(`  Da duyet            ${money(ceiling, 2)}`);
  console.log(`  Chua dung           ${money(Math.max(0, ceiling - total))}`);
  console.log(`  VUOT TRAN?          ${total > ceiling ? "CO (!!)" : "KHONG"}`);

  const ledger = await reservationLedger(batchId, ceiling);
  const byStatus = await prisma.costReservation.groupBy({
    by: ["status"],
    where: { batchId },
    _count: { _all: true },
    _sum: { estimatedCost: true, actualCost: true },
  });
  console.log("\n  --- GIU CHO ---");
  for (const s of byStatus) {
    console.log(
      `  ${s.status.padEnd(10)} ${String(s._count._all).padStart(2)} ban ghi  ` +
        `uoc tinh ${money(s._sum.estimatedCost ?? 0)}  thuc te ${money(s._sum.actualCost ?? 0)}`,
    );
  }
  console.log(`  con giu (RESERVED)  ${money(ledger.reserved)}  <- phai = $0.000000`);

  const creditsAfter = await runwayCredits();
  const pjAfter = await prisma.providerJob.count({ where: { projectId } });
  const postsAfter = await prisma.providerJob.count({
    where: { projectId, externalId: { not: null } },
  });
  console.log("\n  --- RUNWAY / SO LAN POST ---");
  console.log(`  credits truoc       ${creditsBefore ?? "?"}`);
  console.log(`  credits sau         ${creditsAfter ?? "?"}`);
  console.log(
    `  chenh lech          ${creditsBefore !== null && creditsAfter !== null ? creditsBefore - creditsAfter : "?"}`,
  );
  console.log(`  ProviderJob truoc   ${pjBefore}`);
  console.log(`  ProviderJob sau     ${pjAfter}  (moi: ${pjAfter - pjBefore})`);
  console.log(`  POST that lan nay   ${postsAfter - postsBefore}`);

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
          "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_frames",
          "-of", "default=noprint_wrappers=1",
          file,
        ]);
        console.log(`  ${info.trim().split("\n").join("\n  ")}`);
        const { stdout: audio } = await ffprobe([
          "-v", "error",
          "-select_streams", "a:0",
          "-show_entries", "stream=codec_name,channels,sample_rate",
          "-of", "default=noprint_wrappers=1",
          file,
        ]);
        console.log(`  ${audio.trim().split("\n").join("\n  ")}`);
      } catch {
        console.log("  (khong doc duoc thong so stream)");
      }
    }
    console.log(`  phu de              ${project.subtitlePath ?? "-"}`);
  } else {
    console.log("  CHUA CO MP4.");
  }

  console.log(`\n  Tong tien that toan ung dung: ${money(await totalRealSpend())}`);
  const stillConfirmed = (await confirmedProviders()).includes(
    `${TEMP_CONFIRM.provider}/${TEMP_CONFIRM.model}`,
  );
  console.log(`  Xac nhan h3_max con bat?     ${stillConfirmed ? "CON (!!)" : "DA THU HOI"}`);
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
