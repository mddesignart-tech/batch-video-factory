"use client";

import Link from "next/link";
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ProgressBar,
  Stat,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { formatUSD } from "@/lib/utils";
import {
  VI_BATCH_AUTH_STATUS,
  VI_BATCH_STATUS,
  VI_PROJECT_STATUS,
  type BatchAuthStatus,
  type BatchStatus,
  type ProjectStatus,
} from "@/domain/enums";
import type { BatchProgress } from "@/services/batch-runner";
import { BatchControls, RetryVideoButton } from "./batch-controls";
import { ApprovePanel, type ApprovalFigures } from "./approve-panel";
import { POLL_INTERVAL_MS, useBatchProgress } from "./use-batch-progress";

const PROJECT_TONE: Record<string, "neutral" | "info" | "ok" | "warn" | "danger"> = {
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

/**
 * The batch progress page, rendered from live data.
 *
 * Server-rendered once so the first paint is correct with no spinner, then kept
 * current by polling. It never reloads the page: a full reload would lose the
 * scroll position and flash the whole layout every few seconds, which is worse
 * than the F5 it replaces.
 */
export function BatchProgressView({
  initial,
  approval,
}: {
  initial: BatchProgress;
  approval: ApprovalFigures | null;
}) {
  const { progress, refreshing, error, polling } = useBatchProgress(
    initial.batch.id,
    initial,
  );

  const { batch, counts, ledger, authorization, videos } = progress;
  const status = batch.status as BatchStatus;

  const totalPlanned = counts.total + progress.notStarted;
  const doneFraction = totalPlanned > 0 ? counts.completed / totalPlanned : 0;

  const live = authorization?.status === "APPROVED";
  const stopped =
    authorization !== null &&
    ["CANCELLED", "EXHAUSTED"].includes(authorization.status);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink-100">{batch.name}</h1>
          <p className="mt-1 text-sm text-ink-400">
            {VI_BATCH_STATUS[status] ?? status} · {counts.total}/{totalPlanned} video
            đã tạo dự án
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-ink-500">
            {polling
              ? `Tự cập nhật mỗi ${(POLL_INTERVAL_MS / 1000).toFixed(1)}s${refreshing ? " …" : ""}`
              : "Lô đã kết thúc — đã dừng tự cập nhật"}
          </span>
          <Link href="/batches" className="text-xs text-ink-400 hover:text-brand-400">
            ← Danh sách lô
          </Link>
        </div>
      </div>

      {error ? (
        <Alert tone="warn" title="Không đọc được tiến trình mới nhất" className="mb-4">
          {error}. Số liệu bên dưới là lần đọc gần nhất còn đúng.
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Đã chi (committed)"
          value={formatUSD(ledger?.committed ?? 0, 4)}
          hint="Tiền nhà cung cấp đã thật sự tính"
          tone={ledger && ledger.committed > 0 ? "warn" : "neutral"}
        />
        <Stat
          label="Đang giữ chỗ (reserved)"
          value={formatUSD(ledger?.reserved ?? 0, 4)}
          hint="Đã hứa cho request đang bay, chưa quyết toán"
          tone="info"
        />
        <Stat
          label="Hạn mức đã duyệt"
          value={formatUSD(authorization?.authorizedMaxSpend ?? 0)}
          hint={`Còn lại ${formatUSD(ledger?.available ?? 0, 4)}`}
          tone="brand"
        />
        <Stat
          label="Hạn mức / video"
          value={formatUSD(authorization?.maxCostPerVideo ?? 0)}
          hint="Video vượt mức này bị dừng riêng, không kéo cả lô"
        />
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Tiến trình lô</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ProgressBar
            value={doneFraction}
            tone={status === "FAILED" ? "danger" : "brand"}
          />
          <div className="flex flex-wrap gap-4 text-xs text-ink-400">
            <span>
              <strong className="text-ok-500">{counts.completed}</strong> hoàn thành
            </span>
            <span>
              <strong className="text-accent-500">{counts.running}</strong> đang chạy
            </span>
            <span>
              <strong className="text-ink-200">{counts.queued}</strong> chờ
            </span>
            <span>
              <strong className="text-warn-500">{counts.needsReview}</strong> cần xem lại
            </span>
            <span>
              <strong className="text-danger-500">{counts.failed}</strong> thất bại
            </span>
            <span>
              <strong className="text-ink-200">{progress.notStarted}</strong> chưa bắt đầu
            </span>
          </div>

          {authorization ? (
            <div className="rounded-lg border border-ink-800 bg-ink-850 px-4 py-3 text-xs">
              <p className="text-ink-300">
                Quyền chi:{" "}
                <Badge
                  tone={
                    authorization.status === "APPROVED"
                      ? "ok"
                      : authorization.status === "DRAFT"
                        ? "neutral"
                        : "warn"
                  }
                >
                  {VI_BATCH_AUTH_STATUS[authorization.status as BatchAuthStatus] ??
                    authorization.status}
                </Badge>
              </p>
              <p className="mt-1 text-ink-500">
                Nhà cung cấp trong phạm vi:{" "}
                {authorization.providerScope.join(", ") || "— (mock, $0)"}
              </p>
              {authorization.closedReason ? (
                <p className="mt-1 text-warn-500">{authorization.closedReason}</p>
              ) : null}
            </div>
          ) : (
            <Alert tone="warn" title="Lô chưa có quyền chi">
              Chưa có BATCH_SPEND_AUTHORIZATION nào cho lô này, nên nó không thể
              gọi API trả phí.
            </Alert>
          )}

          <BatchControls
            batchId={batch.id}
            canStop={live}
            canResume={stopped}
            canReplan={!live}
          />
        </CardContent>
      </Card>

      {approval ? <ApprovePanel batchId={batch.id} figures={approval} /> : null}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Từng video ({videos.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Video</Th>
                <Th>Trạng thái</Th>
                <Th className="text-right">Cảnh xong</Th>
                <Th className="text-right">Local / AI</Th>
                <Th className="text-right">Dự toán</Th>
                <Th className="text-right">Thực tế</Th>
                <Th>Kết quả</Th>
              </tr>
            </thead>
            <tbody>
              {videos.map((video) => (
                <tr key={video.projectId} className="align-top">
                  <Td className="font-medium text-ink-100">
                    <Link
                      href={`/projects/${video.projectId}`}
                      className="hover:text-brand-400"
                    >
                      {video.phrase}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={PROJECT_TONE[video.status] ?? "neutral"}>
                      {VI_PROJECT_STATUS[video.status as ProjectStatus] ?? video.status}
                    </Badge>
                    {video.errorMessage ? (
                      <p className="mt-1 max-w-md text-[11px] text-ink-500">
                        {video.errorMessage}
                      </p>
                    ) : null}
                  </Td>
                  <Td className="text-right tabular-nums text-ink-300">
                    {video.scenesCompleted}/{video.sceneCount}
                    {video.scenesFailed > 0 ? (
                      <span className="text-danger-500"> ({video.scenesFailed} lỗi)</span>
                    ) : null}
                  </Td>
                  <Td className="text-right tabular-nums text-ink-400">
                    <span className="text-ok-500">{video.localMotionScenes}</span> /{" "}
                    <span className="text-accent-500">{video.aiVideoScenes}</span>
                  </Td>
                  <Td className="text-right tabular-nums text-ink-400">
                    {formatUSD(video.estimatedCost, 4)}
                  </Td>
                  <Td className="text-right tabular-nums text-ink-100">
                    {formatUSD(video.actualCost, 4)}
                  </Td>
                  <Td className="text-xs">
                    {video.finalVideoPath ? (
                      <span className="text-ok-500">MP4 đã xuất</span>
                    ) : (
                      <RetryVideoButton projectId={video.projectId} />
                    )}
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
