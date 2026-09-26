/**
 * Next.js calls this once per server process at startup.
 *
 * It is where the job worker is booted, guarded so it only ever runs in the
 * Node.js runtime (never the Edge runtime, which has no filesystem or child
 * processes and therefore no FFmpeg). The import sits INSIDE the condition:
 * Next replaces NEXT_RUNTIME at compile time, so the Edge bundle drops the
 * branch and never tries to bundle FFmpeg.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
