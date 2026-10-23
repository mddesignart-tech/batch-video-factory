import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetEnvCache } from "@/lib/env";
import { SEED_MODELS } from "@/data/seed-config";
import { ProviderError } from "@/providers/types";
import {
  assertCanSpend,
  confirmedProviders,
  isSpendRefusal,
  ProviderNotConfirmedError,
  SPEND_CAP_SETTING,
  SPEND_CONFIRM_SETTING,
  SpendCapExceededError,
} from "@/services/spend-guard";
import { grantCreateToken, peekCreateToken, revokeCreateToken } from "@/services/create-token";
import { PROVIDER_BUDGET_SETTING, ProviderBudgetExceededError, setProviderBudget } from "@/services/provider-budget";
import { getSpendPreview } from "@/app/actions/spending";

/**
 * QĐ-154: "Chưa được phép gọi API thật của runway/h3_max:480x854" although the
 * person had confirmed the clip's price in the Storyboard. Real-mode gate, no
 * network: assertCanSpend never sends anything, so $0.
 */

const MODEL = "h3_max:480x854";
const REQ = { provider: "runway", model: MODEL, estimatedCost: 0.25 };
const WORK = { sceneId: "scene-qd154", kind: "video" };
const KEYS = [SPEND_CAP_SETTING, SPEND_CONFIRM_SETTING, PROVIDER_BUDGET_SETTING];
let saved: { key: string; valueJson: string }[] = [];
const prevMock = process.env.AI_MOCK_MODE;

async function setConfirmed(list: string[]): Promise<void> {
  const valueJson = JSON.stringify(list);
  await prisma.setting.upsert({ where: { key: SPEND_CONFIRM_SETTING }, create: { key: SPEND_CONFIRM_SETTING, valueJson }, update: { valueJson } });
}
async function setCap(cap: number): Promise<void> {
  const valueJson = JSON.stringify(cap);
  await prisma.setting.upsert({ where: { key: SPEND_CAP_SETTING }, create: { key: SPEND_CAP_SETTING, valueJson }, update: { valueJson } });
}
const permit = (over: Partial<{ provider: string; model: string; sceneId: string; kind: string; maxCost: number }> = {}) =>
  grantCreateToken({ provider: "runway", model: MODEL, sceneId: WORK.sceneId, kind: "video", maxCost: 0.25, note: "test QĐ-154", ...over });

beforeAll(async () => {
  saved = await prisma.setting.findMany({ where: { key: { in: KEYS } }, select: { key: true, valueJson: true } });
  const seed = SEED_MODELS.find((m) => m.provider === "runway" && m.modelId === MODEL)!;
  await prisma.modelRegistry.upsert({
    where: { provider_modelId: { provider: "runway", modelId: MODEL } },
    create: { ...(seed as never), enabled: true },
    update: {},
  });
  process.env.AI_MOCK_MODE = "false";
  resetEnvCache();
});

beforeEach(async () => {
  await revokeCreateToken();
  await setConfirmed(["runway/h3_max:768x1280"]);
  await setCap(15);
  await setProviderBudget({ provider: "runway", available: 245, unit: "credits", usdPerUnit: 0.01, source: "DECLARED" });
});

afterAll(async () => {
  await revokeCreateToken();
  await prisma.setting.deleteMany({ where: { key: { in: KEYS } } });
  for (const s of saved) await prisma.setting.create({ data: s });
  process.env.AI_MOCK_MODE = prevMock;
  resetEnvCache();
});

describe("QĐ-154 — ổ khoá 'model đã được cho phép'", () => {
  it("chưa xác nhận gì → chặn, nói rõ hai cách cho phép, không gửi gì", async () => {
    const err = await assertCanSpend(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderNotConfirmedError);
    expect(String((err as Error).message)).toMatch(/Xác nhận tạo video/);
    expect(String((err as Error).message)).toMatch(/Nhà cung cấp AI.*Tôi xác nhận cho phép/);
    // Asked for consent but no permit was ever granted.
    await expect(assertCanSpend({ ...REQ, consent: WORK })).rejects.toBeInstanceOf(ProviderNotConfirmedError);
  });

  it("xác nhận giá ở Storyboard (permit đúng cảnh/model/giá) → qua cổng cho ĐÚNG lần đó; danh sách không đổi, permit chưa bị tiêu", async () => {
    await permit();
    await expect(assertCanSpend({ ...REQ, consent: WORK })).resolves.toBeTruthy();
    expect(await confirmedProviders()).toEqual(["runway/h3_max:768x1280"]);
    expect(await peekCreateToken()).not.toBeNull();
    // Without the consent context (e.g. a batch job) the permit does not count.
    await expect(assertCanSpend(REQ)).rejects.toBeInstanceOf(ProviderNotConfirmedError);
  });

  it("permit cho model / cảnh / loại khác, hoặc giá vượt mức đã xác nhận → vẫn chặn", async () => {
    await permit({ model: "wan3:480x854" });
    await expect(assertCanSpend({ ...REQ, consent: WORK })).rejects.toBeInstanceOf(ProviderNotConfirmedError);
    await permit({ sceneId: "another-scene" });
    await expect(assertCanSpend({ ...REQ, consent: WORK })).rejects.toBeInstanceOf(ProviderNotConfirmedError);
    await permit({ kind: "image" });
    await expect(assertCanSpend({ ...REQ, consent: WORK })).rejects.toBeInstanceOf(ProviderNotConfirmedError);
    await permit({ maxCost: 0.2 });
    await expect(assertCanSpend({ ...REQ, consent: WORK })).rejects.toBeInstanceOf(ProviderNotConfirmedError);
  });

  it("đã xác nhận nhưng không đủ ngân sách: hạn mức tổng và ví Runway vẫn chặn", async () => {
    await permit();
    await setCap(0.1);
    await expect(assertCanSpend({ ...REQ, consent: WORK })).rejects.toBeInstanceOf(SpendCapExceededError);
    await setCap(15);
    await setProviderBudget({ provider: "runway", available: 10, unit: "credits", usdPerUnit: 0.01, source: "DECLARED" });
    await expect(assertCanSpend({ ...REQ, consent: WORK })).rejects.toBeInstanceOf(ProviderBudgetExceededError);
  });

  it("model đã cho phép lâu dài → qua cổng không cần permit (lô, tạo lại cảnh)", async () => {
    await setConfirmed(["runway/h3_max:768x1280", `runway/${MODEL}`]);
    await expect(assertCanSpend(REQ)).resolves.toBeTruthy();
  });

  it("lệnh chặn của cổng chi tiền không bao giờ là lý do thử model trả phí khác", async () => {
    const refusals = [
      await assertCanSpend(REQ).catch((e: unknown) => e),
      new SpendCapExceededError("cap", 1, 1, 2),
      new ProviderBudgetExceededError("wallet", "runway", 0.1, 0.25),
    ];
    for (const e of refusals) expect(isSpendRefusal(e)).toBe(true);
    const tokenErr = Object.assign(new Error("no permit"), { name: "CreateTokenError" });
    expect(isSpendRefusal(tokenErr)).toBe(true);
    expect(isSpendRefusal(new ProviderError("timeout", "runway", true))).toBe(false);
  });
});

describe("QĐ-154 — trang Nhà cung cấp AI có giá cho model video", () => {
  it("h3_max:480x854: loại video, $0.05/giây, 1 clip 5 giây ≈ $0.25", async () => {
    const p = await getSpendPreview("runway", MODEL);
    expect(p?.type).toBe("video");
    expect(p?.priceLabel).toBe("$0.05 / giây video");
    expect(p?.perUseLabel).toBe("Ước tính / 1 clip 5 giây");
    expect(p?.estimatedPerUse).toBeCloseTo(0.25, 6);
    expect(p?.confirmed).toBe(false);
    expect(p?.mockMode).toBe(false);
  });
});
