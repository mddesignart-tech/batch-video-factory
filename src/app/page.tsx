import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, Clock, Loader2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
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

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<ProjectStatus, "ok" | "info" | "warn" | "danger" | "neutral"> = {
  draft: "neutral",
  script_ready: "info",
  media_generating: "warn",
  media_ready: "info",
  rendering: "warn",
  completed: "ok",
  failed: "danger",
};

export default async function DashboardPage() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [
    today,
    month,
    queue,
    todayCount,
    failedCount,
    recentProjects,
    idiomsAvailable,
  ] = await Promise.all([
    costSummary("today"),
    costSummary("month"),
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
        <Stat label="Chi phí hôm nay" value={formatUSD(today.total)} />
        <Stat label="Chi phí tháng này" value={formatUSD(month.total)} />
        <Stat
          label="Chi phí TB / video"
          value={formatUSD(month.averageCostPerVideo)}
          hint="Tính trên video hoàn thành trong tháng"
        />
        <Stat
          label="Dung lượng media"
          value={formatBytes(mediaBytes)}
          hint={`${idiomsAvailable} thành ngữ chưa dùng`}
        />
      </div>

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
