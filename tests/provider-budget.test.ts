import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  addProviderBudget,
  assertProviderBudget,
  defaultBudgets,
  getProviderBudgets,
  PROVIDER_BUDGET_SETTING,
  ProviderBudgetExceededError,
  providerSpendBreakdown,
  setProviderBudget,
} from "@/services/provider-budget";

/**
 * One wallet per provider, never added together.
 *
 * The mistake these tests exist to prevent is specific and expensive: $6 topped
 * up at OpenAI buys nothing at Runway, and a guard that saw one pool would
 * authorise a Sora call against Runway credits. The vendor would then refuse
 * with a 402, after the guard had called it affordable.
 */

beforeEach(async () => {
  await prisma.setting.deleteMany({ where: { key: PROVIDER_BUDGET_SETTING } });
  await prisma.costEntry.deleteMany({});
});

describe("wallets are separate", () => {
  it("does not let one provider spend another's money", async () => {
    // Runway is empty; OpenAI is flush. A single-pool guard would allow this.
    await setProviderBudget({ provider: "openai", available: 6, unit: "usd" });
    await setProviderBudget({
      provider: "runway",
      available: 0,
      unit: "credits",
      usdPerUnit: 0.01,
    });

    await expect(
      assertProviderBudget({
        provider: "runway",
        model: "gen4_turbo:720x1280",
        estimatedCost: 0.25,
      }),
    ).rejects.toThrow(ProviderBudgetExceededError);

    // ... while OpenAI, which actually has the money, is fine.
    await expect(
      assertProviderBudget({
        provider: "openai",
        model: "sora-2:720x1280",
        estimatedCost: 0.4,
      }),
    ).resolves.toBeUndefined();
  });

  it("says plainly that another vendor's money cannot be used here", async () => {
    await setProviderBudget({
      provider: "runway",
      available: 0,
      unit: "credits",
      usdPerUnit: 0.01,
    });
    await expect(
      assertProviderBudget({
        provider: "runway",
        model: "gen4_turbo",
        estimatedCost: 0.25,
      }),
    ).rejects.toThrow(/tiền ở nhà cung cấp khác không dùng được ở đây/);
  });

  it("converts credits to dollars at the vendor's own rate", async () => {
    // 25 credits bought a 5-second clip for $0.25 - measured, not assumed.
    await setProviderBudget({
      provider: "runway",
      available: 30,
      unit: "credits",
      usdPerUnit: 0.01,
    });
    await expect(
      assertProviderBudget({ provider: "runway", model: "m", estimatedCost: 0.25 }),
    ).resolves.toBeUndefined();
    await expect(
      assertProviderBudget({ provider: "runway", model: "m", estimatedCost: 0.35 }),
    ).rejects.toThrow(ProviderBudgetExceededError);
  });
});

describe("providers the vendor meters itself", () => {
  it("does not block a provider billed on its own quota", async () => {
    // Groq enforces its own plan. Inventing a limit here would refuse work for
    // a reason this tool cannot actually know about.
    await setProviderBudget({ provider: "groq", available: 0, unit: "external" });
    await expect(
      assertProviderBudget({ provider: "groq", model: "gpt-oss", estimatedCost: 5 }),
    ).resolves.toBeUndefined();
  });

  it("does not block a provider with no wallet recorded at all", async () => {
    await expect(
      assertProviderBudget({ provider: "unknown-co", model: "m", estimatedCost: 99 }),
    ).resolves.toBeUndefined();
  });
});

describe("topping up", () => {
  it("adds to the existing balance rather than replacing it", async () => {
    await setProviderBudget({ provider: "openai", available: 2, unit: "usd" });
    await addProviderBudget("openai", 6);
    const rows = await getProviderBudgets();
    expect(rows.find((b) => b.provider === "openai")?.available).toBe(8);
  });

  it("leaves every other wallet untouched", async () => {
    await setProviderBudget({
      provider: "runway",
      available: 975,
      unit: "credits",
      usdPerUnit: 0.01,
    });
    await addProviderBudget("openai", 6);
    const rows = await getProviderBudgets();
    expect(rows.find((b) => b.provider === "runway")?.available).toBe(975);
    expect(rows.find((b) => b.provider === "runway")?.unit).toBe("credits");
  });

  it("never goes negative", async () => {
    await setProviderBudget({ provider: "openai", available: -5, unit: "usd" });
    const rows = await getProviderBudgets();
    expect(rows.find((b) => b.provider === "openai")?.available).toBe(0);
  });
});

describe("defaults and recovery", () => {
  it("ships defaults that already separate the three vendors", () => {
    const rows = defaultBudgets();
    expect(rows.find((b) => b.provider === "openai")?.unit).toBe("usd");
    expect(rows.find((b) => b.provider === "runway")?.unit).toBe("credits");
    expect(rows.find((b) => b.provider === "groq")?.unit).toBe("external");
  });

  it("falls back to defaults when the stored value is corrupt", async () => {
    await prisma.setting.upsert({
      where: { key: PROVIDER_BUDGET_SETTING },
      create: { key: PROVIDER_BUDGET_SETTING, valueJson: "{ not json" },
      update: { valueJson: "{ not json" },
    });
    const rows = await getProviderBudgets();
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("the breakdown", () => {
  it("reports each provider's spend separately", async () => {
    await prisma.costEntry.createMany({
      data: [
        { category: "image", provider: "openai", model: "gpt-image-2", amount: 1.2 },
        { category: "video", provider: "runway", model: "gen4_turbo", amount: 0.25 },
        { category: "text", provider: "groq", model: "gpt-oss", amount: 0.03 },
      ],
    });
    const rows = await providerSpendBreakdown();
    expect(rows.find((r) => r.provider === "openai")?.spentUsd).toBeCloseTo(1.2, 6);
    expect(rows.find((r) => r.provider === "runway")?.spentUsd).toBeCloseTo(0.25, 6);
    expect(rows.find((r) => r.provider === "groq")?.spentUsd).toBeCloseTo(0.03, 6);
  });

  it("returns NO combined total field to be misread", async () => {
    // The absence is the feature. A caller wanting one number across vendors is
    // about to make the mistake this module exists to prevent.
    const rows = await providerSpendBreakdown();
    for (const row of rows) {
      expect(row).not.toHaveProperty("totalAvailable");
      expect(row).not.toHaveProperty("combinedRemaining");
    }
  });

  it("leaves remaining as null for a vendor that meters itself", async () => {
    await setProviderBudget({ provider: "groq", available: 0, unit: "external" });
    const rows = await providerSpendBreakdown();
    expect(rows.find((r) => r.provider === "groq")?.remainingUsd).toBeNull();
  });

  it("excludes mock, which is not money", async () => {
    await prisma.costEntry.create({
      data: { category: "video", provider: "mock", model: "mock-video", amount: 0 },
    });
    const rows = await providerSpendBreakdown();
    expect(rows.some((r) => r.provider === "mock")).toBe(false);
  });
});

describe("declared balance versus live balance", () => {
  /**
   * A number the operator typed and a number read back from the vendor are
   * different kinds of fact. Presenting the first as the second is how someone
   * plans a render against money that was spent last week.
   */
  it("marks Runway as readable, because GET /organization returns one", async () => {
    const rows = defaultBudgets();
    expect(rows.find((b) => b.provider === "runway")?.liveBalanceAvailable).toBe(true);
  });

  it("marks OpenAI as declared, because an API key cannot read the balance", async () => {
    const rows = defaultBudgets();
    expect(rows.find((b) => b.provider === "openai")?.liveBalanceAvailable).toBe(false);
  });

  it("defaults a NEW wallet to declared, never to live", async () => {
    // Assuming otherwise would label a typed figure as if it had been verified.
    await setProviderBudget({ provider: "brand-new", available: 10, unit: "usd" });
    const rows = await getProviderBudgets();
    expect(rows.find((b) => b.provider === "brand-new")?.liveBalanceAvailable).toBe(
      false,
    );
  });

  it("treats a stored record with the flag missing as declared", async () => {
    await prisma.setting.upsert({
      where: { key: PROVIDER_BUDGET_SETTING },
      create: {
        key: PROVIDER_BUDGET_SETTING,
        valueJson: JSON.stringify([{ provider: "openai", available: 6, unit: "usd" }]),
      },
      update: {
        valueJson: JSON.stringify([{ provider: "openai", available: 6, unit: "usd" }]),
      },
    });
    const rows = await getProviderBudgets();
    expect(rows.find((b) => b.provider === "openai")?.liveBalanceAvailable).toBe(false);
  });
});
