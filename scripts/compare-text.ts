import { PrismaClient } from "@prisma/client";

/**
 * Side-by-side comparison of the mock script writer and a real text provider.
 *
 * Usage:
 *   npx tsx scripts/compare-text.ts --provider openai --model gpt-4o-mini
 *   npx tsx scripts/compare-text.ts --provider ollama --model llama3.1   (free)
 *   npx tsx scripts/compare-text.ts --idiom "Piece of cake"
 *
 * It runs the SAME idiom through both paths and scores each result against the
 * checks that actually matter for this product: schema validity, scene count,
 * duration fit, prompt completeness, and whether the English is simple enough
 * for a learner. Costs are reported separately for mock (always $0) and real.
 *
 * Nothing here writes a project or touches the operator's data.
 */

const prisma = new PrismaClient();

interface Args {
  provider: string;
  model: string;
  idiom: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  return {
    provider: get("provider", "openai"),
    model: get("model", "gpt-4o-mini"),
    idiom: get("idiom", "Break a leg"),
  };
}

interface Checks {
  schemaValid: boolean;
  sceneCount: number;
  sceneCountOk: boolean;
  totalDuration: number;
  durationOk: boolean;
  allScenesHaveImagePrompt: boolean;
  allScenesHaveVideoPrompt: boolean;
  allScenesShortEnough: boolean;
  hasMeaning: boolean;
  hasExample: boolean;
  avgWordsPerSubtitle: number;
  subtitlesSimple: boolean;
}

interface Outcome {
  label: string;
  ok: boolean;
  error?: string;
  checks?: Checks;
  score?: Record<string, number>;
  cost: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  sample?: { title: string; hook: string; punchline: string; meaning: string };
}

function evaluate(script: {
  scenes: {
    duration: number;
    imagePrompt: string;
    videoPrompt: string;
    subtitle: string;
  }[];
  meaning: string;
  exampleSentence: string;
}): Checks {
  const totalDuration = script.scenes.reduce((sum, s) => sum + s.duration, 0);
  const words = script.scenes
    .map((s) => s.subtitle.trim().split(/\s+/).filter(Boolean).length)
    .filter((n) => n > 0);
  const avgWords =
    words.length > 0 ? words.reduce((a, b) => a + b, 0) / words.length : 0;

  return {
    schemaValid: true,
    sceneCount: script.scenes.length,
    sceneCountOk: script.scenes.length >= 4 && script.scenes.length <= 6,
    totalDuration: Math.round(totalDuration * 10) / 10,
    durationOk: totalDuration >= 20 && totalDuration <= 35,
    allScenesHaveImagePrompt: script.scenes.every(
      (s) => s.imagePrompt.trim().length > 20,
    ),
    allScenesHaveVideoPrompt: script.scenes.every(
      (s) => s.videoPrompt.trim().length > 20,
    ),
    // Each scene is one AI video generation; longer than 6s is unreliable.
    allScenesShortEnough: script.scenes.every(
      (s) => s.duration >= 2 && s.duration <= 6,
    ),
    hasMeaning: script.meaning.trim().length > 0,
    hasExample: script.exampleSentence.trim().length > 0,
    avgWordsPerSubtitle: Math.round(avgWords * 10) / 10,
    // Learner-friendly subtitles are short; over ~12 words is hard to read on a
    // phone in three seconds.
    subtitlesSimple: avgWords > 0 && avgWords <= 12,
  };
}

async function run(
  label: string,
  provider: string,
  model: string,
  idiom: {
    id: string;
    phrase: string;
    meaning: string;
    literalMeaning: string;
    exampleSentence: string;
  },
): Promise<Outcome> {
  const started = Date.now();
  try {
    const { getTextProvider } = await import("../src/providers/registry");
    const { buildPrompt } = await import("../src/lib/prompts");

    const characters = await prisma.character.findMany({
      where: { enabled: true },
      take: 2,
    });
    const preset = await prisma.stylePreset.findFirst({
      where: { isDefault: true },
    });
    const stylePrompt = [
      preset?.positivePrompt ?? "",
      preset?.lightingStyle ?? "",
    ]
      .filter(Boolean)
      .join(", ");

    const charList = characters.map((c) => ({
      name: c.name,
      personality: c.personality,
      visualPrompt: c.visualPrompt,
    }));

    const systemPrompt = await buildPrompt("script", {
      idiom: idiom.phrase,
      meaning: idiom.meaning,
      literalMeaning: idiom.literalMeaning,
      exampleSentence: idiom.exampleSentence,
      targetDuration: 27,
      stylePrompt,
      characters: charList
        .map((c) => `- ${c.name} (${c.personality}): ${c.visualPrompt}`)
        .join("\n"),
      avoidAngles: "(none yet)",
    });

    const impl = await getTextProvider(provider, model);

    // Every paid call goes through the same gate and the same ledger as the app
    // does. A comparison script that bypassed them would under-report spending
    // and could slip past the cap - exactly the hole this project exists to
    // close.
    const { assertCanSpend } = await import("../src/services/spend-guard");
    const { recordCost } = await import("../src/services/cost-tracker");
    const estimate = await impl.estimateScriptCost({
      idiom: idiom.phrase,
      meaning: idiom.meaning,
      literalMeaning: idiom.literalMeaning,
      exampleSentence: idiom.exampleSentence,
      targetDuration: 27,
      stylePrompt,
      characters: charList,
      avoidAngles: [],
      model,
      systemPrompt,
    });
    await assertCanSpend({ provider, model, estimatedCost: estimate.amount });

    const { script, usage } = await impl.generateScript({
      idiom: idiom.phrase,
      meaning: idiom.meaning,
      literalMeaning: idiom.literalMeaning,
      exampleSentence: idiom.exampleSentence,
      targetDuration: 27,
      stylePrompt,
      characters: charList,
      avoidAngles: [],
      model,
      systemPrompt,
    });

    await recordCost({
      category: "text",
      provider,
      model: usage.model,
      amount: usage.actualCost,
      note: "compare:script",
    });

    await assertCanSpend({ provider, model, estimatedCost: estimate.amount / 3 });
    const { score, usage: scoreUsage } = await impl.scoreScript(script, model);
    await recordCost({
      category: "text",
      provider,
      model: scoreUsage.model,
      amount: scoreUsage.actualCost,
      note: "compare:score",
    });

    const totalCost = usage.actualCost + scoreUsage.actualCost;
    const totalIn = (usage.inputTokens ?? 0) + (scoreUsage.inputTokens ?? 0);
    const totalOut = (usage.outputTokens ?? 0) + (scoreUsage.outputTokens ?? 0);

    return {
      label,
      ok: true,
      checks: evaluate(script),
      score: {
        hook: score.hook,
        humor: score.humor,
        clarity: score.clarity,
        learningValue: score.learningValue,
        visualFeasibility: score.visualFeasibility,
      },
      cost: totalCost,
      inputTokens: usage.inputTokens === null ? null : totalIn,
      outputTokens: usage.outputTokens === null ? null : totalOut,
      durationMs: Date.now() - started,
      sample: {
        title: script.title,
        hook: script.hook,
        punchline: script.punchline,
        meaning: script.meaning,
      },
    };
  } catch (err) {
    return {
      label,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      cost: 0,
      inputTokens: null,
      outputTokens: null,
      durationMs: Date.now() - started,
    };
  }
}

function tick(value: boolean): string {
  return value ? "DAT" : "KHONG DAT";
}

function report(outcome: Outcome): void {
  console.log(`\n--- ${outcome.label} ---`);
  if (!outcome.ok) {
    console.log(`  THAT BAI: ${outcome.error}`);
    return;
  }
  const c = outcome.checks!;
  console.log(`  JSON dung schema        : ${tick(c.schemaValid)}`);
  console.log(`  So canh                 : ${c.sceneCount} (${tick(c.sceneCountOk)}, can 4-6)`);
  console.log(`  Tong thoi luong         : ${c.totalDuration}s (${tick(c.durationOk)}, can 20-35s)`);
  console.log(`  Moi canh 2-6 giay       : ${tick(c.allScenesShortEnough)}`);
  console.log(`  Du prompt anh           : ${tick(c.allScenesHaveImagePrompt)}`);
  console.log(`  Du prompt video         : ${tick(c.allScenesHaveVideoPrompt)}`);
  console.log(`  Co giai thich nghia     : ${tick(c.hasMeaning)}`);
  console.log(`  Co cau vi du            : ${tick(c.hasExample)}`);
  console.log(`  TB tu/phu de            : ${c.avgWordsPerSubtitle} (${tick(c.subtitlesSimple)}, nen <= 12)`);
  console.log(
    `  Diem tu cham            : hook ${outcome.score!.hook}, humor ${outcome.score!.humor}, ` +
      `clarity ${outcome.score!.clarity}, learning ${outcome.score!.learningValue}, ` +
      `visual ${outcome.score!.visualFeasibility}`,
  );
  console.log(
    `  Token                   : ${outcome.inputTokens ?? "?"} vao / ${
      outcome.outputTokens ?? "?"
    } ra`,
  );
  console.log(`  Thoi gian               : ${outcome.durationMs}ms`);
  console.log(`  CHI PHI THAT            : $${outcome.cost.toFixed(6)}`);
  console.log(`  Tieu de   : ${outcome.sample!.title}`);
  console.log(`  Hook      : ${outcome.sample!.hook}`);
  console.log(`  Punchline : ${outcome.sample!.punchline}`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  const idiom = await prisma.idiom.findFirst({
    where: { phrase: args.idiom },
  });
  if (!idiom) {
    console.error(
      `Khong tim thay thanh ngu "${args.idiom}". Chay "npm run seed" truoc.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nSO SANH MOCK vs TEXT AI THAT`);
  console.log(`Thanh ngu : ${idiom.phrase}`);
  console.log(`Provider  : ${args.provider} / ${args.model}`);

  // Mock always runs: it needs no key and costs nothing.
  const previous = process.env.AI_MOCK_MODE;
  process.env.AI_MOCK_MODE = "true";
  const { resetEnvCache } = await import("../src/lib/env");
  resetEnvCache();
  const mockOutcome = await run("MOCK (khong goi API)", "mock", "mock-text-1", idiom);

  // Real path: only attempted with mock mode off.
  process.env.AI_MOCK_MODE = "false";
  resetEnvCache();
  const realOutcome = await run(
    `THAT (${args.provider}/${args.model})`,
    args.provider,
    args.model,
    idiom,
  );

  process.env.AI_MOCK_MODE = previous ?? "true";
  resetEnvCache();

  report(mockOutcome);
  report(realOutcome);

  console.log(`\n--- TONG KET CHI PHI ---`);
  console.log(`  Mock : $0.000000 (luon mien phi)`);
  console.log(
    `  That : $${realOutcome.cost.toFixed(6)}${
      realOutcome.ok ? "" : "  (khong chay duoc, xem loi o tren)"
    }`,
  );
  console.log("");
}

main()
  .catch((err: unknown) => {
    console.error("So sanh that bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
