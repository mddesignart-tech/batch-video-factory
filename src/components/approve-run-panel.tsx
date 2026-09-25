"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input } from "@/components/ui";
import { formatUSD } from "@/lib/utils";
import { approveAndRunBatch, preflightBatch } from "@/app/actions/batch-run";
import type { ApprovalPreflight } from "@/services/batch-executor";

/**
 * PREFLIGHT, then DUYỆT & CHẠY BATCH - the whole approval, in the UI.
 *
 * The person types the ceiling. Nothing is pre-filled into the amount field:
 * the recommendation is shown beside it, but agreeing to spend is something
 * they do, not something a default does for them. The run button stays off
 * until the preflight with THEIR numbers is green and they tick the sentence
 * that names the amount. The server re-checks all of it - this panel can make
 * approving easy, not approving wrongly.
 */
export function ApproveRunPanel({ batchId }: { batchId: string }) {
  const router = useRouter();
  const [maxBatch, setMaxBatch] = useState("");
  const [maxPerVideo, setMaxPerVideo] = useState("");
  const [lowAuto, setLowAuto] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"preflight" | "run" | null>(null);
  const [pre, setPre] = useState<ApprovalPreflight | null>(null);
  // The figures the last PREFLIGHT checked. Editing a number after it means the
  // green result no longer describes what would be approved.
  const [checkedWith, setCheckedWith] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const batchNum = Number(maxBatch.replace(",", "."));
  const perVideoNum = maxPerVideo.trim() ? Number(maxPerVideo.replace(",", ".")) : undefined;

  async function onPreflight() {
    setBusy("preflight");
    setMessage(null);
    setConfirmed(false);
    try {
      const r = await preflightBatch(batchId, {
        maxBatch: Number.isFinite(batchNum) && batchNum > 0 ? batchNum : undefined,
        maxPerVideo: perVideoNum,
      });
      setPre(r.preflight ?? null);
      setCheckedWith(`${maxBatch}|${maxPerVideo}`);
      setMessage({ ok: r.ok, text: r.message });
    } finally {
      setBusy(null);
    }
  }

  async function onRun() {
    if (!pre) return;
    setBusy("run");
    setMessage(null);
    try {
      const r = await approveAndRunBatch({
        batchId,
        maxBatch: batchNum,
        maxPerVideo: perVideoNum,
        lowAutoApproved: lowAuto,
        confirmed,
      });
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) router.push(`/batches/${batchId}`);
    } finally {
      setBusy(null);
    }
  }

  const numbersMatch =
    pre !== null && Number.isFinite(batchNum) && batchNum > 0 && checkedWith === `${maxBatch}|${maxPerVideo}`;
  const canRun =
    pre !== null &&
    pre.ready &&
    numbersMatch &&
    confirmed &&
    (!pre.usesLowAuto || lowAuto || pre.mockMode) &&
    busy === null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Duyệt chi & chạy lô</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Trần chi CẢ LÔ ($) — bắt buộc" hint={pre ? `Đề xuất ${formatUSD(pre.recommendedAuthorization)} (dự toán +10%)` : "Bấm PREFLIGHT để xem đề xuất"}>
            <Input
              value={maxBatch}
              inputMode="decimal"
              placeholder="vd. 0.46"
              onChange={(e) => {
                setMaxBatch(e.target.value);
                setConfirmed(false);
              }}
            />
          </Field>
          <Field label="Trần chi MỖI VIDEO ($) — tuỳ chọn" hint="Để trống: giữ trần đã đặt lúc nhập">
            <Input
              value={maxPerVideo}
              inputMode="decimal"
              placeholder="vd. 0.70"
              onChange={(e) => {
                setMaxPerVideo(e.target.value);
                setConfirmed(false);
              }}
            />
          </Field>
          <div className="flex items-end">
            <Button variant="secondary" onClick={onPreflight} disabled={busy !== null}>
              {busy === "preflight" ? <Loader2 className="size-4 animate-spin" /> : null}
              PREFLIGHT
            </Button>
          </div>
        </div>

        {pre ? (
          <>
            <div className="grid gap-1 rounded-lg border border-ink-800 p-3 font-mono text-xs md:grid-cols-2">
              <div>ESTIMATED TOTAL: <strong>{formatUSD(pre.estimatedTotal)}</strong></div>
              <div>GLOBAL REMAINING: {formatUSD(pre.globalRemaining)} / cap {formatUSD(pre.globalCap)}</div>
              <div>MAX/BATCH: {Number.isFinite(batchNum) && batchNum > 0 ? formatUSD(batchNum) : "— (chưa nhập)"}</div>
              <div>MAX/VIDEO: {perVideoNum !== undefined ? formatUSD(perVideoNum) : `giữ nguyên (${formatUSD(pre.preflight.maxCostPerVideo)})`}</div>
              <div>VIDEO: {pre.runnableVideos} chạy được · {pre.blockedVideos} BLOCKED</div>
              <div>PROVIDER/MODEL: {pre.plannedVideoModels.join(", ") || "không có clip trả phí"}</div>
              <div>IMAGE API POST: <strong>{pre.imagePosts}</strong> · VIDEO API POST: <strong>{pre.videoPosts}</strong> · VOICE API POST: <strong>{pre.voicePosts}</strong></div>
              <div>ẢNH IMPORTED/REUSE: {pre.importedImages} · WILL_CREATE: {pre.willCreateImages}</div>
              <div>Cơ sở giá: {pre.mockMode ? "MOCK (không tốn tiền)" : "GIÁ THẬT"}</div>
            </div>

            <div className="space-y-1">
              {pre.checks.map((c) => (
                <div key={c.label} className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone={c.ok ? "ok" : c.blocking ? "danger" : "warn"}>
                    {c.ok ? "ĐẠT" : c.blocking ? "HỎNG" : "BỎ QUA"}
                  </Badge>
                  <span className="text-ink-200">{c.label}</span>
                  <span className="text-ink-500">{c.detail}</span>
                </div>
              ))}
            </div>

            {pre.usesLowAuto && !pre.mockMode ? (
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={lowAuto} onChange={(e) => setLowAuto(e.target.checked)} />
                Đồng ý cho router tự chọn model cho cảnh không ghim (LOW_AUTO): {pre.plannedVideoModels.join(", ")}
              </label>
            ) : null}

            {numbersMatch ? (
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                Tôi đồng ý chi TỐI ĐA <strong>{formatUSD(batchNum)}</strong> cho lô này
                {perVideoNum !== undefined ? <> (mỗi video tối đa {formatUSD(perVideoNum)})</> : null}. Không tự nâng hạn mức.
              </label>
            ) : (
              <p className="text-xs text-warn-500">Nhập trần chi cả lô rồi bấm PREFLIGHT lại để kiểm với con số của bạn.</p>
            )}

            <Button onClick={onRun} disabled={!canRun}>
              {busy === "run" ? <Loader2 className="size-4 animate-spin" /> : null}
              DUYỆT & CHẠY BATCH
            </Button>
          </>
        ) : null}

        {message ? <Alert tone={message.ok ? "ok" : "danger"}>{message.text}</Alert> : null}
        <p className="text-[11px] text-ink-500">
          Dùng đúng pipeline production (như script CLI): mỗi asset 1 lần gọi trả phí, không tự thử lại,
          không tự đổi model, ảnh nhập được dùng lại ($0), kiểm trần lô / trần video / hạn mức toàn cục trước
          MỌI lần gọi trả phí.
        </p>
      </CardContent>
    </Card>
  );
}
