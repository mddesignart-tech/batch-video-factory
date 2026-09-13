import Link from "next/link";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Stat,
} from "@/components/ui";
import { prisma } from "@/lib/prisma";
import { DIRS, dirSize } from "@/lib/paths";
import { formatBytes, formatDateVi } from "@/lib/utils";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  image: "Ảnh",
  video: "Video cảnh",
  audio: "Giọng đọc",
  subtitle: "Phụ đề",
  final: "Video hoàn chỉnh",
};

export default async function MediaPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const params = await searchParams;

  const [assets, byKind, finals] = await Promise.all([
    prisma.asset.findMany({
      where: params.kind ? { kind: params.kind } : {},
      orderBy: { createdAt: "desc" },
      take: 120,
      include: { project: { select: { id: true, title: true } } },
    }),
    prisma.asset.groupBy({
      by: ["kind"],
      _count: { _all: true },
      _sum: { bytes: true },
    }),
    prisma.project.findMany({
      where: { finalVideoPath: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: 12,
      include: { idiom: true },
    }),
  ]);

  const totalBytes = dirSize(DIRS.projects);

  return (
    <>
      <PageHeader
        title="Media"
        description="Mọi tệp được tạo ra đều nằm trên ổ đĩa cục bộ trong thư mục data/projects."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Dung lượng media" value={formatBytes(totalBytes)} />
        <Stat label="Video hoàn chỉnh" value={finals.length} tone="ok" />
        <Stat
          label="Tổng số tệp"
          value={byKind.reduce((sum, k) => sum + k._count._all, 0)}
        />
        <Stat label="Thư mục gốc" value="data/projects" />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Video hoàn chỉnh</CardTitle>
        </CardHeader>
        <CardContent>
          {finals.length === 0 ? (
            <EmptyState
              title="Chưa có video hoàn chỉnh nào"
              description="Sau khi tạo media và render, video MP4 sẽ xuất hiện ở đây."
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {finals.map((project) => (
                <div key={project.id}>
                  <video
                    src={`/api/media/${project.finalVideoPath}`}
                    controls
                    playsInline
                    preload="metadata"
                    className="aspect-[9/16] w-full rounded-lg border border-ink-800 bg-black object-cover"
                  />
                  <Link
                    href={`/projects/${project.id}`}
                    className="mt-1.5 block truncate text-xs text-ink-300 hover:text-brand-400"
                  >
                    {project.idiom.phrase}
                  </Link>
                  <p className="text-[10px] text-ink-600">
                    {formatDateVi(project.updatedAt)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Tất cả tệp</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            <Link
              href="/media"
              className={`rounded-md px-2.5 py-1 text-xs ${
                !params.kind
                  ? "bg-ink-700 text-ink-100"
                  : "text-ink-400 hover:bg-ink-800"
              }`}
            >
              Tất cả
            </Link>
            {byKind.map((kind) => (
              <Link
                key={kind.kind}
                href={`/media?kind=${kind.kind}`}
                className={`rounded-md px-2.5 py-1 text-xs ${
                  params.kind === kind.kind
                    ? "bg-ink-700 text-ink-100"
                    : "text-ink-400 hover:bg-ink-800"
                }`}
              >
                {KIND_LABEL[kind.kind] ?? kind.kind} ({kind._count._all})
              </Link>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {assets.length === 0 ? (
            <EmptyState title="Chưa có tệp media nào" />
          ) : (
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-7">
              {assets.map((asset) => (
                <div
                  key={asset.id}
                  className="rounded-lg border border-ink-800 bg-ink-850 p-2"
                >
                  {asset.kind === "image" ? (
                    // Plain <img>: these are locally generated user files served
                    // from an API route, so next/image's optimiser adds nothing.
                    <img
                      src={`/api/media/${asset.filePath}`}
                      alt={asset.prompt.slice(0, 60)}
                      className="aspect-[9/16] w-full rounded object-cover"
                    />
                  ) : asset.kind === "video" || asset.kind === "final" ? (
                    <video
                      src={`/api/media/${asset.filePath}`}
                      preload="metadata"
                      controls
                      className="aspect-[9/16] w-full rounded bg-black object-cover"
                    />
                  ) : asset.kind === "audio" ? (
                    <div className="flex aspect-[9/16] w-full items-center justify-center rounded bg-ink-900">
                      <audio
                        src={`/api/media/${asset.filePath}`}
                        controls
                        className="w-full scale-75"
                      />
                    </div>
                  ) : (
                    <a
                      href={`/api/media/${asset.filePath}`}
                      className="flex aspect-[9/16] w-full items-center justify-center rounded bg-ink-900 text-[11px] text-accent-500"
                    >
                      Mở tệp
                    </a>
                  )}
                  <div className="mt-1.5 space-y-0.5">
                    <Badge>{KIND_LABEL[asset.kind] ?? asset.kind}</Badge>
                    <p className="truncate text-[10px] text-ink-500">
                      {asset.provider}/{asset.model}
                    </p>
                    <p className="text-[10px] text-ink-600">
                      {formatBytes(asset.bytes)}
                    </p>
                    {asset.project ? (
                      <Link
                        href={`/projects/${asset.project.id}`}
                        className="block truncate text-[10px] text-accent-500 hover:underline"
                      >
                        {asset.project.title}
                      </Link>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
