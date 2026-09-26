"use server";

import { revalidatePath } from "next/cache";
import { errorMessage } from "@/lib/utils";
import { refreshRunwayBalance, type BalanceRefresh } from "@/services/provider-budget";

/**
 * REFRESH BALANCE - read Runway's own wallet with GET /organization. Free, and
 * read-only: no POST, no ProviderJob, no CostEntry, no reservation, no create
 * token. On any failure the stored figure is kept (and reported STALE), never
 * overwritten with zero. Manual only - nothing polls this.
 */
export async function refreshRunwayBalanceNow(): Promise<{ ok: boolean; message: string; result?: BalanceRefresh }> {
  try {
    const result = await refreshRunwayBalance();
    revalidatePath("/");
    revalidatePath("/settings");
    return {
      ok: result.ok,
      message: result.ok
        ? `LIVE: ${result.credits} credit ≈ $${(result.usd ?? 0).toFixed(2)}`
        : `STALE — giữ số đã lưu (${result.source}${result.cacheAgeHours !== null ? `, ${result.cacheAgeHours} giờ tuổi` : ""}): ${result.note}`,
      result,
    };
  } catch (err) {
    return { ok: false, message: `STALE — ${errorMessage(err)}` };
  }
}
