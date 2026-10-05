import fs from "node:fs";
import path from "node:path";
import { AMBIENT_DIR } from "@/services/ambient-library";
import { buildAlphaAmbientLoopArgs, buildAmbientLoopArgs, GENERATED_ALPHA_KINDS, GENERATED_AMBIENT_KINDS } from "@/media/ambient-generate";
import { ffmpeg } from "@/media/ffmpeg";

/**
 * `npm run ambient:generate [-- --force]` - writes procedural ambient loops to
 * data/ambient/: light-on-black <kind>.mp4 (screen-blended) and transparent
 * <kind>.webm (drawn over the background). Local FFmpeg only, $0, no provider.
 * An existing file (e.g. a real stock loop you added) is kept unless --force.
 */
async function main() {
  const force = process.argv.includes("--force");
  fs.mkdirSync(AMBIENT_DIR, { recursive: true });
  const jobs = [
    ...GENERATED_AMBIENT_KINDS.map((kind) => ({ kind, out: path.join(AMBIENT_DIR, `${kind}.mp4`), args: (o: string) => buildAmbientLoopArgs(kind, o) })),
    // Transparent loops (drawn over the background): cars, passers-by, birds, leaves.
    ...GENERATED_ALPHA_KINDS.map((kind) => ({ kind, out: path.join(AMBIENT_DIR, `${kind}.webm`), args: (o: string) => buildAlphaAmbientLoopArgs(kind, o) })),
  ];
  for (const { kind, out, args } of jobs) {
    if (fs.existsSync(out) && !force) {
      console.log(`  bỏ qua ${kind} (đã có file — thêm --force để tạo lại)`);
      continue;
    }
    const started = Date.now();
    await ffmpeg(args(out), { timeoutMs: 10 * 60 * 1000 });
    console.log(`  ${kind.padEnd(8)} ${(fs.statSync(out).size / 1024).toFixed(0)} KB · ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
  console.log(`Xong: ${AMBIENT_DIR} · $0 (FFmpeg tại máy).`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
