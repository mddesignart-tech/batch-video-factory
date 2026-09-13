import Link from "next/link";
import {
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
import { VI_JOB_STATUS, type JobStatus } from "@/domain/enums";

export const dynamic = "force-dynamic";

const LEVEL_TONE: Record<string, "neutral" | "info" | "warn" | "danger"> = {
  debug: "neutral",
  info: "info",
  warn: "warn",
  error: "danger",
};

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ level?: string }>;
}) {
  const params = await searchParams;

  const [logs, jobs, levels] = await Promise.all([
    prisma.logEntry.findMany({
      where: params.level ? { level: params.level } : {},
      orderBy: { createdAt: "desc" },
      take: 150,
    }),
    prisma.job.findMany({
      orderBy: { createdAt: "desc" },
      take: 40,
      include: { project: { select: { id: true, title: true } } },
    }),
    prisma.logEntry.groupBy({ by: ["level"], _count: { _all: true } }),
  ]);

  return (
    <>
      <PageHeader
        title="Nhật ký"
        description="Nhật ký có cấu trúc của mọi lệnh gọi nhà cung cấp, job và lỗi. API key không bao giờ được ghi vào đây."
      />

      <Card className="mb-4">
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Hàng đợi công việc</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {jobs.length === 0 ? (
            <div className="p-5">
              <EmptyState title="Chưa có job nào" />
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Loại</Th>
                  <Th>Trạng thái</Th>
                  <Th>Dự án</Th>
                  <Th className="text-right">Lần thử</Th>
                  <Th>Chạy lúc</Th>
                  <Th>Lỗi</Th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="hover:bg-ink-850">
                    <Td className="font-mono text-[11px] text-ink-300">
                      {job.type}
                    </Td>
                    <Td>
                      <Badge
                        tone={
                          job.status === "completed"
                            ? "ok"
                            : job.status === "failed"
                              ? "danger"
                              : job.status === "processing"
                                ? "info"
                                : "neutral"
                        }
                      >
                        {VI_JOB_STATUS[job.status as JobStatus] ?? job.status}
                      </Badge>
                    </Td>
                    <Td className="max-w-48 truncate text-xs">
                      {job.project ? (
                        <Link
                          href={`/projects/${job.project.id}`}
                          className="text-accent-500 hover:underline"
                        >
                          {job.project.title}
                        </Link>
                      ) : (
                        <span className="text-ink-500">-</span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums text-ink-400">
                      {job.attempts}/{job.maxAttempts}
                    </Td>
                    <Td className="text-[11px] text-ink-500">
                      {formatDateVi(job.startedAt ?? job.nextRunAt)}
                    </Td>
                    <Td className="max-w-64 truncate text-[11px] text-danger-500">
                      {job.error ?? ""}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Nhật ký hệ thống</CardTitle>
          <div className="flex gap-1.5">
            <Link
              href="/logs"
              className={`rounded-md px-2.5 py-1 text-xs ${
                !params.level
                  ? "bg-ink-700 text-ink-100"
                  : "text-ink-400 hover:bg-ink-800"
              }`}
            >
              Tất cả
            </Link>
            {levels.map((level) => (
              <Link
                key={level.level}
                href={`/logs?level=${level.level}`}
                className={`rounded-md px-2.5 py-1 text-xs ${
                  params.level === level.level
                    ? "bg-ink-700 text-ink-100"
                    : "text-ink-400 hover:bg-ink-800"
                }`}
              >
                {level.level} ({level._count._all})
              </Link>
            ))}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {logs.length === 0 ? (
            <div className="p-5">
              <EmptyState title="Chưa có nhật ký nào" />
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Thời gian</Th>
                  <Th>Mức</Th>
                  <Th>Sự kiện</Th>
                  <Th>Nhà cung cấp</Th>
                  <Th>Mô hình</Th>
                  <Th className="text-right">Thời gian</Th>
                  <Th className="text-right">Chi phí</Th>
                  <Th>Nội dung</Th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-ink-850">
                    <Td className="whitespace-nowrap text-[11px] text-ink-500">
                      {formatDateVi(log.createdAt)}
                    </Td>
                    <Td>
                      <Badge tone={LEVEL_TONE[log.level] ?? "neutral"}>
                        {log.level}
                      </Badge>
                    </Td>
                    <Td className="font-mono text-[11px] text-ink-300">
                      {log.event}
                    </Td>
                    <Td className="text-xs text-ink-400">
                      {log.provider ?? "-"}
                    </Td>
                    <Td className="font-mono text-[10px] text-ink-500">
                      {log.model ?? "-"}
                    </Td>
                    <Td className="text-right tabular-nums text-[11px] text-ink-500">
                      {log.durationMs !== null ? `${log.durationMs}ms` : "-"}
                    </Td>
                    <Td className="text-right tabular-nums text-[11px] text-ink-400">
                      {log.actualCost !== null ? formatUSD(log.actualCost) : "-"}
                    </Td>
                    <Td className="max-w-96 text-xs text-ink-300">
                      {log.message}
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
