import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { toAbsolute } from "@/lib/paths";
import { peekCreateToken } from "@/services/create-token";
import {
  confirmProvider,
  confirmedProviders,
  revokeProvider,
  spendStatus,
  totalRealSpend,
} from "@/services/spend-guard";
import { providerSpendBreakdown } from "@/services/provider-budget";
import { approveAuthorization } from "@/services/batch-authorization";
import { release as releaseReservation, reservationLedger } from "@/services/cost-reservation";
import {
  materialiseImport,
  scanImportSource,
  validateImport,
} from "@/services/storyboard-import";
import { preflightImportedBatch } from "@/services/import-preflight";
import {
  generateSceneImage,
  generateSceneVideo,
  generateSceneVoice,
} from "@/services/generation";
import { deriveSceneVideoFacts } from "@/services/low-auto-facts";
import { lowAutoEligibility } from "@/domain/low-auto";
import { writeBatchReport } from "@/services/batch-report";
import { completeJob, failJob } from "@/jobs/queue";
import { runJob } from "@/jobs/handlers";
import { probeDuration, ffprobe } from "@/media/ffmpeg";
import type { Job } from "@prisma/client";

/**
 * The first real-money run of the import path, kept as small as a real run can
 * be: one scene of one video buys one clip.
 *
 * ## The shape of the test
 *
 * Five scenes are LOCAL_MOTION and one is VIDEO_AI, pinned to the model the
 * operator named. Every keyframe was supplied, so the image stage must buy
 * nothing at all - which makes the bill a single number that can be checked
 * against a single task id.
 *
 * ## Why this is a script and not the batch page
 *
 * Same reason `resume-batch.ts` is: the queue's retry policy cannot honour "one
 * paid POST, no retries, stop the batch if it fails". A worker would have
 * bought the clip twice before anyone read the error. So the scene chain is
 * driven here, step by step, through the same production functions - and
 * `evaluateScene` is left out, because a below-threshold verdict from a MOCK
 * quality model bumps `retryCount`, changes the idempotency key and buys the
 * clip again.
 *
 * ## The gates
 *
 * Everything below `--apply` is free and refuses loudly. The run only starts
 * when every one of the operator's conditions is true at once, and any one of
 * them being false stops the script before a single request leaves.
 *
 *   npx tsx scripts/first-real-import-run.ts --source <dir>            # $0
 *   AI_MOCK_MODE=false npx tsx scripts/first-real-import-run.ts \
 *     --source <dir> --apply --confirm-real-spend
 */

const RUNWAY_BASE = "https://api.dev.runwayml.com/v1";
const CEILING = 0.5;
const PAID_SCENE = 3;
const PAID_MODEL = "runway/h3_max:768x1280";
const TEMP_CONFIRM = { provider: "runway", model: "h3_max:768x1280" } as const;

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const money = (n: number, d = 6) => `$${n.toFixed(d)}`;

let failures = 0;
function must(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "[DAT ]" : "[DUNG]"} ${label.padEnd(44)} ${detail}`);
}
function note(label: string, detail: string): void {
  console.log(`  [    ] ${label.padEnd(44)} ${detail}`);
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

interface Totals {
  spend: number;
  costEntries: number;
  providerJobs: number;
  imageJobs: number;
  videoJobs: number;
  voiceJobs: number;
}

async function totals(projectId?: string): Promise<Totals> {
  const where = projectId ? { projectId } : {};
  return {
    spend: await totalRealSpend(),
    costEntries: await prisma.costEntry.count({ where }),
    providerJobs: await prisma.providerJob.count({ where }),
    imageJobs: await prisma.providerJob.count({ where: { ...where, kind: "image" } }),
    videoJobs: await prisma.providerJob.count({ where: { ...where, kind: "video" } }),
    voiceJobs: await prisma.providerJob.count({ where: { ...where, kind: "audio" } }),
  };
}

async function main(): Promise<void> {
  const source = arg("source");
  const apply = process.argv.includes("--apply");
  const confirmed = process.argv.includes("--confirm-real-spend");

  console.log("=".repeat(96));
  console.log(
    `  NHAP STORYBOARD — CHAY THAT LAN DAU  ${apply ? "[CHAY THAT]" : "[PREFLIGHT - khong chi gi]"}`,
  );
  console.log("=".repeat(96));

  // ------------------------------------------------------- 1. the material
  console.log("\n--- 1. Doc storyboard ---");
  const scan = scanImportSource(path.resolve(source));
  const validated = await validateImport(scan);
  const errors = validated.issues.filter((i) => i.level === "error");
  for (const i of validated.issues) {
    note(
      `${i.level === "error" ? "LOI" : "nhac"} ${i.code}`,
      `${i.sceneNumber !== undefined ? `canh ${i.sceneNumber}: ` : ""}${i.message}`,
    );
  }
  must("Khong loi khi kiem tra", errors.length === 0, `${errors.length} loi`);
  must("Dung 1 video", validated.videos.length === 1, `${validated.videos.length}`);
  if (failures > 0) return finish();

  const video = validated.videos[0]!;
  must("Dung 6 canh", video.scenes.length === 6, `${video.scenes.length}`);
  must(
    "CA 6 canh deu co anh nhap san",
    video.suppliedImages === 6 && video.missingImages === 0,
    `co san ${video.suppliedImages}, thieu ${video.missingImages}`,
  );
  must(
    "Dung 1 canh VIDEO_AI",
    video.videoAiScenes === 1,
    `VIDEO_AI ${video.videoAiScenes}, LOCAL_MOTION ${video.localMotionScenes}, AUTO ${video.autoScenes}`,
  );
  must("Khong canh nao de AUTO", video.autoScenes === 0, `${video.autoScenes}`);

  // ------------------------------------------------------- 2. the cast
  console.log("\n--- 2. Nhan vat ---");
  for (const character of video.characters) {
    const existing = await prisma.character.findUnique({
      where: { name: character.name },
      include: { references: { where: { approved: true } } },
    });
    const scenes = video.scenes
      .filter((s) => s.scene.characterId === character.characterId)
      .map((s) => s.scene.sceneNumber);
    note("character_id", character.characterId);
    note("character_name", character.name);
    note(
      "reference image",
      existing
        ? `${existing.references.length} anh da duyet` +
            (existing.references.find((r) => r.isPrimary)
              ? ` (primary: ${existing.references.find((r) => r.isPrimary)!.filePath})`
              : " (chua co primary)")
        : character.referenceImage ?? "(chua co, se tao moi)",
    );
    note("canh tham chieu", scenes.join(", "));
    must(
      `Nhan vat "${character.name}" dung lai ban ghi co san`,
      existing !== null,
      existing ? `id ${existing.id.slice(0, 8)}` : "CHUA CO — se tao moi",
    );
    must(
      "Moi canh deu tham chieu cung mot nhan vat",
      scenes.length === video.scenes.length,
      `${scenes.length}/${video.scenes.length}`,
    );
  }

  // --------------------------------------------- 3. rows, then the estimate
  console.log("\n--- 3. Tao lo (chi ghi DB) va DU TOAN ---");
  const existingBatchId = arg("batch");
  const batchId =
    existingBatchId ||
    (
      await materialiseImport(validated, {
        batchName: "Nhap storyboard — chay that lan dau",
        maxCostPerVideo: CEILING,
        maxCostForBatch: CEILING,
      })
    ).batchId;
  const pre = await preflightImportedBatch(batchId);
  const preview = pre.videos[0]!;
  const project = await prisma.project.findFirstOrThrow({ where: { batchId } });
  const scenes = await prisma.scene.findMany({
    where: { projectId: project.id },
    orderBy: { sceneNumber: "asc" },
  });

  note("batch", batchId);
  note("project", project.id);
  console.log("\n  canh | mode         | route                        | anh      | uoc tinh");
  for (const line of preview.scenes) {
    const scene = scenes.find((s) => s.sceneNumber === line.sceneNumber)!;
    const onDisk = scene.imagePath ? fs.existsSync(toAbsolute(scene.imagePath)) : false;
    console.log(
      `  ${String(line.sceneNumber).padEnd(4)} | ${line.motionSource.padEnd(12)} | ` +
        `${(line.videoModel ?? "ffmpeg/local-motion").padEnd(28)} | ` +
        `${(onDisk ? "co" : "THIEU").padEnd(8)} | ${money(line.estimatedCost)}`,
    );
  }

  console.log("\n  --- videoPrompt va camera ---");
  for (const scene of scenes) {
    const derived = deriveSceneVideoFacts(scene, {
      qualityMode: project.qualityMode,
      stage: "VIDEO",
    });
    console.log(
      `  canh ${scene.sceneNumber} camera=${derived.cameraIntent.mode} ` +
        `guardrail=${derived.facts.promptGuarded ? "da ap" : "CHUA"} ` +
        `mau thuan=${derived.contradictions.length}`,
    );
    console.log(`        ${derived.videoPrompt.replace(/\s+/g, " ").slice(0, 150)}`);
  }

  console.log("\n  --- chi phi ---");
  note("TEXT", money(preview.breakdown.text));
  note("IMAGE", money(preview.breakdown.image));
  note("VIDEO", money(preview.breakdown.video));
  note("VOICE", money(preview.breakdown.voice));
  note("RENDER", money(0));
  note("TOTAL", money(preview.estimatedCost));

  const cap = await spendStatus();
  const wallets = await providerSpendBreakdown();
  const credits = await runwayCredits();
  note("Han muc tong con lai", money(cap.remaining));
  note("Vi runway", `${credits ?? "?"} credit (LIVE)`);
  for (const w of wallets) {
    note(`  vi ${w.provider}`, w.remainingUsd === null ? "hang tu quan" : `con ${money(w.remainingUsd)}`);
  }

  // ------------------------------------------------------------ 4. the gates
  console.log("\n--- 4. Cong chan (moi dieu kien phai dung cung luc) ---");

  const paid = preview.scenes.find((s) => s.sceneNumber === PAID_SCENE)!;
  must(
    `Canh ${PAID_SCENE} di dung ${PAID_MODEL}`,
    paid.videoModel === PAID_MODEL && paid.motionSource === "AI_VIDEO",
    `${paid.motionSource} ${paid.videoModel ?? "(local)"}`,
  );
  const others = preview.scenes.filter((s) => s.sceneNumber !== PAID_SCENE);
  must(
    "5 canh con lai KHONG goi Video AI",
    others.every((s) => s.motionSource === "LOCAL_MOTION" && s.videoModel === null),
    others.map((s) => `${s.sceneNumber}:${s.motionSource}`).join(" "),
  );
  must("Chi phi IMAGE = $0", preview.breakdown.image === 0, money(preview.breakdown.image));
  must(
    "Moi anh deu co that tren dia",
    scenes.every((s) => s.imageSource === "IMPORTED" && s.imagePath && fs.existsSync(toAbsolute(s.imagePath))),
    `${scenes.filter((s) => s.imageSource === "IMPORTED").length}/6 IMPORTED`,
  );
  must(
    `Du toan <= ${money(CEILING, 2)}`,
    preview.estimatedCost <= CEILING,
    `${money(preview.estimatedCost)} <= ${money(CEILING, 2)}`,
  );
  must(
    "Han muc tong du",
    cap.remaining >= preview.estimatedCost,
    `con ${money(cap.remaining)}`,
  );
  must("Vi runway du 40 credit", (credits ?? 0) >= 40, `${credits ?? "?"} credit`);
  must("CREATE_ATTEMPT_TOKEN = 0", (await peekCreateToken()) === null, "null");
  must("Trang thai lo PLANNED", (await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status === "PLANNED", "PLANNED");

  // The quality preconditions h3_max requires, asked with the keyframe already
  // on disk - and asked about the right thing.
  //
  // `ignoreManualPin` would be wrong here, and the first version of this gate
  // used it and refused a scene that is perfectly fine. Setting the pin aside
  // flips the motion verdict back to LOCAL_MOTION (LOW complexity, NORMAL
  // priority), and the gate then answers `local_motion`: "there is nothing to
  // buy here". True, and beside the point. LOW_AUTO's motion check exists to
  // stop the ROUTER finding things to buy on its own; this clip is bought
  // because a person instructed it.
  //
  // So the facts are derived with the instruction honoured - motionSource
  // AI_VIDEO, which is what the pipeline will act on - and only
  // `manualPinElsewhere` is set aside, which asks the question actually worth
  // asking: leaving aside that a pin points here, does this scene meet every
  // condition h3_max is required to meet? LOW, one character, locked camera,
  // keyframe on disk, prompt guarded, no contradictions, inside all three
  // budgets.
  const paidScene = scenes.find((s) => s.sceneNumber === PAID_SCENE)!;
  const derived = deriveSceneVideoFacts(paidScene, {
    qualityMode: project.qualityMode,
    stage: "VIDEO",
  });
  const model = await prisma.modelRegistry.findUniqueOrThrow({
    where: { provider_modelId: { provider: "runway", modelId: "h3_max:768x1280" } },
  });
  const verdict = lowAutoEligibility({
    ...derived.facts,
    complexity: paidScene.complexity,
    characterCount: derived.characterCount,
    modelLifecycle: model.lifecycle,
    modelReliability: model.reliability,
    modelVerification: model.verification,
    estimatedCost: model.price * paidScene.duration,
    budgetRemaining: cap.remaining,
    providerBudgetRemaining:
      wallets.find((w) => w.provider === "runway")?.remainingUsd ?? null,
    perVideoCapRemaining: CEILING,
    manualPinElsewhere: false,
  });
  must(
    `Canh ${PAID_SCENE} qua cong LOW_AUTO`,
    verdict.eligible,
    verdict.eligible ? "du dieu kien" : verdict.blockers.map((b) => b.code).join(", "),
  );
  must("Camera da khoa", derived.cameraIntent.mode === "LOCKED_CAMERA", derived.cameraIntent.mode);
  must("Prompt khong tu mau thuan", derived.contradictions.length === 0, `${derived.contradictions.length}`);
  must("Keyframe cho canh tra phi co that", derived.hasKeyframe, String(derived.hasKeyframe));
  must("Thoi luong 5 giay", paidScene.duration === 5, `${paidScene.duration}s`);

  if (!apply) {
    console.log(
      `\n  PREFLIGHT xong. ${failures} dieu kien khong dat. Khong goi API tra phi nao.\n` +
        `  Lo ${batchId} dang PLANNED, quyen chi DRAFT.\n` +
        (failures === 0
          ? `  Chay that:\n    AI_MOCK_MODE=false npx tsx scripts/first-real-import-run.ts ` +
            `--source ${source} --batch ${batchId} --apply --confirm-real-spend\n`
          : "  Sua het dieu kien roi chay lai.\n"),
    );
    if (failures > 0) process.exitCode = 1;
    return;
  }

  must("Da xac nhan chi tien that", confirmed, confirmed ? "--confirm-real-spend" : "THIEU CO");
  must("Mock Mode da TAT", !isMockMode(), `AI_MOCK_MODE=${isMockMode()}`);
  if (failures > 0) return finish();

  // -------------------------------------------------------------- 5. run it
  console.log("\n--- 5. Chay that ---");
  const before = await totals();
  const beforeProject = await totals(project.id);
  note("Runway credits TRUOC", String(credits ?? "?"));
  note("So chi that TRUOC", money(before.spend));

  const hadConfirm = (await confirmedProviders()).includes(
    `${TEMP_CONFIRM.provider}/${TEMP_CONFIRM.model}`,
  );
  let stopped = "";
  try {
    if (!hadConfirm) {
      await confirmProvider(TEMP_CONFIRM.provider, TEMP_CONFIRM.model);
      console.log(`  Da BAT xac nhan tam thoi: ${TEMP_CONFIRM.provider}/${TEMP_CONFIRM.model}`);
    }

    await approveAuthorization({
      batchId,
      authorizedMaxSpend: CEILING,
      note: "First real storyboard import acceptance run",
    });
    console.log(`  Quyen chi APPROVED = ${money(CEILING, 2)}`);

    for (const scene of scenes) {
      try {
        await runScene(scene.id, project.id, project.qualityMode);
        console.log(`  [xong] canh ${scene.sceneNumber}`);
      } catch (err) {
        stopped = err instanceof Error ? err.message : String(err);
        console.log(`  [HONG] canh ${scene.sceneNumber}: ${stopped}`);
        console.log("  DUNG CA LO. Khong thu lai, khong doi provider.");
        break;
      }
    }

    if (!stopped) {
      console.log("  --- render ---");
      await render(project.id);
    }
  } finally {
    if (!hadConfirm) {
      await revokeProvider(TEMP_CONFIRM.provider, TEMP_CONFIRM.model);
      console.log(`  Da THU HOI xac nhan: ${TEMP_CONFIRM.provider}/${TEMP_CONFIRM.model}`);
    }
  }

  // ---------------------------------------------------- 6. settle and report
  const stranded = await prisma.costReservation.findMany({
    where: { batchId, status: "RESERVED" },
    select: { idempotencyKey: true, kind: true, provider: true, estimatedCost: true },
  });
  for (const r of stranded) {
    await releaseReservation(r.idempotencyKey, { billed: true });
    console.log(`  Dong giu cho treo ${r.kind}/${r.provider} ${money(r.estimatedCost)}`);
  }

  await report(batchId, project.id, credits, before, beforeProject, stopped);
}

/**
 * One scene, in the order the operator's rules require, with the quality stage
 * deliberately absent. See the header.
 */
async function runScene(
  sceneId: string,
  projectId: string,
  qualityMode: string,
): Promise<void> {
  await generateSceneImage(sceneId);

  const scene = await prisma.scene.findUniqueOrThrow({ where: { id: sceneId } });
  if (scene.motionMode === "VIDEO_AI") {
    const derived = deriveSceneVideoFacts(scene, { qualityMode, stage: "VIDEO" });
    if (!derived.hasKeyframe) {
      throw new Error(`Canh ${scene.sceneNumber}: khong co keyframe that tren dia.`);
    }
    if (`${scene.videoProvider}/${scene.videoModel}` !== PAID_MODEL) {
      throw new Error(
        `Canh ${scene.sceneNumber} doi model: cho ${PAID_MODEL}, thuc te ` +
          `${scene.videoProvider}/${scene.videoModel}.`,
      );
    }
    console.log(`    canh ${scene.sceneNumber}: POST dung 1 lan toi ${PAID_MODEL}`);
  }

  await generateSceneVideo(sceneId);
  await generateSceneVoice(sceneId);
  await prisma.scene.update({
    where: { id: sceneId },
    data: { status: "completed", errorMessage: null },
  });
  void projectId;
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

async function report(
  batchId: string,
  projectId: string,
  creditsBefore: number | null,
  before: Totals,
  beforeProject: Totals,
  stopped: string,
): Promise<void> {
  console.log("\n" + "=".repeat(96));
  console.log("  KET QUA");
  console.log("=".repeat(96));

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { scenes: { orderBy: { sceneNumber: "asc" } } },
  });
  const auth = await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId } });

  console.log(`\n  project            ${projectId}`);
  console.log(`  batch              ${batchId}`);
  console.log(`  trang thai project ${project.status}`);
  console.log(`  quyen chi          ${auth.status} tran ${money(auth.authorizedMaxSpend, 2)}`);

  console.log("\n  --- TUNG CANH ---");
  for (const scene of project.scenes) {
    const jobs = await prisma.providerJob.findMany({
      where: { sceneId: scene.id },
      select: { kind: true, externalId: true, status: true, actualCost: true, attempts: true },
    });
    console.log(
      `  canh ${scene.sceneNumber} ${String(scene.motionMode).padEnd(12)} ` +
        `${scene.motionSource.padEnd(12)} ${scene.status.padEnd(11)} ` +
        `anh=${scene.imageSource} clip=${scene.videoPath ? "co" : "-"}`,
    );
    for (const j of jobs) {
      console.log(
        `        ${j.kind.padEnd(5)} task=${j.externalId ?? "-"} ${j.status} ` +
          `actual=${money(j.actualCost ?? 0)} attempts=${j.attempts}`,
      );
    }
  }

  const rows = await prisma.costEntry.groupBy({
    by: ["category", "provider", "model"],
    where: { projectId, estimated: false },
    _sum: { amount: true },
    _count: { _all: true },
  });
  console.log("\n  --- CHI PHI THAT CUA VIDEO NAY ---");
  let total = 0;
  for (const r of rows) {
    const amount = r._sum.amount ?? 0;
    total += amount;
    console.log(
      `  ${r.category.padEnd(8)} ${r.provider}/${r.model} x${r._count._all}  ${money(amount)}`,
    );
  }
  console.log(`  ${"TONG".padEnd(8)} ${money(total)}   tran ${money(CEILING, 2)}`);
  console.log(`  VUOT TRAN?        ${total > CEILING ? "CO (!!)" : "KHONG"}`);

  const ledger = await reservationLedger(batchId, auth.authorizedMaxSpend);
  console.log(`  giu cho con treo  ${money(ledger.reserved)}`);

  const after = await totals();
  const afterProject = await totals(projectId);
  const creditsAfter = await runwayCredits();
  console.log("\n  --- SO LAN GOI PROVIDER ---");
  console.log(`  image POST        ${afterProject.imageJobs - beforeProject.imageJobs}`);
  console.log(`  video POST        ${afterProject.videoJobs - beforeProject.videoJobs}`);
  console.log(`  voice POST        ${afterProject.voiceJobs - beforeProject.voiceJobs}`);
  console.log(`  credits truoc/sau ${creditsBefore ?? "?"} -> ${creditsAfter ?? "?"}`);
  console.log(
    `  chenh credit      ${creditsBefore !== null && creditsAfter !== null ? creditsBefore - creditsAfter : "?"}`,
  );
  console.log(`  so chi that       ${money(before.spend)} -> ${money(after.spend)}`);

  console.log("\n  --- VIDEO CUOI ---");
  if (project.finalVideoPath) {
    const file = toAbsolute(project.finalVideoPath);
    console.log(`  duong dan         ${file}`);
    if (fs.existsSync(file)) {
      console.log(`  dung luong        ${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB`);
      console.log(`  thoi luong        ${(await probeDuration(file)).toFixed(3)}s`);
      const { stdout } = await ffprobe([
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_frames",
        "-of", "default=noprint_wrappers=1", file,
      ]);
      const { stdout: audio } = await ffprobe([
        "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,channels,sample_rate",
        "-of", "default=noprint_wrappers=1", file,
      ]);
      console.log(`  ${stdout.trim().split("\n").join("\n  ")}`);
      console.log(`  ${audio.trim().split("\n").join("\n  ")}`);
    }
  } else {
    console.log("  CHUA CO MP4.");
  }
  console.log(`  phu de            ${project.subtitlePath ?? "-"}`);

  // ------------------------------------------------- resume, which must be free
  console.log("\n  --- CHAY LAI (phai mien phi) ---");
  const beforeResume = await totals(projectId);
  const spendBeforeResume = await totalRealSpend();
  for (const scene of project.scenes) {
    await generateSceneImage(scene.id);
    await generateSceneVideo(scene.id);
    await generateSceneVoice(scene.id);
  }
  const afterResume = await totals(projectId);
  const spendAfterResume = await totalRealSpend();
  console.log(`  ProviderJob       ${beforeResume.providerJobs} -> ${afterResume.providerJobs}`);
  console.log(`  image job         ${beforeResume.imageJobs} -> ${afterResume.imageJobs}`);
  console.log(`  video job         ${beforeResume.videoJobs} -> ${afterResume.videoJobs}`);
  console.log(`  voice job         ${beforeResume.voiceJobs} -> ${afterResume.voiceJobs}`);
  console.log(`  CostEntry         ${beforeResume.costEntries} -> ${afterResume.costEntries}`);
  console.log(
    `  chenh chi phi     ${money(spendAfterResume - spendBeforeResume)} ` +
      `${Math.abs(spendAfterResume - spendBeforeResume) < 1e-9 ? "(= 0, dung)" : "(!! KHAC 0)"}`,
  );

  const reportPath = await writeBatchReport(batchId);
  console.log(`\n  batch-report.json ${reportPath}`);
  const stillConfirmed = (await confirmedProviders()).includes(
    `${TEMP_CONFIRM.provider}/${TEMP_CONFIRM.model}`,
  );
  console.log(`  xac nhan h3_max   ${stillConfirmed ? "CON BAT (!!)" : "da thu hoi"}`);
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
