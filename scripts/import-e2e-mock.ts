import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The first end-to-end run of Import Storyboard V1 - in mock mode, on a
 * throwaway database and a throwaway data folder.
 *
 * ## Why it builds its own world
 *
 * The point of this run is to prove the WHOLE chain works, which means writing
 * projects, scenes, jobs, cost rows and MP4s. None of that belongs in the
 * operator's real `data/` or in the production ledger - a mock cost written
 * there would sit beside real money and look exactly like it. So the script
 * points `DATA_DIR` and `DATABASE_URL` at a scratch location, and the
 * production totals are untouched by construction rather than by care.
 *
 * It also starts that database from `prisma migrate deploy` rather than
 * `db push`, which is the only way to find out whether the migrations in the
 * repo actually build the schema the code expects.
 *
 * ## What it refuses to do
 *
 * Nothing here can reach a paid provider: `AI_MOCK_MODE=true` short-circuits
 * the spend guard, and no create token is ever granted. The chain it exercises
 * is the production one - the same handlers, the same batch gate, the same
 * reservations, the same renderer.
 *
 *   npx tsx scripts/import-e2e-mock.ts
 */

const ROOT = process.cwd();
const SCRATCH = path.join(ROOT, "data", ".import-e2e");
const DB_FILE = path.join(SCRATCH, "e2e.db");

process.env.DATA_DIR = SCRATCH;
process.env.DATABASE_URL = `file:${DB_FILE.replace(/\\/g, "/")}`;
process.env.AI_MOCK_MODE = "true";
process.env.JOB_WORKER_ENABLED = "false";

const money = (n: number, d = 6) => `$${n.toFixed(d)}`;
let failures = 0;

function must(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "[DAT ]" : "[HONG]"} ${label.padEnd(46)} ${detail}`);
}
function note(label: string, detail: string): void {
  console.log(`  [    ] ${label.padEnd(46)} ${detail}`);
}
function heading(text: string): void {
  console.log(`\n--- ${text} ---`);
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd: ROOT,
    env: { ...process.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
}

async function main(): Promise<void> {
  console.log("=".repeat(96));
  console.log("  IMPORT STORYBOARD V1 — CHAY END-TO-END BANG MOCK  (khong goi API tra phi nao)");
  console.log("=".repeat(96));

  // ------------------------------------------------- 1. a database from migrations
  heading("1. Dung DB sach TU MIGRATION (khong dung db push)");
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  note("DATA_DIR", SCRATCH);
  note("DATABASE_URL", process.env.DATABASE_URL!);

  run("npx", ["prisma", "migrate", "deploy"]);
  must("prisma migrate deploy", fs.existsSync(DB_FILE), path.basename(DB_FILE));

  run("npx", ["tsx", "scripts/seed.ts"]);

  const { prisma } = await import("@/lib/prisma");
  const { isMockMode } = await import("@/lib/env");
  const { peekCreateToken } = await import("@/services/create-token");

  must("AI_MOCK_MODE bat", isMockMode(), String(isMockMode()));
  must("CREATE_ATTEMPT_TOKEN = 0", (await peekCreateToken()) === null, "null");
  const seededModels = await prisma.modelRegistry.count();
  must("Seed xong", seededModels > 0, `${seededModels} model trong registry`);

  // The seed ships a deliberately tiny cap. Raising it HERE is safe and says
  // nothing about production: this database is a scratch file created three
  // lines ago, and every price in it is a mock price.
  const { setSpendCap } = await import("@/services/spend-guard");
  await setSpendCap(50);
  note("Han muc tong cua DB nhap (mock)", "$50.00 — chi ton tai trong DB tam");

  // The whole point of a migration test: the columns the code needs must exist
  // because a migration made them, not because someone pushed a schema once.
  const columns = (await prisma.$queryRawUnsafe(
    `SELECT name FROM pragma_table_info('Scene')`,
  )) as { name: string }[];
  const names = columns.map((c) => c.name);
  must("Cot motionMode co trong DB migrate", names.includes("motionMode"), "Scene.motionMode");
  must("Cot imageSource co trong DB migrate", names.includes("imageSource"), "Scene.imageSource");

  // ------------------------------------------------------------- 2. import
  heading("2. NHAP storyboard 6 canh");
  const { scanImportSource, validateImport, materialiseImport } = await import(
    "@/services/storyboard-import"
  );
  const { preflightImportedBatch } = await import("@/services/import-preflight");

  const source = path.join(ROOT, "examples", "storyboard-import-e2e");
  const scan = scanImportSource(source);
  const validated = await validateImport(scan);
  const errors = validated.issues.filter((i) => i.level === "error");
  must("Khong loi khi kiem tra", errors.length === 0, errors.map((e) => e.code).join(", ") || "0 loi");
  if (failures > 0) return finish(prisma);

  const video = validated.videos[0]!;
  must("Dung 1 video", validated.videos.length === 1, video.videoId);
  must("Dung 6 canh", video.scenes.length === 6, `${video.scenes.length} canh`);
  must("6 anh co san", video.suppliedImages === 6, `${video.suppliedImages}/6`);
  must("2 VIDEO_AI + 4 LOCAL_MOTION", video.videoAiScenes === 2 && video.localMotionScenes === 4,
    `VIDEO_AI ${video.videoAiScenes}, LOCAL_MOTION ${video.localMotionScenes}`);
  must("Co 1 nhan vat xuyen suot", video.characters.length === 1, video.characters[0]?.name ?? "-");

  // videoPrompt is composed at import, from fields the operator wrote.
  const withPrompt = video.scenes.filter((s) => s.scene.videoPrompt.trim().length > 0);
  must("Moi canh deu co videoPrompt", withPrompt.length === 6, `${withPrompt.length}/6`);
  note("videoPrompt canh 1", video.scenes[0]!.scene.videoPrompt.slice(0, 120));

  const created = await materialiseImport(validated, {
    batchName: "E2E mock — Bite the bullet",
    maxCostPerVideo: 5,
    maxCostForBatch: 20,
  });
  const projectId = created.projects[0]!.projectId;
  must("Tao 1 project", created.projects.length === 1, projectId.slice(0, 8));
  must("Chep 6 keyframe + 1 anh nhan vat", created.copiedImages === 7, `${created.copiedImages} anh`);

  const scenes = await prisma.scene.findMany({
    where: { projectId },
    orderBy: { sceneNumber: "asc" },
  });
  must("6 canh IMPORTED", scenes.filter((s) => s.imageSource === "IMPORTED").length === 6, "6/6");
  must(
    "Moi canh co nhan vat trong khung",
    scenes.every((s) => JSON.parse(s.charactersPresentJson).length > 0),
    JSON.parse(scenes[0]!.charactersPresentJson).join(", "),
  );
  const character = await prisma.character.findFirst({
    where: { name: "Mia" },
    include: { references: true },
  });
  must("Nhan vat co anh tham chieu da duyet",
    Boolean(character?.references.some((r) => r.isPrimary && r.approved)),
    `${character?.references.length ?? 0} anh`);

  // -------------------------------------------------------- 3. cost preview
  heading("3. DU TOAN (chua duyet gi)");
  const pre = await preflightImportedBatch(created.batchId);
  const preview = pre.videos[0]!;
  note("co so gia", pre.costBasis);
  note("TEXT/IMAGE/VIDEO/VOICE",
    `${money(preview.breakdown.text)} / ${money(preview.breakdown.image)} / ` +
    `${money(preview.breakdown.video)} / ${money(preview.breakdown.voice)}`);
  note("tong du toan", money(pre.estimatedTotal));
  must("IMAGE du toan = 0 (anh da co san)", preview.breakdown.image === 0, money(preview.breakdown.image));
  must("Lo van PLANNED", (await prisma.batch.findUniqueOrThrow({ where: { id: created.batchId } })).status === "PLANNED", "PLANNED");
  must("Quyen chi van DRAFT",
    (await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId: created.batchId } })).status === "DRAFT",
    "DRAFT");

  // ------------------------------------------------------------- 4. approve
  heading("4. DUYET (gia mock) va CHAY");
  const { approveAuthorization } = await import("@/services/batch-authorization");
  await approveAuthorization({
    batchId: created.batchId,
    authorizedMaxSpend: Math.max(1, pre.suggestedAuthorizedMaxSpend),
    note: "E2E mock run",
  });
  must("Quyen chi APPROVED",
    (await prisma.batchAuthorization.findUniqueOrThrow({ where: { batchId: created.batchId } })).status === "APPROVED",
    "APPROVED");

  const drained = await drain(created.batchId);
  note("job da chay", `${drained.done} xong, ${drained.failed} hong`);

  // --------------------------------------------------------- 5. the artefact
  heading("5. KET QUA");
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  must("Project completed", project.status === "completed", project.status);
  must("Co FINAL MP4", Boolean(project.finalVideoPath), project.finalVideoPath ?? "-");

  const { toAbsolute } = await import("@/lib/paths");
  const { probeDuration, ffprobe } = await import("@/media/ffmpeg");
  if (project.finalVideoPath) {
    const file = toAbsolute(project.finalVideoPath);
    must("MP4 ton tai tren dia", fs.existsSync(file), file);
    if (fs.existsSync(file)) {
      const duration = await probeDuration(file);
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
      note("dung luong", `${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB`);
      note("thoi luong", `${duration.toFixed(3)}s`);
      for (const line of `${stdout.trim()}\n${audio.trim()}`.split("\n")) note("", line.trim());
      must("Thoi luong = tong cac canh (26s)", Math.abs(duration - 26) < 1.5, `${duration.toFixed(3)}s`);
    }
  }
  must("Co file phu de", Boolean(project.subtitlePath), project.subtitlePath ?? "-");

  const finalScenes = await prisma.scene.findMany({
    where: { projectId },
    orderBy: { sceneNumber: "asc" },
  });
  console.log("\n  --- TUNG CANH ---");
  for (const s of finalScenes) {
    console.log(
      `  canh ${s.sceneNumber} ${String(s.motionMode).padEnd(12)} ${s.motionSource.padEnd(12)} ` +
        `${s.status.padEnd(11)} anh=${s.imageSource} clip=${s.videoPath ? "co" : "-"} ` +
        `voice=${s.audioPath ? "co" : "-"}`,
    );
  }
  must("2 canh co clip Video AI", finalScenes.filter((s) => s.videoPath).length === 2,
    `${finalScenes.filter((s) => s.videoPath).length} clip`);
  must("4 canh LOCAL_MOTION khong co clip",
    finalScenes.filter((s) => s.motionSource === "LOCAL_MOTION" && !s.videoPath).length === 4, "4");

  // ----------------------------------------------------- 6. resume is free
  heading("6. CHAY LAI SAU KHI XONG — chi phi phai = 0");
  const jobsBefore = await prisma.providerJob.count();
  const spentBefore = await totalSpend(prisma);
  const imagesBefore = await prisma.providerJob.count({ where: { kind: "image" } });

  const { generateSceneImage, generateSceneVideo, generateSceneVoice } = await import(
    "@/services/generation"
  );
  for (const scene of finalScenes) {
    await generateSceneImage(scene.id);
    await generateSceneVideo(scene.id);
    await generateSceneVoice(scene.id);
  }

  const jobsAfter = await prisma.providerJob.count();
  const spentAfter = await totalSpend(prisma);
  must("Khong ProviderJob nao moi", jobsAfter === jobsBefore, `${jobsBefore} -> ${jobsAfter}`);
  must("Khong job anh nao moi",
    (await prisma.providerJob.count({ where: { kind: "image" } })) === imagesBefore,
    `${imagesBefore}`);
  must("Chenh lech chi phi = 0", Math.abs(spentAfter - spentBefore) < 1e-9,
    `${money(spentBefore)} -> ${money(spentAfter)}`);

  // Rendering again must not regenerate anything upstream either.
  const { renderProject } = await import("@/media/render");
  void renderProject;
  const beforeRerender = await prisma.providerJob.count();
  await rerender(prisma, projectId);
  must("Render lai khong dong toi media phia truoc",
    (await prisma.providerJob.count()) === beforeRerender, `${beforeRerender}`);

  // ------------------------------------------------------------- 7. report
  heading("7. BAO CAO LO");
  const { writeBatchReport, buildBatchReport } = await import("@/services/batch-report");
  const reportPath = await writeBatchReport(created.batchId);
  const report = await buildBatchReport(created.batchId);
  note("batch-report.json", reportPath);
  note("video / canh", `${report.totals.videos} / ${report.totals.scenes}`);
  note("du toan / thuc te", `${money(report.totals.estimatedCost)} / ${money(report.totals.actualCost)}`);
  must("Khong con giu cho treo", report.reservations.reserved === 0, money(report.reservations.reserved));

  // ---------------------------------------------- 8. one video fails, others do not
  heading("8. LO 3 VIDEO — video #2 hong, hai video kia van xong");
  await failureBatch(prisma);

  finish(prisma);
}

async function totalSpend(prisma: typeof import("@/lib/prisma").prisma): Promise<number> {
  const rows = await prisma.costEntry.aggregate({ _sum: { amount: true } });
  return rows._sum.amount ?? 0;
}

/** Drive the real queue to completion, one job at a time. */
async function drain(batchId: string): Promise<{ done: number; failed: number }> {
  const { prisma } = await import("@/lib/prisma");
  const { runJob } = await import("@/jobs/handlers");
  const { claimNext, completeJob, failJob } = await import("@/jobs/queue");

  await prisma.job.create({
    data: { type: "batch_expand", batchId, status: "queued", maxAttempts: 1 },
  });

  let done = 0;
  let failed = 0;
  for (let i = 0; i < 400; i += 1) {
    await prisma.job.updateMany({
      where: { status: "queued", nextRunAt: { gt: new Date() } },
      data: { nextRunAt: new Date() },
    });
    const job = await claimNext();
    if (!job) break;
    try {
      const outcome = await runJob(job);
      if (!outcome.deferred) {
        await completeJob(job.id, outcome.result);
        done += 1;
      }
    } catch (err) {
      await failJob(job.id, err);
      failed += 1;
    }
  }
  return { done, failed };
}

async function rerender(
  prisma: typeof import("@/lib/prisma").prisma,
  projectId: string,
): Promise<void> {
  const { runJob } = await import("@/jobs/handlers");
  const { completeJob } = await import("@/jobs/queue");
  const row = await prisma.job.findFirst({
    where: { projectId, type: "render_final" },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return;
  await prisma.job.update({
    where: { id: row.id },
    data: { status: "processing", attempts: 1, maxAttempts: 1, payloadJson: "{}" },
  });
  const fresh = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
  const outcome = await runJob(fresh);
  if (!outcome.deferred) await completeJob(row.id, outcome.result);
}

/**
 * Three videos, one of which cannot finish.
 *
 * The failure is deliberate and it is a REAL one rather than a simulated
 * provider error: video #2 declares a supplied keyframe, and the file is
 * deleted before the run. That is the exact case the import guard exists for,
 * and it proves the guard stops one video without touching the other two.
 */
async function failureBatch(prisma: typeof import("@/lib/prisma").prisma): Promise<void> {
  const fsx = await import("node:fs");
  const { scanImportSource, validateImport, materialiseImport } = await import(
    "@/services/storyboard-import"
  );
  const { preflightImportedBatch } = await import("@/services/import-preflight");
  const { approveAuthorization } = await import("@/services/batch-authorization");
  const { toAbsolute } = await import("@/lib/paths");

  const root = path.join(SCRATCH, "failure-source");
  fsx.rmSync(root, { recursive: true, force: true });
  const png = fsx.readFileSync(
    path.join(ROOT, "examples", "storyboard-import-e2e", "cold-open", "images", "scene-01.png"),
  );
  for (const id of ["fail-a", "fail-b", "fail-c"]) {
    const dir = path.join(root, id);
    fsx.mkdirSync(dir, { recursive: true });
    fsx.writeFileSync(path.join(dir, "k.png"), png);
    fsx.writeFileSync(
      path.join(dir, "storyboard.json"),
      JSON.stringify({
        video_id: id,
        video_title: id,
        scenes: [1, 2].map((n) => ({
          scene_number: n,
          duration: 4,
          visual_description: `${id} scene ${n} on a plain background.`,
          character_action: "The character nods once.",
          camera: "Locked static medium shot, no camera movement.",
          dialogue: `Narrator: "Line ${n} of ${id}."`,
          subtitle: `Line ${n} of ${id}.`,
          image_file: "k.png",
          motion_mode: "LOCAL_MOTION",
          priority: "LOW",
        })),
      }),
    );
  }

  const created = await materialiseImport(await validateImport(scanImportSource(root)), {
    batchName: "E2E mock — failure batch",
    maxCostPerVideo: 5,
    maxCostForBatch: 20,
  });
  const pre = await preflightImportedBatch(created.batchId);
  await approveAuthorization({
    batchId: created.batchId,
    authorizedMaxSpend: Math.max(1, pre.suggestedAuthorizedMaxSpend),
    note: "E2E mock failure batch",
  });

  // Break exactly one scene of exactly one video.
  const victimProject = created.projects.find((p) => p.videoId === "fail-b")!;
  const victimScene = await prisma.scene.findFirstOrThrow({
    where: { projectId: victimProject.projectId, sceneNumber: 2 },
  });
  const victimFile = toAbsolute(victimScene.imagePath!);
  const rescued = fsx.readFileSync(victimFile);
  fsx.rmSync(victimFile);
  note("pha hong", `video fail-b, canh 2 — xoa keyframe ${path.basename(victimFile)}`);

  const drained = await drain(created.batchId);
  note("job", `${drained.done} xong, ${drained.failed} hong`);

  const after = await prisma.project.findMany({
    where: { batchId: created.batchId },
    orderBy: { createdAt: "asc" },
  });
  for (const p of after) {
    console.log(`  ${p.title.padEnd(10)} ${p.status.padEnd(16)} ${p.finalVideoPath ? "co MP4" : "khong MP4"}`);
  }
  const byTitle = new Map(after.map((p) => [p.title, p]));
  must("fail-a xong", byTitle.get("fail-a")?.status === "completed", byTitle.get("fail-a")?.status ?? "-");
  must("fail-c xong", byTitle.get("fail-c")?.status === "completed", byTitle.get("fail-c")?.status ?? "-");
  must("fail-b KHONG xong", byTitle.get("fail-b")?.status !== "completed", byTitle.get("fail-b")?.status ?? "-");

  // ---- fix it, retry only that scene
  fsx.writeFileSync(victimFile, rescued);
  const { retryScene } = await import("@/services/batch-runner");
  const jobsBefore = await prisma.providerJob.count();
  const okScenesBefore = await prisma.scene.findMany({
    where: { projectId: { in: [byTitle.get("fail-a")!.id, byTitle.get("fail-c")!.id] } },
    select: { id: true, updatedAt: true },
  });

  await retryScene(victimScene.id);
  await drain(created.batchId);

  const victimAfter = await prisma.scene.findUniqueOrThrow({ where: { id: victimScene.id } });
  const projectAfter = await prisma.project.findUniqueOrThrow({
    where: { id: victimProject.projectId },
  });
  must("Canh hong da chay lai xong", victimAfter.status === "completed", victimAfter.status);
  must("Video #2 gio da xong", projectAfter.status === "completed", projectAfter.status);

  const okScenesAfter = await prisma.scene.findMany({
    where: { id: { in: okScenesBefore.map((s) => s.id) } },
    select: { id: true, updatedAt: true },
  });
  const untouched = okScenesAfter.every(
    (s) => s.updatedAt.getTime() === okScenesBefore.find((b) => b.id === s.id)!.updatedAt.getTime(),
  );
  must("Retry KHONG dong toi canh cua video khac", untouched, `${okScenesBefore.length} canh nguyen ven`);
  note("ProviderJob truoc/sau retry", `${jobsBefore} -> ${await prisma.providerJob.count()}`);
}

function finish(prisma: typeof import("@/lib/prisma").prisma): void {
  console.log("\n" + "=".repeat(96));
  console.log(
    failures === 0
      ? "  TAT CA DIEU KIEN DAT. Chi phi API that: $0.00 (toan bo chay bang mock, DB rieng)."
      : `  ${failures} DIEU KIEN KHONG DAT.`,
  );
  console.log("=".repeat(96) + "\n");
  if (failures > 0) process.exitCode = 1;
  void prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
