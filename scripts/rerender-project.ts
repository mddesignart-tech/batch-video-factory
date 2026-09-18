import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { toAbsolute } from "@/lib/paths";
import { runJob } from "@/jobs/handlers";
import { completeJob } from "@/jobs/queue";
import type { Job } from "@prisma/client";
import fs from "node:fs";
import { probeDuration, ffprobe } from "@/media/ffmpeg";

/**
 * Re-render a project's final MP4 from media that already exists.
 *
 * FFmpeg only. Nothing here can reach a provider: `handleRenderFinal` cuts
 * picture, builds the dialogue timeline, mixes, writes subtitles and muxes -
 * every input is a file on this disk that was paid for once already.
 *
 * It re-attaches the project's EXISTING `render_final` job row rather than
 * enqueueing a new one, for the same reason `resume-batch.ts` does: the job is
 * the record of a piece of work, and a second row for the same work makes the
 * queue lie about what happened.
 *
 * Use it after changing something that only affects assembly - scene pacing,
 * a pause, a subtitle - where re-generating media would be paying again for
 * footage that is already correct.
 *
 *   npx tsx scripts/rerender-project.ts --project <id>
 */

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<void> {
  const projectId = arg("project");

  console.log("=".repeat(88));
  console.log("  RENDER LAI (chi FFmpeg tai may, khong goi provider nao)");
  console.log("=".repeat(88));

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      scenes: { where: { skipped: false }, orderBy: { sceneNumber: "asc" } },
    },
  });
  console.log(`\n  project     ${project.id}`);
  console.log(`  trang thai  ${project.status}`);
  console.log(`  mock mode   ${isMockMode()} (khong lien quan: render khong hoi provider)`);
  console.log(`  MP4 cu      ${project.finalVideoPath ?? "(chua co)"}`);

  const missing = project.scenes.filter((s) => !s.videoPath && !s.imagePath);
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} canh chua co media (${missing.map((s) => s.sceneNumber).join(", ")}). ` +
        `Render lai se bo mat canh - dung lai thay vi xuat mot video thieu canh.`,
    );
  }

  let job = await prisma.job.findFirst({
    where: { projectId, type: "render_final" },
    orderBy: { createdAt: "desc" },
  });
  if (!job) throw new Error("Khong tim thay job render_final cua project nay.");

  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: "processing",
      attempts: 1,
      maxAttempts: 1,
      error: null,
      startedAt: new Date(),
      finishedAt: null,
      // The deferral counter from the previous run would otherwise start this
      // one part-way through its patience.
      payloadJson: "{}",
    },
  });
  job = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });

  console.log(`\n  bam lai job render_final ${job.id.slice(0, 8)}`);
  const outcome = await runJob(job as Job);
  if (outcome.deferred) {
    throw new Error("render_final tu hoan lai - van con canh chua co media.");
  }
  await completeJob(job.id, outcome.result);

  const after = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const file = after.finalVideoPath ? toAbsolute(after.finalVideoPath) : null;
  console.log(`\n  MP4 moi     ${after.finalVideoPath ?? "(khong co)"}`);
  if (file && fs.existsSync(file)) {
    console.log(`  dung luong  ${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  thoi luong  ${(await probeDuration(file)).toFixed(3)}s`);
    const { stdout } = await ffprobe([
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_frames",
      "-of", "default=noprint_wrappers=1",
      file,
    ]);
    console.log(`  ${stdout.trim().split("\n").join("\n  ")}`);
    const { stdout: audio } = await ffprobe([
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_name,channels,sample_rate",
      "-of", "default=noprint_wrappers=1",
      file,
    ]);
    console.log(`  ${audio.trim().split("\n").join("\n  ")}`);
  }
  console.log(`  phu de      ${after.subtitlePath ?? "-"}`);
  console.log("\n  Chi phi API buoc nay: $0.00\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
