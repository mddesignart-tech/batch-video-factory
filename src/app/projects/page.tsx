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
import {
  VI_PROJECT_STATUS,
  VI_QUALITY_MODE,
  type ProjectStatus,
  type QualityMode,
} from "@/domain/enums";
import { NewProjectForm } from "./new-project-form";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<
  ProjectStatus,
  "ok" | "info" | "warn" | "danger" | "neutral"
> = {
  draft: "neutral",
  script_ready: "info",
  media_generating: "warn",
  media_ready: "info",
  rendering: "warn",
  completed: "ok",
  failed: "danger",
};

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ idiomId?: string; status?: string }>;
}) {
  const params = await searchParams;

  const [projects, idioms, presets] = await Promise.all([
    prisma.project.findMany({
      where: params.status ? { status: params.status } : {},
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { idiom: true, _count: { select: { scenes: true } } },
    }),
    prisma.idiom.findMany({
      where: { status: { in: ["unused", "planned"] } },
      orderBy: [{ timesUsed: "asc" }, { phrase: "asc" }],
      take: 500,
      select: { id: true, phrase: true, meaning: true, category: true },
    }),
    prisma.stylePreset.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <>
      <PageHeader
        title="Dự án video"
        description="Mỗi dự án là một video ngắn dựa trên một thành ngữ."
      />

      <NewProjectForm
        idioms={idioms}
        presets={presets.map((p) => ({
          id: p.id,
          name: p.name,
          isDefault: p.isDefault,
        }))}
        preselectedIdiomId={params.idiomId}
      />

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Tất cả dự án ({projects.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {projects.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="Chưa có dự án nào"
                description="Chọn một thành ngữ ở trên, giữ chế độ Cân bằng, rồi bấm Tạo dự án. Ở chế độ mock toàn bộ quy trình chạy miễn phí."
              />
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Thành ngữ</Th>
                  <Th>Tiêu đề</Th>
                  <Th>Trạng thái</Th>
                  <Th>Chế độ</Th>
                  <Th className="text-right">Cảnh</Th>
                  <Th className="text-right">Ước tính</Th>
                  <Th className="text-right">Thực tế</Th>
                  <Th className="text-right">Ngân sách</Th>
                  <Th>Tạo lúc</Th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id} className="hover:bg-ink-850">
                    <Td className="font-medium">
                      <Link
                        href={`/projects/${project.id}`}
                        className="text-ink-100 hover:text-brand-400"
                      >
                        {project.idiom.phrase}
                      </Link>
                    </Td>
                    <Td className="max-w-64 text-xs text-ink-400">
                      {project.title}
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
                      {project._count.scenes}
                    </Td>
                    <Td className="text-right tabular-nums text-ink-300">
                      {formatUSD(project.estimatedCost)}
                    </Td>
                    <Td className="text-right tabular-nums text-ink-100">
                      {formatUSD(project.actualCost)}
                    </Td>
                    <Td className="text-right tabular-nums text-ink-500">
                      {formatUSD(project.maxBudget)}
                    </Td>
                    <Td className="text-xs text-ink-500">
                      {formatDateVi(project.createdAt)}
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
