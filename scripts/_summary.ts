/** Request summary before a paid POST. Read-only, no network, no spend. */
import fs from "node:fs";
import { prisma } from "../src/lib/prisma";
async function main() {
  process.env.AI_MOCK_MODE = "false";
  const { resetEnvCache } = await import("../src/lib/env");
  resetEnvCache();
  const { buildVideoConfig } = await import("../src/providers/video-config");
  const { buildCreateBody } = await import("../src/providers/runway/runway-video-client");
  const { toAbsolute } = await import("../src/lib/paths");
  const { fetchRunwayCatalog } = await import("../src/services/provider-catalog");

  const prefixes = process.argv.slice(2);
  const bal = await fetchRunwayCatalog();
  console.log(`So du Runway: ${bal.creditBalance} credit ($${((bal.creditBalance ?? 0) * 0.01).toFixed(2)})\n`);

  let need = 0;
  for (const pre of prefixes) {
    const scene = await prisma.scene.findFirst({
      where: { id: { startsWith: pre } },
      include: { project: { include: { idiom: true } } },
    });
    if (!scene?.imagePath) { console.log(`${pre}: KHONG CO KEYFRAME`); continue; }
    const kf = toAbsolute(scene.imagePath);
    const config = await buildVideoConfig("runway", "h3_max:768x1280");
    const body = buildCreateBody(config, {
      prompt: scene.videoPrompt, seconds: scene.duration, keyframePath: kf,
    });
    const keys = Object.keys(body).sort();
    const okSchema =
      body.model === "h3_max" &&
      body.resolution === "768p" &&
      body.ratio === undefined &&
      keys.join(",") === "duration,model,promptImage,promptText,resolution";
    console.log(`===== ${pre} "${scene.project.idiom.phrase}" canh ${scene.sceneNumber} =====`);
    console.log(`  model        : ${body.model}`);
    console.log(`  resolution   : ${body.resolution}   (config.size=${config.size})`);
    console.log(`  duration     : ${body.duration}  (canh viet ${scene.duration}s)`);
    console.log(`  promptImage  : ${body.promptImage.slice(0,30)}... ${body.promptImage.length} ky tu, file ${fs.statSync(kf).size} bytes`);
    console.log(`  promptText   : ${body.promptText.length} ky tu`);
    console.log(`  fields       : ${keys.join(", ")}`);
    console.log(`  co 'ratio'?  : ${"ratio" in body ? "CO -> SAI" : "KHONG -> dung"}`);
    console.log(`  field gen4?  : ${keys.some((k)=>k==="ratio") ? "CO -> SAI" : "khong"}`);
    console.log(`  SCHEMA       : ${okSchema ? "DAT" : "KHONG DAT - DUNG LAI"}`);
    console.log(`  chi phi       : ${body.duration * 8} credit = $${(body.duration*0.08).toFixed(2)}`);
    console.log("");
    need += body.duration * 8;
  }
  console.log(`Tong can: ${need} credit. Con lai sau do: ${(bal.creditBalance ?? 0) - need} credit.`);
  console.log(`Du credit? ${(bal.creditBalance ?? 0) >= need ? "DU" : "KHONG DU - DUNG LAI"}`);
}
main().finally(() => prisma.$disconnect());
