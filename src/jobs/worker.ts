import { logger } from "@/lib/logger";
import { getSettings } from "@/lib/settings";
import { onJobExhausted, runJob } from "./handlers";
import { claimNext, completeJob, failJob, requeueStaleJobs } from "./queue";

/**
 * In-process job worker.
 *
 * One worker per app process, polling the job table. Concurrency defaults to 2
 * and is configurable, but stays deliberately low: the throttle here is what
 * stops a 50-video batch from firing fifty paid generations at once.
 */

const POLL_INTERVAL_MS = 1000;
const IDLE_BACKOFF_MS = 2500;

/**
 * Worker state lives on globalThis, not in module scope.
 *
 * Next bundles `instrumentation.ts` (which starts the worker) separately from
 * the route handlers (which report on it), so each gets its own instance of this
 * module. A plain module-level flag would have the status endpoint permanently
 * reporting "worker off" while the worker was in fact running.
 */
interface WorkerState {
  running: boolean;
  stopping: boolean;
  active: number;
}

const globalForWorker = globalThis as unknown as {
  __idiomWorker?: WorkerState;
};

const state: WorkerState = (globalForWorker.__idiomWorker ??= {
  running: false,
  stopping: false,
  active: 0,
});

export function workerRunning(): boolean {
  return state.running;
}

export function activeJobCount(): number {
  return state.active;
}

export async function startWorker(): Promise<void> {
  if (state.running) return;

  const settings = await getSettings();
  if (!settings.workerEnabled) {
    await logger.warn({
      event: "worker.disabled",
      message: "Worker đang tắt (JOB_WORKER_ENABLED=false). Job sẽ không được xử lý.",
    });
    return;
  }

  state.running = true;
  state.stopping = false;
  await requeueStaleJobs();
  await logger.info({
    event: "worker.started",
    message: `Worker khởi động, concurrency = ${settings.jobConcurrency}.`,
  });

  void loop();
}

export function stopWorker(): void {
  state.stopping = true;
  state.running = false;
}

async function loop(): Promise<void> {
  while (!state.stopping) {
    let concurrency = 2;
    try {
      concurrency = Math.max(1, (await getSettings()).jobConcurrency);
    } catch {
      // Settings unreadable (e.g. DB not migrated yet) - fall back and retry.
    }

    if (state.active >= concurrency) {
      await wait(POLL_INTERVAL_MS);
      continue;
    }

    let job = null;
    try {
      job = await claimNext();
    } catch (err) {
      await logger.error({
        event: "worker.claim_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      await wait(IDLE_BACKOFF_MS);
      continue;
    }

    if (!job) {
      await wait(IDLE_BACKOFF_MS);
      continue;
    }

    state.active++;
    void (async () => {
      const started = Date.now();
      try {
        const outcome = await runJob(job);
        // A deferred job re-queued itself while waiting on a dependency; it must
        // not be marked complete.
        if (!outcome.deferred) {
          await completeJob(job.id, outcome.result);
          await logger.info({
            event: "job.completed",
            jobId: job.id,
            projectId: job.projectId ?? undefined,
            sceneId: job.sceneId ?? undefined,
            durationMs: Date.now() - started,
            message: job.type,
          });
        }
      } catch (err) {
        const willRetry = await failJob(job.id, err);
        if (!willRetry) await onJobExhausted(job, err);
      } finally {
        state.active--;
      }
    })();

    await wait(120); // small gap so jobs start staggered, not in a burst
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
