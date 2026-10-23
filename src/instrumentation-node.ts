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
import { ensureMindVoice, mindInstalled } from "@/services/mind-voice-launcher";

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
  // Mind Voice (QĐ-153): start the local voice service when it is installed and
  // not running - however the app was opened. Never awaited: pages answer at once.
  if (process.env.MIND_VOICE_AUTOSTART !== "0" && mindInstalled()) {
    void ensureMindVoice()
      .then((r) => (r.ok ? undefined : console.warn(`[Mind Voice] ${r.message}`)))
      .catch((err: unknown) => console.error("[Mind Voice] Không khởi động được:", err));
  }
}
