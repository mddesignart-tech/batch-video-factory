/**
 * The Node.js half of src/instrumentation.ts: data folders and the job worker.
 *
 * It lives in its own module so the Edge compile of instrumentation never sees
 * it. With an early `return` instead, `next dev` still bundled the worker ->
 * render -> ffmpeg-static chain for Edge, failed on `require('os')`, and every
 * page answered 500.
 */
import { ensureDataDirs } from "@/lib/paths";
import { startWorker } from "@/jobs/worker";
import { reconcileInterruptedRuns } from "@/services/restart-recovery";

export async function registerNode(): Promise<void> {
  ensureDataDirs();
  // A run lives in this process; after a restart none is running. Videos the
  // database still calls "running" are classified INTERRUPTED (resumable) -
  // nothing is sent (V1.2 Phase 6, QĐ-114).
  await reconcileInterruptedRuns().catch((err: unknown) => {
    console.error("Không phân loại được video bị gián đoạn:", err);
  });
  await startWorker().catch((err: unknown) => {
    console.error("Không khởi động được worker:", err);
  });
}
