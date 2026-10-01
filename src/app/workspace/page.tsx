import Link from "next/link";
import { FileUp } from "lucide-react";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Input, PageHeader, Stat, Table, Td, Th, Button } from "@/components/ui";
import { formatDateVi, formatDuration, formatUSD } from "@/lib/utils";
import { batchHistory, dailyBoard } from "@/services/daily-history";
import { FRIENDLY_BATCH_STATUS, VI_WORKFLOW_STEP, WORKFLOW_STEPS } from "@/domain/friendly-status";
import { QueuePanel } from "./queue-panel";

export const dynamic = "force-dynamic";

/**
 * The daily workspace (V1.2 Phase 6, QĐ-114): what a person opens every day.
 * IMPORT → REVIEW → PREFLIGHT → APPROVE → QUEUE → GENERATE → RENDER → EXPORT,
 * today's numbers (real money only, mock kept apart), the live queue and the
 * batch history. Engine words (ProviderJob, CostEntry) live in Advanced pages.
 */
export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; date?: string; status?: string }>;
}) {
  const sp = await searchParams;
  const [board, history] = await Promise.all([
    dailyBoard(),
    batchHistory({ q: sp.q, date: sp.date, status: sp.status || undefined, limit: 50 }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Làm việc hằng ngày"
        description="Nhập storyboard → kiểm tra → duyệt → chạy → xuất file đăng Shorts / TikTok / Reels. Không cần dòng lệnh."
        actions={
          <Link href="/import">
            <Button variant="primary" size="lg">
              <FileUp className="h-5 w-5" />
              TẠO LÔ VIDEO
            </Button>
          </Link>
        }
      />

      <ol className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {WORKFLOW_STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-1.5">
            <span className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 font-medium text-ink-300">
              {i + 1}. {VI_WORKFLOW_STEP[s]}
            </span>
            {i < WORKFLOW_STEPS.length - 1 ? <span className="text-ink-600">→</span> : null}
          </li>
        ))}
      </ol>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-200">HÔM NAY</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Video hoàn thành" value={board.videosCompleted} hint={board.videosCompletedMock > 0 ? `+${board.videosCompletedMock} video mock (không tính)` : "chỉ video sản xuất thật"} tone="ok" />
          <Stat label="Video lỗi" value={board.videosFailed} tone={board.videosFailed > 0 ? "danger" : "neutral"} />
          <Stat label="Video đang chờ / chạy" value={board.videosPending} tone="info" />
          <Stat label="Lô tạo hôm nay" value={board.batchesToday} />
          <Stat label="Chi API hôm nay" value={formatUSD(board.apiSpend, 4)} hint="Tiền thật đã tính (không gồm mock, không phải số duyệt)" tone={board.apiSpend > 0 ? "warn" : "neutral"} />
          <Stat
            label="Chi phí trung bình / video"
            value={board.averageCostPerVideo === null ? "—" : formatUSD(board.averageCostPerVideo, 4)}
            hint="Tiền thật của từng video xong hôm nay"
          />
          <Stat label="Tiết kiệm nhờ dùng lại" value={formatUSD(board.reuseSavedToday, 4)} hint="Giá gốc của asset được dùng lại hôm nay — tiền KHÔNG chi" tone="ok" />
          <Stat
            label="Hạn mức toàn cục còn lại"
            value={formatUSD(board.globalRemaining, 4)}
            hint={`Đã chi ${formatUSD(board.globalSpent, 4)} / ${formatUSD(board.globalCap, 2)}`}
            tone={board.globalRemaining < 0.4 ? "warn" : "brand"}
          />
          <Stat
            label="Số dư Runway"
            value={board.runwayCredits === null ? "—" : `${board.runwayCredits} credit`}
            hint={
              board.runwayFreshness
                ? `${board.runwayFreshness}${board.runwayCheckedAt ? ` · đọc lúc ${formatDateVi(board.runwayCheckedAt)}` : ""}`
                : "chưa có số liệu"
            }
          />
        </div>
      </section>

      <QueuePanel />

      <Card>
        <CardHeader>
          <CardTitle>Lịch sử lô</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form className="flex flex-wrap items-end gap-2" action="/workspace">
            <label className="text-xs text-ink-400">
              Tìm tên lô / tên video
              <Input name="q" defaultValue={sp.q ?? ""} placeholder="vd. AI tools" className="mt-1 w-64" />
            </label>
            <label className="text-xs text-ink-400">
              Ngày
              <Input type="date" name="date" defaultValue={sp.date ?? ""} className="mt-1 w-40" />
            </label>
            <label className="text-xs text-ink-400">
              Trạng thái
              <select
                name="status"
                defaultValue={sp.status ?? ""}
                className="mt-1 block h-9 rounded-md border border-ink-700 bg-ink-900 px-2 text-sm text-ink-100"
              >
                <option value="">Tất cả</option>
                {Object.entries(FRIENDLY_BATCH_STATUS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" size="md">
              Tìm
            </Button>
            {sp.q || sp.date || sp.status ? (
              <Link href="/workspace" className="text-xs text-ink-400 hover:text-brand-400">
                Xoá lọc
              </Link>
            ) : null}
          </form>
          {history.length === 0 ? (
            <EmptyState title="Không có lô nào khớp" description="Bấm TẠO LÔ VIDEO để nhập storyboard đầu tiên." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Ngày</Th>
                  <Th>Tên lô</Th>
                  <Th>Trạng thái</Th>
                  <Th className="text-right">Video</Th>
                  <Th className="text-right">Xong</Th>
                  <Th className="text-right">Lỗi / chặn</Th>
                  <Th className="text-right">Chi phí thật</Th>
                  <Th className="text-right">Thời lượng</Th>
                  <Th>Thư mục</Th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <Td className="whitespace-nowrap text-xs text-ink-400">{formatDateVi(h.createdAt)}</Td>
                    <Td>
                      <Link href={`/workspace/${h.id}`} className="font-medium text-ink-100 hover:text-brand-400">
                        {h.name}
                      </Link>
                      {h.matchedVideos.length > 0 ? (
                        <p className="text-[11px] text-ink-500">khớp: {h.matchedVideos.slice(0, 3).join(", ")}</p>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone={h.status === "COMPLETED" ? "ok" : h.status === "RUNNING" ? "warn" : h.status === "FAILED" ? "danger" : "neutral"}>
                        {h.running ? "Đang chạy" : h.statusLabel}
                      </Badge>
                    </Td>
                    <Td className="text-right tabular-nums">{h.videos}</Td>
                    <Td className="text-right tabular-nums text-ok-500">{h.completed}</Td>
                    <Td className="text-right tabular-nums text-warn-500">{h.failed + h.blocked}</Td>
                    <Td className="text-right tabular-nums">{formatUSD(h.cost, 4)}</Td>
                    <Td className="text-right tabular-nums">{h.durationSec > 0 ? formatDuration(h.durationSec) : "—"}</Td>
                    <Td className="font-mono text-[11px] text-ink-500">{h.outputFolder ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
