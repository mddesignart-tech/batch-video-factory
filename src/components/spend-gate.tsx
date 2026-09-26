"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input } from "@/components/ui";
import { ActionButton, type ActionResult } from "@/components/action-ui";
import {
  approveRealSpending,
  getSpendPreview,
  revokeRealSpending,
  updateSpendCap,
  type SpendPreview,
} from "@/app/actions/spending";
import { formatUSD } from "@/lib/utils";
import { saveFailure, spendCapView, type SpendCapSaveOutcome } from "@/domain/spend-cap-display";

/**
 * The gate the operator passes through before any real money can be spent.
 *
 * It deliberately loads the figures on demand rather than rendering them with
 * the page: the numbers shown at the moment of approval must be the current
 * ones, not whatever was true when the page was opened.
 */
export function SpendGate({
  provider,
  models,
}: {
  provider: string;
  models: { modelId: string; displayName: string; enabled: boolean }[];
}) {
  const [preview, setPreview] = useState<SpendPreview | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);

  if (models.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-ink-800 pt-3">
      <p className="text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
        Cho phép gọi API thật
      </p>

      <div className="flex flex-wrap gap-1.5">
        {models.map((model) => (
          <Button
            key={model.modelId}
            size="sm"
            variant="outline"
            disabled={loading === model.modelId}
            onClick={async () => {
              setLoading(model.modelId);
              setResult(null);
              setPreview(await getSpendPreview(provider, model.modelId));
              setLoading(null);
            }}
          >
            {loading === model.modelId ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : null}
            {model.modelId}
          </Button>
        ))}
      </div>

      {preview ? (
        <Card className="mt-2 border-warn-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {preview.confirmed ? (
                <ShieldCheck className="h-4 w-4 text-ok-500" />
              ) : (
                <ShieldAlert className="h-4 w-4 text-warn-500" />
              )}
              {preview.provider}/{preview.model}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Row label="Nhà cung cấp" value={preview.provider} />
              <Row label="Model" value={preview.model} />
              <Row
                label="Giá input"
                value={
                  preview.isFree
                    ? "Miễn phí (chạy cục bộ)"
                    : `$${preview.priceInput} / 1k token`
                }
              />
              <Row
                label="Giá output"
                value={
                  preview.isFree
                    ? "Miễn phí (chạy cục bộ)"
                    : `$${preview.priceOutput} / 1k token`
                }
              />
              <Row
                label="Ước tính / kịch bản"
                value={
                  preview.isFree
                    ? "$0.00"
                    : `tối đa ${formatUSD(preview.estimatedPerScript)}`
                }
                tone="brand"
              />
              <Row
                label="Đã chi thật"
                value={formatUSD(preview.spent)}
                tone={preview.spent > 0 ? "warn" : "ok"}
              />
              <Row label="Hạn mức" value={formatUSD(preview.cap)} />
              <Row
                label="Còn lại"
                value={formatUSD(preview.remaining)}
                tone={preview.remaining <= 0 ? "danger" : "ok"}
              />
            </div>

            {preview.warnings.length > 0 ? (
              <div className="space-y-1 rounded-md border border-warn-500/30 bg-warn-500/10 p-2.5">
                {preview.warnings.map((w) => (
                  <p key={w} className="flex gap-1.5 text-[11px] text-warn-500">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="text-ink-200">{w}</span>
                  </p>
                ))}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {preview.confirmed ? (
                <>
                  <Badge tone="ok">
                    <Check className="mr-1 h-3 w-3" />
                    Đã cho phép
                  </Badge>
                  <ActionButton
                    size="sm"
                    variant="danger"
                    action={() => revokeRealSpending(preview.provider, preview.model)}
                    onDone={(r) => {
                      setResult(r);
                      void getSpendPreview(preview.provider, preview.model).then(
                        setPreview,
                      );
                    }}
                  >
                    Thu hồi quyền
                  </ActionButton>
                </>
              ) : (
                <ActionButton
                  size="sm"
                  variant="primary"
                  confirm={
                    preview.isFree
                      ? `Cho phép gọi ${preview.provider}/${preview.model}? Model này chạy cục bộ nên không tốn phí.`
                      : `Cho phép gọi API THẬT của ${preview.provider}/${preview.model}? ` +
                        `Mỗi kịch bản tốn tối đa ${formatUSD(preview.estimatedPerScript)}. ` +
                        `Hạn mức tổng là ${formatUSD(preview.cap)}.`
                  }
                  action={() =>
                    approveRealSpending(preview.provider, preview.model)
                  }
                  onDone={(r) => {
                    setResult(r);
                    void getSpendPreview(preview.provider, preview.model).then(
                      setPreview,
                    );
                  }}
                >
                  Tôi xác nhận cho phép
                </ActionButton>
              )}
              <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
                Đóng
              </Button>
            </div>

            {result ? (
              <p
                className={`text-[11px] ${
                  result.ok ? "text-ok-500" : "text-danger-500"
                }`}
              >
                {result.message}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "ok" | "warn" | "danger" | "brand";
}) {
  const colors = {
    neutral: "text-ink-300",
    ok: "text-ok-500",
    warn: "text-warn-500",
    danger: "text-danger-500",
    brand: "text-brand-400",
  } as const;
  return (
    <div>
      <p className="text-[11px] text-ink-500">{label}</p>
      <p className={`font-medium ${colors[tone]}`}>{value}</p>
    </div>
  );
}

/** Global spend cap editor, shown on the settings page. */
export function SpendCapForm({
  cap: serverCap,
  spent: serverSpent,
  databaseFile,
  productionDatabase,
}: {
  cap: number;
  spent: number;
  databaseFile: string | null;
  productionDatabase: boolean;
}) {
  // GLOBAL PROJECT SPEND LIMIT. The field starts EMPTY: the current limit is
  // shown beside it, but a new limit is something the person types - nothing
  // here raises it for them. Saving asks first, names old -> new and what will
  // be left, and starts no batch. The figures shown are always the database's
  // (see spendCapView) - never the number typed.
  const router = useRouter();
  const [value, setValue] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SpendCapSaveOutcome | null>(null);
  const view = spendCapView({ cap: serverCap, spent: serverSpent }, result);
  const { cap, spent } = view;
  const next = Number(value.replace(",", "."));
  const valid = /^\d+([.,]\d+)?$/.test(value.trim()) && Number.isFinite(next) && next >= spent && next <= 1000;

  async function save() {
    const form = new FormData();
    form.set("cap", value.trim());
    form.set("confirm", "yes");
    setBusy(true);
    try {
      const r = await updateSpendCap(form);
      setResult(r);
      if (r.ok) {
        setValue("");
        setConfirming(false);
        // Re-render the server parts of the page from the database as well.
        router.refresh();
      }
    } catch (err) {
      // A save that never reached the server must not look like one that did.
      setResult(saveFailure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-warn-500/30">
      <CardHeader>
        <CardTitle>GLOBAL PROJECT SPEND LIMIT</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
          <Row label="Spent (đã chi thật)" value={formatUSD(spent, 6)} tone={spent > 0 ? "warn" : "ok"} />
          <Row label="Limit (hạn mức)" value={formatUSD(cap, 2)} tone="brand" />
          <Row
            label="Remaining (còn lại)"
            value={formatUSD(Math.max(0, cap - spent), 6)}
            tone={cap - spent <= 0.5 ? "danger" : "ok"}
          />
        </div>

        <Field
          label="Hạn mức mới (USD)"
          hint={`Phải ≥ số đã chi ($${spent.toFixed(6)}). Áp dụng cho TOÀN BỘ ứng dụng; nâng hạn mức KHÔNG chạy lô nào — mỗi lô vẫn phải PREFLIGHT và DUYỆT & CHẠY.`}
        >
          <Input
            value={value}
            inputMode="decimal"
            placeholder={`hiện tại ${cap.toFixed(2)}`}
            onChange={(e) => {
              setValue(e.target.value);
              setConfirming(false);
              setResult(null);
            }}
          />
        </Field>
        {value.trim() !== "" && !valid ? (
          <p className="mt-1 text-[11px] text-danger-500">
            Không hợp lệ: phải là số từ ${spent.toFixed(6)} (đã chi) tới $1000.
          </p>
        ) : null}

        {!confirming ? (
          <Button className="mt-3" size="sm" variant="primary" disabled={!valid || busy} onClick={() => setConfirming(true)}>
            Lưu hạn mức…
          </Button>
        ) : (
          <div className="mt-3 rounded-lg border border-warn-500/40 bg-warn-500/10 p-3 text-xs">
            <p>
              Đổi hạn mức từ <strong>{formatUSD(cap, 2)}</strong> thành <strong>{formatUSD(next, 2)}</strong>?
              Còn lại sẽ là <strong>{formatUSD(next - spent, 6)}</strong>. Không lô nào được chạy vì thay đổi này.
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="danger" disabled={busy} onClick={save}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                XÁC NHẬN
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                Huỷ
              </Button>
            </div>
          </div>
        )}
        {result ? (
          <p className={`mt-2 text-[11px] ${result.ok ? "text-ok-500" : "text-danger-500"}`}>
            {view.saveState === "SAVED" ? <strong>ĐÃ LƯU — </strong> : null}
            {result.message}
          </p>
        ) : null}

        <p className={`mt-3 break-all text-[11px] ${productionDatabase ? "text-ink-500" : "text-danger-500"}`}>
          DB: {databaseFile ?? "không xác định"}
          {productionDatabase ? " (production)" : " — KHÔNG phải data/app.db: thay đổi ở đây không áp cho production"}
        </p>

        <p className="mt-3 text-[11px] text-ink-500">
          Mỗi thay đổi được ghi vào Nhật ký (cũ → mới, số đã chi). Đây là lớp bảo vệ khác với ngân sách từng
          dự án và trần của từng lô.
        </p>
      </CardContent>
    </Card>
  );
}
