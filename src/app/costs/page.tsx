import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  ProgressBar,
  Stat,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { prisma } from "@/lib/prisma";
import { formatDateVi, formatUSD } from "@/lib/utils";
import { costSummary, type CostPeriod } from "@/services/cost-tracker";
import { spendStatus } from "@/services/spend-guard";
import { COST_CATEGORY_LABELS } from "@/services/cost-estimator";
import type { CostCategory } from "@/domain/enums";

export const dynamic = "force-dynamic";

const PERIODS: { key: CostPeriod; label: string }[] = [
  { key: "today", label: "Hôm nay" },
  { key: "week", label: "Tuần này" },
  { key: "month", label: "Tháng này" },
  { key: "all", label: "Toàn bộ" },
];

export default async function CostsPage() {
  const [today, week, month, all, spend, recent, byProvider] = await Promise.all([
    costSummary("today"),
    costSummary("week"),
    costSummary("month"),
    costSummary("all"),
    spendStatus(),
    prisma.costEntry.findMany({
      orderBy: { createdAt: "desc" },
      take: 60,
      include: { project: { select: { title: true } } },
    }),
    prisma.costEntry.groupBy({
      by: ["provider", "model"],
      where: { estimated: false },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const summaries = { today, week, month, all };
  const maxCategory = Math.max(
    1,
    ...Object.values(all.byCategory).map((v) => v),
  );

  return (
    <>
      <PageHeader
        title="Chi phí"
        description="Theo dõi chi tiêu API thực tế theo từng giai đoạn của quy trình."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {PERIODS.map((period) => (
          <Stat
            key={period.key}
            label={`${period.label} (API thật)`}
            value={formatUSD(summaries[period.key].actualApiCost)}
            hint={`${summaries[period.key].videosGenerated} video`}
            tone={summaries[period.key].actualApiCost > 0 ? "warn" : "ok"}
          />
        ))}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Chi phí API THẬT"
          value={formatUSD(all.actualApiCost)}
          hint="Tiền thật đã trả"
          tone={all.actualApiCost > 0 ? "warn" : "ok"}
        />
        <Stat
          label="Chi phí ƯỚC TÍNH"
          value={formatUSD(all.estimatedCost)}
          hint="Dự báo, chưa phải tiền"
        />
        <Stat
          label="Chi phí MOCK"
          value={formatUSD(all.mockCost)}
          hint={`${all.mockCalls} lượt gọi, luôn miễn phí`}
        />
        <Stat
          label="Hạn mức còn lại"
          value={formatUSD(spend.remaining)}
          hint={`Trần ${formatUSD(spend.cap)}`}
          tone={spend.remaining <= 0 ? "danger" : "brand"}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Video đã tạo (toàn bộ)" value={all.videosGenerated} />
        <Stat label="Thành công" value={all.videosSucceeded} tone="ok" />
        <Stat
          label="Thất bại"
          value={all.videosFailed}
          tone={all.videosFailed > 0 ? "danger" : "neutral"}
        />
        <Stat
          label="Chi phí TB / video"
          value={formatUSD(all.averageCostPerVideo)}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Chi phí theo giai đoạn (toàn bộ)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {Object.keys(all.byCategory).length === 0 ? (
              <p className="text-xs text-ink-500">
                Chưa có chi phí nào được ghi nhận. Ở chế độ mock mọi thao tác
                đều là $0.00.
              </p>
            ) : (
              Object.entries(all.byCategory).map(([category, amount]) => (
                <div key={category}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="text-ink-300">
                      {COST_CATEGORY_LABELS[category as CostCategory] ?? category}
                    </span>
                    <span className="tabular-nums text-ink-200">
                      {formatUSD(amount)}
                    </span>
                  </div>
                  <ProgressBar value={amount / maxCategory} />
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Chi phí theo mô hình</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {byProvider.length === 0 ? (
              <div className="p-5">
                <EmptyState title="Chưa có dữ liệu" />
              </div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Nhà cung cấp</Th>
                    <Th>Mô hình</Th>
                    <Th className="text-right">Số lần</Th>
                    <Th className="text-right">Tổng</Th>
                  </tr>
                </thead>
                <tbody>
                  {byProvider.map((row) => (
                    <tr key={`${row.provider}/${row.model}`}>
                      <Td className="text-xs text-ink-300">{row.provider}</Td>
                      <Td className="font-mono text-[11px] text-ink-400">
                        {row.model}
                      </Td>
                      <Td className="text-right tabular-nums text-ink-300">
                        {row._count._all}
                      </Td>
                      <Td className="text-right tabular-nums text-ink-100">
                        {formatUSD(row._sum.amount ?? 0)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Lịch sử chi phí gần đây</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {recent.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="Chưa có giao dịch nào"
                description="Mỗi lần gọi nhà cung cấp AI sẽ tạo một dòng ở đây, kể cả khi chi phí là $0."
              />
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Thời gian</Th>
                  <Th>Dự án</Th>
                  <Th>Giai đoạn</Th>
                  <Th>Nhà cung cấp</Th>
                  <Th>Mô hình</Th>
                  <Th>Loại</Th>
                  <Th>Tiền thật?</Th>
                  <Th className="text-right">Chi phí</Th>
                </tr>
              </thead>
              <tbody>
                {recent.map((entry) => (
                  <tr key={entry.id}>
                    <Td className="text-[11px] text-ink-500">
                      {formatDateVi(entry.createdAt)}
                    </Td>
                    <Td className="max-w-48 truncate text-xs text-ink-300">
                      {entry.project?.title ?? "-"}
                    </Td>
                    <Td className="text-xs text-ink-400">
                      {COST_CATEGORY_LABELS[entry.category as CostCategory] ??
                        entry.category}
                    </Td>
                    <Td className="text-xs text-ink-400">{entry.provider}</Td>
                    <Td className="font-mono text-[11px] text-ink-500">
                      {entry.model}
                    </Td>
                    <Td className="text-[11px] text-ink-500">
                      {entry.isRetry ? "tạo lại" : "lần đầu"}
                    </Td>
                    <Td className="text-[11px]">
                      {entry.estimated ? (
                        <span className="text-ink-500">ước tính</span>
                      ) : entry.provider === "mock" ? (
                        <span className="text-ink-400">mock ($0)</span>
                      ) : (
                        <span className="text-warn-500">TIỀN THẬT</span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums text-ink-100">
                      {formatUSD(entry.amount)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
