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

// ------------------------------------------------------- per-video locks ---
//
// V1.2 Phase 3 (QĐ-110): each VIDEO has at most one active execution - media,
// render, export - whoever started it (a batch run, TIẾP TỤC on one video,
// TIẾP TỤC TẤT CẢ). Videos of the same batch run independently of each other.
//
// Taken SYNCHRONOUSLY, before the first await, so a double click cannot slip a
// second execution in between "is it free?" and "it is mine". In-process, like
// the reservation lock (one app, one SQLite file).

const VIDEO_KEY = "__videoRunRegistry";
const videos: Map<string, string> =
  ((globalThis as Record<string, unknown>)[VIDEO_KEY] as Map<string, string>) ?? new Map();
(globalThis as Record<string, unknown>)[VIDEO_KEY] = videos;

/** Take the video's lock for `owner`. False when someone else holds it. */
export function tryLockVideo(projectId: string, owner: string): boolean {
  const held = videos.get(projectId);
  if (held !== undefined && held !== owner) return false;
  videos.set(projectId, owner);
  return true;
}

export function unlockVideo(projectId: string, owner: string): void {
  if (videos.get(projectId) === owner) videos.delete(projectId);
}

export function isVideoRunning(projectId: string): boolean {
  return videos.has(projectId);
}
