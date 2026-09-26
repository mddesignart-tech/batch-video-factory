import { describe, expect, it, vi } from "vitest";

// Server actions call revalidatePath, which only exists inside a Next request.
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { prisma } from "@/lib/prisma";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { peekCreateToken } from "@/services/create-token";
import { updateSpendCap } from "@/app/actions/spending";

/**
 * GLOBAL PROJECT SPEND LIMIT - changed only by a person, only after they
 * confirm, never below what was already spent, always logged old -> new, and
 * never a trigger for any spending of its own.
 */

function form(cap: string, confirm?: string): FormData {
  const f = new FormData();
  f.set("cap", cap);
  if (confirm) f.set("confirm", confirm);
  return f;
}

async function moneySide() {
  return {
    jobs: await prisma.providerJob.count(),
    costs: await prisma.costEntry.count(),
    reservations: await prisma.costReservation.count(),
    queue: await prisma.job.count(),
    token: await peekCreateToken(),
  };
}

describe("GLOBAL PROJECT SPEND LIMIT", () => {
  it("không xác nhận thì KHÔNG lưu", async () => {
    await setSpendCap(10);
    const r = await updateSpendCap(form("12"));
    expect(r.ok).toBe(false);
    expect((await spendStatus()).cap).toBe(10);
  });

  it("từ chối hạn mức thấp hơn số đã chi", async () => {
    const spent = (await spendStatus()).spent;
    await prisma.costEntry.create({
      data: { category: "voice", provider: "openai", model: "gpt-4o-mini-tts", amount: 0.5, estimated: false },
    });
    const now = await spendStatus();
    expect(now.spent).toBeCloseTo(spent + 0.5, 6);
    const r = await updateSpendCap(form(String(Math.max(0, now.spent - 0.1)), "yes"));
    expect(r.ok).toBe(false);
    expect((await spendStatus()).cap).toBe(10);
  });

  it("lưu đúng số người dùng nhập, ghi log cũ -> mới, không chạm phía tiền", async () => {
    const before = await moneySide();
    const r = await updateSpendCap(form("10.5", "yes"));
    expect(r.ok).toBe(true);
    expect((await spendStatus()).cap).toBe(10.5);
    const log = await prisma.logEntry.findFirst({ where: { event: "spend.cap_changed" }, orderBy: { createdAt: "desc" } });
    expect(log?.message).toContain("từ $10.00");
    expect(log?.message).toContain("thành $10.50");
    expect(log?.message).toContain("SETTINGS_UI");
    // Changing the limit starts nothing and buys nothing.
    expect(await moneySide()).toEqual(before);
  });

  it("không có giá trị tự tăng: số ngoài phạm vi bị từ chối, hạn mức giữ nguyên", async () => {
    const r = await updateSpendCap(form("abc", "yes"));
    expect(r.ok).toBe(false);
    expect((await spendStatus()).cap).toBe(10.5);
  });
});
