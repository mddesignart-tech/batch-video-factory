import Link from "next/link";
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader, Table, Td, Th } from "@/components/ui";
import { prisma } from "@/lib/prisma";
import { formatUSD } from "@/lib/utils";
import { batchProgress } from "@/services/batch-runner";
import { LIFECYCLE_TONE } from "@/domain/video-lifecycle";
import { AutoRefresh } from "./auto-refresh";

export const dynamic = "force-dynamic";

/**
 * HÀNG ĐỢI - every video of the recent batches in one list, each with its own
 * lifecycle. Read-only: it reads the same rows the batch pages read, so there
 * is no path from this page to a provider. Runs are started and resumed on the
 * batch page, where the money is approved.
 */
export default async function QueuePage() {
  const batches = await prisma.batch.findMany({ orderBy: { createdAt: "desc" }, take: 12, select: { id: true } });
  const progress = (await Promise.all(batches.map((b) => batchProgress(b.id)))).filter(
    (p): p is NonNullable<typeof p> => p !== null,
  );
  const rows = progress.flatMap((p) => p.videos.map((v) => ({ batch: p, video: v })));
  const anyRunning = progress.some((p) => p.running || p.status === "RUNNING");

  return (
    <>
      <AutoRefresh active={anyRunning} />
      <PageHeader
        title="Hàng đợi"
        description="Mọi video của các lô gần đây. Một video lỗi hay bị chặn không làm dừng video khác."
      />
      <Card>
        <CardHeader>
          <CardTitle>
            {rows.length} video · {rows.filter((r) => r.video.lifecycle === "RUNNING" || r.video.lifecycle === "RENDERING").length} đang chạy ·{" "}
            {rows.filter((r) => r.video.lifecycle === "COMPLETED").length} xong ·{" "}
            {rows.filter((r) => r.video.lifecycle === "BLOCKED").length} bị chặn ·{" "}
            {rows.filter((r) => r.video.lifecycle === "FAILED").length} lỗi
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Video</Th>
                <Th>Lô</Th>
                <Th>Trạng thái</Th>
                <Th className="text-right">Cảnh</Th>
                <Th className="text-right">Ảnh</Th>
                <Th className="text-right">Video AI</Th>
                <Th className="text-right">Giọng</Th>
                <Th>Render</Th>
                <Th className="text-right">Chi thật / trần</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ batch, video }) => (
                <tr key={video.projectId} className="align-top">
                  <Td>
                    <Link href={`/projects/${video.projectId}`} className="hover:text-brand-400">
                      {video.title}
                    </Link>
                    {video.errorMessage ? (
                      <p className="mt-1 max-w-sm text-[11px] text-ink-500">{video.errorMessage}</p>
                    ) : null}
                  </Td>
                  <Td className="text-xs">
                    <Link href={`/batches/${batch.batch.id}`} className="text-ink-400 hover:text-brand-400">
                      {batch.batch.name}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={LIFECYCLE_TONE[video.lifecycle]}>{video.lifecycle}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums">
                    {video.scenesCompleted}/{video.sceneCount}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {video.imagesDone}/{video.sceneCount}
                    {video.importedImages > 0 ? <span className="text-ok-500"> ({video.importedImages} nhập)</span> : null}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {video.aiVideoScenes > 0 ? `${video.clipsDone}/${video.aiVideoScenes}` : "—"}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {video.voicesDone}/{video.sceneCount}
                  </Td>
                  <Td className="text-xs">{video.finalVideoPath ? "XONG" : video.lifecycle === "RENDERING" ? "đang render" : "chưa"}</Td>
                  <Td className="text-right tabular-nums">
                    {formatUSD(video.actualCost, 4)} / {formatUSD(video.authorizedCost, 2)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
