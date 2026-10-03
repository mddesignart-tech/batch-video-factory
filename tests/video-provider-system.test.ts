import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { explainIncapable, isCapable, routeScene, RoutingError, type RouteContext } from "@/services/ai-router";
import {
  effectiveProfile,
  routingModeChange,
  routingModeOf,
  storedProfile,
} from "@/domain/video-model-profile";
import { VIDEO_ADAPTERS, hasVideoAdapter } from "@/providers/video-adapters";
import { VIDEO_PROVIDERS } from "@/providers/video-config";
import {
  listVideoModels,
  registerDiscoveredVideoModel,
  saveVideoCapabilityProfile,
  setDefaultVideoModel,
  setVideoRoutingMode,
  testVideoProviderConnection,
} from "@/services/video-model-admin";
import { createContentProject, approveContentScript } from "@/services/content-service";
import { previewProjectCost } from "@/services/project-service";
import { profileFromPlatform } from "@/domain/platform-profile";
import { makePng, seedMock } from "./phase5-helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * EXTENSIBLE AI VIDEO PROVIDER SYSTEM: adapters in one registry, model
 * capabilities as data, routing modes a person controls - and no change at all
 * for a model that has no capability profile.
 */

function model(over: Partial<ModelRegistry> & { modelId: string }): ModelRegistry {
  return {
    id: over.modelId,
    provider: "vendor-a",
    displayName: over.modelId,
    type: "video",
    enabled: true,
    priceUnit: "per_second",
    price: 0.1,
    priceOutput: 0,
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    supportsReferenceImage: true,
    supportsCharacterReference: true,
    supportsInputFidelity: false,
    supportsAudio: false,
    supports1080p: false,
    supportsUpscale: false,
    supportsVoiceInstructions: false,
    maxDuration: 10,
    qualityRating: 6,
    speedRating: 6,
    consistencyRating: 6,
    historicalSuccessRate: 1,
    capabilityProfileJson: null,
    lifecycle: "ACTIVE",
    providerModelKey: null,
    verification: "BENCHMARK_VERIFIED",
    verificationNote: "",
    verifiedAt: null,
    existenceSource: "MANUAL_DOCS",
    existenceCheckedAt: null,
    pricingSource: "MANUAL_DOCS",
    pricingCheckedAt: null,
    capabilitySource: "MANUAL_DOCS",
    sourceNote: "",
    maxConcurrent: null,
    maxDaily: null,
    reliability: "OK",
    reliabilityNote: "",
    reliabilityUpdatedAt: null,
    deprecationDate: null,
    shutdownDate: null,
    replacementNote: "",
    lastVerifiedAt: null,
    notes: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ModelRegistry;
}

function ctx(over: Partial<RouteContext> = {}): RouteContext {
  return {
    type: "video",
    qualityMode: "BALANCED",
    strategy: "AUTO",
    complexity: "MEDIUM",
    spendPriority: "NORMAL",
    durationSeconds: 4,
    characterCount: 1,
    consistencyRequired: true,
    needs1080p: false,
    needsReferenceImage: false,
    frameAspect: "9:16",
    budgetRemaining: 10,
    usage: { seconds: 4, jobs: 1 },
    availableProviders: ["vendor-a", "vendor-b"],
    ...over,
  };
}

describe("ADAPTER REGISTRY", () => {
  it("nhà cung cấp video = đúng các adapter đã đăng ký; thêm một provider = thêm một dòng", () => {
    expect([...VIDEO_PROVIDERS].sort()).toEqual(Object.keys(VIDEO_ADAPTERS).sort());
    expect(hasVideoAdapter("runway")).toBe(true);
    expect(hasVideoAdapter("future-vendor")).toBe(false);
  });
});

describe("CAPABILITY PROFILE + ROUTING", () => {
  const A = model({ modelId: "a:720x1280", qualityRating: 7 });
  const B = model({ modelId: "b:720x1280", provider: "vendor-b", price: 0.05, qualityRating: 6 });

  it("không có hồ sơ = suy ra từ cột cũ, định tuyến y như trước (legacy)", () => {
    const p = effectiveProfile(A);
    expect(p.inferred).toBe(true);
    expect(p.supportedAspectRatios).toEqual(["9:16"]);
    const before = routeScene([A, B], ctx());
    const withType = routeScene([A, B], ctx({ contentType: "PRODUCT_REVIEW" }));
    expect(withType.modelId).toBe(before.modelId);
    expect(withType.estimatedCost).toBe(before.estimatedCost);
  });

  it("tỷ lệ không hỗ trợ (hồ sơ chỉ ghi 16:9) → không dùng cho video dọc, nói rõ lý do", () => {
    const wideOnly = model({ modelId: "wide", capabilityProfileJson: JSON.stringify({ supportedAspectRatios: ["16:9"] }) });
    expect(isCapable(wideOnly, ctx())).toBe(false);
    expect(explainIncapable(wideOnly, ctx())).toMatch(/9:16/);
    expect(isCapable(wideOnly, ctx({ frameAspect: "16:9" }))).toBe(true);
  });

  it("thời lượng vượt danh sách nhà cung cấp nhận → không dùng", () => {
    const short = model({ modelId: "short", capabilityProfileJson: JSON.stringify({ supportedDurations: [4] }) });
    expect(isCapable(short, ctx({ durationSeconds: 4 }))).toBe(true);
    expect(isCapable(short, ctx({ durationSeconds: 6 }))).toBe(false);
  });

  it("model bị tắt / DISABLED không bao giờ được chọn", () => {
    const off = model({ modelId: "off", enabled: false });
    expect(isCapable(off, ctx())).toBe(false);
    const disabled = model({ modelId: "dis", lifecycle: "DISABLED" });
    expect(() => routeScene([disabled], ctx())).toThrow(RoutingError);
  });

  it("PIN_ONLY không tự gọi; chọn tay thì được", () => {
    const pin = model({ modelId: "pin", lifecycle: "PIN_ONLY" });
    expect(() => routeScene([pin], ctx())).toThrow(RoutingError);
    const manual = routeScene([pin], ctx({ manualProvider: "vendor-a", manualModel: "pin" }));
    expect(manual.modelId).toBe("pin");
  });

  it("DEPRECATED: không tự chọn; chọn tay vẫn chạy nhưng có cảnh báo", () => {
    const old = model({ modelId: "old", lifecycle: "DEPRECATED", replacementNote: "Dùng model mới." });
    expect(() => routeScene([old], ctx())).toThrow(RoutingError);
    const manual = routeScene([old], ctx({ manualProvider: "vendor-a", manualModel: "old" }));
    expect(manual.reason).toMatch(/NGỪNG DÙNG/);
  });

  it("nhà cung cấp không sẵn sàng → chỉ fallback sang model AUTO_OK khác, không bao giờ sang PIN_ONLY", () => {
    const pinB = model({ modelId: "pin-b", provider: "vendor-b", lifecycle: "PIN_ONLY", price: 0.01 });
    const autoB = model({ modelId: "auto-b", provider: "vendor-b", price: 0.08 });
    const decision = routeScene([A, pinB, autoB], ctx({ availableProviders: ["vendor-b"] }));
    expect(decision.modelId).toBe("auto-b");
    // Nothing AUTO_OK left: refuse (the caller turns this into VIDEO_MODEL_NEEDS_SELECTION).
    expect(() => routeScene([A, pinB], ctx({ availableProviders: ["vendor-b"] }))).toThrow(RoutingError);
  });

  it("điểm benchmark theo loại nội dung (productFidelity) chỉ tính khi có trong hồ sơ", () => {
    const faithful = model({
      modelId: "faithful:720x1280",
      provider: "vendor-b",
      qualityRating: 5,
      price: 0.1,
      capabilityProfileJson: JSON.stringify({ quality: { productFidelity: 10 } }),
    });
    const generic = model({ modelId: "generic:720x1280", qualityRating: 8, price: 0.1 });
    const product = routeScene([faithful, generic], ctx({ contentType: "PRODUCT_REVIEW", qualityMode: "QUALITY" }));
    expect(product.modelId).toBe("faithful:720x1280");
    const custom = routeScene([faithful, generic], ctx({ contentType: "CUSTOM", qualityMode: "QUALITY" }));
    expect(custom.modelId).toBe("generic:720x1280");
  });

  it("AUTO_OK chỉ sau benchmark; không bao giờ nới LOW_AUTO thành ACTIVE", () => {
    expect(routingModeChange({ lifecycle: "PIN_ONLY", enabled: true, verification: "UNVERIFIED", price: 0.1 }, "AUTO_OK").ok).toBe(false);
    expect(routingModeChange({ lifecycle: "PIN_ONLY", enabled: true, verification: "BENCHMARK_VERIFIED", price: 0 }, "AUTO_OK").ok).toBe(false);
    expect(routingModeChange({ lifecycle: "PIN_ONLY", enabled: true, verification: "BENCHMARK_VERIFIED", price: 0.1 }, "AUTO_OK")).toEqual({ ok: true, lifecycle: "ACTIVE", enabled: true });
    expect(routingModeChange({ lifecycle: "LOW_AUTO", enabled: true, verification: "BENCHMARK_VERIFIED", price: 0.4 }, "AUTO_OK")).toEqual({ ok: true, lifecycle: "LOW_AUTO", enabled: true });
    expect(routingModeOf("LOW_AUTO", true)).toBe("AUTO_OK");
    expect(routingModeOf("LOW_AUTO_CANDIDATE", true)).toBe("PIN_ONLY");
    expect(routingModeOf("ACTIVE", false)).toBe("DISABLED");
  });
});

describe("VIDEO AI ADMIN (DB, mock)", () => {
  beforeAll(async () => {
    await seedMock();
  });

  it("model mới phát hiện: TẮT + PIN_ONLY + chưa giá → không tự định tuyến; AUTO_OK bị từ chối khi chưa benchmark", async () => {
    const id = `disc-${randomUUID().slice(0, 6)}`;
    const row = await registerDiscoveredVideoModel({ provider: "mock", modelId: id });
    expect(row.enabled).toBe(false);
    expect(row.lifecycle).toBe("PIN_ONLY");
    expect(row.price).toBe(0);
    await expect(setVideoRoutingMode(row.id, "AUTO_OK")).rejects.toThrow(/benchmark/);
    const listed = (await listVideoModels()).find((m) => m.id === row.id)!;
    expect(listed.routingMode).toBe("DISABLED");

    await prisma.modelRegistry.update({ where: { id: row.id }, data: { verification: "BENCHMARK_VERIFIED", price: 0.05 } });
    await setVideoRoutingMode(row.id, "AUTO_OK");
    expect((await prisma.modelRegistry.findUniqueOrThrow({ where: { id: row.id } })).lifecycle).toBe("ACTIVE");
    await setVideoRoutingMode(row.id, "DEPRECATED");
    expect((await listVideoModels()).find((m) => m.id === row.id)!.routingMode).toBe("DEPRECATED");
    await setVideoRoutingMode(row.id, "DISABLED");
    expect((await prisma.modelRegistry.findUniqueOrThrow({ where: { id: row.id } })).enabled).toBe(false);
  });

  it("đặt mặc định chỉ một model; hồ sơ khả năng được kiểm tra trước khi lưu", async () => {
    const a = await registerDiscoveredVideoModel({ provider: "mock", modelId: `def-a-${randomUUID().slice(0, 6)}` });
    const b = await registerDiscoveredVideoModel({ provider: "mock", modelId: `def-b-${randomUUID().slice(0, 6)}` });
    await setDefaultVideoModel(a.id);
    await setDefaultVideoModel(b.id);
    const rows = await prisma.modelRegistry.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows.filter((r) => storedProfile(r.capabilityProfileJson)?.isDefault).map((r) => r.id)).toEqual([b.id]);
    await expect(saveVideoCapabilityProfile(a.id, { supportedAspectRatios: ["dọc"] })).rejects.toThrow(/không hợp lệ/);
    await saveVideoCapabilityProfile(a.id, { supportedAspectRatios: ["9:16", "16:9"], credits: 40, billingUnit: "5s" });
    expect(storedProfile((await prisma.modelRegistry.findUniqueOrThrow({ where: { id: a.id } })).capabilityProfileJson)?.credits).toBe(40);
  });

  it("Kiểm tra kết nối không tạo request trả phí nào", async () => {
    const before = await prisma.providerJob.count();
    const r = await testVideoProviderConnection("runway");
    expect(r.paidRequests).toBe(0);
    expect(r.ok).toBe(true); // mock mode: nothing leaves the machine
    expect(await prisma.providerJob.count()).toBe(before);
  });

  it("LOCAL_MOTION là route độc lập: cảnh dùng ảnh thật không cần model video nào", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vps-"));
    const bytes = fs.readFileSync(await makePng(tmp, "orange", "1000x1000"));
    const project = await createContentProject({
      contentType: "PRODUCT_REVIEW",
      sourceType: "ASSETS",
      subjectName: "Ghế gấp",
      uploads: [{ bytes, filename: "ghe.png" }],
      durationSeconds: 15,
      outputProfile: profileFromPlatform("TIKTOK"),
    });
    await approveContentScript(project.id);
    const preview = await previewProjectCost(project.id);
    const scenes = await prisma.scene.findMany({ where: { projectId: project.id } });
    for (const plan of preview.current.scenes) {
      const scene = scenes.find((s) => s.sceneNumber === plan.sceneNumber)!;
      if (scene.motionMode === "LOCAL_MOTION") {
        expect(plan.motionSource).toBe("LOCAL_MOTION");
        expect(plan.video).toBeFalsy();
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
