import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { isProductionDatabase } from "@/lib/db-location";
import { ffmpeg } from "@/media/ffmpeg";
import { SEED_CHARACTERS, SEED_MODELS, SEED_PROVIDERS, SEED_STYLE_PRESETS } from "@/data/seed-config";
import { setSpendCap } from "@/services/spend-guard";
import { materialiseImport, scanImportSource, validateImport } from "@/services/storyboard-import";
import { approveAndRun } from "@/services/batch-executor";

/**
 * Fixture for the Phase 4 browser check (QĐ-112). MOCK ONLY, scratch DB only.
 *
 *   seed      mock providers/models; writes two storyboard folders; imports and
 *             RUNS the "previous" one so the reuse cache holds its assets
 *   counts    ProviderJob per kind for every project (what was really sent)
 *
 * The "current" folder, imported in the UI, is 2 videos / 10 scenes:
 *   A  5 imported pictures · 4 LOCAL_MOTION · 1 VIDEO_AI whose clip exists · voices exist
 *      -> incremental media API cost $0
 *   B  3 pictures exist · 2 new pictures · 4 LOCAL_MOTION · 1 VIDEO_AI clip new · voices exist
 *      -> only 2 images + 1 clip are paid for
 *
 * Env: DATA_DIR=data/.ui-qa-p4 DATABASE_URL=file:../data/.ui-qa-p4/app.db AI_MOCK_MODE=true
 */

const ROOT = path.resolve(process.env.DATA_DIR ?? "data/.ui-qa-p4");
const COLOURS = ["0xD32F2F", "0x1565C0", "0x2E7D32", "0x6A1B9A", "0xEF6C00"];

function guard(): void {
  if (!isMockMode()) throw new Error("AI_MOCK_MODE phải = true.");
  if (isProductionDatabase()) throw new Error("Đang trỏ vào data/app.db — script QA này chỉ chạy trên DB nháp.");
}

interface Row {
  image?: string;
  motion: "LOCAL_MOTION" | "VIDEO_AI";
  description: string;
}

function write(folder: string, id: string, title: string, rows: Row[]): void {
  const dir = path.join(ROOT, folder, id);
  fs.mkdirSync(dir, { recursive: true });
  const scenes = rows.map((r, i) => ({
    scene_number: i + 1,
    duration: 3,
    visual_description: r.description,
    character_action: "Max holds still.",
    camera: "Locked static medium shot, no camera movement.",
    dialogue: `Max: "${title}, line ${i + 1}."`,
    subtitle: `Line ${i + 1}.`,
    ...(r.image ? { image_file: r.image } : {}),
    motion_mode: r.motion,
    priority: "NORMAL",
  }));
  fs.writeFileSync(
    path.join(dir, "storyboard.json"),
    JSON.stringify({ video_id: `qa-p4-${id}`, video_title: title, characters: [{ character_id: "max", character_name: "Max" }], scenes }, null, 2),
  );
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
    await prisma.character.upsert({ where: { name: character.name }, create: { ...character, voiceProvider: "mock", enabled: true }, update: {} });
  }
  await setSpendCap(20);

  // Imported pictures for video A (same files in both folders).
  for (const folder of ["previous", "current"]) {
    const dir = path.join(ROOT, folder, "video-a");
    fs.mkdirSync(dir, { recursive: true });
    for (const [i, c] of COLOURS.entries()) {
      await ffmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${c}:s=1080x1920`, "-frames:v", "1", path.join(dir, `a${i + 1}.png`)]);
    }
  }
  const aRows: Row[] = [1, 2, 3, 4, 5].map((n) => ({
    image: `a${n}.png`,
    motion: n === 5 ? "VIDEO_AI" : "LOCAL_MOTION",
    description: `Max in front of coloured card ${n}.`,
  }));
  const bPrev: Row[] = [1, 2, 3, 4, 5].map((n) => ({ motion: "LOCAL_MOTION", description: `Max on a plain studio set, pose ${n}.` }));
  const bNow: Row[] = [
    ...bPrev.slice(0, 3),
    { motion: "LOCAL_MOTION", description: "Max on a plain studio set, pointing left." },
    { motion: "VIDEO_AI", description: "Max on a plain studio set, waving hello." },
  ];
  write("previous", "video-a", "A — 5 ảnh nhập, clip đã có", aRows);
  write("previous", "video-b", "B — 3 ảnh đã có, 2 ảnh mới, 1 clip mới", bPrev);
  write("current", "video-a", "A — 5 ảnh nhập, clip đã có", aRows);
  write("current", "video-b", "B — 3 ảnh đã có, 2 ảnh mới, 1 clip mới", bNow);

  const validated = await validateImport(scanImportSource(path.join(ROOT, "previous")));
  const created = await materialiseImport(validated, { batchName: "QA P4 — lần trước (tạo cache)", maxCostPerVideo: 5, maxCostForBatch: 50 });
  await approveAndRun({ batchId: created.batchId, maxBatch: 5, lowAutoApproved: true, wait: true });
  console.log(`seed xong. Lô trước ${created.batchId} đã chạy (mock). Thư mục để nhập trên UI: ${path.join(ROOT, "current")}`);
}

async function counts(): Promise<void> {
  const projects = await prisma.project.findMany({ orderBy: { createdAt: "asc" }, include: { batch: { select: { name: true } } } });
  for (const p of projects) {
    const jobs = await prisma.providerJob.groupBy({ by: ["kind"], where: { projectId: p.id }, _count: { _all: true } });
    const reused = await prisma.asset.groupBy({ by: ["kind"], where: { projectId: p.id, source: "REUSED" }, _count: { _all: true } });
    console.log(
      JSON.stringify({
        batch: p.batch?.name,
        project: p.title,
        status: p.status,
        posts: Object.fromEntries(jobs.map((j) => [j.kind, j._count._all])),
        reused: Object.fromEntries(reused.map((j) => [j.kind, j._count._all])),
        costEntries: await prisma.costEntry.count({ where: { projectId: p.id } }),
      }),
    );
  }
}

async function main(): Promise<void> {
  guard();
  const cmd = process.argv[2];
  if (cmd === "seed") await seed();
  else if (cmd === "counts") await counts();
  else throw new Error("Dùng: seed | counts");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
