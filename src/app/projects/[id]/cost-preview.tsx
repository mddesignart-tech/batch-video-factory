"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { formatUSD } from "@/lib/utils";
import { VI_QUALITY_MODE, type QualityMode } from "@/domain/enums";
import type { ProjectCostPreview } from "@/services/project-service";

/**
 * The cost preview the operator sees before pressing "TẠO MEDIA".
 *
 * Showing all three automatic modes side by side is the point: the whole product
 * thesis is "quality per dollar", and that is only a decision the operator can
 * make if they can see what the other two modes would have cost.
 */
export function CostPreview({
  preview,
  currentMode,
}: {
  preview: ProjectCostPreview;
  currentMode: string;
}) {
  const { current, modes, budget } = preview;
  const rows = [
    { key: "text", label: "Kịch bản (Text AI)", value: current.breakdown.text },
    { key: "image", label: "Ảnh keyframe", value: current.breakdown.image },
    { key: "video", label: "Video", value: current.breakdown.video },
    { key: "voice", label: "Giọng đọc", value: current.breakdown.voice },
    { key: "upscale", label: "Nâng phân giải", value: current.breakdown.upscale },
    {
      key: "quality",
      label: "Đánh giá chất lượng",
      value: current.breakdown.quality,
    },
    {
      key: "retries",
      label: "Dự phòng tạo lại",
      value: current.breakdown.retries,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Chi phí ước tính</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          {(["ECONOMY", "BALANCED", "QUALITY"] as const).map((mode) => {
            const estimate = modes[mode];
            const active = mode === currentMode;
            return (
              <div
                key={mode}
                className={`flex items-center justify-between rounded-md border px-3 py-2 ${
                  active
                    ? "border-brand-500/40 bg-brand-500/10"
                    : "border-ink-800 bg-ink-850"
                }`}
              >
                <span className="flex items-center gap-2 text-xs">
                  <span
                    className={active ? "font-semibold text-brand-400" : "text-ink-300"}
                  >
                    {VI_QUALITY_MODE[mode as QualityMode]}
                  </span>
                  {active ? <Badge tone="brand">đang dùng</Badge> : null}
                </span>
                <span className="text-sm font-semibold tabular-nums text-ink-100">
                  {formatUSD(estimate.breakdown.total)}
                </span>
              </div>
            );
          })}
        </div>

        <div className="space-y-1 border-t border-ink-800 pt-3 text-xs">
          {rows.map((row) => (
            <div key={row.key} className="flex justify-between">
              <span className="text-ink-400">{row.label}</span>
              <span className="tabular-nums text-ink-300">
                {formatUSD(row.value)}
              </span>
            </div>
          ))}
          <div className="mt-2 flex justify-between border-t border-ink-800 pt-2 text-sm">
            <span className="font-semibold text-ink-200">Tổng cộng</span>
            <span className="font-semibold tabular-nums text-brand-400">
              {formatUSD(current.breakdown.total)}
            </span>
          </div>
          <div className="flex justify-between text-[11px]">
            <span className="text-ink-500">Chi phí / video</span>
            <span className="tabular-nums text-ink-500">
              {formatUSD(current.breakdown.total)}
            </span>
          </div>
        </div>

        <div
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
            budget.allowed
              ? "border-ok-500/30 bg-ok-500/10 text-ok-500"
              : "border-danger-500/30 bg-danger-500/10 text-danger-500"
          }`}
        >
          {budget.allowed ? (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <div>
            {budget.allowed ? (
              <span>
                Nằm trong ngân sách tối đa {formatUSD(budget.maxBudget)}.
              </span>
            ) : (
              <>
                <p className="font-semibold">{budget.message}</p>
                <ul className="mt-1 list-inside list-disc text-ink-300">
                  {budget.suggestions.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>

        {current.errors.length > 0 ? (
          <div className="rounded-md border border-warn-500/30 bg-warn-500/10 px-3 py-2 text-xs text-warn-500">
            <p className="font-semibold">Cảnh báo định tuyến</p>
            <ul className="mt-1 list-inside list-disc text-ink-300">
              {current.errors.slice(0, 5).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
