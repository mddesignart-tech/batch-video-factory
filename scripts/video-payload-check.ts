import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * Inspect exactly what the video adapter WOULD send, without sending it.
 *
 * Written after Runway failed generation twice with INTERNAL.BAD_OUTPUT.CODE01
 * on a request the API had already accepted. When the body is valid but the
 * output is not, the next question is "what is actually in the body" - and
 * answering that by making more paid calls is the expensive way to find out.
 *
 * It writes the real keyframe to disk rather than leaving it as base64 in
 * memory, so the image the vendor receives can be opened and looked at.
 *
 * This script never calls a create endpoint. It makes no network requests at
 * all unless --models is passed, and that one is a GET.
 *
 * Usage:
 *   npx tsx scripts/video-payload-check.ts --provider runway --scene 4
 *   npx tsx scripts/video-payload-check.ts --provider runway --scene 4 --models
 */

const prisma = new PrismaClient();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Identify a file by its leading bytes, not by its extension. */
function magicOf(buf: Buffer): { kind: string; mime: string } {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: "PNG", mime: "image/png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { kind: "JPEG", mime: "image/jpeg" };
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") {
    return { kind: "WEBP", mime: "image/webp" };
  }
  return { kind: "KHONG NHAN RA", mime: "application/octet-stream" };
}

/** PNG colour-type byte says whether an alpha channel is present. */
function pngAlpha(buf: Buffer): string {
  if (buf.length < 26) return "khong doc duoc";
  const colourType = buf[25];
  switch (colourType) {
    case 0:
      return "khong (greyscale)";
    case 2:
      return "khong (RGB)";
    case 3:
      return "khong (bang mau)";
    case 4:
      return "CO (greyscale + alpha)";
    case 6:
      return "CO (RGBA)";
    default:
      return `khong ro (colourType=${String(colourType)})`;
  }
}

async function main(): Promise<void> {
  const provider = arg("provider", "runway");
  const sceneNumber = Number(arg("scene", "4"));
  const idiom = arg("idiom", "Spill the beans");

  const { buildVideoConfig } = await import("../src/providers/video-config");
  const { splitModelSize, billedVideoSeconds } = await import(
    "../src/domain/video-duration"
  );
  const { fitVideoPrompt, RUNWAY_MAX_PROMPT_CHARS } = await import(
    "../src/domain/video-prompt"
  );
  const { prepareKeyframe } = await import(
    "../src/providers/openai/openai-video-provider"
  );
  const { toRunwayRatio, RUNWAY_API_VERSION } = await import(
    "../src/providers/runway/runway-video-client"
  );
  const { toAbsolute, projectSubdir } = await import("../src/lib/paths");
  const { ffprobe } = await import("../src/media/ffmpeg");

  console.log(`\n========== KIEM TRA PAYLOAD ${provider.toUpperCase()} (khong goi create) ==========\n`);

  // ---- the scene ---------------------------------------------------------
  const project = await prisma.project.findFirst({
    where: { idiom: { phrase: idiom } },
    include: { idiom: true, scenes: { orderBy: { sceneNumber: "asc" } } },
  });
  const scene = project?.scenes.find((s) => s.sceneNumber === sceneNumber);
  if (!project || !scene?.imagePath) {
    console.log("  Khong tim thay canh hoac keyframe.\n");
    process.exitCode = 1;
    return;
  }

  const rows = await prisma.modelRegistry.findMany({
    where: { provider, type: "video" },
    orderBy: { price: "asc" },
  });
  const model = rows[0];
  if (!model) {
    console.log(`  Provider ${provider} khong co model video.\n`);
    process.exitCode = 1;
    return;
  }
  const { apiModel, size } = splitModelSize(model.modelId);
  const config = await buildVideoConfig(provider, model.modelId);

  // ---- 1. the keyframe, written where it can be opened -------------------
  console.log("--- 1. KEYFRAME RUNWAY THUC SU NHAN ---\n");
  const sourceAbs = toAbsolute(scene.imagePath);
  const sourceBuf = fs.readFileSync(sourceAbs);
  const sourceMagic = magicOf(sourceBuf);
  console.log("  ANH GOC (truoc khi xu ly)");
  console.log(`    Duong dan       : ${sourceAbs}`);
  console.log(`    Dung luong      : ${sourceBuf.length} byte (${(sourceBuf.length / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`    Magic bytes     : ${sourceMagic.kind}`);

  const prepared = prepareKeyframe(sourceAbs, size);

  // Copy it somewhere durable. prepareKeyframe writes to a temp dir it expects
  // the caller to delete, and a file that vanishes cannot be inspected.
  const outDir = toAbsolute(projectSubdir(project.id, "temp"));
  fs.mkdirSync(outDir, { recursive: true });
  const keptPath = path.join(outDir, `runway-keyframe-scene${sceneNumber}.png`);
  fs.copyFileSync(prepared.path, keptPath);
  const keptBuf = fs.readFileSync(keptPath);
  const magic = magicOf(keptBuf);

  console.log("\n  ANH GUI DI (sau prepareKeyframe)");
  console.log(`    Duong dan       : ${keptPath}`);
  console.log(`    Dung luong      : ${keptBuf.length} byte (${(keptBuf.length / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`    Magic bytes     : ${magic.kind}  ${magic.kind === "PNG" ? "(dung PNG)" : "(KHONG PHAI PNG)"}`);
  console.log(`    MIME suy ra     : ${magic.mime}`);
  console.log(`    Alpha channel   : ${magic.kind === "PNG" ? pngAlpha(keptBuf) : "khong ap dung"}`);

  // Dimensions from the PNG header, then independently from ffprobe.
  const hdrW = keptBuf.length >= 24 ? keptBuf.readUInt32BE(16) : 0;
  const hdrH = keptBuf.length >= 24 ? keptBuf.readUInt32BE(20) : 0;
  console.log(`    Kich thuoc (PNG): ${hdrW}x${hdrH}`);

  let probeOk = false;
  try {
    const r = await ffprobe([
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,pix_fmt,codec_name",
      "-of", "default=noprint_wrappers=1",
      keptPath,
    ]);
    probeOk = true;
    console.log("    ffprobe         :");
    for (const line of r.stdout.trim().split(/\r?\n/)) {
      console.log(`      ${line}`);
    }
  } catch (err) {
    console.log(`    ffprobe         : LOI ${err instanceof Error ? err.message : String(err)}`);
  }

  const { width: wantW, height: wantH } = { width: Number(size.split("x")[0]), height: Number(size.split("x")[1]) };
  const dimsOk = hdrW === wantW && hdrH === wantH;
  const ratio = hdrH > 0 ? hdrW / hdrH : 0;
  console.log(`\n    Dung ${wantW}x${wantH}?  ${dimsOk ? "DUNG" : `SAI - dang la ${hdrW}x${hdrH}`}`);
  console.log(`    Ty le           : ${ratio.toFixed(4)}  (9:16 = ${(9 / 16).toFixed(4)})  ${Math.abs(ratio - 9 / 16) < 0.001 ? "KHOP 9:16" : "KHONG khop"}`);
  console.log(`    ffmpeg giai ma  : ${probeOk ? "SACH" : "CO LOI"}`);

  // Orientation metadata. A rotation tag is a classic way for an image to look
  // correct in a viewer and arrive at a vendor sideways: the pixels say one
  // thing and the tag says another, and different decoders obey different ones.
  try {
    const rot = await ffprobe([
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream_tags=rotate:side_data=rotation:format_tags=Orientation",
      "-of", "default=noprint_wrappers=1",
      keptPath,
    ]);
    const tags = rot.stdout.trim();
    console.log(
      "    Metadata xoay   : " +
        (tags.length === 0
          ? "KHONG CO (tot - pixel la su that duy nhat)"
          : tags.split(/\s+/).join(", ")),
    );
  } catch {
    console.log("    Metadata xoay   : khong doc duoc");
  }

  if (prepared.temporary) fs.rmSync(path.dirname(prepared.path), { recursive: true, force: true });

  // ---- 2. the payload, sanitized ----------------------------------------
  console.log("\n--- 2. PAYLOAD (da che key va base64) ---\n");
  const requested = scene.duration;
  const billed = billedVideoSeconds({
    provider,
    model: model.modelId,
    size,
    requestedSeconds: requested,
    hasKeyframe: true,
  });
  const fitted = fitVideoPrompt(scene.videoPrompt, RUNWAY_MAX_PROMPT_CHARS);
  const b64Len = Math.ceil((keptBuf.length / 3) * 4);

  console.log(`  endpoint          : POST ${config.baseUrl.replace(/\/+$/, "")}/image_to_video`);
  console.log(`  X-Runway-Version  : ${RUNWAY_API_VERSION}`);
  console.log(`  Authorization     : Bearer <DA CHE>  (${config.apiKey.length} ky tu)`);
  console.log(`  Content-Type      : application/json`);
  console.log("");
  console.log(`  provider          : ${provider}`);
  console.log(`  model (registry)  : ${model.modelId}`);
  console.log(`  model (gui di)    : ${apiModel}`);
  console.log(`  duration          : ${billed}  (canh dai ${requested}s, Runway tinh tien ${billed}s)`);
  console.log(`  ratio             : ${toRunwayRatio(size)}`);
  console.log(`  resolution        : ${size}`);
  console.log(`  promptImage MIME  : ${magic.mime}`);
  console.log(`  promptImage bytes : ${keptBuf.length}`);
  console.log(`  promptImage b64   : ~${b64Len} ky tu (~${(b64Len / 1024 / 1024).toFixed(2)} MB) <DA CHE>`);
  console.log(`  promptText length : ${fitted.finalChars}${fitted.changed ? ` (rut gon tu ${fitted.originalChars})` : ""}`);
  console.log("");
  console.log("  promptText day du :");
  console.log("  " + "-".repeat(66));
  for (const line of fitted.text.split("\n")) console.log(`  ${line}`);
  console.log("  " + "-".repeat(66));

  // ---- 3. model capability, from the vendor ------------------------------
  if (flag("models")) {
    console.log("\n--- 3. MODEL THEO API (GET, khong tinh tien) ---\n");
    try {
      const res = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/organization`, {
        headers: {
          "X-Runway-Version": RUNWAY_API_VERSION,
          Authorization: `Bearer ${config.apiKey}`,
        },
        signal: AbortSignal.timeout(30_000),
      });
      console.log(`  GET /organization -> HTTP ${res.status}`);
      if (res.ok) {
        const json = (await res.json()) as {
          tier?: { models?: Record<string, { maxConcurrentGenerations?: number; maxDailyGenerations?: number }> };
        };
        const entry = json.tier?.models?.[apiModel];
        console.log(`  "${apiModel}" trong danh sach: ${entry ? "CO" : "KHONG"}`);
        if (entry) console.log(`    ${JSON.stringify(entry)}`);
      }
    } catch (err) {
      console.log(`  loi mang: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- 4. which API versions does this account's API accept? -------------
  //
  // An unsupported version header is answered with a 400 that names the
  // supported ones. GET + 400 is free, so the pinned version can be verified
  // against the API itself instead of against documentation we cannot see.
  if (flag("versions")) {
    console.log("\n--- 4. X-RUNWAY-VERSION (GET, khong tinh tien) ---\n");
    const probes = ["2024-09-13", "2024-11-06", "2099-01-01", ""];
    for (const v of probes) {
      try {
        const res = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/organization`, {
          headers: {
            ...(v ? { "X-Runway-Version": v } : {}),
            Authorization: `Bearer ${config.apiKey}`,
          },
          signal: AbortSignal.timeout(30_000),
        });
        const body = (await res.text()).slice(0, 300);
        const label = v === "" ? "(khong gui header)" : v;
        console.log(`  ${label.padEnd(20)} -> HTTP ${res.status}`);
        if (!res.ok) console.log(`    ${body}`);
      } catch (err) {
        console.log(`  ${(v || "(khong gui)").padEnd(20)} -> loi ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`\n  Adapter dang ghim : ${RUNWAY_API_VERSION}`);
  }

  console.log("\n  (Script nay khong goi endpoint create. Khong ton tien.)\n");
}

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
