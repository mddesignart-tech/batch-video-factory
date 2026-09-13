import { PrismaClient } from "@prisma/client";

/**
 * Compare every video model on the same scene, without calling anything.
 *
 * The cost column is produced by each provider's own `estimateCost`, not by
 * multiplying price by the requested duration. That difference is the whole
 * point: Runway bills a 4-second scene as 5 seconds and Veo may bill it as 8,
 * so a naive "price x seconds" table would understate two of the three
 * candidates by 25% and 100%.
 *
 * Usage: npx tsx scripts/video-benchmark.ts --idiom "Spill the beans" --scene 4
 */

const prisma = new PrismaClient();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const idiom = arg("idiom", "Spill the beans");
  const sceneNumber = Number(arg("scene", "4"));

  // Mock mode off so real configs are built, but nothing is ever called: this
  // script only asks providers what they WOULD charge.
  process.env.AI_MOCK_MODE = "false";
  const { resetEnvCache } = await import("../src/lib/env");
  resetEnvCache();

  const { buildVideoConfig, splitModelSize } = await import(
    "../src/providers/video-config"
  );
  const { hasApiKey } = await import("../src/providers/provider-credentials");
  const { spendStatus } = await import("../src/services/spend-guard");

  const project = await prisma.project.findFirst({
    where: { idiom: { phrase: idiom } },
    include: { idiom: true, scenes: { orderBy: { sceneNumber: "asc" } } },
  });
  const scene = project?.scenes.find((s) => s.sceneNumber === sceneNumber);
  if (!project || !scene) {
    console.log(`Khong tim thay ${idiom} canh ${sceneNumber}.`);
    process.exitCode = 1;
    return;
  }

  const models = await prisma.modelRegistry.findMany({
    where: { type: "video", provider: { not: "mock" } },
    orderBy: [{ price: "asc" }],
  });

  console.log(`\n========== SO SANH NHA CUNG CAP VIDEO ==========\n`);
  console.log(`  Benchmark : ${project.idiom.phrase} canh ${sceneNumber}`);
  console.log(`  Thoi luong: ${scene.duration}s`);
  console.log(`  Keyframe  : ${scene.imagePath ? "co" : "KHONG CO"}`);
  console.log(`  (Script nay khong goi API, khong tieu tien.)\n`);

  const rows: string[][] = [];

  for (const model of models) {
    const { size } = splitModelSize(model.modelId);
    const keyed = await hasApiKey(model.provider);

    let cost = "?";
    let detail = "";
    try {
      // requireEnabled false: a disabled model must still be quotable, or the
      // comparison could only ever include what is already switched on.
      const config = await buildVideoConfig(model.provider, model.modelId, false);
      const { getVideoProviderForConfig } = await import("./video-benchmark-helpers");
      const provider = await getVideoProviderForConfig(model.provider, config);
      const estimate = await provider.estimateCost({
        projectId: project.id,
        sceneId: scene.id,
        model: model.modelId,
        prompt: scene.videoPrompt,
        negativePrompt: "",
        durationSeconds: scene.duration,
        width: 720,
        height: 1280,
        fps: 30,
        referenceImagePath: scene.imagePath ?? undefined,
        outputPath: "benchmark.mp4",
      });
      cost = `$${estimate.amount.toFixed(4)}`;
      detail = estimate.detail;
    } catch (err) {
      cost = "loi";
      detail = err instanceof Error ? err.message.slice(0, 70) : "";
    }

    rows.push([
      model.provider,
      model.modelId.replace(/:.*$/, ""),
      size,
      cost,
      model.supportsImageToVideo ? "co" : "khong",
      size.split("x")[0] && size.split("x")[1] &&
      Number(size.split("x")[0]) < Number(size.split("x")[1])
        ? "co"
        : "khong",
      String(model.consistencyRating),
      String(model.speedRating),
      keyed ? "CO KEY" : "thieu key",
      model.enabled ? "bat" : "tat",
    ]);

    if (detail) rows.push(["", `  ${detail}`, "", "", "", "", "", "", "", ""]);
  }

  const header = [
    "Provider",
    "Model",
    "Size",
    "Gia 4s",
    "i2v",
    "9:16",
    "NhatQuan",
    "TocDo",
    "Key",
    "TrangThai",
  ];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ");

  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));

  const status = await spendStatus();
  console.log(`\n  Da chi: $${status.spent.toFixed(6)} / $${status.cap.toFixed(2)}`);
  console.log(`  Con lai: $${(status.cap - status.spent).toFixed(6)}\n`);
}

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
