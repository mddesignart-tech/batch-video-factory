import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * Generate real speech for one project's dialogue, one file per line.
 *
 * Deliberately scoped to the lines that already exist: it reads the script out
 * of the database and speaks exactly those, so it cannot invent a line or
 * quietly re-speak one that is already done.
 *
 * Every figure is printed before anything is sent, and a per-run ceiling blocks
 * the call rather than warning about it.
 *
 * Usage:
 *   npx tsx scripts/project-voice.ts --idiom "Spill the beans" --dry-run
 *   npx tsx scripts/project-voice.ts --idiom "Spill the beans" --real --limit 0.01
 */

const prisma = new PrismaClient();

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : "?";
}

async function main(): Promise<void> {
  const idiom = arg("idiom", "Spill the beans");
  const real = flag("real");
  const dryRun = flag("dry-run") || !real;
  const limit = Number(arg("limit", "0.01"));

  process.env.AI_MOCK_MODE = real ? "false" : "true";
  const { resetEnvCache } = await import("../src/lib/env");
  resetEnvCache();

  const { parseDialogueLines } = await import("../src/domain/dialogue-lines");
  const { sceneCharacters } = await import("../src/domain/scene-characters");
  const { getVoiceProvider } = await import("../src/providers/registry");
  const { assertCanSpend, spendStatus } = await import("../src/services/spend-guard");
  const { recordCost } = await import("../src/services/cost-tracker");
  const { normalizeVoiceClip } = await import("../src/media/audio-normalize");
  const { toAbsolute, toRelative, projectSubdir } = await import("../src/lib/paths");

  console.log("\n========== TAO GIONG THAT CHO PROJECT ==========\n");
  console.log(`  Che do: ${real ? "THAT (co tinh tien)" : "MOCK (mien phi)"}\n`);

  const project = await prisma.project.findFirst({
    where: { idiom: { phrase: idiom } },
    include: { idiom: true, scenes: { orderBy: { sceneNumber: "asc" } } },
  });
  if (!project) {
    console.log(`  [DUNG] Khong tim thay du an "${idiom}".\n`);
    process.exitCode = 1;
    return;
  }

  // ---- 1. the exact lines, from the script already in the database --------
  const characters = await prisma.character.findMany();
  const byName = new Map(characters.map((c) => [c.name, c]));

  interface Planned {
    sceneId: string;
    sceneNumber: number;
    sceneDuration: number;
    lineNumber: number;
    speaker: string;
    text: string;
    provider: string;
    model: string;
    voiceId: string;
    instructions: string;
    speed: number;
    gender: "male" | "female";
    accent: "US" | "UK";
    chars: number;
    price: number;
    estimate: number;
  }

  const planned: Planned[] = [];

  for (const scene of project.scenes) {
    if (scene.skipped) continue;
    const speaking = sceneCharacters(scene).speaking;
    for (const line of parseDialogueLines(scene.dialogue, scene.narration, speaking)) {
      const character = byName.get(line.speaker);
      if (!character) {
        console.log(`  [DUNG] Khong tim thay nhan vat "${line.speaker}".\n`);
        process.exitCode = 1;
        return;
      }
      const model = await prisma.modelRegistry.findUnique({
        where: {
          provider_modelId: {
            provider: character.voiceProvider,
            modelId: character.voiceModel,
          },
        },
      });
      if (!model) {
        console.log(
          `  [DUNG] ${character.name} tro toi ${character.voiceProvider}/${character.voiceModel}, ` +
            `khong co trong bang Mo hinh AI.\n`,
        );
        process.exitCode = 1;
        return;
      }
      planned.push({
        sceneId: scene.id,
        sceneNumber: scene.sceneNumber,
        sceneDuration: scene.duration,
        lineNumber: line.lineNumber,
        speaker: line.speaker,
        text: line.text,
        provider: character.voiceProvider,
        model: character.voiceModel,
        voiceId: character.voiceId,
        instructions: character.voiceInstructions,
        speed: character.voiceSpeed,
        gender: character.voiceGender === "female" ? "female" : "male",
        accent: character.voiceAccent === "UK" ? "UK" : "US",
        chars: line.text.length,
        price: model.price,
        estimate: Math.round((line.text.length / 1000) * model.price * 1e6) / 1e6,
      });
    }
  }

  const total = Math.round(planned.reduce((s, p) => s + p.estimate, 0) * 1e6) / 1e6;
  const before = await spendStatus();

  console.log("--- 1. CAC CAU SE DOC ---\n");
  console.log("  Canh Cau Nhan vat Giong    Ky tu  Uoc tinh");
  for (const p of planned) {
    console.log(
      `  ${String(p.sceneNumber).padStart(4)} ${String(p.lineNumber).padStart(3)} ` +
        `${p.speaker.padEnd(9)} ${p.voiceId.padEnd(8)} ${String(p.chars).padStart(5)}  ` +
        `$${p.estimate.toFixed(6)}`,
    );
    console.log(`       "${p.text}"`);
  }

  console.log(`\n  So cau       : ${planned.length}`);
  console.log(`  TONG UOC TINH: $${total.toFixed(6)}`);
  console.log(`  Da chi       : $${before.spent.toFixed(6)} / $${before.cap.toFixed(2)}`);
  console.log(`  Sau khi chay : $${(before.spent + total).toFixed(6)}`);
  console.log(`  Hard limit   : $${limit.toFixed(4)}`);

  if (total > limit) {
    console.log(
      `\n  [DUNG] Uoc tinh $${total.toFixed(6)} vuot hard limit $${limit.toFixed(4)}. KHONG goi API.\n`,
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

  // ---- 2. speak each line, then trim and level it ------------------------
  console.log("\n--- 2. DANG TAO ---\n");
  let spent = 0;

  for (const p of planned) {
    const relPath = path.join(
      projectSubdir(project.id, "audio"),
      `s${p.sceneNumber}-l${p.lineNumber}-${p.speaker.toLowerCase()}.wav`,
    );
    const outPath = toAbsolute(relPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // The provider refuses to overwrite, which is right for a paid call; this
    // script is re-runnable, so an old file is cleared deliberately first.
    if (fs.existsSync(outPath)) fs.rmSync(outPath);

    // The row exists BEFORE the call, so a crash leaves a trace of the attempt.
    const row = await prisma.dialogueLine.upsert({
      where: { sceneId_lineNumber: { sceneId: p.sceneId, lineNumber: p.lineNumber } },
      create: {
        sceneId: p.sceneId,
        characterId: byName.get(p.speaker)?.id ?? null,
        lineNumber: p.lineNumber,
        text: p.text,
        provider: p.provider,
        model: p.model,
        voiceId: p.voiceId,
        instructions: p.instructions,
        speed: p.speed,
        estimatedCost: p.estimate,
        status: "processing",
      },
      update: {
        characterId: byName.get(p.speaker)?.id ?? null,
        text: p.text,
        provider: p.provider,
        model: p.model,
        voiceId: p.voiceId,
        instructions: p.instructions,
        speed: p.speed,
        estimatedCost: p.estimate,
        status: "processing",
        error: "",
      },
    });

    try {
      await assertCanSpend({
        provider: p.provider,
        model: p.model,
        estimatedCost: p.estimate,
      });

      const provider = await getVoiceProvider(p.provider, p.model);
      const job = await provider.createVoice({
        projectId: project.id,
        sceneId: p.sceneId,
        model: p.model,
        text: p.text,
        voiceId: p.voiceId,
        instructions: p.instructions,
        accent: p.accent,
        gender: p.gender,
        speed: p.speed,
        targetDuration: p.sceneDuration,
        outputPath: outPath,
      });
      const asset = await provider.downloadResult(job.externalId);

      // Trim, level, and measure the file that will actually play.
      const levelled = await normalizeVoiceClip(asset.filePath, asset.filePath);

      await recordCost({
        projectId: project.id,
        sceneId: p.sceneId,
        category: "voice",
        provider: p.provider,
        model: p.model,
        amount: asset.actualCost,
        note: `canh ${p.sceneNumber} cau ${p.lineNumber} (${p.speaker})`,
      });
      spent += asset.actualCost;

      await prisma.dialogueLine.update({
        where: { id: row.id },
        data: {
          actualCost: asset.actualCost,
          durationSec: levelled.durationSec,
          outputPath: toRelative(asset.filePath),
          status: "completed",
          pauseAfterMs: null,
        },
      });

      console.log(
        `  canh ${p.sceneNumber} cau ${p.lineNumber} ${p.speaker.padEnd(4)} ` +
          `${fmt(levelled.durationSec)}s  ` +
          `${fmt(levelled.after.integratedLufs)} LUFS  ` +
          `TP ${fmt(levelled.after.truePeakDb)}  ` +
          `cat ${fmt(levelled.trimmedSeconds)}s  ` +
          `$${asset.actualCost.toFixed(6)}`,
      );
    } catch (err) {
      await prisma.dialogueLine.update({
        where: { id: row.id },
        data: {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        },
      });
      console.log(
        `  canh ${p.sceneNumber} cau ${p.lineNumber}: THAT BAI - ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
      return;
    }
  }

  // ---- 3. how each scene's speech compares with its planned length --------
  //
  // Reported, NOT acted on. Extending a scene, shortening a pause or rewriting
  // a line are all editorial decisions, and a script that quietly picks one
  // hides the choice from the person who should be making it.
  console.log("\n--- 3. THOI LUONG: TIENG so voi HINH ---\n");
  console.log("  Canh  Hinh    Tieng   Chenh   Ket luan");

  const lines = await prisma.dialogueLine.findMany({
    where: { scene: { projectId: project.id } },
    orderBy: [{ scene: { sceneNumber: "asc" } }, { lineNumber: "asc" }],
    include: { scene: { select: { sceneNumber: true, duration: true } } },
  });

  const bySceneNumber = new Map<number, { duration: number; speech: number; count: number }>();
  for (const l of lines) {
    const key = l.scene.sceneNumber;
    const current = bySceneNumber.get(key) ?? {
      duration: l.scene.duration,
      speech: 0,
      count: 0,
    };
    // Pauses between lines count towards the scene's speech length.
    current.speech += l.durationSec + (current.count > 0 ? 0.28 : 0);
    current.count += 1;
    bySceneNumber.set(key, current);
  }

  let over = 0;
  for (const [sceneNumber, v] of [...bySceneNumber.entries()].sort((a, b) => a[0] - b[0])) {
    const diff = v.speech - v.duration;
    const verdict =
      diff <= 0
        ? "vua"
        : diff <= 1
          ? "hoi dai - chinh nhip hoac toc do doc la du"
          : "DAI DANG KE - nen keo dai canh hoac rut gon loi thoai";
    if (diff > 0) over += 1;
    console.log(
      `  ${String(sceneNumber).padStart(4)}  ${fmt(v.duration).padStart(5)}s ` +
        `${fmt(v.speech).padStart(6)}s ${(diff >= 0 ? "+" : "") + fmt(diff)}s  ${verdict}`,
    );
  }

  const after = await spendStatus();
  console.log("\n--- 4. CHI PHI ---\n");
  console.log(`  Lan chay nay : $${spent.toFixed(6)}`);
  console.log(`  Tong da chi  : $${after.spent.toFixed(6)} / $${after.cap.toFixed(2)}`);
  console.log(
    `\n  ${over} canh co tieng dai hon hinh. KHONG tu dong sua - ` +
      `xem bang tren roi quyet.\n`,
  );
}

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
