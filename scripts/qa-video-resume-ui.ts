import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { isProductionDatabase } from "@/lib/db-location";
import { toAbsolute } from "@/lib/paths";
import { ffmpeg } from "@/media/ffmpeg";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import { setSpendCap } from "@/services/spend-guard";

/**
 * Fixture for the browser check of the per-video table (QĐ-110 / QĐ-111).
 * MOCK ONLY, on a scratch database - refuses to touch data/app.db.
 *
 *   seed    mock providers/models + a 6-video storyboard folder and ZIP to import in the UI
 *   states  after the UI run: turn videos B..E into FAILED / BLOCKED / render-only / NEEDS_RECOVERY
 *
 * Env: DATA_DIR=data/.ui-qa-p3 DATABASE_URL=file:../data/.ui-qa-p3/app.db AI_MOCK_MODE=true
 */

const VIDEOS = [
  { id: "a", title: "A — hoàn thành", clip: false },
  { id: "b", title: "B — thiếu giọng (FAILED)", clip: false },
  { id: "c", title: "C — vượt trần (BLOCKED)", clip: true },
  { id: "d", title: "D — mất final.mp4 (render lại)", clip: false },
  { id: "e", title: "E — request trả phí chưa rõ (NEEDS_RECOVERY)", clip: true },
  { id: "f", title: "F — có clip Video AI, dùng để thử RUNNING", clip: true },
];

function guard(): void {
  if (!isMockMode()) throw new Error("AI_MOCK_MODE phải = true.");
  if (isProductionDatabase()) throw new Error("Đang trỏ vào data/app.db — script QA này chỉ chạy trên DB nháp.");
}

async function seed(): Promise<void> {
  for (const provider of SEED_PROVIDERS.filter((p) => p.name === "mock")) {
    await prisma.providerConfig.upsert({
      where: { name: provider.name },
      create: { ...provider, types: JSON.stringify(provider.types), status: "connected" },
      update: { enabled: true, status: "connected" },
    });
  }
  for (const model of SEED_MODELS.filter((m) => m.provider === "mock")) {
    await prisma.modelRegistry.upsert({
      where: { provider_modelId: { provider: model.provider, modelId: model.modelId } },
      create: model,
      update: { enabled: true },
    });
  }
  for (const preset of SEED_STYLE_PRESETS) {
    await prisma.stylePreset.upsert({ where: { slug: preset.slug }, create: { ...preset, aspectRatio: "9:16" }, update: {} });
  }
  for (const character of SEED_CHARACTERS) {
    await prisma.character.upsert({
      where: { name: character.name },
      create: { ...character, voiceProvider: "mock", enabled: true },
      update: {},
    });
  }
  await setSpendCap(20);

  const root = path.resolve(process.env.DATA_DIR ?? "data/.ui-qa-p3", "storyboard-6");
  const colours = ["0xD32F2F", "0x1565C0", "0x2E7D32", "0x6A1B9A", "0xEF6C00", "0x37474F"];
  for (const [i, v] of VIDEOS.entries()) {
    const dir = path.join(root, `video-${v.id}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const n of [1, 2]) {
      await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colours[i]}:s=1080x1920`, "-frames:v", "1", path.join(dir, `s${n}.png`)]);
    }
    const scenes = [1, 2].map((n) => ({
      scene_number: n,
      duration: 3,
      visual_description: `Max against a plain wall, shot ${n}.`,
      character_action: "Max holds still.",
      camera: "Locked static medium shot, no camera movement.",
      dialogue: `Max: "Video ${v.id.toUpperCase()}, line ${n}."`,
      subtitle: `Line ${n}.`,
      image_file: `s${n}.png`,
      motion_mode: v.clip && n === 2 ? "VIDEO_AI" : "LOCAL_MOTION",
      priority: v.clip && n === 2 ? "HIGH" : "LOW",
    }));
    fs.writeFileSync(
      path.join(dir, "storyboard.json"),
      JSON.stringify({ video_id: `qa-p3-${v.id}`, video_title: v.title, characters: [{ character_id: "max", character_name: "Max" }], scenes }, null, 2),
    );
  }
  console.log(`seed xong. Thư mục storyboard: ${root}`);
}

async function projectByTitle(prefix: string) {
  return prisma.project.findFirstOrThrow({ where: { title: { startsWith: prefix } }, orderBy: { createdAt: "desc" } });
}

async function states(): Promise<void> {
  // B: one voice line lost -> FAILED, paid voice needed.
  const b = await projectByTitle("B —");
  const bScene = await prisma.scene.findFirstOrThrow({ where: { projectId: b.id, sceneNumber: 2 } });
  const bKeys = (await prisma.providerJob.findMany({ where: { sceneId: bScene.id, kind: "audio" } })).map((j) => j.idempotencyKey);
  await prisma.costReservation.deleteMany({ where: { idempotencyKey: { in: bKeys } } });
  await prisma.providerJob.deleteMany({ where: { sceneId: bScene.id, kind: "audio" } });
  await prisma.dialogueLine.updateMany({ where: { sceneId: bScene.id }, data: { status: "pending", outputPath: "" } });
  await prisma.scene.update({ where: { id: bScene.id }, data: { audioPath: null, status: "image_ready" } });
  await prisma.project.update({ where: { id: b.id }, data: { status: "failed", errorMessage: "QA: mất giọng cảnh 2" } });

  // C: clip lost AND the video's own limit lowered below its price -> BLOCKED.
  const c = await projectByTitle("C —");
  const cScene = await prisma.scene.findFirstOrThrow({ where: { projectId: c.id, sceneNumber: 2 } });
  const cKeys = (await prisma.providerJob.findMany({ where: { sceneId: cScene.id, kind: "video" } })).map((j) => j.idempotencyKey);
  await prisma.costReservation.deleteMany({ where: { idempotencyKey: { in: cKeys } } });
  await prisma.providerJob.deleteMany({ where: { sceneId: cScene.id, kind: "video" } });
  await prisma.scene.update({ where: { id: cScene.id }, data: { videoPath: null, status: "image_ready" } });
  await prisma.project.update({ where: { id: c.id }, data: { status: "failed", maxBudget: 0.001, errorMessage: "QA: mất clip" } });

  // D: finished, but final.mp4 is gone -> local render only, $0.
  const d = await projectByTitle("D —");
  if (d.finalVideoPath && fs.existsSync(toAbsolute(d.finalVideoPath))) fs.rmSync(toAbsolute(d.finalVideoPath));

  // E: a paid request that may have been charged (another provider's name, DATA
  // ONLY - mock mode cannot reach it) -> NEEDS_RECOVERY, never re-sent.
  const e = await projectByTitle("E —");
  const eScene = await prisma.scene.findFirstOrThrow({ where: { projectId: e.id, sceneNumber: 2 } });
  await prisma.scene.update({ where: { id: eScene.id }, data: { videoPath: null } });
  const key = `synthetic-qa-${randomUUID()}`;
  await prisma.providerJob.create({
    data: {
      provider: "runway",
      model: "h3_max:768x1280",
      kind: "video",
      idempotencyKey: key,
      status: "failed",
      externalId: `task-${randomUUID().slice(0, 8)}`,
      projectId: e.id,
      sceneId: eScene.id,
      error: "QA: poll timeout",
      estimatedCost: 0.4,
    },
  });
  await prisma.costReservation.create({
    data: {
      batchId: e.batchId!,
      projectId: e.id,
      sceneId: eScene.id,
      idempotencyKey: key,
      kind: "video",
      provider: "runway",
      model: "h3_max:768x1280",
      status: "COMMITTED",
      estimatedCost: 0.4,
      actualCost: 0.4,
    },
  });
  await prisma.project.update({ where: { id: e.id }, data: { status: "failed", errorMessage: "QA: poll timeout" } });
  console.log("states xong: B FAILED · C BLOCKED · D render-only · E NEEDS_RECOVERY · A/F COMPLETED");
}

/** Ledger + dialogue-line bookkeeping of one video, to prove a resume wrote nothing. */
async function snapshot(prefix: string): Promise<void> {
  const p = await projectByTitle(prefix);
  const lines = await prisma.dialogueLine.findMany({
    where: { scene: { projectId: p.id } },
    orderBy: { id: "asc" },
    select: { id: true, status: true, updatedAt: true },
  });
  console.log(
    JSON.stringify({
      project: p.title,
      status: p.status,
      providerJobs: await prisma.providerJob.count({ where: { projectId: p.id } }),
      costEntries: await prisma.costEntry.count({ where: { projectId: p.id } }),
      reservations: await prisma.costReservation.count({ where: { projectId: p.id } }),
      lines: lines.map((l) => `${l.status}@${l.updatedAt.toISOString()}`),
    }),
  );
}

async function dropFinal(prefix: string): Promise<void> {
  const p = await projectByTitle(prefix);
  if (p.finalVideoPath && fs.existsSync(toAbsolute(p.finalVideoPath))) fs.rmSync(toAbsolute(p.finalVideoPath));
  console.log(`đã xoá final.mp4 của ${p.title}`);
}

async function main(): Promise<void> {
  guard();
  const cmd = process.argv[2];
  if (cmd === "seed") await seed();
  else if (cmd === "states") await states();
  else if (cmd === "snapshot") await snapshot(process.argv[3] ?? "D —");
  else if (cmd === "drop-final") await dropFinal(process.argv[3] ?? "D —");
  else throw new Error("Dùng: seed | states | snapshot <tiền tố> | drop-final <tiền tố>");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
