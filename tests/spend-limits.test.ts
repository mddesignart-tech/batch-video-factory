import { describe, expect, it } from "vitest";
import { evaluateSpendLimits, planBatchSpend, type PlannedVideo } from "@/domain/spend-limits";

/**
 * Hierarchical spend limits - the pure rules (V1.2 Phase 2). $0: no database,
 * no provider. The same rules run inside the reservation lock before every
 * paid POST; that path is tested in spend-limits.gate.test.ts.
 */

const video = (id: string, order: number, costs: number[], videoLimit: number | null, sceneLimit: number | null = null): PlannedVideo => ({
  id,
  title: `Video ${id}`,
  order,
  videoLimit,
  scenes: costs.map((c, i) => ({ sceneNumber: i + 1, incrementalCost: c, limit: sceneLimit })),
});

describe("evaluateSpendLimits — một request, bốn tầng", () => {
  it("A. global $5, lô $2, video $0.60, cảnh $0.45, chi $0.40 -> PASS", () => {
    const v = evaluateSpendLimits({
      label: "Video A · cảnh 3",
      estimatedCost: 0.4,
      global: { cap: 5, used: 0 },
      batch: { limit: 2, used: 0 },
      video: { limit: 0.6, used: 0 },
      scene: { limit: 0.45, used: 0 },
    });
    expect(v.status).toBe("PASS");
    expect(v.reasonCode).toBe("OK");
    expect(v.layer).toBe("SCENE"); // the tightest layer is reported
    expect(v.remainingAfter).toBeCloseTo(0.05, 6);
  });

  it("B. trần cảnh $0.30, clip $0.40 -> SCENE_LIMIT_EXCEEDED, nói rõ số", () => {
    const v = evaluateSpendLimits({
      label: "Video A · cảnh 3",
      estimatedCost: 0.4,
      global: { cap: 5, used: 0 },
      batch: { limit: 2, used: 0 },
      video: { limit: 0.6, used: 0 },
      scene: { limit: 0.3, used: 0 },
    });
    expect(v.status).toBe("BLOCKED");
    expect(v.reasonCode).toBe("SCENE_LIMIT_EXCEEDED");
    expect(v.overBy).toBeCloseTo(0.1, 6);
    expect(v.limit).toBe(0.3);
    expect(v.message).toContain("vượt giới hạn cảnh $0.10");
    expect(v.message).toContain("dự toán $0.40");
    expect(v.message).toContain("giới hạn $0.30");
  });

  it("C. trần video $0.60, video $0.70 -> VIDEO_LIMIT_EXCEEDED ($0.10)", () => {
    const v = evaluateSpendLimits({ label: "Video 2", estimatedCost: 0.7, global: { cap: 5, used: 0 }, video: { limit: 0.6, used: 0 } });
    expect(v.reasonCode).toBe("VIDEO_LIMIT_EXCEEDED");
    expect(v.overBy).toBeCloseTo(0.1, 6);
    expect(v.message).toBe("Video 2 vượt giới hạn video $0.10 — dự toán $0.70, giới hạn $0.60.");
  });

  it("F. global còn $0.30, clip $0.40 -> GLOBAL_LIMIT_EXCEEDED", () => {
    const v = evaluateSpendLimits({ label: "Video A", estimatedCost: 0.4, global: { cap: 8.5, used: 8.2 }, batch: { limit: 2, used: 0 } });
    expect(v.reasonCode).toBe("GLOBAL_LIMIT_EXCEEDED");
    expect(v.remainingBefore).toBeCloseTo(0.3, 6);
    expect(v.overBy).toBeCloseTo(0.1, 6);
  });

  it("tầng cụ thể nhất được báo trước (cảnh trước video trước lô trước toàn cục)", () => {
    const v = evaluateSpendLimits({
      label: "x",
      estimatedCost: 1,
      global: { cap: 0.1, used: 0 },
      batch: { limit: 0.1, used: 0 },
      video: { limit: 0.1, used: 0 },
      scene: { limit: 0.1, used: 0 },
    });
    expect(v.reasonCode).toBe("SCENE_LIMIT_EXCEEDED");
  });

  it("đã dùng một phần: chỉ phần còn lại được tính", () => {
    const v = evaluateSpendLimits({ label: "x", estimatedCost: 0.2, global: { cap: 5, used: 0 }, video: { limit: 0.6, used: 0.45 } });
    expect(v.reasonCode).toBe("VIDEO_LIMIT_EXCEEDED");
    expect(v.overBy).toBeCloseTo(0.05, 6);
  });
});

describe("planBatchSpend — ai được chạy, ai bị chặn, vì sao", () => {
  it("D. trần lô $1: A $0.40 + B $0.40 -> cả hai chạy, duyệt $0.80", () => {
    const p = planBatchSpend({ videos: [video("A", 1, [0.4], 0.6), video("B", 2, [0.4], 0.6)], batchLimit: 1, globalRemaining: 5 });
    expect(p.runnable.map((v) => v.id)).toEqual(["A", "B"]);
    expect(p.authorizationAmount).toBeCloseTo(0.8, 6);
  });

  it("E. trần lô $0.60: A $0.40 + B $0.40 -> A chạy (thứ tự hàng đợi), B BATCH_LIMIT_EXCEEDED, không vượt", () => {
    const p = planBatchSpend({ videos: [video("B", 2, [0.4], 0.6), video("A", 1, [0.4], 0.6)], batchLimit: 0.6, globalRemaining: 5 });
    expect(p.runnable.map((v) => v.id)).toEqual(["A"]);
    expect(p.blocked.map((v) => [v.id, v.verdict.reasonCode])).toEqual([["B", "BATCH_LIMIT_EXCEEDED"]]);
    expect(p.authorizationAmount).toBeLessThanOrEqual(0.6);
    // Same input, same answer - every time.
    const again = planBatchSpend({ videos: [video("A", 1, [0.4], 0.6), video("B", 2, [0.4], 0.6)], batchLimit: 0.6, globalRemaining: 5 });
    expect(again.runnable.map((v) => v.id)).toEqual(["A"]);
  });

  it("E'. ưu tiên của người dùng đứng trước thứ tự hàng đợi; video rẻ phía sau vẫn được xếp vừa", () => {
    const pri: PlannedVideo = { ...video("B", 2, [0.4], 0.6), priority: 5 };
    const p = planBatchSpend({ videos: [video("A", 1, [0.4], 0.6), pri, video("C", 3, [0.1], 0.6)], batchLimit: 0.6, globalRemaining: 5 });
    expect(p.runnable.map((v) => v.id)).toEqual(["B", "C"]);
    expect(p.blocked.map((v) => v.id)).toEqual(["A"]);
  });

  it("G. A PASS, B vượt trần video, C PASS -> A và C chạy, B bị chặn RIÊNG, không vào số duyệt", () => {
    const p = planBatchSpend({
      videos: [video("A", 1, [0.02, 0.4], 0.6), video("B", 2, [0.01, 0.8], 0.7), video("C", 3, [0.22], 0.6)],
      batchLimit: 5,
      globalRemaining: 5,
    });
    expect(p.runnable.map((v) => v.id)).toEqual(["A", "C"]);
    expect(p.blocked[0]!.verdict.reasonCode).toBe("VIDEO_LIMIT_EXCEEDED");
    expect(p.blocked[0]!.verdict.message).toContain("Video B vượt giới hạn video $0.11");
    expect(p.authorizationAmount).toBeCloseTo(0.64, 6);
    expect(p.requestedTotal).toBeCloseTo(1.45, 6);
  });

  it("cảnh vượt trần cảnh -> cả video BLOCKED với mã SCENE_LIMIT_EXCEEDED, nêu tên cảnh", () => {
    const p = planBatchSpend({ videos: [video("A", 1, [0.01, 0.4], 0.6, 0.3)], batchLimit: 5, globalRemaining: 5 });
    expect(p.blocked[0]!.verdict.reasonCode).toBe("SCENE_LIMIT_EXCEEDED");
    expect(p.blocked[0]!.verdict.message).toContain("cảnh 2");
  });

  it("H. asset REUSE (giá gốc $0.40) -> tăng thêm $0, video vẫn chạy dưới trần $0.10", () => {
    const d = video("D", 4, [0, 0, 0], 0.1);
    const p = planBatchSpend({ videos: [d], batchLimit: 0.7, globalRemaining: 5 });
    expect(p.runnable.map((v) => v.id)).toEqual(["D"]);
    expect(p.authorizationAmount).toBe(0);
  });

  it("toàn cục là giới hạn chặt hơn lô -> GLOBAL_LIMIT_EXCEEDED", () => {
    const p = planBatchSpend({ videos: [video("A", 1, [0.4], 0.6), video("B", 2, [0.4], 0.6)], batchLimit: 2, globalRemaining: 0.5 });
    expect(p.runnable.map((v) => v.id)).toEqual(["A"]);
    expect(p.blocked[0]!.verdict.reasonCode).toBe("GLOBAL_LIMIT_EXCEEDED");
  });

  it("video bị chặn vì lý do khác tiền được giữ nguyên mã, không chiếm tiền", () => {
    const blocked: PlannedVideo = { ...video("X", 1, [0.5], 1), preBlocked: { reasonCode: "MODEL_NOT_CONFIRMED", message: "chưa xác nhận giá" } };
    const p = planBatchSpend({ videos: [blocked, video("Y", 2, [0.5], 1)], batchLimit: 0.6, globalRemaining: 5 });
    expect(p.blocked[0]!.verdict.reasonCode).toBe("MODEL_NOT_CONFIRMED");
    expect(p.runnable.map((v) => v.id)).toEqual(["Y"]);
  });

  it("17. QA 4 video: A $0.40/$0.60, B $0.70/$0.50, C $0.20/$0.40, D REUSE $0/$0.10, lô $0.70 -> A+C+D, duyệt $0.60", () => {
    const p = planBatchSpend({
      videos: [video("A", 1, [0.4], 0.6), video("B", 2, [0.7], 0.5), video("C", 3, [0.2], 0.4), video("D", 4, [0], 0.1)],
      batchLimit: 0.7,
      globalRemaining: 5,
    });
    expect(p.runnable.map((v) => v.id)).toEqual(["A", "C", "D"]);
    expect(p.blocked.map((v) => [v.id, v.verdict.reasonCode])).toEqual([["B", "VIDEO_LIMIT_EXCEEDED"]]);
    expect(p.authorizationAmount).toBeCloseTo(0.6, 6);
  });
});
