"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
} from "@/components/ui";
import { ActionFeedback, type ActionResult } from "@/components/action-ui";
import { approveBatch } from "@/app/actions/batches";
import { formatUSD } from "@/lib/utils";
import { VI_COST_BASIS_SHORT, type CostBasis } from "@/domain/cost-basis";

export interface ApprovalFigures {
  costBasis: CostBasis;
  estimated: number;
  recommended: number;
  safetyMarginPct: number;
  clampedByGlobalCap: boolean;
  globalRemaining: number;
  providerScope: string[];
  videoCount: number;
  maxCostPerVideo: number;
  /** Non-empty when the plan has something the operator should read first. */
  warnings: string[];
}

/**
 * Approve a batch that was planned somewhere other than the /batches form.
 *
 * Without this the detail page could show a DRAFT authorisation and offer no
 * way to act on it: the only approve control lived inside the planning form, so
 * a batch prepared by a script was visible, correct, and unusable. A prepared
 * batch that cannot be approved in the UI forces the operator to a side script
 * to spend money, which is exactly the path the batch gateway exists to close.
 *
 * The ceiling is typed by a person. `recommended` only pre-fills the box.
 */
export function ApprovePanel({
  batchId,
  figures,
}: {
  batchId: string;
  figures: ApprovalFigures;
}) {
  const router = useRouter();
  const [ceiling, setCeiling] = useState(figures.recommended);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  const overCap = ceiling > figures.globalRemaining;

  const run = async () => {
    setPending(true);
    try {
      const res = await approveBatch(batchId, ceiling);
      setResult(res);
      if (res.ok) router.refresh();
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="mt-4 border-brand-500/40">
      <CardHeader>
        <CardTitle>Duyệt chi (đây là bước tiêu tiền)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {figures.costBasis !== "PRODUCTION_ESTIMATE" ? (
          <Alert tone="warn" title="Con số dưới đây KHÔNG phải dự toán chạy thật">
            Cơ sở giá là <strong>{VI_COST_BASIS_SHORT[figures.costBasis]}</strong>.
            Không duyệt hạn mức dựa trên giá giả lập.
          </Alert>
        ) : null}

        <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Số video" value={String(figures.videoCount)} />
          <Tile label="Hạn mức / video" value={formatUSD(figures.maxCostPerVideo)} />
          <Tile
            label="Nhà cung cấp sẽ tính tiền"
            value={figures.providerScope.join(", ") || "— (mock, $0)"}
          />
          <Tile
            label="Hạn mức tổng còn lại"
            value={formatUSD(figures.globalRemaining, 4)}
          />
        </div>

        <div className="rounded-lg border border-ink-800 bg-ink-850 p-4">
          <div className="mb-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <p className="text-[11px] text-ink-500">Estimated</p>
              <p className="font-semibold tabular-nums text-ink-100">
                {formatUSD(figures.estimated, 4)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-ink-500">
                Recommended maximum (+
                {(figures.safetyMarginPct * 100).toFixed(0)}% dự phòng)
              </p>
              <p className="font-semibold tabular-nums text-brand-400">
                {formatUSD(figures.recommended, 4)}
                {figures.clampedByGlobalCap ? (
                  <span className="ml-2 text-[11px] font-normal text-warn-500">
                    (đã hạ theo hạn mức tổng)
                  </span>
                ) : null}
              </p>
            </div>
          </div>

          <Field
            label="MAXIMUM AUTHORIZED SPEND cho cả lô (USD)"
            hint="Số này do bạn nhập, không phải hệ thống tự duyệt. Lô tuyệt đối không chi vượt."
          >
            <Input
              type="number"
              min={0}
              step="0.01"
              value={ceiling}
              onChange={(e) => setCeiling(Number(e.currentTarget.value) || 0)}
              className="max-w-xs"
            />
          </Field>
        </div>

        {figures.warnings.length > 0 ? (
          <Alert tone="warn" title="Cần đọc trước khi duyệt">
            <ul className="list-inside list-disc space-y-0.5 text-xs">
              {figures.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        {overCap ? (
          <Alert tone="danger" title="Vượt hạn mức toàn ứng dụng">
            Hạn mức tổng chỉ còn {formatUSD(figures.globalRemaining, 4)}.
          </Alert>
        ) : null}

        <Button
          variant="primary"
          disabled={pending || ceiling <= 0 || overCap}
          onClick={() => void run()}
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          DUYỆT &amp; CHẠY BATCH
        </Button>

        {result ? <ActionFeedback result={result} /> : null}
      </CardContent>
    </Card>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-850 px-3 py-2">
      <p className="text-[11px] text-ink-500">{label}</p>
      <p className="mt-0.5 font-semibold tabular-nums text-ink-100">{value}</p>
    </div>
  );
}
