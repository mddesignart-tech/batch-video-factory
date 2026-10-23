import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * QĐ-151 LOCAL_MOTION benchmark - renders the SAME stills and the SAME camera
 * paths with:
 *   A0  production V1 chain (scene without a camera plan)
 *   A   production camera (QĐ-128/130 zoompan, exactly the app's argument builder)
 *   B1  V2 renderer (sub-pixel perspective, 2x supersample), production's path + curve
 *   B2  full V2: same distance, SMOOTHERSTEP curve (V2 default)
 *   B1x1 the B1 renderer without supersampling (speed close to production)
 * plus a V2 move catalogue and the four intensities, then measures every clip
 * with motion_probe.py and writes side-by-side videos + metrics.
 * Local FFmpeg only, $0. No production file is changed.
 *
 *   npx tsx scripts/qa/qd151/bench.ts [--only-probe]
 * Output: data/benchmarks/qd151/
 */

const OUT = path.resolve("data", "benchmarks", "qd151");
const DUR = 7;
const TARGET = { width: 1080, height: 1920, fps: 30 };
const IMAGES = {
  S1_hall: "projects/12d7a81e-3e8e-415f-b9ab-b1d2a4c66a23/images/bfcc8424-ac35-4890-809f-42009d2e75e8.png",
  S2_park: "projects/adeec8a7-c0ec-4ac1-880a-35de2e0c4721/images/5c17ce92-55fa-49cd-97a1-0cdbf727ffdc.png",
  S3_product: "projects/236b0f85-d007-4e3e-a030-194126037c91/images/d1090d7d-8386-4055-b771-370bf014d2d9.png",
} as const;
const COMPARE = [
  { v2: "ZOOM_IN", prod: "SLOW_ZOOM_IN" },
  { v2: "PAN_RIGHT", prod: "PAN_RIGHT" },
  { v2: "TILT_UP", prod: "TILT_UP" },
  { v2: "DOLLY_IN", prod: "DOLLY_IN" },
] as const;

type Clip = { id: string; image: string; variant: string; move: string; file: string; renderSec?: number; bytes?: number };

async function main(): Promise<void> {
  const { buildSceneNormalizeArgs } = await import("../../../src/media/render");
  const { ffmpeg } = await import("../../../src/media/ffmpeg");
  const { toAbsolute } = await import("../../../src/lib/paths");
  const v2 = await import("./motion-v2");
  const FF = path.resolve("node_modules/ffmpeg-static/ffmpeg.exe");
  const FP = path.resolve("node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe");
  const onlyProbe = process.argv.includes("--only-probe");
  fs.mkdirSync(path.join(OUT, "clips"), { recursive: true });
  fs.mkdirSync(path.join(OUT, "metrics"), { recursive: true });
  fs.mkdirSync(path.join(OUT, "compare"), { recursive: true });

  const clips: Clip[] = [];
  const add = (image: keyof typeof IMAGES, variant: string, move: string) => {
    const id = `${image}__${move}__${variant}`;
    const c: Clip = { id, image, variant, move, file: path.join(OUT, "clips", `${id}.mp4`) };
    clips.push(c);
    return c;
  };
  // Render times of clips kept from an earlier run (--only-probe re-renders only missing clips).
  const previous = fs.existsSync(path.join(OUT, "results.json"))
    ? new Map((JSON.parse(fs.readFileSync(path.join(OUT, "results.json"), "utf8")).clips as Clip[]).map((c) => [c.id, c.renderSec]))
    : new Map<string, number | undefined>();
  const timed = async (c: Clip, args: string[]) => {
    if (onlyProbe && fs.existsSync(c.file)) {
      c.renderSec = previous.get(c.id);
      return;
    }
    const t = performance.now();
    await ffmpeg(args, { timeoutMs: 20 * 60 * 1000 });
    c.renderSec = Math.round((performance.now() - t) / 100) / 10;
    console.log(`${c.id}: ${c.renderSec}s`);
  };

  for (const [key, rel] of Object.entries(IMAGES) as [keyof typeof IMAGES, string][]) {
    const image = toAbsolute(rel);
    // A0: a scene with no camera plan (V1 chain).
    const a0 = add(key, "A0_v1chain", "V1_PUSH");
    await timed(a0, buildSceneNormalizeArgs({ videoInput: image, audioInput: null, duration: DUR, target: TARGET, output: a0.file }));
    for (const m of COMPARE) {
      const a = add(key, "A_prod", m.v2);
      await timed(a, buildSceneNormalizeArgs({ videoInput: image, audioInput: null, duration: DUR, target: TARGET, output: a.file, camera: { move: m.prod, speed: "SLOW", easing: "EASE_IN_OUT" } }));
      const b1 = add(key, "B1_v2render", m.v2);
      await timed(b1, v2.v2Args({ image, output: b1.file, durationSec: DUR, ...TARGET, path: v2.productionPath(m.v2), easing: "PROD_EASE_IN_OUT", endSpeed: 0.4 }));
      const b2 = add(key, "B2_v2full", m.v2);
      await timed(b2, v2.v2Args({ image, output: b2.file, durationSec: DUR, ...TARGET, path: v2.v2Path(m.v2, "NORMAL"), easing: "SMOOTHERSTEP", endSpeed: v2.V2_INTENSITY.NORMAL.endSpeed }));
    }
  }
  // V2 renderer WITHOUT supersampling (speed close to production): same path as B1.
  for (const [key, rel] of Object.entries(IMAGES) as [keyof typeof IMAGES, string][]) {
    for (const m of COMPARE) {
      const c = add(key, "B1x1_v2render_1x", m.v2);
      await timed(c, v2.v2Args({ image: toAbsolute(rel), output: c.file, durationSec: DUR, ...TARGET, path: v2.productionPath(m.v2), easing: "PROD_EASE_IN_OUT", endSpeed: 0.4, supersample: 1 }));
    }
  }
  // Measurement noise floor: a picture that does not move at all.
  const still = add("S2_park", "CTRL_static", "STATIC");
  await timed(still, ["-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", "30", "-t", String(DUR), "-i", toAbsolute(IMAGES.S2_park), "-vf", "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", still.file]);
  // V2 catalogue: the ten paths of the brief on one picture.
  for (const move of ["PAN_LEFT", "PAN_RIGHT", "ZOOM_IN", "ZOOM_OUT", "DOLLY_IN", "DOLLY_OUT", "TILT_UP", "TILT_DOWN", "DIAGONAL", "SUBTLE_CINEMATIC"] as const) {
    const c = add("S2_park", "V2_catalogue", move);
    await timed(c, v2.v2Args({ image: toAbsolute(IMAGES.S2_park), output: c.file, durationSec: DUR, ...TARGET, path: v2.v2Path(move, "NORMAL"), easing: "SMOOTHERSTEP", endSpeed: 0.3 }));
  }
  // The four intensities on one move.
  for (const level of ["SUBTLE", "NORMAL", "DYNAMIC", "CINEMATIC"] as const) {
    const c = add("S1_hall", `V2_intensity_${level}`, "DOLLY_IN");
    await timed(c, v2.v2Args({ image: toAbsolute(IMAGES.S1_hall), output: c.file, durationSec: DUR, ...TARGET, path: v2.v2Path("DOLLY_IN", level), easing: "SMOOTHERSTEP", endSpeed: v2.V2_INTENSITY[level].endSpeed }));
  }

  // Measure every clip.
  const metrics: Record<string, unknown>[] = [];
  for (const c of clips) {
    c.bytes = fs.statSync(c.file).size;
    const json = path.join(OUT, "metrics", `${c.id}.json`);
    execFileSync("python", ["-I", path.resolve("scripts/qa/qd151/motion_probe.py"), FF, FP, c.file, c.id, json], { stdio: "ignore" });
    const m = JSON.parse(fs.readFileSync(json, "utf8"));
    delete m.edge_speed_series;
    metrics.push({ ...c, file: path.relative(OUT, c.file).replace(/\\/g, "/"), probe: m });
  }

  // Side by side for review: A | V2 1x | V2 2x | V2 easing, labelled with render time and fps,
  // plus a 2x magnified DETAIL strip (product text / picture edge) of the same four.
  const font = "C\:/Windows/Fonts/arial.ttf";
  const label = (t: string, size = 26) => `drawtext=fontfile='${font}':text='${t}':x=10:y=10:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=6`;
  const VARIANTS = [
    { v: "A_prod", name: "A LEGACY (production)" },
    { v: "B1x1_v2render_1x", name: "V2 1x" },
    { v: "B1_v2render", name: "V2 2x" },
    { v: "B2_v2full", name: "V2 EASING (2x)" },
  ];
  // Where to look closely, per picture (x, y, size on the 1080x1920 frame).
  const DETAIL: Record<string, { x: number; y: number; s: number; what: string }> = {
    S1_hall: { x: 0, y: 0, s: 400, what: "mep tren-trai (den tran)" },
    S2_park: { x: 680, y: 260, s: 400, what: "mep phai (than cay, la)" },
    S3_product: { x: 640, y: 560, s: 400, what: "chu tren san pham" },
  };
  const secOf = (id: string) => clips.find((c) => c.id === id)?.renderSec;
  for (const key of Object.keys(IMAGES)) {
    for (const m of COMPARE) {
      const f = (v: string) => path.join(OUT, "clips", `${key}__${m.v2}__${v}.mp4`);
      const out = path.join(OUT, "compare", `${key}__${m.v2}__4up.mp4`);
      const det = path.join(OUT, "compare", `${key}__${m.v2}__detail.mp4`);
      if (onlyProbe && fs.existsSync(out) && fs.existsSync(det)) continue;
      const names = VARIANTS.map(({ v, name }) => {
        const sec = secOf(`${key}__${m.v2}__${v}`);
        return `${name} · ${sec ?? "?"}s · 30fps`.replace(/:/g, "\:");
      });
      const inputs = VARIANTS.flatMap(({ v }) => ["-i", f(v)]);
      await ffmpeg([
        "-y", "-hide_banner", "-loglevel", "error", ...inputs,
        "-filter_complex",
        VARIANTS.map((_, i) => `[${i}]scale=540:960,${label(names[i]!)}[v${i}]`).join(";") + `;${VARIANTS.map((_, i) => `[v${i}]`).join("")}hstack=4`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-r", "30", out,
      ]);
      const d = DETAIL[key]!;
      await ffmpeg([
        "-y", "-hide_banner", "-loglevel", "error", ...inputs,
        "-filter_complex",
        VARIANTS.map((_, i) => `[${i}]crop=${d.s}:${d.s}:${d.x}:${d.y},scale=540:540:flags=neighbor,${label(VARIANTS[i]!.name, 22)}[d${i}]`).join(";") + `;${VARIANTS.map((_, i) => `[d${i}]`).join("")}hstack=4`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-r", "30", det,
      ]);
    }
  }
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), target: TARGET, durationSec: DUR, clips: metrics }, null, 2));
  console.log(`Xong: ${clips.length} clip → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
