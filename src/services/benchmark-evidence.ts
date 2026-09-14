import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import type { Complexity } from "@/domain/enums";
import { checkSuitability } from "@/domain/video-suitability";

/**
 * Recorded benchmark runs, and the check that routing rules agree with them.
 *
 * The rules in domain/video-suitability are INFERRED from runs like these. An
 * inference that contradicts the evidence it came from is a bug, and it has
 * already happened twice in this project:
 *
 *   - gen4_turbo's measured limits were applied to gen4.5, a sibling model
 *     nothing had been measured about, and the router blocked a benchmark that
 *     went on to succeed.
 *   - the classifier scored scene 5 as MEDIUM on a shot Runway had already
 *     animated successfully.
 *
 * Both were caught by a person remembering a result, which is not a mechanism.
 * `findContradictions` is the mechanism.
 */

export interface BenchmarkScores {
  maxIdentity?: number;
  leoIdentity?: number;
  miaIdentity?: number;
  motion?: number;
  smallObjectConsistency?: number;
  physics?: number;
  artifacts?: number;
  camera?: number;
  composition?: number;
  humorReadability?: number;
}

export interface RecordBenchmarkInput {
  provider: string;
  model: string;
  taskId?: string | null;
  projectId?: string | null;
  sceneNumber: number;
  complexity: Complexity;
  complexityScore?: number;
  characterCount?: number;
  promptSent: string;
  durationRequested: number;
  durationSent: number;
  keyframePath?: string;
  outcome: "succeeded" | "failed";
  failureCode?: string;
  credits?: number;
  actualCost: number;
  generationMs?: number;
  outputPath?: string;
  scores?: BenchmarkScores;
  notes?: string;
}

export async function recordBenchmark(input: RecordBenchmarkInput): Promise<void> {
  await prisma.videoBenchmark.create({
    data: {
      provider: input.provider,
      model: input.model,
      taskId: input.taskId ?? null,
      projectId: input.projectId ?? null,
      sceneNumber: input.sceneNumber,
      complexity: input.complexity,
      complexityScore: input.complexityScore ?? 0,
      characterCount: input.characterCount ?? 0,
      // The prompt as SENT, after any vendor-specific fitting. Storing the one
      // we meant to send would make the record describe a run that never
      // happened - the same mistake `sentRequest` exists to avoid.
      promptSent: input.promptSent.slice(0, 4000),
      durationRequested: input.durationRequested,
      durationSent: input.durationSent,
      keyframePath: input.keyframePath ?? "",
      outcome: input.outcome,
      failureCode: input.failureCode ?? "",
      credits: input.credits ?? 0,
      actualCost: input.actualCost,
      generationMs: input.generationMs ?? 0,
      outputPath: input.outputPath ?? "",
      scoresJson: JSON.stringify(input.scores ?? {}),
      notes: input.notes ?? "",
    },
  });
  await logger.info({
    event: "benchmark.recorded",
    provider: input.provider,
    model: input.model,
    message:
      `Ghi nhận benchmark: cảnh ${input.sceneNumber} (${input.complexity}), ` +
      `${input.outcome}, $${input.actualCost.toFixed(4)}.`,
  });
}

export interface Contradiction {
  provider: string;
  model: string;
  sceneNumber: number;
  complexity: string;
  kind: "blocked_but_succeeded" | "allowed_but_failed";
  message: string;
}

/**
 * Where the routing rules disagree with a run that was actually paid for.
 *
 * Two directions, and they are not equally bad:
 *
 *   blocked_but_succeeded - the rules refuse work this model has DONE. Costs
 *                           nothing but wastes the model, and is how a
 *                           benchmark gets blocked before it can run.
 *   allowed_but_failed    - the rules offer work this model has REFUSED. This
 *                           one spends money to rediscover a known failure.
 *
 * Both are reported. Neither is auto-corrected: the rules encode judgement
 * about what a result MEANS, and a single run is not always the whole story -
 * a model that failed once may have hit a transient fault. The point is that
 * nobody has to notice the disagreement by memory.
 */
export async function findContradictions(): Promise<Contradiction[]> {
  const runs = await prisma.videoBenchmark.findMany({
    orderBy: { createdAt: "asc" },
  });
  const found: Contradiction[] = [];

  for (const run of runs) {
    const verdict = checkSuitability({
      provider: run.provider,
      model: run.model,
      complexity: run.complexity as Complexity,
      characterCount: Math.max(1, run.characterCount),
      // Scene flags are deliberately omitted: a flag records THIS scene's
      // history, and re-applying it here would make every failed run look like
      // a contradiction with itself.
    });

    if (run.outcome === "succeeded" && !verdict.allowed) {
      found.push({
        provider: run.provider,
        model: run.model,
        sceneNumber: run.sceneNumber,
        complexity: run.complexity,
        kind: "blocked_but_succeeded",
        message:
          `${run.model} ĐÃ LÀM ĐƯỢC cảnh ${run.sceneNumber} (${run.complexity}) ` +
          `với giá $${run.actualCost.toFixed(4)}, nhưng luật định tuyến đang chặn: ` +
          `"${verdict.reason}". Luật mâu thuẫn với kết quả đã trả tiền.`,
      });
    }

    if (run.outcome === "failed" && verdict.allowed) {
      found.push({
        provider: run.provider,
        model: run.model,
        sceneNumber: run.sceneNumber,
        complexity: run.complexity,
        kind: "allowed_but_failed",
        message:
          `${run.model} ĐÃ HỎNG ở cảnh ${run.sceneNumber} (${run.complexity})` +
          (run.failureCode ? ` với mã ${run.failureCode}` : "") +
          `, nhưng luật định tuyến vẫn cho phép. Sẽ tốn tiền để học lại điều đã biết.`,
      });
    }
  }

  return found;
}

/** Every run for one model, newest first, for a report or a decision. */
export async function benchmarksFor(provider: string, model?: string) {
  return prisma.videoBenchmark.findMany({
    where: { provider, ...(model ? { model } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

/** Mean of the scores that were actually given, ignoring the ones left blank. */
export function averageScore(scores: BenchmarkScores): number {
  const values = Object.values(scores).filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (values.length === 0) return 0;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

/** Mean identity across whichever characters were scored. */
export function averageIdentity(scores: BenchmarkScores): number {
  return averageScore({
    maxIdentity: scores.maxIdentity,
    leoIdentity: scores.leoIdentity,
    miaIdentity: scores.miaIdentity,
  });
}
