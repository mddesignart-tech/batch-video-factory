/**
 * Named, process-wide counting semaphores (V1.2 Phase 6, QĐ-114).
 *
 * One local app = one server process, so "at most N FFmpeg renders" and "at
 * most N media steps that may pay" are in-process facts, like the run registry
 * and the reservation lock. Kept on globalThis so a dev hot reload does not
 * forget who holds a slot. The limit is read on every acquire, so a change in
 * Settings applies to the next step without a restart.
 *
 * These only ORDER work. Money is still guarded where it always was: the
 * reservation lock and the gate re-check every limit at the POST itself.
 */
interface Slot {
  active: number;
  waiting: Array<() => void>;
}

const KEY = "__namedSemaphores";
const slots: Map<string, Slot> =
  ((globalThis as Record<string, unknown>)[KEY] as Map<string, Slot>) ?? new Map();
(globalThis as Record<string, unknown>)[KEY] = slots;

function slot(name: string): Slot {
  let s = slots.get(name);
  if (!s) {
    s = { active: 0, waiting: [] };
    slots.set(name, s);
  }
  return s;
}

export async function withSemaphore<T>(name: string, limit: number, work: () => Promise<T>): Promise<T> {
  const s = slot(name);
  const max = Math.max(1, Math.floor(limit));
  while (s.active >= max) {
    await new Promise<void>((resolve) => s.waiting.push(resolve));
  }
  s.active += 1;
  try {
    return await work();
  } finally {
    s.active -= 1;
    const next = s.waiting.shift();
    if (next) next();
  }
}

/** For tests and the queue view: how many hold the named slot right now. */
export function semaphoreActive(name: string): number {
  return slots.get(name)?.active ?? 0;
}

/**
 * Run `worker` over `items` with at most `limit` in flight; results keep the
 * input order. A worker's rejection is returned in its slot, never thrown, so
 * one video's failure cannot abandon the others (failure isolation).
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        try {
          results[i] = { ok: true, value: await worker(items[i]!, i) };
        } catch (error) {
          results[i] = { ok: false, error };
        }
      }
    }),
  );
  return results;
}
