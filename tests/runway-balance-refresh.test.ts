import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getProviderBudgets, refreshRunwayBalance, setProviderBudget } from "@/services/provider-budget";
import { peekCreateToken } from "@/services/create-token";
import { todayDashboard } from "@/services/dashboard";

/**
 * REFRESH BALANCE: one GET to Runway, and nothing else.
 *
 * The fetch is injected, so no network is touched. What is proved: success
 * stores a LIVE reading; every failure keeps the old figure (STALE) and never
 * writes zero; a genuine zero IS stored; and no money-side row appears.
 */

const OLD = { credits: 551, checkedAt: "2026-09-19T07:27:26.486Z" };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; method: string }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return respond();
  }) as typeof fetch;
  return { impl, calls };
}

async function counts() {
  return {
    jobs: await prisma.providerJob.count(),
    costs: await prisma.costEntry.count(),
    reservations: await prisma.costReservation.count(),
    token: await peekCreateToken(),
  };
}

async function runway() {
  return (await getProviderBudgets()).find((b) => b.provider === "runway")!;
}

beforeEach(async () => {
  await setProviderBudget({
    provider: "runway",
    available: OLD.credits,
    unit: "credits",
    usdPerUnit: 0.01,
    liveBalanceAvailable: true,
    source: "LIVE",
    checkedAt: OLD.checkedAt,
    note: "old reading",
  });
});

describe("REFRESH BALANCE — chỉ đọc", () => {
  it("thành công: lưu số LIVE mới, đúng 1 request GET /organization", async () => {
    const before = await counts();
    const f = fakeFetch(() => new Response(JSON.stringify({ creditBalance: 471 }), { status: 200 }));
    const r = await refreshRunwayBalance({ apiKey: "fake-api-key-for-test-only", fetchImpl: f.impl });
    expect(r.ok).toBe(true);
    expect(r.credits).toBe(471);
    expect(r.usd).toBe(4.71);
    expect(r.source).toBe("LIVE");
    expect(f.calls).toEqual([{ url: expect.stringMatching(/\/organization$/), method: "GET" }]);
    const b = await runway();
    expect(b.available).toBe(471);
    // Read back from the database it is CACHE by design - only the call itself
    // mints LIVE; by the time it sits in SQLite, time has passed.
    expect(b.source).toBe("CACHE");
    expect(new Date(b.checkedAt!).getTime()).toBeGreaterThan(new Date(OLD.checkedAt).getTime());
    // Read-only: nothing on the money side moved.
    expect(await counts()).toEqual(before);
  });

  it.each([
    ["HTTP 500", () => new Response("boom", { status: 500 })],
    ["JSON hỏng", () => new Response("not json", { status: 200 })],
    ["thiếu creditBalance", () => new Response(JSON.stringify({}), { status: 200 })],
    ["lỗi mạng", () => Promise.reject(new Error("ECONNRESET"))],
  ])("%s: giữ số cũ (STALE), không ghi đè bằng 0", async (_label, respond) => {
    const f = fakeFetch(respond as () => Response);
    const r = await refreshRunwayBalance({ apiKey: "fake-api-key-for-test-only", fetchImpl: f.impl });
    expect(r.ok).toBe(false);
    expect(r.credits).toBeNull();
    const b = await runway();
    expect(b.available).toBe(OLD.credits);
    expect(b.checkedAt).toBe(OLD.checkedAt);
  });

  it("không có key: không gọi mạng, giữ số cũ", async () => {
    const f = fakeFetch(() => new Response("{}", { status: 200 }));
    const prev = process.env.RUNWAY_API_KEY;
    delete process.env.RUNWAY_API_KEY;
    try {
      const r = await refreshRunwayBalance({ fetchImpl: f.impl });
      expect(r.ok).toBe(false);
      expect(f.calls).toHaveLength(0);
    } finally {
      if (prev !== undefined) process.env.RUNWAY_API_KEY = prev;
    }
    expect((await runway()).available).toBe(OLD.credits);
  });

  it("số dư 0 THẬT được lưu là 0 — con số quan trọng nhất không bị bỏ qua", async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ creditBalance: 0 }), { status: 200 }));
    const r = await refreshRunwayBalance({ apiKey: "fake-api-key-for-test-only", fetchImpl: f.impl });
    expect(r.ok).toBe(true);
    expect((await runway()).available).toBe(0);
  });

  it("dashboard: LIVE ngay sau khi đọc, CACHE khi số đã cũ", async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ creditBalance: 471 }), { status: 200 }));
    await refreshRunwayBalance({ apiKey: "fake-api-key-for-test-only", fetchImpl: f.impl });
    const now = await todayDashboard();
    expect(now.runwayFreshness).toBe("LIVE");
    expect(now.runwayCredits).toBe(471);
    const later = await todayDashboard(new Date(Date.now() + 2 * 3_600_000));
    expect(later.runwayFreshness).toBe("CACHE");
  });
});
