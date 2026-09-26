/**
 * What the GLOBAL PROJECT SPEND LIMIT card may show.
 *
 * The card shows the limit the SERVER last read from the database: the page's
 * own reading, or - straight after a successful save - the value the save read
 * back. The number typed into the field is never shown as the limit, so a save
 * that failed (or never reached the server) cannot look like one that worked.
 */

export interface SpendCapSaveOutcome {
  ok: boolean;
  message: string;
  readBack?: { cap: number; spent: number; remaining: number };
}

export interface SpendCapView {
  cap: number;
  spent: number;
  remaining: number;
  saveState: "IDLE" | "SAVED" | "SAVE_FAILED";
}

export function spendCapView(
  server: { cap: number; spent: number },
  outcome: SpendCapSaveOutcome | null,
): SpendCapView {
  if (outcome?.ok && outcome.readBack) {
    const { cap, spent, remaining } = outcome.readBack;
    return { cap, spent, remaining: Math.max(0, remaining), saveState: "SAVED" };
  }
  return {
    cap: server.cap,
    spent: server.spent,
    remaining: Math.max(0, server.cap - server.spent),
    saveState: outcome ? "SAVE_FAILED" : "IDLE",
  };
}

/** A save that threw (network down, server gone) becomes an explicit failure. */
export function saveFailure(err: unknown): SpendCapSaveOutcome {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    message: `SAVE FAILED: không gửi được tới server (${detail}). Hạn mức trong DB giữ nguyên.`,
  };
}
