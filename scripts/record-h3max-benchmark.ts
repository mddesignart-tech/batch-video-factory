/**
 * File the h3_max benchmark result. Read-only as far as any vendor is
 * concerned: it makes NO network calls and spends nothing.
 *
 * The clip it records was produced by exactly one paid create on 2026-09-15,
 * task b6fddf11-900b-43f2-9cca-df366f80c6f0, 40 credits ($0.40), on the same
 * scene and the same keyframe that gen4_turbo failed twice with
 * INTERNAL.BAD_OUTPUT.CODE01. Same input, different model - which is the only
 * way the comparison means anything.
 *
 * The scores are a person's reading of five extracted frames. They are written
 * down as numbers rather than prose so the next model can be compared against
 * them instead of against somebody's memory.
 */
import { prisma } from "../src/lib/prisma";
import { recordBenchmark } from "../src/services/benchmark-evidence";
import { recordVerification } from "../src/services/provider-catalog";

const TASK_ID = "b6fddf11-900b-43f2-9cca-df366f80c6f0";
const MODEL_ID = "h3_max:768x1280";
const OUTPUT =
  "projects/f2b68443-0c9c-4bec-9775-e0ed864c104a/videos/8ebf22c5-ed68-42d6-b6a0-26767223c7bb.mp4";

async function main() {
  const scene = await prisma.scene.findFirst({
    where: { id: { startsWith: "71cd51f2" } },
    include: { project: true },
  });
  if (!scene) throw new Error("Không tìm thấy cảnh benchmark.");

  const job = await prisma.providerJob.findFirst({
    where: { externalId: TASK_ID },
  });

  await recordBenchmark({
    provider: "runway",
    model: MODEL_ID,
    taskId: TASK_ID,
    projectId: scene.projectId,
    sceneNumber: scene.sceneNumber,
    complexity: scene.complexity as "LOW" | "MEDIUM" | "HIGH",
    // Scene rows do not store the numeric score, only the band. Passing 0 is
    // honest here; inventing a number to fill the column would be worse.
    complexityScore: 0,
    characterCount: 1,
    promptSent: scene.videoPrompt,
    durationRequested: scene.duration,
    durationSent: 5,
    keyframePath: scene.imagePath ?? "",
    outcome: "succeeded",
    credits: 40,
    actualCost: job?.actualCost ?? 0.4,
    generationMs: 28_900,
    outputPath: OUTPUT,
    scores: {
      // Max is the only character in this scene; Leo and Mia are absent, and
      // scoring an absent character would flatter the average.
      maxIdentity: 10,
      faceDrift: 9,
      handsBody: 9,
      motion: 8,
      camera: 8,
      composition: 9,
      artifacts: 9,
      clothingConsistency: 10,
      staysInFrame: 10,
      keyframeAdherence: 9,
    },
    notes:
      "Mot lan tao duy nhat, 40 credits. Output 768x1280 - DUNG 9:16, khong phai " +
      "2:3 theo anh dau vao nhu tai lieu goi y. Nhan vat, trang phuc, van nhay " +
      "giu nguyen tu frame dau den frame cuoi. Tay/ngon tay sach. Tru diem o " +
      "Motion va Camera: prompt yeu cau 'static locked camera' va chi nghieng " +
      "DAU, nhung model cho ca than tren cui ve phia truoc va co dich chuyen " +
      "khung rat nhe. Clip co san audio AAC (h3_max luon bat audio goc); pipeline " +
      "dung map [1:a] la file giong doc nen audio nay bi bo dung cach, khong ton " +
      "them tien va khong can sua.",
  });

  const advanced = await recordVerification(
    "runway",
    MODEL_ID,
    "BENCHMARK_VERIFIED",
    `Task ${TASK_ID}, 40 credits, 1 clip dat. VAN GIU PIN_ONLY: mot mau khong du de auto-route.`,
  );

  // Deliberately NOT promoted to ACTIVE. One clip proves the adapter builds a
  // valid request and the model can do this kind of shot; it does not prove the
  // model should be the router's default. gen4_turbo became the default on
  // exactly this much evidence and then failed twice.
  const row = await prisma.modelRegistry.findFirst({ where: { modelId: MODEL_ID } });
  console.log(`verification: ${row?.verification} (advanced: ${advanced})`);
  console.log(`lifecycle   : ${row?.lifecycle}  <- van chan auto-route`);
  console.log(`reliability : ${row?.reliability}`);

  const gen4 = await prisma.modelRegistry.findFirst({
    where: { modelId: "gen4_turbo:720x1280" },
  });
  console.log(`\ngen4_turbo  : lifecycle=${gen4?.lifecycle} reliability=${gen4?.reliability}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
