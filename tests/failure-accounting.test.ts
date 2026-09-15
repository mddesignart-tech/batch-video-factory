import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelRegistry } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTask } from "@/providers/runway/runway-video-client";
import { RunwayVideoProvider } from "@/providers/runway/runway-video-provider";
import type { VideoModelConfig } from "@/providers/video-config";
import { routeScene, RoutingError, type RouteContext } from "@/services/ai-router";
import { prisma } from "@/lib/prisma";
import { correctSettlement, reservationLedger, reserve } from "@/services/cost-reservation";
import {
  DEGRADED_AT,
  evaluateReliability,
  failureTally,
  fingerprintInput,
  isReliableForAuto,
  knownBadInput,
  recordFailureEvidence,
  reliabilityOf,
} from "@/services/model-reliability";
import {
  approveAuthorization,
  createAuthorization,
} from "@/services/batch-authorization";
import { getSpendCap, setSpendCap } from "@/services/spend-guard";

/**
 * Failure accounting: what a failed paid job costs, and what it teaches.
 *
 * Written after a real $0.25 that was never actually charged sat on the ledger
 * for a week. Runway answered the failed task with
 *
 *     { status: "FAILED", failureCode: "INTERNAL.BAD_OUTPUT.CODE01",
 *       cost: { credits: 0 } }
 *
 * and the system kept none of it. The code was folded into a prose message
 * ("An unexpected error occurred."), so the rule that bans a model from a scene
 * it has already refused had nothing to match on. The zero was read with a
 * truthy check, so "the vendor says it charged nothing" became "the vendor said
 * nothing" - and the settlement fell back to assuming the estimate was billed.
 *
 * Both halves are tested here, and both are about NOT LOSING A VALUE:
 *
 *   FAILED + failureCode - the vendor's machine code survives to the ledger
 *   FAILED + credits:0   - a reported zero stays a zero, and releases the money
 */

let server: http.Server;
let baseUrl = "";
let taskBody: Record<string, unknown> = {};
/** The global cap as this file found it. Restored in afterAll - see below. */
let originalSpendCap = 0;

function config(): VideoModelConfig {
  return {
    providerName: "runway",
    model: "gen4_turbo",
    apiKey: "test-key",
    baseUrl,
    pricePerSecond: 0.05,
    size: "720x1280",
    timeoutMs: 5000,
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(taskBody));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  originalSpendCap = await getSpendCap();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Tests share one database. Anything written here is removed, or the next
  // file inherits a model the router refuses to pick and fails for no reason.
  await prisma.modelFailureEvidence.deleteMany({
    where: { model: { startsWith: "test-" } },
  });
  await prisma.modelRegistry.deleteMany({ where: { modelId: { startsWith: "test-" } } });
  // The spend cap is a single shared setting, not per-file state. Leaving it
  // raised would quietly loosen every budget assertion that runs afterwards -
  // the kind of cross-file leak that makes a suite pass for the wrong reason.
  await setSpendCap(originalSpendCap);
});

describe("FAILED + failureCode", () => {
  it("giữ nguyên mã lỗi của nhà cung cấp, tách khỏi câu chữ", async () => {
    taskBody = {
      id: "t-fail",
      status: "FAILED",
      failure: "An unexpected error occurred.",
      failureCode: "INTERNAL.BAD_OUTPUT.CODE01",
    };
    const task = await getTask(config(), "t-fail");

    // The message is for a human; the code is what a rule reads. If these ever
    // collapse into one field again, the unsuitability rule goes dark.
    expect(task.failureCode).toBe("INTERNAL.BAD_OUTPUT.CODE01");
    expect(task.error).toBe("An unexpected error occurred.");
  });

  it("đưa mã lỗi qua provider tới JobStatus", async () => {
    taskBody = {
      id: "t-fail",
      status: "FAILED",
      failure: "An unexpected error occurred.",
      failureCode: "INTERNAL.BAD_OUTPUT.CODE01",
      cost: { credits: 0 },
    };
    const status = await new RunwayVideoProvider(config()).getJobStatus("t-fail");
    expect(status.state).toBe("failed");
    expect(status.failureCode).toBe("INTERNAL.BAD_OUTPUT.CODE01");
    expect(status.billedUnits).toBe(0);
  });

  it("không bịa mã lỗi khi nhà cung cấp im lặng", async () => {
    taskBody = { id: "t-fail", status: "FAILED", failure: "boom" };
    const status = await new RunwayVideoProvider(config()).getJobStatus("t-fail");
    expect(status.failureCode).toBeUndefined();
    // Unknown is not zero. Guessing "nothing was billed" here would hand back
    // budget for a clip that may well have been charged.
    expect(status.billedUnits).toBeNull();
  });
});

describe("FAILED + credits:0", () => {
  it("giữ số 0 do nhà cung cấp báo, không biến thành null", async () => {
    taskBody = { id: "t0", status: "FAILED", cost: { credits: 0 } };
    const task = await getTask(config(), "t0");
    expect(task.billedCredits).toBe(0);
    expect(task.billedCredits).not.toBeNull();
  });

  it("phân biệt 'báo 0' với 'không báo'", async () => {
    taskBody = { id: "t1", status: "FAILED" };
    expect((await getTask(config(), "t1")).billedCredits).toBeNull();

    taskBody = { id: "t2", status: "FAILED", cost: { credits: 0 } };
    expect((await getTask(config(), "t2")).billedCredits).toBe(0);

    taskBody = { id: "t3", status: "SUCCEEDED", cost: { credits: 25 } };
    expect((await getTask(config(), "t3")).billedCredits).toBe(25);
  });

  it("trả lại toàn bộ tiền đã giữ khi nhà cung cấp xác nhận không tính phí", async () => {
    const CEILING = 0.9;
    // The global cap sits above every batch ceiling; without room here the
    // approval is refused for an unrelated reason and proves nothing. Restored
    // in afterAll.
    await setSpendCap(50);
    const batch = await prisma.batch.create({
      data: { name: `test-batch-${Date.now()}`, maxCostPerVideo: 0.5 },
    });
    const batchId = batch.id;
    const auth = await createAuthorization({
      batchId,
      estimatedCost: 0.3,
      maxCostPerVideo: 0.5,
      providerScope: ["runway"],
      videoCount: 1,
      qualityMode: "BALANCED",
    });
    await approveAuthorization({ batchId, authorizedMaxSpend: CEILING });

    const key = `test-key-${Date.now()}`;
    await reserve(
      {
        idempotencyKey: key,
        batchId,
        kind: "video",
        provider: "runway",
        model: "test-gen4-turbo",
        estimatedCost: 0.25,
      },
      CEILING,
    );

    // The failure path settles it as billed, the way it did before the fix:
    // request left the machine, so assume the estimate was charged.
    await correctSettlement(key, { actualCost: 0.25, reason: "giả lập đoán mò" });
    expect((await reservationLedger(batchId, CEILING)).committed).toBeCloseTo(0.25, 6);

    // Then the vendor's own answer arrives: credits = 0.
    const result = await correctSettlement(key, {
      actualCost: 0,
      reason: "credits=0",
    });
    expect(result?.after).toBe(0);

    const ledger = await reservationLedger(batchId, CEILING);
    expect(ledger.committed).toBe(0);
    expect(ledger.reserved).toBe(0);
    // The whole ceiling is available again, which is the point: a failure that
    // cost nothing must not eat the batch's headroom.
    expect(ledger.available).toBe(CEILING);

    const row = await prisma.costReservation.findUnique({
      where: { idempotencyKey: key },
    });
    expect(row?.status).toBe("RELEASED");
    // A correction is made when the answer stopped being a guess.
    expect(row?.possiblyBilled).toBe(false);

    const updated = await prisma.batchAuthorization.findUnique({
      where: { id: auth.id },
    });
    expect(updated?.actualSpend).toBe(0);

    await prisma.costReservation.deleteMany({ where: { batchId } });
    await prisma.batchAuthorization.deleteMany({ where: { batchId } });
    await prisma.batch.delete({ where: { id: batchId } });
  });
});

describe("bằng chứng theo dấu vân tay input", () => {
  const base = {
    model: "test-fp",
    kind: "video",
    prompt: "a cat on a wall",
    keyframePath: "/tmp/k.png",
    durationSeconds: 5,
  };

  it("cùng request cho cùng dấu vân tay", () => {
    expect(fingerprintInput(base)).toBe(fingerprintInput({ ...base }));
  });

  it("đổi bất cứ thứ gì đã gửi là một request khác", () => {
    const fp = fingerprintInput(base);
    expect(fingerprintInput({ ...base, prompt: "a dog" })).not.toBe(fp);
    expect(fingerprintInput({ ...base, keyframePath: "/tmp/other.png" })).not.toBe(fp);
    expect(fingerprintInput({ ...base, durationSeconds: 8 })).not.toBe(fp);
    // Crucially: a failure teaches nothing about a different model.
    expect(fingerprintInput({ ...base, model: "test-other" })).not.toBe(fp);
  });

  it("chặn gửi lại đúng request đã thất bại, nhưng không chặn request khác", async () => {
    await recordFailureEvidence({
      ...base,
      provider: "runway",
      failureCode: "INTERNAL.BAD_OUTPUT.CODE01",
      sceneId: "test-scene-a",
      billedUnits: 0,
    });

    const seen = await knownBadInput(base);
    expect(seen?.failureCode).toBe("INTERNAL.BAD_OUTPUT.CODE01");

    // Same model, edited prompt: allowed. The rule bans repeating a failure,
    // not using the model again - otherwise one bad clip freezes a scene.
    expect(await knownBadInput({ ...base, prompt: "a cat, wider shot" })).toBeNull();
    // Different model, same prompt: allowed.
    expect(await knownBadInput({ ...base, model: "test-other" })).toBeNull();
  });

  it("KHÔNG ghi lỗi do phía mình gây ra", async () => {
    const result = await recordFailureEvidence({
      model: "test-our-bug",
      kind: "video",
      prompt: "x",
      provider: "openai",
      // A 400 is a malformed request of ours. Recording it would let our own
      // bugs accumulate into a verdict against a model that never misbehaved.
      failureCode: "http_400 input_reference",
      sceneId: "test-scene-z",
    });
    expect(result.recorded).toBe(false);
    expect(await knownBadInput({ model: "test-our-bug", kind: "video", prompt: "x" })).toBeNull();
  });
});

describe("độ tin cậy của model", () => {
  it("một cảnh thất bại nhiều lần KHÔNG kết tội model", async () => {
    const model = "test-one-scene";
    for (const prompt of ["take one", "take two", "take three"]) {
      await recordFailureEvidence({
        model,
        kind: "video",
        prompt,
        provider: "runway",
        failureCode: "INTERNAL.BAD_OUTPUT.CODE01",
        sceneId: "test-scene-same",
        billedUnits: 0,
      });
    }
    const tally = await failureTally(model);
    expect(tally.failures).toBe(3);
    // Three rows, one scene. That is a fact about the scene.
    expect(tally.distinctScenes).toBe(1);
    expect(await reliabilityOf(model)).toBe("OK");
  });

  it("thất bại trên nhiều cảnh khác nhau thì hạ cấp model", async () => {
    const model = "test-many-scenes";
    await prisma.modelRegistry.create({
      data: {
        provider: "runway",
        modelId: model,
        displayName: model,
        type: "video",
        priceUnit: "per_second",
        price: 0.05,
      },
    });

    for (let i = 0; i < DEGRADED_AT; i += 1) {
      await recordFailureEvidence({
        model,
        kind: "video",
        prompt: `scene ${i}`,
        provider: "runway",
        failureCode: "INTERNAL.BAD_OUTPUT.CODE01",
        sceneId: `test-scene-${i}`,
        billedUnits: 0,
      });
    }

    const verdict = await evaluateReliability("runway", model);
    expect(verdict.distinctScenes).toBe(DEGRADED_AT);
    expect(verdict.reliability).toBe("DEGRADED");

    const row = await prisma.modelRegistry.findFirst({ where: { modelId: model } });
    expect(row?.reliability).toBe("DEGRADED");
    // Downgraded, not switched off: a manual pin must still reach it, which is
    // exactly what re-benchmarking needs.
    expect(row?.enabled).toBe(true);
  });

  it("coi giá trị trống là OK", () => {
    // A row written before the column existed is not evidence of anything.
    expect(isReliableForAuto(null)).toBe(true);
    expect(isReliableForAuto(undefined)).toBe(true);
    expect(isReliableForAuto("")).toBe(true);
    expect(isReliableForAuto("OK")).toBe(true);
    expect(isReliableForAuto("DEGRADED")).toBe(false);
    expect(isReliableForAuto("UNSUITABLE")).toBe(false);
  });
});

describe("router tôn trọng độ tin cậy", () => {
  function model(over: Partial<ModelRegistry> & { modelId: string }): ModelRegistry {
    return {
      id: over.modelId,
      provider: "runway",
      displayName: over.modelId,
      type: "video",
      enabled: true,
      priceUnit: "per_second",
      price: 0.05,
      supportsTextToVideo: true,
      supportsImageToVideo: true,
      supportsReferenceImage: true,
      supportsCharacterReference: true,
      supportsAudio: false,
      supports1080p: true,
      supportsUpscale: false,
      maxDuration: 10,
      qualityRating: 7,
      speedRating: 7,
      consistencyRating: 7,
      historicalSuccessRate: 1,
      lifecycle: "ACTIVE",
      reliability: "OK",
      reliabilityNote: "",
      notes: "",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    } as ModelRegistry;
  }

  function ctx(): RouteContext {
    return {
      type: "video",
      qualityMode: "BALANCED",
      strategy: "AUTO",
      complexity: "LOW",
      spendPriority: "NORMAL",
      durationSeconds: 5,
      characterCount: 1,
      consistencyRequired: true,
      needs1080p: false,
      needsReferenceImage: false,
      budgetRemaining: 10,
      usage: { seconds: 5 },
      availableProviders: ["runway"],
    };
  }

  it("không tự chọn model đã bị hạ cấp", () => {
    const degraded = model({ modelId: "test-bad", reliability: "DEGRADED", price: 0.01 });
    const healthy = model({ modelId: "test-good", price: 0.2 });

    const decision = routeScene([degraded, healthy], ctx());
    // The degraded model is far cheaper. It still must not be chosen.
    expect(decision.modelId).toBe("test-good");
    expect(decision.fallbacks.some((f) => f.modelId === "test-bad")).toBe(false);
  });

  it("nếu chỉ còn model bị hạ cấp thì dừng và nói lý do, không âm thầm chi", () => {
    const degraded = model({ modelId: "test-bad", reliability: "DEGRADED" });
    try {
      routeScene([degraded], ctx());
      expect.unreachable("router đáng lẽ phải từ chối");
    } catch (err) {
      expect(err).toBeInstanceOf(RoutingError);
      expect((err as RoutingError).message).toContain("DEGRADED");
    }
  });

  it("vẫn cho phép chọn tay model bị hạ cấp", () => {
    const degraded = model({ modelId: "test-bad", reliability: "DEGRADED" });
    const decision = routeScene([degraded], {
      ...ctx(),
      manualProvider: "runway",
      manualModel: "test-bad",
    });
    // Re-benchmarking a downgraded model is impossible if the pin is refused.
    expect(decision.modelId).toBe("test-bad");
  });
});
