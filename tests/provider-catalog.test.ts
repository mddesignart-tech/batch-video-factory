import type { ModelRegistry } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  autoRouteBlock,
  cachedCatalog,
  reconcileRegistry,
  applyCatalogToRegistry,
  recordVerification,
  VERIFICATION_STATES,
  type Catalog,
} from "@/services/provider-catalog";
import {
  allowedDurationsFor,
  billedVideoSeconds,
  H3_MAX_MIN_SECONDS,
  H3_MAX_MAX_SECONDS,
  WAN3_MAX_SECONDS,
} from "@/domain/video-duration";
import { SEED_MODELS } from "@/data/seed-config";

/**
 * The model registry's three axes, and the ways each one has failed.
 *
 *   existence    does the account actually list this model
 *   lifecycle    has the vendor retired it
 *   reliability  what did our own paid runs do
 *
 * Plus the provenance of every fact, which is the point of the whole exercise:
 * Runway serves NO pricing or capability endpoint (GET /models is a 404), so a
 * price sitting in the registry is somebody's typing, not the vendor's word.
 * Code that cannot tell those apart will eventually treat a stale guess as a
 * measurement.
 */

afterAll(async () => {
  await prisma.modelRegistry.deleteMany({ where: { modelId: { startsWith: "test-" } } });
  await prisma.providerCatalogSnapshot.deleteMany({
    where: { provider: { startsWith: "test-" } },
  });
});

function liveCatalog(keys: string[]): Catalog {
  return {
    provider: "runway",
    source: "LIVE",
    fetchedAt: new Date(),
    ageMs: 0,
    endpoint: "/organization",
    models: keys.map((key) => ({ key, maxConcurrent: 1, maxDaily: 50 })),
    creditBalance: 831,
  };
}

describe("chặn định tuyến tự động", () => {
  const base = {
    lifecycle: "ACTIVE",
    reliability: "OK",
    shutdownDate: null as Date | null,
  };

  it("cho phép model bình thường", () => {
    expect(autoRouteBlock(base)).toBeNull();
  });

  it("ngày tắt đã qua thì chặn, BẤT KỂ nhãn vòng đời nói gì", () => {
    // The whole point. A row can read ACTIVE simply because nobody has edited
    // it since the vendor's announcement; the date is the fact, the label is an
    // opinion, and believing the label costs a failed paid call to discover.
    const dead = { ...base, shutdownDate: new Date("2020-01-01") };
    expect(autoRouteBlock(dead)).toContain("đã tắt");
  });

  it("ngày tắt trong tương lai thì chưa chặn", () => {
    const future = new Date(Date.now() + 90 * 24 * 3600 * 1000);
    expect(autoRouteBlock({ ...base, shutdownDate: future })).toBeNull();
  });

  it("chặn theo vòng đời và theo độ tin cậy", () => {
    expect(autoRouteBlock({ ...base, lifecycle: "PIN_ONLY" })).toContain("PIN_ONLY");
    // DEPRECATED gets its own wording, in the operator's language and with the
    // shutdown date when there is one. "no model available" would send someone
    // hunting through the registry for a row that is sitting right there.
    expect(autoRouteBlock({ ...base, lifecycle: "DEPRECATED" })).toContain(
      "NGỪNG DÙNG",
    );
    expect(
      autoRouteBlock({
        ...base,
        lifecycle: "DEPRECATED",
        shutdownDate: new Date("2026-09-24"),
      }),
    ).toContain("2026-09-24");
    expect(autoRouteBlock({ ...base, reliability: "DEGRADED" })).toContain("DEGRADED");
  });
});

describe("seed KHÔNG được hồi sinh model đã ngừng dùng", () => {
  it("không ghi lifecycle khi seed không có ý kiến", async () => {
    // This is the bug that made the whole exercise necessary: the update branch
    // wrote `model.lifecycle ?? "ACTIVE"`, so a seed row that said nothing about
    // lifecycle overwrote a stored DEPRECATED with ACTIVE. One `npm run seed`
    // handed a retired model straight back to the router.
    const modelId = "test-retired";
    await prisma.modelRegistry.create({
      data: {
        provider: "runway",
        modelId,
        displayName: modelId,
        type: "video",
        priceUnit: "per_second",
        price: 0.05,
        lifecycle: "DEPRECATED",
        shutdownDate: new Date("2026-01-01"),
      },
    });

    // The shape the seed uses for a row with no lifecycle opinion.
    const seedRowWithoutOpinion: { lifecycle?: string } = {};
    await prisma.modelRegistry.updateMany({
      where: { provider: "runway", modelId },
      data: {
        displayName: modelId,
        ...(seedRowWithoutOpinion.lifecycle
          ? { lifecycle: seedRowWithoutOpinion.lifecycle }
          : {}),
      },
    });

    const row = await prisma.modelRegistry.findFirst({ where: { modelId } });
    expect(row?.lifecycle).toBe("DEPRECATED");
    expect(autoRouteBlock(row as ModelRegistry)).not.toBeNull();
  });

  it("seed không bao giờ chạm vào reliability", () => {
    // Reliability is earned from our own paid runs. A seed file has nothing to
    // say about it, and gen4_turbo's DEGRADED must survive any number of seeds.
    const seedSource = SEED_MODELS as unknown as Array<Record<string, unknown>>;
    for (const model of seedSource) {
      expect(model.reliability).toBeUndefined();
    }
  });
});

describe("nguồn gốc dữ liệu", () => {
  it("giá và khả năng trong seed luôn là MANUAL_DOCS", () => {
    // Runway serves no pricing or capability endpoint at all. A seed row
    // claiming an account-listing source for either would be claiming something
    // no API can back up. The value is named after where it really came from -
    // documentation - rather than "LIVE", which was read as "verified against
    // GET /models", an endpoint that answers 404.
    for (const model of SEED_MODELS) {
      if (model.pricingSource) {
        expect(model.pricingSource).toBe("MANUAL_DOCS");
      }
      if (model.capabilitySource) {
        expect(model.capabilitySource).toBe("MANUAL_DOCS");
      }
    }
  });

  it("chỉ dữ liệu LIVE mới được đóng dấu vào registry", async () => {
    const stale: Catalog = {
      ...liveCatalog(["wan3"]),
      source: "CACHE",
      ageMs: 86_400_000,
    };
    // Stamping "confirmed" from a cached snapshot would turn a day-old reading
    // into a present-tense claim about the account.
    await expect(applyCatalogToRegistry(stale)).rejects.toMatchObject({
      code: "not_live",
    });
  });

  it("bản cache luôn mang nhãn CACHE và tuổi của nó", async () => {
    const fetchedAt = new Date(Date.now() - 3_600_000);
    await prisma.providerCatalogSnapshot.create({
      data: {
        provider: "test-cache",
        payloadJson: JSON.stringify({
          tier: { models: { wan3: { maxConcurrentGenerations: 1, maxDailyGenerations: 50 } } },
        }),
        modelKeysJson: JSON.stringify(["wan3"]),
        endpoint: "/organization",
        fetchedAt,
      },
    });
    const cached = await cachedCatalog("test-cache");
    expect(cached?.source).toBe("CACHE");
    expect(cached?.ageMs).toBeGreaterThan(3_000_000);
    // Credit balance is deliberately not served from cache: a stale number
    // masquerading as a balance is worse than no number.
    expect(cached?.creditBalance).toBeNull();
  });

  it("báo model có trong registry nhưng KHÔNG có trong tài khoản", async () => {
    await prisma.modelRegistry.create({
      data: {
        provider: "runway",
        modelId: "test-ghost:720x1280",
        providerModelKey: "test-ghost",
        displayName: "ghost",
        type: "video",
        priceUnit: "per_second",
        price: 0.05,
      },
    });
    const rows = await reconcileRegistry(liveCatalog(["wan3", "gen4_turbo"]));
    const ghost = rows.find((r) => r.modelId === "test-ghost:720x1280");
    expect(ghost?.confirmed).toBe(false);
    expect(ghost?.problem).toContain("KHÔNG có");
  });
});

describe("độ dài clip của các ứng viên", () => {
  it("h3_max nhận 5-15 giây, không phải khoảng của gen4.5", () => {
    const allowed = allowedDurationsFor("runway", "h3_max");
    expect(allowed?.[0]).toBe(H3_MAX_MIN_SECONDS);
    expect(allowed?.[allowed.length - 1]).toBe(H3_MAX_MAX_SECONDS);
  });

  it("wan3 nhận tới 30 giây", () => {
    const allowed = allowedDurationsFor("runway", "wan3");
    expect(allowed?.[allowed.length - 1]).toBe(WAN3_MAX_SECONDS);
  });

  it("KHÔNG kẹp mọi model per-second vào khoảng 2-10 của gen4.5", () => {
    // The hardcoded 2-10 was correct while gen4.5 was the only per-second
    // model. Adding siblings made it wrong in both directions: it would quote a
    // 12-second h3_max clip as 10 - under-billing a request the vendor accepts.
    expect(
      billedVideoSeconds({
        provider: "runway",
        model: "h3_max:768x1280",
        size: "768x1280",
        requestedSeconds: 12,
        hasKeyframe: true,
      }),
    ).toBe(12);

    expect(
      billedVideoSeconds({
        provider: "runway",
        model: "wan3:720x1280",
        size: "720x1280",
        requestedSeconds: 20,
        hasKeyframe: true,
      }),
    ).toBe(20);
  });

  it("cảnh LOW 5 giây đi thẳng vào h3_max, không đệm, không cắt", () => {
    // Our LOW scenes are written at exactly 5s (QĐ-030), which is h3_max's
    // floor. Nothing is padded and no paid second is thrown away.
    expect(
      billedVideoSeconds({
        provider: "runway",
        model: "h3_max:768x1280",
        size: "768x1280",
        requestedSeconds: 5,
        hasKeyframe: true,
      }),
    ).toBe(5);
  });

  it("gen4_turbo vẫn giữ nguyên bậc 5/10", () => {
    // The new per-second models must not leak their behaviour into the model
    // that genuinely quantises.
    expect(
      billedVideoSeconds({
        provider: "runway",
        model: "gen4_turbo:720x1280",
        size: "720x1280",
        requestedSeconds: 6,
        hasKeyframe: true,
      }),
    ).toBe(10);
  });
});

describe("giá một clip test", () => {
  it("khớp với biểu giá credit của Runway", () => {
    // 1 credit = $0.01. Cross-checked against the two models we have already
    // paid for: gen4_turbo 5 credits/s = $0.05, gen4.5 12 = $0.12. If those two
    // stop matching, the rest of the table is no longer trustworthy either.
    const price = (id: string): number =>
      SEED_MODELS.find((m) => m.modelId === id)?.price ?? -1;

    expect(price("gen4_turbo:720x1280")).toBeCloseTo(0.05, 6);
    expect(price("gen4.5:720x1280")).toBeCloseTo(0.12, 6);
    expect(price("h3_max:768x1280")).toBeCloseTo(0.08, 6);
    expect(price("h3_max:480x854")).toBeCloseTo(0.05, 6);
    expect(price("wan3:480x854")).toBeCloseTo(0.05, 6);
    expect(price("wan3:720x1280")).toBeCloseTo(0.1, 6);

    // One 5-second test clip on the recommended model.
    expect(price("h3_max:768x1280") * 5).toBeCloseTo(0.4, 6);
  });

  it("ứng viên mới đều PIN_ONLY cho tới khi có benchmark", () => {
    // Cheap and unproven must not beat proven on price alone. Promotion to
    // ACTIVE is something a benchmark earns, not something a price wins.
    for (const id of [
      "wan3:480x854",
      "wan3:720x1280",
      "h3_max:480x854",
      "h3_max:768x1280",
      "veo3.1_fast:720x1280",
    ]) {
      const model = SEED_MODELS.find((m) => m.modelId === id);
      expect(model, id).toBeDefined();
      expect(model?.lifecycle, id).toBe("PIN_ONLY");
    }
  });
});

describe("gen4_turbo KHÔNG được hồi sinh bằng bất kỳ đường nào", () => {
  const MODEL = "test-degraded:720x1280";

  it("catalog refresh chỉ đóng dấu tồn tại, KHÔNG chạm reliability", async () => {
    await prisma.modelRegistry.create({
      data: {
        provider: "runway",
        modelId: MODEL,
        providerModelKey: "test-degraded",
        displayName: MODEL,
        type: "video",
        priceUnit: "per_second",
        price: 0.05,
        reliability: "DEGRADED",
        reliabilityNote: "2 cảnh thất bại",
      },
    });

    // A catalogue refresh is about EXISTENCE. It confirms the account still
    // lists the model, which says nothing at all about whether the model
    // produces usable output - those are different questions and a refresh that
    // answered both would be answering one of them by accident.
    await applyCatalogToRegistry({
      provider: "runway",
      source: "LIVE",
      fetchedAt: new Date(),
      ageMs: 0,
      endpoint: "/organization",
      models: [{ key: "test-degraded", maxConcurrent: 1, maxDaily: 50 }],
      creditBalance: 831,
    });

    const row = await prisma.modelRegistry.findFirst({ where: { modelId: MODEL } });
    expect(row?.existenceSource).toBe("ACCOUNT_LISTING");
    expect(row?.reliability).toBe("DEGRADED");
    expect(autoRouteBlock(row as ModelRegistry)).toContain("DEGRADED");
  });

  it("xác minh benchmark KHÔNG gỡ được trạng thái DEGRADED", async () => {
    // Proving the pipe works is not the same as proving the model is well.
    // A benchmark of a degraded model must not quietly rehabilitate it.
    await recordVerification("runway", MODEL, "BENCHMARK_VERIFIED", "thử nghiệm");
    const row = await prisma.modelRegistry.findFirst({ where: { modelId: MODEL } });
    expect(row?.verification).toBe("BENCHMARK_VERIFIED");
    expect(row?.reliability).toBe("DEGRADED");
    expect(autoRouteBlock(row as ModelRegistry)).not.toBeNull();
  });

  it("trạng thái xác minh chỉ tiến, không lùi", async () => {
    // A later catalogue refresh must not knock a benchmarked model back to
    // CATALOG_LISTED: the clip still happened.
    const moved = await recordVerification(
      "runway",
      MODEL,
      "CATALOG_LISTED",
      "refresh danh mục",
    );
    expect(moved).toBe(false);
    const row = await prisma.modelRegistry.findFirst({ where: { modelId: MODEL } });
    expect(row?.verification).toBe("BENCHMARK_VERIFIED");
  });

  it("phân biệt 'có trong danh mục' với 'gọi được qua API'", () => {
    // The whole point of the vocabulary. Runway's /image_to_video serves
    // several vendors' models through one URL and they do NOT share a request
    // schema, so being listed is no evidence a create would be accepted.
    const order = [...VERIFICATION_STATES];
    expect(order.indexOf("CATALOG_LISTED")).toBeLessThan(
      order.indexOf("API_CREATE_VERIFIED"),
    );
    expect(order.indexOf("API_CREATE_VERIFIED")).toBeLessThan(
      order.indexOf("BENCHMARK_VERIFIED"),
    );
  });
});

describe("cờ RUNWAY_UNSUITABLE chỉ buộc tội họ model đã gây ra nó", () => {
  it("chặn Gen-4 nhưng KHÔNG chặn model hãng khác bán qua Runway", async () => {
    const { checkSuitability, RUNWAY_UNSUITABLE } = await import(
      "@/domain/video-suitability"
    );
    const flags = [RUNWAY_UNSUITABLE];

    // Earned by gen4_turbo on this scene.
    expect(
      checkSuitability({
        provider: "runway",
        model: "gen4_turbo:720x1280",
        complexity: "LOW",
        characterCount: 1,
        sceneFlags: flags,
      }).allowed,
    ).toBe(false);

    // h3_max is a MiniMax model that happens to be resold through the same
    // endpoint. It has never seen this scene and cannot have refused it.
    expect(
      checkSuitability({
        provider: "runway",
        model: "h3_max:768x1280",
        complexity: "LOW",
        characterCount: 1,
        sceneFlags: flags,
      }).allowed,
    ).toBe(true);
  });
});
