import fs from "node:fs";
import path from "node:path";
import { AMBIENT_DIR } from "@/services/ambient-library";
import { buildAmbientLoopArgs, GENERATED_AMBIENT_KINDS } from "@/media/ambient-generate";
import { ffmpeg } from "@/media/ffmpeg";

/**
 * `npm run ambient:generate [-- --force]` - writes procedural ambient loops to
 * data/ambient/<kind>.mp4. Local FFmpeg only, $0, no provider.
 * An existing file (e.g. a real stock loop you added) is kept unless --force.
 */
async function main() {
  const force = process.argv.includes("--force");
  fs.mkdirSync(AMBIENT_DIR, { recursive: true });
  for (const kind of GENERATED_AMBIENT_KINDS) {
    const out = path.join(AMBIENT_DIR, `${kind}.mp4`);
    if (fs.existsSync(out) && !force) {
      console.log(`  bỏ qua ${kind} (đã có file — thêm --force để tạo lại)`);
      continue;
    }
    const started = Date.now();
    await ffmpeg(buildAmbientLoopArgs(kind, out), { timeoutMs: 10 * 60 * 1000 });
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
