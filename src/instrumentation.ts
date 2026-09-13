/**
 * Next.js calls this once per server process at startup.
 *
 * It is where the job worker is booted, guarded so it only ever runs in the
 * Node.js runtime (never the Edge runtime, which has no filesystem or child
 * processes and therefore no FFmpeg).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { ensureDataDirs } = await import("@/lib/paths");
  ensureDataDirs();

  const { startWorker } = await import("@/jobs/worker");
  await startWorker().catch((err: unknown) => {
    console.error("Không khởi động được worker:", err);
  });
}
