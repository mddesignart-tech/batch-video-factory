"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Table, Td, Th } from "@/components/ui";
import { formatUSD } from "@/lib/utils";
import { LIFECYCLE_TONE } from "@/domain/video-lifecycle";
import {
  acknowledgeRecoveryAction,
  continueAllAction,
  continueVideoAction,
  recoverVideoAction,
  videoResumePlans,
} from "@/app/actions/batch-run";
import type { VideoResumePlan } from "@/services/video-resume";
import type { RecoveryItem } from "@/services/paid-recovery";

/**
 * One row per video, one button per video (QĐ-110). Every figure comes from
 * the server's resume plan: INCREMENTAL cost only (what already exists is $0),
 * and a paid step always asks first, showing video / batch / global headroom.
 */
export function VideoResumePanel({ batchId }: { batchId: string }) {
  const [plans, setPlans] = useState<VideoResumePlan[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmFor, setConfirmFor] = useState<VideoResumePlan | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{ videoId: string; items: RecoveryItem[] } | null>(null);
  const [allPreview, setAllPreview] = useState<Awaited<ReturnType<typeof continueAllAction>> | null>(null);
  const [agree, setAgree] = useState(false);

  const load = useCallback(async () => {
    const r = await videoResumePlans(batchId);
    if (r.ok && r.plans) setPlans(r.plans);
    else setMessage({ ok: false, text: r.message });
  }, [batchId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onContinue(plan: VideoResumePlan, confirmPaid: boolean) {
    setBusy(plan.videoId);
    try {
      const r = await continueVideoAction(plan.videoId, confirmPaid);
      if (r.status === "NEEDS_CONFIRMATION" && r.plan) {
        setConfirmFor(r.plan);
        setAgree(false);
      } else {
        setConfirmFor(null);
        setMessage({ ok: r.ok, text: r.message });
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function onRecover(plan: VideoResumePlan) {
    setBusy(plan.videoId);
    try {
      const r = await recoverVideoAction(plan.videoId);
      setMessage({ ok: r.ok, text: r.message });
      setRecovery({ videoId: plan.videoId, items: r.needsAcknowledgement ?? [] });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function onAcknowledge(item: RecoveryItem) {
    setBusy(item.providerJobId);
    try {
      const r = await acknowledgeRecoveryAction(item.providerJobId);
      setMessage({ ok: r.ok, text: r.message });
      setRecovery((prev) => (prev ? { ...prev, items: prev.items.filter((i) => i.providerJobId !== item.providerJobId) } : prev));
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function onContinueAll(confirmPaid: boolean) {
    setBusy("__all");
    try {
      const r = await continueAllAction(batchId, confirmPaid);
      if (r.status === "NEEDS_CONFIRMATION") {
        setAllPreview(r);
        setAgree(false);
      } else {
        setAllPreview(null);
        setMessage({ ok: r.ok, text: r.message });
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Từng video — tiếp tục riêng</CardTitle>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => onContinueAll(false)}>
          {busy === "__all" ? <Loader2 className="size-4 animate-spin" /> : null}
          TIẾP TỤC TẤT CẢ VIDEO ĐỦ ĐIỀU KIỆN
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {plans === null ? (
          <p className="text-xs text-ink-500">Đang lập kế hoạch từng video…</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Video</Th>
                <Th>Trạng thái</Th>
                <Th>Tiến độ</Th>
                <Th>Chi phí tăng thêm</Th>
                <Th>Việc còn lại</Th>
                <Th>Hành động</Th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <Fragment key={p.videoId}>
                  <tr>
                    <Td className="font-medium">{p.title}</Td>
                    <Td>
                      <Badge tone={LIFECYCLE_TONE[p.currentStatus]}>{p.currentStatus}</Badge>
                    </Td>
                    <Td>{p.progress}%</Td>
                    <Td>{p.estimatedIncrementalCost === null ? "?" : formatUSD(p.estimatedIncrementalCost, 4)}</Td>
                    <Td className="text-[11px]">
                      {p.paidRequestsRequired.total > 0
                        ? `trả phí: ảnh ${p.paidRequestsRequired.image} · video ${p.paidRequestsRequired.video} · giọng ${p.paidRequestsRequired.voice}`
                        : p.nextStep === "NONE"
                          ? "—"
                          : "chỉ tại máy ($0)"}
                      {p.localWorkRequired.length > 0 && p.nextStep !== "NONE" ? (
                        <span className="block text-ink-500">{p.localWorkRequired.join(" · ")}</span>
                      ) : null}
                    </Td>
                    <Td>
                      {p.nextAction === "TIẾP TỤC" ? (
                        <Button size="sm" disabled={busy !== null} onClick={() => onContinue(p, false)}>
                          {busy === p.videoId ? <Loader2 className="size-3.5 animate-spin" /> : null}
                          TIẾP TỤC
                        </Button>
                      ) : p.nextAction === "KIỂM TRA LẠI" ? (
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => onContinue(p, false)}>
                          KIỂM TRA LẠI
                        </Button>
                      ) : p.nextAction === "XEM LÝ DO" ? (
                        <Button size="sm" variant="outline" onClick={() => setReasonFor(reasonFor === p.videoId ? null : p.videoId)}>
                          XEM LÝ DO
                        </Button>
                      ) : p.nextAction === "KIỂM TRA" ? (
                        <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => onRecover(p)}>
                          KIỂM TRA / RECOVER
                        </Button>
                      ) : (
                        <span className="text-xs text-ink-500">{p.currentStatus === "RUNNING" || p.currentStatus === "RENDERING" ? "đang chạy" : "—"}</span>
                      )}
                    </Td>
                  </tr>
                  {(reasonFor === p.videoId || p.nextStep === "RECOVER") && p.blockedReason ? (
                    <tr>
                      <Td colSpan={6}>
                        <Alert tone={p.nextStep === "RECOVER" ? "danger" : "warn"}>{p.blockedReason}</Alert>
                      </Td>
                    </tr>
                  ) : null}
                  {recovery?.videoId === p.videoId && recovery.items.length > 0 ? (
                    <tr>
                      <Td colSpan={6} className="space-y-1">
                        {recovery.items.map((item) => (
                          <div key={item.providerJobId} className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="text-danger-500">{item.message}</span>
                            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => onAcknowledge(item)}>
                              ĐÃ KIỂM TRA — CHO PHÉP GỬI LẠI
                            </Button>
                          </div>
                        ))}
                      </Td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </Table>
        )}

        {confirmFor ? (
          <div className="space-y-2 rounded-lg border border-warn-500/40 bg-warn-500/10 p-3 text-xs">
            <p className="font-semibold">Tiếp tục &quot;{confirmFor.title}&quot; — cần xác nhận chi</p>
            <p>
              Còn thiếu: ảnh {confirmFor.paidRequestsRequired.image} · clip Video AI {confirmFor.paidRequestsRequired.video} · giọng{" "}
              {confirmFor.paidRequestsRequired.voice}. Tài sản đã có được dùng lại ($0).
            </p>
            <div className="grid gap-1 font-mono md:grid-cols-2">
              <div>INCREMENTAL ESTIMATE: <strong>{formatUSD(confirmFor.estimatedIncrementalCost ?? 0, 6)}</strong></div>
              <div>VIDEO CAP REMAINING: {formatUSD(confirmFor.budget.videoRemaining, 6)}</div>
              <div>BATCH CAP REMAINING: {formatUSD(confirmFor.budget.batchRemaining, 6)}</div>
              <div>GLOBAL REMAINING: {formatUSD(confirmFor.budget.globalRemaining, 6)}</div>
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              Tôi đồng ý chi tối đa {formatUSD(confirmFor.estimatedIncrementalCost ?? 0, 6)} cho phần còn thiếu (kiểm lại mọi trần ngay trước khi gửi).
            </label>
            <div className="flex gap-2">
              <Button size="sm" variant="danger" disabled={!agree || busy !== null} onClick={() => onContinue(confirmFor, true)}>
                XÁC NHẬN & TIẾP TỤC
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmFor(null)}>
                Huỷ
              </Button>
            </div>
          </div>
        ) : null}

        {allPreview ? (
          <div className="space-y-2 rounded-lg border border-warn-500/40 bg-warn-500/10 p-3 text-xs">
            <p className="font-semibold">TIẾP TỤC TẤT CẢ — {allPreview.runnable.length} video</p>
            <p>ĐƯỢC CHẠY: {allPreview.runnable.map((p) => `${p.title} (${formatUSD(p.estimatedIncrementalCost ?? 0, 4)})`).join(" + ") || "không"}</p>
            <p>BỎ QUA: {allPreview.skipped.map((s) => `${s.plan.title} — ${s.why.split(":")[0]}`).join(" · ") || "không"}</p>
            <p className="font-mono">AUTHORIZATION (tăng thêm): <strong>{formatUSD(allPreview.authorizationAmount, 6)}</strong></p>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              Tôi đồng ý chi tối đa {formatUSD(allPreview.authorizationAmount, 6)} cho các video trên.
            </label>
            <div className="flex gap-2">
              <Button size="sm" variant="danger" disabled={!agree || busy !== null} onClick={() => onContinueAll(true)}>
                XÁC NHẬN & TIẾP TỤC {allPreview.runnable.length} VIDEO
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAllPreview(null)}>
                Huỷ
              </Button>
            </div>
          </div>
        ) : null}

        {message ? <Alert tone={message.ok ? "ok" : "danger"}>{message.text}</Alert> : null}
      </CardContent>
    </Card>
  );
}
