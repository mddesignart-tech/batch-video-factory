import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, Clock, Loader2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Stat,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { prisma } from "@/lib/prisma";
import { DIRS, dirSize } from "@/lib/paths";
import { formatBytes, formatDateVi, formatUSD } from "@/lib/utils";
import { VI_PROJECT_STATUS, VI_QUALITY_MODE } from "@/domain/enums";
import type { ProjectStatus, QualityMode } from "@/domain/enums";
import { costSummary } from "@/services/cost-tracker";
import { queueStats } from "@/jobs/queue";
import { spendStatus } from "@/services/spend-guard";
import { recentBatches, todayDashboard } from "@/services/dashboard";
import { RefreshBalanceButton } from "@/components/refresh-balance-button";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<ProjectStatus, "ok" | "info" | "warn" | "danger" | "neutral"> = {
  draft: "neutral",
  script_ready: "info",
  media_generating: "warn",
  media_ready: "info",
  rendering: "warn",
  completed: "ok",
  failed: "danger",
  needs_review: "warn",
  budget_exhausted: "warn",
  cancelled: "neutral",
};

export default async function DashboardPage() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [
    today,
    month,
    all,
    spend,
    estimatedPending,
    queue,
    todayCount,
    failedCount,
    recentProjects,
    idiomsAvailable,
  ] = await Promise.all([
    costSummary("today"),
    costSummary("month"),
    costSummary("all"),
    spendStatus(),
    // Forecast still outstanding: projects that have an estimate but have not
    // finished. Deliberately not added to any spend figure.
    prisma.project
      .aggregate({
        where: { status: { notIn: ["completed", "failed"] } },
        _sum: { estimatedCost: true },
      })
      .then((r) => r._sum.estimatedCost ?? 0),
    queueStats(),
    prisma.project.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.project.count({ where: { status: "failed" } }),
    prisma.project.findMany({
      orderBy: { updatedAt: "desc" },
      take: 8,
      include: { idiom: true },
    }),
    prisma.idiom.count({ where: { status: "unused" } }),
  ]);

  const mediaBytes = dirSize(DIRS.projects);
  const [day, batches] = await Promise.all([todayDashboard(), recentBatches(8)]);

  return (
    <>
      <PageHeader
        title="Tổng quan"
        description="Tình trạng sản xuất video và chi phí API."
        actions={
          <Link href="/projects">
            <Button variant="primary">
              Tạo dự án mới <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </Link>
        }
      />

      <Card className="mb-4">
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Hôm nay</CardTitle>
          <Link href="/import">
            <Button size="sm" variant="primary">
              Nhập storyboard <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </Link>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Stat
              label={
                day.videosCompletedMock > 0
                  ? `Video hoàn thành (+${day.videosCompletedMock} mock, không tính)`
                  : "Video hoàn thành"
              }
              value={day.videosCompleted}
              tone="ok"
            />
            <Stat label="Video lỗi" value={day.videosFailed} tone={day.videosFailed > 0 ? "danger" : "neutral"} />
            <Stat label="Chi API thật" value={formatUSD(day.apiSpend, 4)} tone={day.apiSpend > 0 ? "warn" : "ok"} />
            <Stat
              label="Chi TB / video"
              value={day.averageCostPerVideo === null ? "—" : formatUSD(day.averageCostPerVideo, 4)}
            />
            <div className="space-y-1.5">
              <Stat
                label={`Runway credit · ${day.runwayFreshness ?? "?"}`}
                value={
                  day.runwayCredits === null
                    ? "không rõ"
                    : `${day.runwayCredits} (≈ ${formatUSD(day.runwayRemainingUsd ?? 0, 2)})`
                }
                hint={
                  day.runwayCheckedAt
                    ? `đọc live lúc ${new Date(day.runwayCheckedAt).toLocaleString("vi-VN")}` +
                      (day.runwayFreshness === "LIVE" ? "" : " — số cũ, bấm REFRESH")
                    : "chưa từng đọc live"
                }
                tone={day.runwayFreshness === "LIVE" ? "ok" : "warn"}
              />
              <RefreshBalanceButton />
            </div>
            <Stat
              label="Ngân sách còn"
              value={formatUSD(day.globalRemaining, 4)}
              hint={`đã chi ${formatUSD(day.globalSpent, 4)} / ${formatUSD(day.globalCap, 2)}`}
              tone={day.globalRemaining < 0.5 ? "danger" : "neutral"}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Lô gần đây</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {batches.length === 0 ? (
            <p className="p-4 text-xs text-ink-500">Chưa có lô nào.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Lô</Th>
                  <Th>Trạng thái</Th>
                  <Th className="text-right">Video</Th>
                  <Th className="text-right">Xong</Th>
                  <Th className="text-right">Chặn / lỗi</Th>
                  <Th className="text-right">Chi thật</Th>
                  <Th>Ngày</Th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <Td>
                      <Link href={`/batches/${b.id}`} className="hover:text-brand-400">
                        {b.name}
                      </Link>
                    </Td>
                    <Td>
                      <Badge tone={b.status === "COMPLETED" ? "ok" : b.status === "RUNNING" ? "warn" : "neutral"}>{b.status}</Badge>
                    </Td>
                    <Td className="text-right tabular-nums">{b.videos}</Td>
                    <Td className="text-right tabular-nums text-ok-500">{b.completed}</Td>
                    <Td className="text-right tabular-nums text-warn-500">
                      {b.blocked} / {b.failed}
                    </Td>
                    <Td className="text-right tabular-nums">{formatUSD(b.cost, 4)}</Td>
                    <Td className="text-xs text-ink-400">{formatDateVi(b.createdAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Video hôm nay" value={todayCount} tone="brand" />
        <Stat
          label="Đang xử lý"
          value={queue.processing ?? 0}
          tone={(queue.processing ?? 0) > 0 ? "info" : "neutral"}
        />
        <Stat label="Chờ xử lý" value={queue.queued ?? 0} />
        <Stat
          label="Thất bại"
          value={failedCount}
          tone={failedCount > 0 ? "danger" : "neutral"}
        />
        <Stat
          label="API thật hôm nay"
          value={formatUSD(today.actualApiCost)}
          hint="Tiền thật đã trả cho nhà cung cấp"
          tone={today.actualApiCost > 0 ? "warn" : "ok"}
        />
        <Stat
          label="API thật tháng này"
          value={formatUSD(month.actualApiCost)}
          hint="Tiền thật đã trả cho nhà cung cấp"
          tone={month.actualApiCost > 0 ? "warn" : "ok"}
        />
        <Stat
          label="Mock tháng này"
          value={formatUSD(month.mockCost)}
          hint={`${month.mockCalls} lượt gọi mock - luôn miễn phí`}
        />
        <Stat
          label="Dung lượng media"
          value={formatBytes(mediaBytes)}
          hint={`${idiomsAvailable} thành ngữ chưa dùng`}
        />
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Chi phí: ba con số khác nhau</CardTitle>
          <CardDescription>
            Đừng nhầm lẫn giữa tiền thật, dự báo và số mô phỏng.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-[11px] tracking-wide text-ink-500 uppercase">
              Chi phí API thật
            </p>
            <p
              className={`mt-1 text-xl font-semibold tabular-nums ${
                all.actualApiCost > 0 ? "text-warn-500" : "text-ok-500"
              }`}
            >
              {formatUSD(all.actualApiCost)}
            </p>
            <p className="mt-1 text-[11px] text-ink-500">
              Tiền thật đã trả cho nhà cung cấp. Hạn mức {formatUSD(spend.cap)},
              còn {formatUSD(spend.remaining)}.
            </p>
          </div>
          <div>
            <p className="text-[11px] tracking-wide text-ink-500 uppercase">
              Chi phí ước tính
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-ink-300">
              {formatUSD(estimatedPending)}
            </p>
            <p className="mt-1 text-[11px] text-ink-500">
              Dự báo cho các dự án chưa render xong. Chưa phải tiền.
            </p>
          </div>
          <div>
            <p className="text-[11px] tracking-wide text-ink-500 uppercase">
              Chi phí mock
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-ink-400">
              {formatUSD(all.mockCost)}
            </p>
            <p className="mt-1 text-[11px] text-ink-500">
              {all.mockCalls} lượt gọi mock. Luôn bằng 0 — không tốn đồng nào.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex items-center justify-between">
            <CardTitle>Dự án gần đây</CardTitle>
            <Link
              href="/projects"
              className="text-xs text-accent-500 hover:underline"
            >
              Xem tất cả
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            {recentProjects.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="Chưa có dự án nào"
                  description="Chọn một thành ngữ và tạo dự án đầu tiên để thử toàn bộ quy trình ở chế độ mock."
                  action={
                    <Link href="/projects">
                      <Button variant="primary" size="sm">
                        Tạo dự án
                      </Button>
                    </Link>
                  }
                />
              </div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Thành ngữ</Th>
                    <Th>Trạng thái</Th>
                    <Th>Chế độ</Th>
                    <Th className="text-right">Ước tính</Th>
                    <Th className="text-right">Thực tế</Th>
                    <Th>Cập nhật</Th>
                  </tr>
                </thead>
                <tbody>
                  {recentProjects.map((project) => (
                    <tr key={project.id} className="hover:bg-ink-850">
                      <Td>
                        <Link
                          href={`/projects/${project.id}`}
                          className="font-medium text-ink-100 hover:text-brand-400"
                        >
                          {project.idiom.phrase}
                        </Link>
                      </Td>
                      <Td>
                        <Badge tone={STATUS_TONE[project.status as ProjectStatus]}>
                          {VI_PROJECT_STATUS[project.status as ProjectStatus] ??
                            project.status}
                        </Badge>
                      </Td>
                      <Td className="text-xs text-ink-400">
                        {VI_QUALITY_MODE[project.qualityMode as QualityMode]}
                      </Td>
                      <Td className="text-right tabular-nums text-ink-300">
                        {formatUSD(project.estimatedCost)}
                      </Td>
                      <Td className="text-right tabular-nums text-ink-100">
                        {formatUSD(project.actualCost)}
                      </Td>
                      <Td className="text-xs text-ink-500">
                        {formatDateVi(project.updatedAt)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Hàng đợi công việc</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <QueueRow
              icon={<Clock className="h-4 w-4 text-ink-400" />}
              label="Chờ xử lý"
              value={queue.queued ?? 0}
            />
            <QueueRow
              icon={<Loader2 className="h-4 w-4 text-accent-500" />}
              label="Đang xử lý"
              value={queue.processing ?? 0}
            />
            <QueueRow
              icon={<CheckCircle2 className="h-4 w-4 text-ok-500" />}
              label="Hoàn thành"
              value={queue.completed ?? 0}
            />
            <QueueRow
              icon={<AlertTriangle className="h-4 w-4 text-danger-500" />}
              label="Thất bại"
              value={queue.failed ?? 0}
            />
            <div className="border-t border-ink-800 pt-3">
              <Link
                href="/logs"
                className="text-xs text-accent-500 hover:underline"
              >
                Xem nhật ký chi tiết
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function QueueRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-sm text-ink-300">
        {icon}
        {label}
      </span>
      <span className="text-sm font-semibold tabular-nums text-ink-100">
        {value}
      </span>
    </div>
  );
}
