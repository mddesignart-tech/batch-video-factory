"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Wallet } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";
import { updateVideoBudget } from "@/app/actions/projects";
import { BUDGET_TITLE, suggestedBudget, type BudgetProblem } from "@/domain/budget-message";
import type { VideoBudget } from "@/services/video-budget";

/**
 * SIMPLE MODE money UI (QĐ-119): one number per video.
 *
 * The guards behind it are unchanged - global cap, an approved batch, the
 * video's budget all still bind at the POST. This only shows them as
 * "Đã dùng / Giới hạn / Còn lại" and lets a person change THE number that is
 * theirs to change: the video's budget.
 */

const usd = (n: number) => `$${n.toFixed(2)}`;
/** Small amounts (a voice line) need more than cents to read as non-zero. */
const usdFine = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

function BudgetEditor({
  projectId,
  initial,
  label,
  onSaved,
  onCancel,
}: {
  projectId: string;
  initial: number | null;
  label: string;
  onSaved?: (b: VideoBudget) => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initial !== null ? String(initial) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const amount = Number(value.replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Nhập một số lớn hơn 0, ví dụ 1, 2 hoặc 5.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await updateVideoBudget(projectId, amount);
      if (!r.ok || !r.budget) {
        setError(r.message);
        return;
      }
      onSaved?.(r.budget);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] text-ink-400">{label}</label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-400">$</span>
        <Input
          value={value}
          inputMode="decimal"
          placeholder="vd. 2"
          className="h-8 w-24"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        {[1, 2, 5].map((n) => (
          <button key={n} type="button" className="text-[11px] text-ink-400 hover:text-ink-100" onClick={() => setValue(String(n))}>
            {usd(n)}
          </button>
        ))}
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Lưu
        </Button>
        {onCancel ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Huỷ
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-[11px] text-danger-500">{error}</p> : null}
    </div>
  );
}

/** NGÂN SÁCH VIDEO card for the project page. */
export function VideoBudgetCard({ budget }: { budget: VideoBudget }) {
  const [editing, setEditing] = useState(false);
  const unset = budget.limit === null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Wallet className="h-4 w-4" /> NGÂN SÁCH VIDEO
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <Row label="Đã dùng" value={usdFine(budget.used)} />
        <Row label="Giới hạn" value={unset ? "chưa đặt" : usd(budget.limit!)} tone={unset ? "warn" : undefined} />
        <Row
          label="Còn lại"
          value={budget.remaining === null ? "—" : usdFine(budget.remaining)}
          tone={budget.remaining !== null && budget.remaining <= 0 ? "danger" : "ok"}
        />
        {unset ? (
          <p className="text-warn-500">Đặt ngân sách cho video này trước lần tạo ảnh / giọng / video trả phí đầu tiên.</p>
        ) : null}
        {budget.source === "APPROVED_BATCH" && budget.approval ? (
          <p className="text-ink-500">
            Giới hạn đang do lô đã duyệt quyết định ({usd(budget.approval.perVideo)}/video).{" "}
            <Link className="text-brand-400 hover:underline" href={`/batches/${budget.approval.batchId}`}>
              Mở trang lô
            </Link>
          </p>
        ) : null}
        {budget.draftBatchPerVideo !== null && budget.videoLimit !== null && budget.draftBatchPerVideo < budget.videoLimit ? (
          <p className="text-ink-500">Lô chứa video này đặt tối đa {usd(budget.draftBatchPerVideo)}/video khi DUYỆT & CHẠY.</p>
        ) : null}
        {editing || unset ? (
          <BudgetEditor
            projectId={budget.projectId}
            initial={budget.videoLimit}
            label="Ngân sách tối đa cho video này"
            onSaved={() => setEditing(false)}
            onCancel={unset ? undefined : () => setEditing(false)}
          />
        ) : (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Đổi ngân sách
          </Button>
        )}
        <p className="border-t border-ink-800 pt-2 text-[11px] text-ink-500">
          Toàn hệ thống còn {usdFine(budget.global.remaining)} / {usd(budget.global.cap)} (chỉnh trong Cài đặt → Bảo vệ chi phí).
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * "Ngân sách video hiện không đủ" - the friendly form of a budget refusal,
 * with the one button that fixes it and the technical text kept underneath.
 */
export function BudgetProblemBox({
  problem,
  projectId,
  videoLimit,
  onFixed,
}: {
  problem: BudgetProblem;
  projectId: string;
  videoLimit: number | null;
  onFixed?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const unset = problem.scope === "VIDEO" && problem.limit === null;
  const needed = problem.needed ?? 0;
  const used = problem.used ?? 0;
  return (
    <div className="space-y-1.5 rounded-lg border border-warn-500/40 bg-warn-500/10 p-3 text-[11px] text-ink-200">
      <p className="font-semibold text-warn-500">{unset ? "Video này chưa có ngân sách." : BUDGET_TITLE[problem.scope]}</p>
      <div className="space-y-0.5">
        {problem.used !== null ? <p>Đã dùng: {usdFine(problem.used)}</p> : null}
        {problem.remaining !== null ? <p>Còn lại: {usdFine(problem.remaining)}</p> : null}
        {problem.needed !== null ? <p>Thao tác này cần thêm khoảng: {usdFine(problem.needed)}</p> : null}
      </div>
      {problem.scope === "VIDEO" ? (
        editing ? (
          <BudgetEditor
            projectId={projectId}
            initial={suggestedBudget(used, needed, videoLimit)}
            label="Ngân sách tối đa cho video này"
            onSaved={() => {
              setEditing(false);
              onFixed?.();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <Button size="sm" variant="primary" onClick={() => setEditing(true)}>
            {unset ? "Đặt ngân sách video" : "Tăng ngân sách video"}
          </Button>
        )
      ) : problem.scope === "GLOBAL" ? (
        <Link className="text-brand-400 hover:underline" href="/settings">
          Mở Cài đặt → Bảo vệ chi phí
        </Link>
      ) : (
        <p className="text-ink-400">Giới hạn này do lô đã duyệt quyết định — duyệt lại ở trang lô.</p>
      )}
      <details>
        <summary className="cursor-pointer text-ink-500">Chi tiết kỹ thuật</summary>
        <p className="mt-1 break-words font-mono text-ink-500">{problem.detail}</p>
      </details>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "danger" }) {
  const color = tone === "danger" ? "text-danger-500" : tone === "warn" ? "text-warn-500" : tone === "ok" ? "text-ok-500" : "text-ink-100";
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-400">{label}</span>
      <span className={`font-semibold tabular-nums ${color}`}>{value}</span>
    </div>
  );
}
