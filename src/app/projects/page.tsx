import Link from "next/link";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
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
import { ProjectList } from "./project-list";
import { folderBytes } from "@/services/trash-service";

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
  needs_review: "warn",
  budget_exhausted: "warn",
  cancelled: "neutral",
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
      include: { idiom: true, _count: { select: { scenes: { where: { deletedAt: null } }, assets: { where: { kind: "final", deletedAt: null } } } } },
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
        description="Mọi video: review sản phẩm, kể chuyện, kiến thức, thành ngữ… Form bên dưới tạo video thành ngữ từ thư viện."
        actions={
          <Link href="/create">
            <Button variant="primary">TẠO VIDEO (mọi loại)</Button>
          </Link>
        }
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
            <ProjectList
              rows={projects.map((project) => ({
                id: project.id,
                phrase: project.idiom.phrase,
                title: project.title,
                status: project.status,
                statusLabel: VI_PROJECT_STATUS[project.status as ProjectStatus] ?? project.status,
                statusTone: STATUS_TONE[project.status as ProjectStatus] ?? "neutral",
                mode: VI_QUALITY_MODE[project.qualityMode as QualityMode] ?? project.qualityMode,
                scenes: project._count.scenes,
                videos: project._count.assets,
                bytes: folderBytes(project.id),
                estimated: formatUSD(project.estimatedCost),
                actual: formatUSD(project.actualCost),
                budget: formatUSD(project.maxBudget),
                createdAt: formatDateVi(project.createdAt),
                updatedAt: formatDateVi(project.updatedAt),
              }))}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
