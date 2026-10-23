import fs from "node:fs";
import path from "node:path";

/**
 * QĐ-151: render-time of the camera stage for the SAME scenes of a real
 * project, one after another (no segment cache, nothing else running):
 * LEGACY vs SMOOTH_V2 vs HQ_V2. Only the per-scene segment differs between
 * the qualities (audio mix, subtitles, join are identical), so this is the
 * fair comparison. The clips (no subtitles) are then measured with motion_probe.py.
 * Local FFmpeg, $0; writes only to data/benchmarks/qd151/uat-timing/<projectId>.
 *
 *   npx tsx scripts/qa/qd151/uat-timing.ts <projectId>
 */

async function main(): Promise<void> {
  const projectId = process.argv[2];
  if (!projectId) throw new Error("Cần projectId.");
  const { prisma } = await import("../../../src/lib/prisma");
  const { toAbsolute } = await import("../../../src/lib/paths");
  const { renderInputsFor } = await import("../../../src/services/scene-plan-service");
  const { buildSceneNormalizeArgs, stillOnMatte } = await import("../../../src/media/render");
  const { pngHasAlpha } = await import("../../../src/media/cutout");
  const { ffmpeg } = await import("../../../src/media/ffmpeg");

  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { scenes: { orderBy: { sceneNumber: "asc" } } } });
  const profile = project.outputProfileJson ? (JSON.parse(project.outputProfileJson) as { width?: number; height?: number; fps?: number }) : {};
  const target = { width: profile.width ?? 1080, height: profile.height ?? 1920, fps: profile.fps ?? 30 };
  const out = path.resolve("data", "benchmarks", "qd151", "uat-timing", projectId);
  fs.mkdirSync(out, { recursive: true });
  const totals: Record<string, number> = { LEGACY: 0, SMOOTH_V2: 0, HQ_V2: 0 };
  const rows: string[] = [];
  for (const s of project.scenes) {
    if (!s.imagePath) continue;
    const plan = renderInputsFor(s);
    if (!plan.localCamera) continue;
    const img = toAbsolute(s.imagePath);
    const source = pngHasAlpha(img) ? await stillOnMatte(img) : img;
    const duration = s.finalDuration ?? s.duration;
    const times: string[] = [];
    for (const q of ["LEGACY", "SMOOTH_V2", "HQ_V2"] as const) {
      const file = path.join(out, `s${s.sceneNumber}-${q}.mp4`);
      const t = performance.now();
      await ffmpeg(buildSceneNormalizeArgs({ videoInput: source, audioInput: null, duration, target, output: file, camera: plan.localCamera, ...(q === "LEGACY" ? {} : { motionQuality: q }) }));
      const sec = (performance.now() - t) / 1000;
      totals[q]! += sec;
      times.push(`${q} ${sec.toFixed(1)}s`);
    }
    rows.push(`cảnh ${s.sceneNumber} (${plan.localCamera.move}, ${duration.toFixed(2)}s): ${times.join(" · ")}`);
  }
  console.log(rows.join("\n"));
  console.log(`TỔNG ${target.width}x${target.height}: ` + Object.entries(totals).map(([k, v]) => `${k} ${v.toFixed(1)}s`).join(" · "));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
