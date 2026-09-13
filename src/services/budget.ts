import type { QualityMode } from "@/domain/enums";
import { round } from "@/lib/utils";
import type { ProjectEstimate } from "./cost-estimator";

/**
 * Budget enforcement.
 *
 * MAX BUDGET is a hard stop, not a warning. Nothing paid starts until the
 * estimate fits, and the operator is offered concrete ways down rather than a
 * dead end.
 */

export interface BudgetCheck {
  allowed: boolean;
  estimatedTotal: number;
  maxBudget: number;
  overBy: number;
  /** Vietnamese message for the UI. Empty when allowed. */
  message: string;
  suggestions: string[];
}

export function checkBudget(
  estimatedTotal: number,
  maxBudget: number,
): BudgetCheck {
  const total = round(estimatedTotal);
  const over = round(total - maxBudget);
  if (over <= 0) {
    return {
      allowed: true,
      estimatedTotal: total,
      maxBudget,
      overBy: 0,
      message: "",
      suggestions: [],
    };
  }
  return {
    allowed: false,
    estimatedTotal: total,
    maxBudget,
    overBy: over,
    message:
      `Chi phí ước tính ${money(total)} vượt ngân sách tối đa ${money(maxBudget)} ` +
      `(vượt ${money(over)}). Quá trình tạo media sẽ không bắt đầu.`,
    suggestions: [
      "Chuyển sang chế độ Tiết kiệm hoặc Cân bằng",
      "Chọn mô hình rẻ hơn cho các cảnh đơn giản",
      "Giảm số lượng video trong lô",
      "Giảm thời lượng mục tiêu của video",
      `Tăng ngân sách tối đa lên ít nhất ${money(total)}`,
    ],
  };
}

/**
 * Batch budget optimisation.
 *
 * The naive answer to "50 videos, $40" is to run everything in ECONOMY and hand
 * back change. That wastes the budget. Instead: start every video at BALANCED,
 * then spend whatever headroom is left upgrading videos to QUALITY one at a
 * time, and only downgrade if BALANCED does not fit.
 *
 * Cost per mode is supplied by the caller (from a real per-mode estimate) so
 * this function stays pure and testable.
 */
export interface BatchPlanInput {
  videoCount: number;
  totalBudget: number;
  costPerVideo: Record<QualityMode, number>;
}

export interface BatchPlan {
  assignments: Record<"ECONOMY" | "BALANCED" | "QUALITY", number>;
  estimatedTotal: number;
  feasibleCount: number;
  leftover: number;
  message: string;
}

export function planBatchBudget(input: BatchPlanInput): BatchPlan {
  const { videoCount, totalBudget, costPerVideo } = input;
  const economy = Math.max(0, costPerVideo.ECONOMY);
  const balanced = Math.max(0, costPerVideo.BALANCED);
  const quality = Math.max(0, costPerVideo.QUALITY);

  const assignments = { ECONOMY: 0, BALANCED: 0, QUALITY: 0 };

  // Everything free (mock mode) - run the best mode for all of them.
  if (balanced === 0 && economy === 0 && quality === 0) {
    assignments.BALANCED = videoCount;
    return {
      assignments,
      estimatedTotal: 0,
      feasibleCount: videoCount,
      leftover: totalBudget,
      message: `Chế độ mock: ${videoCount} video, chi phí $0.00.`,
    };
  }

  let remaining = totalBudget;
  let feasible = 0;

  // Pass 1 - can we afford BALANCED for everyone?
  for (let i = 0; i < videoCount; i++) {
    if (remaining >= balanced) {
      assignments.BALANCED++;
      remaining = round(remaining - balanced);
      feasible++;
    } else if (remaining >= economy && economy > 0) {
      assignments.ECONOMY++;
      remaining = round(remaining - economy);
      feasible++;
    }
  }

  // Pass 2 - spend the leftover upgrading BALANCED videos to QUALITY.
  const upgradeCost = round(quality - balanced);
  if (upgradeCost > 0) {
    while (assignments.BALANCED > 0 && remaining >= upgradeCost) {
      assignments.BALANCED--;
      assignments.QUALITY++;
      remaining = round(remaining - upgradeCost);
    }
  }

  const estimatedTotal = round(
    assignments.ECONOMY * economy +
      assignments.BALANCED * balanced +
      assignments.QUALITY * quality,
  );

  const shortfall = videoCount - feasible;
  const message =
    shortfall > 0
      ? `Ngân sách ${money(totalBudget)} chỉ đủ cho ${feasible}/${videoCount} video. ` +
        `Hãy tăng ngân sách hoặc giảm số lượng.`
      : `${feasible} video: ${assignments.QUALITY} chất lượng cao, ` +
        `${assignments.BALANCED} cân bằng, ${assignments.ECONOMY} tiết kiệm. ` +
        `Tổng ước tính ${money(estimatedTotal)}.`;

  return {
    assignments,
    estimatedTotal,
    feasibleCount: feasible,
    leftover: round(remaining),
    message,
  };
}

/** Convenience wrapper used by the API layer. */
export function checkProjectEstimate(estimate: ProjectEstimate): BudgetCheck {
  return checkBudget(estimate.breakdown.total, estimate.maxBudget);
}

function money(value: number): string {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
}
