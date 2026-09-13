import { prisma } from "./prisma";

/**
 * Structured logging to both stdout and the LogEntry table.
 *
 * Redaction is applied to every payload before it is written: anything that
 * looks like an API key is replaced, so no secret can reach the log table even
 * if a provider echoes it back inside an error message.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogInput {
  level?: LogLevel;
  event: string;
  message?: string;
  provider?: string;
  model?: string;
  projectId?: string;
  sceneId?: string;
  jobId?: string;
  durationMs?: number;
  estimatedCost?: number;
  actualCost?: number;
  status?: string;
  data?: unknown;
}

const SECRET_HINTS =
  /(api[-_]?key|authorization|bearer|secret|token|password|apikey)/i;

/** Replace any value whose key looks secret, plus obvious key-shaped strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (typeof value === "string") {
    // Vendor keys are usually a short prefix followed by several dash- or
    // underscore-separated segments, so the body must allow those separators -
    // matching only [A-Za-z0-9] stops at the first dash and misses real keys.
    if (/\b(sk|rw|kl|api)[-_][A-Za-z0-9_-]{12,}/.test(value)) return "[redacted]";
    return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_HINTS.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function line(input: LogInput): string {
  const bits = [
    `[${input.level ?? "info"}]`,
    input.event,
    input.provider ? `provider=${input.provider}` : "",
    input.model ? `model=${input.model}` : "",
    input.projectId ? `project=${input.projectId.slice(0, 8)}` : "",
    input.sceneId ? `scene=${input.sceneId.slice(0, 8)}` : "",
    input.durationMs !== undefined ? `${input.durationMs}ms` : "",
    input.actualCost !== undefined ? `$${input.actualCost.toFixed(4)}` : "",
    input.message ?? "",
  ];
  return bits.filter(Boolean).join(" ");
}

export async function log(input: LogInput): Promise<void> {
  const level = input.level ?? "info";
  if (level === "error") console.error(line(input));
  else if (level === "warn") console.warn(line(input));
  else if (process.env.NODE_ENV !== "test") console.log(line(input));

  try {
    await prisma.logEntry.create({
      data: {
        level,
        event: input.event,
        message: input.message ?? "",
        provider: input.provider ?? null,
        model: input.model ?? null,
        projectId: input.projectId ?? null,
        sceneId: input.sceneId ?? null,
        jobId: input.jobId ?? null,
        durationMs: input.durationMs ?? null,
        estimatedCost: input.estimatedCost ?? null,
        actualCost: input.actualCost ?? null,
        status: input.status ?? null,
        dataJson:
          input.data === undefined
            ? null
            : JSON.stringify(redact(input.data)).slice(0, 8000),
      },
    });
  } catch {
    // Logging must never take the pipeline down with it.
  }
}

export const logger = {
  debug: (i: Omit<LogInput, "level">) => log({ ...i, level: "debug" }),
  info: (i: Omit<LogInput, "level">) => log({ ...i, level: "info" }),
  warn: (i: Omit<LogInput, "level">) => log({ ...i, level: "warn" }),
  error: (i: Omit<LogInput, "level">) => log({ ...i, level: "error" }),
};
