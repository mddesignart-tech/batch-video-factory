import type { Job } from "@prisma/client";
import type { JobType } from "@/domain/enums";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { backoffFor, DEFAULT_MAX_RETRIES } from "@/services/generation";

/**
 * SQLite-backed job queue.
 *
 * No Redis, no external broker: this is a single-user desktop-style app, and a
 * table plus a polling worker is both sufficient and far easier to inspect when
 * something goes wrong. Jobs survive a restart, which a purely in-memory queue
 * would not.
 *
 * Claiming is done with a conditional UPDATE rather than read-then-write, so two
 * workers cannot pick up the same job even though SQLite has no SELECT ... FOR
 * UPDATE.
 */

export interface EnqueueInput {
  type: JobType;
  payload?: Record<string, unknown>;
  projectId?: string | null;
  batchId?: string | null;
  sceneId?: string | null;
  priority?: number;
  maxAttempts?: number;
  runAt?: Date;
}

export async function enqueue(input: EnqueueInput): Promise<Job> {
  const job = await prisma.job.create({
    data: {
      type: input.type,
      payloadJson: JSON.stringify(input.payload ?? {}),
      projectId: input.projectId ?? null,
      batchId: input.batchId ?? null,
      sceneId: input.sceneId ?? null,
      priority: input.priority ?? 100,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_RETRIES,
      nextRunAt: input.runAt ?? new Date(),
    },
  });
  await logger.debug({
    event: "job.enqueued",
    jobId: job.id,
    projectId: job.projectId ?? undefined,
    sceneId: job.sceneId ?? undefined,
    message: job.type,
  });
  return job;
}

/**
 * Atomically take the next due job. Returns null when there is nothing to do.
 *
 * The conditional update is the lock: whoever flips `queued` -> `processing`
 * owns the job, and a loser simply tries the next candidate.
 */
export async function claimNext(): Promise<Job | null> {
  const now = new Date();
  const candidates = await prisma.job.findMany({
    where: { status: "queued", nextRunAt: { lte: now } },
    orderBy: [{ priority: "asc" }, { nextRunAt: "asc" }, { createdAt: "asc" }],
    take: 5,
  });

  for (const candidate of candidates) {
    const claimed = await prisma.job.updateMany({
      where: { id: candidate.id, status: "queued" },
      data: {
        status: "processing",
        startedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 1) {
      return prisma.job.findUnique({ where: { id: candidate.id } });
    }
  }
  return null;
}

export async function completeJob(
  jobId: string,
  result?: unknown,
): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "completed",
      finishedAt: new Date(),
      error: null,
      resultJson: result === undefined ? null : JSON.stringify(result).slice(0, 4000),
    },
  });
}

/**
 * Fail a job. If attempts remain it goes back to `queued` with an exponential
 * backoff (10s / 30s / 90s) rather than being retried immediately - a provider
 * that just rate-limited us will not have recovered a millisecond later.
 */
/** Job types that may send a paid provider request. Never auto-retried. */
export const PAID_JOB_TYPES: ReadonlySet<string> = new Set([
  "generate_scene_media",
  "generate_scene_image",
  "generate_scene_video",
  "generate_scene_voice",
  "generate_script",
  "evaluate_scene_quality",
  "batch_expand",
]);

export async function failJob(jobId: string, error: unknown): Promise<boolean> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return false;

  const message =
    error instanceof Error ? error.message : String(error ?? "Lỗi không xác định");

  // A FAILURE THAT SAYS IT WILL NOT PASS IS NOT RETRIED.
  //
  // `GenerationError` and `ProviderError` both carry `retryable`, and this
  // counted attempts without ever reading it - so a 401, a malformed request,
  // or a scene whose character has no description at all burned the whole retry
  // budget re-proving the same thing. Free in the cases that refuse before the
  // POST; NOT free where the vendor has already seen the request, because each
  // attempt is another one it sees.
  //
  // Read structurally rather than by class name, so an error that travels
  // through a boundary and loses its prototype still keeps its meaning.
  const declaredRetryable =
    typeof error === "object" && error !== null && "retryable" in error
      ? (error as { retryable: unknown }).retryable
      : undefined;
  // ONE RETRY POLICY, the executor's: a job that can send a PAID request is
  // never retried automatically. A retryable vendor error (a 5xx after the POST
  // was accepted) retried here would be a second purchase nobody approved. The
  // person retries it - TIẾP TỤC / Thử lại - where the same idempotency key
  // reuses whatever was already bought. Local work (render) still retries.
  const paid = PAID_JOB_TYPES.has(job.type);
  const willRetry =
    paid || declaredRetryable === false ? false : job.attempts < job.maxAttempts;

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: willRetry ? "queued" : "failed",
      error: message.slice(0, 1000),
      finishedAt: willRetry ? null : new Date(),
      nextRunAt: willRetry
        ? new Date(Date.now() + backoffFor(job.attempts - 1))
        : job.nextRunAt,
    },
  });

  await logger.error({
    event: willRetry ? "job.retry" : "job.failed",
    jobId,
    projectId: job.projectId ?? undefined,
    sceneId: job.sceneId ?? undefined,
    message: `${job.type}: ${message}`,
    status: willRetry ? "queued" : "failed",
  });

  return willRetry;
}

/** Reschedule a job without counting it as a failure (waiting on a dependency). */
export async function deferJob(jobId: string, delayMs: number): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "queued",
      nextRunAt: new Date(Date.now() + delayMs),
      // Waiting is not an attempt; do not burn the retry budget on it.
      attempts: { decrement: 1 },
    },
  });
}

export async function cancelJob(jobId: string): Promise<void> {
  await prisma.job.updateMany({
    where: { id: jobId, status: { in: ["queued", "processing"] } },
    data: { status: "cancelled", finishedAt: new Date() },
  });
}

export async function cancelProjectJobs(projectId: string): Promise<number> {
  const res = await prisma.job.updateMany({
    where: { projectId, status: { in: ["queued", "processing"] } },
    data: { status: "cancelled", finishedAt: new Date() },
  });
  return res.count;
}

export async function queueStats(): Promise<Record<string, number>> {
  const rows = await prisma.job.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const out: Record<string, number> = {
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const row of rows) out[row.status] = row._count._all;
  return out;
}

/**
 * Recover jobs that were mid-flight when the process died. Called once at
 * startup: without this, a crash during generation would leave rows stuck in
 * `processing` forever and the project would never finish.
 */
export async function requeueStaleJobs(): Promise<number> {
  const res = await prisma.job.updateMany({
    where: { status: "processing" },
    data: { status: "queued", nextRunAt: new Date(), startedAt: null },
  });
  if (res.count > 0) {
    await logger.warn({
      event: "job.requeued_stale",
      message: `Đưa ${res.count} job đang dở về hàng đợi sau khi khởi động lại.`,
    });
  }
  return res.count;
}
