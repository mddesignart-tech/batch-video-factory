"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";
import { formatUSD } from "@/lib/utils";
import type { Workspace } from "@/services/daily-workspace";
import type { ApprovalPreflight } from "@/services/batch-executor";
import { continueAllAction } from "@/app/actions/batch-run";
import { preflightSelectedAction, runSelectedAction, runZeroCostAction } from "@/app/actions/workspace";

type ContinueAll = Awaited<ReturnType<typeof continueAllAction>>;

/**
 * KIỂM TRA & DỰ TOÁN → DUYỆT → CHẠY for one batch (V1.2 Phase 6, QĐ-114).
 *
 * Three honest doors, never a vague "run":
 *   CHẠY VIDEO $0 TRƯỚC   no money at all (a $0 approval: no paid POST can pass)
 *   DUYỆT & CHẠY          an amount the person TYPES, checked first with the
 *                         same preflight the executor uses
 *   TIẾP TỤC TẤT CẢ       per-video plans, summarised: $0 ones run at once,
 *                         paid ones only after their amount is confirmed
 * When the global budget cannot cover the batch, the shortfall is named and the
 * choices are listed - nothing is changed to squeeze the batch in.
 */
export function ApprovePanel({
  ws,
  selectedIds,
  onChanged,
}: {
  ws: Workspace;
  selectedIds: string[];
  onChanged: () => void;
}) {
  const s = ws.summary;
  const auth = ws.authorization;
  const draft = !auth || auth.status === "DRAFT";
  const [scope, setScope] = useState<"all" | "selected">("all");
  // Rounded DOWN: a default that rounds up past the global remainder would be refused.
  const [amount, setAmount] = useState(() =>
    s ? (Math.floor(Math.min(s.recommendedAuthorization, s.globalRemaining) * 100) / 100).toFixed(2) : "0.00",
  );
  const [lowAuto, setLowAuto] = useState(false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [check, setCheck] = useState<ApprovalPreflight | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [bulk, setBulk] = useState<ContinueAll | null>(null);
  const [bulkAgree, setBulkAgree] = useState(false);

  const runnableIds = ws.videos.filter((v) => v.lifecycle !== "BLOCKED" && v.lifecycle !== "COMPLETED").map((v) => v.projectId);
  const uncoveredIds = ws.videos
    .filter((v) => !v.covered && v.lifecycle !== "BLOCKED" && v.lifecycle !== "COMPLETED")
    .map((v) => v.projectId);
  const targetIds = scope === "selected" ? selectedIds : draft ? runnableIds : uncoveredIds;
  const typed = Number(amount);

  async function doCheck() {
    setBusy("check");
    setMessage(null);
    try {
      const r = await preflightSelectedAction(ws.batch.id, targetIds.length > 0 ? targetIds : null, Number.isFinite(typed) ? typed : undefined);
      setCheck(r.preflight ?? null);
      setMessage({ ok: r.ok, text: r.message });
    } finally {
      setBusy(null);
    }
  }

  async function doRun() {
    setBusy("run");
    try {
      const r = await runSelectedAction({
        batchId: ws.batch.id,
        projectIds: targetIds,
        maxBatch: typed,
        lowAutoApproved: lowAuto,
        expectedVideoModels: check?.plannedVideoModels,
        confirmed: agree,
      });
      setMessage({ ok: r.ok, text: r.message });
      setCheck(null);
      setAgree(false);
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function doZero() {
    setBusy("zero");
    try {
      const r = await runZeroCostAction(ws.batch.id);
      setMessage({ ok: r.ok, text: r.message });
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function doBulk(confirmPaid: boolean, zeroCostOnly = false) {
    setBusy("bulk");
    try {
      const r = await continueAllAction(
        ws.batch.id,
        confirmPaid,
        confirmPaid ? bulk?.fingerprint : undefined,
        { zeroCostOnly, onlyProjectIds: scope === "selected" && selectedIds.length > 0 ? selectedIds : undefined },
      );
      if (r.status === "NEEDS_CONFIRMATION") {
        setBulk(r);
        setBulkAgree(false);
      } else {
        setBulk(r.status === "NOTHING_TO_DO" ? r : null);
        setMessage({ ok: r.ok, text: r.message });
        onChanged();
      }
    } finally {
      setBusy(null);
    }
  }

  const failing = check?.checks.filter((c) => !c.ok && c.blocking) ?? [];
  // A check where nothing fits the typed amount is not "all good": the server
  // refuses that approval anyway (V1.2 final QA saw "0 video · Mọi điều kiện đạt").
  if (check && check.runnableVideos === 0) {
    failing.push({
      label: "Không video nào vừa số tiền này",
      ok: false,
      blocking: true,
      detail:
        `cần số lớn hơn (không vượt hạn mức toàn cục còn ${formatUSD(check.globalRemaining, 4)}), ` +
        `hoặc sửa / bỏ chọn video cần nhiều tiền hơn`,
    });
  }
  const canApprove = check !== null && check.ready && check.runnableVideos > 0 && agree && Number.isFinite(typed) && typed > 0 && targetIds.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Kiểm tra &amp; dự toán</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {ws.preflightError ? <Alert tone="warn">{ws.preflightError}</Alert> : null}
        {s ? (
          <div className="grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
            <Fig label="Tổng video" value={s.totalVideos} />
            <Fig label="Sẵn sàng" value={s.ready} tone="ok" />
            <Fig label="Bị chặn" value={s.blocked} tone={s.blocked > 0 ? "warn" : undefined} />
            <Fig label="Đã xong" value={s.completed} />
            <Fig label="Dùng lại" value={s.reuse} tone="ok" />
            <Fig label="Ảnh nhập" value={s.imported} tone="ok" />
            <Fig label="Cảnh LOCAL" value={s.local} />
            <Fig label="Ảnh AI cần tạo" value={s.imageAi} />
            <Fig label="Clip Video AI" value={s.videoAi} tone={s.videoAi > 0 ? "warn" : undefined} />
            <Fig label="Giọng cần tạo" value={s.voice} />
            <Fig label="Render tại máy" value={s.render} />
            <Fig label="Video $0" value={s.zeroCostVideos} tone="ok" />
            <Fig label="Chi phí cần" value={formatUSD(s.requiredCost, 4)} tone="brand" />
            <Fig label="QA trả phí (tuỳ chọn)" value={formatUSD(s.optionalQa, 4)} />
            <Fig label="Dự phòng thử lại" value={formatUSD(s.retryReserve, 4)} />
            <Fig label="Đề xuất duyệt" value={formatUSD(s.recommendedAuthorization, 4)} tone="brand" />
            <Fig label="Hạn mức toàn cục còn" value={formatUSD(s.globalRemaining, 4)} />
            {auth ? <Fig label="Trần lô đã duyệt" value={`${formatUSD(auth.used, 4)} / ${formatUSD(auth.ceiling, 2)}`} /> : null}
          </div>
        ) : null}

        {s && s.shortfall > 0 ? (
          <Alert tone="warn" title={`Thiếu ${formatUSD(s.shortfall, 4)} để chạy toàn bộ lô`}>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs">
              {s.zeroCostVideos > 0 ? <li>Chạy {s.zeroCostVideos} video $0 trước (không tốn tiền) — nút bên dưới.</li> : null}
              {s.fitsBudget.videos > 0 ? (
                <li>
                  Chạy phần vừa ngân sách: {s.fitsBudget.videos} video, {formatUSD(s.fitsBudget.amount, 4)} — chọn các video đó rồi duyệt.
                </li>
              ) : null}
              <li>Tự sửa cảnh (vd. bỏ Video AI) ở trang Nhập / trình sửa cảnh — hệ thống không tự đổi nội dung hay model.</li>
              <li>
                Tăng hạn mức toàn cục trong{" "}
                <Link href="/settings" className="underline">
                  Cài đặt
                </Link>{" "}
                (việc của bạn, không tự làm).
              </li>
            </ul>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={busy !== null || !s || s.zeroCostVideos === 0 || ws.batch.running} onClick={() => void doZero()}>
            {busy === "zero" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            CHẠY VIDEO $0 TRƯỚC ({s?.zeroCostVideos ?? 0})
          </Button>
          {!draft ? (
            <Button variant="secondary" disabled={busy !== null || ws.batch.running} onClick={() => void doBulk(false)}>
              {busy === "bulk" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              TIẾP TỤC TẤT CẢ
            </Button>
          ) : null}
          <span className="text-[11px] text-ink-500">
            {ws.batch.mode === "STRICT" ? "Chế độ STRICT: có video bị chặn thì lô không bắt đầu." : "Chế độ PARTIAL: video lỗi/bị chặn không chặn video khác."}
          </span>
        </div>

        {bulk ? (
          <div className="rounded-lg border border-ink-700 bg-ink-850 p-3 text-xs text-ink-200">
            <p className="font-semibold">
              {bulk.summary.total} video: {bulk.summary.zeroCost} tiếp tục $0 · {bulk.summary.paid} cần thêm{" "}
              {formatUSD(bulk.summary.paidAmount, 4)} · {bulk.summary.blocked} bị chặn
              {bulk.summary.needsRecovery > 0 ? ` · ${bulk.summary.needsRecovery} cần kiểm tra` : ""}
              {bulk.summary.completed > 0 ? ` · ${bulk.summary.completed} đã xong` : ""}
            </p>
            {bulk.status === "NEEDS_CONFIRMATION" ? (
              <div className="mt-2 space-y-2">
                <p>{bulk.message}</p>
                <div className="flex flex-wrap items-center gap-2">
                  {bulk.summary.zeroCost > 0 ? (
                    <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void doBulk(false, true)}>
                      CHẠY {bulk.summary.zeroCost} VIDEO $0 TRƯỚC
                    </Button>
                  ) : null}
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={bulkAgree} onChange={(e) => setBulkAgree(e.target.checked)} />
                    Tôi đồng ý chi tối đa {formatUSD(bulk.authorizationAmount, 4)}
                  </label>
                  <Button size="sm" variant="outline" disabled={!bulkAgree || busy !== null} onClick={() => void doBulk(true)}>
                    TẠO LẠI — CÓ THỂ PHÁT SINH CHI PHÍ ({formatUSD(bulk.authorizationAmount, 4)})
                  </Button>
                </div>
              </div>
            ) : null}
            {bulk.skipped.length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-ink-400">Bỏ qua {bulk.skipped.length} video</summary>
                <ul className="mt-1 list-inside list-disc">
                  {bulk.skipped.map((x) => (
                    <li key={x.plan.videoId}>
                      {x.plan.title}: {x.why}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}

        {draft || uncoveredIds.length > 0 || selectedIds.length > 0 ? (
          <div className="space-y-2 rounded-lg border border-ink-700 p-3">
            <p className="text-sm font-semibold text-ink-100">{draft ? "DUYỆT & CHẠY" : "DUYỆT THÊM & CHẠY"}</p>
            <div className="flex flex-wrap items-end gap-3 text-xs">
              <label className="flex items-center gap-1">
                <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} />
                {draft ? `Tất cả video sẵn sàng (${runnableIds.length})` : `Video chưa được duyệt (${uncoveredIds.length})`}
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" checked={scope === "selected"} onChange={() => setScope("selected")} />
                Video đã chọn ({selectedIds.length})
              </label>
              <label>
                Chi tối đa ($)
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setCheck(null);
                  }}
                  className="mt-1 w-32"
                />
              </label>
              <Button variant="secondary" size="md" disabled={busy !== null || targetIds.length === 0} onClick={() => void doCheck()}>
                {busy === "check" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                KIỂM TRA VỚI SỐ NÀY
              </Button>
            </div>
            {check ? (
              <div className="space-y-1 text-xs">
                <p>
                  {check.runnableVideos} video sẽ chạy · dự toán {formatUSD(check.estimatedTotal, 4)} · POST ảnh/video/giọng{" "}
                  {check.imagePosts}/{check.videoPosts}/{check.voicePosts}
                  {check.mockMode ? <Badge tone="info" className="ml-2">MOCK — không tốn tiền thật</Badge> : null}
                </p>
                {check.plannedVideoModels.length > 0 ? <p>Model video: {check.plannedVideoModels.join(", ")}</p> : null}
                {failing.length > 0 ? (
                  <ul className="list-inside list-disc text-danger-500">
                    {failing.map((c) => (
                      <li key={c.label}>
                        {c.label}: {c.detail}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-ok-500">Mọi điều kiện đạt.</p>
                )}
                {check.usesLowAuto && !check.mockMode ? (
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={lowAuto} onChange={(e) => setLowAuto(e.target.checked)} />
                    Đồng ý cho router tự chọn model video (LOW_AUTO) cho các cảnh chưa ghim
                  </label>
                ) : null}
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                  Tôi đồng ý chi tối đa {formatUSD(Number.isFinite(typed) ? typed : 0, 2)} cho {check.runnableVideos} video này
                </label>
                <Button variant="primary" disabled={!canApprove || busy !== null || ws.batch.running} onClick={() => void doRun()}>
                  {busy === "run" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {draft ? "DUYỆT & CHẠY" : "DUYỆT THÊM & CHẠY"} — MAX {formatUSD(Number.isFinite(typed) ? typed : 0, 2)}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {message ? <Alert tone={message.ok ? "ok" : "danger"}>{message.text}</Alert> : null}
      </CardContent>
    </Card>
  );
}

function Fig({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "ok" | "warn" | "brand" }) {
  const color = tone === "ok" ? "text-ok-500" : tone === "warn" ? "text-warn-500" : tone === "brand" ? "text-brand-400" : "text-ink-100";
  return (
    <div className="rounded-md border border-ink-800 bg-ink-850 px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-ink-500">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
