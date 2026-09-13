import { z } from "zod";
import {
  ScriptSchema,
  scriptNeedsRewrite,
  type ScriptDoc,
  type ScriptScore,
} from "@/domain/script";
import { sha256 } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { buildPrompt } from "@/lib/prompts";
import { getTextProvider } from "@/providers/registry";
import type { ProviderUsage, ScriptRequest } from "@/providers/types";
import { assertCanSpend } from "./spend-guard";
import { recordCost } from "./cost-tracker";
import { assignSpendPriority, classifyScene } from "./complexity";

/**
 * Script generation, validation and duplicate prevention.
 *
 * A text model returning slightly-wrong JSON is the single most common failure
 * in a pipeline like this, so the contract here is strict: parse, and if that
 * fails, repair the common damage and parse again. If it still fails we throw.
 * We never write a half-valid script to the database and discover it three
 * stages later.
 */

export class ScriptError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ScriptError";
  }
}

/**
 * Repair the malformed-JSON patterns models actually emit: fenced code blocks,
 * a prose preamble before the object, trailing commas, and smart quotes.
 * Deliberately conservative - it fixes wrapping, never invents content.
 */
export function repairJson(raw: string): string {
  let text = raw.trim();

  // ```json ... ``` fences
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text);
  if (fence?.[1]) text = fence[1].trim();

  // Prose before/after the object
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace > 0 || (lastBrace >= 0 && lastBrace < text.length - 1)) {
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1);
    }
  }

  // Smart quotes around keys/values
  text = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  // Trailing commas before a closing brace or bracket
  text = text.replace(/,(\s*[}\]])/g, "$1");

  return text;
}

export function parseScript(raw: string | unknown): ScriptDoc {
  if (typeof raw !== "string") {
    const result = ScriptSchema.safeParse(raw);
    if (result.success) return result.data;
    throw new ScriptError(
      `Kịch bản trả về không hợp lệ: ${formatZod(result.error)}`,
    );
  }

  const attempt = (text: string) => {
    const parsed: unknown = JSON.parse(text);
    return ScriptSchema.parse(parsed);
  };

  try {
    return attempt(raw);
  } catch (first) {
    try {
      return attempt(repairJson(raw));
    } catch (second) {
      throw new ScriptError(
        `Không thể đọc kịch bản JSON từ nhà cung cấp. ${describe(second)}`,
        { first, second },
      );
    }
  }
}

function formatZod(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
    .join("; ");
}

function describe(err: unknown): string {
  if (err instanceof z.ZodError) return formatZod(err);
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------- duplicate prevention ---

/**
 * A stable fingerprint of the joke, not of the wording. Two scripts that make
 * the same gag about the same idiom collapse to the same key even if the
 * sentences differ.
 */
export function angleKeyFor(script: ScriptDoc): string {
  const explicit = script.angleKey.trim();
  if (explicit) return `${normalise(script.idiom)}::${explicit}`;
  return `${normalise(script.idiom)}::${normalise(script.punchline).slice(0, 60)}`;
}

export function scriptHashFor(script: ScriptDoc): string {
  return sha256(
    [
      normalise(script.idiom),
      normalise(script.hook),
      normalise(script.punchline),
      script.scenes.map((s) => normalise(s.visualDescription)).join("|"),
    ].join("::"),
  );
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface DuplicateCheck {
  isDuplicate: boolean;
  reason: string;
  usedAngles: string[];
}

export async function checkDuplicate(
  idiomId: string,
  script: ScriptDoc,
): Promise<DuplicateCheck> {
  const history = await prisma.conceptHistory.findMany({
    where: { idiomId },
    select: { angleKey: true, scriptHash: true },
  });

  const hash = scriptHashFor(script);
  const angle = angleKeyFor(script);
  const usedAngles = history.map((h) => h.angleKey);

  if (history.some((h) => h.scriptHash === hash)) {
    return {
      isDuplicate: true,
      reason: "Kịch bản này trùng hoàn toàn với một kịch bản đã tạo trước đó.",
      usedAngles,
    };
  }
  if (history.some((h) => h.angleKey === angle)) {
    return {
      isDuplicate: true,
      reason: "Góc hài hước này đã được dùng cho thành ngữ này rồi.",
      usedAngles,
    };
  }
  return { isDuplicate: false, reason: "", usedAngles };
}

export async function recordConcept(
  idiomId: string,
  projectId: string,
  script: ScriptDoc,
): Promise<void> {
  await prisma.conceptHistory.create({
    data: {
      idiomId,
      projectId,
      angleKey: angleKeyFor(script),
      scriptHash: scriptHashFor(script),
      summary: script.punchline.slice(0, 200),
    },
  });
}

/** Angle suffixes already used for this idiom, to steer the next generation. */
export async function usedAngleKeys(idiomId: string): Promise<string[]> {
  const rows = await prisma.conceptHistory.findMany({
    where: { idiomId },
    select: { angleKey: true },
  });
  return rows.map((r) => r.angleKey.split("::")[1] ?? "").filter(Boolean);
}

// ------------------------------------------------------------- generation ---

export interface GenerateScriptResult {
  script: ScriptDoc;
  score: ScriptScore;
  rewritten: boolean;
  duplicateAvoided: boolean;
  provider: string;
  model: string;
}

export interface GenerateScriptOptions {
  idiomId: string;
  idiom: string;
  meaning: string;
  literalMeaning: string;
  exampleSentence: string;
  targetDuration: number;
  stylePrompt: string;
  characters: { name: string; personality: string; visualPrompt: string }[];
  provider: string;
  model: string;
  projectId?: string;
}

/**
 * Generate a script, then gate it twice before it is allowed forward:
 *   - duplicate check against this idiom's concept history;
 *   - self-scored quality check, with exactly one rewrite if a critical axis is
 *     below threshold. One. Never a loop.
 */
export async function generateScript(
  opts: GenerateScriptOptions,
): Promise<GenerateScriptResult> {
  const provider = await getTextProvider(opts.provider, opts.model);
  const avoidAngles = await usedAngleKeys(opts.idiomId);

  // Rendered here, not inside the provider: the template is operator-editable
  // content, and every text provider should send the same instructions.
  const systemPrompt = await buildPrompt("script", {
    idiom: opts.idiom,
    meaning: opts.meaning,
    literalMeaning: opts.literalMeaning,
    exampleSentence: opts.exampleSentence,
    targetDuration: opts.targetDuration,
    stylePrompt: opts.stylePrompt,
    characters: opts.characters
      .map((c) => `- ${c.name} (${c.personality}): ${c.visualPrompt}`)
      .join("\n"),
    avoidAngles:
      avoidAngles.length > 0 ? avoidAngles.join(", ") : "(none yet)",
  });

  const request: ScriptRequest = {
    idiom: opts.idiom,
    meaning: opts.meaning,
    literalMeaning: opts.literalMeaning,
    exampleSentence: opts.exampleSentence,
    targetDuration: opts.targetDuration,
    stylePrompt: opts.stylePrompt,
    characters: opts.characters,
    avoidAngles,
    model: opts.model,
    systemPrompt,
  };

  const started = Date.now();

  /**
   * One guarded, recorded text call.
   *
   * Everything a paid request needs wrapped around it lives here so no call
   * site can forget a piece: the spend gate before, the ProviderJob and cost
   * ledger entry after, and the token counts the provider reported.
   */
  const call = async <T extends { usage: ProviderUsage }>(
    purpose: string,
    estimate: number,
    run: () => Promise<T>,
  ): Promise<T> => {
    await assertCanSpend({
      provider: opts.provider,
      model: opts.model,
      estimatedCost: estimate,
    });

    const key = sha256(
      [
        opts.projectId ?? opts.idiomId,
        "text",
        purpose,
        opts.provider,
        opts.model,
        String(callCounter++),
      ].join("|"),
    );

    const job = await prisma.providerJob.create({
      data: {
        provider: opts.provider,
        model: opts.model,
        kind: "text",
        idempotencyKey: key,
        status: "processing",
        // The prompt is stored, the API key never is - it only ever exists in
        // an Authorization header inside the client.
        requestJson: JSON.stringify({ purpose, idiom: opts.idiom }),
        projectId: opts.projectId ?? null,
        estimatedCost: estimate,
        attempts: 1,
      },
    });

    try {
      const result = await run();
      const { usage } = result;

      await prisma.providerJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          durationMs: usage.durationMs,
          actualCost: usage.actualCost,
          responseJson: JSON.stringify({ model: usage.model }),
        },
      });

      await recordCost({
        projectId: opts.projectId ?? null,
        category: "text",
        provider: opts.provider,
        model: usage.model,
        amount: usage.actualCost,
        note: purpose,
      });

      return result;
    } catch (err) {
      await prisma.providerJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          error: err instanceof Error ? err.message.slice(0, 500) : String(err),
        },
      });
      throw err;
    }
  };

  const estimate = (await provider.estimateScriptCost(request)).amount;

  let { script } = await call("script", estimate, () =>
    provider.generateScript(request),
  );
  let duplicateAvoided = false;

  const dup = await checkDuplicate(opts.idiomId, script);
  if (dup.isDuplicate) {
    // Ask again, explicitly excluding every angle we have on record.
    const retry = await call("script-dedupe", estimate, () =>
      provider.generateScript({
        ...request,
        avoidAngles: [...new Set([...avoidAngles, ...dup.usedAngles])],
      }),
    );
    script = retry.script;
    duplicateAvoided = true;
  }

  let { score } = await call("score", estimate / 3, () =>
    provider.scoreScript(script, opts.model),
  );
  let rewritten = false;

  if (scriptNeedsRewrite(score)) {
    const retry = await call("script-rewrite", estimate, () =>
      provider.generateScript({
        ...request,
        avoidAngles: [...avoidAngles, script.angleKey],
      }),
    );
    const retryScore = await call("score-rewrite", estimate / 3, () =>
      provider.scoreScript(retry.script, opts.model),
    );
    // Keep whichever version actually scored better - a rewrite is not
    // automatically an improvement.
    if (total(retryScore.score) > total(score)) {
      script = retry.script;
      score = retryScore.score;
    }
    rewritten = true;
  }

  script = withDerivedRouting(script);

  await logger.info({
    event: "script.generated",
    provider: opts.provider,
    model: opts.model,
    projectId: opts.projectId,
    durationMs: Date.now() - started,
    message: `"${opts.idiom}" - ${script.scenes.length} cảnh`,
    data: { rewritten, duplicateAvoided, score },
  });

  return {
    script,
    score,
    rewritten,
    duplicateAvoided,
    provider: opts.provider,
    model: opts.model,
  };
}

/** Distinguishes repeated calls within one generation run in the job table. */
let callCounter = 0;

function total(score: ScriptScore): number {
  return (
    score.hook +
    score.humor +
    score.clarity +
    score.learningValue +
    score.visualFeasibility
  );
}

/**
 * Recompute complexity and spend priority from the scene text itself rather than
 * trusting whatever the text model claimed. The router's budget decisions depend
 * on these, so they are derived locally where we can reason about them.
 */
export function withDerivedRouting(script: ScriptDoc): ScriptDoc {
  const roles = ["hook", "literal", "escalation", "punchline", "meaning", "example"];
  let elapsed = 0;
  const scenes = script.scenes.map((scene, index) => {
    const { complexity } = classifyScene({
      duration: scene.duration,
      visualDescription: scene.visualDescription,
      characterAction: scene.characterAction,
      camera: scene.camera,
      dialogue: scene.dialogue,
      characters: scene.characters,
    });
    const role =
      index === script.scenes.length - 1
        ? "example"
        : (roles[index] ?? "escalation");
    const { priority } = assignSpendPriority({
      sceneNumber: scene.sceneNumber,
      totalScenes: script.scenes.length,
      startSeconds: elapsed,
      complexity,
      role,
    });
    elapsed += scene.duration;
    return { ...scene, complexity, spendPriority: priority };
  });
  return { ...script, scenes };
}
