/**
 * Which batches have a production run in THIS process right now.
 *
 * One runner per batch: a second click on DUYỆT & CHẠY or TIẾP TỤC while a run
 * is spending must not start a second run beside it. Kept on globalThis so a
 * dev hot reload does not forget a run that is still going. A local app has one
 * server process, so an empty registry after a restart truthfully means "no
 * run is going" - which is exactly when TIẾP TỤC should be offered.
 */
const KEY = "__batchRunRegistry";
const registry: Map<string, Promise<unknown>> =
  ((globalThis as Record<string, unknown>)[KEY] as Map<string, Promise<unknown>>) ?? new Map();
(globalThis as Record<string, unknown>)[KEY] = registry;

export function isRunning(batchId: string): boolean {
  return registry.has(batchId);
}

export function currentRun<T>(batchId: string): Promise<T> | undefined {
  return registry.get(batchId) as Promise<T> | undefined;
}

export function registerRun<T>(batchId: string, run: Promise<T>): Promise<T> {
  registry.set(batchId, run);
  void run.finally(() => registry.delete(batchId)).catch(() => undefined);
  return run;
}
