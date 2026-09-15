"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BatchProgress } from "@/services/batch-runner";
import { isTerminalBatchStatus, type BatchStatus } from "@/domain/enums";

export const POLL_INTERVAL_MS = 2500;

export interface ProgressState {
  progress: BatchProgress;
  /** True while a poll is in flight, so the UI can show a quiet indicator. */
  refreshing: boolean;
  /** Set when the last poll failed. Stale data keeps showing underneath. */
  error: string | null;
  /** False once the batch reaches a terminal state and polling has stopped. */
  polling: boolean;
  refresh: () => void;
}

/**
 * Poll one batch's progress, and know when to stop.
 *
 * Three behaviours worth stating, because each replaces something worse:
 *
 *   it polls              the page used to need F5, which on a progress page
 *                         means the operator cannot tell "nothing has happened"
 *                         from "the page is frozen";
 *   it stops              a finished batch never changes again, so polling it
 *                         forever is a request every 2.5s for data that is done;
 *   it keeps stale data   a failed poll leaves the last good numbers on screen
 *                         with an error beside them, rather than blanking a page
 *                         that was telling the truth a moment ago.
 *
 * Reconnecting needs no special case: every response is built from the database,
 * so a tab that was closed for ten minutes asks once and is correct again.
 */
export function useBatchProgress(
  batchId: string,
  initial: BatchProgress,
): ProgressState {
  const [progress, setProgress] = useState<BatchProgress>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const terminal = isTerminalBatchStatus(progress.status as BatchStatus);
  const [polling, setPolling] = useState(!terminal);

  // Held in a ref so the effect below does not re-subscribe on every render;
  // an interval that tears down and rebuilds each tick drifts and double-fires.
  const inFlight = useRef(false);

  const fetchOnce = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/batches/${batchId}/progress`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // A caveat worth naming: this is JSON, so every `Date` in BatchProgress
      // arrives as a STRING after a poll, while the server-rendered first paint
      // has real Dates. The cast papers over that.
      //
      // Nothing here renders a date, and the app's `formatDateVi` accepts both
      // shapes, so there is no live bug - but anyone adding a date to this view
      // must not call Date methods on it directly.
      const next = (await res.json()) as BatchProgress;
      setProgress(next);
      setError(null);
      if (isTerminalBatchStatus(next.status as BatchStatus)) setPolling(false);
    } catch (err) {
      // Keep the last good numbers. A transient failure must not blank a page
      // that was correct a second ago.
      setError(err instanceof Error ? err.message : "Không đọc được tiến trình.");
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, [batchId]);

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void fetchOnce(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [polling, fetchOnce]);

  return {
    progress,
    refreshing,
    error,
    polling,
    refresh: () => void fetchOnce(),
  };
}
