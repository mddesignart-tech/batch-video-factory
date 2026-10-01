"use client";

import { Badge, Button } from "@/components/ui";
import { formatDuration, formatUSD } from "@/lib/utils";
import { FRIENDLY_TONE } from "@/domain/friendly-status";
import { VI_COST_CLASS } from "@/domain/queue-order";
import type { WorkspaceVideo } from "@/services/daily-workspace";
import { CopyPathButton, CopyTextButton } from "@/components/copy-path-button";
import { ContinueVideoButton } from "@/components/continue-video-button";
import { ActionButtonWithFeedback } from "@/components/action-ui";
import { openOutputFolder } from "@/app/actions/output";
import { rerenderAction } from "@/app/actions/workspace";

/** What a person may press on one video, from its own state. */
export function VideoActions({
  v,
  onChanged,
  onDetail,
  compact = false,
}: {
  v: WorkspaceVideo;
  onChanged: () => void;
  onDetail: () => void;
  compact?: boolean;
}) {
  const finished = v.lifecycle === "COMPLETED";
  const canContinue =
    !finished &&
    v.lifecycle !== "RUNNING" &&
    v.lifecycle !== "RENDERING" &&
    v.lifecycle !== "BLOCKED" &&
    v.covered &&
    !v.invalidVoice;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {finished && v.output ? (
        <>
          <a
            href={`/api/media/${v.output.relative}/final.mp4`}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-ok-500/40 px-2 py-0.5 text-[11px] text-ok-500 hover:bg-ok-500/10"
          >
            PHÁT VIDEO
          </a>
          <ActionButtonWithFeedback action={() => openOutputFolder(v.projectId)} variant="outline" size="sm">
            MỞ THƯ MỤC
          </ActionButtonWithFeedback>
          <CopyPathButton path={v.output.dir} />
          {!compact ? <CopyTextButton text={v.title} label="COPY TITLE" /> : null}
          {!compact ? (
            <ActionButtonWithFeedback
              action={() => rerenderAction(v.projectId)}
              variant="ghost"
              size="sm"
              confirm="Render lại tại máy theo preset hiện tại ($0, không tạo lại ảnh/clip/giọng)?"
              onDone={onChanged}
            >
              RENDER LẠI
            </ActionButtonWithFeedback>
          ) : null}
        </>
      ) : null}
      {canContinue ? <ContinueVideoButton projectId={v.projectId} paidHint={!v.zeroCost} onDone={onChanged} /> : null}
      <Button size="sm" variant="ghost" onClick={onDetail}>
        CHI TIẾT
      </Button>
    </div>
  );
}

export function ProblemLine({ v }: { v: WorkspaceVideo }) {
  if (!v.problem) return null;
  return (
    <details className="mt-1 text-[11px]">
      <summary className="cursor-pointer text-warn-500">
        {v.problem.title}
        {v.problem.mayCost && !/phát sinh chi phí/.test(v.problem.title) ? " · có thể phát sinh chi phí" : ""}
      </summary>
      <p className="mt-1 text-ink-300">{v.problem.action}</p>
      <p className="mt-1 break-words font-mono text-ink-500">{v.problem.detail}</p>
    </details>
  );
}

export function VideoCard({
  v,
  selected,
  onToggle,
  onChanged,
  onDetail,
  hasApproval,
}: {
  v: WorkspaceVideo;
  hasApproval: boolean;
  selected: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onDetail: () => void;
}) {
  const selectable = v.lifecycle !== "BLOCKED";
  return (
    <div
      className={`flex flex-col gap-2 rounded-xl border p-3 ${selected ? "border-brand-500 bg-brand-500/5" : "border-ink-800 bg-ink-900"}`}
      data-video-card={v.projectId}
    >
      <div className="flex gap-3">
        <label className="flex items-start pt-1">
          <input type="checkbox" checked={selected} disabled={!selectable} onChange={onToggle} aria-label={`Chọn ${v.title}`} />
        </label>
        <div className="h-28 w-16 shrink-0 overflow-hidden rounded bg-ink-800">
          {v.thumbnail ? <img src={v.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" /> : null}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-ink-100" title={v.title}>
            {v.title}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Badge tone={FRIENDLY_TONE[v.status]}>{v.status}</Badge>
            {v.exportReady ? <Badge tone="ok">SẴN SÀNG ĐĂNG</Badge> : null}
            {v.lifecycle !== "BLOCKED" && v.lifecycle !== "COMPLETED" ? (
              <Badge tone={v.zeroCost ? "ok" : "neutral"}>{VI_COST_CLASS[v.costClass]}</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] text-ink-400">
            {v.sceneCount} cảnh · {v.durationSec > 0 ? formatDuration(v.durationSec) : "—"} · {v.aspectRatio}
            {v.queueOrder ? ` · hàng đợi #${v.queueOrder}` : ""}
          </p>
          <p className="text-[11px] text-ink-400">
            {v.lifecycle === "COMPLETED" ? "Chi thật " : "Dự toán thêm "}
            <span className="tabular-nums text-ink-200">{formatUSD(v.lifecycle === "COMPLETED" ? v.actualCost : v.estimatedCost, 4)}</span>
            {v.reuseSaving > 0 ? <span className="text-ok-500"> · dùng lại tiết kiệm {formatUSD(v.reuseSaving, 4)}</span> : null}
          </p>
          <p className="truncate text-[11px] text-ink-500" title={[...v.videoModels, ...v.voices].join(", ")}>
            {v.videoModels.length > 0 ? `Video AI: ${v.videoModels.join(", ")}` : "Không Video AI"}
            {v.voices.length > 0 ? ` · Giọng: ${v.voices.join(", ")}` : ""}
          </p>
          {v.currentStep ? <p className="text-[11px] text-accent-500">▶ {v.currentStep}</p> : null}
          <ProblemLine v={v} />
          {hasApproval && !v.covered && v.lifecycle !== "COMPLETED" && v.lifecycle !== "BLOCKED" ? (
            <p className="text-[11px] text-ink-500">Chưa nằm trong phần đã duyệt — DUYỆT THÊM để chạy.</p>
          ) : null}
        </div>
      </div>
      <VideoActions v={v} onChanged={onChanged} onDetail={onDetail} />
    </div>
  );
}
