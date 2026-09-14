import fs from "node:fs";
import { PrismaClient } from "@prisma/client";

/**
 * Write the benchmark runs that have already happened into the evidence table.
 *
 * These are backfilled from logs, job records and the frames that were looked
 * at. Everything here was paid for; nothing is estimated or invented, and a run
 * with no score recorded is left unscored rather than guessed.
 *
 * Idempotent: re-running updates the row for a task rather than adding another.
 *
 * Usage:
 *   npx tsx scripts/record-benchmarks.ts
 */

const prisma = new PrismaClient();

interface Seed {
  taskId: string;
  provider: string;
  model: string;
  sceneNumber: number;
  complexity: string;
  complexityScore: number;
  characterCount: number;
  promptSent: string;
  durationRequested: number;
  durationSent: number;
  keyframePath: string;
  outcome: "succeeded" | "failed";
  failureCode?: string;
  credits: number;
  actualCost: number;
  generationMs: number;
  outputPath: string;
  scores?: Record<string, number>;
  notes: string;
}

const PROJECT = "40d52adb-6bfa-4920-9a06-eca7f202d8b1";

const RUNS: Seed[] = [
  // ---- Runway gen4_turbo, scene 4: refused twice -------------------------
  {
    taskId: "72a37606-ff21-406a-90a6-cadeea73a368",
    provider: "runway",
    model: "gen4_turbo:720x1280",
    sceneNumber: 4,
    complexity: "MEDIUM",
    complexityScore: 6.5,
    characterCount: 2,
    promptSent:
      "Animate this keyframe. Scene: Max and Leo stand together on a floor " +
      "covered with spilled beans. [Movement paragraph preserved, constraints " +
      "compacted to 796 chars for Runway's 1000-char limit.]",
    durationRequested: 4,
    durationSent: 5,
    keyframePath: `projects/${PROJECT}/images/5a55264f-00f0-4807-bb89-aec2d4a14c8a.png`,
    outcome: "failed",
    failureCode: "INTERNAL.BAD_OUTPUT.CODE01",
    credits: 0,
    actualCost: 0,
    generationMs: 0,
    outputPath: "",
    notes:
      "Hỏng lần 1. Runway tự tính 0 credit. Ảnh, payload, model và API version " +
      "đều đã kiểm chứng đúng - lỗi nằm phía nhà cung cấp hoặc ở nội dung cảnh.",
  },
  {
    taskId: "59f4258e-c223-47dc-910e-2462227dc85b",
    provider: "runway",
    model: "gen4_turbo:720x1280",
    sceneNumber: 4,
    complexity: "MEDIUM",
    complexityScore: 6.5,
    characterCount: 2,
    promptSent: "Giống hệt lần 1, từng byte.",
    durationRequested: 4,
    durationSent: 5,
    keyframePath: `projects/${PROJECT}/images/5a55264f-00f0-4807-bb89-aec2d4a14c8a.png`,
    outcome: "failed",
    failureCode: "INTERNAL.BAD_OUTPUT.CODE01",
    credits: 0,
    actualCost: 0,
    generationMs: 0,
    outputPath: "",
    notes:
      "Hỏng lần 2 với request y hệt. Tái lập được - đây là cơ sở cho marker " +
      "RUNWAY_UNSUITABLE: gửi lại y hệt sẽ hỏng y hệt.",
  },

  // ---- Runway gen4_turbo, scene 5: succeeded ------------------------------
  {
    taskId: "d989d38c-a740-4147-9ce0-dc122a60fe56",
    provider: "runway",
    model: "gen4_turbo:720x1280",
    sceneNumber: 5,
    complexity: "LOW",
    complexityScore: 3.5,
    characterCount: 1,
    promptSent:
      "Animate this image naturally. Leo remains in the same position and keeps " +
      "the same face, glasses, hairstyle, clothing and body proportions. Leo " +
      "gives one small friendly nod and a slight smile. Keep movement natural " +
      "and clearly visible. Static camera. No camera movement. No new " +
      "characters. No new objects. No text. No morphing. No body deformation. " +
      "No face drift.",
    durationRequested: 3,
    durationSent: 5,
    keyframePath: `projects/${PROJECT}/images/fb6f561b-8686-49a2-8734-7c3453f8dd63.png`,
    outcome: "succeeded",
    credits: 25,
    actualCost: 0.25,
    generationMs: 29_100,
    outputPath: `projects/${PROJECT}/videos/0287c735-4b27-4cb6-b905-111d791e3119.mp4`,
    scores: {
      leoIdentity: 10,
      motion: 4,
      artifacts: 7,
      camera: 10,
      composition: 6,
    },
    notes:
      "Identity và camera xuất sắc. Bám prompt kém: prompt yêu cầu giữ nguyên " +
      "tư thế, model lại hạ hẳn cánh tay đang chỉ xuống. Tay nhoè lúc hạ.",
  },

  // ---- Runway gen4.5, scene 3, run 1: loose camera prompt -----------------
  {
    taskId: "8efc865b-eba0-41a1-b1f4-8dbe457fffca",
    provider: "runway",
    model: "gen4.5:720x1280",
    sceneNumber: 3,
    complexity: "HIGH",
    complexityScore: 9,
    characterCount: 3,
    promptSent:
      "Animate this image naturally. Max reacts comedically to the falling " +
      "beans... Static camera, or a very slow push-in. No pan, no tilt, no whip.",
    durationRequested: 6,
    durationSent: 6,
    keyframePath: `projects/${PROJECT}/images/e22213b7-e2ef-4c0a-8544-a5125a1e03ea.png`,
    outcome: "succeeded",
    credits: 72,
    actualCost: 0.72,
    generationMs: 240_000,
    outputPath: `projects/${PROJECT}/videos/d43456bd-1354-4276-9529-d2ca318ea310.mp4`,
    scores: {
      maxIdentity: 6,
      leoIdentity: 10,
      miaIdentity: 10,
      motion: 7,
      smallObjectConsistency: 9,
      physics: 8,
      artifacts: 6,
      camera: 4,
      composition: 3,
      humorReadability: 5,
    },
    notes:
      "Làm được cảnh HIGH mà gen4_turbo từ chối, và giữ hàng trăm hạt đậu ổn " +
      "định. Nhưng prompt cho phép 'very slow push-in' và model đẩy vào cho tới " +
      "khi Max RA KHỎI KHUNG ở giây 5.9. Sọc trắng hoodie mờ gần hết, tay Max " +
      "nhoè lúc tiếp đất.",
  },

  // ---- Runway gen4.5, scene 3, run 2: strict camera lock ------------------
  {
    taskId: "75d7a44c-d85d-4d12-9423-3eb713a6e0e1",
    provider: "runway",
    model: "gen4.5:720x1280",
    sceneNumber: 3,
    complexity: "HIGH",
    complexityScore: 9,
    characterCount: 3,
    promptSent:
      "Animate this image while preserving the exact composition. Keep the " +
      "original wide shot. LOCKED CAMERA. No zoom, no push-in, no pull-out, no " +
      "pan, no tilt, no orbit, no dolly, no reframing, no camera shake, no crop " +
      "change... All three characters must remain fully visible inside the " +
      "frame for the entire clip, including the final frame.",
    durationRequested: 6,
    durationSent: 6,
    keyframePath: `projects/${PROJECT}/images/e22213b7-e2ef-4c0a-8544-a5125a1e03ea.png`,
    outcome: "succeeded",
    credits: 72,
    actualCost: 0.72,
    generationMs: 166_300,
    outputPath: `projects/${PROJECT}/videos/ba2e1cf9-3c1e-4648-9bb3-6a3b8898d97f.mp4`,
    scores: {
      maxIdentity: 9,
      leoIdentity: 9,
      miaIdentity: 10,
      motion: 8,
      smallObjectConsistency: 9,
      physics: 8,
      artifacts: 7,
      camera: 7,
      composition: 9,
      humorReadability: 8,
    },
    notes:
      "A/B có kiểm soát với run 1: chỉ đổi prompt. Composition 3 -> 9, không ai " +
      "rời khung, sọc hoodie trở lại, tay hết nhoè. Nhưng tới 4.5s khung vẫn " +
      "siết vào đủ để cắt tay trái Leo, dù prompt cấm camera bằng bảy cách. " +
      "Kính Leo trắng đục quanh 3.0-4.5s. KHÔNG ĐẠT: camera 7 và artifacts 7 " +
      "đều dưới ngưỡng 8.",
  },
];

async function main(): Promise<void> {
  const { toAbsolute } = await import("../src/lib/paths");
  console.log("\n========== GHI BENCHMARK THAT VAO BANG BANG CHUNG ==========\n");

  for (const run of RUNS) {
    const existing = await prisma.videoBenchmark.findFirst({
      where: { taskId: run.taskId },
    });
    const data = {
      provider: run.provider,
      model: run.model,
      taskId: run.taskId,
      projectId: PROJECT,
      sceneNumber: run.sceneNumber,
      complexity: run.complexity,
      complexityScore: run.complexityScore,
      characterCount: run.characterCount,
      promptSent: run.promptSent,
      durationRequested: run.durationRequested,
      durationSent: run.durationSent,
      keyframePath: run.keyframePath,
      outcome: run.outcome,
      failureCode: run.failureCode ?? "",
      credits: run.credits,
      actualCost: run.actualCost,
      generationMs: run.generationMs,
      outputPath: run.outputPath,
      scoresJson: JSON.stringify(run.scores ?? {}),
      notes: run.notes,
    };

    if (existing) {
      await prisma.videoBenchmark.update({ where: { id: existing.id }, data });
    } else {
      await prisma.videoBenchmark.create({ data });
    }

    // A recorded output path that no longer exists is worth knowing about: the
    // evidence points at a file someone can watch, or it points at nothing.
    const fileNote =
      run.outputPath === ""
        ? ""
        : fs.existsSync(toAbsolute(run.outputPath))
          ? "  tep: CO"
          : "  tep: MAT";
    console.log(
      `  ${existing ? "cap nhat" : "them moi"}  ${run.model.padEnd(20)} ` +
        `canh ${run.sceneNumber} ${run.complexity.padEnd(6)} ${run.outcome.padEnd(9)} ` +
        `$${run.actualCost.toFixed(4)}${fileNote}`,
    );
  }

  const total = await prisma.videoBenchmark.count();
  const spent = await prisma.videoBenchmark.aggregate({ _sum: { actualCost: true } });
  console.log(`\n  Tong benchmark da ghi: ${total}`);
  console.log(`  Tong tien da chi cho benchmark video: $${(spent._sum.actualCost ?? 0).toFixed(4)}`);

  // ---- the guard: do the routing rules agree with what was paid for? ------
  const { findContradictions } = await import("../src/services/benchmark-evidence");
  const conflicts = await findContradictions();
  console.log("\n--- LUAT DINH TUYEN CO MAU THUAN VOI BANG CHUNG KHONG? ---\n");
  if (conflicts.length === 0) {
    console.log("  Khong co mau thuan nao.\n");
  } else {
    for (const c of conflicts) {
      console.log(`  [${c.kind}] ${c.message}`);
    }
    console.log("");
  }
}

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
