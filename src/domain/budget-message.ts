/**
 * Budget refusals in words a non-technical person can act on (QĐ-119).
 *
 * The guards keep their exact technical sentences - those go in a bug report
 * and are shown under "Chi tiết kỹ thuật". This only RECOGNISES them and pulls
 * out the numbers, so the screen can say "Ngân sách video hiện không đủ" with
 * Đã dùng / Còn lại / Cần thêm, and offer the one button that fixes it.
 *
 * Pure: no database, no money moves here.
 */

export type BudgetScope = "VIDEO" | "BATCH" | "GLOBAL";

export interface BudgetProblem {
  scope: BudgetScope;
  /** Already spent against this limit, when the message says. */
  used: number | null;
  limit: number | null;
  /** What is left (never negative), when known. */
  remaining: number | null;
  /** What the refused action would add, when the message says. */
  needed: number | null;
  detail: string;
}

const NUM = String.raw`\$?([0-9]+(?:\.[0-9]+)?)`;

const PATTERNS: { scope: BudgetScope; re: RegExp; read: (m: RegExpExecArray) => Partial<BudgetProblem> }[] = [
  // Executor headroom (batch-executor assertHeadroom).
  { scope: "VIDEO", re: new RegExp(`video đã chi ${NUM} > trần ${NUM}`), read: (m) => ({ used: +m[1]!, limit: +m[2]! }) },
  { scope: "BATCH", re: new RegExp(`lô đã chi ${NUM} > trần ${NUM}`), read: (m) => ({ used: +m[1]!, limit: +m[2]! }) },
  { scope: "GLOBAL", re: /hạn mức toàn cục đã hết/, read: () => ({ remaining: 0 }) },
  // Router: the video's MAX BUDGET minus what it has spent.
  {
    scope: "VIDEO",
    re: new RegExp(`(?:Chi phí tối thiểu cho cảnh này là|Mô hình đã chọn tốn) ${NUM} nhưng ngân sách còn lại chỉ ${NUM}`),
    read: (m) => ({ needed: +m[1]!, remaining: +m[2]! }),
  },
  // Global cap (spend-guard).
  {
    scope: "GLOBAL",
    re: new RegExp(`Đã chi ${NUM} cho API thật\\. Yêu cầu này ước tính thêm ${NUM}, tổng ${NUM} sẽ vượt hạn mức ${NUM}`),
    read: (m) => ({ used: +m[1]!, needed: +m[2]!, limit: +m[4]! }),
  },
];

/** Recognise a budget refusal; null for anything else (left to friendlyError). */
export function budgetProblem(message: string | null | undefined): BudgetProblem | null {
  if (!message) return null;
  for (const p of PATTERNS) {
    const m = p.re.exec(message);
    if (!m) continue;
    const got = p.read(m);
    const used = got.used ?? null;
    const limit = got.limit ?? null;
    const remaining = got.remaining ?? (used !== null && limit !== null ? Math.max(0, limit - used) : null);
    return { scope: p.scope, used, limit, remaining, needed: got.needed ?? null, detail: message.trim() };
  }
  return null;
}

export const BUDGET_TITLE: Record<BudgetScope, string> = {
  VIDEO: "Ngân sách video hiện không đủ.",
  BATCH: "Ngân sách của lô đã duyệt không đủ.",
  GLOBAL: "Ngân sách toàn hệ thống không đủ.",
};

/**
 * A budget large enough for `used + needed`, rounded UP to a friendly step
 * (0.5 below $5, 1 above) - a suggestion for the "Tăng ngân sách video" field,
 * never applied without the person saving it.
 */
export function suggestedBudget(used: number, needed: number, current: number | null): number {
  const want = Math.max(used + Math.max(needed, 0), current ?? 0) + 1e-9;
  const step = want < 5 ? 0.5 : 1;
  const next = Math.ceil(want / step) * step;
  return Math.round((next > (current ?? 0) + 1e-9 ? next : next + step) * 100) / 100;
}
