"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { continueVideoAction } from "@/app/actions/batch-run";
import type { VideoResumePlan } from "@/services/video-resume";

/**
 * TIẾP TỤC for one video, with the two kinds of retry never folded into one
 * word (V1.2 Phase 6, QĐ-114):
 *
 *   THỬ LẠI BƯỚC MIỄN PHÍ                  the plan buys nothing (reuse / local /
 *                                          render) - runs at once
 *   TẠO LẠI — CÓ THỂ PHÁT SINH CHI PHÍ     the server priced the missing paid
 *                                          steps again; nothing is sent until the
 *                                          person agrees to THAT amount, and the
 *                                          confirmation carries the plan's
 *                                          fingerprint (a changed plan is refused)
 *
 * The label is a hint from the page; the server's fresh plan decides.
 */
export function ContinueVideoButton({
  projectId,
  paidHint,
  onDone,
  size = "sm",
}: {
  projectId: string;
  /** The page believes this video needs paid work (label only). */
  paidHint: boolean;
  onDone?: () => void;
  size?: "sm" | "md";
}) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<VideoResumePlan | null>(null);
  const [agree, setAgree] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function go(confirmPaid: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await continueVideoAction(projectId, confirmPaid, confirmPaid ? confirm?.fingerprint : undefined);
      if (r.status === "NEEDS_CONFIRMATION" && r.plan) {
        setConfirm(r.plan);
        setAgree(false);
        setMessage(null);
      } else {
        setConfirm(null);
        setMessage({ ok: r.ok, text: r.message });
        onDone?.();
      }
    } finally {
      setBusy(false);
    }
  }

  if (confirm) {
    const cost = confirm.estimatedIncrementalCost ?? 0;
    return (
      <div className="space-y-2 rounded-md border border-warn-500/40 bg-warn-500/10 p-2 text-xs text-ink-200">
        <p className="font-semibold text-warn-500">Chi phí tăng thêm để tiếp tục: ${cost.toFixed(6)}</p>
        <p>
          {confirm.paidRequestsRequired.total} yêu cầu trả phí (ảnh {confirm.paidRequestsRequired.image} · video{" "}
          {confirm.paidRequestsRequired.video} · giọng {confirm.paidRequestsRequired.voice}). Còn lại: video $
          {confirm.budget.videoRemaining.toFixed(4)} · lô ${confirm.budget.batchRemaining.toFixed(4)} · toàn cục $
          {confirm.budget.globalRemaining.toFixed(4)}.
        </p>
        {confirm.videoChoices.length > 0 ? (
          <ul className="list-inside list-disc">
            {confirm.videoChoices.map((c) => (
              <li key={c.sceneId}>
                cảnh {c.sceneNumber}: {c.provider}/{c.model} {c.durationSeconds}s ${c.estimatedCost.toFixed(4)}
                {c.frozen ? " (model đã duyệt)" : " (xác nhận sẽ chốt model)"}
              </li>
            ))}
          </ul>
        ) : null}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          Tôi đồng ý chi tối đa ${cost.toFixed(6)} cho video này
        </label>
        <div className="flex gap-2">
          <Button size="sm" variant="primary" disabled={!agree || busy} onClick={() => void go(true)}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            TẠO LẠI — CÓ THỂ PHÁT SINH CHI PHÍ
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
            Huỷ
          </Button>
        </div>
      </div>
    );
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button size={size} variant={paidHint ? "outline" : "primary"} disabled={busy} onClick={() => void go(false)}>
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        {paidHint ? "TẠO LẠI — CÓ THỂ PHÁT SINH CHI PHÍ" : "THỬ LẠI BƯỚC MIỄN PHÍ"}
      </Button>
      {message ? <span className={`text-[11px] ${message.ok ? "text-ok-500" : "text-danger-500"}`}>{message.text}</span> : null}
    </span>
  );
}
