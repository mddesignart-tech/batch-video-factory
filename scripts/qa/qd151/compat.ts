import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * QĐ-151 compatibility check: EVERY production camera move (and the speaker
 * lean) rendered both by production zoompan and by V2 from the SAME production
 * expressions; measured with motion_probe.py. 540x960, 4 s, local, $0.
 *
 *   npx tsx scripts/qa/qd151/compat.ts
 * Output: data/benchmarks/qd151/compat/ (+ compat.json)
 */

async function main(): Promise<void> {
  const { cameraZoompan, renderableMove } = await import("../../../src/media/camera-motion");
  const { CAMERA_MOVES, localSupport } = await import("../../../src/domain/camera-grammar");
  const { ffmpeg } = await import("../../../src/media/ffmpeg");
  const v2 = await import("./motion-v2");
  const OUT = path.resolve("data", "benchmarks", "qd151", "compat");
  fs.mkdirSync(OUT, { recursive: true });
  const FF = path.resolve("node_modules/ffmpeg-static/ffmpeg.exe");
  const FP = path.resolve("node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe");
  const img = path.resolve("data/projects/adeec8a7-c0ec-4ac1-880a-35de2e0c4721/images/5c17ce92-55fa-49cd-97a1-0cdbf727ffdc.png");
  const target = { width: 540, height: 960, fps: 30 };
  const DUR = 4;
  const cases = [
    ...CAMERA_MOVES.map((move) => ({ name: move, spec: { move, speed: "SLOW" as const, easing: "EASE_IN_OUT" as const } })),
    { name: "SPEAKER_LEAN", spec: { move: "SLOW_ZOOM_IN" as const, speed: "SLOW" as const, speakerBias: [{ atSec: 0, side: -1 as const }, { atSec: 1.5, side: 1 as const }] } },
  ];
  const rows: Record<string, unknown>[] = [];
  const probe = (file: string) => JSON.parse(execFileSync("python", ["-I", path.resolve("scripts/qa/qd151/motion_probe.py"), FF, FP, file, path.basename(file)]).toString());
  for (const c of cases) {
    const chain = cameraZoompan(c.spec as never, { durationSec: DUR, target });
    const row: Record<string, unknown> = { move: c.name, rendersAs: renderableMove(c.spec.move), support: c.name === "SPEAKER_LEAN" ? "EXACT" : localSupport(c.spec.move) };
    if (!chain) {
      rows.push({ ...row, v2: "không có camera (STATIC) — giữ nguyên" });
      continue;
    }
    const path2 = v2.fromProductionZoompan(chain);
    if (!path2) {
      rows.push({ ...row, v2: "FALLBACK: không đọc được biểu thức" });
      continue;
    }
    const a = path.join(OUT, `${c.name}__A.mp4`);
    const b = path.join(OUT, `${c.name}__V2.mp4`);
    const t0 = performance.now();
    await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-i", img, "-vf", `scale=540:960:force_original_aspect_ratio=increase,crop=540:960${chain},fps=30,setsar=1,format=yuv420p`, "-frames:v", String(DUR * 30), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", a]);
    const t1 = performance.now();
    try {
      await ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", "30", "-t", String(DUR), "-i", img, "-vf", v2.v2FilterRaw({ path: path2, ...target }), "-frames:v", String(DUR * 30), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", b]);
    } catch (err) {
      rows.push({ ...row, v2: `FALLBACK: FFmpeg lỗi (${String(err).slice(0, 120)})` });
      continue;
    }
    const t2 = performance.now();
    const pa = probe(a);
    const pb = probe(b);
    rows.push({
      ...row,
      v2: "OK",
      jitterA: pa.jitter_px.rel_rms_pct,
      jitterV2: pb.jitter_px.rel_rms_pct,
      stillA: pa.duplicate_frames,
      stillV2: pb.duplicate_frames,
      speedA: pa.edge_speed_px_per_frame.mean,
      speedV2: pb.edge_speed_px_per_frame.mean,
      secA: Math.round(t1 - t0) / 1000,
      secV2: Math.round(t2 - t1) / 1000,
    });
    console.log(`${c.name}: A ${pa.jitter_px.rel_rms_pct}% / V2 ${pb.jitter_px.rel_rms_pct}%`);
  }
  fs.writeFileSync(path.join(OUT, "..", "compat.json"), JSON.stringify(rows, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
