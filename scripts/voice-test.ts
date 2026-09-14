import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * Three short lines, one per character, to hear whether the voices work.
 *
 * Deliberately NOT a whole project: the question is whether Max, Leo and Mia
 * sound like three different people with the right delivery, and three
 * sentences answer that as well as sixty would, for a hundredth of the cost.
 *
 * Like every paid script here it prints every figure first and blocks on a
 * per-run ceiling before anything is sent.
 *
 * Usage:
 *   npx tsx scripts/voice-test.ts --dry-run
 *   npx tsx scripts/voice-test.ts --real --limit 0.20
 */

const prisma = new PrismaClient();

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

/**
 * One line each, chosen to exercise what the videos actually need: an idiom
 * spoken naturally, a clear explanation, and a line with attitude.
 */
const LINES: { character: string; text: string }[] = [
  {
    character: "Max",
    text: "Wait, you want me to spill the beans? I already spilled the whole bag!",
  },
  {
    character: "Leo",
    text: "Spill the beans means to tell a secret. It has nothing to do with actual beans.",
  },
  {
    character: "Mia",
    text: "Oh brilliant, Max. Now the secret AND the beans are all over the floor.",
  },
];

async function main(): Promise<void> {
  const real = flag("real");
  const dryRun = flag("dry-run") || !real;
  const limit = Number(arg("limit", "0.20"));

  process.env.AI_MOCK_MODE = real ? "false" : "true";
  const { resetEnvCache } = await import("../src/lib/env");
  resetEnvCache();

  const { getVoiceProvider } = await import("../src/providers/registry");
  const { spendStatus, assertCanSpend } = await import("../src/services/spend-guard");
  const { recordCost } = await import("../src/services/cost-tracker");
  const { toAbsolute } = await import("../src/lib/paths");
  const { probeDuration } = await import("../src/media/ffmpeg");

  console.log("\n========== TEST GIONG NOI ==========\n");
  console.log(`  Che do        : ${real ? "THAT (co tinh tien)" : "MOCK (mien phi)"}`);

  // ---- resolve every character's settings before spending anything -------
  const rows: {
    name: string;
    text: string;
    provider: string;
    model: string;
    voiceId: string;
    instructions: string;
    speed: number;
    chars: number;
    price: number;
    estimate: number;
  }[] = [];

  for (const line of LINES) {
    const ch = await prisma.character.findFirst({ where: { name: line.character } });
    if (!ch) {
      console.log(`\n  [DUNG] Khong tim thay nhan vat ${line.character}.\n`);
      process.exitCode = 1;
      return;
    }
    const model = await prisma.modelRegistry.findUnique({
      where: { provider_modelId: { provider: ch.voiceProvider, modelId: ch.voiceModel } },
    });
    if (!model) {
      console.log(
        `\n  [DUNG] ${line.character} tro toi ${ch.voiceProvider}/${ch.voiceModel}, ` +
          `khong co trong bang Mo hinh AI.\n`,
      );
      process.exitCode = 1;
      return;
    }
    const chars = line.text.length;
    rows.push({
      name: ch.name,
      text: line.text,
      provider: ch.voiceProvider,
      model: ch.voiceModel,
      voiceId: ch.voiceId,
      instructions: ch.voiceInstructions,
      speed: ch.voiceSpeed,
      chars,
      price: model.price,
      estimate: Math.round((chars / 1000) * model.price * 1e6) / 1e6,
    });
  }

  const total = Math.round(rows.reduce((s, r) => s + r.estimate, 0) * 1e6) / 1e6;
  const before = await spendStatus();

  for (const r of rows) {
    console.log(`\n  ---- ${r.name} ----`);
    console.log(`    Provider    : ${r.provider}`);
    console.log(`    Model       : ${r.model}`);
    console.log(`    Voice       : ${r.voiceId}`);
    console.log(`    Speed       : ${r.speed}`);
    console.log(`    Instructions: ${r.instructions.slice(0, 120)}${r.instructions.length > 120 ? "..." : ""}`);
    console.log(`    Cau thoai   : "${r.text}"`);
    console.log(`    So ky tu    : ${r.chars}`);
    console.log(`    Uoc tinh    : $${r.estimate.toFixed(6)}  (${r.chars}/1000 x $${r.price})`);
  }

  console.log(`\n  TONG UOC TINH : $${total.toFixed(6)}`);
  console.log(`  Da chi        : $${before.spent.toFixed(6)} / $${before.cap.toFixed(2)}`);
  console.log(`  Sau khi chay  : $${(before.spent + total).toFixed(6)}`);
  console.log(`  Hard limit    : $${limit.toFixed(2)}`);

  if (total > limit) {
    console.log(
      `\n  [DUNG] Uoc tinh $${total.toFixed(6)} vuot hard limit $${limit.toFixed(2)}. KHONG goi API.\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (before.spent + total > before.cap) {
    console.log("\n  [DUNG] Uoc tinh vuot han muc tong cua ung dung.\n");
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log("\n  --dry-run: khong goi API.\n");
    return;
  }

  // ---- generate ----------------------------------------------------------
  const outDir = toAbsolute(path.join("voice-test"));
  fs.mkdirSync(outDir, { recursive: true });

  console.log("\n---------- DANG TAO ----------");
  let spent = 0;
  for (const r of rows) {
    const outPath = path.join(outDir, `${r.name.toLowerCase()}-${Date.now()}.wav`);
    const started = Date.now();
    try {
      await assertCanSpend({
        provider: r.provider,
        model: r.model,
        estimatedCost: r.estimate,
      });

      const provider = await getVoiceProvider(r.provider, r.model);
      const job = await provider.createVoice({
        projectId: "voice-test",
        sceneId: "voice-test",
        model: r.model,
        text: r.text,
        voiceId: r.voiceId,
        instructions: r.instructions,
        accent: "US",
        gender: r.name === "Mia" ? "female" : "male",
        speed: r.speed,
        targetDuration: 5,
        outputPath: outPath,
      });
      const asset = await provider.downloadResult(job.externalId);

      // Measured, not promised.
      let seconds = 0;
      try {
        seconds = await probeDuration(asset.filePath);
      } catch {
        seconds = 0;
      }

      // Through the ledger like the app, not around it. A benchmark that skips
      // the books is how a cap stops matching reality.
      await recordCost({
        category: "voice",
        provider: r.provider,
        model: r.model,
        amount: asset.actualCost,
        note: `voice-test ${r.name}`,
      });
      spent += asset.actualCost;

      console.log(`\n  ${r.name}: OK sau ${((Date.now() - started) / 1000).toFixed(1)}s`);
      console.log(`    Tep       : ${asset.filePath}`);
      console.log(`    Dung luong: ${(asset.bytes / 1024).toFixed(1)} KB`);
      console.log(`    Thoi luong: ${seconds.toFixed(2)}s (do bang ffprobe)`);
      console.log(`    Chi phi   : $${asset.actualCost.toFixed(6)}`);
      console.log(`    Toc do doc: ${seconds > 0 ? (r.text.split(/\s+/).length / (seconds / 60)).toFixed(0) : "?"} tu/phut`);
    } catch (err) {
      console.log(`\n  ${r.name}: THAT BAI - ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }

  const after = await spendStatus();
  console.log("\n---------- DA GHI NHAN ----------");
  console.log(`  Lan chay nay tieu: $${spent.toFixed(6)}`);
  console.log(`  Tong da chi      : $${after.spent.toFixed(6)} / $${after.cap.toFixed(2)}`);
  console.log(`  Tep am thanh o   : ${outDir}`);
  console.log("");
}

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
