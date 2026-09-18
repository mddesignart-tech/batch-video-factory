import { prisma } from "@/lib/prisma";
import { recordBenchmark } from "@/services/benchmark-evidence";

/**
 * File the two h3_max clips the first real production batch bought.
 *
 * Read-only as far as any vendor is concerned: no network call, nothing spent.
 * Both clips already exist and were paid for on 2026-09-18 inside batch
 * a690a290, 40 credits each.
 *
 * ## Why these rows matter more than the benchmark rows before them
 *
 * Every earlier h3_max row came from a clip bought ON PURPOSE to learn
 * something, on a scene chosen because it had already broken another model.
 * These two are the first that came out of an ordinary production run: the
 * router picked the model at plan time, a batch approval paid for it, and
 * nobody was watching for a particular failure. That is the population the
 * routing rules are actually about.
 *
 * ## How the scores were arrived at
 *
 * Five stills per clip (0.00 / 1.30 / 2.59 / 3.89 / 5.10s) read by eye against
 * the keyframe that was sent, plus two measurements that do not depend on
 * anyone's eye:
 *
 *   per-frame scene_score   how much changes between consecutive frames -
 *                           the motion budget, and proof there is no cut
 *   border-band difference  first frame vs last frame, restricted to the left,
 *                           right and top edges where the SUBJECT never is.
 *                           A locked camera leaves the background aligned, so
 *                           anything above the noise floor is camera drift.
 *
 * The numbers are written down rather than described so the next model can be
 * compared against them instead of against somebody's memory.
 *
 *   npx tsx scripts/record-batch-benchmarks.ts [--apply]
 */

const BATCH_ID = "a690a290-bb28-4dbd-9903-0d8018bb0db1";
const MODEL_ID = "h3_max:768x1280";

interface Entry {
  taskId: string;
  sceneNumber: number;
  generationMs: number;
  scores: Record<string, number>;
  notes: string;
}

const ENTRIES: Entry[] = [
  {
    taskId: "d4f779ed-8679-491b-bd57-22ca7d2d66e5",
    sceneNumber: 1,
    generationMs: 2953,
    scores: {
      maxIdentity: 10,
      faceDrift: 9,
      handsBody: 9,
      clothingConsistency: 10,
      staysInFrame: 10,
      motion: 7,
      camera: 10,
      composition: 9,
      artifacts: 9,
      keyframeAdherence: 8,
      promptAdherence: 9,
    },
    notes:
      "Canh 1, 5s, 1 nhan vat (Max), keyframe co dinh - Max dung cuoi cau nhay, " +
      "nen troi phang. Prompt: cui dau, mo to mat, may khoa.\n" +
      "CAMERA 10: canh van bat dau va ket thuc o dung mot vi tri pixel. Lech nen " +
      "giua frame dau va frame cuoi do o ba bien: trai YAVG 1.13, phai 1.38 - " +
      "muc nhieu nen. Bien TREN 10.69 la do TOC nhan vat ha xuong khoi vung do, " +
      "khong phai may dich: canh cau nhay o goc duoi van trung khop tuyet doi.\n" +
      "MOTION 7: dung y do nhung rat kin. scene_score trung binh 0.0011, lon nhat " +
      "0.0065 tren 124 frame - gan nhu anh tinh co thoi. Doi voi mot cau 'cui dau, " +
      "mo mat' thi dat; neu canh can chuyen dong ro hon thi con so nay la canh bao.\n" +
      "KEYFRAME 8: keyframe 1024x1536 (2:3) ra clip 768x1280 (3:5) nen co cat/phong " +
      "nhe, nhan vat to hon mot chut so voi anh goc. Khong phai loi, nhung la mot " +
      "khac biet co that giua thu gui di va thu nhan ve.\n" +
      "Khong thay artifact o 5 diem mau. Tay giu nguyen 5 ngon, ao/toc/mau khong doi.",
  },
  {
    taskId: "ced4ec15-af7a-438a-a536-75ac624269f7",
    sceneNumber: 4,
    generationMs: 2954,
    scores: {
      maxIdentity: 10,
      faceDrift: 9,
      handsBody: 9,
      clothingConsistency: 10,
      staysInFrame: 10,
      motion: 8,
      camera: 10,
      composition: 7,
      artifacts: 9,
      keyframeAdherence: 10,
      promptAdherence: 6,
    },
    notes:
      "Canh 4, 5s, 1 nhan vat (Max), nen phang khong vat the. Prompt: lac dau mot " +
      "cai, lui nua buoc, MAT VAN MO TO, may khoa.\n" +
      "CAMERA 10: ba bien deu o muc nhieu (trai 1.85, phai 1.55, tren 1.40). " +
      "MOTION 8: lac dau va dich lui thay ro; scene_score trung binh 0.0023, lon " +
      "nhat 0.0151 - gap doi canh 1, khong co cut.\n" +
      "PROMPT ADHERENCE 6, VA LOI KHONG THUOC VE h3_max. Keyframe gui vao la mot " +
      "Max DANG CUOI TUOI tren nen trong, khong co cau nhay. Kich ban canh 4 ghi ro " +
      "'His eyes stay wide' va 'along the board'. Mo hinh video da lam dung viec cua " +
      "image-to-video: giu nguyen thu no duoc dua. Cai mat la mat o buoc TAO ANH.\n" +
      "COMPOSITION 7 cung vi ly do do: khung hinh sach nhung trong, va mat lien mach " +
      "voi canh 1-3 vi cau nhay bien mat.\n" +
      "KEYFRAME ADHERENCE 10: bam sat anh dau vao tu dang nguoi, anh sang den mau.\n" +
      "Khong artifact o 5 diem mau.",
  },
];

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log("=".repeat(88));
  console.log(`  GHI BENCHMARK 2 CLIP h3_max CUA LO THAT  ${apply ? "[GHI]" : "[DRY RUN]"}`);
  console.log("=".repeat(88));

  for (const entry of ENTRIES) {
    const job = await prisma.providerJob.findFirst({
      where: { externalId: entry.taskId },
    });
    if (!job) {
      console.log(`\ncanh ${entry.sceneNumber}: KHONG tim thay ProviderJob ${entry.taskId}. Bo qua.`);
      continue;
    }
    const scene = await prisma.scene.findUniqueOrThrow({
      where: { id: job.sceneId ?? "" },
      include: { project: true },
    });
    if (scene.project.batchId !== BATCH_ID) {
      console.log(`\ncanh ${entry.sceneNumber}: clip khong thuoc lo ${BATCH_ID}. Bo qua.`);
      continue;
    }

    // Recording the same clip twice would double its weight in every average
    // the router later reads. The task id is what makes a clip one clip.
    const already = await prisma.videoBenchmark.findFirst({
      where: { taskId: entry.taskId },
    });
    const values = Object.values(entry.scores);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;

    console.log(
      `\ncanh ${entry.sceneNumber}  task ${entry.taskId}\n` +
        `  clip        ${scene.videoPath}\n` +
        `  keyframe    ${scene.imagePath}\n` +
        `  do kho      ${scene.complexity}/${scene.spendPriority}, ${scene.duration}s\n` +
        `  chi phi     $${job.actualCost.toFixed(6)} (40 credit)\n` +
        `  diem TB     ${mean.toFixed(2)}/10 tren ${values.length} tieu chi\n` +
        `  ${Object.entries(entry.scores).map(([k, v]) => `${k}=${v}`).join(" ")}`,
    );
    if (already) {
      console.log("  DA CO ban ghi cho task nay, khong ghi de.");
      continue;
    }
    if (!apply) {
      console.log("  (dry run - chua ghi)");
      continue;
    }

    await recordBenchmark({
      provider: "runway",
      model: MODEL_ID,
      taskId: entry.taskId,
      projectId: scene.projectId,
      sceneNumber: entry.sceneNumber,
      complexity: scene.complexity as "LOW" | "MEDIUM" | "HIGH",
      // The band is what the classifier stored; it never stored the number.
      // Passing 0 is honest, inventing one to fill the column is not.
      complexityScore: 0,
      characterCount: 1,
      promptSent: scene.videoPrompt,
      durationRequested: scene.duration,
      durationSent: 5,
      keyframePath: scene.imagePath ?? "",
      outcome: "succeeded",
      credits: 40,
      actualCost: job.actualCost,
      generationMs: entry.generationMs,
      outputPath: scene.videoPath ?? "",
      scores: entry.scores,
      notes: entry.notes,
    });
    console.log("  da ghi VideoBenchmark.");
  }

  const total = await prisma.videoBenchmark.count({ where: { model: MODEL_ID } });
  console.log(
    `\nTong so ban ghi benchmark cua ${MODEL_ID}: ${total}.\n` +
      "KHONG doi lifecycle, reliability hay verification cua model - hai mau san xuat\n" +
      "khong du de doi mot quyet dinh dinh tuyen, va do la viec cua nguoi van hanh.\n",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
