import Link from "next/link";
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { prisma } from "@/lib/prisma";
import { formatDateVi, formatUSD } from "@/lib/utils";
import {
  DIFFICULTIES,
  IDIOM_CATEGORIES,
  VI_BATCH_STATUS,
  type BatchStatus,
} from "@/domain/enums";
import { DEFAULT_MAX_COST_PER_VIDEO } from "@/services/batch-authorization";
import { spendStatus } from "@/services/spend-guard";
import { BatchPlanForm } from "./batch-plan-form";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<BatchStatus, "neutral" | "info" | "ok" | "warn" | "danger"> = {
  PLANNED: "neutral",
  QUEUED: "info",
  RUNNING: "info",
  COMPLETED: "ok",
  FAILED: "danger",
  NEEDS_REVIEW: "warn",
  BUDGET_EXHAUSTED: "warn",
  CANCELLED: "neutral",
};

export default async function BatchesPage() {
  const [batches, presets, unusedCount, spend] = await Promise.all([
    prisma.batch.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        _count: { select: { projects: true } },
        authorization: true,
      },
    }),
    prisma.stylePreset.findMany({ orderBy: { name: "asc" } }),
    prisma.idiom.count({ where: { status: { in: ["unused", "planned"] } } }),
    spendStatus(),
  ]);

  return (
    <>
      <PageHeader
        title="Batch Video Factory"
        description="Một nút tạo nhiều video hoàn chỉnh: kịch bản → ảnh → video → giọng → phụ đề → render → MP4."
      />

      <Alert tone="info" title="Quy trình hai bước, tiền chỉ ra ở bước hai">
        Bấm <strong>PHÂN TÍCH &amp; DỰ TOÁN</strong> để xem từng video tốn bao
        nhiêu — bước này miễn phí và làm lại bao nhiêu lần cũng được. Chỉ khi bấm{" "}
        <strong>DUYỆT &amp; CHẠY BATCH</strong> và nhập hạn mức thì lô mới được
        phép gọi API trả phí. Hạn mức toàn ứng dụng hiện còn{" "}
        <strong>{formatUSD(spend.remaining, 4)}</strong> trên{" "}
        {formatUSD(spend.cap)}.
      </Alert>

      <div className="mt-4">
        <BatchPlanForm
          presets={presets.map((p) => ({ id: p.id, name: p.name }))}
          categories={[...IDIOM_CATEGORIES]}
          difficulties={[...DIFFICULTIES]}
          availableIdioms={unusedCount}
          defaultMaxCostPerVideo={DEFAULT_MAX_COST_PER_VIDEO}
        />
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Các lô đã tạo ({batches.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {batches.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="Chưa có lô nào"
                description="Lập kế hoạch cho lô đầu tiên ở trên. Dự toán không tốn gì."
              />
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Tên lô</Th>
                  <Th>Trạng thái</Th>
                  <Th>Quyền chi</Th>
                  <Th className="text-right">Video</Th>
                  <Th className="text-right">Dự toán</Th>
                  <Th className="text-right">Đã duyệt</Th>
                  <Th className="text-right">Đã chi</Th>
                  <Th>Tạo lúc</Th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id} className="hover:bg-ink-850">
                    <Td className="font-medium text-ink-100">
                      <Link
                        href={`/batches/${batch.id}`}
                        className="hover:text-brand-400"
                      >
                        {batch.name}
                      </Link>
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[batch.status as BatchStatus] ?? "neutral"}>
                        {VI_BATCH_STATUS[batch.status as BatchStatus] ?? batch.status}
                      </Badge>
                    </Td>
                    <Td className="text-xs text-ink-400">
                      {batch.authorization?.status ?? "—"}
                    </Td>
                    <Td className="text-right tabular-nums text-ink-300">
                      {batch._count.projects}/{batch.amount}
                    </Td>
                    <Td className="text-right tabular-nums text-ink-300">
                      {formatUSD(batch.estimatedCost, 4)}
                    </Td>
                    <Td className="text-right tabular-nums text-ink-300">
                      {batch.authorization?.status === "DRAFT"
                        ? "chưa duyệt"
                        : formatUSD(batch.authorization?.authorizedMaxSpend ?? 0)}
                    </Td>
                    <Td className="text-right tabular-nums text-ink-100">
                      {formatUSD(batch.authorization?.actualSpend ?? batch.actualCost, 4)}
                    </Td>
                    <Td className="text-xs text-ink-500">
                      {formatDateVi(batch.createdAt)}
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
