import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Server actions call revalidatePath, which only exists inside a Next request.
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { prisma } from "@/lib/prisma";
import { getSpendCap, setSpendCap, spendStatus } from "@/services/spend-guard";
import { updateSpendCap } from "@/app/actions/spending";
import { isProductionDatabase, resolveDatabaseFile } from "@/lib/db-location";
import { saveFailure, spendCapView } from "@/domain/spend-cap-display";
import { TEST_DB } from "./test-env";

/**
 * Regression: a limit typed into Settings must land in the database this server
 * opened, be read back from it, survive a reload, and be audited exactly once.
 * A failed save must never look like a saved one.
 */

function form(cap: string, confirm = "yes"): FormData {
  const f = new FormData();
  f.set("cap", cap);
  f.set("confirm", confirm);
  return f;
}

async function capLogs() {
  return prisma.logEntry.count({ where: { event: "spend.cap_changed" } });
}

async function atLeastSpent(extra: number): Promise<number> {
  return Math.round(((await spendStatus()).spent + extra) * 100) / 100;
}

describe("Settings -> GLOBAL PROJECT SPEND LIMIT -> DB", () => {
  it("1. lưu từ Settings đổi DB thật, trả về giá trị ĐỌC LẠI từ DB", async () => {
    await setSpendCap(await atLeastSpent(1));
    const target = await atLeastSpent(2.5);
    const r = await updateSpendCap(form(target.toFixed(2)));
    expect(r.ok).toBe(true);
    const row = await prisma.setting.findUnique({ where: { key: "spend.cap" } });
    expect(JSON.parse(row!.valueJson)).toBe(target);
    expect(r.readBack?.cap).toBe(target);
  });

  it("2. 'reload' = đọc lại từ DB bằng client mới -> vẫn giá trị đã lưu", async () => {
    const target = await atLeastSpent(3);
    await updateSpendCap(form(target.toFixed(2)));
    // A page reload is a fresh server read, not the component's memory.
    const fresh = new (await import("@prisma/client")).PrismaClient();
    try {
      const row = await fresh.setting.findUnique({ where: { key: "spend.cap" } });
      expect(JSON.parse(row!.valueJson)).toBe(target);
    } finally {
      await fresh.$disconnect();
    }
    expect((await spendStatus()).cap).toBe(target);
  });

  it("3. số không hợp lệ bị chặn, DB giữ nguyên, không có audit", async () => {
    const before = await getSpendCap();
    const logs = await capLogs();
    for (const bad of ["", "abc", "8.5abc", "-1", "NaN", "Infinity", "1e3", "5000"]) {
      const r = await updateSpendCap(form(bad));
      expect(r.ok, bad).toBe(false);
      expect(r.message).toContain("SAVE FAILED");
    }
    expect(await getSpendCap()).toBe(before);
    expect(await capLogs()).toBe(logs);
  });

  it("4. thấp hơn số đã chi thật bị chặn", async () => {
    await prisma.costEntry.create({
      data: { category: "voice", provider: "openai", model: "gpt-4o-mini-tts", amount: 0.25, estimated: false },
    });
    const before = await getSpendCap();
    const spent = (await spendStatus()).spent;
    const r = await updateSpendCap(form(Math.max(0, spent - 0.01).toFixed(2)));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("thấp hơn số đã chi");
    expect(await getSpendCap()).toBe(before);
  });

  it("5. lưu hợp lệ tạo ĐÚNG 1 audit: cũ, mới, thời điểm, nguồn SETTINGS_UI", async () => {
    const previous = await getSpendCap();
    const target = await atLeastSpent(4);
    const logs = await capLogs();
    const r = await updateSpendCap(form(target.toFixed(2)));
    expect(r.ok).toBe(true);
    expect(await capLogs()).toBe(logs + 1);
    const log = await prisma.logEntry.findFirst({
      where: { event: "spend.cap_changed" },
      orderBy: { createdAt: "desc" },
    });
    const data = JSON.parse(log!.dataJson!);
    expect(data.previous).toBe(previous);
    expect(data.cap).toBe(target);
    expect(data.source).toBe("SETTINGS_UI");
    expect(new Date(data.changedAt).getTime()).toBe(log!.createdAt.getTime());
    expect(log!.message).toContain(`từ $${previous.toFixed(2)} thành $${target.toFixed(2)}`);
  });

  it("5b. chưa xác nhận -> không lưu, không audit", async () => {
    const before = await getSpendCap();
    const logs = await capLogs();
    const r = await updateSpendCap(form((before + 1).toFixed(2), "no"));
    expect(r.ok).toBe(false);
    expect(await getSpendCap()).toBe(before);
    expect(await capLogs()).toBe(logs);
  });

  it("6. lưu lỗi -> UI hiển thị số của DB, không phải số vừa gõ", () => {
    const server = { cap: 8.08, spent: 8.012993 };
    // The server refused.
    const refused = spendCapView(server, { ok: false, message: "SAVE FAILED: ..." });
    expect(refused.cap).toBe(8.08);
    expect(refused.saveState).toBe("SAVE_FAILED");
    // The request never reached a server (dead dev server, network).
    const thrown = saveFailure(new Error("fetch failed"));
    expect(thrown.ok).toBe(false);
    expect(thrown.message).toContain("SAVE FAILED");
    expect(spendCapView(server, thrown).cap).toBe(8.08);
    // Only a successful save with a read-back changes what is shown.
    const saved = spendCapView(server, {
      ok: true,
      message: "",
      readBack: { cap: 8.5, spent: 8.012993, remaining: 0.487007 },
    });
    expect(saved).toMatchObject({ cap: 8.5, remaining: 0.487007, saveState: "SAVED" });
  });

  it("7. DB của test và DB production không lẫn nhau", async () => {
    const root = path.resolve(__dirname, "..");
    // The suite runs on data/.test/test.db and the action reports that file.
    expect(resolveDatabaseFile(undefined, root)).toBe(TEST_DB);
    expect(isProductionDatabase(undefined, root)).toBe(false);
    const r = await updateSpendCap(form("abc"));
    expect(r.databaseFile).toBe(TEST_DB);
    expect(r.productionDatabase).toBe(false);
    // The default URL, as in .env, is the operator's real database.
    expect(resolveDatabaseFile("file:../data/app.db", root)).toBe(path.join(root, "data", "app.db"));
    expect(isProductionDatabase("file:../data/app.db", root)).toBe(true);
    expect(isProductionDatabase(`file:${path.join(root, "data", ".cap-repro", "app.db")}`, root)).toBe(false);
  });
});
